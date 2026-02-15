import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import type { Tool, ToolContext } from '../tool-registry.js';

/**
 * Browser integration via persistent Python process.
 * Uses: undetected-chromedriver + selenium-stealth + Xvfb for bot-proof browsing.
 * The Python engine handles all Selenium operations; we communicate via JSON lines over stdio.
 *
 * Single unified tool with action parameter — keeps the tool list lean.
 * Supports concurrent access via command queue (serializes requests to single browser).
 */

let pyProc: ChildProcess | null = null;
let responseBuffer = '';
let browserStarted = false;
let pendingResolve: ((v: string) => void) | null = null;
let pendingReject: ((e: Error) => void) | null = null;

// Command queue for serializing concurrent browser requests
// sessionId is included so tab switching happens atomically with the command
type QueuedCommand = {
  command: Record<string, unknown>;
  sessionId?: string;
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
};
const commandQueue: QueuedCommand[] = [];
let commandRunning = false;

// Track which tab belongs to which session (for subagent isolation)
// Maps sessionId -> window handle
const sessionTabMap: Map<string, string> = new Map();

// Browser config (set from outside via setBrowserConfig)
let browserProfileDir: string = '';
let screenshotDir: string = '';

// Image broadcaster for auto-displaying screenshots in chat
type ImageBroadcastFn = (event: {
  type: 'image';
  sessionId: string;
  base64?: string;
  mimeType: string;
  alt?: string;
  filename?: string;
}) => void;
let imageBroadcaster: ImageBroadcastFn | null = null;

/** Set image broadcaster for auto-displaying screenshots in chat */
export function setBrowserImageBroadcaster(fn: ImageBroadcastFn): void {
  imageBroadcaster = fn;
}

/** Configure the browser profile directory for session persistence (cookies, logins, etc.) */
export function setBrowserConfig(opts: { profileDir?: string; screenshotDir?: string }): void {
  if (opts.profileDir) browserProfileDir = opts.profileDir;
  if (opts.screenshotDir) {
    screenshotDir = opts.screenshotDir;
    if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });
  }
}

function getEnginePath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, '..', '..', 'browser', 'engine.py');
}

