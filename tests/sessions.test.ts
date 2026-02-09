/**
 * Session Manager Integration Tests
 * 
 * Tests session creation, persistence, compaction, auto-reset,
 * message management, and token estimation with real file I/O.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../src/gateway/session-manager.js';
import { ConfigSchema } from '../src/config/schema.js';

const TEST_DIR = join(tmpdir(), `automate-test-sessions-${Date.now()}`);

function makeConfig(overrides: Record<string, any> = {}) {
  return ConfigSchema.parse({
    sessions: {
      directory: join(TEST_DIR, `sessions-${Date.now()}`),
      maxHistory: 20,
      compactThreshold: 15,
      ...overrides,
    },
    skills: { directory: join(TEST_DIR, 'skills') },
    memory: { directory: join(TEST_DIR, 'memory'), sharedDirectory: join(TEST_DIR, 'shared') },
    cron: { directory: join(TEST_DIR, 'cron') },
    plugins: { directory: join(TEST_DIR, 'plugins') },
  });
}

describe('SessionManager', () => {
  let sm: SessionManager;
  let sessionsDir: string;

  beforeEach(() => {
    const config = makeConfig();
    sessionsDir = config.sessions.directory;
    mkdirSync(sessionsDir, { recursive: true });
    sm = new SessionManager(config);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('getOrCreate creates a new session', () => {
    const session = sm.getOrCreate('webchat', 'user1');
    assert.ok(session);
    assert.equal(session.channel, 'webchat');
    assert.equal(session.userId, 'user1');
    assert.equal(session.messages.length, 0);
    assert.equal(session.messageCount, 0);
    assert.ok(session.createdAt);
    assert.ok(session.id);
  });

  test('getOrCreate returns existing session on second call', () => {
    const s1 = sm.getOrCreate('webchat', 'user1');
    const s2 = sm.getOrCreate('webchat', 'user1');
    assert.equal(s1, s2); // same reference
  });

  test('addMessage increments count and stores messages', () => {
    sm.getOrCreate('test', 'user1');
    const id = 'test:user1';
    sm.addMessage(id, { role: 'user', content: 'Hello' });
    sm.addMessage(id, { role: 'assistant', content: 'Hi there' });

    const messages = sm.getMessages(id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'Hello');
    assert.equal(messages[1].role, 'assistant');

    const session = sm.getSession(id);
    assert.equal(session!.messageCount, 2);
  });

  test('saveSession persists to disk', () => {
    sm.getOrCreate('test', 'user1');
    sm.addMessage('test:user1', { role: 'user', content: 'Persisted message' });
    sm.saveSession('test:user1');

    const filePath = join(sessionsDir, 'test:user1.json');
    assert.ok(existsSync(filePath));

    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.equal(raw.messages[0].content, 'Persisted message');
  });

  test('resetSession clears messages', () => {
    sm.getOrCreate('test', 'user1');
    sm.addMessage('test:user1', { role: 'user', content: 'Hello' });
    sm.resetSession('test:user1');

    const messages = sm.getMessages('test:user1');
    assert.equal(messages.length, 0);
  });

  test('deleteSession removes from memory and disk', () => {
    sm.getOrCreate('test', 'user1');
    sm.addMessage('test:user1', { role: 'user', content: 'test' });
    sm.saveSession('test:user1');
    sm.deleteSession('test:user1');

    assert.equal(sm.getSession('test:user1'), undefined);
  });

  test('listSessions returns sessions without full message history', () => {
    sm.getOrCreate('ch1', 'u1');
    sm.getOrCreate('ch2', 'u2');
    sm.addMessage('ch1:u1', { role: 'user', content: 'msg1' });

    const list = sm.listSessions();
    assert.equal(list.length, 2);
    // Messages should be empty in listing (privacy)
    for (const s of list) {
      assert.deepEqual(s.messages, []);
    }
  });

  test('compact keeps system + recent messages', () => {
    sm.getOrCreate('test', 'user1');
    const id = 'test:user1';

    // Add system message
    sm.addMessage(id, { role: 'system', content: 'You are an assistant' });

    // Add 25 messages (exceeds maxHistory of 20)
    for (let i = 0; i < 25; i++) {
      sm.addMessage(id, { role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}` });
    }

    // Compact should have been triggered automatically
    const messages = sm.getMessages(id);
    assert.ok(messages.length < 26); // should be compacted
    assert.ok(messages.length > 5);  // should keep recent ones

    // System message should be preserved
    const systemMsgs = messages.filter(m => m.role === 'system');
    assert.ok(systemMsgs.length >= 1);

    // Most recent message should still be there
    const lastMsg = messages[messages.length - 1];
    assert.equal(lastMsg.content, 'Message 24');
  });

  test('compactWithInstructions includes instruction note', () => {
    sm.getOrCreate('test', 'user1');
    const id = 'test:user1';

    for (let i = 0; i < 15; i++) {
      sm.addMessage(id, { role: 'user', content: `Msg ${i}` });
    }

    const result = sm.compactWithInstructions(id, 'keep the API keys');
    assert.ok(result.includes('Compacted'));
    assert.ok(result.includes('API keys'));

    const messages = sm.getMessages(id);
    const compactNote = messages.find(m => m.content?.includes('API keys'));
    assert.ok(compactNote);
  });

  test('compactWithInstructions rejects short sessions', () => {
    sm.getOrCreate('test', 'user1');
    sm.addMessage('test:user1', { role: 'user', content: 'hello' });
    const result = sm.compactWithInstructions('test:user1', 'keep everything');
    assert.ok(result.includes('too short'));
  });

  test('estimateTokens returns reasonable estimates', () => {
    sm.getOrCreate('test', 'user1');
    const id = 'test:user1';

    // Empty session
    assert.equal(sm.estimateTokens(id), 0);

    // Add some messages
    sm.addMessage(id, { role: 'user', content: 'Hello world this is a test message' });
    const tokens = sm.estimateTokens(id);
    assert.ok(tokens > 0);
    assert.ok(tokens < 100); // "Hello world this is a test message" ~ 8 tokens
  });

  test('saveAll persists all sessions', () => {
    sm.getOrCreate('ch1', 'u1');
    sm.getOrCreate('ch2', 'u2');
    sm.addMessage('ch1:u1', { role: 'user', content: 'test1' });
    sm.addMessage('ch2:u2', { role: 'user', content: 'test2' });

    sm.saveAll();

    assert.ok(existsSync(join(sessionsDir, 'ch1:u1.json')));
    assert.ok(existsSync(join(sessionsDir, 'ch2:u2.json')));
  });

  test('sessions persist and reload across instances', () => {
    const config = makeConfig();
    const dir = config.sessions.directory;
    mkdirSync(dir, { recursive: true });

    // First instance: write data
    const sm1 = new SessionManager(config);
    sm1.getOrCreate('test', 'user1');
    sm1.addMessage('test:user1', { role: 'user', content: 'Persistent message' });
    sm1.saveAll();

    // Second instance: should load saved data
    const sm2 = new SessionManager(config);
    const session = sm2.getSession('test:user1');
    assert.ok(session);
    assert.equal(session!.messages[0].content, 'Persistent message');
  });

  test('pre-compaction hook is called', async () => {
    let hookCalled = false;
    let hookedMessages: any[] = [];

    sm.setBeforeCompactHook(async (sessionId, messages) => {
      hookCalled = true;
      hookedMessages = messages;
    });

    sm.getOrCreate('test', 'user1');
    const id = 'test:user1';

    // Add enough messages to trigger auto-compact (maxHistory=20)
    for (let i = 0; i < 25; i++) {
      sm.addMessage(id, { role: 'user', content: `Msg ${i}` });
    }

    // Hook should have been called (it's async, give it a tick)
    await new Promise(r => setTimeout(r, 50));
    assert.ok(hookCalled);
    assert.ok(hookedMessages.length > 0);
  });
});
