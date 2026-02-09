import type { Tool } from '../tool-registry.js';
import type { Scheduler } from '../../cron/scheduler.js';

let schedulerRef: Scheduler | null = null;

export function setScheduler(s: Scheduler): void {
  schedulerRef = s;
}

export const cronCreateTool: Tool = {
  name: 'cron_create',
  description:
    'Create a scheduled job that runs a prompt at a given time, interval, or cron schedule.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short name for the job' },
      prompt: {
        type: 'string',
        description: 'The prompt / instruction the agent should execute when the job fires',
      },
      type: {
        type: 'string',
        enum: ['once', 'interval', 'cron'],
        description: 'Schedule type',
      },
      at: {
        type: 'string',
        description: 'ISO date string for one-time jobs (used when type=once)',
      },
      every_minutes: {
        type: 'number',
        description: 'Interval in minutes between runs (used when type=interval)',
      },
      cron_expression: {
        type: 'string',
        description:
          '5-field cron expression: min hour dom month dow (used when type=cron). Example: "*/30 * * * *" = every 30 min',
      },
      session_id: {
        type: 'string',
        description: 'Optional session ID to run the prompt in',
      },
    },
    required: ['name', 'prompt', 'type'],
  },
  async execute(params) {
    if (!schedulerRef) return { output: '', error: 'Scheduler not available' };

    const name = params.name as string;
    const prompt = params.prompt as string;
    const type = params.type as 'once' | 'interval' | 'cron';
    const sessionId = params.session_id as string | undefined;

    const schedule: { type: 'once' | 'interval' | 'cron'; at?: string; every?: number; cron?: string } = { type };

    if (type === 'once') {
      if (!params.at) return { output: '', error: 'Parameter "at" is required for type=once' };
      schedule.at = params.at as string;
    } else if (type === 'interval') {
      if (!params.every_minutes)
        return { output: '', error: 'Parameter "every_minutes" is required for type=interval' };
      schedule.every = (params.every_minutes as number) * 60_000;
    } else if (type === 'cron') {
      if (!params.cron_expression)
        return { output: '', error: 'Parameter "cron_expression" is required for type=cron' };
      schedule.cron = params.cron_expression as string;
    }

    const job = schedulerRef.addJob(name, prompt, schedule, sessionId);
    return {
      output:
        `Created job "${job.name}" (${job.id})\n` +
        `  type: ${job.schedule.type}\n` +
        `  next run: ${job.nextRun ?? 'N/A'}\n` +
        `  enabled: ${job.enabled}`,
    };
  },
};

export const cronListTool: Tool = {
  name: 'cron_list',
  description: 'List all scheduled cron jobs.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    if (!schedulerRef) return { output: '', error: 'Scheduler not available' };

    const jobs = schedulerRef.listJobs();
    if (jobs.length === 0) return { output: 'No scheduled jobs.' };

    const header = 'ID         | Enabled | Runs | Type     | Name                 | Next Run';
    const sep = '-'.repeat(header.length);
    const rows = jobs.map(j => {
      const id = j.id.padEnd(10);
      const en = (j.enabled ? 'yes' : 'no').padEnd(7);
      const runs = String(j.runCount).padEnd(4);
      const type = j.schedule.type.padEnd(8);
      const name = j.name.slice(0, 20).padEnd(20);
      const next = j.nextRun ? new Date(j.nextRun).toLocaleString() : 'N/A';
      return `${id} | ${en} | ${runs} | ${type} | ${name} | ${next}`;
    });

    return { output: [header, sep, ...rows].join('\n') };
  },
};

export const cronDeleteTool: Tool = {
  name: 'cron_delete',
  description: 'Delete a scheduled job by ID.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Job ID to delete' },
    },
    required: ['id'],
  },
  async execute(params) {
    if (!schedulerRef) return { output: '', error: 'Scheduler not available' };

    const id = params.id as string;
    const removed = schedulerRef.removeJob(id);
    if (!removed) return { output: '', error: `Job not found: ${id}` };
    return { output: `Deleted job ${id}` };
  },
};

export const cronToggleTool: Tool = {
  name: 'cron_toggle',
  description: 'Enable or disable a scheduled job.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Job ID to toggle' },
      enabled: { type: 'boolean', description: 'true to enable, false to disable' },
    },
    required: ['id', 'enabled'],
  },
  async execute(params) {
    if (!schedulerRef) return { output: '', error: 'Scheduler not available' };

    const id = params.id as string;
    const enabled = params.enabled as boolean;

    const ok = enabled ? schedulerRef.enableJob(id) : schedulerRef.disableJob(id);
    if (!ok) return { output: '', error: `Job not found: ${id}` };
    return { output: `Job ${id} ${enabled ? 'enabled' : 'disabled'}` };
  },
};

export const cronTools = [cronCreateTool, cronListTool, cronDeleteTool, cronToggleTool];
