import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from '../tool-registry.js';

/**
 * Browser integration via persistent Python process.
 * Uses: undetected-chromedriver + selenium-stealth + Xvfb for bot-proof browsing.
 * The Python engine handles all Selenium operations; we communicate via JSON lines over stdio.
 *
 * Single unified tool with action parameter — keeps the tool list lean.
 */

let pyProc: ChildProcess | null = null;
let responseBuffer = '';
let browserStarted = false;
let pendingResolve: ((v: string) => void) | null = null;
let pendingReject: ((e: Error) => void) | null = null;

function getEnginePath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, '..', 'browser', 'engine.py');
}

async function ensureBrowser(): Promise<void> {
  if (pyProc && !pyProc.killed && browserStarted) return;

  return new Promise((resolve, reject) => {
    const enginePath = getEnginePath();
    pyProc = spawn('python3', [enginePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    responseBuffer = '';

    pyProc.stdout!.on('data', (data: Buffer) => {
      const text = data.toString();

      if (!browserStarted && text.includes('READY')) {
        browserStarted = true;
        resolve();
        const afterReady = text.split('READY\n').slice(1).join('');
        if (afterReady) {
          responseBuffer += afterReady;
          processBuffer();
        }
        return;
      }

      responseBuffer += text;
      processBuffer();
    });

    pyProc.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('fontconfig') && !msg.includes('WARNING') && !msg.includes('Xlib')) {
        if (msg.includes('Error') || msg.includes('Traceback')) {
          console.error(`[browser] ${msg}`);
        }
      }
    });

    pyProc.on('exit', () => {
      pyProc = null;
      browserStarted = false;
      if (pendingReject) {
        pendingReject(new Error('Browser process exited'));
        pendingReject = null;
        pendingResolve = null;
      }
    });

    pyProc.on('error', reject);

    setTimeout(() => {
      if (!browserStarted) reject(new Error('Browser startup timed out (60s)'));
    }, 60000);
  });
}

function processBuffer(): void {
  const lines = responseBuffer.split('\n');
  responseBuffer = lines.pop() || '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (pendingResolve) {
      pendingResolve(trimmed);
      pendingResolve = null;
      pendingReject = null;
    }
  }
}

async function cmd(command: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureBrowser();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingReject) {
        pendingReject(new Error('Browser command timed out (120s)'));
        pendingResolve = null;
        pendingReject = null;
      }
    }, 120000);

    pendingResolve = (data: string) => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({ success: false, error: `Invalid response: ${data.slice(0, 200)}` });
      }
    };
    pendingReject = (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    };

    try {
      pyProc!.stdin!.write(JSON.stringify(command) + '\n');
    } catch (err) {
      clearTimeout(timeout);
      pendingResolve = null;
      pendingReject = null;
      reject(err);
    }
  });
}

function fmt(result: Record<string, unknown>): string {
  if (!result.success) return `Error: ${result.error || 'Unknown error'}`;
  const clean = { ...result };
  if (typeof clean.data === 'string' && (clean.data as string).length > 500) {
    clean.data = `(base64 image, ${(clean.data as string).length} chars)`;
  }
  return JSON.stringify(clean, null, 2);
}

// ============================================================================
// Single unified browser tool — all actions via one tool with action parameter
// ============================================================================

