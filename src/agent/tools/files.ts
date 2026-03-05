import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { dirname, resolve, basename, relative } from 'node:path';
import type { Tool } from '../tool-registry.js';
import { getCurrentConfig } from '../../config/loader.js';

// ═══════════════════════════════════════════════════════════════════════════════
// READ FILE TOOL
// ═══════════════════════════════════════════════════════════════════════════════

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read file contents with line numbers. Use offset/limit for partial reads.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
      offset: { type: 'number', description: 'Starting line number (1-based)' },
      limit: { type: 'number', description: 'Maximum number of lines to read' },
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
      
      // Check if pagination is disabled via config
      const config = getCurrentConfig();
      const disablePagination = config?.tools?.disableFilePagination ?? false;
      
      // 1-based line numbers, offset is also 1-based for consistency
      const startLine = disablePagination ? 1 : Math.max(1, (params.offset as number) || 1);
      const limit = disablePagination ? lines.length : ((params.limit as number) || lines.length);
      
      const startIdx = startLine - 1;
      const endIdx = Math.min(startIdx + limit, lines.length);
      
      const result: string[] = [];
      for (let i = startIdx; i < endIdx; i++) {
        const lineNum = (i + 1).toString().padStart(6, ' ');
        result.push(`${lineNum}\t${lines[i]}`);
      }
      
      if (result.length === 0) {
        return { output: '(empty file)' };
      }
      
      // Add file info header
      const header = `File: ${filePath} (${lines.length} lines)\n${'─'.repeat(50)}`;
      return { output: `${header}\n${result.join('\n')}` };
    } catch (err) {
      return { output: '', error: `Failed to read: ${err}` };
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// WRITE FILE TOOL
// ═══════════════════════════════════════════════════════════════════════════════

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file. Creates parent directories if needed. WARNING: Overwrites existing files.',
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
      const lines = (params.content as string).split('\n').length;
      return { output: `Wrote ${lines} line(s) to ${filePath}` };
    } catch (err) {
      return { output: '', error: `Failed to write: ${err}` };
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// EDIT TOOL (Search & Replace)
// ═══════════════════════════════════════════════════════════════════════════════

export const editFileTool: Tool = {
  name: 'edit',
  description: 'Edit a file by replacing exact text matches. old_string must match exactly (including whitespace). Use replace_all for multiple occurrences.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit' },
      old_string: { type: 'string', description: 'Exact text to find and replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(params, ctx) {
    const filePath = resolve(ctx.workdir, params.path as string);
    if (!existsSync(filePath)) {
      return { output: '', error: `File not found: ${filePath}` };
    }

    const oldString = params.old_string as string;
    const newString = params.new_string as string;
    const replaceAll = params.replace_all as boolean;

    if (oldString === '') {
      return { output: '', error: 'old_string cannot be empty' };
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      
      // Count occurrences
      let count = 0;
      let searchPos = 0;
      while (true) {
        const idx = content.indexOf(oldString, searchPos);
        if (idx === -1) break;
        count++;
        searchPos = idx + 1;
        if (!replaceAll) break;
      }

      if (count === 0) {
        return { output: '', error: `Text not found in file. Make sure old_string matches exactly (including whitespace).\nSearched for:\n---\n${oldString}\n---` };
      }

      if (count > 1 && !replaceAll) {
        return { output: '', error: `Found ${count} occurrences. Use replace_all: true to replace all, or provide a more specific old_string with more context.` };
      }

      // Perform replacement
      const newContent = replaceAll 
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);
      
      writeFileSync(filePath, newContent);
      
      const linesDiff = newContent.split('\n').length - content.split('\n').length;
      const linesChanged = Math.abs(linesDiff);
      
      return { 
        output: `Replaced ${count} occurrence(s) in ${filePath}${linesDiff !== 0 ? ` (${linesDiff > 0 ? '+' : ''}${linesDiff} lines)` : ''}` 
      };
    } catch (err) {
      return { output: '', error: `Failed to edit: ${err}` };
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// APPLY PATCH TOOL
// ═══════════════════════════════════════════════════════════════════════════════

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ADD_FILE = '*** Add File: ';
const UPDATE_FILE = '*** Update File: ';
const DELETE_FILE = '*** Delete File: ';
const END_OF_FILE = '*** End of File';
const CONTEXT_MARKER = '@@';

interface PatchHunk {
  kind: 'add' | 'update' | 'delete';
  path: string;
  content?: string;
  chunks?: { context?: string; oldLines: string[]; newLines: string[] }[];
}

function parsePatch(patch: string): PatchHunk[] {
  const lines = patch.split('\n');
  const hunks: PatchHunk[] = [];
  let i = 0;

  // Find begin marker
  while (i < lines.length && !lines[i].startsWith(BEGIN_PATCH)) i++;
  i++; // Skip begin marker

  while (i < lines.length && !lines[i].startsWith(END_PATCH)) {
    const line = lines[i];

    if (line.startsWith(ADD_FILE)) {
      const path = line.slice(ADD_FILE.length).trim();
      const contentLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('***') && !lines[i].startsWith(END_PATCH)) {
        if (lines[i].startsWith('+')) {
          contentLines.push(lines[i].slice(1));
        } else {
          contentLines.push(lines[i]);
        }
        i++;
      }
      hunks.push({ kind: 'add', path, content: contentLines.join('\n') });
    }
    else if (line.startsWith(DELETE_FILE)) {
      const path = line.slice(DELETE_FILE.length).trim();
      hunks.push({ kind: 'delete', path });
      i++;
    }
    else if (line.startsWith(UPDATE_FILE)) {
      const path = line.slice(UPDATE_FILE.length).trim();
      const chunks: { context?: string; oldLines: string[]; newLines: string[] }[] = [];
      let currentChunk: { context?: string; oldLines: string[]; newLines: string[] } | null = null;
      i++;

      while (i < lines.length && !lines[i].startsWith('***') && !lines[i].startsWith(END_PATCH)) {
        const l = lines[i];

        if (l.startsWith(CONTEXT_MARKER)) {
          if (currentChunk) chunks.push(currentChunk);
          currentChunk = { context: l, oldLines: [], newLines: [] };
          i++;
          continue;
        }

        if (l.startsWith(END_OF_FILE)) {
          if (currentChunk) chunks.push(currentChunk);
          i++;
          break;
        }

        if (currentChunk) {
          if (l.startsWith('-')) {
            currentChunk.oldLines.push(l.slice(1));
          } else if (l.startsWith('+')) {
            currentChunk.newLines.push(l.slice(1));
          } else {
            // Context line (no prefix) - goes in both
            currentChunk.oldLines.push(l);
            currentChunk.newLines.push(l);
          }
        }
        i++;
      }

      if (currentChunk) chunks.push(currentChunk);
      hunks.push({ kind: 'update', path, chunks });
    }
    else {
      i++;
    }
  }

  return hunks;
}

function applyChunks(original: string, chunks: { oldLines: string[]; newLines: string[] }[]): string {
  let result = original;
  
  for (const chunk of chunks) {
    const oldText = chunk.oldLines.join('\n');
    const newText = chunk.newLines.join('\n');
    
    if (oldText === '') {
      // Insert at beginning
      result = newText + '\n' + result;
    } else {
      result = result.replace(oldText, newText);
    }
  }
  
  return result;
}

export const applyPatchTool: Tool = {
  name: 'apply_patch',
  description: 'Apply a multi-file unified patch. Supports *** Add/Update/Delete File operations with context lines, -removed, +added prefixes. Wrap in *** Begin Patch / *** End Patch.',
  parameters: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'Patch content with Begin/End markers' },
    },
    required: ['patch'],
  },
  async execute(params, ctx) {
    const patchContent = params.patch as string;
    
    if (!patchContent.includes(BEGIN_PATCH) || !patchContent.includes(END_PATCH)) {
      return { output: '', error: `Patch must contain "${BEGIN_PATCH}" and "${END_PATCH}" markers` };
    }

    try {
      const hunks = parsePatch(patchContent);
      if (hunks.length === 0) {
        return { output: '', error: 'No valid hunks found in patch' };
      }

      const summary = { added: [] as string[], modified: [] as string[], deleted: [] as string[] };

      for (const hunk of hunks) {
        const filePath = resolve(ctx.workdir, hunk.path);

        if (hunk.kind === 'add') {
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, hunk.content || '');
          summary.added.push(hunk.path);
        }
        else if (hunk.kind === 'delete') {
          if (existsSync(filePath)) {
            unlinkSync(filePath);
            summary.deleted.push(hunk.path);
          }
        }
        else if (hunk.kind === 'update') {
          if (!existsSync(filePath)) {
            return { output: '', error: `File not found for update: ${hunk.path}` };
          }
          
          const original = readFileSync(filePath, 'utf-8');
          const updated = applyChunks(original, hunk.chunks || []);
          writeFileSync(filePath, updated);
          summary.modified.push(hunk.path);
        }
      }

      const parts: string[] = [];
      if (summary.added.length) parts.push(`Added: ${summary.added.join(', ')}`);
      if (summary.modified.length) parts.push(`Modified: ${summary.modified.join(', ')}`);
      if (summary.deleted.length) parts.push(`Deleted: ${summary.deleted.join(', ')}`);

      return { output: `Patch applied successfully.\n${parts.join('\n')}` };
    } catch (err) {
      return { output: '', error: `Failed to apply patch: ${err}` };
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH IN FILE TOOL
// ═══════════════════════════════════════════════════════════════════════════════

export const searchInFileTool: Tool = {
  name: 'search_in_file',
  description: 'Search for text or regex pattern in a file. Returns matching lines with context.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to search' },
      pattern: { type: 'string', description: 'Text or regex pattern to search for' },
      regex: { type: 'boolean', description: 'Treat pattern as regex (default: false, literal search)' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
      context: { type: 'number', description: 'Number of context lines before/after match (default: 2)' },
      maxMatches: { type: 'number', description: 'Maximum matches to return (default: 100)' },
    },
    required: ['path', 'pattern'],
  },
  async execute(params, ctx) {
    const filePath = resolve(ctx.workdir, params.path as string);
    
    if (!existsSync(filePath)) {
      return { output: '', error: `File not found: ${filePath}` };
    }
    
    if (statSync(filePath).isDirectory()) {
      return { output: '', error: `Path is a directory: ${filePath}. Use list_files or search_files for directories.` };
    }

    const pattern = params.pattern as string;
    const useRegex = (params.regex as boolean) ?? false;
    const ignoreCase = (params.ignoreCase as boolean) ?? false;
    const contextLines = (params.context as number) ?? 2;
    const maxMatches = (params.maxMatches as number) ?? 100;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const results: { lineNum: number; line: string; isMatch: boolean }[] = [];
      const matchedLines = new Set<number>();

      // Build regex or literal matcher
      let searchRegex: RegExp;
      try {
        if (useRegex) {
          searchRegex = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
        } else {
          // Escape regex special chars for literal search
          const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          searchRegex = new RegExp(escaped, ignoreCase ? 'gi' : 'g');
        }
      } catch (err) {
        return { output: '', error: `Invalid pattern: ${err}` };
      }

      // Find all matches
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (searchRegex.test(line)) {
          matchedLines.add(i);
          // Reset regex lastIndex for global flag
          searchRegex.lastIndex = 0;
        }
      }

      if (matchedLines.size === 0) {
        return { output: `No matches found for: ${pattern}` };
      }

      // Build result with context
      const outputLines: string[] = [];
      let matchCount = 0;
      let lastLine = -1;

      const sortedMatches = [...matchedLines].sort((a, b) => a - b);
      
      for (const matchLine of sortedMatches) {
        if (matchCount >= maxMatches) break;

        // Add separator if there's a gap
        if (lastLine !== -1 && matchLine - lastLine > contextLines * 2 + 1) {
          outputLines.push('   ...');
        }

        // Add context before
        const startLine = Math.max(0, matchLine - contextLines);
        for (let i = startLine; i < matchLine; i++) {
          if (!matchedLines.has(i)) {
            outputLines.push(`${(i + 1).toString().padStart(6, ' ')}\t${lines[i]}`);
          }
        }

        // Add match line (highlighted with >>>)
        outputLines.push(`>>>${(matchLine + 1).toString().padStart(4, ' ')}\t${lines[matchLine]}`);
        matchCount++;

        // Add context after
        const endLine = Math.min(lines.length - 1, matchLine + contextLines);
        for (let i = matchLine + 1; i <= endLine; i++) {
          if (!matchedLines.has(i)) {
            outputLines.push(`${(i + 1).toString().padStart(6, ' ')}\t${lines[i]}`);
          }
        }

        lastLine = matchLine;
      }

      const header = `File: ${filePath}\nPattern: ${pattern}${useRegex ? ' (regex)' : ''}${ignoreCase ? ' (case-insensitive)' : ''}\n${'─'.repeat(50)}`;
      const footer = matchedLines.size > maxMatches 
        ? `\n\nShowing ${maxMatches} of ${matchedLines.size} matches`
        : `\n\n${matchedLines.size} match${matchedLines.size !== 1 ? 'es' : ''} found`;

      return { output: `${header}\n${outputLines.join('\n')}${footer}` };
    } catch (err) {
      return { output: '', error: `Failed to search: ${err}` };
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY COMPATIBILITY
// ═══════════════════════════════════════════════════════════════════════════════

// Keep hashline_edit as an alias for backward compatibility
export const hashlineEditTool = editFileTool;

// List files tool (useful companion)
export const listFilesTool: Tool = {
  name: 'list_files',
  description: 'List files in a directory. Supports glob pattern filter and recursive listing.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path' },
      pattern: { type: 'string', description: 'Glob pattern filter (e.g., *.ts)' },
      recursive: { type: 'boolean', description: 'List recursively' },
    },
    required: ['path'],
  },
  async execute(params, ctx) {
    const dirPath = resolve(ctx.workdir, params.path as string);
    
    if (!existsSync(dirPath)) {
      return { output: '', error: `Directory not found: ${dirPath}` };
    }
    
    if (!statSync(dirPath).isDirectory()) {
      return { output: '', error: `Not a directory: ${dirPath}` };
    }

    try {
      const recursive = params.recursive as boolean;
      const pattern = params.pattern as string | undefined;
      const results: string[] = [];

      function walk(dir: string, prefix: string = '') {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const name = entry.name;
          if (name.startsWith('.') && name !== '.gitignore') continue;
          
          const fullPath = resolve(dir, name);
          const displayPath = prefix ? `${prefix}/${name}` : name;
          
          if (entry.isDirectory()) {
            results.push(`${displayPath}/`);
            if (recursive) walk(fullPath, displayPath);
          } else {
            if (!pattern || name.match(pattern.replace(/\*/g, '.*'))) {
              results.push(displayPath);
            }
          }
        }
      }

      walk(dirPath);
      
      if (results.length === 0) {
        return { output: '(empty directory)' };
      }
      
      return { output: `Directory: ${dirPath}\n${'─'.repeat(40)}\n${results.join('\n')}` };
    } catch (err) {
      return { output: '', error: `Failed to list: ${err}` };
    }
  },
};