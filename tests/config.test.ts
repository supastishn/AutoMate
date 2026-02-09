/**
 * Config & Schema Integration Tests
 * 
 * Tests that config loading, parsing, validation, path resolution,
 * and directory creation all work with real filesystem operations.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigSchema } from '../src/config/schema.js';
import { loadConfig, resolveHome, saveConfig } from '../src/config/loader.js';

const TEST_DIR = join(tmpdir(), `automate-test-config-${Date.now()}`);

describe('ConfigSchema', () => {
  test('parses empty object with all defaults', () => {
    const config = ConfigSchema.parse({});
    assert.equal(config.agent.model, 'claude-opus-4.6');
    assert.equal(config.gateway.port, 18789);
    assert.equal(config.gateway.host, '127.0.0.1');
    assert.equal(config.gateway.auth.mode, 'token');
    assert.equal(config.channels.discord.enabled, false);
    assert.equal(config.browser.enabled, true);
    assert.equal(config.browser.headless, true);
    assert.equal(config.cron.enabled, true);
    assert.equal(config.canvas.enabled, true);
    assert.equal(config.plugins.enabled, true);
    assert.equal(config.heartbeat.enabled, false);
    assert.equal(config.heartbeat.intervalMinutes, 30);
    assert.equal(config.sessions.maxHistory, 200);
    assert.equal(config.sessions.compactThreshold, 150);
    assert.equal(config.sessions.autoResetHour, -1);
    assert.equal(config.memory.embedding.enabled, true);
    assert.equal(config.memory.embedding.chunkSize, 512);
    assert.equal(config.memory.embedding.chunkOverlap, 64);
    assert.equal(config.memory.embedding.vectorWeight, 0.6);
    assert.equal(config.memory.embedding.bm25Weight, 0.4);
    assert.equal(config.memory.embedding.topK, 10);
    assert.equal(config.webhooks.enabled, false);
  });

  test('parses custom values correctly', () => {
    const config = ConfigSchema.parse({
      agent: { model: 'gpt-4o', temperature: 0.7, maxTokens: 4096 },
      gateway: { port: 9999, host: '0.0.0.0', auth: { mode: 'none' } },
      channels: { discord: { enabled: true, token: 'test-token', allowFrom: ['user1'] } },
      browser: { enabled: false, headless: false },
      heartbeat: { enabled: true, intervalMinutes: 15 },
    });
    assert.equal(config.agent.model, 'gpt-4o');
    assert.equal(config.agent.temperature, 0.7);
    assert.equal(config.agent.maxTokens, 4096);
    assert.equal(config.gateway.port, 9999);
    assert.equal(config.gateway.host, '0.0.0.0');
    assert.equal(config.gateway.auth.mode, 'none');
    assert.equal(config.channels.discord.enabled, true);
    assert.equal(config.channels.discord.token, 'test-token');
    assert.deepEqual(config.channels.discord.allowFrom, ['user1']);
    assert.equal(config.browser.enabled, false);
    assert.equal(config.heartbeat.enabled, true);
    assert.equal(config.heartbeat.intervalMinutes, 15);
  });

  test('rejects invalid auth mode', () => {
    assert.throws(() => {
      ConfigSchema.parse({
        gateway: { auth: { mode: 'invalid' } },
      });
    });
  });

  test('handles provider failover config', () => {
    const config = ConfigSchema.parse({
      agent: {
        providers: [
          { model: 'gpt-4o', apiBase: 'https://api.openai.com/v1', priority: 10 },
          { model: 'llama3', apiBase: 'http://localhost:11434/v1', priority: 20 },
        ],
      },
    });
    assert.equal(config.agent.providers.length, 2);
    assert.equal(config.agent.providers[0].model, 'gpt-4o');
    assert.equal(config.agent.providers[0].priority, 10);
    assert.equal(config.agent.providers[1].model, 'llama3');
  });

  test('handles agent profiles config', () => {
    const config = ConfigSchema.parse({
      agents: [
        { name: 'researcher', channels: ['discord:*'], allowFrom: ['user1'] },
        { name: 'coder', channels: ['webchat:*'], allowFrom: ['*'] },
      ],
    });
    assert.equal(config.agents.length, 2);
    assert.equal(config.agents[0].name, 'researcher');
    assert.deepEqual(config.agents[0].channels, ['discord:*']);
    assert.equal(config.agents[1].name, 'coder');
  });

  test('tool policy defaults to empty arrays', () => {
    const config = ConfigSchema.parse({});
    assert.deepEqual(config.tools.allow, []);
    assert.deepEqual(config.tools.deny, []);
  });
});

describe('Config Loader', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('resolveHome replaces ~ with homedir', () => {
    const resolved = resolveHome('~/test/path');
    assert.ok(!resolved.includes('~'));
    assert.ok(resolved.endsWith('/test/path'));
  });

  test('resolveHome handles absolute paths', () => {
    const resolved = resolveHome('/absolute/path');
    assert.equal(resolved, '/absolute/path');
  });

  test('loadConfig with valid JSON file', () => {
    const configPath = join(TEST_DIR, 'test-config.json');
    writeFileSync(configPath, JSON.stringify({
      agent: { model: 'test-model' },
      gateway: { port: 12345 },
      // Override dirs to temp so loadConfig doesn't pollute real dirs
      skills: { directory: join(TEST_DIR, 'skills') },
      sessions: { directory: join(TEST_DIR, 'sessions') },
      memory: { directory: join(TEST_DIR, 'memory'), sharedDirectory: join(TEST_DIR, 'shared') },
      cron: { directory: join(TEST_DIR, 'cron') },
      plugins: { directory: join(TEST_DIR, 'plugins') },
    }));

    const config = loadConfig(configPath);
    assert.equal(config.agent.model, 'test-model');
    assert.equal(config.gateway.port, 12345);

    // Verify directories were created
    assert.ok(existsSync(join(TEST_DIR, 'skills')));
    assert.ok(existsSync(join(TEST_DIR, 'sessions')));
    assert.ok(existsSync(join(TEST_DIR, 'memory')));
    assert.ok(existsSync(join(TEST_DIR, 'shared')));
    assert.ok(existsSync(join(TEST_DIR, 'cron')));
    assert.ok(existsSync(join(TEST_DIR, 'plugins')));
  });

  test('loadConfig with invalid JSON falls back to defaults', () => {
    const configPath = join(TEST_DIR, 'bad-config.json');
    writeFileSync(configPath, 'NOT VALID JSON {{{');

    // Should not throw -- falls back to defaults
    const config = loadConfig(configPath);
    assert.equal(config.agent.model, 'claude-opus-4.6');
  });

  test('loadConfig with missing file uses defaults', () => {
    const configPath = join(TEST_DIR, 'nonexistent.json');
    // loadConfig creates dirs with ~ paths, so override them
    // This would normally use defaults; we just test it doesn't crash
    const config = loadConfig(configPath);
    assert.equal(config.agent.model, 'claude-opus-4.6');
  });

  test('saveConfig writes valid JSON', () => {
    const configPath = join(TEST_DIR, 'save-test.json');
    saveConfig({ agent: { model: 'saved-model' } } as any, configPath);

    assert.ok(existsSync(configPath));
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.equal(raw.agent.model, 'saved-model');
  });
});
