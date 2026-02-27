import type { Tool } from '../tool-registry.js';
import type { MemoryManager } from '../../memory/manager.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let memoryManagerRef: MemoryManager | null = null;

export function setMemoryManager(mm: MemoryManager): void {
  memoryManagerRef = mm;
}

// Identity files (personality, user info, agent config) - NOT memory files
// MEMORY.md is handled separately as Tier 1 core memory via memory tool read/write/append
const IDENTITY_FILES = ['PERSONALITY.md', 'USER.md', 'IDENTITY.md', 'AGENTS.md', 'HEARTBEAT.md'];
const OBJECTIVE_LOG_FILE = 'OBJECTIVE_LOG.md';

// ── Unified memory tool ──────────────────────────────────────────────────

const memoryTool: Tool = {
  name: 'memory',
  description: [
    'Manage persistent memory and identity across sessions.',
    '',
    'CORE MEMORY (MEMORY.md):',
    '  read — show core memory',
    '  append — add to core memory',
    '  write — replace core memory',
    '',
    'IDENTITY FILES:',
    '  identity_read — read PERSONALITY.md, USER.md, IDENTITY.md, AGENTS.md, or HEARTBEAT.md',
    '  identity_write — update an identity file',
    '',
    'HEARTBEAT LOOP:',
    '  heartbeat_read — read OBJECTIVE_LOG.md or HEARTBEAT.md',
    '  heartbeat_write — write OBJECTIVE_LOG.md or HEARTBEAT.md',
    '',
    'TOPIC FILES (memory/*.md):',
    '  tier2_list/read/write/append/delete',
    '',
    'ARCHIVE (archive/*.md):',
    '  archive_list/read/write/append/delete',
    '',
    'SEARCH SYNTAX (Google-like):',
    '  word — matches any document with "word"',
    '  "exact phrase" — matches the exact phrase',
    '  -word — excludes documents with "word"',
    '  -"bad phrase" — excludes documents with phrase',
    '  word1 OR word2 — matches either word',
    '  file:name — filter by filename',
    '',
    'SEARCH EXAMPLES:',
    '  discord — find any mention of discord',
    '  "project alpha" — exact phrase match',
    '  discord -bot — discord but not bot',
    '  bug OR error — either bug or error',
    '  file:2024-12 — search only December logs',
    '',
    'OTHER:',
    '  log — add to daily log',
    '  files — list all memory files',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: read|write|append|search|log|log_read|files|reindex|stats|tier2_list|tier2_read|tier2_write|tier2_append|tier2_delete|archive_list|archive_read|archive_write|archive_append|archive_delete|identity_read|identity_write|heartbeat_read|heartbeat_write',
      },
      query: { type: 'string', description: 'Search query (for search, log_read)' },
      content: { type: 'string', description: 'Full content (for write, tier2_write, identity_write, heartbeat_write)' },
      entry: { type: 'string', description: 'Text to append (for append, log, tier2_append)' },
      topic: { type: 'string', description: 'Topic name for Tier 2 files' },
      file: { type: 'string', description: 'Identity file name (for identity_read/write)' },
      target: { type: 'string', description: 'heartbeat target: objective|heartbeat (for heartbeat_read/write)' },
      limit: { type: 'number', description: 'Max search results (default 10)' },
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
        const stats = memoryManagerRef.getIndexStats();
        
        // Auto-fallback to legacy search if embeddings disabled
        if (!stats.enabled || stats.totalChunks === 0) {
          const results = memoryManagerRef.search(query, limit);
          if (results.length === 0) return { output: `No results found for "${query}"` };
          return { output: `_Legacy search_\n\n` + results.map(r => `### ${r.file}\n${r.matches.join('\n---\n')}`).join('\n\n') };
        }
        
        // Try semantic search, fallback to legacy on error
        try {
          const results = await memoryManagerRef.semanticSearch(query, limit);
          if (results.length === 0) return { output: `No results found for "${query}"` };
          const formatted = results.map((r, i) => {
            const scoreStr = `score: ${r.score.toFixed(3)}`;
            return `### ${i + 1}. ${r.file} [${scoreStr}]\n${r.text}`;
          });
          return { output: `_Searched ${stats.totalChunks} chunks_\n` + formatted.join('\n\n---\n\n') };
        } catch (err) {
          // Fallback to legacy search on any error
          const results = memoryManagerRef.search(query, limit);
          if (results.length === 0) return { output: `No results found for "${query}"` };
          return { output: `_Legacy search (semantic failed)_\n\n` + results.map(r => `### ${r.file}\n${r.matches.join('\n---\n')}`).join('\n\n') };
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
        if (!stats.enabled) return { output: 'Semantic search: DISABLED (using legacy substring search)' };
        return { output: `Semantic search: ENABLED\nChunks: ${stats.totalChunks}\nFiles: ${stats.indexedFiles.join(', ')}` };
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

      // ── Identity file access ──
      case 'identity_read': {
        const file = params.file as string;
        if (!file) return { output: '', error: 'file is required (PERSONALITY.md, USER.md, IDENTITY.md, AGENTS.md, HEARTBEAT.md)' };
        if (!IDENTITY_FILES.includes(file)) {
          return { output: '', error: `Invalid file. Choose from: ${IDENTITY_FILES.join(', ')}` };
        }
        const content = memoryManagerRef.getIdentityFile(file);
        if (!content) return { output: `${file} does not exist or is empty.` };
        return { output: content };
      }
      case 'identity_write': {
        const file = params.file as string;
        const content = params.content as string;
        if (!file) return { output: '', error: 'file is required' };
        if (!IDENTITY_FILES.includes(file)) {
          return { output: '', error: `Invalid file. Choose from: ${IDENTITY_FILES.join(', ')}` };
        }
        if (!content) return { output: '', error: 'content is required' };
        memoryManagerRef.saveIdentityFile(file, content);
        return { output: `${file} updated (${content.length} chars). Changes take effect on next message.` };
      }
      case 'heartbeat_read': {
        const target = ((params.target as string) || 'objective').toLowerCase();
        if (target === 'heartbeat') {
          const content = memoryManagerRef.getIdentityFile('HEARTBEAT.md');
          return { output: content || 'HEARTBEAT.md is empty.' };
        }
        if (target === 'objective') {
          const path = join(memoryManagerRef.getDirectory(), OBJECTIVE_LOG_FILE);
          if (!existsSync(path)) return { output: `${OBJECTIVE_LOG_FILE} does not exist yet.` };
          const content = readFileSync(path, 'utf-8');
          return { output: content || `${OBJECTIVE_LOG_FILE} is empty.` };
        }
        return { output: '', error: 'Invalid target. Use objective or heartbeat.' };
      }
      case 'heartbeat_write': {
        const target = ((params.target as string) || 'objective').toLowerCase();
        const content = params.content as string;
        if (!content) return { output: '', error: 'content is required' };
        if (target === 'heartbeat') {
          memoryManagerRef.saveIdentityFile('HEARTBEAT.md', content);
          return { output: `HEARTBEAT.md updated (${content.length} chars)` };
        }
        if (target === 'objective') {
          const path = join(memoryManagerRef.getDirectory(), OBJECTIVE_LOG_FILE);
          writeFileSync(path, content);
          return { output: `${OBJECTIVE_LOG_FILE} updated (${content.length} chars)` };
        }
        return { output: '', error: 'Invalid target. Use objective or heartbeat.' };
      }

      default:
        return { output: '', error: `Unknown action "${action}". Valid: read, write, append, search, log, log_read, files, reindex, stats, tier2_*, archive_*, identity_read, identity_write, heartbeat_read, heartbeat_write` };
    }
  },
};

