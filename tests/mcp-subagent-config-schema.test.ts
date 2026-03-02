import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema } from '../src/config/schema.js';

describe('MCP and subagent config schema', () => {
  test('provides defaults for mcp servers and subagent profiles', () => {
    const config = ConfigSchema.parse({});
    assert.deepEqual(config.mcp.servers, []);
    assert.deepEqual(config.agent.subagent.profiles, []);
  });

  test('accepts explicit mcp server and subagent profile config', () => {
    const config = ConfigSchema.parse({
      mcp: {
        servers: [
          {
            name: 'local-files',
            enabled: true,
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            env: { HOME: '/tmp' },
            description: 'Filesystem MCP server',
          },
        ],
      },
      agent: {
        subagent: {
          defaultModel: 'gpt-4.1',
          profiles: [
            {
              name: 'reviewer',
              model: 'claude-sonnet-4.5',
              systemPrompt: 'Focus on reliability and security.',
              maxIterations: 40,
              timeoutMs: 600000,
            },
          ],
        },
      },
    });

    assert.equal(config.mcp.servers.length, 1);
    assert.equal(config.mcp.servers[0].name, 'local-files');
    assert.equal(config.mcp.servers[0].transport, 'stdio');
    assert.equal(config.mcp.servers[0].command, 'npx');
    assert.deepEqual(config.mcp.servers[0].env, { HOME: '/tmp' });

    assert.equal(config.agent.subagent.profiles.length, 1);
    assert.equal(config.agent.subagent.profiles[0].name, 'reviewer');
    assert.equal(config.agent.subagent.profiles[0].model, 'claude-sonnet-4.5');
    assert.equal(config.agent.subagent.profiles[0].maxIterations, 40);
    assert.equal(config.agent.subagent.profiles[0].timeoutMs, 600000);
  });
});
