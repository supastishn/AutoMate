import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import type { Tool, ToolContext } from '../tool-registry.js';

/**
 * Browser integration via persistent Python process.
 * Uses: undetected-chromedriver + selenium-stealth + Xvfb for bot-proof browsing.
 * The Python engine handles all Selenium operations; we communicate via JSON lines over stdio.
 *
 * Session-aware command queue - allows concurrent access while maintaining tab isolation.
 * Each session has its own queue to avoid blocking other sessions, but commands within
 * a session are processed sequentially to maintain state consistency.
 */

let pyProc: ChildProcess | null = null;
let responseBuffer = '';
let browserStarted = false;
let pendingResolve: ((v: string) => void) | null = null;
let pendingReject: ((e: Error) => void) | null = null;
let warnedSeleniumDeprecation = false;

// Per-session command queues to allow concurrent operations across different sessions
// Each session has its own queue to prevent blocking other sessions
type QueuedCommand = {
  command: Record<string, unknown>;
  sessionId?: string;
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
};
const sessionCommandQueues: Map<string, QueuedCommand[]> = new Map();
// Track which sessions are currently processing a command
const sessionCommandRunning: Set<string> = new Set();

// Track which tab belongs to which session (for subagent isolation)
// Maps sessionId -> window handle
const sessionTabMap: Map<string, string> = new Map();

// Browser config (set from outside via setBrowserConfig)
type BrowserEngine = 'playwright' | 'selenium';
let browserProfileDir: string = '';
let browserExtensions: string = '';
let browserHeadless: boolean = true;
let browserEngine: BrowserEngine = 'playwright';
let browserChromiumPath: string = '';
let browserChromeDriverPath: string = '';
let screenshotDir: string = '';

// Playwright runtime state (used when browserEngine = 'playwright')
let pwContext: any = null;
let pwCurrentPageIndex = 0;
let pwNetworkLog: Array<Record<string, unknown>> = [];
let pwNetworkLoggerAttached = false;

// Image broadcaster for auto-displaying screenshots in chat
type ImageBroadcastFn = (event: {
  type: 'image';
  sessionId: string;
  base64?: string;
  mimeType: string;
  alt?: string;
  filename?: string;
  id?: string;
}) => void;
let imageBroadcaster: ImageBroadcastFn | null = null;

function resolveHomePath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function runWhich(bin: string): string {
  try {
    const result = spawnSync('which', [bin], { encoding: 'utf-8' });
    if (result.status === 0) {
      return (result.stdout || '').trim();
    }
  } catch {
    // ignore
  }
  return '';
}

export function detectSystemBrowserBinaries(whichResolver: (bin: string) => string = runWhich): {
  chromiumPath: string;
  chromeDriverPath: string;
} {
  const chromiumCandidates = ['chromium', 'chromium-browser', 'google-chrome', 'chrome'];
  const chromedriverCandidates = ['chromedriver'];
  const chromiumPath = chromiumCandidates
    .map(name => (whichResolver(name) || '').trim())
    .find(Boolean) || '';
  const chromeDriverPath = chromedriverCandidates
    .map(name => (whichResolver(name) || '').trim())
    .find(Boolean) || '';
  return { chromiumPath, chromeDriverPath };
}

{
  const detected = detectSystemBrowserBinaries();
  browserChromiumPath = detected.chromiumPath;
  browserChromeDriverPath = detected.chromeDriverPath;
}

/** Set image broadcaster for auto-displaying screenshots in chat */
export function setBrowserImageBroadcaster(fn: ImageBroadcastFn): void {
  imageBroadcaster = fn;
}

/** Configure the browser profile directory for session persistence (cookies, logins, etc.) */
export function setBrowserConfig(opts: {
  profileDir?: string;
  screenshotDir?: string;
  extensions?: string;
  headless?: boolean;
  engine?: BrowserEngine;
  chromiumPath?: string;
  chromeDriverPath?: string;
}): void {
  if (opts.profileDir) browserProfileDir = resolveHomePath(opts.profileDir);
  if (opts.extensions) browserExtensions = opts.extensions;
  if (opts.headless !== undefined) browserHeadless = opts.headless;
  if (opts.engine) browserEngine = opts.engine;
  if (opts.chromiumPath !== undefined) browserChromiumPath = resolveHomePath(opts.chromiumPath);
  if (opts.chromeDriverPath !== undefined) browserChromeDriverPath = resolveHomePath(opts.chromeDriverPath);
  if (browserChromiumPath && !existsSync(browserChromiumPath)) {
    browserChromiumPath = '';
  }
  if (browserChromeDriverPath && !existsSync(browserChromeDriverPath)) {
    browserChromeDriverPath = '';
  }
  if (!browserChromiumPath || !browserChromeDriverPath) {
    const detected = detectSystemBrowserBinaries();
    if (!browserChromiumPath) browserChromiumPath = detected.chromiumPath;
    if (!browserChromeDriverPath) browserChromeDriverPath = detected.chromeDriverPath;
  }
  if (opts.screenshotDir) {
    screenshotDir = opts.screenshotDir;
    if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });
  }
  if (browserEngine === 'selenium' && !warnedSeleniumDeprecation) {
    console.warn('[browser] Selenium backend is deprecated. Prefer browser.engine="playwright".');
    warnedSeleniumDeprecation = true;
  }
}

