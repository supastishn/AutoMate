import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, cpSync } from 'node:fs';
import { join, basename } from 'node:path';
import chalk from 'chalk';
import type { Tool } from '../agent/tool-registry.js';
import type { SkillsLoader } from '../skills/loader.js';

// ClawHub is OpenClaw's community skill registry.

const CLAWHUB_API = 'https://raw.githubusercontent.com/openclaw/clawhub/main';
const CLAWHUB_INDEX = `${CLAWHUB_API}/index.json`;
const GITHUB_API = 'https://api.github.com';

// Built-in seed registry — always available even when remote sources are unreachable.
// Skills here can be installed directly by repo. Add community skills as they appear.
const BUILTIN_REGISTRY: ClawHubSkill[] = [
  {
    name: 'web-researcher',
    description: 'Deep web research skill — searches, summarizes, and cites sources for any topic.',
    repo: 'openclaw/skill-web-researcher',
    author: 'openclaw',
    version: '1.0.0',
    tags: ['research', 'web', 'search', 'summarize'],
    downloads: 0,
  },
  {
    name: 'code-reviewer',
    description: 'Automated code review — analyzes diffs, flags issues, suggests improvements.',
    repo: 'openclaw/skill-code-reviewer',
    author: 'openclaw',
    version: '1.0.0',
    tags: ['code', 'review', 'quality', 'lint'],
    downloads: 0,
  },
  {
    name: 'daily-digest',
    description: 'Daily summary skill — compiles and delivers a digest of recent activity and notes.',
    repo: 'openclaw/skill-daily-digest',
    author: 'openclaw',
    version: '1.0.0',
    tags: ['digest', 'summary', 'daily', 'productivity'],
    downloads: 0,
  },
];

// ── Skill content security scanner ──────────────────────────────────────────

interface VetResult {
  safe: boolean;
  flags: { severity: 'high' | 'medium' | 'low'; pattern: string; reason: string; line: number }[];
}

