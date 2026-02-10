/**
 * Heartbeat System — proactive agent wakeups driven by cron.
 * Reads HEARTBEAT.md for the agent's checklist, then triggers
 * a proactive message with those instructions.
 *
 * The heartbeat loops until the agent explicitly calls `heartbeat_finish`.
 * If the agent responds without calling it, we send a continue prompt.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryManager } from '../memory/manager.js';
import type { Agent } from '../agent/agent.js';
import type { Scheduler, CronJob } from '../cron/scheduler.js';
import type { Tool } from '../agent/tool-registry.js';

const HEARTBEAT_JOB_NAME = '__heartbeat__';
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_HEARTBEAT_ROUNDS = 20; // safety limit on continue loops

/** A single categorized item within a heartbeat summary. */
export interface HeartbeatSummaryCategory {
  category: string;   // e.g. "Memory", "System", "Tasks", "Monitoring"
  items: string[];     // individual things done in this category
}

/** A full heartbeat log entry persisted to disk. */
export interface HeartbeatLogEntry {
  sessionId: string;
  timestamp: number;
  summary: string;                       // raw summary text
  categories: HeartbeatSummaryCategory[]; // parsed categorized breakdown
  rounds: number;
  status: 'finished' | 'max_rounds' | 'error';
  toolsUsed: string[];
}

/** Tracks which heartbeat sessions have called heartbeat_finish. */
const finishedSessions: Set<string> = new Set();

/** Stores the summary text from heartbeat_finish calls, keyed by sessionId. */
const finishedSummaries: Map<string, string> = new Map();

/** Mark a heartbeat session as finished (called by the heartbeat_finish tool). */
export function markHeartbeatFinished(sessionId: string, summary?: string): void {
  finishedSessions.add(sessionId);
  if (summary) finishedSummaries.set(sessionId, summary);
}

/** Check if a heartbeat session has been marked finished. */
export function isHeartbeatFinished(sessionId: string): boolean {
  return finishedSessions.has(sessionId);
}

/** Get the stored summary for a finished session. */
export function getFinishedSummary(sessionId: string): string | undefined {
  return finishedSummaries.get(sessionId);
}

/** Clean up finished state for a session. */
function clearHeartbeatFinished(sessionId: string): void {
  finishedSessions.delete(sessionId);
  finishedSummaries.delete(sessionId);
}

/**
 * Parse a summary string into categories.
 * Expects format like:
 *   **Memory**: logged heartbeat start, reviewed daily logs
 *   **System**: checked disk space, verified uptime
 *   **Tasks**: completed backup, sent notification
 *
 * Falls back to a single "General" category if no pattern is found.
 */
function parseSummaryCategories(summary: string): HeartbeatSummaryCategory[] {
  const categories: HeartbeatSummaryCategory[] = [];

  // Try to parse lines with **Category**: items or [Category]: items or Category: items
  const lines = summary.split('\n').map(l => l.trim()).filter(Boolean);
  const catPattern = /^(?:\*\*(.+?)\*\*|(?:\[(.+?)\])|([A-Z][A-Za-z &/]+?))[:]\s*(.+)$/;

  for (const line of lines) {
    const m = line.match(catPattern);
    if (m) {
      const catName = (m[1] || m[2] || m[3]).trim();
      const itemsStr = m[4].trim();
      // Split items by comma, semicolon, or bullet
      const items = itemsStr
        .split(/[;,]|\s*[-•]\s*/)
        .map(s => s.trim())
        .filter(Boolean);
      if (items.length > 0) {
        // Merge if same category already exists
        const existing = categories.find(c => c.category.toLowerCase() === catName.toLowerCase());
        if (existing) {
          existing.items.push(...items);
        } else {
          categories.push({ category: catName, items });
        }
      }
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      // Bullet items without a category header — add to "General"
      const text = line.replace(/^[-*]\s*/, '').trim();
      if (text) {
        let gen = categories.find(c => c.category === 'General');
        if (!gen) {
          gen = { category: 'General', items: [] };
          categories.push(gen);
        }
        gen.items.push(text);
      }
    }
  }

  // Fallback: if no categories parsed, put the whole summary as a single "General" category
  if (categories.length === 0) {
    categories.push({ category: 'General', items: [summary] });
  }

  return categories;
}

/**
 * Create the heartbeat_finish tool.
 * This is registered as a core tool so it's always available.
 */
