import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import type { Tool } from '../agent/tool-registry.js';
import type { SkillsLoader } from '../skills/loader.js';

// ClawHub is OpenClaw's community skill registry. We implement a compatible
// client so AutoMate users can browse and install skills from it.
// The registry is a GitHub-based system where skills are repos with SKILL.md files.

const CLAWHUB_API = 'https://raw.githubusercontent.com/openclaw/clawhub/main';
const CLAWHUB_INDEX = `${CLAWHUB_API}/index.json`;
const GITHUB_API = 'https://api.github.com';

// ── Skill content security scanner ──────────────────────────────────────────

interface VetResult {
  safe: boolean;
  flags: { severity: 'high' | 'medium' | 'low'; pattern: string; reason: string; line: number }[];
}

const SUSPICIOUS_PATTERNS: { pattern: RegExp; severity: 'high' | 'medium' | 'low'; reason: string }[] = [
  // High: direct command injection / exfiltration
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

  // Medium: suspicious but could be legitimate
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

  // Low: worth noting
  { pattern: /\bhttp:\/\//i, severity: 'low', reason: 'Non-HTTPS URL (insecure)' },
  { pattern: /\beval\b/i, severity: 'low', reason: 'Contains eval reference' },
  { pattern: /disable\s+(security|safety|check|guard)/i, severity: 'low', reason: 'Security disable reference' },
];

/** Scan skill content for suspicious/malicious patterns */
export function vetSkillContent(content: string): VetResult {
  const flags: VetResult['flags'] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, severity, reason } of SUSPICIOUS_PATTERNS) {
      if (pattern.test(line)) {
        // Avoid duplicate flags for the same line+reason
        const exists = flags.some(f => f.line === i + 1 && f.reason === reason);
        if (!exists) {
          flags.push({ severity, pattern: pattern.source, reason, line: i + 1 });
        }
      }
    }
  }

  const hasHigh = flags.some(f => f.severity === 'high');
  return { safe: !hasHigh, flags };
}

/** Format vet results for display */
export function formatVetResult(result: VetResult, content: string): string {
  const lines = content.split('\n');
  let output = '';

  if (result.safe && result.flags.length === 0) {
    output += 'SAFE: No suspicious patterns detected.\n';
    return output;
  }

  if (!result.safe) {
    output += 'BLOCKED: High-severity security issues found.\n\n';
  } else {
    output += 'CAUTION: Some patterns worth reviewing (no blockers).\n\n';
  }

  for (const flag of result.flags) {
    const sev = flag.severity === 'high' ? 'HIGH' : flag.severity === 'medium' ? 'MED ' : 'LOW ';
    const lineContent = lines[flag.line - 1]?.trim().slice(0, 80) || '';
    output += `  [${sev}] Line ${flag.line}: ${flag.reason}\n`;
    output += `         ${lineContent}\n`;
  }

  return output;
}

// ── Data types ──────────────────────────────────────────────────────────────

export interface ClawHubSkill {
  name: string;
  description: string;
  repo: string;        // e.g. "user/repo" or full URL
  author: string;
  version: string;
  tags: string[];
  downloads?: number;
}

export interface InstalledMeta {
  name: string;
  repo: string;
  version: string;
  installedAt: string;
  source: 'clawhub' | 'github';
}

// ── Internal helpers ────────────────────────────────────────────────────────

function getMetaPath(skillsDir: string): string {
  return join(skillsDir, '.clawhub-installed.json');
}

function loadInstalledMeta(skillsDir: string): InstalledMeta[] {
  const p = getMetaPath(skillsDir);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return [];
  }
}

function saveInstalledMeta(skillsDir: string, meta: InstalledMeta[]): void {
  writeFileSync(getMetaPath(skillsDir), JSON.stringify(meta, null, 2));
}

// ── Registry fetch ──────────────────────────────────────────────────────────

