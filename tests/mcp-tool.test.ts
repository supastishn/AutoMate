import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '../src/agent/tool-registry.js';
import { mcpTools, setMCPConfig } from '../src/agent/tools/mcp.js';

function makeCtx(): ToolContext {
  return { sessionId: 'test:user1', workdir: process.cwd(), elevated: true };
}

describe('MCP tool runtime integration', () => {
  test('lists configured MCP servers', async () => {
    setMCPConfig({
      servers: [
        {
          name: 'filesystem',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          env: {},
        },
      ],
    });

    const tool = mcpTools.find(t => t.name === 'mcp')!;
    const result = await tool.execute({ action: 'list' }, makeCtx());
    assert.ok(result.output.includes('filesystem'));
    assert.ok(result.output.includes('stdio'));
  });

  test('can start and stop a stdio MCP server process', async () => {
    setMCPConfig({
      servers: [
        {
          name: 'echo-server',
          enabled: true,
          transport: 'stdio',
          command: 'sh',
          args: ['-c', 'echo ready && sleep 5'],
          env: {},
        },
      ],
    });

    const tool = mcpTools.find(t => t.name === 'mcp')!;
    const startResult = await tool.execute({ action: 'start', name: 'echo-server' }, makeCtx());
    assert.ok(startResult.output.includes('Started'));

    const statusResult = await tool.execute({ action: 'status', name: 'echo-server' }, makeCtx());
    assert.ok(statusResult.output.includes('echo-server'));

    const stopResult = await tool.execute({ action: 'stop', name: 'echo-server' }, makeCtx());
    assert.ok(stopResult.output.includes('Stopped') || stopResult.output.includes('not running'));
  });
});
