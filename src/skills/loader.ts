import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { watch, type FSWatcher } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import JSON5 from 'json5';
import type { Config } from '../config/schema.js';
import type { Tool } from '../agent/tool-registry.js';

/* ── Types ─────────────────────────────────────────────────────────── */

export interface SkillInstallSpec {
  id?: string;
  kind: string;         // brew | apt | node | go | uv | download
  label?: string;
  bins?: string[];
  formula?: string;     // brew
  package?: string;     // apt / node
  module?: string;      // go
  url?: string;         // download
}

export interface SkillMetadata {
  emoji?: string;
  homepage?: string;
  always?: boolean;            // skip gating, always include
  os?: string[];
  requires?: {
    bins?: string[];           // ALL must exist
    anyBins?: string[];        // at least ONE must exist
    env?: string[];            // ALL must be set
    config?: string[];         // config paths (not used in Automate yet, reserved)
  };
  install?: SkillInstallSpec[];
}

export interface SkillGatingResult {
  passed: boolean;
  missingBins?: string[];
  missingAnyBins?: string[];   // none of these found
  missingEnv?: string[];
  unsupportedOs?: boolean;
  installHints?: SkillInstallSpec[];
}

export interface Skill {
  name: string;
  description: string;
  content: string;             // SKILL.md body (frontmatter stripped)
  references: string[];        // extra reference .md contents
  tools?: Tool[];
  directory: string;
  metadata?: SkillMetadata;
  gating?: SkillGatingResult;  // populated when skill is skipped
}

/* ── Frontmatter parsing ───────────────────────────────────────────── */

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  homepage?: string;
  metadata?: SkillMetadata;
  raw: Record<string, string>;   // flat key:value fallback
}

/**
 * Parse YAML-ish frontmatter that may contain inline JSON5 metadata blocks.
 * Supports both Automate's flat `requires_bins: gh,jq` and OpenClaw's nested
 * `metadata: { "openclaw": { ... } }` format.
 */
function parseFrontmatter(content: string): ParsedFrontmatter | null {
  if (!content.startsWith('---')) return null;
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return null;
  const block = content.slice(4, endIdx).trim();   // skip first "---\n"

  const result: ParsedFrontmatter = { raw: {} };

  // Collect all lines, then detect metadata JSON5 block
  const lines = block.split('\n');
  let metadataJson = '';
  let inMetadata = false;
  let braceDepth = 0;

  for (const line of lines) {
    if (!inMetadata) {
      // Check if this line starts the metadata block
      const metaMatch = line.match(/^metadata:\s*(.*)/);
      if (metaMatch) {
        const rest = metaMatch[1].trim();
        if (rest) {
          // Inline metadata on same line or start of multi-line
          metadataJson += rest;
          braceDepth = countBraces(rest);
          if (braceDepth <= 0) {
            // Single-line metadata
            inMetadata = false;
            result.metadata = parseMetadataJson(metadataJson);
            metadataJson = '';
          } else {
            inMetadata = true;
          }
        }
        continue;
      }

      // Flat key: value parsing (Automate's native format)
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key && value) {
        result.raw[key] = value;
        if (key === 'name') result.name = unquote(value);
        if (key === 'description') result.description = unquote(value);
        if (key === 'homepage') result.homepage = unquote(value);
      }
    } else {
      // Accumulating multi-line metadata JSON5
      metadataJson += '\n' + line;
      braceDepth += countBraces(line);
      if (braceDepth <= 0) {
        inMetadata = false;
        result.metadata = parseMetadataJson(metadataJson);
        metadataJson = '';
      }
    }
  }

  // If we were still reading metadata (unclosed), try parsing what we have
  if (inMetadata && metadataJson) {
    result.metadata = parseMetadataJson(metadataJson);
  }

  // Fallback: convert Automate's flat format to metadata if no nested metadata found
  if (!result.metadata) {
    result.metadata = flatToMetadata(result.raw);
  }

  return result;
}

