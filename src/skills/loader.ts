import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { Config } from '../config/schema.js';
import type { Tool } from '../agent/tool-registry.js';

export interface Skill {
  name: string;
  description: string;
  content: string;  // SKILL.md content injected into system prompt
  tools?: Tool[];
  directory: string;
}

export class SkillsLoader {
  private skills: Map<string, Skill> = new Map();
  private config: Config;
  private watcher: FSWatcher | null = null;
  private _changed = false;

  constructor(config: Config) {
    this.config = config;
  }

  // Start watching skills directory for changes
  startWatching(): void {
    const skillsDir = this.config.skills.directory;
    if (!existsSync(skillsDir)) return;

    try {
      this.watcher = watch(skillsDir, { recursive: true }, (_eventType, filename) => {
        if (filename && filename.endsWith('.md')) {
          this._changed = true;
        }
      });
    } catch {
      // recursive watch not supported on all platforms
    }
  }

  // Check if skills changed, reload if so. Called before each agent turn.
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

  loadAll(): Skill[] {
    this.skills.clear();
    const skillsDir = this.config.skills.directory;

    if (!existsSync(skillsDir)) return [];

    const dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of dirs) {
      const skillDir = join(skillsDir, dir.name);
      const skillFile = join(skillDir, 'SKILL.md');

      if (!existsSync(skillFile)) continue;

      const content = readFileSync(skillFile, 'utf-8');

      // Parse YAML frontmatter for gating
      const gating = this.parseGating(content);
      if (gating && !this.checkGating(gating)) {
        continue; // skip this skill
      }

      const description = this.extractDescription(content);

      const skill: Skill = {
        name: dir.name,
        description,
        content,
        directory: skillDir,
      };

      this.skills.set(dir.name, skill);
    }

    return Array.from(this.skills.values());
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  getSystemPromptInjection(): string {
    const skills = this.listSkills();
    if (skills.length === 0) return '';

    const sections = skills.map(s => 
      `## Skill: ${s.name}\n${s.content}`
    );

    return '\n\n# Active Skills\n\n' + sections.join('\n\n---\n\n');
  }

  private parseGating(content: string): Record<string, any> | null {
    if (!content.startsWith('---')) return null;
    const endIdx = content.indexOf('---', 3);
    if (endIdx === -1) return null;
    const frontmatter = content.slice(3, endIdx).trim();
    // Simple YAML-like parsing for key: value pairs
    const result: Record<string, any> = {};
    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      result[key] = value;
    }
    return result.requires_bins || result.requires_env || result.os ? result : null;
  }

  private checkGating(gating: Record<string, any>): boolean {
    // Check required binaries
    if (gating.requires_bins) {
      const bins = gating.requires_bins.split(',').map((b: string) => b.trim());
      for (const bin of bins) {
        try {
          execSync(`which ${bin}`, { stdio: 'ignore' });
        } catch {
          return false;
        }
      }
    }

    // Check required env vars
    if (gating.requires_env) {
      const vars = gating.requires_env.split(',').map((v: string) => v.trim());
      for (const v of vars) {
        if (!process.env[v]) return false;
      }
    }

    // Check OS
    if (gating.os) {
      const allowed = gating.os.split(',').map((o: string) => o.trim());
      if (!allowed.includes(process.platform)) return false;
    }

    return true;
  }

  private extractDescription(content: string): string {
    // Try to get the first paragraph after the title
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
