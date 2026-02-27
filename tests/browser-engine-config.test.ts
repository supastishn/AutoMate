import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Browser Engine Config', () => {
  test('uses a single prefs block that includes popup allowances', () => {
    const enginePath = join(process.cwd(), 'src', 'browser', 'engine.py');
    const source = readFileSync(enginePath, 'utf-8');

    const prefsCalls = source.match(/add_experimental_option\("prefs"/g) ?? [];
    assert.equal(prefsCalls.length, 1, 'Engine should only set Chrome prefs once');

    const prefsBlockMatch = source.match(
      /prefs\s*=\s*\{([\s\S]*?)\n\s*\}\n\s*opts\.add_experimental_option\("prefs", prefs\)/,
    );
    assert.ok(prefsBlockMatch, 'Expected to find final Chrome prefs block');

    const prefsBlock = prefsBlockMatch[1];
    assert.ok(
      prefsBlock.includes('"profile.default_content_setting_values.popups": 1'),
      'Popup allowance should be present in prefs block',
    );
    assert.ok(
      prefsBlock.includes('"profile.managed_default_content_settings.popups": 1'),
      'Managed popup allowance should be present in prefs block',
    );

    assert.ok(
      source.includes('and not extensions_enabled'),
      'Headless fallback should be disabled when extensions are configured',
    );
  });
});
