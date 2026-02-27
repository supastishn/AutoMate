import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryManager } from '../src/memory/manager.js';
import { HeartbeatManager } from '../src/heartbeat/manager.js';

const OBJECTIVE_LOG_FILE = 'OBJECTIVE_LOG.md';

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

function makeSchedulerMock(): any {
  return {
    listJobs: () => [],
    addJob: () => {},
    removeJob: () => {},
    enableJob: () => {},
    disableJob: () => {},
  };
}

describe('Heartbeat objective log loop', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `automate-heartbeat-objective-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('includes latest objective log entry in heartbeat prompt', async () => {
    const mm = makeMemoryManager(testDir);
    mm.saveIdentityFile('HEARTBEAT.md', 'Check pending operations and report issues.');
    writeFileSync(
      join(testDir, OBJECTIVE_LOG_FILE),
      [
        '# Objective Log',
        '',
        '## Current Objective',
        'Next: verify popup handling and extension visibility before any retries.',
        '',
        '## Last Heartbeat Result',
        '- Status: `sent`',
      ].join('\n'),
    );

    let capturedPrompt = '';
    const agentMock = {
      getSessionManager: () => ({
        getSession: () => undefined,
        saveSession: () => {},
      }),
      elevateSession: () => {},
      processMessage: async (_sessionId: string, prompt: string, onStream?: (chunk: string) => void) => {
        capturedPrompt = prompt;
        if (onStream) onStream('HEARTBEAT_OK');
        return { content: 'HEARTBEAT_OK' };
      },
    };

    const hb = new HeartbeatManager(mm, agentMock as any, makeSchedulerMock(), 'webchat:heartbeat');
    await hb.trigger();

    assert.ok(
      capturedPrompt.includes('verify popup handling and extension visibility'),
      'heartbeat prompt should include latest objective log context',
    );
  });

  test('persists next objective entry from heartbeat response', async () => {
    const mm = makeMemoryManager(testDir);
    mm.saveIdentityFile('HEARTBEAT.md', 'Review system state and report only actionable updates.');

    const response = 'Need to investigate extension popup race condition and retry with the existing browser profile.';
    const agentMock = {
      getSessionManager: () => ({
        getSession: () => undefined,
        saveSession: () => {},
      }),
      elevateSession: () => {},
      processMessage: async () => ({ content: response }),
    };

    const hb = new HeartbeatManager(mm, agentMock as any, makeSchedulerMock(), 'webchat:heartbeat');
    await hb.trigger();

    const objectivePath = join(testDir, OBJECTIVE_LOG_FILE);
    assert.ok(existsSync(objectivePath), 'objective log file should be created');
    const objectiveMd = readFileSync(objectivePath, 'utf-8');
    assert.match(objectiveMd, /# Objective Log/);
    assert.match(objectiveMd, /## Current Objective/);
    assert.match(objectiveMd, /- Status: `sent`/);
    assert.match(objectiveMd, new RegExp(response.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