export const browserTools: Tool[] = [
  {
    name: 'browser',
    description: [
      'Control an undetected Chrome browser with anti-bot stealth (selenium-stealth + Xvfb).',
      'Actions: navigate, back, screenshot, click, type, find, scroll, get_page, get_html,',
      'execute_js, fill_form, select, wait_element, press_key, human_click, human_type,',
      'upload, close.',
      'Use execute_js for advanced operations (cookies, localStorage, shadow DOM, etc.).',
      'Use human_click/human_type for stealth-critical sites.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform: navigate|back|screenshot|click|type|find|scroll|get_page|get_html|execute_js|fill_form|select|wait_element|press_key|human_click|human_type|upload|close',
        },
        url: { type: 'string', description: 'URL (for navigate)' },
        selector: { type: 'string', description: 'CSS/XPath selector (for click, type, find, etc.)' },
        by: { type: 'string', description: 'Selector strategy: css|xpath|id|class|tag|name (default: css)' },
        text: { type: 'string', description: 'Text to type (for type, human_type)' },
        key: { type: 'string', description: 'Key to press (for press_key): enter, tab, escape, etc.' },
        direction: { type: 'string', description: 'Scroll direction: up|down|top|bottom' },
        amount: { type: 'number', description: 'Scroll amount in pixels (default 500)' },
        script: { type: 'string', description: 'JavaScript code (for execute_js)' },
        data: { type: 'object', description: 'Form field map (for fill_form)' },
        value: { type: 'string', description: 'Option value (for select)' },
        index: { type: 'number', description: 'Option index (for select)' },
        timeout: { type: 'number', description: 'Wait timeout in seconds (for wait_element, default 10)' },
        condition: { type: 'string', description: 'Wait condition: present|visible|clickable|invisible' },
        clear_first: { type: 'boolean', description: 'Clear input before typing (default true)' },
        save_path: { type: 'string', description: 'File path to save screenshot' },
        file_path: { type: 'string', description: 'File to upload (for upload)' },
        limit: { type: 'number', description: 'Max elements to return (for find, default 10)' },
      },
      required: ['action'],
    },
    execute: async (params: Record<string, unknown>) => {
      const action = params.action as string;
      const by = (params.by as string) || 'css';

      switch (action) {
        case 'navigate':
          return { output: fmt(await cmd({ action: 'navigate', url: params.url })) };
        case 'back':
          return { output: fmt(await cmd({ action: 'back' })) };
        case 'screenshot':
          return { output: fmt(await cmd({ action: 'screenshot', save_path: params.save_path })) };
        case 'click':
          return { output: fmt(await cmd({ action: 'click', selector: params.selector, by })) };
        case 'type':
          return { output: fmt(await cmd({ action: 'type', selector: params.selector, text: params.text, by, clear: params.clear_first !== false })) };
        case 'find':
          return { output: fmt(await cmd({ action: 'find', selector: params.selector, by, limit: params.limit || 10 })) };
        case 'scroll':
          return { output: fmt(await cmd({ action: 'scroll', direction: params.direction || 'down', amount: params.amount || 500 })) };
        case 'get_page':
          return { output: fmt(await cmd({ action: 'get_page' })) };
        case 'get_html':
          return { output: fmt(await cmd({ action: 'get_html' })) };
        case 'execute_js':
          return { output: fmt(await cmd({ action: 'execute_js', script: params.script })) };
        case 'fill_form':
          return { output: fmt(await cmd({ action: 'fill_form', data: params.data })) };
        case 'select':
          return { output: fmt(await cmd({ action: 'select', selector: params.selector, by, value: params.value, text: params.text, index: params.index })) };
        case 'wait_element':
          return { output: fmt(await cmd({ action: 'wait_element', selector: params.selector, by, timeout: params.timeout || 10, condition: params.condition || 'present' })) };
        case 'press_key':
          return { output: fmt(await cmd({ action: 'press_key', key: params.key, selector: params.selector, by })) };
        case 'human_click':
          return { output: fmt(await cmd({ action: 'human_click', selector: params.selector, by })) };
        case 'human_type':
          return { output: fmt(await cmd({ action: 'human_type', selector: params.selector, text: params.text, by, clear: params.clear_first !== false })) };
        case 'upload':
          return { output: fmt(await cmd({ action: 'upload', selector: params.selector, file_path: params.file_path, by })) };
        case 'close':
          try { return { output: fmt(await cmd({ action: 'close' })) }; }
          catch { pyProc = null; browserStarted = false; return { output: 'Browser closed' }; }
        default:
          return { output: `Error: Unknown action "${action}". Valid: navigate, back, screenshot, click, type, find, scroll, get_page, get_html, execute_js, fill_form, select, wait_element, press_key, human_click, human_type, upload, close` };
      }
    },
  },
];
