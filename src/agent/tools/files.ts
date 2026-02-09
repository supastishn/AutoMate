import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Tool } from '../tool-registry.js';

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file. Returns the file content with line numbers.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
      offset: { type: 'number', description: 'Starting line (0-based)' },
      limit: { type: 'number', description: 'Number of lines to read' },
    },
    required: ['path'],
  },
  async execute(params, ctx) {
    const filePath = resolve(ctx.workdir, params.path as string);
    if (!existsSync(filePath)) {
      return { output: '', error: `File not found: ${filePath}` };
    }
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const offset = (params.offset as number) || 0;
      const limit = (params.limit as number) || lines.length;
      const slice = lines.slice(offset, offset + limit);
      const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
      return { output: numbered || '(empty file)' };
    } catch (err) {
      return { output: '', error: `Failed to read: ${err}` };
    }
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file. Creates the file and parent directories if they do not exist.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write to' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(params, ctx) {
    const filePath = resolve(ctx.workdir, params.path as string);
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, params.content as string);
      return { output: `Written to ${filePath}` };
    } catch (err) {
      return { output: '', error: `Failed to write: ${err}` };
    }
  },
};

export const applyPatchTool: Tool = {
  name: 'apply_patch',
  description: 'Apply a unified diff patch to a file. More efficient than edit_file for large multi-line changes.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to patch' },
      patch: { type: 'string', description: 'Unified diff patch content' },
    },
    required: ['path', 'patch'],
  },
  async execute(params, ctx) {
    const filePath = resolve(ctx.workdir, params.path as string);
    if (!existsSync(filePath)) {
      return { output: '', error: `File not found: ${filePath}` };
    }
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const patchLines = (params.patch as string).split('\n');

      let lineIndex = 0;
      const result: string[] = [...lines];
      let offset = 0;

      for (let i = 0; i < patchLines.length; i++) {
        const line = patchLines[i];
        // Parse hunk header: @@ -start,count +start,count @@
        const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          lineIndex = parseInt(hunkMatch[1]) - 1 + offset;
          continue;
        }
        if (line.startsWith('---') || line.startsWith('+++')) continue;
        if (line.startsWith('-')) {
          // Remove line
          const expected = line.slice(1);
          if (result[lineIndex] === expected) {
            result.splice(lineIndex, 1);
            offset--;
          } else {
            lineIndex++;
          }
        } else if (line.startsWith('+')) {
          // Add line
          result.splice(lineIndex, 0, line.slice(1));
          lineIndex++;
          offset++;
        } else if (line.startsWith(' ') || line === '') {
          // Context line
          lineIndex++;
        }
      }

      writeFileSync(filePath, result.join('\n'));
      return { output: `Patched ${filePath}` };
    } catch (err) {
      return { output: '', error: `Failed to apply patch: ${err}` };
    }
  },
};

export const editFileTool: Tool = {
  name: 'edit_file',
  description: 'Edit a file by replacing an exact string match with new content.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old_string: { type: 'string', description: 'Exact string to find and replace' },
      new_string: { type: 'string', description: 'Replacement string' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(params, ctx) {
    const filePath = resolve(ctx.workdir, params.path as string);
    if (!existsSync(filePath)) {
      return { output: '', error: `File not found: ${filePath}` };
    }
    try {
      let content = readFileSync(filePath, 'utf-8');
      const oldStr = params.old_string as string;
      const newStr = params.new_string as string;
      const replaceAll = params.replace_all as boolean;

      if (!content.includes(oldStr)) {
        return { output: '', error: 'old_string not found in file' };
      }

      if (replaceAll) {
        content = content.replaceAll(oldStr, newStr);
      } else {
        content = content.replace(oldStr, newStr);
      }

      writeFileSync(filePath, content);
      return { output: `Edited ${filePath}` };
    } catch (err) {
      return { output: '', error: `Failed to edit: ${err}` };
    }
  },
};
