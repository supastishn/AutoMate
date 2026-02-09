/**
 * Heartbeat System — proactive agent wakeups driven by cron.
 * Reads HEARTBEAT.md for the agent's checklist, then triggers
 * a proactive message with those instructions.
 */

import type { MemoryManager } from '../memory/manager.js';
import type { Agent } from '../agent/agent.js';
import type { Scheduler, CronJob } from '../cron/scheduler.js';

const HEARTBEAT_JOB_NAME = '__heartbeat__';
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export class HeartbeatManager {
  private memoryManager: MemoryManager;
  private agent: Agent;
  private scheduler: Scheduler;
  private enabled: boolean = false;

  constructor(memoryManager: MemoryManager, agent: Agent, scheduler: Scheduler) {
    this.memoryManager = memoryManager;
    this.agent = agent;
    this.scheduler = scheduler;
  }

  /** Start the heartbeat system. Creates a cron job if one doesn't exist. */
  start(intervalMs?: number): void {
    const interval = intervalMs || DEFAULT_INTERVAL_MS;

    // Check if heartbeat job already exists
    const existing = this.scheduler.listJobs().find(j => j.name === HEARTBEAT_JOB_NAME);
    if (existing) {
      if (!existing.enabled) {
        this.scheduler.enableJob(existing.id);
      }
      this.enabled = true;
      return;
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
   */
  async trigger(): Promise<string | null> {
    const heartbeatContent = this.memoryManager.getIdentityFile('HEARTBEAT.md');
    if (!heartbeatContent || heartbeatContent.trim().length === 0) {
      return null; // no heartbeat instructions, skip
    }

    const sessionId = `heartbeat:${Date.now()}`;

    // Build the heartbeat prompt
    const prompt = [
      '[HEARTBEAT — Proactive Check-in]',
      '',
      'This is an automatic heartbeat trigger. Review your HEARTBEAT.md checklist below and take any actions that are due.',
      'If nothing needs attention, just log that you checked and found nothing actionable.',
      '',
      '---',
      heartbeatContent,
      '---',
      '',
      'Check each item. For any that need action, do them now. Log what you did or found to your daily log.',
    ].join('\n');

    try {
      const result = await this.agent.processMessage(sessionId, prompt);
      return result.content;
    } catch (err) {
      console.error(`[heartbeat] Trigger failed: ${(err as Error).message}`);
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
