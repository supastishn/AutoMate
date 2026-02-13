/**
 * Vector Index — in-memory embedding store with JSON persistence.
 * Supports cosine similarity, BM25, and hybrid search.
 * No external dependencies — uses the OpenAI-compatible embeddings API.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────

export interface ChunkMeta {
  id: string;          // unique chunk id: "filename:chunkIndex"
  file: string;        // source filename (e.g. "MEMORY.md")
  text: string;        // raw chunk text
  embedding: number[]; // vector
  charStart: number;   // start offset in original file
  charEnd: number;     // end offset in original file
}

export interface SearchResult {
  file: string;
  text: string;
  score: number;       // combined hybrid score (0-1)
  vectorScore: number;
  bm25Score: number;
}

interface IndexData {
  version: number;
  chunks: ChunkMeta[];
  fileHashes: Record<string, string>; // file -> hash to detect changes
  embeddingCache?: Record<string, number[]>; // text hash -> embedding (persisted cache)
}

export interface EmbeddingConfig {
  enabled: boolean;
  model: string;
  apiBase: string;
  apiKey?: string;
  chunkSize: number;
  chunkOverlap: number;
  vectorWeight: number;
  bm25Weight: number;
  topK: number;
}

// ── Chunking ─────────────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks, respecting paragraph/section boundaries.
 */
export function chunkText(text: string, chunkSize: number, overlap: number): { text: string; charStart: number; charEnd: number }[] {
  if (!text || text.trim().length === 0) return [];

  // Split on double newlines (paragraphs/sections) first
  const paragraphs = text.split(/\n{2,}/);
  const chunks: { text: string; charStart: number; charEnd: number }[] = [];

  let currentChunk = '';
  let currentStart = 0;
  let offset = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];

    // If adding this paragraph would exceed chunk size, flush current chunk
    if (currentChunk.length > 0 && currentChunk.length + para.length + 2 > chunkSize) {
      chunks.push({
        text: currentChunk.trim(),
        charStart: currentStart,
        charEnd: currentStart + currentChunk.length,
      });

      // Overlap: keep the tail of the current chunk
      if (overlap > 0 && currentChunk.length > overlap) {
        const overlapText = currentChunk.slice(-overlap);
        currentChunk = overlapText + '\n\n' + para;
        currentStart = offset - overlap;
      } else {
        currentChunk = para;
        currentStart = offset;
      }
    } else {
      if (currentChunk.length === 0) {
        currentStart = offset;
        currentChunk = para;
      } else {
        currentChunk += '\n\n' + para;
      }
    }

    offset += para.length + 2; // +2 for the \n\n

    // If a single paragraph is bigger than chunkSize, force-split it
    if (currentChunk.length > chunkSize * 1.5) {
      // Split by sentences or fixed size
      while (currentChunk.length > chunkSize) {
        const splitAt = findSplitPoint(currentChunk, chunkSize);
        chunks.push({
          text: currentChunk.slice(0, splitAt).trim(),
          charStart: currentStart,
          charEnd: currentStart + splitAt,
        });
        const advance = Math.max(1, splitAt - overlap);
        currentStart += advance;
        currentChunk = currentChunk.slice(advance);
      }
    }
  }

  // Flush remaining
  if (currentChunk.trim().length > 0) {
    chunks.push({
      text: currentChunk.trim(),
      charStart: currentStart,
      charEnd: currentStart + currentChunk.length,
    });
  }

  return chunks;
}

/** Find a good split point near `target` — prefer sentence/line boundaries. */
function findSplitPoint(text: string, target: number): number {
  // Try to split at sentence boundary (.!?) near target
  for (let i = target; i > target * 0.7; i--) {
    if (text[i] === '.' || text[i] === '!' || text[i] === '?') {
      return i + 1;
    }
  }
  // Try newline
  for (let i = target; i > target * 0.7; i--) {
    if (text[i] === '\n') return i + 1;
  }
  // Try space
  for (let i = target; i > target * 0.7; i--) {
    if (text[i] === ' ') return i + 1;
  }
  // Last resort: split at target
  return target;
}

// ── BM25 ─────────────────────────────────────────────────────────────────

/** Simple tokenizer: lowercase, split on non-alphanumeric, remove stopwords */
function tokenize(text: string): string[] {
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
    'should', 'may', 'might', 'must', 'can', 'could', 'to', 'of', 'in',
    'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
    'during', 'before', 'after', 'above', 'below', 'between', 'and',
    'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
    'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
    'such', 'no', 'only', 'same', 'than', 'too', 'very', 'just', 'that',
    'this', 'these', 'those', 'it', 'its',
  ]);

  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