/** Fetch the ClawHub registry index. Falls back to GitHub search. */
export async function fetchRegistry(): Promise<ClawHubSkill[]> {
  try {
    const res = await fetch(CLAWHUB_INDEX, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      return await res.json() as ClawHubSkill[];
    }
  } catch {}

  try {
    const res = await fetch(
      `${GITHUB_API}/search/repositories?q=topic:clawhub-skill+topic:automate-skill&sort=stars&per_page=50`,
      {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (res.ok) {
      const data = await res.json() as any;
      return (data.items || []).map((r: any) => ({
        name: r.name,
        description: r.description || '',
        repo: r.full_name,
        author: r.owner?.login || '',
        version: 'latest',
        tags: r.topics || [],
        downloads: r.stargazers_count,
      }));
    }
  } catch {}

  return [];
}

/** Search skills by query */
export async function searchSkills(query: string): Promise<ClawHubSkill[]> {
  const all = await fetchRegistry();
  const q = query.toLowerCase();
  return all.filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.tags.some(t => t.toLowerCase().includes(q))
  );
}

/** Fetch a SKILL.md from a repo WITHOUT installing (for preview/vetting) */
export async function fetchSkillContent(repoOrUrl: string): Promise<{ content: string; repo: string } | { error: string }> {
  let repo = repoOrUrl;
  if (repo.startsWith('https://github.com/')) repo = repo.replace('https://github.com/', '').replace(/\/$/, '');
  if (repo.startsWith('github.com/')) repo = repo.replace('github.com/', '');

  for (const branch of ['main', 'master']) {
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${repo}/${branch}/SKILL.md`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (res.ok) {
        return { content: await res.text(), repo };
      }
    } catch {}
  }

  return { error: `Could not find SKILL.md in ${repo} (tried main and master branches)` };
}

// ── Install / uninstall ─────────────────────────────────────────────────────

/** Install a skill from a GitHub repo into the skills directory.
 *  Content must be pre-vetted — this does NOT run the vet check itself. */
export async function installSkill(
  repoOrUrl: string,
  skillsDir: string,
): Promise<{ success: boolean; name: string; error?: string }> {
  mkdirSync(skillsDir, { recursive: true });

  let repo = repoOrUrl;
  if (repo.startsWith('https://github.com/')) repo = repo.replace('https://github.com/', '').replace(/\/$/, '');
  if (repo.startsWith('github.com/')) repo = repo.replace('github.com/', '');

  const name = repo.split('/').pop() || repo;
  const skillDir = join(skillsDir, name);

  if (existsSync(skillDir)) {
    return { success: false, name, error: 'Skill already installed. Use update to refresh.' };
  }

  // Fetch SKILL.md
  const fetched = await fetchSkillContent(repo);
  if ('error' in fetched) {
    return { success: false, name, error: fetched.error };
  }

  // Security vet
  const vetResult = vetSkillContent(fetched.content);
  if (!vetResult.safe) {
    return {
      success: false,
      name,
      error: 'BLOCKED by security scan:\n' + formatVetResult(vetResult, fetched.content),
    };
  }

  // Also try to fetch any additional files listed in a manifest
  let additionalFiles: Record<string, string> = {};
  try {
    const manifestUrl = `https://raw.githubusercontent.com/${repo}/main/manifest.json`;
    const mRes = await fetch(manifestUrl, { signal: AbortSignal.timeout(5000) });
    if (mRes.ok) {
      const manifest = await mRes.json() as { files?: string[] };
      if (manifest.files) {
        const fetches = manifest.files
          .filter(f => f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.json'))
          .map(async (f) => {
            try {
              const fRes = await fetch(
                `https://raw.githubusercontent.com/${repo}/main/${f}`,
                { signal: AbortSignal.timeout(10000) }
              );
              if (fRes.ok) {
                const content = await fRes.text();
                // Vet additional files too
                const addVet = vetSkillContent(content);
                if (addVet.safe) {
                  additionalFiles[f] = content;
                }
              }
            } catch {}
          });
        await Promise.all(fetches);
      }
    }
  } catch {}

  // Write skill files
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), fetched.content);

  for (const [fname, content] of Object.entries(additionalFiles)) {
    const fpath = join(skillDir, fname);
    const fdir = join(fpath, '..');
    mkdirSync(fdir, { recursive: true });
    writeFileSync(fpath, content);
  }

  // Track installation
  const meta = loadInstalledMeta(skillsDir);
  meta.push({
    name,
    repo,
    version: 'latest',
    installedAt: new Date().toISOString(),
    source: 'clawhub',
  });
  saveInstalledMeta(skillsDir, meta);

  return { success: true, name };
}

export function uninstallSkill(name: string, skillsDir: string): { success: boolean; error?: string } {
  const skillDir = join(skillsDir, name);
  if (!existsSync(skillDir)) {
    return { success: false, error: `Skill '${name}' not found` };
  }
  rmSync(skillDir, { recursive: true, force: true });
  const meta = loadInstalledMeta(skillsDir);
  saveInstalledMeta(skillsDir, meta.filter(m => m.name !== name));
  return { success: true };
}

export async function updateSkill(name: string, skillsDir: string): Promise<{ success: boolean; error?: string }> {
  const meta = loadInstalledMeta(skillsDir);
  const entry = meta.find(m => m.name === name);
  if (!entry) {
    return { success: false, error: `Skill '${name}' was not installed from ClawHub` };
  }
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
  const updated: string[] = [];
  const failed: string[] = [];
  for (const entry of meta) {
    const result = await updateSkill(entry.name, skillsDir);
    if (result.success) updated.push(entry.name);
    else failed.push(entry.name);
  }
  return { updated, failed };
}

