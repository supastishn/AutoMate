/**
 * Agent Commands Integration Tests
 * 
 * Tests slash commands (/new, /status, /elevated, /model, /compact, etc.)
 * by constructing a real Agent with real SessionManager and MemoryManager.
 * These test the actual command handling code paths.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigSchema } from '../src/config/schema.js';
import { SessionManager } from '../src/gateway/session-manager.js';
import { MemoryManager } from '../src/memory/manager.js';
import { Agent } from '../src/agent/agent.js';
import { SkillsLoader } from '../src/skills/loader.js';

const TEST_DIR = join(tmpdir(), `automate-test-agent-${Date.now()}`);

describe('Agent Commands', () => {
  let agent: Agent;
  let sessionManager: SessionManager;
  let memoryManager: MemoryManager;
  let config: any;

  beforeEach(() => {
    const ts = Date.now();
    const subDir = join(TEST_DIR, `run-${ts}`);
    mkdirSync(subDir, { recursive: true });
    mkdirSync(join(subDir, 'sessions'), { recursive: true });
    mkdirSync(join(subDir, 'memory'), { recursive: true });
    mkdirSync(join(subDir, 'shared'), { recursive: true });
    mkdirSync(join(subDir, 'skills'), { recursive: true });
    mkdirSync(join(subDir, 'cron'), { recursive: true });
    mkdirSync(join(subDir, 'plugins'), { recursive: true });
    config = ConfigSchema.parse({
      agent: {
        model: 'test-model',
        apiBase: 'http://localhost:99999', // no real API
      },
      sessions: { directory: join(subDir, 'sessions') },
      memory: {
        directory: join(subDir, 'memory'),
        sharedDirectory: join(subDir, 'shared'),
        embedding: { enabled: false },
      },
      skills: { directory: join(subDir, 'skills') },
      cron: { directory: join(subDir, 'cron'), enabled: false },
      plugins: { directory: join(subDir, 'plugins'), enabled: false },
      browser: { enabled: false },
    });

    sessionManager = new SessionManager(config);
    memoryManager = new MemoryManager(config.memory.directory, {
      enabled: false, model: '', apiBase: '', chunkSize: 512,
      chunkOverlap: 64, vectorWeight: 0.6, bm25Weight: 0.4, topK: 10,
    });

    agent = new Agent(config, sessionManager);
    agent.setMemoryManager(memoryManager);

    const loader = new SkillsLoader(config);
    loader.loadAll();
    agent.setSkillsLoader(loader);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('/new resets session', () => {
    const sessionId = 'test:user1';
    sessionManager.getOrCreate('test', 'user1');
    sessionManager.addMessage(sessionId, { role: 'user', content: 'hello' });

    const result = agent.handleCommand(sessionId, '/new');
    assert.ok(result);
    assert.ok(result!.includes('reset'));
    assert.equal(sessionManager.getMessages(sessionId).length, 0);
  });

  test('/reset is alias for /new', () => {
    const result = agent.handleCommand('test:user1', '/reset');
    assert.ok(result);
    assert.ok(result!.includes('reset'));
  });

  test('/status shows session info', () => {
    const sessionId = 'test:user1';
    sessionManager.getOrCreate('test', 'user1');
    sessionManager.addMessage(sessionId, { role: 'user', content: 'hi' });

    const result = agent.handleCommand(sessionId, '/status');
    assert.ok(result);
    assert.ok(result!.includes('Session'));
    assert.ok(result!.includes('Messages'));
    assert.ok(result!.includes('Model'));
    assert.ok(result!.includes('test-model'));
    assert.ok(result!.includes('Elevated: OFF'));
  });

  test('/elevated on and off', () => {
    const sessionId = 'test:user1';

    const onResult = agent.handleCommand(sessionId, '/elevated on');
    assert.ok(onResult);
    assert.ok(onResult!.includes('ENABLED'));
    assert.ok(agent.isElevated(sessionId));

    const offResult = agent.handleCommand(sessionId, '/elevated off');
    assert.ok(offResult);
    assert.ok(offResult!.includes('DISABLED'));
    assert.ok(!agent.isElevated(sessionId));
  });

  test('/elevated status shows current state', () => {
    const sessionId = 'test:user1';
    const result = agent.handleCommand(sessionId, '/elevated');
    assert.ok(result);
    assert.ok(result!.includes('OFF'));
  });

  test('/compact compacts session', () => {
    const sessionId = 'test:user1';
    sessionManager.getOrCreate('test', 'user1');
    for (let i = 0; i < 15; i++) {
      sessionManager.addMessage(sessionId, { role: 'user', content: `msg ${i}` });
    }

    const result = agent.handleCommand(sessionId, '/compact');
    assert.ok(result);
    assert.ok(result!.includes('compact') || result!.includes('Compacted'));
  });

  test('/compact with instructions', () => {
    const sessionId = 'test:user1';
    sessionManager.getOrCreate('test', 'user1');
    for (let i = 0; i < 15; i++) {
      sessionManager.addMessage(sessionId, { role: 'user', content: `msg ${i}` });
    }

    const result = agent.handleCommand(sessionId, '/compact keep the API keys discussion');
    assert.ok(result);
    assert.ok(result!.includes('API keys'));
  });

  test('/model list shows providers', () => {
    const result = agent.handleCommand('test:user1', '/model');
    assert.ok(result);
    assert.ok(result!.includes('Available models'));
    assert.ok(result!.includes('primary'));
  });

  test('/model with invalid name returns error', () => {
    const result = agent.handleCommand('test:user1', '/model nonexistent');
    assert.ok(result);
    assert.ok(result!.includes('Unknown') || result!.includes('not found'));
  });

  test('/context shows diagnostics', () => {
    const sessionId = 'test:user1';
    sessionManager.getOrCreate('test', 'user1');
    sessionManager.addMessage(sessionId, { role: 'user', content: 'hi' });

    const result = agent.handleCommand(sessionId, '/context');
    assert.ok(result);
    assert.ok(result!.includes('Context Diagnostics'));
    assert.ok(result!.includes('Base system prompt'));
    assert.ok(result!.includes('tokens'));
    assert.ok(result!.includes('TOTAL'));
  });

  test('/factory-reset wipes everything', () => {
    memoryManager.saveMemory('Important data');
    memoryManager.deleteBootstrap();

    const result = agent.handleCommand('test:user1', '/factory-reset');
    assert.ok(result);
    assert.ok(result!.includes('Factory reset'));
    assert.equal(memoryManager.getMemory(), '');
    assert.ok(memoryManager.hasBootstrap());
  });

  test('/index status when disabled', () => {
    const result = agent.handleCommand('test:user1', '/index status');
    assert.ok(result);
    assert.ok(result!.includes('OFF'));
  });

  test('/index on enables indexing', () => {
    const result = agent.handleCommand('test:user1', '/index on');
    assert.ok(result);
    assert.ok(result!.includes('ENABLED'));
  });

  test('/index off disables indexing', () => {
    agent.handleCommand('test:user1', '/index on');
    const result = agent.handleCommand('test:user1', '/index off');
    assert.ok(result);
    assert.ok(result!.includes('DISABLED'));
  });

  test('unknown commands return null', () => {
    const result = agent.handleCommand('test:user1', '/nonexistent');
    assert.equal(result, null);
  });

  test('regular messages are not commands', () => {
    const result = agent.handleCommand('test:user1', 'hello world');
    assert.equal(result, null);
  });

  test('/new clears elevated status', () => {
    const sessionId = 'test:user1';
    agent.handleCommand(sessionId, '/elevated on');
    assert.ok(agent.isElevated(sessionId));

    agent.handleCommand(sessionId, '/new');
    assert.ok(!agent.isElevated(sessionId));
  });

  test('getAgentName returns null with default identity', () => {
    assert.equal(agent.getAgentName(), null);
  });

  test('getAgentName returns name after identity is set', () => {
    memoryManager.saveIdentityFile('IDENTITY.md', '- **Name:** TestBot');
    assert.equal(agent.getAgentName(), 'TestBot');
  });
});
