import type { Tool } from '../tool-registry.js';
import { URL } from 'node:url';

// ── SSRF Protection ─────────────────────────────────────────────────────────

/** Check if a hostname resolves to a private/internal IP range */
function isPrivateIP(ip: string): boolean {
  // IPv4 private ranges
  const ipv4Private = [
    /^10\./,                          // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
    /^192\.168\./,                     // 192.168.0.0/16
    /^127\./,                          // 127.0.0.0/8 (loopback)
    /^0\./,                            // 0.0.0.0/8
    /^169\.254\./,                     // 169.254.0.0/16 (link-local)
    /^100\.(6[4-9]|[7-9][0-9]|1[0-2][0-7])\./, // 100.64.0.0/10 (CGNAT)
  ];

  // IPv6 private ranges
  const ipv6Private = [
    /^::1$/,                           // loopback
    /^fe80:/i,                         // link-local
    /^fc[0-9a-f]{2}:/i,               // unique local
    /^fd[0-9a-f]{2}:/i,               // unique local
    /^::ffff:127\./i,                 // IPv4-mapped loopback
    /^::ffff:10\./i,                  // IPv4-mapped private
    /^::ffff:172\.(1[6-9]|2[0-9]|3[0-1])\./i,
    /^::ffff:192\.168\./i,
  ];

  for (const pattern of ipv4Private) {
    if (pattern.test(ip)) return true;
  }
  for (const pattern of ipv6Private) {
    if (pattern.test(ip)) return true;
  }

  return false;
}

/** Validate URL against SSRF attacks */
async function validateUrlForSSRF(urlStr: string): Promise<{ valid: boolean; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Only allow http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `Protocol not allowed: ${parsed.protocol}` };
  }

  // Block localhost and common internal hostnames
  const blockedHostnames = [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    'metadata.google.internal',
    '169.254.169.254', // AWS/GCP metadata
    'metadata.google.com',
    'kubernetes.default',
    'kubernetes.default.svc',
  ];

  const hostname = parsed.hostname.toLowerCase();
  if (blockedHostnames.includes(hostname)) {
    return { valid: false, error: `Blocked hostname: ${hostname}` };
  }

  // Block internal TLDs
  const blockedTLDs = ['.local', '.internal', '.localhost', '.corp', '.lan'];
  for (const tld of blockedTLDs) {
    if (hostname.endsWith(tld)) {
      return { valid: false, error: `Internal TLD not allowed: ${tld}` };
    }
  }

  // Resolve hostname and check if it's a private IP
  // Note: This is a best-effort check; some DNS rebinding attacks can bypass this
  try {
    const { lookup } = await import('node:dns/promises');
    const addresses = await lookup(hostname, { all: true });
    for (const addr of addresses) {
      if (isPrivateIP(addr.address)) {
        return { valid: false, error: `Hostname resolves to private IP: ${addr.address}` };
      }
    }
  } catch {
    // DNS lookup failed - allow the request (might be valid, let fetch handle it)
  }

  return { valid: true };
}

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
      'search — search the web using DuckDuckGo (no API key needed). Falls back to Brave Search if BRAVE_API_KEY is set.',
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

          // Primary: DuckDuckGo HTML scraping (no API key needed)
          try {
            const results = await searchDDG(query, count);

            if (results.length > 0) {
              let output = `# Search: ${query}\n\n`;
              for (const r of results) {
                output += `## ${r.title ?? '(no title)'}\n${r.url ?? ''}\n${r.description ?? ''}\n\n`;
              }
              if (output.length > 10000) output = output.slice(0, 10000) + '\n... (truncated)';
              return { output };
            }
            // DDG returned 0 results, fall through to Brave
          } catch {
            // DDG failed, fall through to Brave
          }

          // Fallback: Brave Search API (if API key is set)
          const apiKey = process.env.BRAVE_API_KEY;
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
            } catch {
              // Brave also failed
            }
          }

          return { output: `# Search: ${query}\n\nNo results found.` };
        }

        case 'fetch': {
          const url = params.url as string;
          if (!url) return { output: '', error: 'url is required for fetch' };
          const maxLength = (params.max_length as number) || 15000;

          // SSRF protection: validate URL before fetching
          const ssrfCheck = await validateUrlForSSRF(url);
          if (!ssrfCheck.valid) {
            return { output: '', error: `SSRF protection: ${ssrfCheck.error}` };
          }

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
