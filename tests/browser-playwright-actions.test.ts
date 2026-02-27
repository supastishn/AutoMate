import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getPlaywrightSupportedActions } from '../src/agent/tools/browser.js';

describe('Playwright action coverage', () => {
  test('includes accessibility-oriented actions', () => {
    const actions = getPlaywrightSupportedActions();
    assert.ok(actions.includes('get_aria_tree'));
    assert.ok(actions.includes('get_interactive'));
    assert.ok(actions.includes('find_text'));
    assert.ok(actions.includes('click_text'));
    assert.ok(actions.includes('check_accessibility'));
    assert.ok(actions.includes('get_aria_info'));
  });

  test('includes cookies, network, shadow-dom, and media actions', () => {
    const actions = getPlaywrightSupportedActions();
    assert.ok(actions.includes('cookies'));
    assert.ok(actions.includes('set_cookie'));
    assert.ok(actions.includes('delete_cookie'));
    assert.ok(actions.includes('delete_cookies'));
    assert.ok(actions.includes('inject_network_logger'));
    assert.ok(actions.includes('get_network_log'));
    assert.ok(actions.includes('clear_network_log'));
    assert.ok(actions.includes('find_in_shadow'));
    assert.ok(actions.includes('click_in_shadow'));
    assert.ok(actions.includes('control_media'));
    assert.ok(actions.includes('get_media_state'));
    assert.ok(actions.includes('seek_media'));
  });
});
