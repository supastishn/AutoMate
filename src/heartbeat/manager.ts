/**
 * Heartbeat System — OpenClaw-style single-turn status checks.
 *
 * Runs in the existing main session (or a configurable target session).
 * Reads HEARTBEAT.md and sends it as a single LLM turn. If the response
 * starts or ends with HEARTBEAT_OK, it's a "nothing to report" ack — strip
 * the token and suppress delivery. If the response has actual content,
 * broadcast it to WebSocket clients as an alert.
 *
 * Session `updatedAt` is preserved so heartbeats don't reset idle expiry.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryManager } from '../memory/manager.js';
import type { Agent } from '../agent/agent.js';
import type { Scheduler } from '../cron/scheduler.js';
import {
  getAutonomousGoal,
  promoteNextGoal,
  isAutoProcessEnabled,
  getUnblockedDependents,
  checkDecomposedParents,
  autoApproveSuggestedGoals,
  getAdaptiveInterval,
  requeueRecurringGoals,
  autoRetryFailedGoals,
  escalateGoals,
  generateDailyReport,
  getGoalsSummary,
} from '../agent/tools/goals.js';
import { notifyChatSession } from '../agent/tools/sessions.js';

const HEARTBEAT_JOB_PREFIX = '__heartbeat__';
const HEARTBEAT_TASK_PREFIX = '__hbtask__';
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const HEARTBEAT_OK_TOKEN = 'HEARTBEAT_OK';
const ACK_MAX_CHARS = 200; // responses under this length containing HEARTBEAT_OK are treated as acks
const OBJECTIVE_LOG_FILE = 'OBJECTIVE_LOG.md';
const OBJECTIVE_MAX_CHARS = 2000;
const HEARTBEAT_TASKS_FILE = 'heartbeat-tasks.json';

// ── Heartbeat Tasks (Feature 10: Multiple Named Heartbeats) ──────────────────

export interface HeartbeatTask {
  id: string;
  name: string;
  prompt: string;              // Custom prompt text or path to .md file
  intervalMs: number;          // How often to run
  jitterMs?: number;           // Random variance
  enabled: boolean;
  sessionId?: string;          // Custom session (defaults to heartbeat session)
  integrateGoals?: boolean;    // Whether to include goal processing (default: false)
  createdAt: number;
  lastRunAt?: number;
}

// ── Randomized Heartbeat Prompts ─────────────────────────────────────────────
// 5 base templates with synonym maps for variety and natural language variation

const SYNONYMS = {
  read: ['read', 'review', 'examine', 'check', 'inspect', 'look at', 'go through', 'scan', 'peruse', 'study'],
  following: ['following', 'below', 'subsequent', 'next', 'attached', 'included', 'provided', 'given'],
  checklist: ['checklist', 'list', 'items', 'tasks', 'reminders', 'notes', 'instructions', 'guidelines', 'points', 'agenda'],
  follow: ['follow', 'adhere to', 'comply with', 'execute', 'carry out', 'perform', 'act on', 'implement', 'fulfill', 'observe'],
  strictly: ['strictly', 'exactly', 'precisely', 'carefully', 'thoroughly', 'diligently', 'rigorously', 'meticulously', 'faithfully', 'closely'],
  infer: ['infer', 'assume', 'guess', 'presume', 'suppose', 'deduce', 'speculate', 'imagine', 'conjecture', 'surmise'],
  repeat: ['repeat', 'rehash', 'revisit', 'bring up', 'reference', 'mention', 'cite', 'recall', 'reiterate', 'return to'],
  old: ['old', 'previous', 'prior', 'past', 'earlier', 'former', 'preceding', 'historical', 'archived', 'outdated'],
  tasks: ['tasks', 'work', 'items', 'jobs', 'actions', 'activities', 'duties', 'assignments', 'responsibilities', 'chores'],
  chats: ['chats', 'conversations', 'sessions', 'messages', 'exchanges', 'discussions', 'dialogues', 'communications', 'interactions', 'talks'],
  nothing: ['nothing', 'no items', 'no tasks', 'nothing urgent', 'no action needed', 'all clear', 'no updates', 'no changes', 'nothing pending', 'no issues'],
  attention: ['attention', 'action', 'focus', 'handling', 'addressing', 'response', 'intervention', 'work', 'effort', 'consideration'],
  reply: ['reply', 'respond', 'answer', 'say', 'output', 'return', 'state', 'indicate', 'report', 'communicate'],
  check: ['check', 'verification', 'review', 'assessment', 'inspection', 'audit', 'examination', 'evaluation', 'scan', 'analysis'],
  periodic: ['periodic', 'scheduled', 'routine', 'regular', 'timed', 'recurring', 'cyclic', 'interval', 'automatic', 'systematic'],
  status: ['status', 'state', 'condition', 'situation', 'progress', 'update', 'report', 'overview', 'summary', 'snapshot'],
  needs: ['needs', 'requires', 'demands', 'warrants', 'calls for', 'necessitates', 'involves', 'entails', 'expects', 'wants'],
  your: ['your', 'the', 'this', 'our', 'the assigned', 'the current', 'the active', 'the specified', 'the designated', 'the relevant'],
  do_not: ['do not', 'don\'t', 'avoid', 'refrain from', 'skip', 'never', 'please don\'t', 'make sure not to', 'be careful not to', 'ensure you don\'t'],
  look: ['look', 'glance', 'peek', 'take a look', 'have a look', 'browse', 'skim', 'survey', 'review', 'observe'],
};

const HEARTBEAT_TEMPLATES = [
  // Template 1: Standard check
  {
    template: '[HEARTBEAT {check}]\n\n{read} the {following} {checklist}. {follow} it {strictly}. {do_not} {infer} or {repeat} {old} {tasks} from {chats}.\nIf {nothing} {needs} {attention}, {reply} {token}.',
    vars: ['check', 'read', 'following', 'checklist', 'follow', 'strictly', 'do_not', 'infer', 'repeat', 'old', 'tasks', 'chats', 'nothing', 'needs', 'attention', 'reply'],
  },
  // Template 2: Status review
  {
    template: '[{periodic} {status} {check}]\n\nPlease {read} {your} {checklist} below. {follow} each item {strictly}.\n{do_not} {repeat} or {infer} anything from {old} {chats}.\nIf there\'s {nothing} requiring {attention}, simply {reply} {token}.',
    vars: ['periodic', 'status', 'check', 'read', 'your', 'checklist', 'follow', 'strictly', 'do_not', 'repeat', 'infer', 'old', 'chats', 'nothing', 'attention', 'reply'],
  },
  // Template 3: Quick scan
  {
    template: '[AUTOMATED {check}]\n\n{look} at the {following} {checklist} and {follow} any pending {tasks} {strictly}.\n{do_not} {infer} {tasks} or {repeat} items from {old} {chats}.\n{nothing} to do? {reply} {token}.',
    vars: ['check', 'look', 'following', 'checklist', 'follow', 'tasks', 'strictly', 'do_not', 'infer', 'repeat', 'old', 'chats', 'nothing', 'reply'],
  },
  // Template 4: Formal review
  {
    template: '[SCHEDULED {status} {check}]\n\nThis is a {periodic} {check}. {read} the {checklist} below {strictly}.\nImportant: {do_not} {infer} new {tasks} or {repeat} completed work from {old} {chats}.\nIf {nothing} {needs} {your} {attention}, {reply} with {token}.',
    vars: ['status', 'check', 'periodic', 'read', 'checklist', 'strictly', 'do_not', 'infer', 'tasks', 'repeat', 'old', 'chats', 'nothing', 'needs', 'your', 'attention', 'reply'],
  },
  // Template 5: Brief check
  {
    template: '[{check}]\n\n{read} below. {follow} {strictly}. No {old} {tasks} from {chats}.\nAll clear? {reply} {token}.',
    vars: ['check', 'read', 'follow', 'strictly', 'old', 'tasks', 'chats', 'reply'],
  },
];

/** Pick a random element from an array */
function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Generate a randomized heartbeat prompt */
function generateHeartbeatPrompt(heartbeatContent: string): string {
  const template = randomPick(HEARTBEAT_TEMPLATES);

  let prompt = template.template;

  // Replace each variable with a random synonym
  for (const varName of template.vars) {
    const synonymList = SYNONYMS[varName as keyof typeof SYNONYMS];
    if (synonymList) {
      const synonym = randomPick(synonymList);
      // Capitalize first letter if it's at start of sentence
      const regex = new RegExp(`\\{${varName}\\}`, 'g');
      prompt = prompt.replace(regex, synonym);
    }
  }

  // Replace {token} with the actual token
  prompt = prompt.replace(/\{token\}/g, HEARTBEAT_OK_TOKEN);

  // Append the actual content
  prompt += '\n\n---\n' + heartbeatContent + '\n---';

  return prompt;
}