function countBraces(s: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
  }
  return depth;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseMetadataJson(raw: string): SkillMetadata | undefined {
  try {
    const parsed = JSON5.parse(raw);
    // Look for openclaw key (or legacy names)
    const meta = parsed.openclaw || parsed.picoding || parsed.pi || parsed;
    if (!meta || typeof meta !== 'object') return undefined;

    const requires = meta.requires && typeof meta.requires === 'object'
      ? {
          bins: normalizeStringList(meta.requires.bins),
          anyBins: normalizeStringList(meta.requires.anyBins),
          env: normalizeStringList(meta.requires.env),
          config: normalizeStringList(meta.requires.config),
        }
      : undefined;

    // Clean up empty arrays — build a clean object
    let cleanRequires: { bins?: string[]; anyBins?: string[]; env?: string[]; config?: string[] } | undefined;
    if (requires) {
      cleanRequires = {};
      if (requires.bins && requires.bins.length > 0) cleanRequires.bins = requires.bins;
      if (requires.anyBins && requires.anyBins.length > 0) cleanRequires.anyBins = requires.anyBins;
      if (requires.env && requires.env.length > 0) cleanRequires.env = requires.env;
      if (requires.config && requires.config.length > 0) cleanRequires.config = requires.config;
      if (Object.keys(cleanRequires).length === 0) cleanRequires = undefined;
    }

    const install: SkillInstallSpec[] = Array.isArray(meta.install)
      ? meta.install.map((spec: any) => ({
          id: spec.id,
          kind: spec.kind || 'unknown',
          label: spec.label,
          bins: normalizeStringList(spec.bins),
          formula: spec.formula,
          package: spec.package,
          module: spec.module,
          url: spec.url,
        }))
      : [];

    return {
      emoji: typeof meta.emoji === 'string' ? meta.emoji : undefined,
      homepage: typeof meta.homepage === 'string' ? meta.homepage : undefined,
      always: typeof meta.always === 'boolean' ? meta.always : undefined,
      os: normalizeStringList(meta.os).length > 0 ? normalizeStringList(meta.os) : undefined,
      requires: cleanRequires,
      install: install.length > 0 ? install : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Convert Automate's flat frontmatter keys to SkillMetadata */
function flatToMetadata(raw: Record<string, string>): SkillMetadata | undefined {
  const hasBins = !!raw.requires_bins;
  const hasEnv = !!raw.requires_env;
  const hasOs = !!raw.os;
  if (!hasBins && !hasEnv && !hasOs) return undefined;

  return {
    requires: {
      ...(hasBins ? { bins: raw.requires_bins.split(',').map(b => b.trim()).filter(Boolean) } : {}),
      ...(hasEnv ? { env: raw.requires_env.split(',').map(v => v.trim()).filter(Boolean) } : {}),
    },
    ...(hasOs ? { os: raw.os.split(',').map(o => o.trim()).filter(Boolean) } : {}),
  };
}

function normalizeStringList(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(v => String(v).trim()).filter(Boolean);
  if (typeof input === 'string') return input.split(',').map(v => v.trim()).filter(Boolean);
  return [];
}

/** Strip frontmatter from content, returning only the body */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return content;
  return content.slice(endIdx + 4).trim();
}

/* ── Binary cache ──────────────────────────────────────────────────── */

const binCache = new Map<string, boolean>();

function hasBinary(name: string): boolean {
  if (binCache.has(name)) return binCache.get(name)!;
  try {
    execSync(`which ${name}`, { stdio: 'ignore' });
    binCache.set(name, true);
    return true;
  } catch {
    binCache.set(name, false);
    return false;
  }
}

/* ── Skill loader ──────────────────────────────────────────────────── */

export class SkillsLoader {
  private skills: Map<string, Skill> = new Map();
  private skippedSkills: Map<string, Skill> = new Map();  // skills that failed gating
  private config: Config;
  private watcher: FSWatcher | null = null;
  private _changed = false;

  constructor(config: Config) {
    this.config = config;
  }

  /* ── Watch ─────────────────────────────────────────────────────── */

  startWatching(): void {
    const dirs = this.getSkillDirs();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        this.watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
          if (filename && filename.endsWith('.md')) {
            this._changed = true;
          }
        });
      } catch {
        // recursive watch not supported on all platforms
      }
    }
  }

  reloadIfChanged(): boolean {
    if (!this._changed) return false;
    this._changed = false;
    this.loadAll();
    return true;
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /* ── Directory resolution ─────────────────────────────────────── */

  /** Returns all skill directories in precedence order (lowest first) */
  private getSkillDirs(): string[] {
    const dirs: string[] = [];

    // 1. Extra dirs from config
    if (this.config.skills.extraDirs) {
      for (const d of this.config.skills.extraDirs) {
        const resolved = d.replace(/^~/, process.env.HOME || '~');
        if (existsSync(resolved)) dirs.push(resolved);
      }
    }

    // 2. Main skills directory (highest precedence, can override extras)
    const mainDir = this.config.skills.directory.replace(/^~/, process.env.HOME || '~');
    dirs.push(mainDir);

    return dirs;
  }

  /* ── Load ──────────────────────────────────────────────────────── */

  loadAll(): Skill[] {
    this.skills.clear();
    this.skippedSkills.clear();
    binCache.clear();  // fresh binary check each reload

    const dirs = this.getSkillDirs();
    // Load in precedence order — later dirs override earlier ones
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      this.loadFromDir(dir);
    }

    const loaded = Array.from(this.skills.values());
    const skipped = Array.from(this.skippedSkills.values());

    if (loaded.length > 0 || skipped.length > 0) {
      console.log(`[skills] loaded ${loaded.length} skills, ${skipped.length} skipped by gating`);
      if (skipped.length > 0) {
        for (const s of skipped) {
          const g = s.gating!;
          const reasons: string[] = [];
          if (g.missingBins?.length) reasons.push(`bins: ${g.missingBins.join(', ')}`);
          if (g.missingAnyBins?.length) reasons.push(`anyBins (need 1 of): ${g.missingAnyBins.join(', ')}`);
          if (g.missingEnv?.length) reasons.push(`env: ${g.missingEnv.join(', ')}`);
          if (g.unsupportedOs) reasons.push(`os: ${process.platform} not supported`);
          const hints = g.installHints?.map(h => h.label || `${h.kind}: ${h.formula || h.package || h.module || ''}`).join('; ');
          console.log(`[skills]   skipped "${s.name}": ${reasons.join(', ')}${hints ? ` (install: ${hints})` : ''}`);
        }
      }
    }

    return loaded;
  }

  private loadFromDir(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch { return; }

    for (const entryName of entries) {
      const skillDir = join(dir, entryName);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
      } catch { continue; }
      const skillFile = join(skillDir, 'SKILL.md');

      if (!existsSync(skillFile)) continue;

      const rawContent = readFileSync(skillFile, 'utf-8');
      const frontmatter = parseFrontmatter(rawContent);
      const body = stripFrontmatter(rawContent);
      const meta = frontmatter?.metadata;

      // Gating check
      if (meta && !meta.always) {
        const gating = this.checkGating(meta);
        if (!gating.passed) {
          const skill: Skill = {
            name: frontmatter?.name || entryName,
            description: frontmatter?.description || this.extractDescription(body),
            content: body,
            references: [],
            directory: skillDir,
            metadata: meta,
            gating,
          };
          this.skippedSkills.set(entryName, skill);
          continue;
        }
      }

      // Load reference files
      const references = this.loadReferences(skillDir);

      const skill: Skill = {
        name: frontmatter?.name || entryName,
        description: frontmatter?.description || this.extractDescription(body),
        content: body,
        references,
        directory: skillDir,
        metadata: meta,
      };

      // Higher-precedence dirs override lower ones
      this.skills.set(entryName, skill);
    }
  }

  private loadReferences(skillDir: string): string[] {
    const refsDir = join(skillDir, 'references');
    if (!existsSync(refsDir)) return [];

    try {
      const files = readdirSync(refsDir).filter(f => f.endsWith('.md')).sort();
      return files.map(f => {
        const content = readFileSync(join(refsDir, f), 'utf-8');
        return `### Reference: ${f}\n\n${content}`;
      });
    } catch {
      return [];
    }
  }

  /* ── Gating ────────────────────────────────────────────────────── */

  private checkGating(meta: SkillMetadata): SkillGatingResult {
    const result: SkillGatingResult = { passed: true };

    // OS check
    if (meta.os && meta.os.length > 0) {
      if (!meta.os.includes(process.platform)) {
        result.passed = false;
        result.unsupportedOs = true;
      }
    }

    // Required binaries (ALL must exist)
    if (meta.requires?.bins && meta.requires.bins.length > 0) {
      const missing = meta.requires.bins.filter(b => !hasBinary(b));
      if (missing.length > 0) {
        result.passed = false;
        result.missingBins = missing;
      }
    }

    // Any binaries (at least ONE must exist)
    if (meta.requires?.anyBins && meta.requires.anyBins.length > 0) {
      const anyFound = meta.requires.anyBins.some(b => hasBinary(b));
      if (!anyFound) {
        result.passed = false;
        result.missingAnyBins = meta.requires.anyBins;
      }
    }

    // Required env vars (ALL must be set)
    if (meta.requires?.env && meta.requires.env.length > 0) {
      const missing = meta.requires.env.filter(v => !process.env[v]);
      if (missing.length > 0) {
        result.passed = false;
        result.missingEnv = missing;
      }
    }

    // Attach install hints when gating fails
    if (!result.passed && meta.install) {
      result.installHints = meta.install;
    }

    return result;
  }

  /* ── Query ─────────────────────────────────────────────────────── */

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  listSkippedSkills(): Skill[] {
    return Array.from(this.skippedSkills.values());
  }

  getSystemPromptInjection(): string {
    const skills = this.listSkills();
    if (skills.length === 0) return '';

    const sections = skills.map(s => {
      let section = `## Skill: ${s.name}`;
      if (s.metadata?.emoji) section = `## ${s.metadata.emoji} Skill: ${s.name}`;
      section += `\n${s.content}`;
      if (s.references.length > 0) {
        section += '\n\n' + s.references.join('\n\n');
      }
      return section;
    });

    return '\n\n# Active Skills\n\n' + sections.join('\n\n---\n\n');
  }

  /* ── Helpers ───────────────────────────────────────────────────── */

  private extractDescription(content: string): string {
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
        return trimmed.slice(0, 200);
      }
    }
    return '';
  }
}
