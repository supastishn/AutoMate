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
    'read — read the curated MEMORY.md file (Tier 1 core memory).',
    'write — replace entire MEMORY.md content. Pass content. Hard cap: ~4000 chars.',
    'append — append to MEMORY.md without replacing. Pass entry.',
    'log — append timestamped entry to today\'s daily log. Pass entry.',
    'log_read — read a daily log. Pass query as date (YYYY-MM-DD), defaults to today.',
    'files — list all memory files with sizes.',
    'reindex — rebuild the semantic search index.',
    'stats — show search index statistics.',
    '',
    'Tier 2 (topic-based reference memory, loaded on-demand):',
    'tier2_list — list all Tier 2 topic files.',
    'tier2_read — read a Tier 2 topic file. Pass topic (e.g. "discord", "reddit").',
    'tier2_write — write/replace a Tier 2 topic file. Pass topic + content.',
    'tier2_append — append to a Tier 2 topic file. Pass topic + entry.',
    'tier2_delete — delete a Tier 2 topic file. Pass topic.',
    '',
    'Archive (cold storage for recordkeeping, lower priority):',
    'archive_list — list all archive files.',
    'archive_read — read an archive file. Pass topic.',
    'archive_write — write/replace an archive file. Pass topic + content.',
    'archive_append — append to an archive file. Pass topic + entry.',
    'archive_delete — delete an archive file. Pass topic.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: search|read|write|append|log|log_read|files|reindex|stats|tier2_list|tier2_read|tier2_write|tier2_append|tier2_delete|archive_list|archive_read|archive_write|archive_append|archive_delete',
      },
      query: { type: 'string', description: 'Search query (for search)' },
      content: { type: 'string', description: 'Full content (for write, tier2_write)' },
      entry: { type: 'string', description: 'Text to append (for append, log, tier2_append)' },
      topic: { type: 'string', description: 'Topic name for Tier 2 files (e.g. "discord", "reddit", "workshop")' },
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
      case 'log_read': {
        const date = (params.query as string) || new Date().toISOString().split('T')[0];
        const content = memoryManagerRef.getDailyLog(date);
        if (!content) return { output: `No daily log found for ${date}.` };
        return { output: content };
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

      // ── Tier 2 operations ──
      case 'tier2_list': {
        const files = memoryManagerRef.listTier2();
        if (files.length === 0) return { output: 'No Tier 2 topic files yet. Create one with tier2_write action.' };
        return { output: `Tier 2 topic files (${files.length}):\n` + files.map(f => `  ${f.name} | ${f.size} bytes | modified ${f.modified}`).join('\n') };
      }
      case 'tier2_read': {
        const topic = params.topic as string;
        if (!topic) return { output: '', error: 'topic is required for tier2_read (e.g. "discord", "reddit")' };
        const content = memoryManagerRef.getTier2(topic);
        if (!content) return { output: `Tier 2 file "${topic}" does not exist or is empty.` };
        return { output: content };
      }
      case 'tier2_write': {
        const topic = params.topic as string;
        const content = params.content as string;
        if (!topic) return { output: '', error: 'topic is required for tier2_write' };
        if (!content) return { output: '', error: 'content is required for tier2_write' };
        memoryManagerRef.saveTier2(topic, content);
        return { output: `Tier 2 "${topic}" written (${content.length} chars)` };
      }
      case 'tier2_append': {
        const topic = params.topic as string;
        const entry = params.entry as string;
        if (!topic) return { output: '', error: 'topic is required for tier2_append' };
        if (!entry) return { output: '', error: 'entry is required for tier2_append' };
        memoryManagerRef.appendTier2(topic, entry);
        return { output: `Appended to Tier 2 "${topic}" (${entry.length} chars)` };
      }
      case 'tier2_delete': {
        const topic = params.topic as string;
        if (!topic) return { output: '', error: 'topic is required for tier2_delete' };
        memoryManagerRef.deleteTier2(topic);
        return { output: `Tier 2 "${topic}" deleted.` };
      }

      // ── Archive operations (cold storage) ──
      case 'archive_list': {
        const files = memoryManagerRef.listArchive();
        if (files.length === 0) return { output: 'No archive files yet. Create one with archive_write action.' };
        return { output: `Archive files (${files.length}):\n` + files.map(f => `  ${f.name} | ${f.size} bytes | modified ${f.modified}`).join('\n') };
      }
      case 'archive_read': {
        const topic = params.topic as string;
        if (!topic) return { output: '', error: 'topic is required for archive_read' };
        const content = memoryManagerRef.getArchive(topic);
        if (!content) return { output: `Archive file "${topic}" does not exist or is empty.` };
        return { output: content };
      }
      case 'archive_write': {
        const topic = params.topic as string;
        const content = params.content as string;
        if (!topic) return { output: '', error: 'topic is required for archive_write' };
        if (!content) return { output: '', error: 'content is required for archive_write' };
        memoryManagerRef.saveArchive(topic, content);
        return { output: `Archive "${topic}" written (${content.length} chars)` };
      }
      case 'archive_append': {
        const topic = params.topic as string;
        const entry = params.entry as string;
        if (!topic) return { output: '', error: 'topic is required for archive_append' };
        if (!entry) return { output: '', error: 'entry is required for archive_append' };
        memoryManagerRef.appendArchive(topic, entry);
        return { output: `Appended to archive "${topic}" (${entry.length} chars)` };
      }
      case 'archive_delete': {
        const topic = params.topic as string;
        if (!topic) return { output: '', error: 'topic is required for archive_delete' };
        memoryManagerRef.deleteArchive(topic);
        return { output: `Archive "${topic}" deleted.` };
      }

      default:
        return { output: '', error: `Unknown action "${action}". Valid: search, read, write, append, log, log_read, files, reindex, stats, tier2_list, tier2_read, tier2_write, tier2_append, tier2_delete, archive_list, archive_read, archive_write, archive_append, archive_delete` };
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
    'Note: For topic-based reference memory (Tier 2), use the memory tool with tier2_* actions instead.',
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
