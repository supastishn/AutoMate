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
      'Manage scheduled jobs. Actions: create|list|get|edit|delete|toggle.',
      'Schedule types: once (at ISO date), interval (every_minutes), cron (5-field expression).',
      'Jobs execute autonomously via the heartbeat system. Use jitter_minutes to spread load.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: create|list|edit|get|delete|toggle',
        },
        name: { type: 'string', description: 'Short name for the job (for create, edit)' },
        prompt: { type: 'string', description: 'Prompt/instruction to execute when job fires (for create, edit)' },
        type: { type: 'string', enum: ['once', 'interval', 'cron'], description: 'Schedule type (for create, edit)' },
        at: { type: 'string', description: 'ISO date string for one-time jobs (for create/edit, type=once)' },
        every_minutes: { type: 'number', description: 'Interval in minutes (for create/edit, type=interval)' },
        cron_expression: { type: 'string', description: '5-field cron expression (for create/edit, type=cron)' },
        session_id: { type: 'string', description: 'Optional session ID to run the prompt in' },
        jitter_minutes: { type: 'number', description: 'Random jitter in minutes (+/-) to vary execution time (for create/edit, type=interval|cron)' },
        id: { type: 'string', description: 'Job ID (for edit, get, delete, toggle)' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable (for toggle, edit)' },
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

          const schedule: { type: 'once' | 'interval' | 'cron'; at?: string; every?: number; cron?: string; jitter?: number } = { type };

          // Add jitter if specified (convert minutes to ms)
          if (params.jitter_minutes && typeof params.jitter_minutes === 'number' && params.jitter_minutes > 0) {
            schedule.jitter = (params.jitter_minutes as number) * 60_000;
          }

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
          const jitterInfo = schedule.jitter ? `\n  jitter: ±${params.jitter_minutes}m` : '';
          return {
            output: `Created job "${job.name}" (${job.id})\n  type: ${job.schedule.type}${jitterInfo}\n  next run: ${job.nextRun ?? 'N/A'}\n  enabled: ${job.enabled}`,
          };
        }

        case 'list': {
          const jobs = schedulerRef.listJobs();
          if (jobs.length === 0) return { output: 'No scheduled jobs.' };

          const header = 'ID         | Enabled | Runs | Type     | Jitter | Name                 | Next Run';
          const sep = '-'.repeat(header.length);
          const rows = jobs.map(j => {
            const id = j.id.padEnd(10);
            const en = (j.enabled ? 'yes' : 'no').padEnd(7);
            const runs = String(j.runCount).padEnd(4);
            const type = j.schedule.type.padEnd(8);
            const jitter = j.schedule.jitter ? `±${Math.round(j.schedule.jitter / 60000)}m`.padEnd(6) : '-'.padEnd(6);
            const name = j.name.slice(0, 20).padEnd(20);
            const next = j.nextRun ? new Date(j.nextRun).toLocaleString() : 'N/A';
            return `${id} | ${en} | ${runs} | ${type} | ${jitter} | ${name} | ${next}`;
          });

          return { output: [header, sep, ...rows].join('\n') };
        }

        case 'get': {
          const id = params.id as string;
          if (!id) return { output: '', error: 'id is required for get' };
          const job = schedulerRef.getJob(id);
          if (!job) return { output: '', error: `Job not found: ${id}` };
          
          const lines = [
            `Job: ${job.name} (${job.id})`,
            `  enabled: ${job.enabled}`,
            `  type: ${job.schedule.type}`,
          ];
          
          if (job.schedule.type === 'once' && job.schedule.at) {
            lines.push(`  at: ${job.schedule.at}`);
          } else if (job.schedule.type === 'interval' && job.schedule.every) {
            lines.push(`  every: ${Math.round(job.schedule.every / 60000)} minutes`);
          } else if (job.schedule.type === 'cron' && job.schedule.cron) {
            lines.push(`  cron: ${job.schedule.cron}`);
          }
          
          if (job.schedule.jitter) {
            lines.push(`  jitter: ±${Math.round(job.schedule.jitter / 60000)} minutes`);
          }
          if (job.sessionId) {
            lines.push(`  session: ${job.sessionId}`);
          }
          lines.push(`  next run: ${job.nextRun ?? 'N/A'}`);
          lines.push(`  last run: ${job.lastRun ?? 'never'}`);
          lines.push(`  run count: ${job.runCount}`);
          lines.push(`  prompt: ${job.prompt.slice(0, 200)}${job.prompt.length > 200 ? '...' : ''}`);
          
          return { output: lines.join('\n') };
        }

        case 'edit': {
          const id = params.id as string;
          if (!id) return { output: '', error: 'id is required for edit' };
          
          const updates: Record<string, unknown> = {};
          
          if (params.name !== undefined) updates.name = params.name;
          if (params.prompt !== undefined) updates.prompt = params.prompt;
          if (params.enabled !== undefined) updates.enabled = params.enabled;
          if (params.session_id !== undefined) updates.sessionId = params.session_id;
          
          // Handle schedule updates
          if (params.type !== undefined) {
            const type = params.type as 'once' | 'interval' | 'cron';
            const schedule: { type: 'once' | 'interval' | 'cron'; at?: string; every?: number; cron?: string; jitter?: number } = { type };
            
            // Add jitter if specified
            if (params.jitter_minutes && typeof params.jitter_minutes === 'number' && params.jitter_minutes > 0) {
              schedule.jitter = (params.jitter_minutes as number) * 60_000;
            }
            
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
            
            updates.schedule = schedule;
          } else if (params.jitter_minutes !== undefined) {
            // Just updating jitter, need to preserve existing schedule
            const existing = schedulerRef.getJob(id);
            if (existing) {
              const schedule = { ...existing.schedule };
              if (params.jitter_minutes && typeof params.jitter_minutes === 'number' && params.jitter_minutes > 0) {
                schedule.jitter = (params.jitter_minutes as number) * 60_000;
              } else {
                schedule.jitter = undefined;
              }
              updates.schedule = schedule;
            }
          }
          
          if (Object.keys(updates).length === 0) {
            return { output: '', error: 'No updates provided. Specify at least one: name, prompt, type, enabled, session_id, jitter_minutes' };
          }
          
          const job = schedulerRef.updateJob(id, updates);
          if (!job) return { output: '', error: `Job not found: ${id}` };
          
          return { output: `Updated job "${job.name}" (${job.id})\n  next run: ${job.nextRun ?? 'N/A'}` };
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
          return { output: `Error: Unknown action "${action}". Valid: create, list, edit, get, delete, toggle` };
      }
    },
  },
];
