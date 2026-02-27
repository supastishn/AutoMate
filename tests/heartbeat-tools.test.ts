import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryManager } from '../src/memory/manager.js';
import { memoryTools, setMemoryManager } from '../src/agent/tools/memory.js';

function makeMemoryManager(dir: string): MemoryManager {
  return new MemoryManager(dir, {
    enabled: false,
    model: '',
    apiBase: '',
    chunkSize: 512,
    chunkOverlap: 64,
    vectorWeight: 0.6,
    bm25Weight: 0.4,
    topK: 10,
  });
}

describe('Heartbeat tools', () => {
  let testDir: string;
  const ctx = { sessionId: 'webchat:test', workdir: process.cwd() };

  beforeEach(() => {
    testDir = join(tmpdir(), `automate-heartbeat-tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(testDir, { recursive: true });
    setMemoryManager(makeMemoryManager(testDir));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('memory tool exposes heartbeat_write/heartbeat_read as actions', async () => {
    const memoryTool = memoryTools.find(t => t.name === 'memory');
    assert.ok(memoryTool, 'memory tool should exist');
    assert.equal(memoryTools.some(t => t.name === 'heartbeat_write'), false);
    assert.equal(memoryTools.some(t => t.name === 'heartbeat_read'), false);

    const writeResult = await memoryTool!.execute({
      action: 'heartbeat_write',
      target: 'objective',
      content: 'Keep browser automation stable and verify extension popups.',
    }, ctx);
    assert.equal(writeResult.error, undefined);

    const readResult = await memoryTool!.execute({ action: 'heartbeat_read', target: 'objective' }, ctx);
    assert.equal(readResult.error, undefined);
    assert.match(readResult.output, /Keep browser automation stable and verify extension popups\./);
  });

  test('memory action heartbeat_write can update HEARTBEAT.md directly', async () => {
    const memoryTool = memoryTools.find(t => t.name === 'memory');
    assert.ok(memoryTool, 'memory tool should exist');

    const writeResult = await memoryTool!.execute({
      action: 'heartbeat_write',
      target: 'heartbeat',
      content: '- Check browser health and report blockers.',
    }, ctx);
    assert.equal(writeResult.error, undefined);

    const readResult = await memoryTool!.execute({ action: 'heartbeat_read', target: 'heartbeat' }, ctx);
    assert.equal(readResult.error, undefined);
    assert.match(readResult.output, /Check browser health and report blockers/);
  });
});
