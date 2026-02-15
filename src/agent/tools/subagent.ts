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
 *
 * Background agents are persisted to disk so they can resume after restart.
 */

import type { Tool } from '../tool-registry.js';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

let spawnFn: ((opts: SubAgentOpts) => Promise<SubAgentResult>) | null = null;
/** Callback to notify the parent session when a parallel sub-agent finishes */
let notifyParentFn: ((parentSessionId: string, message: string) => void) | null = null;
/** Path to persist background agents */
let persistPath: string | null = null;


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
  /** Existing session ID to resume (for restart recovery) */
  resumeSessionId?: string;
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
  parentSessionId?: string;
  sessionId?: string;  // The subagent's own session ID for resume
  name: string;
  task: string;
  systemPrompt?: string;
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

/** Set the path for persisting background agents */
export function setSubAgentPersistPath(path: string): void {
  persistPath = path;
  // Ensure directory exists
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Load existing state
  loadPersistedAgents();
}

/** Save background agents to disk */
function persistAgents(): void {
  if (!persistPath) return;
  try {
    const data = JSON.stringify([...backgroundAgents.values()], null, 2);
    writeFileSync(persistPath, data, 'utf-8');
  } catch (err) {
    console.error(`[subagent] Failed to persist agents: ${(err as Error).message}`);
  }
}

/** Load background agents from disk */
function loadPersistedAgents(): void {
  if (!persistPath || !existsSync(persistPath)) return;
  try {
    const data = readFileSync(persistPath, 'utf-8');
    const agents: BackgroundAgent[] = JSON.parse(data);
    for (const agent of agents) {
      backgroundAgents.set(agent.id, agent);
    }
    console.log(`[subagent] Loaded ${agents.length} persisted agents`);
  } catch (err) {
    console.error(`[subagent] Failed to load persisted agents: ${(err as Error).message}`);
  }
}

/** Get agents that were running when server stopped (for resume) */
export function getInterruptedAgents(): BackgroundAgent[] {
  return [...backgroundAgents.values()].filter(a => a.status === 'running');
}

/** Resume an interrupted agent - called from index.ts on startup */
export async function resumeAgent(agent: BackgroundAgent): Promise<void> {
  if (!spawnFn) {
    console.error(`[subagent] Cannot resume "${agent.name}" - spawner not available`);
    return;
  }

  console.log(`[subagent] Resuming interrupted agent "${agent.name}" (${agent.id})`);

  // The agent's session still exists, so spawning with the same sessionId will continue it
  spawnFn({
    name: agent.name,
    task: '[RESUME] Continue from where you left off. The server was restarted. Review your progress and complete the task.',
    systemPrompt: agent.systemPrompt,
    reportBack: true,
    timeout: 24 * 60 * 60 * 1000,
    parentSessionId: agent.parentSessionId,
    resumeSessionId: agent.sessionId,  // Pass existing session to continue
  })
    .then((result) => {
      agent.status = result.status === 'completed' ? 'completed' : result.status;
      agent.output = result.output;
      agent.toolCalls = result.toolCalls;
      agent.endTime = Date.now();
      persistAgents();

      if (agent.parentSessionId && notifyParentFn) {
        const duration = ((agent.endTime - agent.startTime) / 1000).toFixed(1);
        const preview = (result.output || '').slice(0, 500);
        notifyParentFn(agent.parentSessionId, `[Sub-agent resumed & completed — "${agent.name}" (${agent.id}) finished in ${duration}s]\n\n${preview}${(result.output || '').length > 500 ? '\n\n... (use subagent_poll to see full output)' : ''}`);
      }
    })
    .catch((err) => {
      agent.status = 'error';
      agent.error = (err as Error).message;
      agent.endTime = Date.now();
      persistAgents();

      if (agent.parentSessionId && notifyParentFn) {
        notifyParentFn(agent.parentSessionId, `[Sub-agent resume failed — "${agent.name}" (${agent.id}): ${(err as Error).message}]`);
      }
    });
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

/** Kill/stop a running subagent by ID. Returns the agent if found, null otherwise. */
export function killSubAgent(id: string): BackgroundAgent | null {
  const agent = backgroundAgents.get(id);
  if (!agent) return null;

  if (agent.status === 'running') {
    agent.status = 'error';
    agent.error = 'Killed by user';
    agent.endTime = Date.now();
    persistAgents();
  }

  return agent;
}

export function setSubAgentNotifier(fn: (parentSessionId: string, message: string) => void): void {
  notifyParentFn = fn;
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
        mode: { type: 'string', description: 'blocking (wait for result) or parallel (background, poll later). Parallel agents auto-notify when done.', enum: ['blocking', 'parallel'] },
        report_back: { type: 'boolean', description: 'Deprecated. true=blocking, false=parallel. Use mode instead.' },
      },
      required: ['name', 'task'],
    },
    async execute(params, ctx) {
      if (!spawnFn) return { output: '', error: 'Sub-agent spawner not available' };

      const name = params.name as string;
      const task = params.task as string;
      // Fixed 24-hour timeout for all subagents
      const timeout = 24 * 60 * 60 * 1000;
      const systemPrompt = params.system_prompt as string | undefined;
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
          // Generate the session ID that will be used (matches agent.ts logic)
          const sessionId = `subagent:${name}:${id}`;
          const agent: BackgroundAgent = {
            id,
            parentSessionId,
            sessionId,
            name,
            task: task.slice(0, 500),  // Store more of task for context
            systemPrompt,
            status: 'running',
            startTime: Date.now(),
            toolCalls: [],
          };
          backgroundAgents.set(id, agent);
          persistAgents();  // Persist immediately so we can resume if server restarts
          cleanupOldAgents();

          spawnFn({ name, task, systemPrompt, reportBack: true, timeout, parentSessionId })
            .then((result) => {
              agent.status = result.status === 'completed' ? 'completed' : result.status;
              agent.output = result.output;
              agent.toolCalls = result.toolCalls;
              agent.endTime = Date.now();
              persistAgents();  // Update persisted state

              // Notify the parent session that this sub-agent finished
              if (parentSessionId && notifyParentFn) {
                const duration = ((agent.endTime - agent.startTime) / 1000).toFixed(1);
                const preview = (result.output || '').slice(0, 500);
                notifyParentFn(parentSessionId, `[Sub-agent completed — "${name}" (${id}) finished in ${duration}s]\n\n${preview}${(result.output || '').length > 500 ? '\n\n... (use subagent_poll to see full output)' : ''}`);
              }
            })
            .catch((err) => {
              agent.status = 'error';
              agent.error = (err as Error).message;
              agent.endTime = Date.now();
              persistAgents();  // Update persisted state

              // Notify the parent session about the error too
              if (parentSessionId && notifyParentFn) {
                notifyParentFn(parentSessionId, `[Sub-agent error — "${name}" (${id}) failed: ${(err as Error).message}]`);
              }
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
