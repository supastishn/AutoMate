import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setBrowserConfig, getBrowserRuntimeConfig, detectSystemBrowserBinaries } from '../src/agent/tools/browser.js';

describe('Browser runtime config', () => {
  test('tracks browser engine and system binary paths', () => {
    const dir = join(tmpdir(), `automate-browser-config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    const chromium = join(dir, 'chromium');
    const chromedriver = join(dir, 'chromedriver');
    writeFileSync(chromium, '');
    writeFileSync(chromedriver, '');

    setBrowserConfig({
      engine: 'playwright',
      chromiumPath: chromium,
      chromeDriverPath: chromedriver,
      headless: false,
    } as any);

    const cfg = getBrowserRuntimeConfig();
    assert.equal(cfg.engine, 'playwright');
    assert.equal(cfg.chromiumPath, chromium);
    assert.equal(cfg.chromeDriverPath, chromedriver);
    assert.equal(cfg.headless, false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('detects chromium and chromedriver via which-style resolver', () => {
    const detected = detectSystemBrowserBinaries((bin) => {
      if (bin === 'chromium') return '/data/data/com.termux/files/usr/bin/chromium';
      if (bin === 'chromedriver') return '/data/data/com.termux/files/usr/bin/chromedriver';
      return '';
    });
    assert.equal(detected.chromiumPath, '/data/data/com.termux/files/usr/bin/chromium');
    assert.equal(detected.chromeDriverPath, '/data/data/com.termux/files/usr/bin/chromedriver');
  });
});