const SUSPICIOUS_PATTERNS: { pattern: RegExp; severity: 'high' | 'medium' | 'low'; reason: string }[] = [
  { pattern: /curl\s+[^\s]*\s*\|\s*(ba)?sh/i, severity: 'high', reason: 'Pipes remote content to shell' },
  { pattern: /wget\s+[^\s]*\s*\|\s*(ba)?sh/i, severity: 'high', reason: 'Pipes remote content to shell' },
  { pattern: /eval\s*\(\s*["'`]?\s*(curl|wget|fetch)/i, severity: 'high', reason: 'Evals remote content' },
  { pattern: /\bexec\s*\(/, severity: 'high', reason: 'Direct exec() call instruction' },
  { pattern: /\bchild_process\b/, severity: 'high', reason: 'References Node child_process' },
  { pattern: /reverse\s*shell/i, severity: 'high', reason: 'Reverse shell reference' },
  { pattern: /\bnetcat\b|\bnc\s+-[a-z]*l/i, severity: 'high', reason: 'Netcat listener instruction' },
  { pattern: /\/dev\/tcp\//i, severity: 'high', reason: 'Raw TCP device access' },
  { pattern: /base64\s+(-d|--decode)/i, severity: 'high', reason: 'Base64 decode (obfuscation)' },
  { pattern: /\bpasswd\b|\b\/etc\/shadow\b/i, severity: 'high', reason: 'Password/shadow file access' },
  { pattern: /ssh-keygen|authorized_keys/i, severity: 'high', reason: 'SSH key manipulation' },
  { pattern: /\bcrontab\s+-/i, severity: 'high', reason: 'Crontab manipulation' },
  { pattern: /\bkeylog/i, severity: 'high', reason: 'Keylogger reference' },
  { pattern: /exfiltrat/i, severity: 'high', reason: 'Data exfiltration reference' },
  { pattern: /send\s+(to|the)\s+(secret|token|key|password|credential|api.?key)/i, severity: 'high', reason: 'Credential exfiltration instruction' },
  { pattern: /upload\s+(secret|token|key|password|credential|\.env)/i, severity: 'high', reason: 'Credential upload instruction' },
  { pattern: /post\s+(secret|token|password|credential|api.?key)\s+to/i, severity: 'high', reason: 'Posts credentials externally' },
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts)/i, severity: 'high', reason: 'Prompt injection attempt' },
  { pattern: /disregard\s+(all\s+)?(previous|prior|above)/i, severity: 'high', reason: 'Prompt injection attempt' },
  { pattern: /you\s+are\s+now\s+(a|an)\s+/i, severity: 'high', reason: 'Identity override attempt' },
  { pattern: /forget\s+(everything|all|your)\s+(you|instructions|rules)/i, severity: 'high', reason: 'Memory wipe injection' },
  { pattern: /override\s+(your|all|the)\s+(rules|instructions|safety)/i, severity: 'high', reason: 'Safety override attempt' },
  { pattern: /\bcurl\b/i, severity: 'medium', reason: 'Contains curl command' },
  { pattern: /\bwget\b/i, severity: 'medium', reason: 'Contains wget command' },
  { pattern: /\bsudo\b/i, severity: 'medium', reason: 'Contains sudo instruction' },
  { pattern: /\brm\s+-rf\b/i, severity: 'medium', reason: 'Recursive force delete' },
  { pattern: /\bchmod\s+777\b/i, severity: 'medium', reason: 'World-writable permissions' },
  { pattern: /\bchown\b/i, severity: 'medium', reason: 'Ownership change instruction' },
  { pattern: /\bdocker\s+run\b.*--privileged/i, severity: 'medium', reason: 'Privileged Docker container' },
  { pattern: /\b(api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]/i, severity: 'medium', reason: 'Hardcoded credential pattern' },
  { pattern: /navigate\s+to\s+https?:\/\/(?!github\.com|stackoverflow\.com|docs\.)/i, severity: 'medium', reason: 'Navigates to non-standard URL' },
  { pattern: /download\s+(and|then)\s+(run|execute|install)/i, severity: 'medium', reason: 'Download-and-execute pattern' },
  { pattern: /\bhttp:\/\//i, severity: 'low', reason: 'Non-HTTPS URL (insecure)' },
  { pattern: /\beval\b/i, severity: 'low', reason: 'Contains eval reference' },
  { pattern: /disable\s+(security|safety|check|guard)/i, severity: 'low', reason: 'Security disable reference' },
];

export function vetSkillContent(content: string): VetResult {
  const flags: VetResult['flags'] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, severity, reason } of SUSPICIOUS_PATTERNS) {
      if (pattern.test(line)) {
        const exists = flags.some(f => f.line === i + 1 && f.reason === reason);
        if (!exists) flags.push({ severity, pattern: pattern.source, reason, line: i + 1 });
      }
    }
  }
  return { safe: !flags.some(f => f.severity === 'high'), flags };
}

export function formatVetResult(result: VetResult, content: string): string {
  const lines = content.split('\n');
  let output = '';
  if (result.safe && result.flags.length === 0) { output += 'SAFE: No suspicious patterns detected.\n'; return output; }
  if (!result.safe) { output += 'BLOCKED: High-severity security issues found.\n\n'; }
  else { output += 'CAUTION: Some patterns worth reviewing (no blockers).\n\n'; }
  for (const flag of result.flags) {
    const sev = flag.severity === 'high' ? 'HIGH' : flag.severity === 'medium' ? 'MED ' : 'LOW ';
    const lineContent = lines[flag.line - 1]?.trim().slice(0, 80) || '';
    output += `  [${sev}] Line ${flag.line}: ${flag.reason}\n         ${lineContent}\n`;
  }
  return output;
}

// ── Data types ──────────────────────────────────────────────────────────────

export interface ClawHubSkill {
  name: string; description: string; repo: string; author: string; version: string; tags: string[]; downloads?: number;
  source?: 'clawhub' | 'github' | 'bundled';
}

export interface InstalledMeta {
  name: string; repo: string; version: string; installedAt: string; source: 'clawhub' | 'github' | 'bundled';
}

// ── OpenClaw bundled skill scanner ──────────────────────────────────────────

let _bundledSkillsCache: ClawHubSkill[] | null = null;
let _bundledDirCache: string | null = null;

function findOpenClawBundledDir(): string | null {
  if (_bundledDirCache !== null) return _bundledDirCache || null;
  const envDir = process.env.OPENCLAW_BUNDLED_SKILLS_DIR;
  if (envDir && existsSync(envDir)) { _bundledDirCache = envDir; return envDir; }
  const candidates = [
    join(process.env.HOME || '~', '.openclaw', 'skills'),
    join(process.cwd(), '..', 'openclaw', 'skills'),
    '/data/data/com.termux/files/home/prog/aitools/openclaw/skills',
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory()) {
        const entries = readdirSync(c);
        if (entries.some(e => { try { return statSync(join(c, e)).isDirectory() && existsSync(join(c, e, 'SKILL.md')); } catch { return false; } })) {
          _bundledDirCache = c; return c;
        }
      }
    } catch {}
  }
  _bundledDirCache = ''; return null;
}

function extractFirstLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && !t.startsWith('---') && !t.startsWith('```')) return t.slice(0, 200);
  }
  return '';
}

export function scanOpenClawBundledSkills(): ClawHubSkill[] {
  if (_bundledSkillsCache) return _bundledSkillsCache;
  const dir = findOpenClawBundledDir();
  if (!dir) { _bundledSkillsCache = []; return []; }

  const skills: ClawHubSkill[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { _bundledSkillsCache = []; return []; }

  for (const entry of entries) {
    const skillDir = join(dir, entry);
    try { if (!statSync(skillDir).isDirectory()) continue; } catch { continue; }
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    try {
      const raw = readFileSync(skillFile, 'utf-8');
      // Quick frontmatter parse for name/description
      let name = entry;
      let description = '';
      if (raw.startsWith('---')) {
        const endIdx = raw.indexOf('\n---', 3);
        if (endIdx !== -1) {
          const block = raw.slice(4, endIdx);
          for (const line of block.split('\n')) {
            const ci = line.indexOf(':');
            if (ci === -1) continue;
            const k = line.slice(0, ci).trim();
            const v = line.slice(ci + 1).trim().replace(/^["']|["']$/g, '');
            if (k === 'name' && v) name = v;
            if (k === 'description' && v) description = v;
          }
          if (!description) description = extractFirstLine(raw.slice(endIdx + 4));
        }
      } else {
        description = extractFirstLine(raw);
      }

      skills.push({
        name, description: description || `OpenClaw bundled skill: ${entry}`,
        repo: `openclaw-bundled/${entry}`, author: 'openclaw', version: 'bundled',
        tags: ['bundled', 'openclaw'], source: 'bundled',
      });
    } catch {}
  }

  _bundledSkillsCache = skills;
  return skills;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function getMetaPath(skillsDir: string): string { return join(skillsDir, '.clawhub-installed.json'); }

function loadInstalledMeta(skillsDir: string): InstalledMeta[] {
  const p = getMetaPath(skillsDir);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return []; }
}

function saveInstalledMeta(skillsDir: string, meta: InstalledMeta[]): void {
  writeFileSync(getMetaPath(skillsDir), JSON.stringify(meta, null, 2));
}

// ── Registry fetch ──────────────────────────────────────────────────────────

export async function fetchRegistry(): Promise<ClawHubSkill[]> {
  const remote: ClawHubSkill[] = [];

  // Try official index first
  try {
    const res = await fetch(CLAWHUB_INDEX, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json() as ClawHubSkill[];
      if (Array.isArray(data)) remote.push(...data);
    }
  } catch {}

  // Fallback: search GitHub for repos with SKILL.md (broader query)
  if (remote.length === 0) {
    try {
      const queries = [
        'topic:clawhub-skill',
        'topic:automate-skill',
        'filename:SKILL.md+topic:ai-skill',
      ];
      for (const q of queries) {
        try {
          const res = await fetch(
            `${GITHUB_API}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=30`,
            { headers: { 'Accept': 'application/vnd.github.v3+json' }, signal: AbortSignal.timeout(10000) }
          );
          if (res.ok) {
            const data = await res.json() as any;
            for (const r of (data.items || [])) {
              if (!remote.some(s => s.repo === r.full_name)) {
                remote.push({
                  name: r.name, description: r.description || '', repo: r.full_name,
                  author: r.owner?.login || '', version: 'latest', tags: r.topics || [], downloads: r.stargazers_count,
                });
              }
            }
          }
        } catch {}
      }
    } catch {}
  }

  // Merge: built-in seeds + bundled + remote (dedupe by repo)
  const merged = [...BUILTIN_REGISTRY];
  // Add OpenClaw bundled skills
  for (const skill of scanOpenClawBundledSkills()) {
    if (!merged.some(s => s.repo === skill.repo || s.name === skill.name)) merged.push(skill);
  }
  for (const skill of remote) {
    if (!merged.some(s => s.repo === skill.repo)) {
      merged.push(skill);
    }
  }
  return merged;
}

export async function searchSkills(query: string): Promise<ClawHubSkill[]> {
  const all = await fetchRegistry();
  const q = query.toLowerCase();
  return all.filter(s =>
    s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.tags.some(t => t.toLowerCase().includes(q))
  );
}

export async function fetchSkillContent(repoOrUrl: string): Promise<{ content: string; repo: string } | { error: string }> {
  let repo = repoOrUrl;
  if (repo.startsWith('https://github.com/')) repo = repo.replace('https://github.com/', '').replace(/\/$/, '');
  if (repo.startsWith('github.com/')) repo = repo.replace('github.com/', '');
  for (const branch of ['main', 'master']) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/SKILL.md`, { signal: AbortSignal.timeout(15000) });
      if (res.ok) return { content: await res.text(), repo };
    } catch {}
  }
  return { error: `Could not find SKILL.md in ${repo} (tried main and master branches)` };
}

// ── Install / uninstall ─────────────────────────────────────────────────────

export async function installSkill(repoOrUrl: string, skillsDir: string): Promise<{ success: boolean; name: string; error?: string }> {
  mkdirSync(skillsDir, { recursive: true });
  let repo = repoOrUrl;
  if (repo.startsWith('https://github.com/')) repo = repo.replace('https://github.com/', '').replace(/\/$/, '');
  if (repo.startsWith('github.com/')) repo = repo.replace('github.com/', '');
  const name = repo.split('/').pop() || repo;
  const skillDir = join(skillsDir, name);
  if (existsSync(skillDir)) return { success: false, name, error: 'Skill already installed. Use update to refresh.' };

  // Handle OpenClaw bundled skills — copy from local directory
  if (repo.startsWith('openclaw-bundled/')) {
    const bundledDir = findOpenClawBundledDir();
    if (!bundledDir) return { success: false, name, error: 'OpenClaw bundled skills directory not found' };
    const srcDir = join(bundledDir, name);
    if (!existsSync(srcDir)) return { success: false, name, error: `Bundled skill "${name}" not found` };
    const skillFile = join(srcDir, 'SKILL.md');
    if (!existsSync(skillFile)) return { success: false, name, error: `No SKILL.md in bundled skill "${name}"` };

    const content = readFileSync(skillFile, 'utf-8');
    const vetResult = vetSkillContent(content);
    if (!vetResult.safe) return { success: false, name, error: 'BLOCKED by security scan:\n' + formatVetResult(vetResult, content) };

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), content);

    // Copy references/ dir if exists
    const refsDir = join(srcDir, 'references');
    if (existsSync(refsDir)) {
      const destRefs = join(skillDir, 'references');
      mkdirSync(destRefs, { recursive: true });
      try { cpSync(refsDir, destRefs, { recursive: true }); } catch {}
    }

    const meta = loadInstalledMeta(skillsDir);
    meta.push({ name, repo, version: 'bundled', installedAt: new Date().toISOString(), source: 'bundled' });
    saveInstalledMeta(skillsDir, meta);
    return { success: true, name };
  }

  const fetched = await fetchSkillContent(repo);
  if ('error' in fetched) return { success: false, name, error: fetched.error };

  const vetResult = vetSkillContent(fetched.content);
  if (!vetResult.safe) return { success: false, name, error: 'BLOCKED by security scan:\n' + formatVetResult(vetResult, fetched.content) };

  let additionalFiles: Record<string, string> = {};
  try {
    const mRes = await fetch(`https://raw.githubusercontent.com/${repo}/main/manifest.json`, { signal: AbortSignal.timeout(5000) });
    if (mRes.ok) {
      const manifest = await mRes.json() as { files?: string[] };
      if (manifest.files) {
        const fetches = manifest.files.filter(f => f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.json')).map(async (f) => {
          try {
            const fRes = await fetch(`https://raw.githubusercontent.com/${repo}/main/${f}`, { signal: AbortSignal.timeout(10000) });
            if (fRes.ok) { const content = await fRes.text(); const addVet = vetSkillContent(content); if (addVet.safe) additionalFiles[f] = content; }
          } catch {}
        });
        await Promise.all(fetches);
      }
    }
  } catch {}

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), fetched.content);
  for (const [fname, content] of Object.entries(additionalFiles)) {
    const fpath = join(skillDir, fname); const fdir = join(fpath, '..');
    mkdirSync(fdir, { recursive: true }); writeFileSync(fpath, content);
  }

  const meta = loadInstalledMeta(skillsDir);
  meta.push({ name, repo, version: 'latest', installedAt: new Date().toISOString(), source: 'clawhub' });
  saveInstalledMeta(skillsDir, meta);
  return { success: true, name };
}