// ── Bootstrap lifecycle ──────────────────────────────────────────────────

const bootstrapCompleteTool: Tool = {
  name: 'bootstrap_complete',
  description: [
    'Mark first-run bootstrap as complete by deleting BOOTSTRAP.md.',
    '',
    'WHEN TO USE:',
    '- After completing the initial introduction conversation',
    '- When you have learned the user\'s name and preferences',
    '- When you have set up your identity in IDENTITY.md',
    '- When you have recorded user information in USER.md',
    '- To transition from setup mode to normal operation',
    '',
    'HOW TO USE:',
    '- Call without parameters: bootstrap_complete()',
    '- Should be called only once during initial setup',
    '',
    'PREREQUISITES:',
    '- You know the user\'s name and basic information',
    '- Your identity is set up in IDENTITY.md',
    '- Core personality traits are defined in PERSONALITY.md',
    '- User preferences are recorded in USER.md',
    '',
    'SAFETY NOTES:',
    '- This action is irreversible - BOOTSTRAP.md is permanently deleted',
    '- Transitions system to normal operation mode',
    '- Only call when truly ready to complete setup',
    '',
    'AFTER EXECUTION:',
    '- System operates in normal mode',
    '- No longer prompts for initial setup information',
    '- Regular memory and conversation flow begins',
  ].join('\n'),
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

// ── Exports ───────────────────────────────────────────────────────────────

export {
  memoryTool as memorySearchTool,      // keep old export name for agent.ts compatibility
  memoryTool as memoryGetTool,
  memoryTool as memorySaveTool,
  memoryTool as memoryAppendTool,
  memoryTool as memoryLogTool,
  memoryTool as memoryFilesTool,
  memoryTool as memoryReindexTool,
  memoryTool as memoryIndexStatsTool,
  memoryTool as identityReadTool,      // now part of memory tool (identity_read action)
  memoryTool as identityWriteTool,     // now part of memory tool (identity_write action)
  bootstrapCompleteTool,
};

export const memoryTools = [
  memoryTool,
  bootstrapCompleteTool,
];