/** BM25 score for a query against a set of documents */
function bm25Score(
  queryTokens: string[],
  documents: { tokens: string[]; length: number }[],
  k1: number = 1.5,
  b: number = 0.75,
): number[] {
  const N = documents.length;
  if (N === 0) return [];

  const avgDl = documents.reduce((sum, d) => sum + d.length, 0) / N;

  // Document frequency for each query term
  const df: Record<string, number> = {};
  for (const term of queryTokens) {
    df[term] = 0;
    for (const doc of documents) {
      if (doc.tokens.includes(term)) df[term]++;
    }
  }

  return documents.map(doc => {
    let score = 0;
    // Term frequency in this doc
    const tf: Record<string, number> = {};
    for (const t of doc.tokens) {
      tf[t] = (tf[t] || 0) + 1;
    }

    for (const term of queryTokens) {
      const termTf = tf[term] || 0;
      if (termTf === 0) continue;

      const idf = Math.log((N - (df[term] || 0) + 0.5) / ((df[term] || 0) + 0.5) + 1);
      const tfNorm = (termTf * (k1 + 1)) / (termTf + k1 * (1 - b + b * (doc.length / avgDl)));
      score += idf * tfNorm;
    }

    return score;
  });
}

// ── Cosine similarity ────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dotProduct / denom;
}

// ── Simple hash for change detection ─────────────────────────────────────

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(36);
}

// ── Vector Index Class ───────────────────────────────────────────────────

export class VectorIndex {
  private chunks: ChunkMeta[] = [];
  private fileHashes: Record<string, string> = {};
  private embeddingCache: Map<string, number[]> = new Map(); // text hash -> embedding
  private config: EmbeddingConfig;
  private indexPath: string;
  private cachePath: string;
  private dirty: boolean = false;
  private cacheDirty: boolean = false;