async function ensureBrowser(): Promise<void> {
  if (pyProc && !pyProc.killed && browserStarted) return;

  return new Promise((resolve, reject) => {
    const enginePath = getEnginePath();
    const spawnEnv: Record<string, string> = { ...process.env } as Record<string, string>;
    if (browserProfileDir) spawnEnv.AUTOMATE_PROFILE_DIR = browserProfileDir;

    pyProc = spawn('python3', [enginePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
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

    pyProc.on('exit', (code) => {
      console.log(`[browser] Python process exited with code ${code}`);
      pyProc = null;
      browserStarted = false;
      // Reject pending command if any
      if (pendingReject) {
        pendingReject(new Error('Browser process exited'));
        pendingReject = null;
        pendingResolve = null;
      }
      // Reject all queued commands
      while (commandQueue.length > 0) {
        const { reject } = commandQueue.shift()!;
        reject(new Error('Browser process exited'));
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

/** Execute a single command (internal - called by queue processor) */
async function executeCommand(command: Record<string, unknown>): Promise<Record<string, unknown>> {
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

/** Check if an error indicates the browser process died */
function isBrowserDeadError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return msg.includes('process exited') ||
         msg.includes('epipe') ||
         msg.includes('channel closed') ||
         msg.includes('not running');
}

/** Force restart the browser process */
async function restartBrowser(): Promise<void> {
  console.log('[browser] Restarting browser process...');
  // Kill existing process
  if (pyProc && !pyProc.killed) {
    try {
      pyProc.kill('SIGTERM');
    } catch { /* ignore */ }
  }
  pyProc = null;
  browserStarted = false;
  responseBuffer = '';
  commandRunning = false;
  // Clear tab mappings since browser is dead
  sessionTabMap.clear();
  // Clear pending handlers
  pendingResolve = null;
  pendingReject = null;
  // Start fresh
  await ensureBrowser();
  console.log('[browser] Browser restarted successfully');
}

/** Ensure session has a tab and switch to it (called inside queue processing for atomicity) */
async function ensureSessionTab(sessionId: string): Promise<void> {
  if (!sessionTabMap.has(sessionId)) {
    // Get current tabs
    const tabsResult = await executeCommand({ action: 'tabs' });
    const tabs = (tabsResult as any).tabs || [];

    if (tabs.length === 0 || (tabs.length === 1 && sessionTabMap.size === 0)) {
      // First session, use the existing tab
      const currentHandle = (tabsResult as any).current;
      if (currentHandle) sessionTabMap.set(sessionId, currentHandle);
    } else {
      // Create a new tab for this session
      const newTabResult = await executeCommand({ action: 'new_tab', url: 'about:blank' });
      if (newTabResult.success) {
        const newTabsResult = await executeCommand({ action: 'tabs' });
        const newHandle = (newTabsResult as any).current;
        if (newHandle) sessionTabMap.set(sessionId, newHandle);
      }
    }
  }

  // Switch to this session's tab
  const handle = sessionTabMap.get(sessionId);
  if (handle) {
    try {
      await executeCommand({ action: 'switch_tab', handle });
    } catch {
      // Tab may have been closed externally, recreate it
      sessionTabMap.delete(sessionId);
      const newTabResult = await executeCommand({ action: 'new_tab', url: 'about:blank' });
      if (newTabResult.success) {
        const newTabsResult = await executeCommand({ action: 'tabs' });
        const newHandle = (newTabsResult as any).current;
        if (newHandle) sessionTabMap.set(sessionId, newHandle);
      }
    }
  }
}

/** Process the next command in queue - handles tab switching atomically */
async function processQueue(): Promise<void> {
  if (commandRunning || commandQueue.length === 0) return;

  commandRunning = true;
  const { command, sessionId, resolve, reject } = commandQueue.shift()!;

  try {
    // ATOMIC: Switch to session's tab THEN execute command
    // This happens inside the queue processor so no other command can interleave
    if (sessionId) {
      await ensureSessionTab(sessionId);
    }

    const result = await executeCommand(command);
    resolve(result);
  } catch (err) {
    // If browser died, try to restart and retry once
    if (isBrowserDeadError(err as Error)) {
      try {
        await restartBrowser();
        // Re-ensure tab after restart
        if (sessionId) {
          await ensureSessionTab(sessionId);
        }
        const retryResult = await executeCommand(command);
        resolve(retryResult);
      } catch (retryErr) {
        reject(retryErr as Error);
      }
    } else {
      reject(err as Error);
    }
  } finally {
    commandRunning = false;
    // Process next command if any
    if (commandQueue.length > 0) {
      processQueue();
    }
  }
}

/** Queue a command for execution (serializes concurrent requests) */
async function cmd(command: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
  await ensureBrowser();

  return new Promise((resolve, reject) => {
    commandQueue.push({ command, sessionId, resolve, reject });
    processQueue();
  });
}

/** Queue a raw command without session context (for internal use) */
async function cmdRaw(command: Record<string, unknown>): Promise<Record<string, unknown>> {
  return cmd(command, undefined);
}

function fmt(result: Record<string, unknown>): string {
  if (!result.success) return `Error: ${result.error || 'Unknown error'}`;
  const clean = { ...result };
  if (typeof clean.data === 'string' && (clean.data as string).length > 500) {
    clean.data = `(base64 image, ${(clean.data as string).length} chars)`;
  }
  return JSON.stringify(clean, null, 2);
}

// All actions supported by the Python browser engine
const ALL_ACTIONS = [
  // Navigation
  'navigate', 'back', 'forward', 'refresh',
  // Screenshots
  'screenshot', 'screenshot_full', 'screenshot_element',
  // Interaction - basic
  'click', 'click_position', 'type', 'find', 'scroll', 'scroll_to', 'hover', 'double_click', 'right_click', 'drag',
  // Interaction - human-like (stealth)
  'human_click', 'human_type', 'human_scroll',
  // Page content
  'get_page', 'get_html', 'execute_js', 'save_html',
  // Forms
  'fill_form', 'select', 'submit', 'find_forms', 'upload',
  // Waiting
  'wait_element', 'wait',
  // Keyboard
  'press_key', 'key_combo',
  // Cookies
  'cookies', 'set_cookie', 'delete_cookie', 'delete_cookies',
  // Storage
  'local_storage_get', 'local_storage_set', 'local_storage_remove', 'local_storage_clear',
  'session_storage_get', 'session_storage_set', 'session_storage_clear',
  // Tabs
  'tabs', 'new_tab', 'switch_tab', 'close_tab',
  // Frames
  'switch_frame',
  // Alerts
  'alert',
  // Content extraction
  'find_links', 'get_images', 'get_headings', 'search_text', 'get_meta', 'extract_table',
  // Debugging
  'console_logs', 'get_performance', 'get_js_errors',
  'inject_error_catcher',
  // Network
  'inject_network_logger', 'get_network_log', 'clear_network_log',
  // CSS / DOM inspection
  'highlight', 'get_computed_style', 'get_bounding_box',
  // Shadow DOM
  'find_in_shadow', 'click_in_shadow',
  // Geolocation
  'set_geolocation',
  // Accessibility
  'check_accessibility', 'get_aria_info',
  // PDF
  'print_to_pdf',
  // Media
  'control_media', 'get_media_state', 'seek_media',
  // Window
  'set_window_size', 'maximize_window',
  // Search shortcuts
  'google_search', 'duckduckgo_search',
  // Canvas
  'get_canvas_data',
  // Device emulation
  'emulate_device',
  // Stealth
  'get_stealth_profile',
  // Text-based (no selectors needed)
  'click_text', 'find_text', 'get_interactive', 'get_aria_tree',
  // Session
  'close',
] as const;

// ============================================================================
// Single unified browser tool — all actions via one tool with action parameter
// ============================================================================

export const browserTools: Tool[] = [
  {
    name: 'browser',
    description: [
      'Control an undetected Chrome browser with anti-bot stealth (selenium-stealth + Xvfb).',
      '',
      'NAVIGATION: navigate, back, forward, refresh',
      'SCREENSHOTS: screenshot, screenshot_full, screenshot_element',
      'INTERACTION: click, click_position, type, find, scroll, scroll_to, hover, double_click, right_click, drag',
      '  click_position — click at exact viewport pixel coordinates (params: x, y)',
      'STEALTH INTERACTION: human_click, human_type, human_scroll — mimics natural human behavior.',
      '  human_type supports inline key commands in text: /enter, /tab, /escape, /backspace, /space, /up, /down, /left, /right',
      '  Example: "hello/enterworld" types "hello", presses Enter, types "world"',
      'PAGE CONTENT: get_page, get_html, execute_js, save_html',
      'FORMS: fill_form, select, submit, find_forms, upload',
      'WAITING: wait_element, wait',
      'KEYBOARD: press_key, key_combo — press individual keys or combinations like Ctrl+A',
      'COOKIES: cookies, set_cookie, delete_cookie, delete_cookies',
      'LOCAL STORAGE: local_storage_get, local_storage_set, local_storage_remove, local_storage_clear',
      'SESSION STORAGE: session_storage_get, session_storage_set, session_storage_clear',
      'TABS: tabs, new_tab, switch_tab, close_tab — full multi-tab support',
      'FRAMES: switch_frame — navigate into/out of iframes',
      'ALERTS: alert — accept, dismiss, or get text from browser alerts',
      'CONTENT EXTRACTION: find_links, get_images, get_headings, search_text, get_meta, extract_table',
      'DEBUGGING: console_logs, get_performance, get_js_errors, inject_error_catcher',
      'NETWORK: inject_network_logger, get_network_log, clear_network_log — intercept XHR/fetch',
      'CSS/DOM: highlight, get_computed_style, get_bounding_box',
      'SHADOW DOM: find_in_shadow, click_in_shadow — traverse shadow roots',
      'GEOLOCATION: set_geolocation — spoof GPS coordinates',
      'ACCESSIBILITY: check_accessibility, get_aria_info — audit accessibility',
      'PDF: print_to_pdf — generate PDF from page',
      'MEDIA: control_media, get_media_state, seek_media — control video/audio elements',
      'WINDOW: set_window_size, maximize_window',
      'SEARCH: google_search, duckduckgo_search — quick search shortcuts',
      'CANVAS: get_canvas_data — extract canvas element data',
      'DEVICE EMULATION: emulate_device — mobile/tablet emulation',
      'STEALTH INFO: get_stealth_profile — view current fingerprint profile',
      'TEXT-BASED (no selectors needed — ideal for React/SPA with randomized classes):',
      '  click_text — click element by visible text/aria-label (params: text, exact?, tag?)',
      '  find_text — find elements by visible text/aria-label (params: text, exact?, tag?, limit?)',
      '  get_interactive — list all clickable elements on page (buttons, links, inputs) with labels & positions',
      '  get_aria_tree — get compact accessibility tree snapshot (params: max_depth?) — stable IDs for React apps',
      'SESSION: close — close the browser',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: `Action to perform: ${ALL_ACTIONS.join('|')}`,
        },
        url: { type: 'string', description: 'URL (for navigate, new_tab)' },
        x: { type: 'number', description: 'X pixel coordinate in viewport (for click_position)' },
        y: { type: 'number', description: 'Y pixel coordinate in viewport (for click_position)' },
        selector: { type: 'string', description: 'CSS/XPath selector (for click, type, find, hover, etc.)' },
        by: { type: 'string', description: 'Selector strategy: css|xpath|id|class|tag|name (default: css)' },
        text: { type: 'string', description: 'Text to type, search query, or visible text to match (for type, human_type, search_text, click_text, find_text, google_search, duckduckgo_search)' },
        exact: { type: 'boolean', description: 'Exact text match (for click_text, find_text; default false = substring match)' },
        tag: { type: 'string', description: 'Filter by tag name (for click_text, find_text; e.g. "button", "a")' },
        max_depth: { type: 'number', description: 'Max tree depth (for get_aria_tree; default 5)' },
        key: { type: 'string', description: 'Key to press (for press_key): enter, tab, escape, etc.' },
        keys: { type: 'string', description: 'Key combination (for key_combo): e.g. "ctrl+a", "ctrl+shift+i"' },
        direction: { type: 'string', description: 'Scroll direction: up|down|top|bottom' },
        amount: { type: 'number', description: 'Scroll amount in pixels (default 500)' },
        script: { type: 'string', description: 'JavaScript code (for execute_js)' },
        data: { type: 'object', description: 'Form field map (for fill_form), or cookie data (for set_cookie)' },
        value: { type: 'string', description: 'Option value (for select), storage value (for local/session_storage_set)' },
        index: { type: 'number', description: 'Option index (for select), tab index (for switch_tab)' },
        timeout: { type: 'number', description: 'Wait timeout in seconds (for wait_element, wait; default 10)' },
        condition: { type: 'string', description: 'Wait condition: present|visible|clickable|invisible' },
        clear_first: { type: 'boolean', description: 'Clear input before typing (default true)' },
        save_path: { type: 'string', description: 'File path to save (for screenshot, save_html, print_to_pdf)' },
        file_path: { type: 'string', description: 'File to upload (for upload)' },
        limit: { type: 'number', description: 'Max elements to return (for find, default 10)' },
        // Drag params
        target_selector: { type: 'string', description: 'Target element for drag operation' },
        target_by: { type: 'string', description: 'Target selector strategy for drag' },
        // Frame params
        frame: { type: 'string', description: 'Frame identifier: index number, name/id, or "parent" to go back' },
        // Alert params
        alert_action: { type: 'string', description: 'Alert action: accept|dismiss|get_text' },
        alert_text: { type: 'string', description: 'Text to type into alert prompt' },
        // Cookie params
        name: { type: 'string', description: 'Cookie/storage key name' },
        cookie_name: { type: 'string', description: 'Cookie name (for delete_cookie)' },
        cookie_value: { type: 'string', description: 'Cookie value (for set_cookie)' },
        domain: { type: 'string', description: 'Cookie domain' },
        path: { type: 'string', description: 'Cookie path' },
        // Geolocation
        latitude: { type: 'number', description: 'Latitude (for set_geolocation)' },
        longitude: { type: 'number', description: 'Longitude (for set_geolocation)' },
        accuracy: { type: 'number', description: 'Accuracy in meters (for set_geolocation)' },
        // Media
        media_action: { type: 'string', description: 'Media control: play|pause|mute|unmute' },
        seek_time: { type: 'number', description: 'Time in seconds (for seek_media)' },
        // Window
        width: { type: 'number', description: 'Window width (for set_window_size)' },
        height: { type: 'number', description: 'Window height (for set_window_size)' },
        // Shadow DOM
        host_selector: { type: 'string', description: 'Shadow host element selector' },
        shadow_selector: { type: 'string', description: 'Selector within shadow root' },
        // Device emulation
        device: { type: 'string', description: 'Device name: iphone_12, iphone_14_pro, pixel_7, ipad, ipad_pro, galaxy_s21, surface_pro' },
        // Table extraction
        table_index: { type: 'number', description: 'Table index on page (for extract_table, default 0)' },
        // CSS
        properties: { type: 'array', description: 'CSS property names to get (for get_computed_style)' },
        // Highlight
        color: { type: 'string', description: 'Highlight border color (for highlight, default red)' },
        duration: { type: 'number', description: 'Highlight duration in ms (for highlight, default 3000)' },
      },
      required: ['action'],
    },
    execute: async (params: Record<string, unknown>, ctx?: ToolContext) => {
      const action = params.action as string;

      // Validate action
      if (!ALL_ACTIONS.includes(action as any)) {
        return { output: `Error: Unknown action "${action}". Valid actions:\n${ALL_ACTIONS.join(', ')}` };
      }

      // Build the command object, passing through all params to the Python engine
      const command: Record<string, unknown> = { action };

      // Map all relevant params into the command
      const passthrough = [
        'url', 'x', 'y', 'selector', 'by', 'text', 'exact', 'tag', 'max_depth', 'key', 'keys', 'direction', 'amount',
        'script', 'data', 'value', 'index', 'timeout', 'condition', 'clear_first',
        'save_path', 'file_path', 'limit', 'target_selector', 'target_by',
        'frame', 'alert_action', 'alert_text', 'name', 'cookie_name', 'cookie_value',
        'domain', 'path', 'latitude', 'longitude', 'accuracy',
        'media_action', 'seek_time', 'width', 'height',
        'host_selector', 'shadow_selector', 'device', 'table_index',
        'properties', 'color', 'duration',
      ];

      for (const key of passthrough) {
        if (params[key] !== undefined) {
          // Remap some param names to match Python engine expectations
          if (key === 'clear_first') {
            command['clear'] = params[key];
          } else if (key === 'alert_action') {
            command['action_type'] = params[key];
          } else if (key === 'alert_text') {
            command['text'] = params[key];
          } else if (key === 'media_action') {
            command['media_action'] = params[key];
          } else if (key === 'seek_time') {
            command['time'] = params[key];
          } else if (key === 'cookie_name') {
            command['name'] = params[key];
          } else if (key === 'cookie_value') {
            command['value'] = params[key];
          } else if (key === 'table_index') {
            command['index'] = params[key];
          } else {
            command[key] = params[key];
          }
        }
      }

      // Default values
      if (action === 'find' && !command['limit']) command['limit'] = 10;
      if (action === 'scroll' && !command['direction']) command['direction'] = 'down';
      if (action === 'scroll' && !command['amount']) command['amount'] = 500;
      if (action === 'wait_element' && !command['timeout']) command['timeout'] = 10;
      if (action === 'wait_element' && !command['condition']) command['condition'] = 'present';
      if (!command['by'] && params['selector']) command['by'] = 'css';

      const sessionId = ctx?.sessionId;

      // ── Handle close specially ──
      if (action === 'close') {
        sessionTabMap.clear();
        try { return { output: fmt(await cmdRaw(command)) }; }
        catch { pyProc = null; browserStarted = false; return { output: 'Browser closed' }; }
      }

      // ── Intercept tab-related actions to work within session scope ──
      // The agent thinks they're managing tabs, but they only see their own tab.
      // Tab switching is handled atomically in the queue processor.
      if (sessionId && action === 'tabs') {
        // Get current page info via the queue (which will switch to session tab first)
        const result = await cmd(command, sessionId);
        const handle = sessionTabMap.get(sessionId);
        // Return just their tab info, hide the multi-session nature
        return {
          output: fmt({
            success: true,
            current: handle,
            tabs: [{ handle, title: (result as any).title || 'Tab', url: (result as any).url || '' }],
            count: 1,
          }),
        };
      }

      if (sessionId && action === 'new_tab') {
        // Agent wants a new tab - just navigate their existing tab to the new URL
        const url = command['url'] as string || 'about:blank';
        const navResult = await cmd({ action: 'navigate', url }, sessionId);
        return { output: fmt({ success: navResult.success, message: 'Opened in current tab', url }) };
      }

      if (sessionId && action === 'switch_tab') {
        // No-op since each session only has one tab
        return { output: fmt({ success: true, message: 'Already on your tab' }) };
      }

      if (sessionId && action === 'close_tab') {
        // Navigate to blank instead of actually closing
        await cmd({ action: 'navigate', url: 'about:blank' }, sessionId);
        return { output: fmt({ success: true, message: 'Tab cleared' }) };
      }

      // ── Execute command with session context ──
      // The queue processor will switch to the session's tab atomically before executing
      const result = await cmd(command, sessionId);

      // Auto-display screenshots in chat
      if (result.success && ['screenshot', 'screenshot_full', 'screenshot_element'].includes(action)) {
        const base64Data = result.data as string;
        if (base64Data && imageBroadcaster && ctx?.sessionId) {
          const alt = action === 'screenshot_full' ? 'Full Page Screenshot'
            : action === 'screenshot_element' ? 'Element Screenshot'
            : 'Browser Screenshot';

          imageBroadcaster({
            type: 'image',
            sessionId: ctx.sessionId,
            base64: base64Data,
            mimeType: 'image/png',
            alt,
            filename: `screenshot-${Date.now()}.png`,
          });
        }
      }

      return { output: fmt(result) };
    },
  },
];
