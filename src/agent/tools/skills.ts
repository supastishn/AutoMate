/**
 * Skill Tool — list and load skills on demand.
 * Skills are NOT loaded by default; the AI must explicitly load them.
 */

import type { Tool } from '../tool-registry.js';
import type { SkillsLoader, Skill } from '../../skills/loader.js';

let skillsLoader: SkillsLoader | null = null;

// Per-session loaded skills
const sessionSkills: Map<string, Set<string>> = new Map();

export function setSkillsLoader(loader: SkillsLoader): void {
  skillsLoader = loader;
}

/** Get skills loaded for a specific session */
export function getSessionSkills(sessionId: string): Skill[] {
  if (!skillsLoader) return [];
  const loaded = sessionSkills.get(sessionId);
  if (!loaded || loaded.size === 0) return [];

  const allSkills = skillsLoader.listSkills();
  return allSkills.filter(s => loaded.has(s.name));
}

/** Get system prompt injection for a session's loaded skills only */
export function getSessionSkillsInjection(sessionId: string): string {
  const skills = getSessionSkills(sessionId);
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

  return '\n\n# Loaded Skills\n\n' + sections.join('\n\n---\n\n');
}

/** Clear session skills (on session reset) */
export function clearSessionSkills(sessionId: string): void {
  sessionSkills.delete(sessionId);
}

export const skillTools: Tool[] = [
  {
    name: 'skill',
    description: [
      'List available skills or load/unload a skill for this session.',
      'Skills provide specialized instructions and context for specific tasks.',
      '',
      'Actions:',
      '  list — show all available skills with descriptions',
      '  load <name> — load a skill into this session',
      '  unload <name> — unload a skill from this session',
      '  show <name> — show the full content of a skill',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: list, load, unload, or show',
          enum: ['list', 'load', 'unload', 'show'],
        },
        name: {
          type: 'string',
          description: 'Skill name (for load/unload/show)',
        },
      },
      required: ['action'],
    },
    async execute(params, ctx) {
      if (!skillsLoader) {
        return { output: '', error: 'Skills system not available' };
      }

      const action = params.action as string;
      const name = params.name as string;
      const sessionId = ctx?.sessionId || 'default';

      // Ensure session has a skill set
      if (!sessionSkills.has(sessionId)) {
        sessionSkills.set(sessionId, new Set());
      }
      const loaded = sessionSkills.get(sessionId)!;

      switch (action) {
        case 'list': {
          skillsLoader.reloadIfChanged();
          const all = skillsLoader.listSkills();
          const skipped = skillsLoader.listSkippedSkills();

          if (all.length === 0 && skipped.length === 0) {
            return { output: 'No skills available.' };
          }

          const lines: string[] = ['Available skills:\n'];

          for (const skill of all) {
            const isLoaded = loaded.has(skill.name);
            const icon = isLoaded ? '✓' : '○';
            const emoji = skill.metadata?.emoji || '';
            lines.push(`${icon} ${emoji} ${skill.name} — ${skill.description.slice(0, 100)}`);
          }

          if (skipped.length > 0) {
            lines.push('\nUnavailable (missing dependencies):');
            for (const skill of skipped) {
              const emoji = skill.metadata?.emoji || '';
              const reason = skill.gatingResult?.missingBins?.join(', ') || 'requirements not met';
              lines.push(`  ✗ ${emoji} ${skill.name} — needs: ${reason}`);
            }
          }

          lines.push(`\nLoaded: ${loaded.size}/${all.length}`);
          lines.push('Use skill action=load name="skill-name" to load a skill.');

          return { output: lines.join('\n') };
        }

        case 'load': {
          if (!name) {
            return { output: '', error: 'Need name parameter to load a skill' };
          }

          skillsLoader.reloadIfChanged();
          const skill = skillsLoader.getSkill(name);

          if (!skill) {
            // Check if it's in skipped
            const skipped = skillsLoader.listSkippedSkills();
            const skippedSkill = skipped.find(s => s.name === name);
            if (skippedSkill) {
              const reason = skippedSkill.gatingResult?.missingBins?.join(', ') || 'requirements not met';
              return { output: '', error: `Skill "${name}" is unavailable: ${reason}` };
            }
            return { output: '', error: `Skill "${name}" not found. Use skill action=list to see available skills.` };
          }

          if (loaded.has(name)) {
            return { output: `Skill "${name}" is already loaded.` };
          }

          loaded.add(name);
          return { output: `Skill "${name}" loaded. ${skill.description}` };
        }

        case 'unload': {
          if (!name) {
            return { output: '', error: 'Need name parameter to unload a skill' };
          }

          if (!loaded.has(name)) {
            return { output: `Skill "${name}" is not loaded.` };
          }

          loaded.delete(name);
          return { output: `Skill "${name}" unloaded.` };
        }

        case 'show': {
          if (!name) {
            return { output: '', error: 'Need name parameter to show a skill' };
          }

          skillsLoader.reloadIfChanged();
          const skill = skillsLoader.getSkill(name);

          if (!skill) {
            return { output: '', error: `Skill "${name}" not found.` };
          }

          let output = `# Skill: ${skill.name}\n\n`;
          output += `Description: ${skill.description}\n\n`;
          output += `---\n\n${skill.content}`;

          if (skill.references.length > 0) {
            output += '\n\n---\nReferences:\n\n' + skill.references.join('\n\n');
          }

          return { output };
        }

        default:
          return { output: '', error: `Unknown action "${action}". Use: list, load, unload, show` };
      }
    },
  },
];
