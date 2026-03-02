/**
 * Text Search Index - Inverted index with TF-IDF, stemming, fuzzy matching
 * Fast full-text search without embeddings
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────

export interface TextSearchResult {
  file: string;
  text: string;
  score: number;
  matches: MatchPosition[];
}

export interface MatchPosition {
  start: number;
  end: number;
  text: string;
}

interface FileEntry {
  filename: string;
  content: string;
  termFreq: Map<string, number>; // stemmed terms
  unstemmedFreq: Map<string, number>; // original terms for fuzzy matching
  wordCount: number;
  modified: number;
  tier: number; // 1 = MEMORY.md (highest), 2 = memory/, 3 = logs/, 4 = archive/ (lowest)
}

interface InvertedIndex {
  [term: string]: { file: string; positions: number[] }[];
}

interface IndexData {
  version: number;
  fileHashes: Record<string, string>;
  docCount: number;
  avgDocLength: number;
}

// ── Stemming (Porter Stemmer Lite) ───────────────────────────────────────

const STEP2_LIST: Record<string, string> = {
  ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize',
  bli: 'ble', alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous',
  ization: 'ize', ation: 'ate', ator: 'ate', alism: 'al', iveness: 'ive',
  fulness: 'ful', ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble'
};

const STEP3_LIST: Record<string, string> = {
  icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic',
  ful: '', ness: ''
};

const STEP4_LIST = ['al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent', 
  'ion', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize'];

function isCons(word: string, i: number): boolean {
  const c = word[i];
  if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
  if (c === 'y' && i > 0) return isCons(word, i - 1);
  return true;
}

function measure(word: string): number {
  let m = 0;
  let i = 0;
  const len = word.length;
  while (i < len && isCons(word, i)) i++;
  while (i < len) {
    while (i < len && !isCons(word, i)) i++;
    if (i >= len) break;
    m++;
    while (i < len && isCons(word, i)) i++;
  }
  return m;
}

function hasVowel(word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    if (!isCons(word, i)) return true;
  }
  return false;
}

function endsWithDoubleCons(word: string): boolean {
  const len = word.length;
  if (len < 2) return false;
  const c = word[len - 1];
  if (c !== word[len - 2]) return false;
  return isCons(word, len - 1);
}

function endsWithCVC(word: string): boolean {
  const len = word.length;
  if (len < 3) return false;
  const c = word[len - 1];
  const v = word[len - 2];
  const c2 = word[len - 3];
  if (isCons(word, len - 3) && !isCons(word, len - 2) && isCons(word, len - 1)) {
    return c !== 'w' && c !== 'x' && c !== 'y';
  }
  return false;
}

function stem(word: string): string {
  if (word.length <= 2) return word;
  
  let w = word.toLowerCase();
  const m = measure(w);
  
  // Step 1a
  if (w.endsWith('ies') || w.endsWith('ied')) {
    w = w.slice(0, -3) + (w.length > 4 ? 'y' : 'ie');
  } else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) {
    w = w.slice(0, -1);
  }
  
  // Step 1b
  let step1bApplied = false;
  if (w.endsWith('eed')) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else if (w.endsWith('ed') && hasVowel(w.slice(0, -2))) {
    w = w.slice(0, -2);
    step1bApplied = true;
  } else if (w.endsWith('ing') && hasVowel(w.slice(0, -3))) {
    w = w.slice(0, -3);
    step1bApplied = true;
  }
  
  if (step1bApplied) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) {
      w = w + 'e';
    } else if (endsWithDoubleCons(w) && !w.endsWith('l') && !w.endsWith('s') && !w.endsWith('z')) {
      w = w.slice(0, -1);
    } else if (measure(w) === 1 && endsWithCVC(w)) {
      w = w + 'e';
    }
  }
  
  // Step 1c
  if (w.endsWith('y') && hasVowel(w.slice(0, -1))) {
    w = w.slice(0, -1) + 'i';
  }
  
  // Step 2
  for (const [suffix, replacement] of Object.entries(STEP2_LIST)) {
    if (w.endsWith(suffix)) {
      const stemmed = w.slice(0, -suffix.length);
      if (measure(stemmed) > 0) {
        w = stemmed + replacement;
        break;
      }
    }
  }
  
  // Step 3
  for (const [suffix, replacement] of Object.entries(STEP3_LIST)) {
    if (w.endsWith(suffix)) {
      const stemmed = w.slice(0, -suffix.length);
      if (measure(stemmed) > 0) {
        w = stemmed + replacement;
        break;
      }
    }
  }
  
  // Step 4
  for (const suffix of STEP4_LIST) {
    if (w.endsWith(suffix)) {
      const stemmed = w.slice(0, -suffix.length);
      if (measure(stemmed) > 1) {
        w = stemmed;
        break;
      }
    }
  }
  
  // Step 5a
  if (w.endsWith('e')) {
    const stemmed = w.slice(0, -1);
    if (measure(stemmed) > 1 || (measure(stemmed) === 1 && !endsWithCVC(stemmed))) {
      w = stemmed;
    }
  }
  
  // Step 5b
  if (w.endsWith('l') && endsWithDoubleCons(w) && measure(w) > 1) {
    w = w.slice(0, -1);
  }
  
  return w;
}

// ── Stopwords ────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'can', 'could', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'between', 'and',
  'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
  'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'only', 'same', 'than', 'too', 'very', 'just', 'that',
  'this', 'these', 'those', 'it', 'its', 'they', 'them', 'their', 'we',
  'us', 'our', 'you', 'your', 'i', 'me', 'my', 'mine', 'he', 'she',
  'him', 'his', 'her', 'hers', 'what', 'which', 'who', 'whom', 'whose',
  'where', 'when', 'why', 'how', 'if', 'because', 'while', 'until',
  'though', 'although', 'unless', 'whether', 'once', 'since', 'until'
]);

// ── Tokenization ─────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

function tokenizeWithPositions(text: string): { term: string; position: number }[] {
  const results: { term: string; position: number }[] = [];
  const lowerText = text.toLowerCase();
  const regex = /[a-z0-9]+/g;
  let match;
  
  while ((match = regex.exec(lowerText)) !== null) {
    const term = stem(match[0]);
    if (term.length > 1 && !STOPWORDS.has(term)) {
      results.push({ term, position: match.index });
    }
  }
  
  return results;
}

// ── Fuzzy Matching (Levenshtein) ─────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}

function fuzzyMatch(term: string, candidates: string[], maxDistance: number = 2): string[] {
  return candidates.filter(c => levenshtein(term, c) <= maxDistance);
}

// ── Hash for change detection ────────────────────────────────────────────

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash = hash & hash;
  }
  return hash.toString(36);
}

// ── Wildcard Matching ────────────────────────────────────────────────────

function matchesWildcard(term: string, pattern: string): boolean {
  // Simple prefix/suffix matching: config* or *config
  if (pattern.endsWith('*')) {
    return term.startsWith(pattern.slice(0, -1));
  }
  if (pattern.startsWith('*')) {
    return term.endsWith(pattern.slice(1));
  }
  return term === pattern;
}

// ── Text Search Index Class ──────────────────────────────────────────────

export class TextSearchIndex {
  private files: Map<string, FileEntry> = new Map();
  private invertedIndex: InvertedIndex = {};
  private fileHashes: Map<string, string> = new Map();
  private indexPath: string;
  private indexVersion = 1;
  private totalWordCount = 0;
  private dirty = false;

  // Query result cache with TTL
  private queryCache: Map<string, { results: TextSearchResult[]; timestamp: number; hits: number }> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_CACHE_SIZE = 100;

  constructor(memoryDir: string) {
    this.indexPath = join(memoryDir, '.text-search-index.json');
    this.load();
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.indexPath)) return;
    
    try {
      const raw = readFileSync(this.indexPath, 'utf-8');
      const data = JSON.parse(raw) as IndexData;
      if (data.version === this.indexVersion) {
        this.fileHashes = new Map(Object.entries(data.fileHashes));
      }
    } catch {
      // Corrupted index - start fresh
      this.fileHashes.clear();
    }
  }

  save(): void {
    if (!this.dirty) return;
    
    try {
      const data: IndexData = {
        version: this.indexVersion,
        fileHashes: Object.fromEntries(this.fileHashes),
        docCount: this.files.size,
        avgDocLength: this.files.size > 0 ? this.totalWordCount / this.files.size : 0
      };
      
      mkdirSync(dirname(this.indexPath), { recursive: true });
      writeFileSync(this.indexPath, JSON.stringify(data));
      this.dirty = false;
    } catch (err) {
      console.error(`[text-search] Failed to save index: ${(err as Error).message}`);
    }
  }

  // ── Indexing ─────────────────────────────────────────────────────────

  needsReindex(filename: string, content: string): boolean {
    const hash = simpleHash(content);
    return this.fileHashes.get(filename) !== hash;
  }

  indexFile(filename: string, content: string, tier: number = 2): void {
    const hash = simpleHash(content);
    
    // Skip if unchanged
    if (this.fileHashes.get(filename) === hash) return;
    
    // Remove old index
    this.removeFile(filename);
    
    if (!content || content.trim().length === 0) return;
    
    // Tokenize with positions
    const tokens = tokenizeWithPositions(content);
    const termFreq = new Map<string, number>();
    const unstemmedFreq = new Map<string, number>();
    const termPositions = new Map<string, number[]>();
    
    // Also track unstemmed tokens for fuzzy matching
    const unstemmedRegex = /[a-z0-9]+/g;
    let match;
    const lowerContent = content.toLowerCase();
    while ((match = unstemmedRegex.exec(lowerContent)) !== null) {
      const word = match[0];
      if (word.length > 2 && !STOPWORDS.has(word)) {
        unstemmedFreq.set(word, (unstemmedFreq.get(word) || 0) + 1);
      }
    }
    
    for (const { term, position } of tokens) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
      if (!termPositions.has(term)) termPositions.set(term, []);
      termPositions.get(term)!.push(position);
    }
    
    // Get file stats for recency boosting
    let modified = Date.now();
    try {
      const stat = statSync(filename);
      modified = stat.mtime.getTime();
    } catch {}
    
    // Store file entry
    const entry: FileEntry = {
      filename,
      content,
      termFreq,
      unstemmedFreq,
      wordCount: tokens.length,
      modified,
      tier
    };
    
    this.files.set(filename, entry);
    this.totalWordCount += tokens.length;
    
    // Update inverted index
    for (const [term, positions] of termPositions) {
      if (!this.invertedIndex[term]) this.invertedIndex[term] = [];
      this.invertedIndex[term].push({ file: filename, positions });
    }
    
    this.fileHashes.set(filename, hash);
    this.dirty = true;
  }

  removeFile(filename: string): void {
    const entry = this.files.get(filename);
    if (!entry) return;
    
    // Remove from inverted index
    for (const term of entry.termFreq.keys()) {
      if (this.invertedIndex[term]) {
        this.invertedIndex[term] = this.invertedIndex[term].filter(r => r.file !== filename);
        if (this.invertedIndex[term].length === 0) {
          delete this.invertedIndex[term];
        }
      }
    }
    
    this.totalWordCount -= entry.wordCount;
    this.files.delete(filename);
    this.fileHashes.delete(filename);
    this.dirty = true;
  }

  get size(): number {
    return this.files.size;
  }

  // ── Search ───────────────────────────────────────────────────────────

  search(
    query: string, 
    limit: number = 10,
    options?: {
      fileFilter?: string;
      fuzzy?: boolean;
      wildcard?: boolean;
      skipCache?: boolean;
    }
  ): TextSearchResult[] {
    if (this.files.size === 0) return [];

    // Check cache first
    const cacheKey = `${query}:${limit}:${options?.fileFilter || ''}:${options?.fuzzy || false}:${options?.wildcard || false}`;
    if (!options?.skipCache) {
      const cached = this.queryCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        cached.hits++;
        return cached.results;
      }
    }
    
    // Parse query
    const parsed = this.parseQuery(query);
    if (parsed.terms.length === 0 && parsed.phrases.length === 0 && parsed.orGroups.length === 0) {
      return [];
    }
    
    // Score all files using TF-IDF + BM25 hybrid
    const scores = new Map<string, number>();
    const matches = new Map<string, MatchPosition[]>();
    
    const avgDocLength = this.totalWordCount / this.files.size;
    const N = this.files.size;
    
    for (const [filename, entry] of this.files) {
      // Apply file filter
      if (options?.fileFilter && !filename.toLowerCase().includes(options.fileFilter.toLowerCase())) {
        continue;
      }
      
      let score = 0;
      const fileMatches: MatchPosition[] = [];
      let allTermsMatch = true;
      
      // Check required terms (AND logic - all must match)
      for (const term of parsed.terms) {
        const termScore = this.scoreTerm(term, entry, N, avgDocLength, options);
        if (termScore.score === 0) {
          allTermsMatch = false;
          break;
        }
        score += termScore.score;
        fileMatches.push(...termScore.positions);
      }
      
      if (!allTermsMatch) continue;
      
      // Check phrases (all must match)
      for (const phrase of parsed.phrases) {
        const phraseScore = this.scorePhrase(phrase, entry);
        if (phraseScore.score === 0) {
          allTermsMatch = false;
          break;
        }
        score += phraseScore.score * 2; // Boost phrases
        fileMatches.push(...phraseScore.positions);
      }
      
      if (!allTermsMatch) continue;
      
      // Check excludes
      for (const term of parsed.excludeTerms) {
        if (entry.termFreq.has(stem(term))) {
          allTermsMatch = false;
          break;
        }
      }
      if (!allTermsMatch) continue;
      
      for (const phrase of parsed.excludePhrases) {
        if (entry.content.toLowerCase().includes(phrase.toLowerCase())) {
          allTermsMatch = false;
          break;
        }
      }
      if (!allTermsMatch) continue;
      
      // Check OR groups (at least one from each group)
      for (const group of parsed.orGroups) {
        let groupMatched = false;
        for (const term of group) {
          const termScore = this.scoreTerm(term, entry, N, avgDocLength, options);
          if (termScore.score > 0) {
            groupMatched = true;
            score += termScore.score * 0.8; // Slightly lower weight for OR matches
            fileMatches.push(...termScore.positions);
            break;
          }
        }
        if (!groupMatched) {
          allTermsMatch = false;
          break;
        }
      }
      
      if (!allTermsMatch) continue;
      
      // Apply metadata boosts
      // Recency boost (files modified in last 30 days get boost)
      const daysSinceModified = (Date.now() - entry.modified) / (1000 * 60 * 60 * 24);
      const recencyBoost = Math.max(0.5, 1 - (daysSinceModified / 30) * 0.5);
      score *= recencyBoost;
      
      // Tier boost (MEMORY.md gets highest boost)
      const tierBoost = 1 + (5 - entry.tier) * 0.1;
      score *= tierBoost;
      
      scores.set(filename, score);
      matches.set(filename, fileMatches);
    }
    
    // Sort by score and build results
    const sortedFiles = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
    
    const results = sortedFiles.map(([filename, score]) => {
      const entry = this.files.get(filename)!;
      const fileMatches = matches.get(filename) || [];
      const snippet = this.extractSnippet(entry.content, fileMatches, parsed);
      
      return {
        file: filename,
        text: snippet,
        score,
        matches: fileMatches.slice(0, 5) // Top 5 match positions
      };
    });

    // Cache results
    if (!options?.skipCache && results.length > 0) {
      this.queryCache.set(cacheKey, { results, timestamp: Date.now(), hits: 1 });
      this.cleanupCache();
    }

    return results;
  }

  /** Clean up old cache entries when cache gets too large */
  private cleanupCache(): void {
    if (this.queryCache.size <= this.MAX_CACHE_SIZE) return;
    
    // Remove oldest entries
    const entries = Array.from(this.queryCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    const toRemove = entries.slice(0, entries.length - this.MAX_CACHE_SIZE);
    for (const [key] of toRemove) {
      this.queryCache.delete(key);
    }
  }

  /** Get cache statistics */
  getCacheStats(): { size: number; totalHits: number } {
    let totalHits = 0;
    for (const entry of this.queryCache.values()) {
      totalHits += entry.hits;
    }
    return { size: this.queryCache.size, totalHits };
  }

  /** Clear the query cache */
  clearCache(): void {
    this.queryCache.clear();
  }

  // ── Scoring ──────────────────────────────────────────────────────────

  private scoreTerm(
    term: string, 
    entry: FileEntry, 
    N: number, 
    avgDocLength: number,
    options?: { fuzzy?: boolean; wildcard?: boolean }
  ): { score: number; positions: MatchPosition[] } {
    const stemmedTerm = stem(term.toLowerCase());
    let tf = entry.termFreq.get(stemmedTerm) || 0;
    let positions: number[] = [];
    
    // Wildcard matching
    if (options?.wildcard && tf === 0 && (term.includes('*'))) {
      for (const [indexedTerm] of entry.termFreq) {
        if (matchesWildcard(indexedTerm, stemmedTerm)) {
          tf += entry.termFreq.get(indexedTerm)!;
          const postings = this.invertedIndex[indexedTerm]?.find(p => p.file === entry.filename);
          if (postings) positions.push(...postings.positions);
        }
      }
    }
    
    // Fuzzy matching - check against unstemmed terms in this file
    if (options?.fuzzy && tf === 0 && term.length > 4) {
      const unstemmedTerm = term.toLowerCase();
      const maxDistance = term.length > 8 ? 3 : 2;
      
      // Get unstemmed terms from this file
      const fileTerms = Array.from(entry.unstemmedFreq.keys());
      const fuzzyMatches = fuzzyMatch(unstemmedTerm, fileTerms, maxDistance);
      
      for (const match of fuzzyMatches) {
        const matchTf = entry.unstemmedFreq.get(match);
        if (matchTf) {
          tf += matchTf * 0.7; // Penalty for fuzzy match
          // Find positions in content
          const regex = new RegExp(`\\b${match}\\b`, 'gi');
          let m;
          while ((m = regex.exec(entry.content)) !== null) {
            positions.push({ start: m.index, end: m.index + match.length, text: match });
          }
        }
      }
    }
    
    if (tf === 0) return { score: 0, positions: [] };
    
    // Get positions from inverted index
    if (positions.length === 0) {
      const postings = this.invertedIndex[stemmedTerm]?.find(p => p.file === entry.content);
      if (postings) positions = postings.positions;
    }
    
    // BM25 scoring
    const df = this.invertedIndex[stemmedTerm]?.length || 0;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    const k1 = 1.5;
    const b = 0.75;
    const docLength = entry.wordCount;
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));
    const bm25Score = idf * tfNorm;
    
    // TF-IDF component
    const tfidf = (tf / docLength) * Math.log(N / (df + 1));
    
    const score = bm25Score * 0.6 + tfidf * 0.4;
    
    return {
      score,
      positions: positions.map(pos => ({
        start: pos,
        end: pos + term.length,
        text: entry.content.slice(pos, pos + term.length)
      }))
    };
  }

  private scorePhrase(phrase: string, entry: FileEntry): { score: number; positions: MatchPosition[] } {
    const lowerContent = entry.content.toLowerCase();
    const lowerPhrase = phrase.toLowerCase();
    let pos = lowerContent.indexOf(lowerPhrase);
    const positions: MatchPosition[] = [];
    let count = 0;
    
    while (pos !== -1) {
      positions.push({
        start: pos,
        end: pos + phrase.length,
        text: entry.content.slice(pos, pos + phrase.length)
      });
      count++;
      pos = lowerContent.indexOf(lowerPhrase, pos + 1);
    }
    
    if (count === 0) return { score: 0, positions: [] };
    
    // Phrase matches get higher weight
    const score = Math.log(count + 1) * 2;
    return { score, positions };
  }

  // ── Query Parsing ────────────────────────────────────────────────────

  private parseQuery(query: string): {
    terms: string[];
    phrases: string[];
    excludeTerms: string[];
    excludePhrases: string[];
    orGroups: string[][];
    fileFilter: string;
  } {
    const terms: string[] = [];
    const phrases: string[] = [];
    const excludeTerms: string[] = [];
    const excludePhrases: string[] = [];
    const orGroups: string[][] = [];
    let fileFilter = '';
    
    const tokens = query.match(/(-?"[^"]+"|\S+)/g) || [];
    let currentOrGroup: string[] = [];
    let pendingOrStart: string | null = null;
    
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const isNegative = token.startsWith('-');
      const rawToken = isNegative ? token.slice(1) : token;
      const isPhrase = rawToken.startsWith('"') && rawToken.endsWith('"');
      const cleanToken = isPhrase ? rawToken.slice(1, -1) : rawToken;
      
      // Check for OR operator
      if (cleanToken.toUpperCase() === 'OR') {
        // Move last term from terms to pending OR start
        if (terms.length > 0 && pendingOrStart === null) {
          pendingOrStart = terms.pop()!;
          currentOrGroup = [pendingOrStart];
        }
        continue;
      }
      
      // file: filter
      if (cleanToken.toLowerCase().startsWith('file:')) {
        fileFilter = cleanToken.slice(5);
        continue;
      }
      
      // Handle explicit AND (optional syntax)
      if (cleanToken.toUpperCase() === 'AND') {
        if (currentOrGroup.length > 0) {
          orGroups.push(currentOrGroup);
          currentOrGroup = [];
        }
        pendingOrStart = null;
        continue;
      }
      
      if (isNegative) {
        if (isPhrase) excludePhrases.push(cleanToken);
        else excludeTerms.push(cleanToken);
      } else if (currentOrGroup.length > 0) {
        // In OR group - collect all alternatives
        currentOrGroup.push(cleanToken);
      } else if (isPhrase) {
        phrases.push(cleanToken);
      } else {
        terms.push(cleanToken);
      }
    }
    
    // Finalize last OR group
    if (currentOrGroup.length > 0) {
      orGroups.push(currentOrGroup);
    }
    
    // Strip stopwords from phrases for better matching
    const cleanedPhrases = phrases.map(p => this.stripStopwordsFromPhrase(p)).filter(p => p.length > 0);
    const cleanedExcludePhrases = excludePhrases.map(p => this.stripStopwordsFromPhrase(p)).filter(p => p.length > 0);
    
    return { terms, phrases: cleanedPhrases, excludeTerms, excludePhrases: cleanedExcludePhrases, orGroups, fileFilter };
  }

  /** Strip stopwords from a phrase to improve matching */
  private stripStopwordsFromPhrase(phrase: string): string {
    return phrase
      .toLowerCase()
      .split(/\s+/)
      .filter(word => !STOPWORDS.has(word))
      .join(' ');
  }

  /** Get spelling suggestions for a query term */
  suggestSpelling(term: string): string | null {
    const lowerTerm = term.toLowerCase();
    
    // Don't suggest for short terms
    if (term.length < 4) return null;
    
    // Collect all unstemmed terms from all files
    const allUnstemmedTerms = new Set<string>();
    for (const entry of this.files.values()) {
      for (const term of entry.unstemmedFreq.keys()) {
        allUnstemmedTerms.add(term);
      }
    }
    
    // Find closest match
    let bestMatch: string | null = null;
    let bestDistance = Infinity;
    
    for (const candidate of allUnstemmedTerms) {
      if (candidate.length < 4) continue;
      const distance = levenshtein(lowerTerm, candidate);
      // Must be close enough but not identical
      if (distance > 0 && distance <= 2 && distance < bestDistance) {
        bestDistance = distance;
        bestMatch = candidate;
      }
    }
    
    return bestMatch;
  }

  // ── Snippet Extraction ───────────────────────────────────────────────

  /** Split content into sentences for better snippet extraction */
  private getSentences(text: string): { text: string; start: number; end: number }[] {
    const sentences: { text: string; start: number; end: number }[] = [];
    // Match sentences ending with . ! ? followed by space or end of string
    const regex = /[^.!?]+[.!?]+(?:\s+|$)/g;
    let match;
    
    while ((match = regex.exec(text)) !== null) {
      const trimmed = match[0].trim();
      if (trimmed.length > 10) { // Skip very short fragments
        sentences.push({
          text: trimmed,
          start: match.index,
          end: match.index + match[0].length
        });
      }
    }
    
    // If no sentences found (e.g., bullet points), split on newlines
    if (sentences.length === 0) {
      const lines = text.split('\n');
      let pos = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 10) {
          sentences.push({ text: trimmed, start: pos, end: pos + line.length });
        }
        pos += line.length + 1;
      }
    }
    
    return sentences;
  }

  private extractSnippet(
    content: string, 
    matches: MatchPosition[],
    parsed: { terms: string[]; phrases: string[] }
  ): string {
    // Clean up content - remove excessive whitespace
    const cleanContent = content.replace(/\n{3,}/g, '\n\n').trim();
    
    if (matches.length === 0) {
      // No specific positions - return first meaningful paragraph (not just a header)
      const paragraphs = cleanContent.split(/\n{2,}/);
      for (const para of paragraphs) {
        const trimmed = para.trim();
        // Skip single-line headers
        if (trimmed.length > 50 || (trimmed.length > 20 && !trimmed.startsWith('#'))) {
          return trimmed.slice(0, 300) + (trimmed.length > 300 ? '...' : '');
        }
      }
      // Fallback to first paragraph
      return paragraphs[0]?.slice(0, 300) || cleanContent.slice(0, 300);
    }
    
    // Get all sentences for context-aware extraction
    const sentences = this.getSentences(cleanContent);
    
    // Group matches by proximity
    const sortedMatches = [...matches].sort((a, b) => a.start - b.start);
    const groups: MatchPosition[][] = [];
    let currentGroup: MatchPosition[] = [sortedMatches[0]];
    
    for (let i = 1; i < sortedMatches.length; i++) {
      if (sortedMatches[i].start - sortedMatches[i - 1].end < 300) {
        currentGroup.push(sortedMatches[i]);
      } else {
        groups.push(currentGroup);
        currentGroup = [sortedMatches[i]];
      }
    }
    groups.push(currentGroup);
    
    // Extract sentence-based snippets from top groups
    const snippets: string[] = [];
    for (const group of groups.slice(0, 3)) {
      const groupStart = group[0].start;
      const groupEnd = group[group.length - 1].end;
      
      // Find sentences that contain matches
      const relevantSentences = sentences.filter(s => 
        (s.start <= groupEnd && s.end >= groupStart) || // Overlaps with match group
        (s.start >= groupStart - 100 && s.end <= groupEnd + 100) // Within context window
      );
      
      let snippet: string;
      if (relevantSentences.length > 0) {
        // Join relevant sentences
        snippet = relevantSentences.map(s => s.text).join(' ');
        
        // Add context if snippet is too short
        if (snippet.length < 80 && relevantSentences.length > 0) {
          const firstSentence = relevantSentences[0];
          const prevSentence = sentences.find(s => s.end < firstSentence.start && s.end >= firstSentence.start - 200);
          const nextSentence = sentences.find(s => s.start > firstSentence.end && s.start <= firstSentence.end + 200);
          const parts: string[] = [];
          if (prevSentence) parts.push(prevSentence.text);
          parts.push(snippet);
          if (nextSentence) parts.push(nextSentence.text);
          snippet = parts.join(' ');
        }
      } else {
        // Fallback to character-based extraction
        const start = Math.max(0, groupStart - 80);
        const end = Math.min(cleanContent.length, groupEnd + 80);
        snippet = cleanContent.slice(start, end);
        if (start > 0) snippet = '...' + snippet;
        if (end < cleanContent.length) snippet = snippet + '...';
      }
      
      // Highlight matches (process in reverse order to preserve positions)
      // We need to find the matches within the snippet text
      const sortedGroup = [...group].sort((a, b) => b.start - a.start);
      for (const match of sortedGroup) {
        // Find where this match appears in the snippet
        const matchText = match.text;
        const regex = new RegExp(matchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const matchInSnippet = regex.exec(snippet);
        if (matchInSnippet) {
          const idx = matchInSnippet.index;
          snippet = snippet.slice(0, idx) + `**${matchText}**` + snippet.slice(idx + matchText.length);
        }
      }
      
      snippets.push(snippet);
    }
    
    return snippets.join('\n\n---\n\n');
  }

  // ── Utilities ────────────────────────────────────────────────────────

  clear(): void {
    this.files.clear();
    this.invertedIndex = {};
    this.fileHashes.clear();
    this.totalWordCount = 0;
    this.dirty = true;
  }

  getStats(): {
    files: number;
    terms: number;
    avgDocLength: number;
  } {
    return {
      files: this.files.size,
      terms: Object.keys(this.invertedIndex).length,
      avgDocLength: this.files.size > 0 ? this.totalWordCount / this.files.size : 0
    };
  }
}