export function getBrowserRuntimeConfig(): {
  engine: BrowserEngine;
  profileDir: string;
  extensions: string;
  headless: boolean;
  chromiumPath: string;
  chromeDriverPath: string;
} {
  return {
    engine: browserEngine,
    profileDir: browserProfileDir,
    extensions: browserExtensions,
    headless: browserHeadless,
    chromiumPath: browserChromiumPath,
    chromeDriverPath: browserChromeDriverPath,
  };
}

function getEnginePath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, '..', '..', 'browser', 'engine.py');
}

async function ensureSeleniumBrowser(): Promise<void> {
  if (pwContext) {
    try {
      await pwContext.close();
    } catch { /* ignore */ }
    pwContext = null;
    pwCurrentPageIndex = 0;
    pwNetworkLoggerAttached = false;
    pwNetworkLog = [];
  }
  if (pyProc && !pyProc.killed && browserStarted) return;

  return new Promise((resolve, reject) => {
    const enginePath = getEnginePath();
    const spawnEnv: Record<string, string> = { ...process.env } as Record<string, string>;
    if (browserProfileDir) spawnEnv.AUTOMATE_PROFILE_DIR = browserProfileDir;
    if (browserExtensions) spawnEnv.AUTOMATE_EXTENSIONS = browserExtensions;
    if (!browserHeadless) spawnEnv.AUTOMATE_HEADLESS = '';
    if (browserChromiumPath) spawnEnv.AUTOMATE_CHROMIUM_PATH = browserChromiumPath;
    if (browserChromeDriverPath) spawnEnv.AUTOMATE_CHROMEDRIVER_PATH = browserChromeDriverPath;

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
      // Reject all queued commands for all sessions
      for (const [sessionId, queue] of sessionCommandQueues) {
        while (queue.length > 0) {
          const { reject } = queue.shift()!;
          reject(new Error('Browser process exited'));
        }
        sessionCommandRunning.delete(sessionId);
      }
      sessionCommandQueues.clear();
    });

    pyProc.on('error', reject);

    setTimeout(() => {
      if (!browserStarted) reject(new Error('Browser startup timed out (60s)'));
    }, 60000);
  });
}

async function ensurePlaywrightBrowser(): Promise<void> {
  if (pyProc && !pyProc.killed) {
    try {
      pyProc.kill('SIGTERM');
    } catch { /* ignore */ }
    pyProc = null;
    browserStarted = false;
    responseBuffer = '';
    pendingResolve = null;
    pendingReject = null;
  }
  if (pwContext) return;
  const playwrightModule = 'playwright-core';
  let playwright: any;
  try {
    playwright = await import(playwrightModule);
  } catch {
    throw new Error('Playwright backend requires "playwright-core". Install it with: npm install playwright-core');
  }
  const extensionList = browserExtensions
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  const extensionArgs: string[] = extensionList.length > 0
    ? [
        `--disable-extensions-except=${extensionList.join(',')}`,
        `--load-extension=${extensionList.join(',')}`,
      ]
    : [];
  const effectiveHeadless = extensionList.length > 0 ? false : browserHeadless;
  const launchOptions: Record<string, unknown> = {
    headless: effectiveHeadless,
    args: extensionArgs,
  };
  if (browserChromiumPath) {
    launchOptions.executablePath = browserChromiumPath;
  }
  pwContext = await playwright.chromium.launchPersistentContext(
    browserProfileDir || undefined,
    launchOptions,
  );
  pwNetworkLoggerAttached = false;
  pwNetworkLog = [];
}

