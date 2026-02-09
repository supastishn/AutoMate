import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';

export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  schedule: {
    type: 'once' | 'interval' | 'cron';
    at?: string;
    every?: number;
    cron?: string;
  };
  sessionId?: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  createdAt: string;
  runCount: number;
}

/** Expand a single cron field into a set of valid numbers. */
function expandCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();

  for (const part of field.split(',')) {
    const trimmed = part.trim();

    if (trimmed === '*') {
      for (let i = min; i <= max; i++) result.add(i);
    } else if (trimmed.includes('/')) {
      // step: */n or a-b/n
      const [range, stepStr] = trimmed.split('/');
      const step = parseInt(stepStr, 10);
      let start = min;
      let end = max;
      if (range !== '*') {
        if (range.includes('-')) {
          const [a, b] = range.split('-').map(Number);
          start = a;
          end = b;
        } else {
          start = parseInt(range, 10);
        }
      }
      for (let i = start; i <= end; i += step) result.add(i);
    } else if (trimmed.includes('-')) {
      const [a, b] = trimmed.split('-').map(Number);
      for (let i = a; i <= b; i++) result.add(i);
    } else {
      result.add(parseInt(trimmed, 10));
    }
  }

  return result;
}

/** Find the next Date from `from` that matches a 5-field cron expression. */
function nextCronMatch(expression: string, from: Date): Date {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron expression (need 5 fields): ${expression}`);

  const minutes = expandCronField(fields[0], 0, 59);
  const hours = expandCronField(fields[1], 0, 23);
  const doms = expandCronField(fields[2], 1, 31);
  const months = expandCronField(fields[3], 1, 12);
  const dows = expandCronField(fields[4], 0, 6); // 0=Sunday

  // Start searching from 1 minute after `from`
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  // Search up to ~2 years (safety limit)
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    const mo = cursor.getMonth() + 1; // 1-12
    const dom = cursor.getDate();
    const dow = cursor.getDay(); // 0=Sunday
    const hr = cursor.getHours();
    const mn = cursor.getMinutes();

    if (months.has(mo) && doms.has(dom) && dows.has(dow) && hours.has(hr) && minutes.has(mn)) {
      return cursor;
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  // Fallback: 24h from now
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

export class Scheduler {
  private jobs: CronJob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private filePath: string;
  private onTrigger: (job: CronJob) => void;

  constructor(cronDir: string, onTrigger: (job: CronJob) => void) {
    this.onTrigger = onTrigger;

    if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true });
    this.filePath = join(cronDir, 'jobs.json');

    if (existsSync(this.filePath)) {
      try {
        this.jobs = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      } catch {
        this.jobs = [];
      }
    }

    this.start();
  }

  addJob(
    name: string,
    prompt: string,
    schedule: CronJob['schedule'],
    sessionId?: string,
  ): CronJob {
    const now = new Date();
    const job: CronJob = {
      id: nanoid(10),
      name,
      prompt,
      schedule,
      sessionId,
      enabled: true,
      createdAt: now.toISOString(),
      runCount: 0,
    };
    job.nextRun = this.calculateNextRun(job, now);
    this.jobs.push(job);
    this.save();
    return job;
  }

  removeJob(id: string): boolean {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter(j => j.id !== id);
    if (this.jobs.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  enableJob(id: string): boolean {
    const job = this.jobs.find(j => j.id === id);
    if (!job) return false;
    job.enabled = true;
    job.nextRun = this.calculateNextRun(job, new Date());
    this.save();
    return true;
  }

  disableJob(id: string): boolean {
    const job = this.jobs.find(j => j.id === id);
    if (!job) return false;
    job.enabled = false;
    this.save();
    return true;
  }

  listJobs(): CronJob[] {
    return this.jobs;
  }

  getJob(id: string): CronJob | undefined {
    return this.jobs.find(j => j.id === id);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 15_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const now = new Date();

    for (const job of this.jobs) {
      if (!job.enabled) continue;
      if (!job.nextRun) continue;

      const nextRun = new Date(job.nextRun);
      if (now >= nextRun) {
        // Fire
        job.lastRun = now.toISOString();
        job.runCount++;

        // For 'once' jobs, disable after firing
        if (job.schedule.type === 'once') {
          job.enabled = false;
          job.nextRun = undefined;
        } else {
          job.nextRun = this.calculateNextRun(job, now);
        }

        this.save();

        try {
          this.onTrigger(job);
        } catch {
          // trigger errors are non-fatal
        }
      }
    }
  }

  private calculateNextRun(job: CronJob, now?: Date): string | undefined {
    const ref = now ?? new Date();

    switch (job.schedule.type) {
      case 'once': {
        if (!job.schedule.at) return undefined;
        return job.schedule.at;
      }
      case 'interval': {
        if (!job.schedule.every || job.schedule.every <= 0) return undefined;
        const base = job.lastRun ? new Date(job.lastRun) : ref;
        return new Date(base.getTime() + job.schedule.every).toISOString();
      }
      case 'cron': {
        if (!job.schedule.cron) return undefined;
        try {
          return nextCronMatch(job.schedule.cron, ref).toISOString();
        } catch {
          return undefined;
        }
      }
      default:
        return undefined;
    }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.jobs, null, 2));
  }
}
