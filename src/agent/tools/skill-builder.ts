/**
 * Self-Building Skills — tools that let the agent create, edit, and manage
 * its own skills at runtime. Skills are SKILL.md files in directories.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '../tool-registry.js';
import type { SkillsLoader } from '../../skills/loader.js';

let skillsDirRef: string = '';
let skillsLoaderRef: SkillsLoader | null = null;

export function setSkillBuilderConfig(skillsDir: string, loader: SkillsLoader): void {
  skillsDirRef = skillsDir;
  skillsLoaderRef = loader;
}

export const skillCreateTool: Tool = {
  name: 'skill_create',
  description: 'Create a new skill by writing a SKILL.md file. The skill will be immediately hot-loaded into your active capabilities. Skills inject instructions into your system prompt — use them to teach yourself new behaviors, workflows, or knowledge.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill name (used as directory name, lowercase-hyphenated e.g. "code-review", "daily-standup")',
      },
      content: {
        type: 'string',
        description: 'Full SKILL.md content (markdown). Include a # Title, description, and instructions for yourself.',
      },
    },
    required: ['name', 'content'],
  },
  async execute(params: Record<string, unknown>) {
    if (!skillsDirRef) return { output: '', error: 'Skills directory not configured' };

    const name = (params.name as string).toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    const content = params.content as string;

    if (!content.trim()) {
      return { output: '', error: 'Content cannot be empty' };
    }

    const skillDir = join(skillsDirRef, name);
    const skillFile = join(skillDir, 'SKILL.md');

    // Check if skill already exists
    if (existsSync(skillFile)) {
      return { output: '', error: `Skill "${name}" already exists. Use skill_edit to modify it.` };
    }

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, content);

    // Hot-reload skills
    if (skillsLoaderRef) {
      skillsLoaderRef.loadAll();
    }

    return { output: `Skill "${name}" created and loaded. It is now active in your system prompt.` };
  },
};

export const skillEditTool: Tool = {
  name: 'skill_edit',
  description: 'Edit an existing skill\'s SKILL.md content. Changes take effect immediately via hot-reload.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name (directory name)' },
      content: { type: 'string', description: 'New full SKILL.md content (replaces existing)' },
    },
    required: ['name', 'content'],
  },
  async execute(params: Record<string, unknown>) {
    if (!skillsDirRef) return { output: '', error: 'Skills directory not configured' };

    const name = params.name as string;
    const content = params.content as string;
    const skillFile = join(skillsDirRef, name, 'SKILL.md');

    if (!existsSync(skillFile)) {
      return { output: '', error: `Skill "${name}" not found. Use skill_create to make a new one.` };
    }

    writeFileSync(skillFile, content);

    if (skillsLoaderRef) {
      skillsLoaderRef.loadAll();
    }

    return { output: `Skill "${name}" updated and reloaded.` };
  },
};

export const skillReadTool: Tool = {
  name: 'skill_read',
  description: 'Read the SKILL.md content of an existing skill.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name to read' },
    },
    required: ['name'],
  },
  async execute(params: Record<string, unknown>) {
    if (!skillsDirRef) return { output: '', error: 'Skills directory not configured' };

    const name = params.name as string;
    const skillFile = join(skillsDirRef, name, 'SKILL.md');

    if (!existsSync(skillFile)) {
      return { output: '', error: `Skill "${name}" not found.` };
    }

    const content = readFileSync(skillFile, 'utf-8');
    return { output: content };
  },
};

export const skillDeleteTool: Tool = {
  name: 'skill_delete',
  description: 'Delete a skill entirely. Removes the skill directory and all its files. The skill will be immediately unloaded.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name to delete' },
    },
    required: ['name'],
  },
  async execute(params: Record<string, unknown>) {
    if (!skillsDirRef) return { output: '', error: 'Skills directory not configured' };

    const name = params.name as string;
    const skillDir = join(skillsDirRef, name);

    if (!existsSync(skillDir)) {
      return { output: '', error: `Skill "${name}" not found.` };
    }

    rmSync(skillDir, { recursive: true, force: true });

    if (skillsLoaderRef) {
      skillsLoaderRef.loadAll();
    }

    return { output: `Skill "${name}" deleted and unloaded.` };
  },
};

export const skillListTool: Tool = {
  name: 'skill_list',
  description: 'List all skills with their names, descriptions, and content sizes.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    if (!skillsDirRef) return { output: '', error: 'Skills directory not configured' };
    if (!existsSync(skillsDirRef)) return { output: 'No skills directory found.' };

    const dirs = readdirSync(skillsDirRef, { withFileTypes: true }).filter(d => d.isDirectory());
    if (dirs.length === 0) return { output: 'No skills installed.' };

    const lines: string[] = [];
    for (const dir of dirs) {
      const skillFile = join(skillsDirRef, dir.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const content = readFileSync(skillFile, 'utf-8');
      const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('---'))?.replace(/^#+\s*/, '') || dir.name;
      lines.push(`  ${dir.name} — ${firstLine.slice(0, 80)} (${content.length} chars)`);
    }

    return { output: `Skills (${lines.length}):\n${lines.join('\n')}` };
  },
};

export const skillBuilderTools = [
  skillCreateTool,
  skillEditTool,
  skillReadTool,
  skillDeleteTool,
  skillListTool,
];
