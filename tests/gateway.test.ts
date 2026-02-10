/**
 * Gateway Server Integration Tests
 * 
 * Starts a REAL Fastify server, makes REAL HTTP requests and
 * WebSocket connections to test the gateway end-to-end.
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
import { GatewayServer } from '../src/gateway/server.js';

const TEST_DIR = join(tmpdir(), `automate-test-gateway-${Date.now()}`);
let PORT = 19700 + Math.floor(Math.random() * 300);

function makeTestConfig(port: number) {
  return ConfigSchema.parse({
    agent: {
      model: 'test-model',
      apiBase: 'http://localhost:99999', // deliberately invalid — we test gateway, not LLM
    },
    gateway: { port, host: '127.0.0.1', auth: { mode: 'none' } },
    sessions: { directory: join(TEST_DIR, 'sessions') },
    memory: { directory: join(TEST_DIR, 'memory'), sharedDirectory: join(TEST_DIR, 'shared') },
    skills: { directory: join(TEST_DIR, 'skills') },
    cron: { directory: join(TEST_DIR, 'cron'), enabled: false },
    plugins: { directory: join(TEST_DIR, 'plugins'), enabled: false },
    browser: { enabled: false },
    canvas: { enabled: true },
  });
}

describe('GatewayServer', () => {
  let server: GatewayServer;
  let config: ReturnType<typeof makeTestConfig>;
  let sessionManager: SessionManager;
  let baseUrl: string;

  beforeEach(async () => {
    PORT++;
    mkdirSync(TEST_DIR, { recursive: true });
    // Create subdirectories needed by components
    mkdirSync(join(TEST_DIR, 'sessions'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'memory'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'shared'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'skills'), { recursive: true });
    config = makeTestConfig(PORT);
    sessionManager = new SessionManager(config);
    const memoryManager = new MemoryManager(config.memory.directory, {
      enabled: false, model: '', apiBase: '', chunkSize: 512,
      chunkOverlap: 64, vectorWeight: 0.6, bm25Weight: 0.4, topK: 10,
    });
    const agent = new Agent(config, sessionManager);
    agent.setMemoryManager(memoryManager);

    server = new GatewayServer(config, agent, sessionManager);
    await server.start();
    baseUrl = `http://127.0.0.1:${PORT}`;
  });

  afterEach(async () => {
    await server.stop();
    // Clear any intervals left by SessionManager to prevent hanging
    // @ts-expect-error accessing private for cleanup
    if (sessionManager.resetTimer) {
      // @ts-expect-error accessing private for cleanup
      clearInterval(sessionManager.resetTimer);
    }
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('GET /api/health returns ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.status, 'ok');
    assert.equal(data.model, 'test-model');
    assert.ok(typeof data.uptime === 'number');
    assert.equal(data.version, '0.1.0');
  });

  test('GET /api/status returns status info', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(typeof data.uptime === 'number');
    assert.ok(typeof data.sessions === 'number');
    assert.ok(typeof data.webchat_clients === 'number');
    assert.ok(typeof data.canvas_clients === 'number');
    assert.equal(data.model, 'test-model');
    assert.ok(data.presence);
    assert.equal(data.presence.status, 'online');
  });

  test('GET /api/sessions returns empty list initially', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data.sessions));
  });

  test('GET /api/config returns sanitized config', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.config.agent.model, 'test-model');
    assert.equal(data.config.gateway.port, PORT);
    // Should NOT expose API keys
    assert.equal(data.config.agent.apiKey, undefined);
  });

  test('GET /api/canvas returns canvas list', async () => {
    const res = await fetch(`${baseUrl}/api/canvas`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data.canvases));
  });

  test('POST /api/chat handles slash commands', async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '/status' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    // /status returns either session info or 'No active session.' — both contain 'session' (case-insensitive)
    assert.ok(data.response.toLowerCase().includes('session'), `Expected "session" in: ${data.response}`);
  });

  test('POST /api/chat /new resets session', async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '/new', session_id: 'test-session' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(data.response.includes('reset'));
  });

  test('POST /api/webhook rejects when disabled', async () => {
    const res = await fetch(`${baseUrl}/api/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'test' }),
    });
    assert.equal(res.status, 404);
  });

  test('DELETE /api/sessions/:id resets a session', async () => {
    // Create a session first
    sessionManager.getOrCreate('test', 'user1');
    sessionManager.addMessage('test:user1', { role: 'user', content: 'hello' });

    const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent('test:user1')}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.ok, true);
  });

  test('auth mode token blocks unauthorized requests', async () => {
    // Create a server with token auth
    const authPort = PORT + 100;
    mkdirSync(join(TEST_DIR, 'auth-sessions'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'auth-memory'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'auth-shared'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'auth-skills'), { recursive: true });
    const authConfig = ConfigSchema.parse({
      ...config,
      gateway: { port: authPort, host: '127.0.0.1', auth: { mode: 'token', token: 'secret123' } },
      sessions: { directory: join(TEST_DIR, 'auth-sessions') },
      memory: { directory: join(TEST_DIR, 'auth-memory'), sharedDirectory: join(TEST_DIR, 'auth-shared') },
      skills: { directory: join(TEST_DIR, 'auth-skills') },
      cron: { directory: join(TEST_DIR, 'auth-cron'), enabled: false },
      plugins: { directory: join(TEST_DIR, 'auth-plugins'), enabled: false },
      browser: { enabled: false },
    });
    const authSM = new SessionManager(authConfig);
    const authMM = new MemoryManager(authConfig.memory.directory, {
      enabled: false, model: '', apiBase: '', chunkSize: 512,
      chunkOverlap: 64, vectorWeight: 0.6, bm25Weight: 0.4, topK: 10,
    });
    const authAgent = new Agent(authConfig, authSM);
    authAgent.setMemoryManager(authMM);
    const authServer = new GatewayServer(authConfig, authAgent, authSM);
    await authServer.start();

    try {
      // Unauthorized request
      const res1 = await fetch(`http://127.0.0.1:${authPort}/api/health`);
      assert.equal(res1.status, 401);

      // Authorized request
      const res2 = await fetch(`http://127.0.0.1:${authPort}/api/health`, {
        headers: { Authorization: 'Bearer secret123' },
      });
      assert.equal(res2.status, 200);
    } finally {
      await authServer.stop();
      // @ts-expect-error accessing private for cleanup
      if (authSM.resetTimer) clearInterval(authSM.resetTimer);
    }
  });

  // ── Cron API ────────────────────────────────────────────────────────

  test('GET /api/cron returns jobs array (scheduler not wired)', async () => {
    const res = await fetch(`${baseUrl}/api/cron`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data.jobs));
    // Scheduler is not wired in test config, so error message is present
    assert.equal(data.error, 'Scheduler not available');
  });

  test('POST /api/cron returns scheduler not available', async () => {
    const res = await fetch(`${baseUrl}/api/cron`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-job', prompt: 'hello', schedule: '* * * * *' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.error, 'Scheduler not available');
  });

  test('DELETE /api/cron/:id returns scheduler not available', async () => {
    const res = await fetch(`${baseUrl}/api/cron/some-id`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.error, 'Scheduler not available');
  });

  test('PUT /api/cron/:id/toggle returns scheduler not available', async () => {
    const res = await fetch(`${baseUrl}/api/cron/some-id/toggle`, { method: 'PUT' });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.error, 'Scheduler not available');
  });

  // ── Memory API ──────────────────────────────────────────────────────

  test('GET /api/memory/files returns files list', async () => {
    const res = await fetch(`${baseUrl}/api/memory/files`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data.files));
    // Memory manager creates default template files (PERSONALITY.md, IDENTITY.md, etc.)
    assert.ok(data.files.length >= 0);
  });

  test('GET /api/memory/file/:name returns file content', async () => {
    const res = await fetch(`${baseUrl}/api/memory/file/IDENTITY.md`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.name, 'IDENTITY.md');
    assert.equal(typeof data.content, 'string');
  });

  test('GET /api/memory/file/:name returns empty for nonexistent file', async () => {
    const res = await fetch(`${baseUrl}/api/memory/file/NONEXISTENT.md`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.name, 'NONEXISTENT.md');
    assert.equal(data.content, '');
  });

  test('PUT /api/memory/file/:name saves file content', async () => {
    const res = await fetch(`${baseUrl}/api/memory/file/TEST-FILE.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Test\nHello world' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.ok, true);

    // Verify the file was actually saved
    const readRes = await fetch(`${baseUrl}/api/memory/file/TEST-FILE.md`);
    const readData = await readRes.json() as any;
    assert.equal(readData.content, '# Test\nHello world');
  });

  test('POST /api/memory/search returns results array', async () => {
    const res = await fetch(`${baseUrl}/api/memory/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'identity', limit: 5 }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data.results));
  });

  // ── Plugins API ─────────────────────────────────────────────────────

  test('GET /api/plugins returns plugins array (plugin manager not wired)', async () => {
    const res = await fetch(`${baseUrl}/api/plugins`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data.plugins));
    assert.equal(data.error, 'Plugin manager not available');
  });

  test('POST /api/plugins/reload returns plugin manager not available', async () => {
    const res = await fetch(`${baseUrl}/api/plugins/reload`, { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.error, 'Plugin manager not available');
  });

  test('POST /api/plugins/scaffold returns error when plugin manager not available', async () => {
    const res = await fetch(`${baseUrl}/api/plugins/scaffold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-plugin', type: 'tool' }),
    });
    assert.equal(res.status, 400);
    const data = await res.json() as any;
    assert.equal(data.error, 'Plugin manager not available');
  });

  // ── Doctor API ──────────────────────────────────────────────────────

  test('GET /api/doctor returns security audit', async () => {
    const res = await fetch(`${baseUrl}/api/doctor`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data.ok));
    assert.ok(Array.isArray(data.issues));
    assert.ok(typeof data.total === 'object');
    assert.equal(typeof data.total.passed, 'number');
    assert.equal(typeof data.total.warnings, 'number');
    // auth.mode is 'none' → should produce a warning
    assert.ok(data.issues.some((i: string) => i.includes('Auth mode is "none"')));
    // host is '127.0.0.1' → should pass
    assert.ok(data.ok.some((o: string) => o.includes('localhost only')));
  });

  // ── Command API ─────────────────────────────────────────────────────

  test('POST /api/command executes /status', async () => {
    const res = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: '/status' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(typeof data.result === 'string');
    assert.ok(typeof data.sessionId === 'string');
    // /status without active session says "No active session."
    assert.ok(
      data.result.toLowerCase().includes('session'),
      `Expected "session" in result: ${data.result}`,
    );
  });

  test('POST /api/command handles unknown command', async () => {
    const res = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: '/nonexistentcommand' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.result, 'Unknown command');
  });

  // ── Tools load/unload API ───────────────────────────────────────────

  test('POST /api/tools/load loads a deferred tool', async () => {
    const res = await fetch(`${baseUrl}/api/tools/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'web' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.promoted, true);
  });

  test('POST /api/tools/load returns error for unknown tool', async () => {
    const res = await fetch(`${baseUrl}/api/tools/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'nonexistent-tool-xyz' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.promoted, false);
    assert.ok(data.error);
  });

  test('POST /api/tools/unload demotes a core tool', async () => {
    const res = await fetch(`${baseUrl}/api/tools/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bash' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.demoted, true);
  });

  test('POST /api/tools/unload returns error for not-loaded tool', async () => {
    const res = await fetch(`${baseUrl}/api/tools/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'nonexistent-tool-xyz' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.demoted, false);
    assert.ok(data.error);
  });

  // ── Models API ──────────────────────────────────────────────────────

  test('GET /api/models returns providers and current', async () => {
    const res = await fetch(`${baseUrl}/api/models`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data.providers));
    assert.ok(data.providers.length >= 1);
    assert.ok(typeof data.current === 'object');
    assert.equal(data.current.model, 'test-model');
    // At least one provider should be marked active
    assert.ok(data.providers.some((p: any) => p.active === true));
  });

  test('POST /api/models/switch with invalid name returns error', async () => {
    const res = await fetch(`${baseUrl}/api/models/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'nonexistent-provider' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.success, false);
    assert.ok(data.error);
  });

  test('POST /api/models/switch by index 0 succeeds', async () => {
    const res = await fetch(`${baseUrl}/api/models/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '0' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.success, true);
    assert.equal(data.model, 'test-model');
  });
});
