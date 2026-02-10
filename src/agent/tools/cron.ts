import type { Tool } from '../tool-registry.js';
import type { Scheduler } from '../../cron/scheduler.js';

let schedulerRef: Scheduler | null = null;

export function setScheduler(s: Scheduler): void {
  schedulerRef = s;
}

export const cronTools: Tool[] = [
  {
    name: 'cron',
    description: [
      'Manage scheduled jobs.',
      'Actions: create, list, delete, toggle.',
      'create — create a job that runs a prompt at a given time/interval/cron schedule.',
      'list — list all scheduled jobs.',
      'delete — delete a job by ID.',
      'toggle — enable or disable a job.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: create|list|delete|toggle',
        },
        name: { type: 'string', description: 'Short name for the job (for create)' },
        prompt: { type: 'string', description: 'Prompt/instruction to execute when job fires (for create)' },
        type: { type: 'string', enum: ['once', 'interval', 'cron'], description: 'Schedule type (for create)' },
        at: { type: 'string', description: 'ISO date string for one-time jobs (for create, type=once)' },
        every_minutes: { type: 'number', description: 'Interval in minutes (for create, type=interval)' },
        cron_expression: { type: 'string', description: '5-field cron expression (for create, type=cron)' },
        session_id: { type: 'string', description: 'Optional session ID to run the prompt in' },
        id: { type: 'string', description: 'Job ID (for delete, toggle)' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable (for toggle)' },
      },
      required: ['action'],
    },
    async execute(params) {
      if (!schedulerRef) return { output: '', error: 'Scheduler not available' };
      const action = params.action as string;

      switch (action) {
        case 'create': {
          const name = params.name as string;
          const prompt = params.prompt as string;
          const type = params.type as 'once' | 'interval' | 'cron';
          const sessionId = params.session_id as string | undefined;

          if (!name || !prompt || !type) return { output: '', error: 'name, prompt, and type are required for create' };

          const schedule: { type: 'once' | 'interval' | 'cron'; at?: string; every?: number; cron?: string } = { type };

          if (type === 'once') {
            if (!params.at) return { output: '', error: '"at" is required for type=once' };
            schedule.at = params.at as string;
          } else if (type === 'interval') {
            if (!params.every_minutes) return { output: '', error: '"every_minutes" is required for type=interval' };
            schedule.every = (params.every_minutes as number) * 60_000;
          } else if (type === 'cron') {
            if (!params.cron_expression) return { output: '', error: '"cron_expression" is required for type=cron' };
            schedule.cron = params.cron_expression as string;
          }

          const job = schedulerRef.addJob(name, prompt, schedule, sessionId);
          return {
            output: `Created job "${job.name}" (${job.id})\n  type: ${job.schedule.type}\n  next run: ${job.nextRun ?? 'N/A'}\n  enabled: ${job.enabled}`,
          };
        }

        case 'list': {
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
        }

        case 'delete': {
          const id = params.id as string;
          if (!id) return { output: '', error: 'id is required for delete' };
          const removed = schedulerRef.removeJob(id);
          if (!removed) return { output: '', error: `Job not found: ${id}` };
          return { output: `Deleted job ${id}` };
        }

        case 'toggle': {
          const id = params.id as string;
          const enabled = params.enabled as boolean;
          if (!id || enabled === undefined) return { output: '', error: 'id and enabled are required for toggle' };
          const ok = enabled ? schedulerRef.enableJob(id) : schedulerRef.disableJob(id);
          if (!ok) return { output: '', error: `Job not found: ${id}` };
          return { output: `Job ${id} ${enabled ? 'enabled' : 'disabled'}` };
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: create, list, delete, toggle` };
      }
    },
  },
];