async function ensureBrowser(): Promise<void> {
  if (browserEngine === 'playwright') {
    await ensurePlaywrightBrowser();
    return;
  }
  await ensureSeleniumBrowser();
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

/** Execute a single Selenium command through the Python bridge. */
async function executeSeleniumCommand(command: Record<string, unknown>): Promise<Record<string, unknown>> {
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

function resolveSelector(selector: string, by?: unknown): string {
  const strategy = typeof by === 'string' ? by.toLowerCase() : 'css';
  if (strategy === 'xpath') return `xpath=${selector}`;
  if (strategy === 'id') return selector.startsWith('#') ? selector : `#${selector}`;
  if (strategy === 'class') return selector.startsWith('.') ? selector : `.${selector}`;
  if (strategy === 'name') return `[name="${selector}"]`;
  return selector;
}

async function executePlaywrightCommand(command: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensurePlaywrightBrowser();
  if (!pwContext) {
    return { success: false, error: 'Playwright context is not initialized' };
  }

  const action = String(command.action || '');
  if (!PLAYWRIGHT_SUPPORTED_ACTIONS.includes(action as any)) {
    return {
      success: false,
      error: `Action "${action}" is not supported in playwright mode yet. Supported: ${PLAYWRIGHT_SUPPORTED_ACTIONS.join(', ')}`,
    };
  }
  if (action === 'close') {
    await pwContext.close();
    pwContext = null;
    pwCurrentPageIndex = 0;
    pwNetworkLoggerAttached = false;
    pwNetworkLog = [];
    return { success: true, data: 'Browser closed' };
  }

  const pages = pwContext.pages();
  if (pages.length === 0) {
    await pwContext.newPage();
  }
  const livePages = pwContext.pages();
  if (pwCurrentPageIndex >= livePages.length) pwCurrentPageIndex = Math.max(0, livePages.length - 1);
  const page = livePages[pwCurrentPageIndex];

  const selector = command.selector ? resolveSelector(String(command.selector), command.by) : '';
  const timeoutMs = Number(command.timeout ?? 10) * 1000;
  const clear = command.clear !== false;

  try {
    switch (action) {
      case 'navigate': {
        const url = String(command.url || '');
        if (!url) return { success: false, error: 'navigate requires url' };
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        return { success: true, data: { url: page.url(), title: await page.title() } };
      }
      case 'back':
        await page.goBack({ waitUntil: 'domcontentloaded' });
        return { success: true, data: page.url() };
      case 'forward':
        await page.goForward({ waitUntil: 'domcontentloaded' });
        return { success: true, data: page.url() };
      case 'refresh':
        await page.reload({ waitUntil: 'domcontentloaded' });
        return { success: true, data: page.url() };
      case 'get_page': {
        const text = await page.innerText('body');
        return { success: true, data: text };
      }
      case 'get_html':
        return { success: true, data: await page.content() };
      case 'execute_js': {
        const script = String(command.script || '');
        if (!script) return { success: false, error: 'execute_js requires script' };
        const result = await page.evaluate(`(() => { ${script} })()`);
        return { success: true, data: result };
      }
      case 'find': {
        if (!selector) return { success: false, error: 'find requires selector' };
        const count = await page.locator(selector).count();
        const limit = Number(command.limit ?? 10);
        const items: string[] = [];
        for (let i = 0; i < Math.min(count, limit); i++) {
          const handle = page.locator(selector).nth(i);
          const txt = (await handle.innerText().catch(() => '')).trim();
          if (txt) items.push(txt.slice(0, 200));
        }
        return { success: true, data: { count, samples: items } };
      }
      case 'cookies': {
        const targetUrl = command.url ? String(command.url) : undefined;
        const cookies = targetUrl ? await pwContext.cookies([targetUrl]) : await pwContext.cookies();
        return { success: true, data: cookies };
      }
      case 'set_cookie': {
        const raw = (command.data as Record<string, unknown>) || {};
        const name = String(command.name ?? raw.name ?? '');
        const value = String(command.value ?? raw.value ?? '');
        if (!name || !value) return { success: false, error: 'set_cookie requires name and value' };
        const cookie: Record<string, unknown> = {
          name,
          value,
          path: String(command.path ?? raw.path ?? '/'),
        };
        const url = String(command.url ?? raw.url ?? page.url() ?? '');
        const domain = String(command.domain ?? raw.domain ?? '');
        if (url) cookie.url = url;
        if (domain) cookie.domain = domain;
        if (raw.expires !== undefined) cookie.expires = Number(raw.expires);
        if (raw.httpOnly !== undefined) cookie.httpOnly = raw.httpOnly === true;
        if (raw.secure !== undefined) cookie.secure = raw.secure === true;
        if (raw.sameSite !== undefined) cookie.sameSite = raw.sameSite;
        await pwContext.addCookies([cookie]);
        return { success: true, data: `cookie ${name} set` };
      }
      case 'delete_cookie': {
        const cookieName = String(command.name ?? command.cookie_name ?? '');
        if (!cookieName) return { success: false, error: 'delete_cookie requires name' };
        const current = await pwContext.cookies();
        const remaining = current.filter((c: any) => c.name !== cookieName);
        await pwContext.clearCookies();
        if (remaining.length > 0) {
          await pwContext.addCookies(remaining);
        }
        return { success: true, data: `cookie ${cookieName} deleted` };
      }
      case 'delete_cookies':
        await pwContext.clearCookies();
        return { success: true, data: 'all cookies cleared' };
      case 'inject_network_logger': {
        if (!pwNetworkLoggerAttached) {
          pwContext.on('request', (request: any) => {
            pwNetworkLog.push({
              type: 'request',
              url: request.url(),
              method: request.method(),
              resourceType: request.resourceType ? request.resourceType() : undefined,
              timestamp: Date.now(),
            });
            if (pwNetworkLog.length > 500) pwNetworkLog = pwNetworkLog.slice(-500);
          });
          pwContext.on('response', (response: any) => {
            pwNetworkLog.push({
              type: 'response',
              url: response.url(),
              status: response.status(),
              ok: response.ok(),
              timestamp: Date.now(),
            });
            if (pwNetworkLog.length > 500) pwNetworkLog = pwNetworkLog.slice(-500);
          });
          pwNetworkLoggerAttached = true;
        }
        return { success: true, data: 'network logger enabled' };
      }
      case 'get_network_log': {
        const limit = Number(command.limit ?? 100);
        return { success: true, data: pwNetworkLog.slice(-limit) };
      }
      case 'clear_network_log':
        pwNetworkLog = [];
        return { success: true, data: 'network log cleared' };
      case 'find_in_shadow': {
        const hostSelector = String(command.host_selector || '');
        const shadowSelector = String(command.shadow_selector || '');
        if (!hostSelector || !shadowSelector) {
          return { success: false, error: 'find_in_shadow requires host_selector and shadow_selector' };
        }
        const limit = Number(command.limit ?? 20);
        const data = await page.evaluate(({ host, shadow, max }) => {
          const hosts = Array.from(document.querySelectorAll(host));
          const matches: Array<{ hostTag: string; tag: string; text: string }> = [];
          for (const hostNode of hosts) {
            const root = (hostNode as HTMLElement).shadowRoot;
            if (!root) continue;
            const nodes = Array.from(root.querySelectorAll(shadow));
            for (const node of nodes) {
              matches.push({
                hostTag: hostNode.tagName.toLowerCase(),
                tag: node.tagName.toLowerCase(),
                text: (((node as HTMLElement).innerText || node.textContent || '').trim()).slice(0, 200),
              });
              if (matches.length >= max) break;
            }
            if (matches.length >= max) break;
          }
          return { count: matches.length, matches };
        }, { host: hostSelector, shadow: shadowSelector, max: limit });
        return { success: true, data };
      }
      case 'click_in_shadow': {
        const hostSelector = String(command.host_selector || '');
        const shadowSelector = String(command.shadow_selector || '');
        if (!hostSelector || !shadowSelector) {
          return { success: false, error: 'click_in_shadow requires host_selector and shadow_selector' };
        }
        const clicked = await page.evaluate(({ host, shadow }) => {
          const hostNode = document.querySelector(host) as HTMLElement | null;
          if (!hostNode || !hostNode.shadowRoot) return false;
          const target = hostNode.shadowRoot.querySelector(shadow) as HTMLElement | null;
          if (!target) return false;
          target.click();
          return true;
        }, { host: hostSelector, shadow: shadowSelector });
        if (!clicked) return { success: false, error: 'No matching shadow element to click' };
        return { success: true, data: 'clicked shadow element' };
      }
      case 'find_text': {
        const needle = String(command.text || '').trim();
        if (!needle) return { success: false, error: 'find_text requires text' };
        const exact = command.exact === true;
        const tag = command.tag ? String(command.tag).toLowerCase() : '';
        const limit = Number(command.limit ?? 20);
        const result = await page.evaluate(({ search, exactMatch, tagName, max }) => {
          const nodes = tagName
            ? Array.from(document.querySelectorAll(tagName))
            : Array.from(document.querySelectorAll('a,button,input,textarea,select,label,[role],p,span,div'));
          const matches: Array<{ tag: string; text: string; role: string; ariaLabel: string }> = [];
          const lowered = search.toLowerCase();
          for (const node of nodes) {
            const raw = ((node as HTMLElement).innerText || node.textContent || '').trim();
            if (!raw) continue;
            const ok = exactMatch ? raw === search : raw.toLowerCase().includes(lowered);
            if (!ok) continue;
            matches.push({
              tag: node.tagName.toLowerCase(),
              text: raw.slice(0, 200),
              role: node.getAttribute('role') || '',
              ariaLabel: node.getAttribute('aria-label') || '',
            });
            if (matches.length >= max) break;
          }
          return { count: matches.length, matches };
        }, {
          search: needle,
          exactMatch: exact,
          tagName: tag,
          max: limit,
        });
        return { success: true, data: result };
      }
      case 'click_text': {
        const needle = String(command.text || '').trim();
        if (!needle) return { success: false, error: 'click_text requires text' };
        const exact = command.exact === true;
        const tag = command.tag ? String(command.tag).toLowerCase() : '';
        if (tag) {
          const nodes = page.locator(tag);
          const count = await nodes.count();
          const lowered = needle.toLowerCase();
          for (let i = 0; i < count; i++) {
            const node = nodes.nth(i);
            const text = (await node.innerText().catch(() => '')).trim();
            if (!text) continue;
            const ok = exact ? text === needle : text.toLowerCase().includes(lowered);
            if (!ok) continue;
            await node.click({ timeout: timeoutMs });
            return { success: true, data: { clicked: true, text: text.slice(0, 200), index: i } };
          }
          return { success: false, error: `No matching ${tag} element found for text "${needle}"` };
        }
        const locator = exact
          ? page.getByText(needle, { exact: true }).first()
          : page.getByText(needle).first();
        await locator.click({ timeout: timeoutMs });
        return { success: true, data: { clicked: true, text: needle } };
      }
      case 'get_interactive': {
        const limit = Number(command.limit ?? 200);
        const data = await page.evaluate((max) => {
          const selector = 'a,button,input,textarea,select,[role],summary,[tabindex],[onclick]';
          const elements = Array.from(document.querySelectorAll(selector));
          return elements.slice(0, max).map((el, index) => ({
            index,
            tag: el.tagName.toLowerCase(),
            id: (el as HTMLElement).id || '',
            role: el.getAttribute('role') || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            text: (((el as HTMLElement).innerText || el.textContent || '').trim()).slice(0, 200),
            disabled: (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
          }));
        }, limit);
        return { success: true, data };
      }
      case 'get_aria_tree': {
        const maxDepth = Number(command.max_depth ?? 5);
        const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
        const prune = (node: any, depth: number): any => {
          if (!node || depth > maxDepth) return null;
          const next = {
            role: node.role,
            name: node.name,
            value: node.value,
            description: node.description,
            children: Array.isArray(node.children)
              ? node.children.map((child: any) => prune(child, depth + 1)).filter(Boolean)
              : [],
          };
          return next;
        };
        return { success: true, data: prune(snapshot, 0) };
      }
      case 'check_accessibility': {
        const report = await page.evaluate(() => {
          const imagesWithoutAlt = Array.from(document.querySelectorAll('img')).filter(img => !(img.getAttribute('alt') || '').trim()).length;
          const inputsWithoutLabel = Array.from(document.querySelectorAll('input,textarea,select')).filter(field => {
            const id = field.getAttribute('id');
            const aria = field.getAttribute('aria-label');
            const labelledBy = field.getAttribute('aria-labelledby');
            if ((aria || '').trim() || (labelledBy || '').trim()) return false;
            if (!id) return true;
            return !document.querySelector(`label[for="${id}"]`);
          }).length;
          const buttonsWithoutName = Array.from(document.querySelectorAll('button,[role="button"]')).filter(btn => {
            const text = ((btn as HTMLElement).innerText || btn.textContent || '').trim();
            const aria = btn.getAttribute('aria-label') || '';
            return !text && !aria.trim();
          }).length;
          return {
            imagesWithoutAlt,
            inputsWithoutLabel,
            buttonsWithoutName,
            passed: imagesWithoutAlt === 0 && inputsWithoutLabel === 0 && buttonsWithoutName === 0,
          };
        });
        return { success: true, data: report };
      }
      case 'get_aria_info': {
        const targetSelector = selector || 'body';
        const info = await page.locator(targetSelector).first().evaluate((el) => ({
          role: el.getAttribute('role') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          ariaLabelledBy: el.getAttribute('aria-labelledby') || '',
          ariaDescribedBy: el.getAttribute('aria-describedby') || '',
          ariaExpanded: el.getAttribute('aria-expanded') || '',
          ariaHidden: el.getAttribute('aria-hidden') || '',
          tag: el.tagName.toLowerCase(),
          text: (((el as HTMLElement).innerText || el.textContent || '').trim()).slice(0, 200),
        }));
        return { success: true, data: info };
      }
      case 'control_media': {
        const mediaAction = String(command.media_action || '');
        if (!mediaAction) return { success: false, error: 'control_media requires media_action' };
        const result = await page.evaluate((actionName) => {
          const media = document.querySelector('video, audio') as HTMLMediaElement | null;
          if (!media) return { ok: false, error: 'No media element found' };
          if (actionName === 'play') media.play();
          else if (actionName === 'pause') media.pause();
          else if (actionName === 'mute') media.muted = true;
          else if (actionName === 'unmute') media.muted = false;
          else return { ok: false, error: `Unsupported media action: ${actionName}` };
          return { ok: true, paused: media.paused, muted: media.muted, currentTime: media.currentTime };
        }, mediaAction);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, data: result };
      }
      case 'get_media_state': {
        const state = await page.evaluate(() => {
          const media = document.querySelector('video, audio') as HTMLMediaElement | null;
          if (!media) return null;
          return {
            tag: media.tagName.toLowerCase(),
            paused: media.paused,
            muted: media.muted,
            currentTime: media.currentTime,
            duration: Number.isFinite(media.duration) ? media.duration : null,
            volume: media.volume,
            ended: media.ended,
          };
        });
        if (!state) return { success: false, error: 'No media element found' };
        return { success: true, data: state };
      }
      case 'seek_media': {
        const seekTo = Number(command.time ?? command.seek_time ?? 0);
        const result = await page.evaluate((target) => {
          const media = document.querySelector('video, audio') as HTMLMediaElement | null;
          if (!media) return { ok: false, error: 'No media element found' };
          media.currentTime = target;
          return { ok: true, currentTime: media.currentTime };
        }, seekTo);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, data: result };
      }
      case 'click':
      case 'trusted_click':
      case 'human_click': {
        if (!selector) return { success: false, error: `${action} requires selector` };
        await page.click(selector, { timeout: timeoutMs });
        return { success: true, data: 'clicked' };
      }
      case 'type':
      case 'human_type': {
        if (!selector) return { success: false, error: `${action} requires selector` };
        const text = String(command.text || '');
        if (clear) {
          await page.fill(selector, text, { timeout: timeoutMs });
        } else {
          await page.type(selector, text, { timeout: timeoutMs });
        }
        return { success: true, data: 'typed' };
      }
      case 'wait':
        await page.waitForTimeout(timeoutMs);
        return { success: true, data: `waited ${timeoutMs}ms` };
      case 'wait_element': {
        if (!selector) return { success: false, error: 'wait_element requires selector' };
        const condition = String(command.condition || 'present');
        const state = condition === 'invisible' ? 'hidden' : (condition === 'present' ? 'attached' : 'visible');
        await page.waitForSelector(selector, { state: state as any, timeout: timeoutMs });
        return { success: true, data: 'element condition met' };
      }
      case 'screenshot':
      case 'screenshot_full': {
        const shot = await page.screenshot({ fullPage: action === 'screenshot_full' });
        return { success: true, data: shot.toString('base64') };
      }
      case 'screenshot_element': {
        if (!selector) return { success: false, error: 'screenshot_element requires selector' };
        const shot = await page.locator(selector).first().screenshot();
        return { success: true, data: shot.toString('base64') };
      }
      case 'tabs': {
        const tabInfo = pwContext.pages().map((p: any, idx: number) => ({
          index: idx,
          url: p.url(),
          active: idx === pwCurrentPageIndex,
        }));
        return { success: true, data: tabInfo };
      }
      case 'new_tab': {
        const newPage = await pwContext.newPage();
        if (command.url) {
          await newPage.goto(String(command.url), { waitUntil: 'domcontentloaded' });
        }
        pwCurrentPageIndex = pwContext.pages().length - 1;
        return { success: true, data: { index: pwCurrentPageIndex, url: newPage.url() } };
      }
      case 'switch_tab': {
        const target = Number(command.index ?? 0);
        const list = pwContext.pages();
        if (!Number.isInteger(target) || target < 0 || target >= list.length) {
          return { success: false, error: `Invalid tab index: ${target}` };
        }
        pwCurrentPageIndex = target;
        await list[pwCurrentPageIndex].bringToFront();
        return { success: true, data: { index: pwCurrentPageIndex, url: list[pwCurrentPageIndex].url() } };
      }
      case 'close_tab': {
        const list = pwContext.pages();
        if (list.length === 0) return { success: true, data: 'No tab to close' };
        await list[pwCurrentPageIndex].close();
        const remaining = pwContext.pages();
        if (remaining.length === 0) {
          await pwContext.newPage();
        }
        pwCurrentPageIndex = Math.max(0, Math.min(pwCurrentPageIndex, pwContext.pages().length - 1));
        return { success: true, data: 'tab closed' };
      }
      case 'press_key': {
        const key = String(command.key || '');
        if (!key) return { success: false, error: 'press_key requires key' };
        await page.keyboard.press(key);
        return { success: true, data: `pressed ${key}` };
      }
      case 'key_combo': {
        const keys = String(command.keys || '');
        if (!keys) return { success: false, error: 'key_combo requires keys' };
        await page.keyboard.press(keys);
        return { success: true, data: `pressed ${keys}` };
      }
      case 'scroll': {
        const direction = String(command.direction || 'down');
        const amount = Number(command.amount ?? 500);
        const dy = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
        await page.evaluate((value: number) => window.scrollBy(0, value), dy);
        return { success: true, data: `scrolled ${direction}` };
      }
      case 'scroll_to': {
        if (!selector) return { success: false, error: 'scroll_to requires selector' };
        await page.locator(selector).first().scrollIntoViewIfNeeded();
        return { success: true, data: 'scrolled into view' };
      }
      default:
        return { success: false, error: `Unsupported playwright action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Execute a single command (internal - called by queue processor) */
async function executeCommand(command: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (browserEngine === 'playwright') {
    return executePlaywrightCommand(command);
  }
  return executeSeleniumCommand(command);
}

/** Check if an error indicates the browser process died */
function isBrowserDeadError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  if (browserEngine === 'playwright') {
    return msg.includes('browser has been closed') ||
      msg.includes('target page, context or browser has been closed') ||
      msg.includes('closed');
  }
  return msg.includes('process exited') ||
         msg.includes('epipe') ||
         msg.includes('channel closed') ||
         msg.includes('not running');
}

/** Force restart the browser process */
async function restartBrowser(): Promise<void> {
  console.log('[browser] Restarting browser process...');
  if (browserEngine === 'playwright') {
    if (pwContext) {
      try {
        await pwContext.close();
      } catch { /* ignore */ }
    }
    pwContext = null;
    pwCurrentPageIndex = 0;
    pwNetworkLoggerAttached = false;
    pwNetworkLog = [];
    await ensureBrowser();
    console.log('[browser] Playwright browser restarted successfully');
    return;
  }
  
  // Try to send close command to properly quit Chrome before killing process
  if (pyProc && !pyProc.killed && browserStarted) {
    try {
      // Send close command to gracefully shut down Chrome
      await executeCommand({ action: 'close' });
    } catch { /* ignore - process might be dead */ }
  }
  
  // Kill existing process
  if (pyProc && !pyProc.killed) {
    try {
      pyProc.kill('SIGTERM');
    } catch { /* ignore */ }
  }
  pyProc = null;
  browserStarted = false;
  responseBuffer = '';
  // Clear all session states
  for (const sessionId of sessionCommandRunning) {
    sessionCommandRunning.delete(sessionId);
  }
  sessionCommandQueues.clear();
  // Clear tab mappings since browser is dead
  sessionTabMap.clear();
  // Clear pending handlers
  pendingResolve = null;
  pendingReject = null;
  // Start fresh
  await ensureBrowser();
  console.log('[browser] Browser restarted successfully');
}

/** Ensure browser is ready - all sessions share full browser access */
async function ensureSessionTab(sessionId: string): Promise<void> {
  // Just ensure browser is running, no tab isolation needed
  // Sessions can freely use all tabs, switch between them, create/close as needed
  await ensureBrowser();
}

/** Process the next command in a session's queue */
async function processSessionQueue(sessionId: string): Promise<void> {
  // Don't process if already running or no commands queued
  if (sessionCommandRunning.has(sessionId) || !sessionCommandQueues.has(sessionId) || sessionCommandQueues.get(sessionId)!.length === 0) {
    return;
  }

  sessionCommandRunning.add(sessionId);
  const queue = sessionCommandQueues.get(sessionId)!;
  const { command, sessionId: cmdSessionId, resolve, reject } = queue.shift()!;

  // Clean up empty queue
  if (queue.length === 0) {
    sessionCommandQueues.delete(sessionId);
  }

  try {
    // ATOMIC: Switch to session's tab THEN execute command
    // This happens inside the queue processor so no other command can interleave
    if (cmdSessionId) {
      await ensureSessionTab(cmdSessionId);
    }

    const result = await executeCommand(command);
    resolve(result);
  } catch (err) {
    // If browser died, try to restart and retry once
    if (isBrowserDeadError(err as Error)) {
      try {
        await restartBrowser();
        // Re-ensure tab after restart
        if (cmdSessionId) {
          await ensureSessionTab(cmdSessionId);
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
    sessionCommandRunning.delete(sessionId);
    // Process next command in this session's queue if any
    if (sessionCommandQueues.has(sessionId) && sessionCommandQueues.get(sessionId)!.length > 0) {
      processSessionQueue(sessionId);
    }
  }
}

/** Queue a command for execution in the appropriate session queue */
async function cmd(command: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
  await ensureBrowser();

  // Use a default session ID if none provided
  const actualSessionId = sessionId || 'default';

  return new Promise((resolve, reject) => {
    // Create or get the queue for this session
    if (!sessionCommandQueues.has(actualSessionId)) {
      sessionCommandQueues.set(actualSessionId, []);
    }
    const queue = sessionCommandQueues.get(actualSessionId)!;
    
    queue.push({ command, sessionId: actualSessionId, resolve, reject });
    processSessionQueue(actualSessionId);
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
  'click', 'click_position', 'trusted_click', 'type', 'find', 'scroll', 'scroll_to', 'hover', 'double_click', 'right_click', 'drag',
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
  'close', 'reload_config',
] as const;

const PLAYWRIGHT_SUPPORTED_ACTIONS = [
  'navigate', 'back', 'forward', 'refresh',
  'get_page', 'get_html', 'execute_js',
  'find', 'find_text', 'click_text',
  'cookies', 'set_cookie', 'delete_cookie', 'delete_cookies',
  'inject_network_logger', 'get_network_log', 'clear_network_log',
  'find_in_shadow', 'click_in_shadow',
  'click', 'trusted_click', 'human_click',
  'type', 'human_type',
  'wait', 'wait_element',
  'screenshot', 'screenshot_full', 'screenshot_element',
  'tabs', 'new_tab', 'switch_tab', 'close_tab',
  'press_key', 'key_combo',
  'scroll', 'scroll_to',
  'control_media', 'get_media_state', 'seek_media',
  'get_interactive', 'get_aria_tree', 'check_accessibility', 'get_aria_info',
  'close',
] as const;

export function getPlaywrightSupportedActions(): string[] {
  return [...PLAYWRIGHT_SUPPORTED_ACTIONS];
}

// ============================================================================
// Single unified browser tool — all actions via one tool with action parameter
// ============================================================================

export const browserTools: Tool[] = [
  {
    name: 'browser',
    description: [
      'Control a browser with selectable backend: Playwright (preferred) or Selenium legacy (deprecated).',
      'Playwright mode uses the existing local Chromium binary (no auto browser installation).',
      '',
      'WHEN TO USE:',
      '- Interacting with websites that have anti-bot measures',
      '- Filling out complex forms or authentication',
      '- Scraping dynamic content loaded by JavaScript',
      '- Taking screenshots of web pages or elements',
      '- Automating repetitive web-based tasks',
      '- Testing website functionality',
      '- Performing research across multiple sites',
      '- Interacting with single-page applications (SPAs)',
      '',
      'STEALTH FEATURES:',
      '- Anti-detection: bypasses most bot detection systems',
      '- Fingerprint spoofing: appears as normal browser',
      '- Human-like behavior: mimics natural mouse movements and typing',
      '- Headless operation: runs without visible UI',
      '',
      'NAVIGATION ACTIONS:',
      '- navigate: go to a specific URL',
      '- back/forward: browser history navigation',
      '- refresh: reload current page',
      '',
      'SCREENSHOT ACTIONS:',
      '- screenshot: capture visible viewport',
      '- screenshot_full: capture entire page (scrolling)',
      '- screenshot_element: capture specific element',
      '',
      'INTERACTION ACTIONS:',
      '- click: click element by selector',
      '- click_position: click at exact pixel coordinates (params: x, y)',
      '- type: enter text into input fields',
      '- find: locate elements by selector',
      '- scroll/scroll_to: scroll page or to element',
      '- hover/double_click/right_click/drag: additional mouse actions',
      '',
      'STEALTH INTERACTION ACTIONS:',
      '- human_click: click with human-like timing and movements',
      '- human_type: type with human-like speed and errors',
      '- human_scroll: scroll with natural acceleration/deceleration',
      '  human_type supports inline key commands: /enter, /tab, /escape, /backspace, /space, /up/down/left/right',
      '  Example: "hello/enterworld" types "hello", presses Enter, then types "world"',
      '',
      'PAGE CONTENT ACTIONS:',
      '- get_page: get rendered text content',
      '- get_html: get page HTML source',
      '- execute_js: run JavaScript in browser context',
      '- save_html: save page HTML to file',
      '',
      'FORM ACTIONS:',
      '- fill_form: populate multiple form fields at once',
      '- select: choose from dropdown/select elements',
      '- submit: submit forms',
      '- find_forms: locate forms on page',
      '- upload: upload files to forms',
      '',
      'WAITING ACTIONS:',
      '- wait_element: wait for element to appear/disappear',
      '- wait: wait for specified time',
      '',
      'STORAGE ACTIONS:',
      '- cookies: manage browser cookies',
      '- local_storage_*: manage localStorage',
      '- session_storage_*: manage sessionStorage',
      '',
      'TAB ACTIONS:',
      '- tabs: list available tabs',
      '- new_tab: open new tab',
      '- switch_tab: switch between tabs',
      '- close_tab: close current tab',
      '',
      'ADVANCED ACTIONS:',
      '- get_interactive: list all clickable elements with labels and positions',
      '- get_aria_tree: get accessibility tree (useful for React/SPA with dynamic classes)',
      '- click_text/find_text: interact with elements by visible text (no selectors needed)',
      '- google_search/duckduckgo_search: quick search shortcuts',
      '- set_geolocation: spoof GPS coordinates',
      '- print_to_pdf: generate PDF from page',
      '- emulate_device: mobile/tablet emulation',
      '- inject_network_logger: intercept network requests',
      '',
      'HOW TO USE:',
      '- Start with: browser(action="navigate", url="https://example.com")',
      '- Find elements: browser(action="find", selector="button.submit")',
      '- Click elements: browser(action="click", selector="input#name")',
      '- Enter text: browser(action="type", selector="input#name", text="John")',
      '- For SPAs: use click_text/find_text instead of selectors when classes are randomized',
      '',
      'SAFETY NOTES:',
      '- Automatically handles session isolation for different conversations',
      '- Resilient to browser crashes with auto-restart capability',
      '- Respects robots.txt and ethical scraping practices',
      '- Some sites may still detect automation despite stealth measures',
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
        // Config reload
        config: { type: 'object', description: 'New browser config for reload_config action (extensions, headless, profile_dir, etc.)' },
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
        'properties', 'color', 'duration', 'config',
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
        catch {
          pyProc = null;
          browserStarted = false;
          pwContext = null;
          pwCurrentPageIndex = 0;
          return { output: 'Browser closed' };
        }
      }

      // ── Execute command directly with session context for queue ordering ──
      // All sessions share full browser access - no tab isolation
      const result = await cmd(command, sessionId);

      // Actions that should trigger auto-screenshot (page state changes)
      const SCREENSHOT_ACTIONS = [
        'navigate', 'back', 'forward', 'refresh',
        'click', 'click_position', 'trusted_click', 'double_click', 'right_click',
        'human_click', 'human_type', 'human_scroll',
        'type', 'fill_form', 'select', 'submit', 'upload',
        'scroll', 'scroll_to',
        'switch_tab', 'new_tab', 'close_tab',
        'switch_frame', 'alert',
        'press_key', 'key_combo',
        'execute_js', 'drag',
        'click_text',
        'google_search', 'duckduckgo_search',
        'set_geolocation', 'emulate_device',
        'hover',
      ];

      // Auto-screenshot after page-changing actions (replaces previous screenshot)
      if (result.success && SCREENSHOT_ACTIONS.includes(action)) {
        try {
          const screenshotResult = await cmd({ action: 'screenshot_full' }, sessionId);
          const base64Data = screenshotResult.data as string;
          if (base64Data && imageBroadcaster && ctx?.sessionId) {
            // Use 'browser-current' as ID to replace previous screenshots
            imageBroadcaster({
              type: 'image',
              sessionId: ctx.sessionId,
              base64: base64Data,
              mimeType: 'image/png',
              alt: 'Browser',
              filename: `browser-current.png`,
              id: 'browser-current', // Fixed ID to replace previous
            });
          }
        } catch (e) {
          // Screenshot failed, don't break the flow
        }
      }

      // For explicit screenshot actions, broadcast with high quality
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
            id: 'browser-current', // Replace auto-screenshot with explicit one
          });
        }
      }

      return { output: fmt(result) };
    },
  },
];
