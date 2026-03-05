/**
 * Heartbeat Tasks Tool — Manage multiple named heartbeat schedules.
 *
 * Allows the AI or user to create, modify, and delete heartbeat tasks
 * with different intervals and prompts. E.g., "check news daily" or
 * "respond to emails every 30 minutes".
 */

import type { Tool } from '../tool-registry.js';
import type { HeartbeatManager, HeartbeatTask } from '../../heartbeat/manager.js';

let heartbeatManagerRef: HeartbeatManager | null = null;

export function setHeartbeatTasksManager(hb: HeartbeatManager): void {
  heartbeatManagerRef = hb;
}

function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}min`;
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}hr`;
  return `${(ms / 86400000).toFixed(1)}d`;
}

const heartbeatTasksTool: Tool = {
  name: 'heartbeat_tasks',
  description: [
    'Manage named heartbeat schedules with independent intervals and prompts.',
    'Actions: list, add, get, update, remove, trigger (run now).',
    'Each task has its own prompt, interval, and session for autonomous check-ins.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: list|add|get|update|remove|trigger',
      },
      id: { type: 'string', description: 'Task ID (for get, update, remove, trigger)' },
      name: { type: 'string', description: 'Task name (for add, update)' },
      prompt: { type: 'string', description: 'Task prompt or .md file path (for add, update)' },
      interval_minutes: { type: 'number', description: 'How often to run in minutes (for add, update)' },
      jitter_minutes: { type: 'number', description: 'Random variance in minutes (for add, update)' },
      enabled: { type: 'boolean', description: 'Whether task is active (for update, default: true)' },
      session_id: { type: 'string', description: 'Custom session ID (for add, update)' },
      integrate_goals: { type: 'boolean', description: 'Include goal summary in prompt (for add, update)' },
    },
    required: ['action'],
  },
  async execute(params) {
    if (!heartbeatManagerRef) {
      return { output: '', error: 'Heartbeat manager not available. Ensure heartbeat is enabled in config.' };
    }

    const action = params.action as string;

    switch (action) {
      case 'list': {
        const tasks = heartbeatManagerRef.listTasks();
        if (tasks.length === 0) {
          return { output: 'No heartbeat tasks configured. Use `heartbeat_tasks action=add` to create one.' };
        }
        const lines = tasks.map(t => {
          const status = t.enabled ? '✅' : '⏸️';
          const interval = formatDuration(t.intervalMs);
          const lastRun = t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : 'never';
          return `${status} **${t.name}** [\`${t.id}\`]\n  Every ${interval} | Last run: ${lastRun}`;
        });
        return { output: `Heartbeat Tasks (${tasks.length}):\n\n${lines.join('\n\n')}` };
      }

      case 'add': {
        const name = params.name as string;
        const prompt = params.prompt as string;
        const intervalMin = params.interval_minutes as number;
        if (!name) return { output: '', error: 'name is required' };
        if (!prompt) return { output: '', error: 'prompt is required' };
        if (!intervalMin || intervalMin < 1) return { output: '', error: 'interval_minutes >= 1 is required' };

        const task = heartbeatManagerRef.addTask({
          name,
          prompt,
          intervalMs: intervalMin * 60 * 1000,
          jitterMs: params.jitter_minutes ? (params.jitter_minutes as number) * 60 * 1000 : undefined,
          enabled: true,
          sessionId: params.session_id as string | undefined,
          integrateGoals: params.integrate_goals as boolean | undefined,
        });

        return { output: `✅ Heartbeat task created: "${name}" [\`${task.id}\`]\nInterval: every ${formatDuration(task.intervalMs)}\nEnabled: true` };
      }

      case 'get': {
        const id = params.id as string;
        if (!id) return { output: '', error: 'id is required' };

        const task = heartbeatManagerRef.getTask(id);
        if (!task) return { output: '', error: `Task "${id}" not found` };

        return {
          output: [
            `**${task.name}** [\`${task.id}\`]`,
            `- Status: ${task.enabled ? '✅ Active' : '⏸️ Paused'}`,
            `- Interval: ${formatDuration(task.intervalMs)}`,
            task.jitterMs ? `- Jitter: ±${formatDuration(task.jitterMs)}` : '',
            task.sessionId ? `- Session: ${task.sessionId}` : '- Session: (default heartbeat session)',
            `- Integrate Goals: ${task.integrateGoals ? 'yes' : 'no'}`,
            `- Created: ${new Date(task.createdAt).toLocaleString()}`,
            task.lastRunAt ? `- Last Run: ${new Date(task.lastRunAt).toLocaleString()}` : '- Last Run: never',
            '',
            '**Prompt:**',
            task.prompt,
          ].filter(Boolean).join('\n'),
        };
      }

      case 'update': {
        const id = params.id as string;
        if (!id) return { output: '', error: 'id is required' };

        const updates: Record<string, unknown> = {};
        if (params.name !== undefined) updates.name = params.name;
        if (params.prompt !== undefined) updates.prompt = params.prompt;
        if (params.interval_minutes !== undefined) updates.intervalMs = (params.interval_minutes as number) * 60 * 1000;
        if (params.jitter_minutes !== undefined) updates.jitterMs = (params.jitter_minutes as number) * 60 * 1000;
        if (params.enabled !== undefined) updates.enabled = params.enabled;
        if (params.session_id !== undefined) updates.sessionId = params.session_id;
        if (params.integrate_goals !== undefined) updates.integrateGoals = params.integrate_goals;

        const task = heartbeatManagerRef.updateTask(id, updates as any);
        if (!task) return { output: '', error: `Task "${id}" not found` };

        return { output: `✅ Updated: "${task.name}" [\`${task.id}\`]\nInterval: ${formatDuration(task.intervalMs)} | Enabled: ${task.enabled}` };
      }

      case 'remove': {
        const id = params.id as string;
        if (!id) return { output: '', error: 'id is required' };

        const removed = heartbeatManagerRef.removeTask(id);
        if (!removed) return { output: '', error: `Task "${id}" not found` };

        return { output: `🗑️ Heartbeat task removed.` };
      }

      case 'trigger': {
        const id = params.id as string;
        if (!id) return { output: '', error: 'id is required' };

        const result = await heartbeatManagerRef.triggerTask(id);
        return { output: result ? `Task triggered. Response:\n${result.slice(0, 2000)}` : 'Task triggered (no response or task not found).' };
      }

      default:
        return { output: '', error: `Unknown action "${action}"` };
    }
  },
};

export { heartbeatTasksTool };
export const heartbeatTasksTools = [heartbeatTasksTool];
