/**
 * Sub-Agent Spawner — spawn isolated sub-agents with their own context,
 * system prompt, tools, and optional result callback. Unlike sessions_spawn,
 * sub-agents can have custom instructions and report back results.
 */

import type { Tool } from '../tool-registry.js';

// Will be set at runtime
let spawnFn: ((opts: SubAgentOpts) => Promise<SubAgentResult>) | null = null;

export interface SubAgentOpts {
  name: string;
  task: string;
  systemPrompt?: string;
  maxIterations?: number;
  timeout?: number;          // ms
  reportBack?: boolean;      // if true, waits for result; if false, fire-and-forget
}

export interface SubAgentResult {
  agentId: string;
  name: string;
  status: 'completed' | 'timeout' | 'error';
  output: string;
  toolCalls: { name: string; result: string }[];
  duration: number;          // ms
}

export function setSubAgentSpawner(fn: (opts: SubAgentOpts) => Promise<SubAgentResult>): void {
  spawnFn = fn;
}

export const subAgentSpawnTool: Tool = {
  name: 'subagent_spawn',
  description: 'Spawn an independent sub-agent to perform a task. The sub-agent gets its own session and can use all your tools. Use report_back=true to wait for results, or false for fire-and-forget background work. Sub-agents are great for: parallel research, code review, data processing, long-running tasks.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name for this sub-agent (e.g. "researcher", "code-reviewer")' },
      task: { type: 'string', description: 'The task/prompt to give the sub-agent' },
      system_prompt: { type: 'string', description: 'Optional custom system prompt for the sub-agent' },
      report_back: { type: 'boolean', description: 'Wait for the sub-agent to finish and return its output (default: true)' },
      timeout: { type: 'number', description: 'Timeout in seconds (default: 300). Only used when report_back=true.' },
    },
    required: ['name', 'task'],
  },
  async execute(params) {
    if (!spawnFn) return { output: '', error: 'Sub-agent spawner not available' };

    const name = params.name as string;
    const task = params.task as string;
    const systemPrompt = params.system_prompt as string | undefined;
    const reportBack = params.report_back !== false; // default true
    const timeout = ((params.timeout as number) || 300) * 1000;

    try {
      const result = await spawnFn({
        name,
        task,
        systemPrompt,
        reportBack,
        timeout,
      });

      if (!reportBack) {
        return { output: `Sub-agent "${name}" spawned in background. ID: ${result.agentId}` };
      }

      const statusLine = result.status === 'completed'
        ? `completed in ${(result.duration / 1000).toFixed(1)}s`
        : `${result.status} after ${(result.duration / 1000).toFixed(1)}s`;

      const toolLine = result.toolCalls.length > 0
        ? `\nTools used: ${result.toolCalls.map(t => t.name).join(', ')}`
        : '';

      return {
        output: `Sub-agent "${name}" ${statusLine}${toolLine}\n\n${result.output}`,
      };
    } catch (err) {
      return { output: '', error: `Sub-agent spawn failed: ${(err as Error).message}` };
    }
  },
};

export const subAgentListTool: Tool = {
  name: 'subagent_list',
  description: 'List all active and recent sub-agents with their status.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    // This is backed by sessions_list for spawn: sessions
    // We'll just filter spawn sessions from the session manager
    return { output: 'Use sessions_list and filter for "subagent:" prefixed sessions to see sub-agents.' };
  },
};

export const subAgentTools = [subAgentSpawnTool];