export function createHeartbeatFinishTool(): Tool {
  return {
    name: 'heartbeat_finish',
    description:
      'Call this tool when you have completed ALL heartbeat tasks. ' +
      'This signals that the heartbeat session is done. ' +
      'You MUST call this when finished — the heartbeat will keep asking you to continue until you do. ' +
      'IMPORTANT: Format your summary with categories using this format:\n' +
      '**Category Name**: item1, item2, item3\n' +
      '**Another Category**: item4, item5\n' +
      'Example categories: Memory, System, Tasks, Monitoring, Communication, Maintenance',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'Categorized summary of what was accomplished. Use format: **Category**: item1, item2. ' +
            'Each line should be a different category (Memory, System, Tasks, Monitoring, etc.)',
        },
      },
      required: ['summary'],
    },
    async execute(params, ctx) {
      const summary = (params.summary as string) || 'Heartbeat completed.';
      markHeartbeatFinished(ctx.sessionId, summary);
      console.log(`[heartbeat] Session ${ctx.sessionId} finished: ${summary}`);
      return { output: `Heartbeat marked as complete. Summary: ${summary}` };
    },
  };
}

/** Broadcaster function type — sends a JSON-serializable object to all WS clients. */
export type HeartbeatBroadcaster = (msg: Record<string, unknown>) => void;

export class HeartbeatManager {
  private memoryManager: MemoryManager;
  private agent: Agent;
  private scheduler: Scheduler;
  private enabled: boolean = false;
  private broadcaster: HeartbeatBroadcaster | null = null;
  private logFile: string;

  constructor(memoryManager: MemoryManager, agent: Agent, scheduler: Scheduler) {
    this.memoryManager = memoryManager;
    this.agent = agent;
    this.scheduler = scheduler;
    // Persistent log file in the memory directory
    this.logFile = join(memoryManager.getDirectory(), 'heartbeat-log.json');
  }

  /** Set the broadcaster function for live heartbeat events (call after gateway init). */
  setBroadcaster(fn: HeartbeatBroadcaster): void {
    this.broadcaster = fn;
  }

  /** Emit a heartbeat event to all connected clients. */
  private broadcast(event: Record<string, unknown>): void {
    if (this.broadcaster) {
      try { this.broadcaster(event); } catch {}
    }
  }

  /** Load the heartbeat log from disk. */
  private loadLog(): HeartbeatLogEntry[] {
    try {
      if (existsSync(this.logFile)) {
        return JSON.parse(readFileSync(this.logFile, 'utf-8'));
      }
    } catch {}
    return [];
  }

  /** Append an entry to the heartbeat log and write to disk. */
  private appendLog(entry: HeartbeatLogEntry): void {
    const log = this.loadLog();
    log.push(entry);
    // Keep last 200 entries max
    const trimmed = log.slice(-200);
    try {
      writeFileSync(this.logFile, JSON.stringify(trimmed, null, 2));
    } catch (err) {
      console.error(`[heartbeat] Failed to write log: ${(err as Error).message}`);
    }
  }

  /** Get the heartbeat log (most recent entries first). */
  getLog(limit: number = 50): HeartbeatLogEntry[] {
    const log = this.loadLog();
    return log.slice(-limit).reverse();
  }

  /** Start the heartbeat system. Creates a cron job if one doesn't exist. */
  start(intervalMs?: number, force?: boolean): void {
    const interval = intervalMs || DEFAULT_INTERVAL_MS;

    // Check if heartbeat job already exists
    const existing = this.scheduler.listJobs().find(j => j.name === HEARTBEAT_JOB_NAME);
    if (existing) {
      if (force) {
        // Force: delete and recreate with new interval
        this.scheduler.removeJob(existing.id);
      } else {
        if (!existing.enabled) {
          this.scheduler.enableJob(existing.id);
        }
        this.enabled = true;
        return;
      }
    }

    // Create the heartbeat job
    this.scheduler.addJob(
      HEARTBEAT_JOB_NAME,
      '__heartbeat__', // special prompt marker recognized by the trigger
      { type: 'interval', every: interval },
    );

    this.enabled = true;
  }

  /** Stop heartbeats (disable the cron job, don't delete it) */
  stop(): void {
    const job = this.scheduler.listJobs().find(j => j.name === HEARTBEAT_JOB_NAME);
    if (job) {
      this.scheduler.disableJob(job.id);
    }
    this.enabled = false;
  }

  /** Check if heartbeat is active */
  isActive(): boolean {
    return this.enabled;
  }

