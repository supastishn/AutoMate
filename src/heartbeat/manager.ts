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

const HEARTBEAT_JOB_PREFIX = '__heartbeat__';
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const HEARTBEAT_OK_TOKEN = 'HEARTBEAT_OK';
const ACK_MAX_CHARS = 200; // responses under this length containing HEARTBEAT_OK are treated as acks

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
  private targetSession: string; // session to run heartbeats in
  private agentName: string | undefined; // per-agent name (undefined = primary)
  private jobName: string; // unique cron job name for this agent

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

  /** Start the heartbeat system. Creates a cron job if one doesn't exist. */
  start(intervalMs?: number, force?: boolean): void {
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
      { type: 'interval', every: interval },
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

  /**
   * Execute a single-turn heartbeat.
   * - Reads HEARTBEAT.md
   * - Sends it to the LLM in the target session
   * - If response contains HEARTBEAT_OK → suppress (ok-token)
   * - If response is empty → ok-empty
   * - Otherwise → broadcast alert (sent)
   * - Restores session updatedAt to avoid resetting idle expiry
   */
  async trigger(): Promise<string | null> {
    const heartbeatContent = this.memoryManager.getIdentityFile('HEARTBEAT.md');

    // Skip if no HEARTBEAT.md or effectively empty
    if (!heartbeatContent || isHeartbeatContentEffectivelyEmpty(heartbeatContent)) {
      const tag = this.agentName ? `heartbeat:${this.agentName}` : 'heartbeat';
      console.log(`[${tag}] HEARTBEAT.md empty or effectively empty, skipping.`);
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

    const sessionId = this.targetSession;

    // Capture updatedAt before the heartbeat so we can restore it
    const sm = this.agent.getSessionManager();
    const sessionBefore = sm.getSession(sessionId);
    const updatedAtBefore = sessionBefore?.updatedAt;

    // Build heartbeat prompt — openclaw-style: follow strictly, don't hallucinate
    const prompt = [
      '[HEARTBEAT CHECK]',
      '',
      'Read the following checklist. Follow it strictly. Do not infer or repeat old tasks from prior chats.',
      `If nothing needs attention, reply ${HEARTBEAT_OK_TOKEN}.`,
      '',
      '---',
      heartbeatContent,
      '---',
    ].join('\n');

    const tag = this.agentName ? `heartbeat:${this.agentName}` : 'heartbeat';
    console.log(`[${tag}] Triggering in session ${sessionId}`);

    this.broadcast({
      type: 'heartbeat_activity',
      event: 'start',
      sessionId,
      agentName: this.agentName,
      timestamp: Date.now(),
    });

    try {
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
        this.broadcast({
          type: 'heartbeat_activity',
          event: 'end',
          sessionId,
          agentName: this.agentName,
          status: 'ok-empty',
          timestamp: Date.now(),
        });
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
        this.broadcast({
          type: 'heartbeat_activity',
          event: 'end',
          sessionId,
          agentName: this.agentName,
          status: 'ok-token',
          timestamp: Date.now(),
        });
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
      this.broadcast({
        type: 'heartbeat_activity',
        event: 'end',
        sessionId,
        agentName: this.agentName,
        status: 'sent',
        content: responseText.slice(0, 2000),
        timestamp: Date.now(),
      });
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
): HeartbeatManager {
  const sessionTarget = agentName
    ? `webchat:heartbeat:${agentName}`
    : 'webchat:heartbeat';
  const hb = new HeartbeatManager(memoryManager, agent, scheduler, sessionTarget, agentName);

  if (autoStart) {
    hb.start(intervalMs);
  } else {
    // Check if job was already enabled from a previous run
    const jobName = heartbeatJobName(agentName);
    const existing = scheduler.listJobs().find(j => j.name === jobName);
    if (existing?.enabled) {
      hb.start(intervalMs);
    }
  }

  return hb;
}
