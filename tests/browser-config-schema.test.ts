import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema } from '../src/config/schema.js';

describe('Browser config schema', () => {
  test('defaults to playwright engine and system binary paths', () => {
    const config = ConfigSchema.parse({});
    assert.equal(config.browser.engine, 'playwright');
    assert.equal(config.browser.chromiumPath, '/usr/bin/chromium');
    assert.equal(config.browser.chromeDriverPath, '/usr/bin/chromedriver');
  });

  test('accepts selenium engine explicitly', () => {
    const config = ConfigSchema.parse({
      browser: {
        engine: 'selenium',
      },
    });
    assert.equal(config.browser.engine, 'selenium');
  });
});
