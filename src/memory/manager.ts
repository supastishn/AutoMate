import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VectorIndex, type EmbeddingConfig, type SearchResult } from './vector-index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = join(__dirname, 'defaults');

// Files that get default templates on first run
const TEMPLATE_FILES = ['PERSONALITY.md', 'BOOTSTRAP.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'HEARTBEAT.md'];

// Files injected into the system prompt (order matters)
const PROMPT_FILES = ['AGENTS.md', 'PERSONALITY.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md'];

// Files to index for semantic search (all .md files are indexed)
const SKIP_INDEX_FILES = ['.vector-index.json'];

export class MemoryManager {
  private dir: string;
  private vectorIndex: VectorIndex | null = null;
  private embeddingConfig: EmbeddingConfig | null = null;
  private indexingInProgress: boolean = false;

  constructor(memoryDir: string, embeddingConfig?: EmbeddingConfig) {
    this.dir = memoryDir;
    mkdirSync(this.dir, { recursive: true });
    this.ensureDefaults();

    // Store config even if disabled — needed for /index on later
    if (embeddingConfig) {
      this.embeddingConfig = embeddingConfig;
      if (embeddingConfig.enabled) {
        this.vectorIndex = new VectorIndex(this.dir, embeddingConfig);
      }
    }
  }

  /** Get the memory directory path. */
  getDirectory(): string {
    return this.dir;
  }

  /** Copy default templates for any missing identity files on first run */
  private ensureDefaults(): void {
    for (const file of TEMPLATE_FILES) {
      const dest = join(this.dir, file);
      if (!existsSync(dest)) {
        const src = join(DEFAULTS_DIR, file);
        if (existsSync(src)) {
          copyFileSync(src, dest);
        }
      }
    }
  }

  // ── MEMORY.md (curated long-term) ──────────────────────────────────────

  getMemory(): string {
    const path = join(this.dir, 'MEMORY.md');
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  }

  saveMemory(content: string): void {
    writeFileSync(join(this.dir, 'MEMORY.md'), content);
    this._queueReindex('MEMORY.md', content);
  }

  appendMemory(entry: string): void {
    const path = join(this.dir, 'MEMORY.md');
    const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    const separator = existing && !existing.endsWith('\n') ? '\n' : '';
    const newContent = existing + separator + entry + '\n';
    writeFileSync(path, newContent);
    this._queueReindex('MEMORY.md', newContent);
  }

  // ── Daily logs ────────────────────────────────────────────────────────

  appendDailyLog(entry: string): void {
    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}.md`;
    const path = join(this.dir, filename);
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    appendFileSync(path, `\n## ${timestamp}\n${entry}\n`);
    // Re-index daily log after append
    const content = readFileSync(path, 'utf-8');
    this._queueReindex(filename, content);
  }

  /** Get today's daily log content */
  getDailyLog(date?: string): string {
    const d = date || new Date().toISOString().split('T')[0];
    const path = join(this.dir, `${d}.md`);
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  }

  /** Get recent daily logs (today + yesterday) for prompt injection */
  getRecentDailyLogs(): string {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const todayStr = today.toISOString().split('T')[0];
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const sections: string[] = [];

    const yesterdayLog = this.getDailyLog(yesterdayStr);
    if (yesterdayLog) {
      // Truncate yesterday to last 2000 chars to save context
      const trimmed = yesterdayLog.length > 2000
        ? '...\n' + yesterdayLog.slice(-2000)
        : yesterdayLog;
      sections.push(`### Yesterday (${yesterdayStr})\n${trimmed}`);
    }

    const todayLog = this.getDailyLog(todayStr);
    if (todayLog) {
      sections.push(`### Today (${todayStr})\n${todayLog}`);
    }

    if (sections.length === 0) return '';
    return sections.join('\n\n');
  }

  // ── Identity files (PERSONALITY.md, USER.md, IDENTITY.md, etc.) ─────────────

  getIdentityFile(name: string): string {
    const path = join(this.dir, name);
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  }

  saveIdentityFile(name: string, content: string): void {
    writeFileSync(join(this.dir, name), content);
    this._queueReindex(name, content);
  }

  /** Check if BOOTSTRAP.md exists (first-run state) */
  hasBootstrap(): boolean {
    return existsSync(join(this.dir, 'BOOTSTRAP.md'));
  }

  /** Delete BOOTSTRAP.md (called after first-run conversation) */
  deleteBootstrap(): void {
    const path = join(this.dir, 'BOOTSTRAP.md');
    if (existsSync(path)) unlinkSync(path);
  }

  /** Factory reset: wipe all memory files and restore defaults */
  factoryReset(): void {
    if (existsSync(this.dir)) {
      const files = readdirSync(this.dir);
      for (const f of files) {
        const p = join(this.dir, f);
        const stat = statSync(p);
        if (stat.isFile()) unlinkSync(p);
      }
    }
    // Clear vector index
    if (this.vectorIndex) {
      this.vectorIndex.clear();
      this.vectorIndex.save();
    }
    this.ensureDefaults();
  }

  /** Parse agent name from IDENTITY.md */
  getAgentName(): string | null {
    const identity = this.getIdentityFile('IDENTITY.md');
    if (!identity) return null;
    // Match "- **Name:** Something" pattern
    const match = identity.match(/\*\*Name:\*\*\s*(.+)/i);
    if (!match) return null;
    const name = match[1].trim();
    // Skip placeholder text
    if (name.startsWith('_') || name.startsWith('(') || !name || name.includes('pick something')) {
      return null;
    }
    return name;
  }

  /** Parse agent emoji from IDENTITY.md */
  getAgentEmoji(): string | null {
    const identity = this.getIdentityFile('IDENTITY.md');
    if (!identity) return null;
    const match = identity.match(/\*\*Emoji:\*\*\s*(.+)/i);
    if (!match) return null;
    const emoji = match[1].trim();
    if (emoji.startsWith('_') || emoji.startsWith('(') || !emoji || emoji.includes('pick one')) {
      return null;
    }
    return emoji;
  }

  // ── Indexing Toggle ────────────────────────────────────────────────────

  /** Enable semantic indexing at runtime. Loads existing index from disk. */
  enableIndexing(): void {
    if (this.vectorIndex) return; // already on
    if (!this.embeddingConfig) {
      // No config at all — create defaults
      this.embeddingConfig = {
        enabled: true,
        model: 'text-embedding-3-small',
        apiBase: 'http://localhost:4141/v1',
        chunkSize: 512,
        chunkOverlap: 64,
        vectorWeight: 0.6,
        bm25Weight: 0.4,
        topK: 10,
      };
    }
    this.embeddingConfig.enabled = true;
    this.vectorIndex = new VectorIndex(this.dir, this.embeddingConfig);
  }

  /** Disable semantic indexing at runtime. Index is preserved on disk for later. */
  disableIndexing(): void {
    if (this.vectorIndex) {
      this.vectorIndex.save(); // persist before disabling
      this.vectorIndex = null;
    }
    if (this.embeddingConfig) {
      this.embeddingConfig.enabled = false;
    }
  }

  /** Clear the entire index and force a full rebuild on next indexAll(). */
  clearIndex(): void {
    if (this.vectorIndex) {
      this.vectorIndex.clear();
      this.vectorIndex.save();
    }
  }

  // ── Vector Index Management ─────────────────────────────────────────────

  /** Queue a file for re-indexing (non-blocking, fire-and-forget) */
  private _queueReindex(filename: string, content: string): void {
    if (!this.vectorIndex) return;
    // Fire and forget — don't block the caller
    this.vectorIndex.indexFile(filename, content)
      .then(() => this.vectorIndex!.save())
      .catch(err => {
        // Silently fail — embedding service might be down
        // The old text search still works as fallback
        console.error(`[memory] Failed to index ${filename}:`, err.message);
      });
  }

  /**
   * Index all .md files in the memory directory.
   * Call this on startup to build/refresh the index.
   * Returns number of chunks indexed.
   */
  async indexAll(): Promise<{ indexed: number; files: number; skipped: number }> {
    if (!this.vectorIndex) return { indexed: 0, files: 0, skipped: 0 };
    if (this.indexingInProgress) return { indexed: 0, files: 0, skipped: 0 };

    this.indexingInProgress = true;
    let totalChunks = 0;
    let filesIndexed = 0;
    let filesSkipped = 0;

    try {
      // Collect top-level .md files
      const topFiles = readdirSync(this.dir).filter(f =>
        f.endsWith('.md') && !SKIP_INDEX_FILES.includes(f)
      ).map(f => ({ key: f, path: join(this.dir, f) }));

      // Also collect .md files from transcripts/ subdirectory
      const transcriptsDir = join(this.dir, 'transcripts');
      if (existsSync(transcriptsDir)) {
        const transcriptFiles = readdirSync(transcriptsDir).filter(f => f.endsWith('.md'));
        for (const f of transcriptFiles) {
          topFiles.push({ key: `transcripts/${f}`, path: join(transcriptsDir, f) });
        }
      }

      for (const { key, path } of topFiles) {
        const content = readFileSync(path, 'utf-8');

        if (!this.vectorIndex.needsReindex(key, content)) {
          filesSkipped++;
          continue;
        }

        try {
          const chunks = await this.vectorIndex.indexFile(key, content);
          totalChunks += chunks;
          filesIndexed++;
        } catch (err) {
          console.error(`[memory] Failed to index ${key}:`, (err as Error).message);
        }
      }

      this.vectorIndex.save();
    } finally {
      this.indexingInProgress = false;
    }

    return { indexed: totalChunks, files: filesIndexed, skipped: filesSkipped };
  }

  /** Get vector index stats */
  getIndexStats(): { enabled: boolean; totalChunks: number; indexedFiles: string[] } {
    if (!this.vectorIndex) {
      return { enabled: false, totalChunks: 0, indexedFiles: [] };
    }
    return {
      enabled: true,
      totalChunks: this.vectorIndex.size,
      indexedFiles: this.vectorIndex.indexedFiles,
    };
  }

  // ── Search ────────────────────────────────────────────────────────────

  /**
   * Semantic search: hybrid vector + BM25.
   * Falls back to BM25-only if embeddings fail, then to naive text search.
   */
  async semanticSearch(query: string, limit: number = 10): Promise<SearchResult[]> {
    if (!this.vectorIndex || this.vectorIndex.size === 0) {
      // Fallback: if no index yet, try BM25 on indexed chunks
      if (this.vectorIndex && this.vectorIndex.size > 0) {
        return this.vectorIndex.textSearch(query, limit);
      }
      // Ultimate fallback: use old text search, wrap in SearchResult format
      return this._legacySearchAsResults(query, limit);
    }

    try {
      return await this.vectorIndex.search(query, limit);
    } catch {
      // Embedding API down — fall back to BM25
      try {
        return this.vectorIndex.textSearch(query, limit);
      } catch {
        // BM25 also failed — use legacy
        return this._legacySearchAsResults(query, limit);
      }
    }
  }

  /** Convert legacy search results to SearchResult format */
  private _legacySearchAsResults(query: string, limit: number): SearchResult[] {
    const legacy = this.search(query, limit);
    return legacy.flatMap(r =>
      r.matches.map(m => ({
        file: r.file,
        text: m,
        score: 0.5, // no real score for legacy
        vectorScore: 0,
        bm25Score: 0,
      }))
    ).slice(0, limit);
  }

  /** Legacy substring search — kept as fallback */
  search(query: string, limit: number = 10): { file: string; matches: string[] }[] {
    const results: { file: string; matches: string[] }[] = [];
    const files = readdirSync(this.dir).filter(f => f.endsWith('.md'));
    const queryLower = query.toLowerCase();

    for (const file of files) {
      const content = readFileSync(join(this.dir, file), 'utf-8');
      const lines = content.split('\n');
      const matches: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(queryLower)) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 3);
          matches.push(lines.slice(start, end).join('\n'));
        }
      }

      if (matches.length > 0) {
        results.push({ file, matches: matches.slice(0, 5) });
      }
    }

    return results.slice(0, limit);
  }

  // ── File listing ──────────────────────────────────────────────────────

  listFiles(): { name: string; size: number; modified: string }[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter(f => f.endsWith('.md'));
    return files.map(f => {
      const stat = statSync(join(this.dir, f));
      return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
    });
  }

  // ── System prompt injection ───────────────────────────────────────────

  getPromptInjection(): string {
    const sections: string[] = [];

    // Bootstrap takes priority over everything on first run
    if (this.hasBootstrap()) {
      const bootstrap = this.getIdentityFile('BOOTSTRAP.md');
      if (bootstrap) {
        sections.push(`## FIRST RUN\n${bootstrap}`);
      }
    }

    // Identity/personality files
    for (const file of PROMPT_FILES) {
      const content = this.getIdentityFile(file);
      if (content) {
        // Truncate large files to prevent context overflow
        const trimmed = content.length > 5000
          ? content.slice(0, 5000) + '\n\n_(truncated — file is too large)_'
          : content;
        sections.push(`## ${file.replace('.md', '')}\n${trimmed}`);
      }
    }

    // Curated long-term memory
    const memory = this.getMemory();
    if (memory) {
      const trimmed = memory.length > 8000
        ? memory.slice(0, 8000) + '\n\n_(truncated — use memory_search for full access)_'
        : memory;
      sections.push(`## Long-term Memory\n${trimmed}`);
    }

    // Recent daily logs (today + yesterday)
    const recentLogs = this.getRecentDailyLogs();
    if (recentLogs) {
      sections.push(`## Recent Daily Log\n${recentLogs}`);
    }

    if (sections.length === 0) return '';
    return '\n\n# Agent Memory & Identity\n\n' + sections.join('\n\n---\n\n');
  }
}