/** Build a unique cron job name for an agent's heartbeat. */
export function heartbeatJobName(agentName?: string): string {
  return agentName ? `${HEARTBEAT_JOB_PREFIX}:${agentName}` : HEARTBEAT_JOB_PREFIX;
}

/** Check if a cron job prompt is a heartbeat trigger. */
export function isHeartbeatJob(prompt: string): boolean {
  return prompt === HEARTBEAT_JOB_PREFIX || prompt.startsWith(`${HEARTBEAT_JOB_PREFIX}:`);
}

/** Extract the agent name from a heartbeat job prompt (undefined = primary agent). */
export function heartbeatAgentName(prompt: string): string | undefined {
  if (!prompt.startsWith(`${HEARTBEAT_JOB_PREFIX}:`)) return undefined;
  return prompt.slice(HEARTBEAT_JOB_PREFIX.length + 1) || undefined;
}

/** Status of a heartbeat execution. */
export type HeartbeatStatus = 'ok-empty' | 'ok-token' | 'sent' | 'skipped' | 'failed';

/** A heartbeat log entry persisted to disk. */
export interface HeartbeatLogEntry {
  timestamp: number;
  status: HeartbeatStatus;
  sessionId: string;
  agentName?: string;        // which agent this heartbeat belongs to
  content?: string;       // actual alert content (only for 'sent' status)
  responseLength?: number;
  error?: string;         // error message (only for 'failed' status)
}

