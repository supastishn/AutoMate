import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

  constructor(config: Config) {
    this.config = config;
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
