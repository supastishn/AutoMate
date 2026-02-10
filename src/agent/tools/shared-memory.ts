/**
 * Shared Memory — unified tool for reading/writing to a shared memory space
 * accessible by all agents in a multi-agent setup.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '../tool-registry.js';

let sharedDirRef: string = '';

export function setSharedMemoryDir(dir: string): void {
  sharedDirRef = dir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function listKeys(): string {
  if (!existsSync(sharedDirRef)) return '';
  return readdirSync(sharedDirRef)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''))
    .join(', ');
}

export const sharedMemoryTools: Tool[] = [
  {
    name: 'shared_memory',
    description: [
      'Manage shared memory accessible by all agents.',
      'Actions: read, write, append, list, delete.',
      'Use for inter-agent coordination, shared state, and knowledge transfer.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: read|write|append|list|delete',
        },
        key: { type: 'string', description: 'Key/filename (e.g. "project-status", "shared-notes")' },
        content: { type: 'string', description: 'Content to write (for write action)' },
        entry: { type: 'string', description: 'Text to append (for append action)' },
      },
      required: ['action'],
    },
    async execute(params) {
      if (!sharedDirRef) return { output: '', error: 'Shared memory not configured' };
      const action = params.action as string;

      switch (action) {
        case 'read': {
          const key = sanitizeKey(params.key as string);
          const path = join(sharedDirRef, `${key}.md`);
          if (!existsSync(path)) return { output: `Shared key "${key}" not found. Available keys: ${listKeys()}` };
          return { output: readFileSync(path, 'utf-8') };
        }

        case 'write': {
          const key = sanitizeKey(params.key as string);
          const content = params.content as string;
          if (!content) return { output: '', error: 'Content is required for write action' };
          writeFileSync(join(sharedDirRef, `${key}.md`), content);
          return { output: `Shared memory "${key}" written (${content.length} chars). All agents can now read this.` };
        }

        case 'append': {
          const key = sanitizeKey(params.key as string);
          const entry = params.entry as string;
          if (!entry) return { output: '', error: 'Entry is required for append action' };
          const path = join(sharedDirRef, `${key}.md`);
          const timestamp = new Date().toISOString();
          appendFileSync(path, `\n## ${timestamp}\n${entry}\n`);
          return { output: `Appended to shared memory "${key}" (${entry.length} chars).` };
        }

        case 'list': {
          if (!existsSync(sharedDirRef)) return { output: 'Shared memory directory does not exist.' };
          const files = readdirSync(sharedDirRef).filter(f => f.endsWith('.md'));
          if (files.length === 0) return { output: 'Shared memory is empty.' };
          const lines = files.map(f => {
            const stat = statSync(join(sharedDirRef, f));
            return `  ${f.replace('.md', '')} — ${stat.size} bytes, modified ${stat.mtime.toISOString().split('T')[0]}`;
          });
          return { output: `Shared memory keys (${files.length}):\n${lines.join('\n')}` };
        }

        case 'delete': {
          const key = sanitizeKey(params.key as string);
          const path = join(sharedDirRef, `${key}.md`);
          if (!existsSync(path)) return { output: `Key "${key}" not found.` };
          unlinkSync(path);
          return { output: `Shared memory "${key}" deleted.` };
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: read, write, append, list, delete` };
      }
    },
  },
];
