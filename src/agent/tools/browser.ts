import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from '../tool-registry.js';

/**
 * Browser integration via persistent Python process.
 * Uses: undetected-chromedriver + selenium-stealth + Xvfb for bot-proof browsing.
 * The Python engine handles all Selenium operations; we communicate via JSON lines over stdio.
 * 
 * Pruned to essential tools only. Niche tools (shadow DOM, media control, geolocation,
 * accessibility audit, canvas data, device emulation, network interception, etc.)
 * are handled via browser_execute_js when needed.
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
// Tool Definitions - Essential browser tools (18 tools)
// For niche operations (shadow DOM, media, canvas, etc.) use browser_execute_js
// ============================================================================

const t = (name: string, desc: string, params: Record<string, unknown>, exec: (p: Record<string, unknown>) => Promise<{ output: string }>): Tool => ({
  name, description: desc, parameters: { type: 'object', ...params }, execute: exec,
});

export const browserTools: Tool[] = [
  // ==== Navigation ====
  t('browser_navigate', 'Navigate to a URL using undetected Chrome with anti-bot stealth.', {
    properties: { url: { type: 'string', description: 'URL to navigate to' } }, required: ['url'],
  }, async (p) => ({ output: fmt(await cmd({ action: 'navigate', url: p.url })) })),

  t('browser_back', 'Navigate back in browser history.', { properties: {} },
    async () => ({ output: fmt(await cmd({ action: 'back' })) })),

  // ==== Screenshots ====
  t('browser_screenshot', 'Take a screenshot of the current page.', {
    properties: { save_path: { type: 'string', description: 'Optional file path to save screenshot' } },
  }, async (p) => ({ output: fmt(await cmd({ action: 'screenshot', save_path: p.save_path })) })),

  // ==== Element interaction ====
  t('browser_click', 'Click an element on the page. For stealth-critical sites, use browser_human_click instead.', {
    properties: { selector: { type: 'string' }, by: { type: 'string', description: 'css/xpath/id/class/tag/name (default css)' } }, required: ['selector'],
  }, async (p) => ({ output: fmt(await cmd({ action: 'click', selector: p.selector, by: p.by || 'css' })) })),

  t('browser_type', 'Type text into an input element. For stealth-critical sites, use browser_human_type instead.', {
    properties: { selector: { type: 'string' }, text: { type: 'string' }, by: { type: 'string' }, clear_first: { type: 'boolean' } }, required: ['selector', 'text'],
  }, async (p) => ({ output: fmt(await cmd({ action: 'type', selector: p.selector, text: p.text, by: p.by || 'css', clear: p.clear_first !== false })) })),

  t('browser_find', 'Find elements on the page matching a selector. Returns text, tag, attributes.', {
    properties: { selector: { type: 'string' }, by: { type: 'string' }, limit: { type: 'number' } }, required: ['selector'],
  }, async (p) => ({ output: fmt(await cmd({ action: 'find', selector: p.selector, by: p.by || 'css', limit: p.limit || 10 })) })),

  t('browser_scroll', 'Scroll the page. Directions: up, down, top, bottom.', {
    properties: { direction: { type: 'string' }, amount: { type: 'number' } },
  }, async (p) => ({ output: fmt(await cmd({ action: 'scroll', direction: p.direction || 'down', amount: p.amount || 500 })) })),

  // ==== Page content ====
  t('browser_get_page', 'Get page URL, title, and visible text content.', {
    properties: {},
  }, async () => ({ output: fmt(await cmd({ action: 'get_page' })) })),

  t('browser_get_html', 'Get the full HTML source of the current page.', {
    properties: {},
  }, async () => ({ output: fmt(await cmd({ action: 'get_html' })) })),

  t('browser_execute_js', 'Execute JavaScript in the browser and return the result. Use this for any advanced operations (cookies, localStorage, shadow DOM, media, canvas, accessibility, etc.).', {
    properties: { script: { type: 'string', description: 'JavaScript code to execute' } }, required: ['script'],
  }, async (p) => ({ output: fmt(await cmd({ action: 'execute_js', script: p.script })) })),

  // ==== Forms ====
  t('browser_fill_form', 'Fill a form with multiple field values. Fields matched by name/id/placeholder.', {
    properties: { data: { type: 'object', description: 'Map of field names to values' } }, required: ['data'],
  }, async (p) => ({ output: fmt(await cmd({ action: 'fill_form', data: p.data })) })),

  t('browser_select', 'Select an option from a dropdown by value, text, or index.', {
    properties: { selector: { type: 'string' }, by: { type: 'string' }, value: { type: 'string' }, text: { type: 'string' }, index: { type: 'number' } }, required: ['selector'],
  }, async (p) => ({ output: fmt(await cmd({ action: 'select', selector: p.selector, by: p.by || 'css', value: p.value, text: p.text, index: p.index })) })),

  // ==== Waiting ====
  t('browser_wait_element', 'Wait for an element to appear/become visible/clickable.', {
    properties: { selector: { type: 'string' }, by: { type: 'string' }, timeout: { type: 'number' }, condition: { type: 'string', description: 'present/visible/clickable/invisible' } }, required: ['selector'],
  }, async (p) => ({ output: fmt(await cmd({ action: 'wait_element', selector: p.selector, by: p.by || 'css', timeout: p.timeout || 10, condition: p.condition || 'present' })) })),

  // ==== Keyboard ====
  t('browser_press_key', 'Press a key (enter, tab, escape, backspace, delete, space, arrow keys, etc.).', {
    properties: { key: { type: 'string' }, selector: { type: 'string' }, by: { type: 'string' } }, required: ['key'],
  }, async (p) => ({ output: fmt(await cmd({ action: 'press_key', key: p.key, selector: p.selector, by: p.by || 'css' })) })),

  // ==== Stealth / Human-like ====
  t('browser_human_click', 'Click with human-like mouse movement (bezier curve path). Stealthier than browser_click.', {
    properties: { selector: { type: 'string' }, by: { type: 'string' } }, required: ['selector'],
  }, async (p) => ({ output: fmt(await cmd({ action: 'human_click', selector: p.selector, by: p.by || 'css' })) })),

  t('browser_human_type', 'Type text with human-like variable-speed keystrokes. Stealthier than browser_type.', {
    properties: { selector: { type: 'string' }, text: { type: 'string' }, by: { type: 'string' }, clear_first: { type: 'boolean' } }, required: ['selector', 'text'],
  }, async (p) => ({ output: fmt(await cmd({ action: 'human_type', selector: p.selector, text: p.text, by: p.by || 'css', clear: p.clear_first !== false })) })),

  // ==== File upload ====
  t('browser_upload_file', 'Upload a file via a file input element.', {
    properties: { selector: { type: 'string' }, file_path: { type: 'string' }, by: { type: 'string' } }, required: ['selector', 'file_path'],
  }, async (p) => ({ output: fmt(await cmd({ action: 'upload', selector: p.selector, file_path: p.file_path, by: p.by || 'css' })) })),

  // ==== Close ====
  t('browser_close', 'Close the browser and clean up resources.', { properties: {} }, async () => {
    try { const r = await cmd({ action: 'close' }); return { output: fmt(r) }; }
    catch { pyProc = null; browserStarted = false; return { output: 'Browser closed' }; }
  }),
];
