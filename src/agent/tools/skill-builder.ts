/**
 * Self-Building Skills — unified tool for creating, editing, reading,
 * deleting, and listing skills at runtime.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '../tool-registry.js';
import type { SkillsLoader } from '../../skills/loader.js';

let skillsDirRef: string = '';
let skillsLoaderRef: SkillsLoader | null = null;

export function setSkillBuilderConfig(skillsDir: string, loader: SkillsLoader): void {
  skillsDirRef = skillsDir;
  skillsLoaderRef = loader;
}

export const skillBuilderTools: Tool[] = [
  {
    name: 'skill',
    description: [
      'Manage agent skills (hot-reloadable SKILL.md files).',
      'Actions: create, edit, read, delete, list.',
      'create — create a new skill (immediately hot-loaded).',
      'edit — replace a skill\'s content (immediately hot-reloaded).',
      'read — read a skill\'s SKILL.md content.',
      'delete — delete a skill entirely.',
      'list — list all skills with descriptions and sizes.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: create|edit|read|delete|list',
        },
        name: {
          type: 'string',
          description: 'Skill name (lowercase-hyphenated e.g. "code-review", "daily-standup")',
        },
        content: {
          type: 'string',
          description: 'Full SKILL.md content (for create, edit)',
        },
      },
      required: ['action'],
    },
    async execute(params: Record<string, unknown>) {
      if (!skillsDirRef) return { output: '', error: 'Skills directory not configured' };
      const action = params.action as string;

      switch (action) {
        case 'create': {
          const name = (params.name as string).toLowerCase().replace(/[^a-z0-9-_]/g, '-');
          const content = params.content as string;
          if (!name || !content?.trim()) return { output: '', error: 'name and content are required for create' };

          const skillDir = join(skillsDirRef, name);
          const skillFile = join(skillDir, 'SKILL.md');
          if (existsSync(skillFile)) return { output: '', error: `Skill "${name}" already exists. Use edit action to modify.` };

          mkdirSync(skillDir, { recursive: true });
          writeFileSync(skillFile, content);
          if (skillsLoaderRef) skillsLoaderRef.loadAll();
          return { output: `Skill "${name}" created and loaded. It is now active in your system prompt.` };
        }

        case 'edit': {
          const name = params.name as string;
          const content = params.content as string;
          if (!name || !content) return { output: '', error: 'name and content are required for edit' };
          const skillFile = join(skillsDirRef, name, 'SKILL.md');
          if (!existsSync(skillFile)) return { output: '', error: `Skill "${name}" not found. Use create action.` };

          writeFileSync(skillFile, content);
          if (skillsLoaderRef) skillsLoaderRef.loadAll();
          return { output: `Skill "${name}" updated and reloaded.` };
        }

        case 'read': {
          const name = params.name as string;
          if (!name) return { output: '', error: 'name is required for read' };
          const skillFile = join(skillsDirRef, name, 'SKILL.md');
          if (!existsSync(skillFile)) return { output: '', error: `Skill "${name}" not found.` };
          return { output: readFileSync(skillFile, 'utf-8') };
        }

        case 'delete': {
          const name = params.name as string;
          if (!name) return { output: '', error: 'name is required for delete' };
          const skillDir = join(skillsDirRef, name);
          if (!existsSync(skillDir)) return { output: '', error: `Skill "${name}" not found.` };

          rmSync(skillDir, { recursive: true, force: true });
          if (skillsLoaderRef) skillsLoaderRef.loadAll();
          return { output: `Skill "${name}" deleted and unloaded.` };
        }

        case 'list': {
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
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: create, edit, read, delete, list` };
      }
    },
  },
];
