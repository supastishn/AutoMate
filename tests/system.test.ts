/**
 * Skills, Plugins, Canvas, Presence, ToolRegistry, and Router Integration Tests
 * 
 * Tests real module instantiation and behavior — no mocks.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigSchema } from '../src/config/schema.js';
import { SkillsLoader } from '../src/skills/loader.js';
import { PluginManager } from '../src/plugins/manager.js';
import { ToolRegistry, type Tool } from '../src/agent/tool-registry.js';
import { PresenceManager } from '../src/gateway/presence.js';
import { setCanvasBroadcaster, canvasTools, getCanvas, getAllCanvases } from '../src/canvas/canvas-manager.js';

const TEST_DIR = join(tmpdir(), `automate-test-misc-${Date.now()}`);

// ── Skills Loader ─────────────────────────────────────────────────────────

describe('SkillsLoader', () => {
  let loader: SkillsLoader;
  let skillsDir: string;

  beforeEach(() => {
    skillsDir = join(TEST_DIR, `skills-${Date.now()}`);
    mkdirSync(skillsDir, { recursive: true });
    const config = ConfigSchema.parse({
      skills: { directory: skillsDir },
      sessions: { directory: join(TEST_DIR, 's') },
      memory: { directory: join(TEST_DIR, 'm'), sharedDirectory: join(TEST_DIR, 'sh') },
      cron: { directory: join(TEST_DIR, 'c') },
      plugins: { directory: join(TEST_DIR, 'p') },
    });
    loader = new SkillsLoader(config);
  });

  afterEach(() => {
    loader.stopWatching();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('loads skills from directory', () => {
    // Create a skill
    const skillDir = join(skillsDir, 'test-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Test Skill\nThis skill does testing.');

    const skills = loader.loadAll();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'test-skill');
    assert.ok(skills[0].content.includes('Test Skill'));
    assert.ok(skills[0].description.includes('This skill does testing'));
  });

  test('skips directories without SKILL.md', () => {
    mkdirSync(join(skillsDir, 'no-skill'), { recursive: true });
    writeFileSync(join(skillsDir, 'no-skill', 'README.md'), 'Not a skill');

    const skills = loader.loadAll();
    assert.equal(skills.length, 0);
  });

  test('getSkill returns specific skill', () => {
    const skillDir = join(skillsDir, 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# My Skill');
    loader.loadAll();

    const skill = loader.getSkill('my-skill');
    assert.ok(skill);
    assert.equal(skill!.name, 'my-skill');

    // Non-existent
    assert.equal(loader.getSkill('nonexistent'), undefined);
  });

  test('getSystemPromptInjection builds combined prompt', () => {
    for (let i = 0; i < 3; i++) {
      const dir = join(skillsDir, `skill-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), `# Skill ${i}\nDescription ${i}`);
    }
    loader.loadAll();

    const injection = loader.getSystemPromptInjection();
    assert.ok(injection.includes('Active Skills'));
    assert.ok(injection.includes('Skill 0'));
    assert.ok(injection.includes('Skill 1'));
    assert.ok(injection.includes('Skill 2'));
  });

  test('empty skills dir returns empty injection', () => {
    loader.loadAll();
    assert.equal(loader.getSystemPromptInjection(), '');
  });

  test('gating by requires_env skips skill when env var missing', () => {
    const dir = join(skillsDir, 'gated-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nrequires_env: NONEXISTENT_VAR_12345\n---\n# Gated Skill`);

    const skills = loader.loadAll();
    assert.equal(skills.length, 0); // should be skipped
  });

  test('gating by os skips when platform doesnt match', () => {
    const dir = join(skillsDir, 'os-gated');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nos: nonexistent_os\n---\n# OS Gated`);

    const skills = loader.loadAll();
    assert.equal(skills.length, 0);
  });
});

// ── Tool Registry ─────────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  const mockTool: Tool = {
    name: 'test_tool',
    description: 'A test tool',
    parameters: { type: 'object', properties: { input: { type: 'string' } } },
    async execute(params) {
      return { output: `Result: ${params.input}` };
    },
  };

  const anotherTool: Tool = {
    name: 'another_tool',
    description: 'Another test tool',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { output: 'another result' };
    },
  };

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  test('register and execute a tool', async () => {
    registry.register(mockTool);
    const result = await registry.execute('test_tool', { input: 'hello' }, { sessionId: 'test', workdir: '/' });
    assert.equal(result.output, 'Result: hello');
  });

  test('execute unknown tool returns error', async () => {
    const result = await registry.execute('nonexistent', {}, { sessionId: 'test', workdir: '/' });
    assert.ok(result.error);
    assert.ok(result.error!.includes('Unknown tool'));
  });

  test('deny list blocks tools', async () => {
    registry.register(mockTool);
    registry.setPolicy([], ['test_tool']);

    const result = await registry.execute('test_tool', {}, { sessionId: 'test', workdir: '/' });
    assert.ok(result.error);
    assert.ok(result.error!.includes('denied'));
  });

  test('allow list restricts to listed tools only', async () => {
    registry.register(mockTool);
    registry.register(anotherTool);
    registry.setPolicy(['test_tool'], []);

    // Allowed tool works
    const r1 = await registry.execute('test_tool', { input: 'ok' }, { sessionId: 'test', workdir: '/' });
    assert.equal(r1.output, 'Result: ok');

    // Non-allowed tool blocked
    const r2 = await registry.execute('another_tool', {}, { sessionId: 'test', workdir: '/' });
    assert.ok(r2.error);
    assert.ok(r2.error!.includes('not in the allow list'));
  });

  test('deny wins over allow', async () => {
    registry.register(mockTool);
    registry.setPolicy(['test_tool'], ['test_tool']);

    const result = await registry.execute('test_tool', {}, { sessionId: 'test', workdir: '/' });
    assert.ok(result.error);
    assert.ok(result.error!.includes('denied'));
  });

  test('getToolDefs respects policy', () => {
    registry.register(mockTool);
    registry.register(anotherTool);
    registry.setPolicy([], ['test_tool']);

    const defs = registry.getToolDefs();
    assert.equal(defs.length, 1);
    assert.equal(defs[0].function.name, 'another_tool');
  });

  test('unregister removes a tool', () => {
    registry.register(mockTool);
    assert.ok(registry.get('test_tool'));
    registry.unregister('test_tool');
    assert.equal(registry.get('test_tool'), undefined);
  });

  test('tool execution error is caught gracefully', async () => {
    const failTool: Tool = {
      name: 'fail_tool',
      description: 'Fails',
      parameters: { type: 'object', properties: {} },
      async execute() {
        throw new Error('Intentional failure');
      },
    };
    registry.register(failTool);

    const result = await registry.execute('fail_tool', {}, { sessionId: 'test', workdir: '/' });
    assert.ok(result.error);
    assert.ok(result.error!.includes('Intentional failure'));
  });
});

// ── Canvas ────────────────────────────────────────────────────────────────

describe('Canvas Tools', () => {
  const [pushTool, resetTool, snapshotTool] = canvasTools;
  let broadcasts: any[];

  beforeEach(() => {
    broadcasts = [];
    setCanvasBroadcaster((event) => broadcasts.push(event));
  });

  test('canvas_push creates canvas and broadcasts', async () => {
    const result = await pushTool.execute(
      { title: 'Test Canvas', content: '<h1>Hello</h1>', content_type: 'html' },
      { sessionId: 'test:session', workdir: '/' }
    );
    assert.ok(result.output.includes('Canvas updated'));
    assert.ok(result.output.includes('Test Canvas'));

    // Should broadcast
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, 'canvas_push');
    assert.equal(broadcasts[0].canvas.content, '<h1>Hello</h1>');
  });

  test('canvas_snapshot returns content', async () => {
    await pushTool.execute(
      { title: 'Snapshot Test', content: 'Some content', content_type: 'text' },
      { sessionId: 'snap:session', workdir: '/' }
    );

    const snapshot = await snapshotTool.execute({}, { sessionId: 'snap:session', workdir: '/' });
    const data = JSON.parse(snapshot.output);
    assert.equal(data.title, 'Snapshot Test');
    assert.equal(data.contentType, 'text');
    assert.ok(data.contentLength > 0);
  });

  test('canvas_reset clears content', async () => {
    await pushTool.execute(
      { content: 'To be cleared' },
      { sessionId: 'reset:session', workdir: '/' }
    );
    await resetTool.execute({}, { sessionId: 'reset:session', workdir: '/' });

    const snapshot = await snapshotTool.execute({}, { sessionId: 'reset:session', workdir: '/' });
    assert.ok(snapshot.output.includes('empty'));
  });

  test('canvas maintains history', async () => {
    const ctx = { sessionId: 'history:session', workdir: '/' };
    await pushTool.execute({ content: 'Version 1' }, ctx);
    await pushTool.execute({ content: 'Version 2' }, ctx);
    await pushTool.execute({ content: 'Version 3' }, ctx);

    const snapshot = await snapshotTool.execute({}, ctx);
    const data = JSON.parse(snapshot.output);
    assert.equal(data.historyCount, 2); // versions 1 and 2 in history
  });
});

// ── Presence Manager ──────────────────────────────────────────────────────

describe('PresenceManager', () => {
  let pm: PresenceManager;
  let events: any[];

  beforeEach(() => {
    pm = new PresenceManager('test-agent', 1000); // 1s idle timeout for tests
    events = [];
    pm.setBroadcaster((event) => events.push(event));
  });

  afterEach(() => {
    pm.shutdown();
  });

  test('initial state is online', () => {
    const state = pm.getState();
    assert.equal(state.status, 'online');
    assert.equal(state.typing, false);
    assert.equal(state.agentId, 'test-agent');
  });

  test('startProcessing sets busy + typing', () => {
    pm.startProcessing('session1');
    const state = pm.getState();
    assert.equal(state.status, 'busy');
    assert.equal(state.typing, true);
    assert.equal(state.currentSession, 'session1');

    // Should have emitted typing + presence events
    assert.ok(events.some(e => e.type === 'typing' && e.active === true));
    assert.ok(events.some(e => e.type === 'presence' && e.status === 'busy'));
  });

  test('stopProcessing sets online + not typing', () => {
    pm.startProcessing('session1');
    events = []; // clear start events
    pm.stopProcessing('session1');

    const state = pm.getState();
    assert.equal(state.status, 'online');
    assert.equal(state.typing, false);
    assert.equal(state.currentSession, undefined);

    assert.ok(events.some(e => e.type === 'typing' && e.active === false));
    assert.ok(events.some(e => e.type === 'presence' && e.status === 'online'));
  });

  test('auto-idle after timeout', async () => {
    // Idle timeout is 1 second in tests
    pm.touch(); // reset timer
    await new Promise(r => setTimeout(r, 1500));

    const state = pm.getState();
    assert.equal(state.status, 'idle');
  });

  test('touch recovers from idle', async () => {
    // Set status to idle manually instead of waiting
    pm.setStatus('idle');
    assert.equal(pm.getState().status, 'idle');

    pm.touch();
    assert.equal(pm.getState().status, 'online');
  });

  test('shutdown sets offline', () => {
    pm.shutdown();
    assert.equal(pm.getState().status, 'offline');
    assert.ok(events.some(e => e.type === 'presence' && e.status === 'offline'));
  });

  test('setStatus manually changes status', () => {
    pm.setStatus('busy');
    assert.equal(pm.getState().status, 'busy');

    pm.setStatus('online');
    assert.equal(pm.getState().status, 'online');
  });
});

// ── Plugin Manager ────────────────────────────────────────────────────────

describe('PluginManager', () => {
  let pluginsDir: string;

  beforeEach(() => {
    pluginsDir = join(TEST_DIR, `plugins-${Date.now()}`);
    mkdirSync(pluginsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('scaffold creates plugin structure', () => {
    const dir = PluginManager.scaffold(pluginsDir, 'test-plugin', 'tools');

    assert.ok(existsSync(join(dir, 'plugin.json')));
    assert.ok(existsSync(join(dir, 'index.js')));

    const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8'));
    assert.equal(manifest.name, 'test-plugin');
    assert.equal(manifest.type, 'tools');
    assert.equal(manifest.version, '0.1.0');
  });

  test('scaffold rejects duplicate names', () => {
    PluginManager.scaffold(pluginsDir, 'dupe', 'tools');
    assert.throws(() => {
      PluginManager.scaffold(pluginsDir, 'dupe', 'tools');
    }, /already exists/);
  });

  test('scaffold creates different types', () => {
    for (const type of ['tools', 'channel', 'middleware', 'mixed'] as const) {
      const dir = PluginManager.scaffold(pluginsDir, `${type}-plugin`, type);
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8'));
      assert.equal(manifest.type, type);
    }
  });
});

// ── LLM Client Provider Failover ──────────────────────────────────────────

describe('LLMClient', () => {
  test('constructs with primary provider', async () => {
    // We can only test construction (not actual API calls)
    const { LLMClient } = await import('../src/agent/llm-client.js');
    const config = ConfigSchema.parse({
      agent: {
        model: 'test',
        apiBase: 'http://localhost:99999',
        providers: [
          { model: 'fallback1', apiBase: 'http://localhost:99998', priority: 10 },
        ],
      },
    });

    const client = new LLMClient(config);
    const current = client.getCurrentProvider();
    assert.equal(current.name, 'primary');
    assert.equal(current.model, 'test');
  });

  test('listProviders returns all providers', async () => {
    const { LLMClient } = await import('../src/agent/llm-client.js');
    const config = ConfigSchema.parse({
      agent: {
        model: 'main',
        apiBase: 'http://localhost:1',
        providers: [
          { model: 'fb1', apiBase: 'http://localhost:2', priority: 10 },
          { model: 'fb2', apiBase: 'http://localhost:3', priority: 20 },
        ],
      },
    });

    const client = new LLMClient(config);
    const providers = client.listProviders();
    assert.equal(providers.length, 3);
    assert.ok(providers.some(p => p.model === 'main'));
    assert.ok(providers.some(p => p.model === 'fb1'));
    assert.ok(providers.some(p => p.model === 'fb2'));
  });

  test('switchModel by index', async () => {
    const { LLMClient } = await import('../src/agent/llm-client.js');
    const config = ConfigSchema.parse({
      agent: {
        model: 'main',
        apiBase: 'http://localhost:1',
        providers: [
          { name: 'fallback', model: 'fb', apiBase: 'http://localhost:2', priority: 10 },
        ],
      },
    });

    const client = new LLMClient(config);
    const result = client.switchModel('1');
    assert.ok(result.success);
    assert.equal(result.model, 'fb');
    assert.equal(client.getCurrentProvider().model, 'fb');
  });

  test('switchModel by name', async () => {
    const { LLMClient } = await import('../src/agent/llm-client.js');
    const config = ConfigSchema.parse({
      agent: {
        model: 'main',
        apiBase: 'http://localhost:1',
        providers: [
          { name: 'openai', model: 'gpt-4o', apiBase: 'http://localhost:2', priority: 10 },
        ],
      },
    });

    const client = new LLMClient(config);
    const result = client.switchModel('openai');
    assert.ok(result.success);
    assert.equal(result.model, 'gpt-4o');
  });

  test('switchModel with invalid name returns error', async () => {
    const { LLMClient } = await import('../src/agent/llm-client.js');
    const config = ConfigSchema.parse({});
    const client = new LLMClient(config);
    const result = client.switchModel('nonexistent');
    assert.ok(!result.success);
    assert.ok(result.error);
  });

  test('chat throws when all providers fail', async () => {
    const { LLMClient } = await import('../src/agent/llm-client.js');
    const config = ConfigSchema.parse({
      agent: { apiBase: 'http://localhost:99999' },
    });
    const client = new LLMClient(config);

    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'test' }]),
      /All providers failed/
    );
  });
});