/** Broadcaster function type — sends a JSON-serializable object to all WS clients. */
export type HeartbeatBroadcaster = (msg: Record<string, unknown>) => void;

export interface HeartbeatObjectiveLogEntry {
  timestamp: number;
  status: Exclude<HeartbeatStatus, 'skipped'>;
  sessionId: string;
  agentName?: string;
  objective: string;
  responseLength?: number;
  error?: string;
}

/**
 * Check if HEARTBEAT.md content is effectively empty.
 * Returns true if it's only whitespace, markdown headers, horizontal rules,
 * or empty bullet points with no real task content.
 */
function isHeartbeatContentEffectivelyEmpty(content: string): boolean {
  const stripped = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (!line) return false;                          // blank lines
      if (/^#+\s*$/.test(line)) return false;           // empty headers (# with no text after)
      if (/^#+\s+/.test(line)) return true;             // headers with text — keep
      if (/^---+$/.test(line)) return false;            // horizontal rules
      if (/^\*\*\*+$/.test(line)) return false;         // horizontal rules
      if (/^[-*+]\s*$/.test(line)) return false;        // empty bullets
      return true;                                       // real content
    })
    .join('')
    .trim();

  return stripped.length === 0;
}

export class HeartbeatManager {
  private memoryManager: MemoryManager;
  private agent: Agent;
  private scheduler: Scheduler;
  private enabled: boolean = false;
  private broadcaster: HeartbeatBroadcaster | null = null;
  private logFile: string;
  private objectiveLogFile: string;
  private targetSession: string; // session to run heartbeats in
  private agentName: string | undefined; // per-agent name (undefined = primary)
  private jobName: string; // unique cron job name for this agent
  private tasksFile: string; // path to heartbeat-tasks.json

  constructor(
    memoryManager: MemoryManager,
    agent: Agent,
    scheduler: Scheduler,
    targetSession: string = 'webchat:heartbeat',
    agentName?: string,
  ) {
    this.memoryManager = memoryManager;
    this.agent = agent;
    this.scheduler = scheduler;
    this.targetSession = targetSession;
    this.agentName = agentName;
    this.jobName = heartbeatJobName(agentName);
    this.logFile = join(memoryManager.getDirectory(), 'heartbeat-log.json');
    this.objectiveLogFile = join(memoryManager.getDirectory(), OBJECTIVE_LOG_FILE);
    this.tasksFile = join(memoryManager.getDirectory(), HEARTBEAT_TASKS_FILE);
  }

  /** Get the agent name this heartbeat belongs to. */
  getAgentName(): string | undefined {
    return this.agentName;
  }

  /** Set the broadcaster function for live heartbeat events. */
  setBroadcaster(fn: HeartbeatBroadcaster): void {
    this.broadcaster = fn;
  }

  /** Update the target session for heartbeats (e.g. when main session changes). */
  setTargetSession(sessionId: string): void {
    this.targetSession = sessionId;
  }

