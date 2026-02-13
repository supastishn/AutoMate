/**
 * Sub-Agent Spawner — spawn isolated sub-agents with their own context.
 * 
 * Two modes:
 *   - blocking (default): Waits for sub-agent to finish and returns the result inline.
 *   - parallel: Runs in background, returns a hash ID immediately.
 *     Use the `subagent_poll` tool to check status and retrieve results.
 * 
 * Sub-agents keep running until they call `subagent_finish`. If they produce
 * a plain text response without tool calls, a "continue" nudge is injected
 * so they keep working instead of stopping early.
 */

import type { Tool } from '../tool-registry.js';
import { randomBytes } from 'node:crypto';

let spawnFn: ((opts: SubAgentOpts) => Promise<SubAgentResult>) | null = null;

export interface SubAgentOpts {
  name: string;
  task: string;
  systemPrompt?: string;
  maxIterations?: number;
  timeout?: number;
  /** @deprecated Use mode instead */
  reportBack?: boolean;
  mode?: 'blocking' | 'parallel';
  /** Session ID of the parent — used to inherit promoted tools */
  parentSessionId?: string;
}

export interface SubAgentResult {
  agentId: string;
  name: string;
  status: 'completed' | 'running' | 'timeout' | 'error';
  output: string;
  toolCalls: { name: string; result: string }[];
  duration: number;
}

// ── Finished sub-agent sessions ───────────────────────────────────────

/** Tracks which subagent sessions have called subagent_finish, and their final output. */
const finishedSessions: Map<string, string> = new Map();

/** Mark a subagent session as finished with a final result. */
export function markSubAgentFinished(sessionId: string, result: string): void {
  finishedSessions.set(sessionId, result);
}

/** Check if a subagent session has called subagent_finish. */
export function isSubAgentFinished(sessionId: string): boolean {
  return finishedSessions.has(sessionId);
}

/** Get the finish result and clean up. */
export function consumeSubAgentFinish(sessionId: string): string | undefined {
  const result = finishedSessions.get(sessionId);
  finishedSessions.delete(sessionId);
  return result;
}

// ── Background sub-agent store ────────────────────────────────────────

interface BackgroundAgent {
  id: string;
  name: string;
  task: string;
  status: 'running' | 'completed' | 'timeout' | 'error';
  startTime: number;
  endTime?: number;
  output?: string;
  toolCalls: { name: string; result: string }[];
  error?: string;
}

const backgroundAgents: Map<string, BackgroundAgent> = new Map();

function generateId(): string {
  return randomBytes(4).toString('hex');
}

function cleanupOldAgents(): void {
  const entries = [...backgroundAgents.entries()];
  const completed = entries.filter(([, a]) => a.status !== 'running');
  if (completed.length > 50) {
    completed
      .sort((a, b) => (a[1].startTime - b[1].startTime))
      .slice(0, completed.length - 50)
      .forEach(([id]) => backgroundAgents.delete(id));
  }
}

/** Get all background agents (for gateway API). */
export function getBackgroundAgents(): BackgroundAgent[] {
  return [...backgroundAgents.values()];
}