  /**
   * Execute a heartbeat. Called by the cron trigger.
   * Reads HEARTBEAT.md and sends it as a proactive agent message.
   * Loops until the agent calls heartbeat_finish or we hit the safety limit.
   */
  async trigger(): Promise<string | null> {
    const heartbeatContent = this.memoryManager.getIdentityFile('HEARTBEAT.md');
    if (!heartbeatContent || heartbeatContent.trim().length === 0) {
      console.log('[heartbeat] No HEARTBEAT.md content, skipping.');
      return null;
    }

    const sessionId = `heartbeat:${Date.now()}`;
    console.log(`[heartbeat] ---- TRIGGER START ---- session=${sessionId}`);

    // Clean any stale finished state
    clearHeartbeatFinished(sessionId);

    // Auto-elevate heartbeat sessions so the agent has full tool access
    this.agent.elevateSession(sessionId);
    console.log(`[heartbeat] Session elevated.`);

    // Promote heartbeat_finish for this session only (not available in normal sessions)
    const promoted = this.agent.promoteToolForSession(sessionId, 'heartbeat_finish');
    console.log(`[heartbeat] heartbeat_finish promoted for session: ${promoted}`);

    // Log diagnostics: what tools are available?
    const toolStats = this.agent.getToolStats();
    console.log(`[heartbeat] Core tools (${toolStats.coreToolCount}): ${toolStats.coreTools.join(', ')}`);
    console.log(`[heartbeat] Deferred tools (${toolStats.deferredToolCount}): ${toolStats.deferredTools.map(t => t.name).join(', ')}`);

    // Build the initial heartbeat prompt
    const prompt = [
      '[SYSTEM HEARTBEAT — AUTOMATED TASK EXECUTION]',
      '',
      'This is an automated heartbeat. You are REQUIRED to use tools to complete these tasks.',
      'Do NOT respond with text only. You MUST call tools.',
      '',
      'MANDATORY FIRST STEP: Call `memory_log` with a note that heartbeat started.',
      '',
      'Then execute EACH task below using the appropriate tools:',
      '',
      '---',
      heartbeatContent,
      '---',
      '',
      'For EACH task above:',
      '1. Use `bash` to run commands, `read_file` to check files, `memory_log` to log findings',
      '2. If anything should be saved permanently, use `memory_save` or `memory_append`',
      '3. If daily log needs review, use `identity_read` to read MEMORY.md, then `memory_log` results',
      '',
      'When you have completed ALL tasks, you MUST call `heartbeat_finish` with a summary.',
      'The heartbeat will NOT end until you call `heartbeat_finish`.',
      '',
      'IMPORTANT: Your response MUST include tool calls. A text-only response is a failure.',
      'Start by calling memory_log right now.',
    ].join('\n');

    let lastContent = '';
    let round = 0;
    const toolsUsed: string[] = [];

    // Broadcast heartbeat start
    this.broadcast({
      type: 'heartbeat_activity',
      event: 'start',
      sessionId,
      timestamp: Date.now(),
    });

    try {
      // Round 1: send the initial prompt
      console.log(`[heartbeat] Round 1: sending initial prompt (${prompt.length} chars)`);
      const result = await this.agent.processMessage(sessionId, prompt);
      lastContent = result.content || '';
      round = 1;

      console.log(`[heartbeat] Round 1 result: content=${lastContent.length} chars, toolCalls=${result.toolCalls.length} [${result.toolCalls.map(t => t.name).join(', ')}]`);

      // Collect tools used
      for (const tc of result.toolCalls) {
        if (!toolsUsed.includes(tc.name)) toolsUsed.push(tc.name);
      }

      // Broadcast round result
      this.broadcast({
        type: 'heartbeat_activity',
        event: 'round',
        sessionId,
        round,
        content: lastContent.slice(0, 500),
        toolCalls: result.toolCalls.map(t => t.name),
        timestamp: Date.now(),
      });

      if (result.toolCalls.length === 0) {
        console.warn(`[heartbeat] WARNING: Round 1 returned ZERO tool calls. LLM may not have received tools.`);
        console.warn(`[heartbeat] Response text: ${lastContent.slice(0, 500)}`);
      }

      // Check if already finished
      if (isHeartbeatFinished(sessionId)) {
        console.log(`[heartbeat] Finished after round 1.`);
        const summary = getFinishedSummary(sessionId) || lastContent;
        this.appendLog({
          sessionId, timestamp: Date.now(), summary,
          categories: parseSummaryCategories(summary),
          rounds: round, status: 'finished', toolsUsed,
        });
        clearHeartbeatFinished(sessionId);
        this.broadcast({ type: 'heartbeat_activity', event: 'end', sessionId, round, status: 'finished', timestamp: Date.now() });
        return lastContent;
      }

      // Continue loop: keep sending continue prompts until finish is called
      while (round < MAX_HEARTBEAT_ROUNDS) {
        round++;

        const continuePrompt = [
          'Continue working on the heartbeat tasks.',
          'If you have completed ALL tasks, call `heartbeat_finish` with a summary of what you did.',
          'If you have NOT completed all tasks, continue executing them using tools.',
          'Do NOT just respond with text — use tools or call heartbeat_finish.',
        ].join(' ');

        console.log(`[heartbeat] Round ${round}: sending continue prompt`);
        const cont = await this.agent.processMessage(sessionId, continuePrompt);
        lastContent = cont.content || '';

        console.log(`[heartbeat] Round ${round} result: content=${lastContent.length} chars, toolCalls=${cont.toolCalls.length} [${cont.toolCalls.map(t => t.name).join(', ')}]`);

        // Collect tools used
        for (const tc of cont.toolCalls) {
          if (!toolsUsed.includes(tc.name)) toolsUsed.push(tc.name);
        }

        // Broadcast round result
        this.broadcast({
          type: 'heartbeat_activity',
          event: 'round',
          sessionId,
          round,
          content: lastContent.slice(0, 500),
          toolCalls: cont.toolCalls.map(t => t.name),
          timestamp: Date.now(),
        });

        if (isHeartbeatFinished(sessionId)) {
          console.log(`[heartbeat] Finished after round ${round}.`);
          const summary = getFinishedSummary(sessionId) || lastContent;
          this.appendLog({
            sessionId, timestamp: Date.now(), summary,
            categories: parseSummaryCategories(summary),
            rounds: round, status: 'finished', toolsUsed,
          });
          clearHeartbeatFinished(sessionId);
          this.broadcast({ type: 'heartbeat_activity', event: 'end', sessionId, round, status: 'finished', timestamp: Date.now() });
          return lastContent;
        }

        // If no tool calls AND no finish for 3 consecutive text-only responses, force stop
        if (cont.toolCalls.length === 0 && round >= 3) {
          console.warn(`[heartbeat] Round ${round}: text-only response again, checking if stuck...`);
        }
      }

      console.warn(`[heartbeat] Hit max rounds (${MAX_HEARTBEAT_ROUNDS}), force stopping.`);
      const summary = getFinishedSummary(sessionId) || lastContent || 'Hit max rounds without finishing.';
      this.appendLog({
        sessionId, timestamp: Date.now(), summary,
        categories: parseSummaryCategories(summary),
        rounds: round, status: 'max_rounds', toolsUsed,
      });
      clearHeartbeatFinished(sessionId);
      this.broadcast({ type: 'heartbeat_activity', event: 'end', sessionId, round, status: 'max_rounds', timestamp: Date.now() });
      return lastContent;
    } catch (err) {
      console.error(`[heartbeat] Trigger failed at round ${round}: ${(err as Error).message}`);
      console.error(`[heartbeat] Stack: ${(err as Error).stack}`);
      this.appendLog({
        sessionId, timestamp: Date.now(),
        summary: `Error: ${(err as Error).message}`,
        categories: [{ category: 'Error', items: [(err as Error).message] }],
        rounds: round, status: 'error', toolsUsed,
      });
      clearHeartbeatFinished(sessionId);
      this.broadcast({ type: 'heartbeat_activity', event: 'end', sessionId, round, status: 'error', error: (err as Error).message, timestamp: Date.now() });
      return null;
    }
  }
}

/**
 * Wire the heartbeat into the cron scheduler.
 * Call this after both scheduler and agent are initialized.
 */
export function wireHeartbeat(
  memoryManager: MemoryManager,
  agent: Agent,
  scheduler: Scheduler,
  autoStart: boolean = true,
): HeartbeatManager {
  // Register the heartbeat_finish tool as a deferred tool (only promoted for heartbeat sessions)
  agent.registerDeferredTool(createHeartbeatFinishTool(), 'Signal heartbeat task completion — only used in heartbeat sessions');
  console.log('[heartbeat] Registered heartbeat_finish tool (deferred).');

  const hb = new HeartbeatManager(memoryManager, agent, scheduler);

  // Patch the scheduler's onTrigger to intercept heartbeat jobs
  const originalJobs = scheduler.listJobs();
  const existingHeartbeat = originalJobs.find(j => j.name === HEARTBEAT_JOB_NAME);

  if (autoStart) {
    hb.start();
  } else if (existingHeartbeat?.enabled) {
    hb.start(); // was already enabled from a previous run
  }

  return hb;
}
