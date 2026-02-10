/**
 * Sub-Agent Spawner — spawn isolated sub-agents with their own context.
 */

import type { Tool } from '../tool-registry.js';

let spawnFn: ((opts: SubAgentOpts) => Promise<SubAgentResult>) | null = null;

export interface SubAgentOpts {
  name: string;
  task: string;
  systemPrompt?: string;
  maxIterations?: number;
  timeout?: number;
  reportBack?: boolean;
}

export interface SubAgentResult {
  agentId: string;
  name: string;
  status: 'completed' | 'timeout' | 'error';
  output: string;
  toolCalls: { name: string; result: string }[];
  duration: number;
}

export function setSubAgentSpawner(fn: (opts: SubAgentOpts) => Promise<SubAgentResult>): void {
  spawnFn = fn;
}

export const subAgentTools: Tool[] = [
  {
    name: 'subagent',
    description: [
      'Spawn an independent sub-agent to perform a task.',
      'The sub-agent gets its own session and can use all your tools.',
      'Use report_back=true to wait for results, false for fire-and-forget.',
      'Great for: parallel research, code review, data processing, long-running tasks.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for this sub-agent (e.g. "researcher", "code-reviewer")' },
        task: { type: 'string', description: 'The task/prompt to give the sub-agent' },
        system_prompt: { type: 'string', description: 'Optional custom system prompt' },
        report_back: { type: 'boolean', description: 'Wait for result (default: true)' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)' },
      },
      required: ['name', 'task'],
    },
    async execute(params) {
      if (!spawnFn) return { output: '', error: 'Sub-agent spawner not available' };

      const name = params.name as string;
      const task = params.task as string;
      const systemPrompt = params.system_prompt as string | undefined;
      const reportBack = params.report_back !== false;
      const timeout = ((params.timeout as number) || 300) * 1000;

      try {
        const result = await spawnFn({ name, task, systemPrompt, reportBack, timeout });

        if (!reportBack) {
          return { output: `Sub-agent "${name}" spawned in background. ID: ${result.agentId}` };
        }

        const statusLine = result.status === 'completed'
          ? `completed in ${(result.duration / 1000).toFixed(1)}s`
          : `${result.status} after ${(result.duration / 1000).toFixed(1)}s`;

        const toolLine = result.toolCalls.length > 0
          ? `\nTools used: ${result.toolCalls.map(t => t.name).join(', ')}`
          : '';

        return { output: `Sub-agent "${name}" ${statusLine}${toolLine}\n\n${result.output}` };
      } catch (err) {
        return { output: '', error: `Sub-agent spawn failed: ${(err as Error).message}` };
      }
    },
  },
];