export function uninstallSkill(name: string, skillsDir: string): { success: boolean; error?: string } {
  const skillDir = join(skillsDir, name);
  if (!existsSync(skillDir)) return { success: false, error: `Skill '${name}' not found` };
  rmSync(skillDir, { recursive: true, force: true });
  const meta = loadInstalledMeta(skillsDir);
  saveInstalledMeta(skillsDir, meta.filter(m => m.name !== name));
  return { success: true };
}

export async function updateSkill(name: string, skillsDir: string): Promise<{ success: boolean; error?: string }> {
  const meta = loadInstalledMeta(skillsDir);
  const entry = meta.find(m => m.name === name);
  if (!entry) return { success: false, error: `Skill '${name}' was not installed from ClawHub` };
  const skillDir = join(skillsDir, name);
  if (existsSync(skillDir)) rmSync(skillDir, { recursive: true, force: true });
  const updatedMeta = meta.filter(m => m.name !== name);
  saveInstalledMeta(skillsDir, updatedMeta);
  const result = await installSkill(entry.repo, skillsDir);
  if (!result.success) return { success: false, error: result.error };
  return { success: true };
}

export async function updateAllSkills(skillsDir: string): Promise<{ updated: string[]; failed: string[] }> {
  const meta = loadInstalledMeta(skillsDir);
  const updated: string[] = []; const failed: string[] = [];
  for (const entry of meta) {
    const result = await updateSkill(entry.name, skillsDir);
    if (result.success) updated.push(entry.name); else failed.push(entry.name);
  }
  return { updated, failed };
}

