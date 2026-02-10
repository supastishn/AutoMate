import type { Tool } from '../tool-registry.js';

// ── DuckDuckGo fallback search ─────────────────────────────────────────────

async function searchDDG(query: string, count: number): Promise<{ title: string; url: string; description: string }[]> {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const res = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
  const html = await res.text();
  const results: { title: string; url: string; description: string }[] = [];

  const blocks = html.split(/class="result results_links/).slice(1);

  for (const block of blocks) {
    if (results.length >= count) break;

    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;
    let title = titleMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

    const hrefMatch = block.match(/class="result__a"\s+href="([^"]*)"/);
    if (!hrefMatch) continue;
    let resultUrl = hrefMatch[1];

    if (resultUrl.includes('uddg=')) {
      const decoded = resultUrl.split('uddg=')[1]?.split('&')[0];
      if (decoded) resultUrl = decodeURIComponent(decoded);
    }

    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    let snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
      : '';

    const decode = (s: string) =>
      s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
    title = decode(title);
    snippet = decode(snippet);

    if (title && resultUrl && !resultUrl.includes('duckduckgo.com')) {
      results.push({ title, url: resultUrl, description: snippet });
    }
  }

  return results;
}

// ── HTML stripping ─────────────────────────────────────────────────────────

function stripHtml(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n\n');
  text = text.trim();

  return { title, text };
}

export const webTools: Tool[] = [
  {
    name: 'web',
    description: [
      'Web operations: search and fetch.',
      'Actions: search, fetch.',
      'search — search the web using Brave Search API (set BRAVE_API_KEY).',
      'fetch — fetch a URL and extract clean text content.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: search|fetch',
        },
        query: { type: 'string', description: 'Search query (for search)' },
        url: { type: 'string', description: 'URL to fetch (for fetch)' },
        count: { type: 'number', description: 'Number of results (for search, default 5, max 20)' },
        max_length: { type: 'number', description: 'Max output length (for fetch, default 15000)' },
      },
      required: ['action'],
    },
    async execute(params) {
      const action = params.action as string;

      switch (action) {
        case 'search': {
          const query = params.query as string;
          if (!query) return { output: '', error: 'query is required for search' };
          const count = Math.min(Math.max((params.count as number) || 5, 1), 20);

          const apiKey = process.env.BRAVE_API_KEY;

          // Try Brave first if API key is set
          if (apiKey) {
            try {
              const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
              const res = await fetch(url, {
                headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36' },
              });

              if (res.ok) {
                const data = (await res.json()) as {
                  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
                };
                const results = data.web?.results ?? [];

                if (results.length > 0) {
                  let output = `# Search: ${query}\n\n`;
                  for (const r of results) {
                    output += `## ${r.title ?? '(no title)'}\n${r.url ?? ''}\n${r.description ?? ''}\n\n`;
                  }
                  if (output.length > 10000) output = output.slice(0, 10000) + '\n... (truncated)';
                  return { output };
                }
              }
              // If Brave fails, fall through to DDG
            } catch {
              // Brave failed, fall through to DDG
            }
          }

          // Fallback: DuckDuckGo HTML scraping (no API key needed)
          try {
            const results = await searchDDG(query, count);

            if (results.length === 0) return { output: `# Search: ${query}\n\nNo results found.` };

            let output = `# Search: ${query}\n\n`;
            for (const r of results) {
              output += `## ${r.title ?? '(no title)'}\n${r.url ?? ''}\n${r.description ?? ''}\n\n`;
            }
            if (output.length > 10000) output = output.slice(0, 10000) + '\n... (truncated)';
            return { output };
          } catch (err) {
            return { output: '', error: `Search failed: ${err}` };
          }
        }

        case 'fetch': {
          const url = params.url as string;
          if (!url) return { output: '', error: 'url is required for fetch' };
          const maxLength = (params.max_length as number) || 15000;

          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);

            const res = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36' },
              signal: controller.signal,
              redirect: 'follow',
            });
            clearTimeout(timer);

            if (!res.ok) return { output: '', error: `Fetch error: ${res.status} ${res.statusText}` };

            const html = await res.text();
            const { title, text } = stripHtml(html);

            let output = `# ${title || url}\nSource: ${url}\n\n${text}`;
            if (output.length > maxLength) output = output.slice(0, maxLength) + '\n... (truncated)';
            return { output };
          } catch (err) {
            const msg = err instanceof Error && err.name === 'AbortError' ? 'Request timed out (15s)' : String(err);
            return { output: '', error: `Fetch failed: ${msg}` };
          }
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: search, fetch` };
      }
    },
  },
];
