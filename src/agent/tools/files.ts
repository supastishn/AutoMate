import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Tool } from '../tool-registry.js';

/**
 * Generate a short content hash for a line (2-3 chars).
 * Uses first 2 chars of base36-encoded MD5 for uniqueness within a file.
 */
function lineHash(content: string): string {
  const hash = createHash('md5').update(content).digest();
  // Take first 2 bytes, convert to base36 for compact representation
  const num = (hash[0] << 8) | hash[1];
  return num.toString(36).padStart(3, '0').slice(0, 2);
}

/**
 * Format a line with hashline format: "lineNum:hash|content"
 */
function formatHashline(lineNum: number, content: string): string {
  const hash = lineHash(content);
  return `${lineNum}:${hash}|${content}`;
}

export const readFileTool: Tool = {
  name: 'read_file',
  description: `Read the contents of a file. Returns lines in hashline format: "lineNum:hash|content".
The hash is a 2-char content identifier. Use these line:hash references with hashline_edit for precise edits.
Example output:
  1:a3|function hello() {
  2:f1|  return "world";
  3:0e|}`,
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
      // Format with hashline: "lineNum:hash|content"
      const numbered = slice.map((line, i) => formatHashline(offset + i + 1, line)).join('\n');
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

/**
 * Parse a line:hash reference like "5:a3" into { line: 5, hash: 'a3' }
 */
function parseLineRef(ref: string): { line: number; hash: string } | null {
  const match = ref.match(/^(\d+):([a-z0-9]{2})$/i);
  if (!match) return null;
  return { line: parseInt(match[1]), hash: match[2].toLowerCase() };
}

export const hashlineEditTool: Tool = {
  name: 'hashline_edit',
  description: `Edit a file using line:hash references from read_file output.
This is more reliable than string matching - the hash verifies you're editing the right line.

Operations:
- replace: Replace a single line or range of lines
- insert_after: Insert new lines after a specific line
- insert_before: Insert new lines before a specific line  
- delete: Delete a single line or range of lines

Line references use format "lineNum:hash" (e.g., "5:a3") from read_file output.
If the hash doesn't match the current line content, the edit is rejected (file changed).

Example: To replace lines 5-7, use start_ref="5:a3" end_ref="7:f1" new_content="replacement"`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      operation: { 
        type: 'string', 
        enum: ['replace', 'insert_after', 'insert_before', 'delete'],
        description: 'Edit operation type'
      },
      start_ref: { type: 'string', description: 'Line reference "lineNum:hash" (e.g., "5:a3")' },
      end_ref: { type: 'string', description: 'End line reference for range operations (optional, defaults to start_ref)' },
      new_content: { type: 'string', description: 'New content (for replace/insert operations). Can be multiple lines.' },
    },
    required: ['path', 'operation', 'start_ref'],
  },
  async execute(params, ctx) {
    const filePath = resolve(ctx.workdir, params.path as string);
    if (!existsSync(filePath)) {
      return { output: '', error: `File not found: ${filePath}` };
    }

    const operation = params.operation as string;
    const startRefStr = params.start_ref as string;
    const endRefStr = (params.end_ref as string) || startRefStr;
    const newContent = params.new_content as string | undefined;

    const startRef = parseLineRef(startRefStr);
    const endRef = parseLineRef(endRefStr);

    if (!startRef) {
      return { output: '', error: `Invalid start_ref format: "${startRefStr}". Expected "lineNum:hash" (e.g., "5:a3")` };
    }
    if (!endRef) {
      return { output: '', error: `Invalid end_ref format: "${endRefStr}". Expected "lineNum:hash" (e.g., "7:f1")` };
    }
    if (endRef.line < startRef.line) {
      return { output: '', error: `end_ref line (${endRef.line}) cannot be before start_ref line (${startRef.line})` };
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      // Validate line numbers
      if (startRef.line < 1 || startRef.line > lines.length) {
        return { output: '', error: `start_ref line ${startRef.line} out of range (file has ${lines.length} lines)` };
      }
      if (endRef.line < 1 || endRef.line > lines.length) {
        return { output: '', error: `end_ref line ${endRef.line} out of range (file has ${lines.length} lines)` };
      }

      // Validate hashes - this is the key safety check!
      const startLineContent = lines[startRef.line - 1];
      const endLineContent = lines[endRef.line - 1];
      const actualStartHash = lineHash(startLineContent);
      const actualEndHash = lineHash(endLineContent);

      if (actualStartHash !== startRef.hash) {
        return { 
          output: '', 
          error: `Hash mismatch at line ${startRef.line}: expected "${startRef.hash}" but found "${actualStartHash}". File may have changed - re-read it first.` 
        };
      }
      if (actualEndHash !== endRef.hash) {
        return { 
          output: '', 
          error: `Hash mismatch at line ${endRef.line}: expected "${endRef.hash}" but found "${actualEndHash}". File may have changed - re-read it first.` 
        };
      }

      // Perform the operation
      let result: string[];
      const startIdx = startRef.line - 1;
      const endIdx = endRef.line - 1;

      switch (operation) {
        case 'replace': {
          if (newContent === undefined) {
            return { output: '', error: 'new_content is required for replace operation' };
          }
          const newLines = newContent.split('\n');
          result = [
            ...lines.slice(0, startIdx),
            ...newLines,
            ...lines.slice(endIdx + 1),
          ];
          break;
        }
        case 'insert_after': {
          if (newContent === undefined) {
            return { output: '', error: 'new_content is required for insert_after operation' };
          }
          const newLines = newContent.split('\n');
          result = [
            ...lines.slice(0, endIdx + 1),
            ...newLines,
            ...lines.slice(endIdx + 1),
          ];
          break;
        }
        case 'insert_before': {
          if (newContent === undefined) {
            return { output: '', error: 'new_content is required for insert_before operation' };
          }
          const newLines = newContent.split('\n');
          result = [
            ...lines.slice(0, startIdx),
            ...newLines,
            ...lines.slice(startIdx),
          ];
          break;
        }
        case 'delete': {
          result = [
            ...lines.slice(0, startIdx),
            ...lines.slice(endIdx + 1),
          ];
          break;
        }
        default:
          return { output: '', error: `Unknown operation: ${operation}` };
      }

      writeFileSync(filePath, result.join('\n'));

      const linesAffected = endIdx - startIdx + 1;
      const newLinesCount = newContent ? newContent.split('\n').length : 0;
      
      let summary = '';
      switch (operation) {
        case 'replace':
          summary = `Replaced ${linesAffected} line(s) with ${newLinesCount} line(s)`;
          break;
        case 'insert_after':
          summary = `Inserted ${newLinesCount} line(s) after line ${endRef.line}`;
          break;
        case 'insert_before':
          summary = `Inserted ${newLinesCount} line(s) before line ${startRef.line}`;
          break;
        case 'delete':
          summary = `Deleted ${linesAffected} line(s)`;
          break;
      }

      return { output: `${summary} in ${filePath}` };
    } catch (err) {
      return { output: '', error: `Failed to edit: ${err}` };
    }
  },
};
