import type { Tool } from '../tool-registry.js';
import type { MemoryManager } from '../../memory/manager.js';

let memoryManagerRef: MemoryManager | null = null;

export function setMemoryManager(mm: MemoryManager): void {
  memoryManagerRef = mm;
}

const IDENTITY_FILES = ['PERSONALITY.md', 'USER.md', 'IDENTITY.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md', 'MEMORY.md'];

// ── Unified memory tool ──────────────────────────────────────────────────

const memoryTool: Tool = {
  name: 'memory',
  description: [
    'Manage memory and daily logs. Actions:',
    'search — semantic search across all memory (vector+BM25). Pass query, optional limit and mode (hybrid|vector|text|legacy).',
    'read — read the curated MEMORY.md file.',
    'write — replace entire MEMORY.md content. Pass content.',
    'append — append to MEMORY.md without replacing. Pass entry.',
    'log — append timestamped entry to today\'s daily log. Pass entry.',
    'files — list all memory files with sizes.',
    'reindex — rebuild the semantic search index.',
    'stats — show search index statistics.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: search|read|write|append|log|files|reindex|stats',
      },
      query: { type: 'string', description: 'Search query (for search)' },
      content: { type: 'string', description: 'Full content (for write)' },
      entry: { type: 'string', description: 'Text to append (for append, log)' },
      limit: { type: 'number', description: 'Max results (for search, default 10)' },
      mode: { type: 'string', description: 'Search mode: hybrid|vector|text|legacy (default hybrid)' },
    },
    required: ['action'],
  },
  async execute(params) {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    const action = params.action as string;

    switch (action) {
      case 'search': {
        const query = params.query as string;
        if (!query) return { output: '', error: 'query is required for search' };
        const limit = (params.limit as number) || 10;
        const mode = (params.mode as string) || 'hybrid';
        if (mode === 'legacy') {
          const results = memoryManagerRef.search(query, limit);
          if (results.length === 0) return { output: `No results found for "${query}"` };
          return { output: results.map(r => `### ${r.file}\n${r.matches.join('\n---\n')}`).join('\n\n') };
        }
        try {
          const results = await memoryManagerRef.semanticSearch(query, limit);
          if (results.length === 0) return { output: `No results found for "${query}"` };
          const formatted = results.map((r, i) => {
            const scoreStr = `score: ${r.score.toFixed(3)} (vec: ${r.vectorScore.toFixed(3)}, bm25: ${r.bm25Score.toFixed(3)})`;
            return `### ${i + 1}. ${r.file} [${scoreStr}]\n${r.text}`;
          });
          const stats = memoryManagerRef.getIndexStats();
          return { output: `_Searched ${stats.totalChunks} chunks across ${stats.indexedFiles.length} files_\n` + formatted.join('\n\n---\n\n') };
        } catch (err) {
          return { output: '', error: `Semantic search failed: ${(err as Error).message}. Try mode: "legacy" as fallback.` };
        }
      }
      case 'read': {
        const content = memoryManagerRef.getMemory();
        if (!content) return { output: 'MEMORY.md is empty or does not exist yet.' };
        return { output: content };
      }
      case 'write': {
        const content = params.content as string;
        if (!content) return { output: '', error: 'content is required for write' };
        memoryManagerRef.saveMemory(content);
        return { output: `MEMORY.md updated (${content.length} chars)` };
      }
      case 'append': {
        const entry = params.entry as string;
        if (!entry) return { output: '', error: 'entry is required for append' };
        memoryManagerRef.appendMemory(entry);
        return { output: `Appended to MEMORY.md (${entry.length} chars)` };
      }
      case 'log': {
        const entry = params.entry as string;
        if (!entry) return { output: '', error: 'entry is required for log' };
        memoryManagerRef.appendDailyLog(entry);
        return { output: `Logged to ${new Date().toISOString().split('T')[0]}.md` };
      }
      case 'files': {
        const files = memoryManagerRef.listFiles();
        if (files.length === 0) return { output: 'No memory files found.' };
        return { output: files.map(f => `${f.name} | ${f.size} bytes | modified ${f.modified}`).join('\n') };
      }
      case 'reindex': {
        const stats = memoryManagerRef.getIndexStats();
        if (!stats.enabled) return { output: 'Semantic search is disabled. Enable in config: memory.embedding.enabled = true' };
        try {
          const result = await memoryManagerRef.indexAll();
          return { output: `Reindex complete: ${result.files} files (${result.indexed} new chunks), ${result.skipped} skipped. Total: ${memoryManagerRef.getIndexStats().totalChunks} chunks` };
        } catch (err) {
          return { output: '', error: `Reindex failed: ${(err as Error).message}` };
        }
      }
      case 'stats': {
        const stats = memoryManagerRef.getIndexStats();
        if (!stats.enabled) return { output: 'Semantic search: DISABLED (legacy substring only). Enable: memory.embedding.enabled = true' };
        return { output: [`Semantic search: ENABLED`, `Chunks: ${stats.totalChunks}`, `Files: ${stats.indexedFiles.join(', ')}`].join('\n') };
      }
      default:
        return { output: '', error: `Unknown action "${action}". Valid: search, read, write, append, log, files, reindex, stats` };
    }
  },
};