  /** Get the current target session ID. */
  getTargetSession(): string {
    return this.targetSession;
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

  /** Regenerate OBJECTIVE_LOG.md from latest heartbeat objective. */
  private appendObjectiveLog(entry: HeartbeatObjectiveLogEntry): void {
    const objective = entry.objective.trim().slice(0, OBJECTIVE_MAX_CHARS);
    const lines = [
      '# Objective Log',
      '',
      '_Regenerated by heartbeat after each cycle._',
      '',
      '## Current Objective',
      objective || 'No explicit objective recorded.',
      '',
      '## Last Heartbeat Result',
      `- Timestamp: \`${new Date(entry.timestamp).toISOString()}\``,
      `- Status: \`${entry.status}\``,
      `- Session: \`${entry.sessionId}\``,
      entry.agentName ? `- Agent: \`${entry.agentName}\`` : '',
      entry.responseLength !== undefined ? `- Response Length: ${entry.responseLength}` : '',
      entry.error ? `- Error: ${entry.error}` : '',
      '',
      '## Notes',
      '- This file is intentionally overwritten each heartbeat run.',
      '- Use heartbeat_read / heartbeat_write tools for direct access.',
    ].filter(Boolean);
    try {
      writeFileSync(this.objectiveLogFile, lines.join('\n'));
    } catch (err) {
      const tag = this.agentName ? `heartbeat:${this.agentName}` : 'heartbeat';
      console.error(`[${tag}] Failed to write objective log: ${(err as Error).message}`);
    }
  }

  /** Get the latest objective entry for continuity across heartbeat cycles. */
  private getLatestObjectiveEntry(): HeartbeatObjectiveLogEntry | null {
    try {
      if (!existsSync(this.objectiveLogFile)) return null;
      const content = readFileSync(this.objectiveLogFile, 'utf-8');
      if (!content.trim()) return null;

      const objectiveMatch = content.match(/## Current Objective\s+([\s\S]*?)(?:\n## |\s*$)/);
      const objective = (objectiveMatch?.[1] || '').trim();
      if (!objective) return null;

      const statusMatch = content.match(/- Status: `([^`]+)`/);
      const rawStatus = statusMatch?.[1];
      const validStatuses: Array<Exclude<HeartbeatStatus, 'skipped'>> = ['ok-empty', 'ok-token', 'sent', 'failed'];
      const status = validStatuses.includes(rawStatus as Exclude<HeartbeatStatus, 'skipped'>)
        ? (rawStatus as Exclude<HeartbeatStatus, 'skipped'>)
        : 'sent';

      const sessionMatch = content.match(/- Session: `([^`]+)`/);
      const timestampMatch = content.match(/- Timestamp: `([^`]+)`/);
      const parsedTimestamp = timestampMatch?.[1] ? Date.parse(timestampMatch[1]) : NaN;

      return {
        timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
        status,
        sessionId: sessionMatch?.[1] || this.targetSession,
        agentName: this.agentName,
        objective,
      };
    } catch {
      return null;
    }
  }

  /** Build carry-over objective text from a heartbeat outcome. */
  private buildNextObjective(
    status: Exclude<HeartbeatStatus, 'skipped'>,
    responseText: string,
    error?: string,
  ): string {
    const trimmedResponse = responseText.trim();
    if (status === 'sent' && trimmedResponse) {
      return trimmedResponse.slice(0, OBJECTIVE_MAX_CHARS);
    }
    if (status === 'failed') {
      const reason = (error || '').trim();
      const prefix = reason ? `Previous heartbeat failed: ${reason}. ` : '';
      return `${prefix}Next heartbeat should prioritize diagnosing the failure and reporting blockers clearly.`;
    }
    if (trimmedResponse) {
      return trimmedResponse.slice(0, OBJECTIVE_MAX_CHARS);
    }
    return 'No urgent updates were detected. On the next heartbeat, re-run HEARTBEAT.md and only report new actionable items.';
  }

  /** Start the heartbeat system. Creates a cron job if one doesn't exist. */
  start(intervalMs?: number, jitterMs?: number, force?: boolean): void {
    const interval = intervalMs || DEFAULT_INTERVAL_MS;

    const existing = this.scheduler.listJobs().find(j => j.name === this.jobName);
    if (existing) {
      if (force) {
        this.scheduler.removeJob(existing.id);
      } else {
        if (!existing.enabled) {
          this.scheduler.enableJob(existing.id);
        }
        this.enabled = true;
        return;
      }
    }

    this.scheduler.addJob(
      this.jobName,
      this.jobName, // prompt = job name so we can route it back
      { type: 'interval', every: interval, jitter: jitterMs },
    );

    this.enabled = true;
  }

  /** Stop heartbeats (disable the cron job, don't delete it). */
  stop(): void {
    const job = this.scheduler.listJobs().find(j => j.name === this.jobName);
    if (job) {
      this.scheduler.disableJob(job.id);
    }
    this.enabled = false;
  }

  /** Check if heartbeat is active. */
  isActive(): boolean {
    return this.enabled;
  }

  /** Update the heartbeat interval and jitter (recreates the cron job). */
  updateInterval(intervalMs: number, jitterMs?: number): void {
    const existing = this.scheduler.listJobs().find(j => j.name === this.jobName);
    if (existing) {
      // Check if interval and jitter actually changed
      if (existing.schedule?.every === intervalMs && existing.schedule?.jitter === jitterMs) {
        return; // No change needed
      }
      this.scheduler.removeJob(existing.id);
    }

    this.scheduler.addJob(
      this.jobName,
      this.jobName,
      { type: 'interval', every: intervalMs, jitter: jitterMs },
    );
    this.enabled = true;
  }

  /** Get current interval in milliseconds (or null if no job). */
  getInterval(): number | null {
    const job = this.scheduler.listJobs().find(j => j.name === this.jobName);
    return job?.schedule?.every ?? null;
  }

  /**
   * Execute a single-turn heartbeat.
   * - Reads HEARTBEAT.md
   * - Auto-promotes pending goals if auto-process enabled
   * - Sends it to the LLM in the target session
   * - If response contains HEARTBEAT_OK → suppress (ok-token)
   * - If response is empty → ok-empty
   * - Otherwise → broadcast alert (sent)
   * - Restores session updatedAt to avoid resetting idle expiry
   */
  async trigger(): Promise<string | null> {
    const heartbeatContent = this.memoryManager.getIdentityFile('HEARTBEAT.md');
    const memoryDir = this.memoryManager.getDirectory();
    const sessionId = this.targetSession;
    const tag = this.agentName ? `heartbeat:${this.agentName}` : 'heartbeat';
    const latestObjective = this.getLatestObjectiveEntry();
    const objectivePrompt = latestObjective
      ? `\n\n## Previous Objective Log\nUse this carry-over objective from the previous heartbeat run as context:\n${latestObjective.objective}`
      : '';
    const hasActionableObjective = !!latestObjective && (latestObjective.status === 'sent' || latestObjective.status === 'failed');

    // ── Autonomy pre-hooks (run every tick regardless of heartbeat content) ──
    let autonomyNotes = '';
    try {
      // Feature 7: Escalate stale goals
      const escalated = escalateGoals(memoryDir);
      if (escalated.length > 0) {
        console.log(`[${tag}] Escalated ${escalated.length} goal(s): ${escalated.map(g => `${g.title} → ${g.priority}`).join(', ')}`);
        autonomyNotes += `\n📈 ${escalated.length} goal(s) auto-escalated in priority.`;
      }

      // Feature 1: Auto-approve suggested goals past timeout
      const approved = autoApproveSuggestedGoals(memoryDir);
      if (approved.length > 0) {
        console.log(`[${tag}] Auto-approved ${approved.length} suggested goal(s): ${approved.map(g => g.title).join(', ')}`);
        autonomyNotes += `\n✅ ${approved.length} suggested goal(s) auto-approved.`;
      }

      // Feature 5: Re-queue completed recurring goals
      const requeued = requeueRecurringGoals(memoryDir);
      if (requeued.length > 0) {
        console.log(`[${tag}] Re-queued ${requeued.length} recurring goal(s): ${requeued.map(g => g.title).join(', ')}`);
        autonomyNotes += `\n🔄 ${requeued.length} recurring goal(s) re-queued.`;
      }

      // Feature 6: Auto-retry failed goals past backoff
      const retried = autoRetryFailedGoals(memoryDir);
      if (retried.length > 0) {
        console.log(`[${tag}] Auto-retried ${retried.length} failed goal(s): ${retried.map(g => `${g.title} (attempt ${g.retryCount})`).join(', ')}`);
        autonomyNotes += `\n🔄 ${retried.length} failed goal(s) auto-retried.`;
      }

      // Feature 4: Auto-complete decomposed parents whose children are all done
      const completedParents = checkDecomposedParents(memoryDir);
      if (completedParents.length > 0) {
        console.log(`[${tag}] Auto-completed ${completedParents.length} decomposed parent goal(s)`);
        autonomyNotes += `\n✅ ${completedParents.length} parent goal(s) auto-completed (all sub-goals done).`;
      }

      // Feature 9: Daily report generation
      const report = generateDailyReport(memoryDir);
      if (report) {
        console.log(`[${tag}] Daily report generated`);
        this.broadcast({
          type: 'heartbeat_activity',
          event: 'daily_report',
          agentName: this.agentName,
          content: report.slice(0, 2000),
          timestamp: Date.now(),
        });
        autonomyNotes += '\n📊 Daily goal report generated.';
      }
    } catch (err) {
      console.error(`[${tag}] Autonomy pre-hooks error: ${(err as Error).message}`);
    }

    // Check for pending goals to auto-promote
    let goalPrompt = '';
    if (isAutoProcessEnabled(memoryDir)) {
      const pendingGoal = getAutonomousGoal(memoryDir);
      if (pendingGoal) {
        const promoted = promoteNextGoal(memoryDir);
        if (promoted) {
          goalPrompt = `\n\n## 🎯 Auto-Promoted Goal\nYou have a new goal to work on:\n- **Title**: ${promoted.title}\n- **ID**: ${promoted.id}\n- **Priority**: ${promoted.priority}\n${promoted.description ? `- **Description**: ${promoted.description}` : ''}${promoted.retryStrategy?.length ? `\n- **Previous attempts**:\n${promoted.retryStrategy.map(s => `  - ${s}`).join('\n')}` : ''}\n\n**ACTION REQUIRED**: Work on this goal now. Use tools to make progress. When done, run \`goals action=complete id="${promoted.id}"\`\n`;
          console.log(`[${tag}] Auto-promoted goal: ${promoted.title} [${promoted.id}]`);
        }
      }
    }

    // Add autonomy notes to goal prompt if any
    if (autonomyNotes) {
      goalPrompt += `\n\n## 🤖 Autonomy Activity${autonomyNotes}`;
    }

    // Skip if no HEARTBEAT.md or effectively empty AND no goals
    const heartbeatEmpty = !heartbeatContent || isHeartbeatContentEffectivelyEmpty(heartbeatContent);
    if (heartbeatEmpty && !goalPrompt && !hasActionableObjective) {
      console.log(`[${tag}] HEARTBEAT.md empty and no pending goals, skipping.`);
      this.appendLog({
        timestamp: Date.now(),
        status: 'skipped',
        sessionId: this.targetSession,
        agentName: this.agentName,
      });
      this.broadcast({
        type: 'heartbeat_activity',
        event: 'skipped',
        reason: 'empty',
        agentName: this.agentName,
        timestamp: Date.now(),
      });
      return null;
    }

    // Capture updatedAt before the heartbeat so we can restore it
    const sm = this.agent.getSessionManager();
    const sessionBefore = sm.getSession(sessionId);
    const updatedAtBefore = sessionBefore?.updatedAt;

    // Build randomized heartbeat prompt for variety and to avoid pattern detection
    // Include goal prompt if we have one
    let prompt = '';
    if (!heartbeatEmpty) {
      prompt = generateHeartbeatPrompt(heartbeatContent);
    } else if (hasActionableObjective) {
      prompt = '[AUTONOMOUS FOLLOW-UP]\n\nContinue the objective from the previous heartbeat run. Report only actionable progress or blockers.';
    } else {
      // No heartbeat content but we have a goal - create minimal prompt
      prompt = `[AUTONOMOUS CHECK]\n\nYou have tasks to work on.`;
    }
    prompt += objectivePrompt;
    prompt += goalPrompt;

    console.log(`[${tag}] Triggering in session ${sessionId}`);

    this.broadcast({
      type: 'heartbeat_activity',
      event: 'start',
      sessionId,
      agentName: this.agentName,
      timestamp: Date.now(),
    });

    try {
      // Auto-elevate heartbeat session so tools work without restrictions
      this.agent.elevateSession(sessionId);

      // Single-turn: send message and get response, streaming chunks to clients
      let streamedContent = '';
      const result = await this.agent.processMessage(sessionId, prompt, (chunk) => {
        streamedContent += chunk;
        // Stream each chunk to connected clients
        this.broadcast({
          type: 'heartbeat_stream',
          sessionId,
          agentName: this.agentName,
          chunk,
          timestamp: Date.now(),
        });
      });
      const responseText = (result.content || '').trim();

      // Restore session updatedAt so heartbeat doesn't affect idle expiry
      if (updatedAtBefore) {
        const sessionAfter = sm.getSession(sessionId);
        if (sessionAfter) {
          sessionAfter.updatedAt = updatedAtBefore;
          sm.saveSession(sessionId);
        }
      }

      // Determine status based on response
      if (!responseText || responseText.length === 0) {
        // Empty response
        console.log(`[${tag}] Empty response (ok-empty).`);
        this.appendLog({
          timestamp: Date.now(),
          status: 'ok-empty',
          sessionId,
          agentName: this.agentName,
          responseLength: 0,
        });
        this.appendObjectiveLog({
          timestamp: Date.now(),
          status: 'ok-empty',
          sessionId,
          agentName: this.agentName,
          objective: this.buildNextObjective('ok-empty', ''),
          responseLength: 0,
        });
        this.broadcast({
          type: 'heartbeat_activity',
          event: 'end',
          sessionId,
          agentName: this.agentName,
          status: 'ok-empty',
          timestamp: Date.now(),
        });
        await this.runPostHooks(memoryDir, sessionId);
        return null;
      }

      // Check for HEARTBEAT_OK token
      const hasOkToken =
        responseText.length <= ACK_MAX_CHARS &&
        (responseText.startsWith(HEARTBEAT_OK_TOKEN) || responseText.endsWith(HEARTBEAT_OK_TOKEN));

      if (hasOkToken) {
        // Strip token and suppress — nothing to report
        const stripped = responseText
          .replace(HEARTBEAT_OK_TOKEN, '')
          .trim();
        console.log(`[${tag}] OK (token ack).${stripped ? ` Note: ${stripped}` : ''}`);
        this.appendLog({
          timestamp: Date.now(),
          status: 'ok-token',
          sessionId,
          agentName: this.agentName,
          responseLength: responseText.length,
        });
        this.appendObjectiveLog({
          timestamp: Date.now(),
          status: 'ok-token',
          sessionId,
          agentName: this.agentName,
          objective: this.buildNextObjective('ok-token', stripped),
          responseLength: responseText.length,
        });
        this.broadcast({
          type: 'heartbeat_activity',
          event: 'end',
          sessionId,
          agentName: this.agentName,
          status: 'ok-token',
          timestamp: Date.now(),
        });
        await this.runPostHooks(memoryDir, sessionId);
        // Notify chat if autonomy pre-hooks did something even though heartbeat acked OK
        if (autonomyNotes) {
          notifyChatSession(
            `Heartbeat${this.agentName ? ` (${this.agentName})` : ''} — nothing urgent, but:${autonomyNotes}`,
            'heartbeat'
          );
        }
        return null;
      }

      // Actual alert content — broadcast to clients
      console.log(`[${tag}] Alert: ${responseText.slice(0, 200)}`);
      this.appendLog({
        timestamp: Date.now(),
        status: 'sent',
        sessionId,
        agentName: this.agentName,
        content: responseText,
        responseLength: responseText.length,
      });
      this.appendObjectiveLog({
        timestamp: Date.now(),
        status: 'sent',
        sessionId,
        agentName: this.agentName,
        objective: this.buildNextObjective('sent', responseText),
        responseLength: responseText.length,
      });
      this.broadcast({
        type: 'heartbeat_activity',
        event: 'end',
        sessionId,
        agentName: this.agentName,
        status: 'sent',
        content: responseText.slice(0, 2000),
        timestamp: Date.now(),
      });

      // ── Post-response autonomy hooks ──
      await this.runPostHooks(memoryDir, sessionId);

      // Notify chat only about autonomy activity (goal completions, escalations, etc.)
      if (autonomyNotes) {
        notifyChatSession(
          `Heartbeat${this.agentName ? ` (${this.agentName})` : ''}:${autonomyNotes}`,
          'heartbeat'
        );
      }

      return responseText;
    } catch (err) {
      console.error(`[${tag}] Trigger failed: ${(err as Error).message}`);
      this.appendLog({
        timestamp: Date.now(),
        status: 'failed',
        sessionId,
        agentName: this.agentName,
        error: (err as Error).message,
      });
      this.appendObjectiveLog({
        timestamp: Date.now(),
        status: 'failed',
        sessionId,
        agentName: this.agentName,
        objective: this.buildNextObjective('failed', '', (err as Error).message),
        error: (err as Error).message,
      });
      this.broadcast({
        type: 'heartbeat_activity',
        event: 'end',
        sessionId,
        agentName: this.agentName,
        status: 'failed',
        error: (err as Error).message,
        timestamp: Date.now(),
      });
      return null;
    }
  }

  // ── Post-response autonomy hooks ──────────────────────────────────────

  /** Run autonomy hooks after each heartbeat tick */
  private async runPostHooks(memoryDir: string, sessionId: string): Promise<void> {
    const tag = this.agentName ? `heartbeat:${this.agentName}` : 'heartbeat';
    try {
      // Feature 2: Goal chaining — check for newly unblocked goals
      const unblocked = getUnblockedDependents(memoryDir);
      if (unblocked.length > 0) {
        const maxChains = 3; // Could be from settings in the future
        const toPromote = unblocked.slice(0, maxChains);
        for (const goal of toPromote) {
          const promoted = promoteNextGoal(memoryDir);
          if (promoted) {
            console.log(`[${tag}] Chain-promoted unblocked goal: ${promoted.title} [${promoted.id}]`);
            // Send a follow-up prompt for the chained goal
            const chainPrompt = `[GOAL CHAIN] A dependency was completed, unblocking a new goal:\n- **Title**: ${promoted.title}\n- **ID**: ${promoted.id}\n- **Priority**: ${promoted.priority}\n${promoted.description ? `- **Description**: ${promoted.description}` : ''}\n\nWork on this goal now. When done, run \`goals action=complete id="${promoted.id}"\``;
            try {
              await this.agent.processMessage(sessionId, chainPrompt);
            } catch (chainErr) {
              console.error(`[${tag}] Chain processing failed: ${(chainErr as Error).message}`);
            }
          }
        }
      }

      // Feature 3: Adaptive interval adjustment
      const newInterval = getAdaptiveInterval(memoryDir);
      if (newInterval !== null) {
        const currentInterval = this.getInterval();
        if (currentInterval && Math.abs(currentInterval - newInterval) > 10000) { // >10s difference
          console.log(`[${tag}] Adaptive interval: ${currentInterval}ms → ${newInterval}ms`);
          this.updateInterval(newInterval);
          this.broadcast({
            type: 'heartbeat_activity',
            event: 'interval_changed',
            agentName: this.agentName,
            oldInterval: currentInterval,
            newInterval,
            timestamp: Date.now(),
          });
        }
      }
    } catch (err) {
      console.error(`[${tag}] Post-hooks error: ${(err as Error).message}`);
    }
  }

  // ── Feature 10: Multiple Named Heartbeat Tasks ────────────────────────

  /** Load heartbeat tasks from disk */
  private loadTasks(): HeartbeatTask[] {
    try {
      if (existsSync(this.tasksFile)) {
        return JSON.parse(readFileSync(this.tasksFile, 'utf-8'));
      }
    } catch {}
    return [];
  }

  /** Save heartbeat tasks to disk */
  private saveTasks(tasks: HeartbeatTask[]): void {
    writeFileSync(this.tasksFile, JSON.stringify(tasks, null, 2));
  }

  /** Add a named heartbeat task with its own schedule */
  addTask(task: Omit<HeartbeatTask, 'id' | 'createdAt'>): HeartbeatTask {
    const tasks = this.loadTasks();
    const newTask: HeartbeatTask = {
      ...task,
      id: `hbtask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
    };
    tasks.push(newTask);
    this.saveTasks(tasks);

    // Register cron job for this task
    if (newTask.enabled) {
      const jobName = `${HEARTBEAT_TASK_PREFIX}:${newTask.id}`;
      this.scheduler.addJob(jobName, jobName, {
        type: 'interval',
        every: newTask.intervalMs,
        jitter: newTask.jitterMs,
      });
    }

    return newTask;
  }

  /** List all heartbeat tasks */
  listTasks(): HeartbeatTask[] {
    return this.loadTasks();
  }

  /** Get a specific task by ID */
  getTask(taskId: string): HeartbeatTask | undefined {
    return this.loadTasks().find(t => t.id === taskId);
  }

  /** Update a heartbeat task (interval, prompt, enabled, etc.) */
  updateTask(taskId: string, updates: Partial<Pick<HeartbeatTask, 'name' | 'prompt' | 'intervalMs' | 'jitterMs' | 'enabled' | 'sessionId' | 'integrateGoals'>>): HeartbeatTask | null {
    const tasks = this.loadTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) return null;

    Object.assign(task, updates);
    this.saveTasks(tasks);

    // Update cron job
    const jobName = `${HEARTBEAT_TASK_PREFIX}:${taskId}`;
    const existing = this.scheduler.listJobs().find(j => j.name === jobName);
    if (existing) this.scheduler.removeJob(existing.id);

    if (task.enabled) {
      this.scheduler.addJob(jobName, jobName, {
        type: 'interval',
        every: task.intervalMs,
        jitter: task.jitterMs,
      });
    }

    return task;
  }

  /** Remove a heartbeat task */
  removeTask(taskId: string): boolean {
    const tasks = this.loadTasks();
    const idx = tasks.findIndex(t => t.id === taskId);
    if (idx === -1) return false;

    tasks.splice(idx, 1);
    this.saveTasks(tasks);

    // Remove cron job
    const jobName = `${HEARTBEAT_TASK_PREFIX}:${taskId}`;
    const existing = this.scheduler.listJobs().find(j => j.name === jobName);
    if (existing) this.scheduler.removeJob(existing.id);

    return true;
  }

  /** Execute a specific heartbeat task */
  async triggerTask(taskId: string): Promise<string | null> {
    const task = this.getTask(taskId);
    if (!task) return null;

    const tag = this.agentName ? `heartbeat:${this.agentName}` : 'heartbeat';
    const sessionId = task.sessionId || this.targetSession;
    console.log(`[${tag}] Triggering task "${task.name}" in session ${sessionId}`);

    this.broadcast({
      type: 'heartbeat_activity',
      event: 'task_start',
      taskId: task.id,
      taskName: task.name,
      sessionId,
      agentName: this.agentName,
      timestamp: Date.now(),
    });

    try {
      this.agent.elevateSession(sessionId);

      // Build prompt — use task's custom prompt, check if it's a file reference
      let prompt = task.prompt;
      if (prompt.endsWith('.md') && existsSync(join(this.memoryManager.getDirectory(), prompt))) {
        prompt = readFileSync(join(this.memoryManager.getDirectory(), prompt), 'utf-8');
      }

      // Optionally integrate goals
      if (task.integrateGoals) {
        const memoryDir = this.memoryManager.getDirectory();
        const goalSummary = getGoalsSummary(memoryDir);
        if (goalSummary) prompt += `\n\n${goalSummary}`;
      }

      const result = await this.agent.processMessage(sessionId, prompt);
      const responseText = (result.content || '').trim();

      // Update lastRunAt
      const tasks = this.loadTasks();
      const t = tasks.find(x => x.id === taskId);
      if (t) {
        t.lastRunAt = Date.now();
        this.saveTasks(tasks);
      }

      this.broadcast({
        type: 'heartbeat_activity',
        event: 'task_end',
        taskId: task.id,
        taskName: task.name,
        sessionId,
        agentName: this.agentName,
        status: responseText ? 'sent' : 'ok-empty',
        content: responseText?.slice(0, 2000),
        timestamp: Date.now(),
      });

      return responseText || null;
    } catch (err) {
      console.error(`[${tag}] Task "${task.name}" failed: ${(err as Error).message}`);
      this.broadcast({
        type: 'heartbeat_activity',
        event: 'task_end',
        taskId: task.id,
        taskName: task.name,
        sessionId,
        agentName: this.agentName,
        status: 'failed',
        error: (err as Error).message,
        timestamp: Date.now(),
      });
      return null;
    }
  }

  /** Start all registered heartbeat tasks as cron jobs */
  startTasks(): void {
    const tasks = this.loadTasks();
    for (const task of tasks) {
      if (!task.enabled) continue;
      const jobName = `${HEARTBEAT_TASK_PREFIX}:${task.id}`;
      const existing = this.scheduler.listJobs().find(j => j.name === jobName);
      if (!existing) {
        this.scheduler.addJob(jobName, jobName, {
          type: 'interval',
          every: task.intervalMs,
          jitter: task.jitterMs,
        });
      }
    }
  }
}

/** Check if a cron job prompt is a heartbeat task trigger */
export function isHeartbeatTask(prompt: string): boolean {
  return prompt.startsWith(`${HEARTBEAT_TASK_PREFIX}:`);
}

/** Extract the task ID from a heartbeat task job prompt */
export function heartbeatTaskId(prompt: string): string | undefined {
  if (!prompt.startsWith(`${HEARTBEAT_TASK_PREFIX}:`)) return undefined;
  return prompt.slice(HEARTBEAT_TASK_PREFIX.length + 1) || undefined;
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
  agentName?: string,
  intervalMs?: number,
  jitterMs?: number,
): HeartbeatManager {
  const sessionTarget = agentName
    ? `webchat:heartbeat:${agentName}`
    : 'webchat:heartbeat';
  const hb = new HeartbeatManager(memoryManager, agent, scheduler, sessionTarget, agentName);

  if (autoStart) {
    hb.start(intervalMs, jitterMs);
  } else {
    // Check if job was already enabled from a previous run
    const jobName = heartbeatJobName(agentName);
    const existing = scheduler.listJobs().find(j => j.name === jobName);
    if (existing?.enabled) {
      hb.start(intervalMs, jitterMs);
    }
  }

  // Start any registered heartbeat tasks
  hb.startTasks();

  return hb;
}