export function listInstalled(skillsDir: string): InstalledMeta[] {
  return loadInstalledMeta(skillsDir);
}

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
    name: 'clawhub_search',
    description: 'Search the ClawHub community skill registry for skills by name, description, or tag. Returns a list of available skills with their repo, author, and description.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (name, keyword, or tag)' },
      },
      required: ['query'],
    },
    async execute(params) {
      const query = params.query as string;
      const results = await searchSkills(query);
      if (results.length === 0) {
        return { output: `No skills found for "${query}". Try a different search term.` };
      }
      const lines = results.map(s =>
        `- ${s.name} (${s.repo}) by ${s.author}\n  ${s.description}\n  Tags: ${s.tags.join(', ') || 'none'}`
      );
      return { output: `Found ${results.length} skill(s):\n\n${lines.join('\n\n')}` };
    },
  },

  {
    name: 'clawhub_preview',
    description: 'Fetch and security-scan a skill from a GitHub repo WITHOUT installing it. Use this to review the skill content and verify it is safe before installing. Always preview before installing.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repo (e.g. "user/skill-name" or full URL)' },
      },
      required: ['repo'],
    },
    async execute(params) {
      const repo = params.repo as string;
      const fetched = await fetchSkillContent(repo);
      if ('error' in fetched) {
        return { output: '', error: fetched.error };
      }

      const vet = vetSkillContent(fetched.content);
      let output = `=== Skill from ${fetched.repo} ===\n\n`;
      output += `--- Security Scan ---\n${formatVetResult(vet, fetched.content)}\n`;
      output += `--- Content (${fetched.content.length} chars) ---\n${fetched.content.slice(0, 3000)}`;
      if (fetched.content.length > 3000) {
        output += `\n... (${fetched.content.length - 3000} more chars truncated)`;
      }

      return { output };
    },
  },

  {
    name: 'clawhub_install',
    description: 'Install a skill from a GitHub repo after it has been previewed and verified safe. The skill is security-scanned automatically — installation is blocked if high-severity issues are found. After install, the skill is hot-loaded immediately.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repo (e.g. "user/skill-name" or full URL)' },
      },
      required: ['repo'],
    },
    async execute(params) {
      if (!_skillsDir) {
        return { output: '', error: 'Skills directory not configured' };
      }
      const repo = params.repo as string;
      const result = await installSkill(repo, _skillsDir);
      if (!result.success) {
        return { output: '', error: result.error || 'Install failed' };
      }
      const reloadMsg = reloadSkills();
      return { output: `Installed and activated skill "${result.name}".\n${reloadMsg}` };
    },
  },

  {
    name: 'clawhub_uninstall',
    description: 'Uninstall a previously installed ClawHub skill by name. Removes it from disk and hot-reloads.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name to uninstall' },
      },
      required: ['name'],
    },
    async execute(params) {
      if (!_skillsDir) {
        return { output: '', error: 'Skills directory not configured' };
      }
      const name = params.name as string;
      const result = uninstallSkill(name, _skillsDir);
      if (!result.success) {
        return { output: '', error: result.error || 'Uninstall failed' };
      }
      const reloadMsg = reloadSkills();
      return { output: `Uninstalled skill "${name}".\n${reloadMsg}` };
    },
  },

  {
    name: 'clawhub_list',
    description: 'List all installed ClawHub skills with their source repo and install date.',
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute() {
      if (!_skillsDir) {
        return { output: '', error: 'Skills directory not configured' };
      }
      const installed = listInstalled(_skillsDir);
      if (installed.length === 0) {
        return { output: 'No ClawHub skills installed.' };
      }
      const lines = installed.map(s =>
        `- ${s.name} (from ${s.repo}, installed ${s.installedAt.split('T')[0]})`
      );
      return { output: `Installed ClawHub skills:\n${lines.join('\n')}` };
    },
  },
];

// ── CLI display helpers ─────────────────────────────────────────────────────

export function printSkillList(skills: ClawHubSkill[]): void {
  if (skills.length === 0) {
    console.log(chalk.dim('  No skills found.'));
    return;
  }
  for (const s of skills) {
    console.log(`  ${chalk.cyan.bold(s.name)} ${chalk.dim('by')} ${s.author} ${chalk.dim(`(${s.repo})`)}`);
    console.log(`    ${s.description}`);
    if (s.tags.length > 0) console.log(`    ${chalk.dim(s.tags.map(t => `#${t}`).join(' '))}`);
    console.log('');
  }
}

export function printInstalledList(skills: InstalledMeta[]): void {
  if (skills.length === 0) {
    console.log(chalk.dim('  No ClawHub skills installed.'));
    return;
  }
  for (const s of skills) {
    console.log(`  ${chalk.cyan(s.name)} ${chalk.dim(`from ${s.repo}`)} ${chalk.dim(`(installed ${s.installedAt.split('T')[0]})`)}`);
  }
}
