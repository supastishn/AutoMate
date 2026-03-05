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
import { getCurrentConfig, saveConfig } from '../../config/loader.js';

let spawnFn: ((opts: SubAgentOpts) => Promise<SubAgentResult>) | null = null;
/** Callback to notify the parent session when a parallel sub-agent finishes */
let notifyParentFn: ((parentSessionId: string, message: string) => void) | null = null;
/** Path to persist background agents */
let persistPath: string | null = null;

// ── Concurrency limiting ───────────────────────────────────────────────

/** Maximum concurrent subagents (updated from config) */
let maxConcurrent = 3;
/** Configured subagent profiles (keyed by lowercase profile name) */
const subagentProfiles: Map<string, {
  name: string;
  model?: string;
  systemPrompt?: string;
  maxIterations?: number;
  timeoutMs?: number;
}> = new Map();
/** IDs of currently running subagents */
const runningAgents = new Set<string>();

interface QueuedAgent {
  id: string;
  agent: BackgroundAgent;
  opts: SubAgentOpts;
}

/** Queue of subagents waiting to start */
const queuedAgents: QueuedAgent[] = [];

/** Set the maximum concurrent subagents (called from config loader) */
export function setSubAgentMaxConcurrent(max: number): void {
  maxConcurrent = Math.max(1, Math.min(20, max));
}

/** Set reusable subagent profiles from config (called by Agent on startup/config reload). */
export function setSubAgentProfiles(profiles: {
  name: string;
  model?: string;
  systemPrompt?: string;
  maxIterations?: number;
  timeoutMs?: number;
}[] = []): void {
  subagentProfiles.clear();
  for (const profile of profiles) {
    if (!profile?.name) continue;
    subagentProfiles.set(profile.name.toLowerCase(), profile);
  }
}

/** Get current concurrency info */
export function getSubAgentConcurrencyInfo(): { running: number; max: number; queued: number } {
  return {
    running: runningAgents.size,
    max: maxConcurrent,
    queued: queuedAgents.length,
  };
}


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
  /** Model to use for this subagent (name or model ID) */
  model?: string;
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
  status: 'queued' | 'running' | 'completed' | 'timeout' | 'error';
  startTime: number;
  endTime?: number;
  output?: string;
  toolCalls: { name: string; result: string }[];
  error?: string;
  /** Position in queue when status is 'queued' */
  queuePosition?: number;
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

/** Start executing a subagent (used for both immediate and queued starts) */
function startSubAgentExecution(id: string, agent: BackgroundAgent, opts: SubAgentOpts): void {
  if (!spawnFn) {
    agent.status = 'error';
    agent.error = 'Sub-agent spawner not available';
    agent.endTime = Date.now();
    persistAgents();
    return;
  }

  runningAgents.add(id);
  agent.status = 'running';
  agent.startTime = Date.now();
  persistAgents();

  spawnFn(opts)
    .then((result) => {
      agent.status = result.status === 'completed' ? 'completed' : result.status;
      agent.output = result.output;
      agent.toolCalls = result.toolCalls;
      agent.endTime = Date.now();
      persistAgents();

      if (agent.parentSessionId && notifyParentFn) {
        const duration = ((agent.endTime - agent.startTime) / 1000).toFixed(1);
        const preview = (result.output || '').slice(0, 500);
        notifyParentFn(agent.parentSessionId, `[Sub-agent completed — "${agent.name}" (${id}) finished in ${duration}s]\n\n${preview}${(result.output || '').length > 500 ? '\n\n... (use subagent_poll to see full output)' : ''}`);
      }
    })
    .catch((err) => {
      agent.status = 'error';
      agent.error = (err as Error).message;
      agent.endTime = Date.now();
      persistAgents();

      if (agent.parentSessionId && notifyParentFn) {
        notifyParentFn(agent.parentSessionId, `[Sub-agent error — "${agent.name}" (${id}) failed: ${(err as Error).message}]`);
      }
    })
    .finally(() => {
      runningAgents.delete(id);
      tryStartQueued();
    });
}