// ── Unified identity tool ────────────────────────────────────────────────

const identityTool: Tool = {
  name: 'identity',
  description: [
    'Read or write identity/personality files that define who you are.',
    'Files: PERSONALITY.md, USER.md, IDENTITY.md, AGENTS.md, TOOLS.md, HEARTBEAT.md, MEMORY.md.',
    'Actions: read (pass file), write (pass file + content). If updating PERSONALITY.md, tell the user.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: read|write' },
      file: { type: 'string', description: 'File name (e.g. "PERSONALITY.md", "USER.md")' },
      content: { type: 'string', description: 'Content to write (for write action)' },
    },
    required: ['action', 'file'],
  },
  async execute(params) {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    const action = params.action as string;
    const file = params.file as string;
    if (!IDENTITY_FILES.includes(file)) {
      return { output: '', error: `Invalid file. Choose from: ${IDENTITY_FILES.join(', ')}` };
    }
    if (action === 'read') {
      const content = memoryManagerRef.getIdentityFile(file);
      if (!content) return { output: `${file} does not exist or is empty.` };
      return { output: content };
    }
    if (action === 'write') {
      const content = params.content as string;
      if (!content) return { output: '', error: 'content is required for write' };
      memoryManagerRef.saveIdentityFile(file, content);
      return { output: `${file} updated (${content.length} chars). Changes take effect on next message.` };
    }
    return { output: '', error: `Unknown action "${action}". Valid: read, write` };
  },
};

// ── Bootstrap lifecycle ──────────────────────────────────────────────────

const bootstrapCompleteTool: Tool = {
  name: 'bootstrap_complete',
  description: 'Mark first-run bootstrap as complete by deleting BOOTSTRAP.md. Call after intro conversation: you know your name, the user\'s name, and have filled in IDENTITY.md and USER.md.',
  parameters: { type: 'object', properties: {} },
  async execute() {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    if (!memoryManagerRef.hasBootstrap()) {
      return { output: 'Bootstrap already completed (BOOTSTRAP.md does not exist).' };
    }
    memoryManagerRef.deleteBootstrap();
    return { output: 'Bootstrap complete. BOOTSTRAP.md deleted. You\'re you now.' };
  },
};

// ── Export all (3 tools instead of 11) ───────────────────────────────────

export {
  memoryTool as memorySearchTool,      // keep old export name for agent.ts compatibility
  memoryTool as memoryGetTool,
  memoryTool as memorySaveTool,
  memoryTool as memoryAppendTool,
  memoryTool as memoryLogTool,
  memoryTool as memoryFilesTool,
  memoryTool as memoryReindexTool,
  memoryTool as memoryIndexStatsTool,
  identityTool as identityReadTool,
  identityTool as identityWriteTool,
  bootstrapCompleteTool,
};

export const memoryTools = [
  memoryTool,
  identityTool,
  bootstrapCompleteTool,
];