  constructor(memoryDir: string, config: EmbeddingConfig) {
    this.config = config;
    this.indexPath = join(memoryDir, '.vector-index.json');
    this.cachePath = join(memoryDir, '.embedding-cache.json');
    this.load();
    this.loadCache();
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.indexPath)) return;

    try {
      const raw = readFileSync(this.indexPath, 'utf-8');
      const data = JSON.parse(raw) as IndexData;
      if (data.version === 1) {
        this.chunks = data.chunks;
        this.fileHashes = data.fileHashes;
      }
    } catch {
      // Corrupted index — start fresh
      this.chunks = [];
      this.fileHashes = {};
    }
  }

  private loadCache(): void {
    if (!existsSync(this.cachePath)) return;

    try {
      const raw = readFileSync(this.cachePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, number[]>;
      this.embeddingCache = new Map(Object.entries(data));
    } catch {
      // Corrupted cache — start fresh
      this.embeddingCache = new Map();
    }
  }

  save(): void {
    if (this.dirty) {
      const data: IndexData = {
        version: 1,
        chunks: this.chunks,
        fileHashes: this.fileHashes,
      };

      const dir = dirname(this.indexPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.indexPath, JSON.stringify(data));
      this.dirty = false;
    }

    // Save embedding cache separately (can be large)
    if (this.cacheDirty) {
      const cacheData = Object.fromEntries(this.embeddingCache);
      const dir = dirname(this.cachePath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(cacheData));
      this.cacheDirty = false;
    }
  }

  // ── Embedding API ────────────────────────────────────────────────────

  private async getEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Check cache first
    const results: (number[] | null)[] = texts.map(t => {
      const hash = simpleHash(t);
      return this.embeddingCache.get(hash) || null;
    });

    // Find uncached texts
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (results[i] === null) {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    // If all cached, return immediately
    if (uncachedTexts.length === 0) {
      return results as number[][];
    }

    // Fetch uncached embeddings
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const body = {
      model: this.config.model,
      input: uncachedTexts,
    };

    const res = await fetch(`${this.config.apiBase}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Embedding API error ${res.status}: ${errText}`);
    }

    const json = await res.json() as { data: { embedding: number[]; index: number }[] };

    // Sort by index to maintain order
    const sorted = json.data.sort((a, b) => a.index - b.index);

    // Store in cache and results
    for (let i = 0; i < sorted.length; i++) {
      const originalIdx = uncachedIndices[i];
      const embedding = sorted[i].embedding;
      const hash = simpleHash(texts[originalIdx]);
      
      this.embeddingCache.set(hash, embedding);
      results[originalIdx] = embedding;
    }

    this.cacheDirty = true;
    return results as number[][];
  }

  /** Get cache statistics */
  getCacheStats(): { size: number; hits: number } {
    return {
      size: this.embeddingCache.size,
      hits: 0, // Not tracked currently
    };
  }

  /** Clear the embedding cache */
  clearCache(): void {
    this.embeddingCache.clear();
    this.cacheDirty = true;
  }

  // ── Indexing ─────────────────────────────────────────────────────────

  /** Check if a file needs re-indexing */
  needsReindex(filename: string, content: string): boolean {
    const hash = simpleHash(content);
    return this.fileHashes[filename] !== hash;
  }

  /** Index a single file — chunks it, embeds it, stores it */
  async indexFile(filename: string, content: string): Promise<number> {
    if (!content || content.trim().length === 0) {
      this.removeFile(filename);
      return 0;
    }

    const hash = simpleHash(content);

    // Skip if unchanged
    if (this.fileHashes[filename] === hash) return 0;

    // Remove old chunks for this file
    this.chunks = this.chunks.filter(c => c.file !== filename);

    // Chunk the content
    const rawChunks = chunkText(content, this.config.chunkSize, this.config.chunkOverlap);
    if (rawChunks.length === 0) return 0;

    // Get embeddings in batches of 20
    const BATCH_SIZE = 20;
    const newChunks: ChunkMeta[] = [];

    for (let i = 0; i < rawChunks.length; i += BATCH_SIZE) {
      const batch = rawChunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map(c => c.text);

      const embeddings = await this.getEmbeddings(texts);

      for (let j = 0; j < batch.length; j++) {
        newChunks.push({
          id: `${filename}:${i + j}`,
          file: filename,
          text: batch[j].text,
          embedding: embeddings[j],
          charStart: batch[j].charStart,
          charEnd: batch[j].charEnd,
        });
      }
    }

    this.chunks.push(...newChunks);
    this.fileHashes[filename] = hash;
    this.dirty = true;
    return newChunks.length;
  }

  /** Remove all chunks for a file */
  removeFile(filename: string): void {
    const before = this.chunks.length;
    this.chunks = this.chunks.filter(c => c.file !== filename);
    delete this.fileHashes[filename];
    if (this.chunks.length !== before) {
      this.dirty = true;
    }
  }

  /** Get total chunk count */
  get size(): number {
    return this.chunks.length;
  }

  /** Get indexed file names */
  get indexedFiles(): string[] {
    return Object.keys(this.fileHashes);
  }

  // ── Search ───────────────────────────────────────────────────────────

  /**
   * Hybrid search: combines cosine vector similarity with BM25 text matching.
   * Returns top-K results sorted by combined score.
   */
  async search(query: string, topK?: number): Promise<SearchResult[]> {
    const k = topK || this.config.topK;

    if (this.chunks.length === 0) return [];

    // 1. Get query embedding
    const [queryEmbedding] = await this.getEmbeddings([query]);

    // 2. Vector similarity scores
    const vectorScores = this.chunks.map(chunk =>
      cosineSimilarity(queryEmbedding, chunk.embedding)
    );

    // 3. BM25 scores
    const queryTokens = tokenize(query);
    const docTokens = this.chunks.map(chunk => {
      const tokens = tokenize(chunk.text);
      return { tokens, length: tokens.length };
    });
    const bm25Scores = bm25Score(queryTokens, docTokens);

    // 4. Normalize scores to [0, 1]
    const maxVector = Math.max(...vectorScores, 0.001);
    const maxBm25 = Math.max(...bm25Scores, 0.001);

    const normVector = vectorScores.map(s => s / maxVector);
    const normBm25 = bm25Scores.map(s => s / maxBm25);

    // 5. Combine with weights
    const combined = this.chunks.map((chunk, i) => ({
      file: chunk.file,
      text: chunk.text,
      score: this.config.vectorWeight * normVector[i] + this.config.bm25Weight * normBm25[i],
      vectorScore: vectorScores[i],
      bm25Score: bm25Scores[i],
    }));

    // 6. Sort by combined score descending, deduplicate by file+text
    combined.sort((a, b) => b.score - a.score);

    // Deduplicate overlapping chunks from same file
    const seen = new Set<string>();
    const results: SearchResult[] = [];

    for (const r of combined) {
      const key = `${r.file}:${r.text.slice(0, 100)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(r);
      if (results.length >= k) break;
    }

    return results;
  }

  /**
   * Pure vector search (no BM25), for cases where exact text matching isn't needed.
   */
  async vectorSearch(query: string, topK?: number): Promise<SearchResult[]> {
    const k = topK || this.config.topK;
    if (this.chunks.length === 0) return [];

    const [queryEmbedding] = await this.getEmbeddings([query]);
    const scores = this.chunks.map(chunk =>
      cosineSimilarity(queryEmbedding, chunk.embedding)
    );

    const results = this.chunks
      .map((chunk, i) => ({
        file: chunk.file,
        text: chunk.text,
        score: scores[i],
        vectorScore: scores[i],
        bm25Score: 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return results;
  }

  /**
   * BM25-only search (no embeddings needed). Fallback when embeddings unavailable.
   */
  textSearch(query: string, topK?: number): SearchResult[] {
    const k = topK || this.config.topK;
    if (this.chunks.length === 0) return [];

    const queryTokens = tokenize(query);
    const docTokens = this.chunks.map(chunk => {
      const tokens = tokenize(chunk.text);
      return { tokens, length: tokens.length };
    });
    const scores = bm25Score(queryTokens, docTokens);

    const results = this.chunks
      .map((chunk, i) => ({
        file: chunk.file,
        text: chunk.text,
        score: scores[i],
        vectorScore: 0,
        bm25Score: scores[i],
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return results;
  }

  /** Wipe all data */
  clear(): void {
    this.chunks = [];
    this.fileHashes = {};
    this.dirty = true;
  }
}