/** Try to start queued agents if slots are available */
function tryStartQueued(): void {
  while (runningAgents.size < maxConcurrent && queuedAgents.length > 0) {
    const next = queuedAgents.shift()!;
    // Update queue positions for remaining agents
    queuedAgents.forEach((qa, idx) => {
      qa.agent.queuePosition = idx + 1;
    });
    startSubAgentExecution(next.id, next.agent, next.opts);
  }
  persistAgents();
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

/** Get agents that were running when server stopped — expires them all (no auto-resume) */
export function getInterruptedAgents(): BackgroundAgent[] {
  const now = Date.now();
  const interrupted = [...backgroundAgents.values()].filter(a => a.status === 'running');
  for (const a of interrupted) {
    a.status = 'timeout';
    a.endTime = now;
    a.output = 'Subagent expired during server restart. Use subagent_poll action=clear to clean up.';
  }
  if (interrupted.length > 0) persistAgents();
  return interrupted;
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
      'Spawn an independent sub-agent with its own session and tools.',
      'Modes: blocking (wait for result) or parallel (background, use subagent_poll to check).',
      'Supports model override, profiles, system_prompt, timeout, and max_iterations.',
      'Also: add_profile, remove_profile, list_profiles for managing reusable subagent configs.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['spawn', 'add_profile', 'remove_profile', 'list_profiles'], description: 'Action to perform (default: spawn).' },
        name: { type: 'string', description: 'Name for this sub-agent or profile name' },
        task: { type: 'string', description: 'The task/prompt to give the sub-agent (for spawn)' },
        mode: { type: 'string', description: 'blocking (wait for result) or parallel (background, poll later)', enum: ['blocking', 'parallel'] },
        model: { type: 'string', description: 'Model to use for this subagent (e.g. "gpt-4", "claude-opus", or alias like "fast"). Uses parent model if not specified.' },
        profile: { type: 'string', description: 'Optional subagent profile name from config.agent.subagent.profiles.' },
        system_prompt: { type: 'string', description: 'Optional system prompt override for this subagent or profile.' },
        timeout_ms: { type: 'number', description: 'Optional timeout in ms (max 24h).' },
        max_iterations: { type: 'number', description: 'Optional max iterations for this subagent run or profile.' },
      },
      required: ['name'],
    },
    async execute(params, ctx) {
      const action = (params.action as string) || 'spawn';
      const name = params.name as string;

      // Profile management actions
      if (action === 'list_profiles') {
        if (subagentProfiles.size === 0) return { output: 'No subagent profiles configured.' };
        const lines = ['Configured subagent profiles:'];
        for (const [pname, p] of subagentProfiles.entries()) {
          lines.push(`- ${pname}: model=${p.model || 'parent'}, maxIter=${p.maxIterations || 'default'}, timeout=${p.timeoutMs ? `${p.timeoutMs / 1000}s` : 'default'}`);
        }
        return { output: lines.join('\n') };
      }

      if (action === 'add_profile') {
        if (!name) return { output: '', error: 'Profile name is required.' };
        const profile = {
          name,
          model: params.model as string | undefined,
          systemPrompt: params.system_prompt as string | undefined,
          maxIterations: params.max_iterations as number | undefined,
          timeoutMs: params.timeout_ms as number | undefined,
        };
        subagentProfiles.set(name.toLowerCase(), profile);
        // Persist to config
        try {
          const config = getCurrentConfig();
          if (config) {
            const profiles = [...(config.agent.subagent?.profiles || []).filter((p: any) => p.name?.toLowerCase() !== name.toLowerCase()), profile];
            (config as any).agent.subagent = { ...config.agent.subagent, profiles };
            saveConfig(config);
          }
        } catch {}
        return { output: `Subagent profile "${name}" saved. Use profile="${name}" when spawning subagents.` };
      }

      if (action === 'remove_profile') {
        if (!name) return { output: '', error: 'Profile name is required.' };
        if (!subagentProfiles.has(name.toLowerCase())) return { output: '', error: `Profile "${name}" not found.` };
        subagentProfiles.delete(name.toLowerCase());
        // Persist removal
        try {
          const config = getCurrentConfig();
          if (config) {
            const profiles = (config.agent.subagent?.profiles || []).filter((p: any) => p.name?.toLowerCase() !== name.toLowerCase());
            (config as any).agent.subagent = { ...config.agent.subagent, profiles };
            saveConfig(config);
          }
        } catch {}
        return { output: `Subagent profile "${name}" removed.` };
      }

      // Default: spawn action
      if (!spawnFn) return { output: '', error: 'Sub-agent spawner not available' };
      const task = params.task as string;
      if (!task) return { output: '', error: 'Task is required for spawning a sub-agent.' };
      const profileName = params.profile as string | undefined;
      const profile = profileName ? subagentProfiles.get(profileName.toLowerCase()) : undefined;
      if (profileName && !profile) {
        const available = [...subagentProfiles.keys()].sort();
        const suffix = available.length > 0 ? ` Available profiles: ${available.join(', ')}` : ' No profiles are configured.';
        return { output: '', error: `Profile "${profileName}" was not found.${suffix}` };
      }
      const defaultTimeoutMs = 24 * 60 * 60 * 1000;
      const timeoutRaw = (params.timeout_ms as number | undefined) ?? profile?.timeoutMs ?? defaultTimeoutMs;
      const timeout = Math.min(defaultTimeoutMs, Math.max(1000, Number(timeoutRaw) || defaultTimeoutMs));
      const systemPrompt = (params.system_prompt as string | undefined) ?? profile?.systemPrompt;
      const parentSessionId = ctx?.sessionId;
      const model = (params.model as string | undefined) ?? profile?.model;
      const maxIterations = (params.max_iterations as number | undefined) ?? profile?.maxIterations;

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
          const opts: SubAgentOpts = { name, task, systemPrompt, reportBack: true, timeout, parentSessionId, model, maxIterations };
          
          const canStartNow = runningAgents.size < maxConcurrent;
          const agent: BackgroundAgent = {
            id,
            parentSessionId,
            sessionId,
            name,
            task: task.slice(0, 500),  // Store more of task for context
            systemPrompt,
            status: canStartNow ? 'running' : 'queued',
            startTime: Date.now(),
            toolCalls: [],
            queuePosition: canStartNow ? undefined : queuedAgents.length + 1,
          };
          backgroundAgents.set(id, agent);
          persistAgents();  // Persist immediately so we can resume if server restarts
          cleanupOldAgents();

          if (canStartNow) {
            // Start immediately
            startSubAgentExecution(id, agent, opts);
            return {
              output: `Sub-agent "${name}" spawned in parallel.\nID: ${id}\nSubagents auto-notify when complete. You can manually check via subagent_poll, but they will automatically notify you even if you don't.`,
            };
          } else {
            // Queue it - will start when a slot frees up
            queuedAgents.push({ id, agent, opts });
            persistAgents();
            return {
              output: `Sub-agent "${name}" queued (${runningAgents.size}/${maxConcurrent} running, position ${queuedAgents.length} in queue).\nID: ${id}\nWill start automatically when a slot frees up. Subagents auto-notify when complete — no need to poll.`,
            };
          }
        } else {
          const result = await spawnFn({ name, task, systemPrompt, reportBack: true, timeout, parentSessionId, model, maxIterations });

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
      'Signal sub-agent task completion. Call with your final result to properly terminate.',
      'Required for sub-agents — without it, you keep getting "continue" prompts.',
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
      'Check status and results of parallel sub-agents.',
      'Actions: check (by ID), list (all agents), clear (remove completed from memory).',
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
          ];

          if (agent.status === 'queued' && agent.queuePosition) {
            lines.push(`Queue Position: ${agent.queuePosition}`);
          }

          lines.push(`Duration: ${duration.toFixed(1)}s`, `Task: ${agent.task}`);

          if (agent.toolCalls.length > 0) {
            lines.push(`Tools used: ${agent.toolCalls.map(t => t.name).join(', ')}`);
          }

          if (agent.status === 'queued') {
            lines.push(`\n⏸️ Queued — waiting for slot (${runningAgents.size}/${maxConcurrent} running). Will start automatically.`);
          } else if (agent.status === 'running') {
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
          const concurrency = getSubAgentConcurrencyInfo();
          const lines: string[] = [`Background sub-agents (${backgroundAgents.size}, ${concurrency.running}/${concurrency.max} running, ${concurrency.queued} queued):\n`];
          for (const [id, agent] of backgroundAgents) {
            const duration = ((agent.endTime || Date.now()) - agent.startTime) / 1000;
            const statusIcon = agent.status === 'queued' ? '⏸️' : agent.status === 'running' ? '⏳' : agent.status === 'completed' ? '✅' : '❌';
            const queueInfo = agent.status === 'queued' && agent.queuePosition ? ` [Q:${agent.queuePosition}]` : '';
            lines.push(`${statusIcon} ${id}${queueInfo} | ${agent.name} | ${agent.status} | ${duration.toFixed(1)}s | ${agent.task.slice(0, 80)}`);
          }
          return { output: lines.join('\n') };
        }

        case 'clear': {
          let cleared = 0;
          for (const [id, agent] of backgroundAgents) {
            // Don't clear running or queued agents
            if (agent.status !== 'running' && agent.status !== 'queued') {
              backgroundAgents.delete(id);
              cleared++;
            }
          }
          const remaining = backgroundAgents.size;
          return { output: `Cleared ${cleared} completed sub-agents. ${remaining} still active (running or queued).` };
        }

        default:
          return { output: '', error: `Unknown action "${action}". Use: check, list, clear` };
      }
    },
  },
];
