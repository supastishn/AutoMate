/**
 * Shared Memory — tools for reading/writing to a shared memory space
 * accessible by all agents in a multi-agent setup. Useful for
 * inter-agent coordination, shared state, and knowledge transfer.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '../tool-registry.js';

let sharedDirRef: string = '';

export function setSharedMemoryDir(dir: string): void {
  sharedDirRef = dir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export const sharedMemoryReadTool: Tool = {
  name: 'shared_memory_read',
  description: 'Read a file from shared memory (accessible by all agents). Use for reading state, notes, or data shared between agents.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Key/filename to read (e.g. "project-status", "shared-notes")' },
    },
    required: ['key'],
  },
  async execute(params) {
    if (!sharedDirRef) return { output: '', error: 'Shared memory not configured' };
    const key = (params.key as string).replace(/[^a-zA-Z0-9._-]/g, '-');
    const path = join(sharedDirRef, `${key}.md`);
    if (!existsSync(path)) return { output: `Shared key "${key}" not found. Available keys: ${listKeys()}` };
    return { output: readFileSync(path, 'utf-8') };
  },
};

export const sharedMemoryWriteTool: Tool = {
  name: 'shared_memory_write',
  description: 'Write to shared memory (accessible by all agents). Overwrites existing content for this key.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Key/filename to write (e.g. "project-status")' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['key', 'content'],
  },
  async execute(params) {
    if (!sharedDirRef) return { output: '', error: 'Shared memory not configured' };
    const key = (params.key as string).replace(/[^a-zA-Z0-9._-]/g, '-');
    const content = params.content as string;
    writeFileSync(join(sharedDirRef, `${key}.md`), content);
    return { output: `Shared memory "${key}" written (${content.length} chars). All agents can now read this.` };
  },
};

export const sharedMemoryAppendTool: Tool = {
  name: 'shared_memory_append',
  description: 'Append to a shared memory key without overwriting. Good for logs, event streams, or collaborative notes.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Key/filename to append to' },
      entry: { type: 'string', description: 'Text to append' },
    },
    required: ['key', 'entry'],
  },
  async execute(params) {
    if (!sharedDirRef) return { output: '', error: 'Shared memory not configured' };
    const key = (params.key as string).replace(/[^a-zA-Z0-9._-]/g, '-');
    const entry = params.entry as string;
    const path = join(sharedDirRef, `${key}.md`);
    const timestamp = new Date().toISOString();
    appendFileSync(path, `\n## ${timestamp}\n${entry}\n`);
    return { output: `Appended to shared memory "${key}" (${entry.length} chars).` };
  },
};

export const sharedMemoryListTool: Tool = {
  name: 'shared_memory_list',
  description: 'List all keys in shared memory with sizes.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    if (!sharedDirRef) return { output: '', error: 'Shared memory not configured' };
    const keys = listKeys();
    if (!keys) return { output: 'Shared memory is empty.' };
    if (!existsSync(sharedDirRef)) return { output: 'Shared memory directory does not exist.' };
    const files = readdirSync(sharedDirRef).filter(f => f.endsWith('.md'));
    if (files.length === 0) return { output: 'Shared memory is empty.' };
    const lines = files.map(f => {
      const stat = statSync(join(sharedDirRef, f));
      return `  ${f.replace('.md', '')} — ${stat.size} bytes, modified ${stat.mtime.toISOString().split('T')[0]}`;
    });
    return { output: `Shared memory keys (${files.length}):\n${lines.join('\n')}` };
  },
};

export const sharedMemoryDeleteTool: Tool = {
  name: 'shared_memory_delete',
  description: 'Delete a key from shared memory.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Key to delete' },
    },
    required: ['key'],
  },
  async execute(params) {
    if (!sharedDirRef) return { output: '', error: 'Shared memory not configured' };
    const key = (params.key as string).replace(/[^a-zA-Z0-9._-]/g, '-');
    const path = join(sharedDirRef, `${key}.md`);
    if (!existsSync(path)) return { output: `Key "${key}" not found.` };
    const { unlinkSync } = await import('node:fs');
    unlinkSync(path);
    return { output: `Shared memory "${key}" deleted.` };
  },
};

function listKeys(): string {
  if (!existsSync(sharedDirRef)) return '';
  return readdirSync(sharedDirRef)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''))
    .join(', ');
}

export const sharedMemoryTools = [
  sharedMemoryReadTool,
  sharedMemoryWriteTool,
  sharedMemoryAppendTool,
  sharedMemoryListTool,
  sharedMemoryDeleteTool,
];
