import type { Tool } from '../tool-registry.js';
import type { MemoryManager } from '../../memory/manager.js';

let memoryManagerRef: MemoryManager | null = null;

export function setMemoryManager(mm: MemoryManager): void {
  memoryManagerRef = mm;
}

// ── Existing tools (improved) ───────────────────────────────────────────

export const memorySearchTool: Tool = {
  name: 'memory_search',
  description: 'Semantic search across all memory files. Uses vector embeddings + BM25 text matching for intelligent results. Understands meaning, not just keywords — e.g. searching "database preferences" can find notes about "likes PostgreSQL".',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language search query (e.g. "user\'s favorite tools", "API key locations")' },
      limit: { type: 'number', description: 'Max results to return (default 10)' },
      mode: {
        type: 'string',
        description: 'Search mode: "hybrid" (default, vector+BM25), "vector" (semantic only), "text" (BM25 only), "legacy" (substring match)',
        enum: ['hybrid', 'vector', 'text', 'legacy'],
      },
    },
    required: ['query'],
  },
  async execute(params) {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    const query = params.query as string;
    const limit = (params.limit as number) || 10;
    const mode = (params.mode as string) || 'hybrid';

    if (mode === 'legacy') {
      // Old substring search
      const results = memoryManagerRef.search(query, limit);
      if (results.length === 0) return { output: `No results found for "${query}"` };
      const formatted = results.map(r =>
        `### ${r.file}\n${r.matches.join('\n---\n')}`
      );
      return { output: formatted.join('\n\n') };
    }

    // Semantic search (hybrid, vector, or text mode)
    try {
      const results = await memoryManagerRef.semanticSearch(query, limit);
      if (results.length === 0) return { output: `No results found for "${query}"` };

      const formatted = results.map((r, i) => {
        const scoreStr = `score: ${r.score.toFixed(3)} (vec: ${r.vectorScore.toFixed(3)}, bm25: ${r.bm25Score.toFixed(3)})`;
        return `### ${i + 1}. ${r.file} [${scoreStr}]\n${r.text}`;
      });

      const stats = memoryManagerRef.getIndexStats();
      const header = `_Searched ${stats.totalChunks} chunks across ${stats.indexedFiles.length} files_\n`;
      return { output: header + formatted.join('\n\n---\n\n') };
    } catch (err) {
      return { output: '', error: `Semantic search failed: ${(err as Error).message}. Try mode: "legacy" as fallback.` };
    }
  },
};

export const memoryGetTool: Tool = {
  name: 'memory_get',
  description: 'Read the curated long-term MEMORY.md file containing important persistent facts and notes.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    const content = memoryManagerRef.getMemory();
    if (!content) return { output: 'MEMORY.md is empty or does not exist yet.' };
    return { output: content };
  },
};

export const memorySaveTool: Tool = {
  name: 'memory_save',
  description: 'Write or replace the entire curated MEMORY.md file. Use this for major rewrites or reorganization. For adding a single fact, prefer memory_append.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Full content to write to MEMORY.md (replaces existing content)' },
    },
    required: ['content'],
  },
  async execute(params) {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    const content = params.content as string;
    memoryManagerRef.saveMemory(content);
    return { output: `MEMORY.md updated (${content.length} chars)` };
  },
};

export const memoryAppendTool: Tool = {
  name: 'memory_append',
  description: 'Append a new entry to MEMORY.md without replacing existing content. Use this to add individual facts, preferences, or notes to long-term memory.',
  parameters: {
    type: 'object',
    properties: {
      entry: { type: 'string', description: 'Text to append to MEMORY.md' },
    },
    required: ['entry'],
  },
  async execute(params) {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    const entry = params.entry as string;
    memoryManagerRef.appendMemory(entry);
    return { output: `Appended to MEMORY.md (${entry.length} chars)` };
  },
};

export const memoryLogTool: Tool = {
  name: 'memory_log',
  description: 'Append a timestamped entry to today\'s daily log file. Use for recording events, decisions, observations, and running notes. Daily logs are automatically included in your context.',
  parameters: {
    type: 'object',
    properties: {
      entry: { type: 'string', description: 'Text entry to append to today\'s daily log' },
    },
    required: ['entry'],
  },
  async execute(params) {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    const entry = params.entry as string;
    memoryManagerRef.appendDailyLog(entry);
    const date = new Date().toISOString().split('T')[0];
    return { output: `Logged to ${date}.md` };
  },
};

export const memoryFilesTool: Tool = {
  name: 'memory_files',
  description: 'List all memory files with their names, sizes, and last modified dates.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    const files = memoryManagerRef.listFiles();
    if (files.length === 0) return { output: 'No memory files found.' };
    const lines = files.map(f =>
      `${f.name} | ${f.size} bytes | modified ${f.modified}`
    );
    return { output: lines.join('\n') };
  },
};

