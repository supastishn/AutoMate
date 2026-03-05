import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VectorIndex, type EmbeddingConfig, type SearchResult } from './vector-index.js';
import { TextSearchIndex, type TextSearchResult } from './text-search-index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = join(__dirname, 'defaults');

// Files that get default templates on first run
// MEMORY.md is now Tier 1 (core memory — always injected, hard-capped)
// memory/ subfolder holds Tier 2 files (topic-based, loaded on-demand)
// Daily logs (YYYY-MM-DD.md) are Tier 3 (raw journal, today+yesterday injected)
const TEMPLATE_FILES = ['PERSONALITY.md', 'BOOTSTRAP.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'HEARTBEAT.md'];

// Files that should NOT be auto-injected (handled specially or reserved)
const SKIP_PROMPT_FILES = ['MEMORY.md', 'BOOTSTRAP.md', 'HEARTBEAT.md', 'OBJECTIVE_LOG.md'];

// Files to index for semantic search (all .md files are indexed)
const SKIP_INDEX_FILES = ['.vector-index.json'];

// Tier 1 hard cap (characters). Keeps core memory from bloating context.
// ~8000 chars ≈ ~2000 tokens — doubled from original 4000.
const TIER1_MAX_CHARS = 8000;

export class MemoryManager {
  private dir: string;
  private vectorIndex: VectorIndex | null = null;
  private textSearchIndex: TextSearchIndex;
  private embeddingConfig: EmbeddingConfig | null = null;
  private indexingInProgress: boolean = false;

  constructor(memoryDir: string, embeddingConfig?: EmbeddingConfig) {
    this.dir = memoryDir;
    mkdirSync(this.dir, { recursive: true });
    this.ensureDefaults();
    this._ensureTier2Dir();

    // Initialize text search index (always available, even without embeddings)
    this.textSearchIndex = new TextSearchIndex(this.dir);

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

  /** Ensure the memory/ and logs/ subfolders exist */
  private _ensureTier2Dir(): void {
    mkdirSync(join(this.dir, 'memory'), { recursive: true });
    mkdirSync(join(this.dir, 'logs'), { recursive: true });
    mkdirSync(join(this.dir, 'archive'), { recursive: true });
  }

  private get _logsDir(): string {
    return join(this.dir, 'logs');
  }

  private get _archiveDir(): string {
    return join(this.dir, 'archive');
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
    this.textSearchIndex.indexFile('MEMORY.md', content, 1); // Tier 1 = highest priority
    this.textSearchIndex.save();
  }

  appendMemory(entry: string): void {
    const path = join(this.dir, 'MEMORY.md');
    const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    const separator = existing && !existing.endsWith('\n') ? '\n' : '';
    const newContent = existing + separator + entry + '\n';
    writeFileSync(path, newContent);
    this._queueReindex('MEMORY.md', newContent);
    this.textSearchIndex.indexFile('MEMORY.md', newContent, 1);
    this.textSearchIndex.save();
  }

  // ── Tier 2 Memory (topic-based, on-demand) ────────────────────────────

  private get _tier2Dir(): string {
    return join(this.dir, 'memory');
  }

  /** List all Tier 2 topic files */
  listTier2(): { name: string; size: number; modified: string }[] {
    const dir = this._tier2Dir;
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    return files.map(f => {
      const stat = statSync(join(dir, f));
      return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
    });
  }

  /** Read a Tier 2 topic file */
  getTier2(topic: string): string {
    const name = topic.endsWith('.md') ? topic : `${topic}.md`;
    const path = join(this._tier2Dir, name);
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  }

  /** Write a Tier 2 topic file (full replace) */
  saveTier2(topic: string, content: string): void {
    const name = topic.endsWith('.md') ? topic : `${topic}.md`;
    const path = join(this._tier2Dir, name);
    writeFileSync(path, content);
    this._queueReindex(`memory/${name}`, content);
    this.textSearchIndex.indexFile(`memory/${name}`, content, 2);
    this.textSearchIndex.save();
  }

  /** Append to a Tier 2 topic file */
  appendTier2(topic: string, entry: string): void {
    const name = topic.endsWith('.md') ? topic : `${topic}.md`;
    const path = join(this._tier2Dir, name);
    const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    const separator = existing && !existing.endsWith('\n') ? '\n' : '';
    const newContent = existing + separator + entry + '\n';
    writeFileSync(path, newContent);
    this._queueReindex(`memory/${name}`, newContent);
    this.textSearchIndex.indexFile(`memory/${name}`, newContent, 2);
    this.textSearchIndex.save();
  }

  /** Delete a Tier 2 topic file */
  deleteTier2(topic: string): void {
    const name = topic.endsWith('.md') ? topic : `${topic}.md`;
    const path = join(this._tier2Dir, name);
    if (existsSync(path)) {
      unlinkSync(path);
      this.textSearchIndex.removeFile(`memory/${name}`);
      this.textSearchIndex.save();
    }
  }

  // ── Archive (Tier 4 — cold storage, recordkeeping) ────────────────────

  /** List all archive files */
  listArchive(): { name: string; size: number; modified: string }[] {
    const dir = this._archiveDir;
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    return files.map(f => {
      const stat = statSync(join(dir, f));
      return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
    });
  }

  /** Read an archive file */
  getArchive(topic: string): string {
    const name = topic.endsWith('.md') ? topic : `${topic}.md`;
    const path = join(this._archiveDir, name);
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  }

  /** Write an archive file (full replace) */
  saveArchive(topic: string, content: string): void {
    const name = topic.endsWith('.md') ? topic : `${topic}.md`;
    const path = join(this._archiveDir, name);
    writeFileSync(path, content);
    this._queueReindex(`archive/${name}`, content);
    this.textSearchIndex.indexFile(`archive/${name}`, content, 4); // Tier 4 = lowest priority
    this.textSearchIndex.save();
  }

  /** Append to an archive file */
  appendArchive(topic: string, entry: string): void {
    const name = topic.endsWith('.md') ? topic : `${topic}.md`;
    const path = join(this._archiveDir, name);
    const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    const separator = existing && !existing.endsWith('\n') ? '\n' : '';
    const newContent = existing + separator + entry + '\n';
    writeFileSync(path, newContent);
    this._queueReindex(`archive/${name}`, newContent);
    this.textSearchIndex.indexFile(`archive/${name}`, newContent, 4);
    this.textSearchIndex.save();
  }

  /** Delete an archive file */
  deleteArchive(topic: string): void {
    const name = topic.endsWith('.md') ? topic : `${topic}.md`;
    const path = join(this._archiveDir, name);
    if (existsSync(path)) {
      unlinkSync(path);
      this.textSearchIndex.removeFile(`archive/${name}`);
      this.textSearchIndex.save();
    }
  }

  // ── Transcripts (stored in transcripts/ subfolder) ────────────────────

  private get _transcriptsDir(): string {
    return join(this.dir, 'transcripts');
  }

  /** Save a session transcript and index it for search.
   *  @param append If true, appends a snapshot instead of overwriting (used before compaction). */
  saveTranscript(sessionId: string, content: string, append = false): void {
    const transcriptsDir = this._transcriptsDir;
    mkdirSync(transcriptsDir, { recursive: true });

    const safeName = sessionId.replace(/[:/\\?*"<>|]/g, '_');
    const filename = `transcript-${safeName}.md`;
    const filepath = join(transcriptsDir, filename);

    let fullContent: string;
    if (append && existsSync(filepath)) {
      appendFileSync(filepath, `\n\n---\n## Snapshot: ${new Date().toISOString()}\n\n${content}`);
      fullContent = readFileSync(filepath, 'utf-8');
    } else {
      fullContent = `# Session Transcript: ${sessionId}\n\nLast updated: ${new Date().toISOString()}\n\n${content}`;
      writeFileSync(filepath, fullContent);
    }

    // Index for text search (tier 3 - same as logs)
    this.textSearchIndex.indexFile(`transcripts/${filename}`, fullContent, 3);
    this.textSearchIndex.save();

    // Queue for vector indexing if enabled
    this._queueReindex(`transcripts/${filename}`, fullContent);
  }

  /** Delete a transcript */
  deleteTranscript(sessionId: string): void {
    const safeName = sessionId.replace(/[:/\\?*"<>|]/g, '_');
    const filename = `transcript-${safeName}.md`;
    const filepath = join(this._transcriptsDir, filename);
    if (existsSync(filepath)) {
      unlinkSync(filepath);
      this.textSearchIndex.removeFile(`transcripts/${filename}`);
      this.textSearchIndex.save();
    }
  }

  /** List all transcripts */
  listTranscripts(): { name: string; size: number; modified: string }[] {
    const dir = this._transcriptsDir;
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    return files.map(f => {
      const stat = statSync(join(dir, f));
      return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
    });
  }

  // ── Daily logs (stored in logs/ subfolder) ──────────────────────────

  appendDailyLog(entry: string): void {
    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}.md`;
    const path = join(this._logsDir, filename);
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    appendFileSync(path, `\n## ${timestamp}\n${entry}\n`);
    // Re-index daily log after append
    const content = readFileSync(path, 'utf-8');
    this._queueReindex(`logs/${filename}`, content);
    this.textSearchIndex.indexFile(`logs/${filename}`, content, 3);
    this.textSearchIndex.save();
  }

  /** Get today's daily log content */
  getDailyLog(date?: string): string {
    const d = date || new Date().toISOString().split('T')[0];
    // Check logs/ subfolder first, fall back to root for migration
    const logsPath = join(this._logsDir, `${d}.md`);
    if (existsSync(logsPath)) return readFileSync(logsPath, 'utf-8');
    const rootPath = join(this.dir, `${d}.md`);
    if (existsSync(rootPath)) return readFileSync(rootPath, 'utf-8');
    return '';
  }

  /** Get recent daily log dates (for Tier 2 listing) */
  getRecentLogDates(count: number = 5): string[] {
    const dates: string[] = [];
    // Check logs/ subfolder
    if (existsSync(this._logsDir)) {
      const files = readdirSync(this._logsDir)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .reverse();
      for (const f of files.slice(0, count)) {
        dates.push(f.replace('.md', ''));
      }
    }
    // Also check root for unmigrated logs
    if (dates.length < count) {
      const rootFiles = readdirSync(this.dir)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .reverse();
      for (const f of rootFiles) {
        const date = f.replace('.md', '');
        if (!dates.includes(date)) {
          dates.push(date);
          if (dates.length >= count) break;
        }
      }
    }
    return dates;
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
    this.textSearchIndex.indexFile(name, content, 2);
    this.textSearchIndex.save();
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
    // Clear text search index
    this.textSearchIndex.clear();
    this.textSearchIndex.save();
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
  async indexAll(): Promise<{ indexed: number; files: number; skipped: number; textIndexed: number }> {
    if (this.indexingInProgress) return { indexed: 0, files: 0, skipped: 0, textIndexed: 0 };

    this.indexingInProgress = true;
    let totalChunks = 0;
    let filesIndexed = 0;
    let filesSkipped = 0;
    let textFilesIndexed = 0;

    try {
      // Collect top-level .md files
      const topFiles = readdirSync(this.dir).filter(f =>
        f.endsWith('.md') && !SKIP_INDEX_FILES.includes(f)
      ).map(f => ({ key: f, path: join(this.dir, f), tier: f === 'MEMORY.md' ? 1 : 2 }));

      // Also collect .md files from transcripts/ subdirectory
      const transcriptsDir = join(this.dir, 'transcripts');
      if (existsSync(transcriptsDir)) {
        const transcriptFiles = readdirSync(transcriptsDir).filter(f => f.endsWith('.md'));
        for (const f of transcriptFiles) {
          topFiles.push({ key: `transcripts/${f}`, path: join(transcriptsDir, f), tier: 3 });
        }
      }

      // Also collect .md files from memory/ subdirectory (Tier 2 topics)
      const tier2Dir = this._tier2Dir;
      if (existsSync(tier2Dir)) {
        const tier2Files = readdirSync(tier2Dir).filter(f => f.endsWith('.md'));
        for (const f of tier2Files) {
          topFiles.push({ key: `memory/${f}`, path: join(tier2Dir, f), tier: 2 });
        }
      }

      // Also collect .md files from logs/ subdirectory (daily logs)
      const logsDir = this._logsDir;
      if (existsSync(logsDir)) {
        const logFiles = readdirSync(logsDir).filter(f => f.endsWith('.md'));
        for (const f of logFiles) {
          topFiles.push({ key: `logs/${f}`, path: join(logsDir, f), tier: 3 });
        }
      }

      // Also collect .md files from archive/ subdirectory (Tier 4 archive)
      const archiveDir = this._archiveDir;
      if (existsSync(archiveDir)) {
        const archiveFiles = readdirSync(archiveDir).filter(f => f.endsWith('.md'));
        for (const f of archiveFiles) {
          topFiles.push({ key: `archive/${f}`, path: join(archiveDir, f), tier: 4 });
        }
      }

      for (const { key, path, tier } of topFiles) {
        let content: string;
        try {
          content = readFileSync(path, 'utf-8');
        } catch (readErr) {
          console.error(`[memory] Failed to read ${key}:`, (readErr as Error).message);
          continue;
        }

        // Vector indexing (if enabled)
        if (this.vectorIndex) {
          if (this.vectorIndex.needsReindex(key, content)) {
            try {
              const chunks = await this.vectorIndex.indexFile(key, content);
              if (chunks > 0) {
                totalChunks += chunks;
                filesIndexed++;
              } else {
                filesSkipped++;
              }
            } catch (err) {
              console.error(`[memory] Failed to vector index ${key}:`, (err as Error).message);
            }
          } else {
            filesSkipped++;
          }
        }

        // Text indexing (always)
        if (this.textSearchIndex.needsReindex(key, content)) {
          this.textSearchIndex.indexFile(key, content, tier);
          textFilesIndexed++;
        }
      }

      // Save indexes
      if (this.vectorIndex) {
        this.vectorIndex.save();
      }
      this.textSearchIndex.save();

      // Log summary
      if (filesIndexed === 0 && textFilesIndexed === 0 && topFiles.length > 0) {
        console.warn(`[memory] No files indexed (${filesSkipped} skipped, ${topFiles.length} total)`);
      } else {
        console.log(`[memory] Indexed ${filesIndexed} files (${totalChunks} chunks vector, ${textFilesIndexed} files text)`);
      }
    } finally {
      this.indexingInProgress = false;
    }

    return { indexed: totalChunks, files: filesIndexed, skipped: filesSkipped, textIndexed: textFilesIndexed };
  }

  /** Get vector and text index stats */
  getIndexStats(): { 
    enabled: boolean; 
    totalChunks: number; 
    indexedFiles: string[];
    textSearch: { files: number; terms: number; avgDocLength: number };
  } {
    const textStats = this.textSearchIndex.getStats();
    
    if (!this.vectorIndex) {
      return { 
        enabled: false, 
        totalChunks: 0, 
        indexedFiles: [],
        textSearch: textStats
      };
    }
    return {
      enabled: true,
      totalChunks: this.vectorIndex.size,
      indexedFiles: this.vectorIndex.indexedFiles,
      textSearch: textStats
    };
  }

  // ── Search ────────────────────────────────────────────────────────────

  /**
   * Semantic search: hybrid vector + BM25.
   * Falls back to text-only search when embeddings are disabled or fail.
   */
  async semanticSearch(query: string, limit: number = 10): Promise<SearchResult[]> {
    // No vector index at all (embeddings disabled) — use text search index
    if (!this.vectorIndex) {
      return this._textSearchAsResults(query, limit);
    }

    // Vector index exists but empty — try BM25 on chunks if any, else text search
    if (this.vectorIndex.size === 0) {
      // Try BM25 on any indexed chunks
      try {
        const results = this.vectorIndex.textSearch(query, limit);
        if (results.length > 0) return results;
      } catch {}
      // Fall back to text search index
      return this._textSearchAsResults(query, limit);
    }

    // Have vector index with data — try hybrid search
    try {
      return await this.vectorIndex.search(query, limit);
    } catch {
      // Embedding API down — fall back to BM25
      try {
        return this.vectorIndex.textSearch(query, limit);
      } catch {
        // BM25 also failed — use text search index
        return this._textSearchAsResults(query, limit);
      }
    }
  }

  /** Convert text search results to SearchResult format */
  private _textSearchAsResults(query: string, limit: number): SearchResult[] {
    const results = this.textSearchIndex.search(query, limit, { fuzzy: true, wildcard: true });
    return results.map(r => ({
      file: r.file,
      text: r.text,
      score: r.score,
      vectorScore: 0,
      bm25Score: r.score,
    }));
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

  /** Search with Google-like query syntax.
   *  Supports:
   *  - word matching (AND logic - all words must match)
   *  - "quoted phrase" for exact phrase match
   *  - -word or -"phrase" to exclude
   *  - word1 OR word2 for alternatives
   *  - file:name to filter by filename
   *  - config* for prefix matching (wildcard)
   *  
   *  Uses inverted index with TF-IDF + BM25 + stemming + fuzzy matching.
   */
  search(query: string, limit: number = 10): { file: string; matches: string[] }[] {
    // Use text search index for fast results
    const results = this.textSearchIndex.search(query, limit, { fuzzy: true, wildcard: true });
    
    return results.map(r => ({
      file: r.file,
      matches: [r.text]
    }));
  }

  // ── File listing ──────────────────────────────────────────────────────

  listFiles(): { name: string; size: number; modified: string }[] {
    if (!existsSync(this.dir)) return [];
    const results: { name: string; size: number; modified: string }[] = [];
    
    // Root-level .md files (MEMORY.md, identity files, unmigrated logs)
    const rootFiles = readdirSync(this.dir).filter(f => f.endsWith('.md'));
    for (const f of rootFiles) {
      const stat = statSync(join(this.dir, f));
      results.push({ name: f, size: stat.size, modified: stat.mtime.toISOString() });
    }
    
    // memory/ subfolder (Tier 2 topics)
    if (existsSync(this._tier2Dir)) {
      const memFiles = readdirSync(this._tier2Dir).filter(f => f.endsWith('.md'));
      for (const f of memFiles) {
        const stat = statSync(join(this._tier2Dir, f));
        results.push({ name: `memory/${f}`, size: stat.size, modified: stat.mtime.toISOString() });
      }
    }
    
    // logs/ subfolder
    if (existsSync(this._logsDir)) {
      const logFiles = readdirSync(this._logsDir).filter(f => f.endsWith('.md'));
      for (const f of logFiles) {
        const stat = statSync(join(this._logsDir, f));
        results.push({ name: `logs/${f}`, size: stat.size, modified: stat.mtime.toISOString() });
      }
    }
    
    // archive/ subfolder
    if (existsSync(this._archiveDir)) {
      const archiveFiles = readdirSync(this._archiveDir).filter(f => f.endsWith('.md'));
      for (const f of archiveFiles) {
        const stat = statSync(join(this._archiveDir, f));
        results.push({ name: `archive/${f}`, size: stat.size, modified: stat.mtime.toISOString() });
      }
    }
    
    // transcripts/ subfolder
    const transcriptsDir = this._transcriptsDir;
    if (existsSync(transcriptsDir)) {
      const transcriptFiles = readdirSync(transcriptsDir).filter(f => f.endsWith('.md'));
      for (const f of transcriptFiles) {
        const stat = statSync(join(transcriptsDir, f));
        results.push({ name: `transcripts/${f}`, size: stat.size, modified: stat.mtime.toISOString() });
      }
    }
    
    return results;
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

    // Dynamically load ALL top-level .md files (except special ones handled separately)
    const topLevelFiles = existsSync(this.dir)
      ? readdirSync(this.dir).filter(f =>
          f.endsWith('.md') &&
          !SKIP_PROMPT_FILES.includes(f) &&
          // Skip date-formatted files (daily logs that weren't migrated)
          !/^\d{4}-\d{2}-\d{2}\.md$/.test(f)
        ).sort()
      : [];

    for (const file of topLevelFiles) {
      const content = this.getIdentityFile(file);
      if (content) {
        // Truncate large files to prevent context overflow
        const trimmed = content.length > 5000
          ? content.slice(0, 5000) + '\n\n_(truncated — file is too large)_'
          : content;
        sections.push(`## ${file.replace('.md', '')}\n${trimmed}`);
      }
    }

    // Curated long-term memory (Tier 1 — hard capped)
    const memory = this.getMemory();
    if (memory) {
      const trimmed = memory.length > TIER1_MAX_CHARS
        ? memory.slice(0, TIER1_MAX_CHARS) + '\n\n_(truncated — Tier 1 memory exceeds ' + TIER1_MAX_CHARS + ' char cap. Prune it or move details to Tier 2 topic files via `memory` tool.)_'
        : memory;
      sections.push(`## Long-term Memory\n${trimmed}`);
    }

    // Tier 2 summary (list topic names + recent log dates so agent knows what's available)
    const tier2Files = this.listTier2();
    const recentLogs = this.getRecentLogDates(5);
    const archiveFiles = this.listArchive();
    if (tier2Files.length > 0 || recentLogs.length > 0 || archiveFiles.length > 0) {
      const parts: string[] = ['Available via `memory` tool (NOT auto-loaded — use `memory search` or `memory tier2_read`/`memory log`):'];
      if (tier2Files.length > 0) {
        const names = tier2Files.map(f => f.name.replace('.md', '')).join(', ');
        parts.push(`Topics: ${names}`);
      }
      if (recentLogs.length > 0) {
        parts.push(`Recent logs: ${recentLogs.join(', ')}`);
      }
      if (archiveFiles.length > 0) {
        const names = archiveFiles.map(f => f.name.replace('.md', '')).join(', ');
        parts.push(`Archive (cold storage): ${names}`);
      }
      sections.push(`## Tier 2 — Reference Memory & Logs\n${parts.join('\n')}`);
    }

    if (sections.length === 0) return '';
    return '\n\n# Agent Memory & Identity\n\n' + sections.join('\n\n---\n\n');
  }
}
