import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '../src/agent/tool-registry.js';
import { subAgentTools, setSubAgentSpawner, setSubAgentProfiles } from '../src/agent/tools/subagent.js';

function makeCtx(): ToolContext {
  return { sessionId: 'test:user1', workdir: process.cwd(), elevated: true };
}

describe('Subagent profile runtime integration', () => {
  test('applies configured profile defaults when profile is selected', async () => {
    let captured: any = null;
    setSubAgentProfiles([
      {
        name: 'reviewer',
        model: 'claude-sonnet-4.5',
        systemPrompt: 'Review with security focus.',
        timeoutMs: 120000,
        maxIterations: 25,
      },
    ]);
    setSubAgentSpawner(async (opts) => {
      captured = opts;
      return {
        agentId: 'a1',
        name: opts.name,
        status: 'completed',
        output: 'done',
        toolCalls: [],
        duration: 10,
      };
    });

    const tool = subAgentTools.find(t => t.name === 'subagent')!;
    const result = await tool.execute(
      { name: 'task-runner', task: 'Audit this project', profile: 'reviewer' },
      makeCtx(),
    );

    assert.ok(result.output.includes('completed'));
    assert.equal(captured.model, 'claude-sonnet-4.5');
    assert.equal(captured.systemPrompt, 'Review with security focus.');
    assert.equal(captured.timeout, 120000);
    assert.equal(captured.maxIterations, 25);
  });

  test('returns an error when requested profile does not exist', async () => {
    setSubAgentProfiles([]);
    const tool = subAgentTools.find(t => t.name === 'subagent')!;
    const result = await tool.execute(
      { name: 'task-runner', task: 'Audit this project', profile: 'missing-profile' },
      makeCtx(),
    );
    assert.ok(result.error);
    assert.ok(result.error!.includes('Profile'));
  });
});