// ── New identity file tools ─────────────────────────────────────────────

const IDENTITY_FILES = ['PERSONALITY.md', 'USER.md', 'IDENTITY.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md', 'MEMORY.md'];

export const identityReadTool: Tool = {
  name: 'identity_read',
  description: 'Read an identity/personality file (PERSONALITY.md, USER.md, IDENTITY.md, AGENTS.md, TOOLS.md, HEARTBEAT.md). These files define who you are and how you behave.',
  parameters: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'File name to read (e.g. "PERSONALITY.md", "USER.md", "IDENTITY.md")',
        enum: IDENTITY_FILES,
      },
    },
    required: ['file'],
  },
  async execute(params) {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    const file = params.file as string;
    if (!IDENTITY_FILES.includes(file)) {
      return { output: '', error: `Invalid file. Choose from: ${IDENTITY_FILES.join(', ')}` };
    }
    const content = memoryManagerRef.getIdentityFile(file);
    if (!content) return { output: `${file} does not exist or is empty.` };
    return { output: content };
  },
};

export const identityWriteTool: Tool = {
  name: 'identity_write',
  description: 'Write/update an identity/personality file (PERSONALITY.md, USER.md, IDENTITY.md, AGENTS.md, TOOLS.md, HEARTBEAT.md). Use this to update who you are, record user preferences, or modify your behavior. If updating PERSONALITY.md, tell the user.',
  parameters: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'File name to write (e.g. "IDENTITY.md", "USER.md")',
        enum: IDENTITY_FILES,
      },
      content: {
        type: 'string',
        description: 'Full content to write to the file',
      },
    },
    required: ['file', 'content'],
  },
  async execute(params) {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    const file = params.file as string;
    const content = params.content as string;
    if (!IDENTITY_FILES.includes(file)) {
      return { output: '', error: `Invalid file. Choose from: ${IDENTITY_FILES.join(', ')}` };
    }
    memoryManagerRef.saveIdentityFile(file, content);
    return { output: `${file} updated (${content.length} chars). Changes take effect on next message.` };
  },
};

// ── Bootstrap lifecycle ─────────────────────────────────────────────────

export const memoryReindexTool: Tool = {
  name: 'memory_reindex',
  description: 'Rebuild the semantic search index for all memory files. Use this if search results seem stale or after bulk changes to memory files. Only re-indexes files that have changed since last indexing.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    const stats = memoryManagerRef.getIndexStats();
    if (!stats.enabled) {
      return { output: 'Semantic search is disabled. Enable it in config: memory.embedding.enabled = true' };
    }
    try {
      const result = await memoryManagerRef.indexAll();
      return {
        output: `Reindex complete:\n- ${result.files} files indexed (${result.indexed} new chunks)\n- ${result.skipped} files unchanged (skipped)\n- Total chunks in index: ${memoryManagerRef.getIndexStats().totalChunks}`,
      };
    } catch (err) {
      return { output: '', error: `Reindex failed: ${(err as Error).message}` };
    }
  },
};

export const memoryIndexStatsTool: Tool = {
  name: 'memory_index_stats',
  description: 'Show stats about the semantic search index: number of chunks, indexed files, and whether embeddings are enabled.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    const stats = memoryManagerRef.getIndexStats();
    if (!stats.enabled) {
      return { output: 'Semantic search: DISABLED\nUsing legacy substring search only.\nEnable in config: memory.embedding.enabled = true' };
    }
    const lines = [
      `Semantic search: ENABLED`,
      `Total chunks: ${stats.totalChunks}`,
      `Indexed files: ${stats.indexedFiles.length}`,
      ...stats.indexedFiles.map(f => `  - ${f}`),
    ];
    return { output: lines.join('\n') };
  },
};

// ── Bootstrap lifecycle ─────────────────────────────────────────────────

export const bootstrapCompleteTool: Tool = {
  name: 'bootstrap_complete',
  description: 'Mark the first-run bootstrap as complete by deleting BOOTSTRAP.md. Call this after you have finished the introductory conversation: you know your name, the user\'s name, and have filled in IDENTITY.md and USER.md.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    if (!memoryManagerRef.hasBootstrap()) {
      return { output: 'Bootstrap already completed (BOOTSTRAP.md does not exist).' };
    }
    memoryManagerRef.deleteBootstrap();
    return { output: 'Bootstrap complete. BOOTSTRAP.md deleted. You\'re you now.' };
  },
};

// ── Export all ───────────────────────────────────────────────────────────

export const memoryTools = [
  memorySearchTool,
  memoryGetTool,
  memorySaveTool,
  memoryAppendTool,
  memoryLogTool,
  memoryFilesTool,
  memoryReindexTool,
  memoryIndexStatsTool,
  identityReadTool,
  identityWriteTool,
  bootstrapCompleteTool,
];