/** Clear completed background agents (for gateway API). Returns count cleared. */
export function clearCompletedAgents(): number {
  let cleared = 0;
  for (const [id, agent] of backgroundAgents) {
    if (agent.status !== 'running') {
      backgroundAgents.delete(id);
      cleared++;
    }
  }
  return cleared;
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
      '',
      'Modes:',
      '  blocking (default) — waits for the sub-agent to finish and returns the result inline.',
      '  parallel — runs in background, returns a hash ID immediately. Use subagent_poll to check results.',
      '',
      'For backward compat: report_back=true maps to blocking, report_back=false maps to parallel.',
      '',
      'Great for: parallel research, code review, data processing, long-running tasks.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for this sub-agent (e.g. "researcher", "code-reviewer")' },
        task: { type: 'string', description: 'The task/prompt to give the sub-agent' },
        system_prompt: { type: 'string', description: 'Optional custom system prompt' },
        mode: { type: 'string', description: 'blocking (wait for result) or parallel (background, poll later)', enum: ['blocking', 'parallel'] },
        report_back: { type: 'boolean', description: 'Deprecated. true=blocking, false=parallel. Use mode instead.' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)' },
      },
      required: ['name', 'task'],
    },
    async execute(params, ctx) {
      if (!spawnFn) return { output: '', error: 'Sub-agent spawner not available' };

      const name = params.name as string;
      const task = params.task as string;
      const systemPrompt = params.system_prompt as string | undefined;
      const timeout = ((params.timeout as number) || 300) * 1000;
      const parentSessionId = ctx?.sessionId;

      // Resolve mode
      let mode: 'blocking' | 'parallel' = 'blocking';
      if (params.mode) {
        mode = params.mode as 'blocking' | 'parallel';
      } else if (params.report_back === false) {
        mode = 'parallel';
      }

      try {
        if (mode === 'parallel') {
          const id = generateId();
          const agent: BackgroundAgent = {
            id,
            name,
            task: task.slice(0, 200),
            status: 'running',
            startTime: Date.now(),
            toolCalls: [],
          };
          backgroundAgents.set(id, agent);
          cleanupOldAgents();

          spawnFn({ name, task, systemPrompt, reportBack: true, timeout, parentSessionId })
            .then((result) => {
              agent.status = result.status === 'completed' ? 'completed' : result.status;
              agent.output = result.output;
              agent.toolCalls = result.toolCalls;
              agent.endTime = Date.now();
            })
            .catch((err) => {
              agent.status = 'error';
              agent.error = (err as Error).message;
              agent.endTime = Date.now();
            });

          return {
            output: `Sub-agent "${name}" spawned in parallel.\nID: ${id}\nUse subagent_poll with id="${id}" to check status and get results.`,
          };
        } else {
          const result = await spawnFn({ name, task, systemPrompt, reportBack: true, timeout, parentSessionId });

          const statusLine = result.status === 'completed'
            ? `completed in ${(result.duration / 1000).toFixed(1)}s`
            : `${result.status} after ${(result.duration / 1000).toFixed(1)}s`;

          const toolLine = result.toolCalls.length > 0
            ? `\nTools used: ${result.toolCalls.map(t => t.name).join(', ')}`
            : '';

          return { output: `Sub-agent "${name}" ${statusLine}${toolLine}\n\n${result.output}` };
        }
      } catch (err) {
        return { output: '', error: `Sub-agent spawn failed: ${(err as Error).message}` };
      }
    },
  },
  {
    name: 'subagent_finish',
    description: [
      'Signal that you (a sub-agent) have completed your task.',
      'Call this when you are DONE with your work and want to return a final result.',
      'Without calling this tool, you will keep getting "continue" prompts.',
      '',
      'Pass your final summary/result as the `result` parameter.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        result: { type: 'string', description: 'Your final result/summary to return to the parent agent.' },
      },
      required: ['result'],
    },
    async execute(params, ctx) {
      const result = (params.result as string) || 'Task completed.';
      const sessionId = ctx?.sessionId || '';

      // Mark this session as finished
      markSubAgentFinished(sessionId, result);

      return { output: `SUBAGENT_FINISH: ${result}` };
    },
  },
  {
    name: 'subagent_poll',
    description: [
      'Check the status and results of parallel sub-agents.',
      '',
      'Actions:',
      '  check — check a specific sub-agent by ID. Returns status, output, duration.',
      '  list — list all background sub-agents (running + recent completed).',
      '  clear — clear all completed sub-agent results.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action: check, list, or clear', enum: ['check', 'list', 'clear'] },
        id: { type: 'string', description: 'Sub-agent ID (for check action)' },
      },
      required: ['action'],
    },
    async execute(params) {
      const action = params.action as string;

      switch (action) {
        case 'check': {
          const id = params.id as string;
          if (!id) return { output: '', error: 'Need id parameter to check a sub-agent.' };
          const agent = backgroundAgents.get(id);
          if (!agent) return { output: '', error: `No sub-agent found with ID "${id}". Use subagent_poll action=list to see all.` };

          const duration = ((agent.endTime || Date.now()) - agent.startTime) / 1000;
          const lines = [
            `ID: ${agent.id}`,
            `Name: ${agent.name}`,
            `Status: ${agent.status}`,
            `Duration: ${duration.toFixed(1)}s`,
            `Task: ${agent.task}`,
          ];

          if (agent.toolCalls.length > 0) {
            lines.push(`Tools used: ${agent.toolCalls.map(t => t.name).join(', ')}`);
          }

          if (agent.status === 'running') {
            lines.push('\n⏳ Still running... poll again later.');
          } else if (agent.output) {
            lines.push(`\n--- Output ---\n${agent.output}`);
          }
          if (agent.error) {
            lines.push(`\nError: ${agent.error}`);
          }

          return { output: lines.join('\n') };
        }

        case 'list': {
          if (backgroundAgents.size === 0) return { output: 'No background sub-agents.' };
          const lines: string[] = [`Background sub-agents (${backgroundAgents.size}):\n`];
          for (const [id, agent] of backgroundAgents) {
            const duration = ((agent.endTime || Date.now()) - agent.startTime) / 1000;
            const statusIcon = agent.status === 'running' ? '⏳' : agent.status === 'completed' ? '✅' : '❌';
            lines.push(`${statusIcon} ${id} | ${agent.name} | ${agent.status} | ${duration.toFixed(1)}s | ${agent.task.slice(0, 80)}`);
          }
          return { output: lines.join('\n') };
        }

        case 'clear': {
          let cleared = 0;
          for (const [id, agent] of backgroundAgents) {
            if (agent.status !== 'running') {
              backgroundAgents.delete(id);
              cleared++;
            }
          }
          return { output: `Cleared ${cleared} completed sub-agents. ${backgroundAgents.size} still running.` };
        }

        default:
          return { output: '', error: `Unknown action "${action}". Use: check, list, clear` };
      }
    },
  },
];