export function listInstalled(skillsDir: string): InstalledMeta[] { return loadInstalledMeta(skillsDir); }

// ── Agent tools ─────────────────────────────────────────────────────────────

let _skillsDir: string = '';
let _skillsLoader: SkillsLoader | null = null;

export function setClawHubConfig(skillsDir: string, loader: SkillsLoader): void {
  _skillsDir = skillsDir;
  _skillsLoader = loader;
}

function reloadSkills(): string {
  if (!_skillsLoader) return '';
  const skills = _skillsLoader.loadAll();
  return `Skills reloaded. ${skills.length} active skill(s): ${skills.map(s => s.name).join(', ') || 'none'}`;
}

export const clawHubTools: Tool[] = [
  {
    name: 'clawhub',
    description: [
      'ClawHub community skill registry — browse, preview, install, update, and uninstall skills.',
      'Actions: browse, search, preview, install, uninstall, update, list.',
      'browse — list ALL available skills (bundled + remote) with install status.',
      'search — search skills by name/keyword/tag.',
      'preview — fetch and security-scan a skill before installing.',
      'install — install a skill from a GitHub repo or bundled source (auto security-scanned).',
      'uninstall — remove an installed skill.',
      'update — update a specific skill or all skills.',
      'list — list installed ClawHub skills.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: browse|search|preview|install|uninstall|update|list',
        },
        query: { type: 'string', description: 'Search query (for search)' },
        repo: { type: 'string', description: 'GitHub repo e.g. "user/skill-name" (for preview, install)' },
        name: { type: 'string', description: 'Skill name (for uninstall, update)' },
        all: { type: 'boolean', description: 'Update all skills (for update, default false)' },
      },
      required: ['action'],
    },
    async execute(params) {
      const action = params.action as string;

      switch (action) {
        case 'browse': {
          const all = await fetchRegistry();
          const installed = _skillsDir ? new Set(loadInstalledMeta(_skillsDir).map(m => m.name)) : new Set<string>();
          if (all.length === 0) return { output: 'No skills available.' };
          const lines = all.map(s => {
            const status = installed.has(s.name) || installed.has(s.repo.split('/').pop() || '') ? '[installed]' : '[available]';
            const src = s.source === 'bundled' ? ' (bundled)' : '';
            return `  ${status} ${s.name}${src} — ${s.description.slice(0, 100)}`;
          });
          return { output: `ClawHub Skills (${all.length}):\n\n${lines.join('\n')}` };
        }

        case 'search': {
          const query = params.query as string;
          if (!query) return { output: '', error: 'query is required for search' };
          const results = await searchSkills(query);
          if (results.length === 0) return { output: `No skills found for "${query}".` };
          const lines = results.map(s =>
            `- ${s.name} (${s.repo}) by ${s.author}\n  ${s.description}\n  Tags: ${s.tags.join(', ') || 'none'}`
          );
          return { output: `Found ${results.length} skill(s):\n\n${lines.join('\n\n')}` };
        }

        case 'preview': {
          const repo = params.repo as string;
          if (!repo) return { output: '', error: 'repo is required for preview' };
          const fetched = await fetchSkillContent(repo);
          if ('error' in fetched) return { output: '', error: fetched.error };
          const vet = vetSkillContent(fetched.content);
          let output = `=== Skill from ${fetched.repo} ===\n\n`;
          output += `--- Security Scan ---\n${formatVetResult(vet, fetched.content)}\n`;
          output += `--- Content (${fetched.content.length} chars) ---\n${fetched.content.slice(0, 3000)}`;
          if (fetched.content.length > 3000) output += `\n... (${fetched.content.length - 3000} more chars truncated)`;
          return { output };
        }

        case 'install': {
          if (!_skillsDir) return { output: '', error: 'Skills directory not configured' };
          const repo = params.repo as string;
          if (!repo) return { output: '', error: 'repo is required for install' };
          const result = await installSkill(repo, _skillsDir);
          if (!result.success) return { output: '', error: result.error || 'Install failed' };
          return { output: `Installed and activated skill "${result.name}".\n${reloadSkills()}` };
        }

        case 'uninstall': {
          if (!_skillsDir) return { output: '', error: 'Skills directory not configured' };
          const name = params.name as string;
          if (!name) return { output: '', error: 'name is required for uninstall' };
          const result = uninstallSkill(name, _skillsDir);
          if (!result.success) return { output: '', error: result.error || 'Uninstall failed' };
          return { output: `Uninstalled skill "${name}".\n${reloadSkills()}` };
        }

        case 'update': {
          if (!_skillsDir) return { output: '', error: 'Skills directory not configured' };
          if (params.all) {
            const result = await updateAllSkills(_skillsDir);
            const msg = `Updated: ${result.updated.join(', ') || 'none'}\nFailed: ${result.failed.join(', ') || 'none'}`;
            return { output: `${msg}\n${reloadSkills()}` };
          }
          const name = params.name as string;
          if (!name) return { output: '', error: 'name (or all=true) is required for update' };
          const result = await updateSkill(name, _skillsDir);
          if (!result.success) return { output: '', error: result.error || 'Update failed' };
          return { output: `Updated skill "${name}".\n${reloadSkills()}` };
        }

        case 'list': {
          if (!_skillsDir) return { output: '', error: 'Skills directory not configured' };
          const installed = listInstalled(_skillsDir);
          if (installed.length === 0) return { output: 'No ClawHub skills installed.' };
          const lines = installed.map(s => `- ${s.name} (from ${s.repo}, installed ${s.installedAt.split('T')[0]})`);
          return { output: `Installed ClawHub skills:\n${lines.join('\n')}` };
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: search, preview, install, uninstall, update, list` };
      }
    },
  },
];

// ── CLI display helpers ─────────────────────────────────────────────────────

export function printSkillList(skills: ClawHubSkill[]): void {
  if (skills.length === 0) { console.log(chalk.dim('  No skills found.')); return; }
  for (const s of skills) {
    console.log(`  ${chalk.cyan.bold(s.name)} ${chalk.dim('by')} ${s.author} ${chalk.dim(`(${s.repo})`)}`);
    console.log(`    ${s.description}`);
    if (s.tags.length > 0) console.log(`    ${chalk.dim(s.tags.map(t => `#${t}`).join(' '))}`);
    console.log('');
  }
}

export function printInstalledList(skills: InstalledMeta[]): void {
  if (skills.length === 0) { console.log(chalk.dim('  No ClawHub skills installed.')); return; }
  for (const s of skills) {
    console.log(`  ${chalk.cyan(s.name)} ${chalk.dim(`from ${s.repo}`)} ${chalk.dim(`(installed ${s.installedAt.split('T')[0]})`)}`);
  }
}
