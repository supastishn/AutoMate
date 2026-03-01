/**
 * Goals Tool — Persistent Goal Queue System for Autonomous Operation
 *
 * Manages GOALS.md with structured goal state management.
 * Goals persist across sessions and can be processed autonomously
 * during idle time or heartbeat checks.
 */

import type { Tool } from '../tool-registry.js';
import type { MemoryManager } from '../../memory/manager.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let memoryManagerRef: MemoryManager | null = null;

export function setGoalsMemoryManager(mm: MemoryManager): void {
  memoryManagerRef = mm;
}

export type GoalStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'paused' | 'suggested' | 'decomposed';
export type GoalPriority = 'critical' | 'high' | 'medium' | 'low';
export type GoalSource = 'manual' | 'suggested' | 'auto-extracted' | 'recurring' | 'decomposed';

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  priority: GoalPriority;
  createdAt: number;
  updatedAt: number;
  progress?: string;      // Current progress notes
  blockers?: string[];    // Things blocking this goal
  dependencies?: string[]; // IDs of goals this depends on
  subtasks?: string[];    // Checklist of subtasks
  completedSubtasks?: string[];
  failedReason?: string;  // Why it failed (if status=failed)
  completedAt?: number;   // When it was completed
  // ── Autonomy extensions ──
  source?: GoalSource;           // Where this goal came from
  parentGoalId?: string;         // Parent goal (for decomposed children)
  sessionOrigin?: string;        // Which session created this goal
  originalPriority?: GoalPriority; // Original priority before escalation
  // Recurring goal support
  recurring?: {
    enabled: boolean;
    intervalMs: number;     // How often to re-queue after completion
    lastRunAt?: number;     // Last time this recurring goal was processed
    templateGoalId?: string; // Original template goal ID
  };
  // Retry support
  retryCount?: number;        // How many times this has been retried
  maxRetries?: number;        // Max retry attempts (default: 3)
  retryStrategy?: string[];   // Past failure reasons for context
  lastRetryAt?: number;       // When last retry was queued
}

export interface GoalsFile {
  version: number;
  goals: Goal[];
  lastProcessed?: number;
  lastDailyReport?: number;  // Timestamp of last daily report
  settings: {
    autoProcessDuringIdle: boolean;
    maxInProgressGoals: number;
    idleThresholdMs: number;
    // Feature 1: Auto-extraction
    autoApproveAfterMs: number;  // Auto-approve suggested goals after this delay (0=instant, -1=never)
    // Feature 2: Goal chaining
    maxChainsPerHeartbeat: number; // Max goals to chain-promote per heartbeat tick
    // Feature 3: Adaptive intervals
    adaptiveInterval: {
      enabled: boolean;
      activeMs: number;    // Interval when goals are active (default: 5min)
      idleMs: number;      // Interval when nothing pending (default: 2hr)
      criticalMs: number;  // Interval when critical goals exist (default: 2min)
    };
    // Feature 6: Retry
    retryBaseDelayMs: number;  // Base delay for exponential backoff (default: 5min)
    retryMaxDelayMs: number;   // Max retry delay (default: 2hr)
    // Feature 7: Escalation
    escalation: {
      enabled: boolean;
      lowToMediumMs: number;    // Time before low→medium (default: 24h)
      mediumToHighMs: number;   // Time before medium→high (default: 48h)
      highToCriticalMs: number; // Time before high→critical (default: 72h)
    };
    // Feature 9: Daily reports
    dailyReport: {
      enabled: boolean;
      timeHour: number;  // Hour of day to generate report (0-23, default: 9)
    };
  };
}

const GOALS_FILE = 'GOALS.md';
const GOALS_JSON = 'goals.json';

/** Generate a unique goal ID */
function generateGoalId(): string {
  return `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Load goals from JSON file (primary storage) */
function loadGoalsFile(memoryDir: string): GoalsFile {
  const jsonPath = join(memoryDir, GOALS_JSON);
  try {
    if (existsSync(jsonPath)) {
      const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      // Migration: ensure all fields exist
      return {
        version: data.version || 1,
        goals: data.goals || [],
        lastProcessed: data.lastProcessed,
        lastDailyReport: data.lastDailyReport,
        settings: {
          autoProcessDuringIdle: data.settings?.autoProcessDuringIdle ?? true,
          maxInProgressGoals: data.settings?.maxInProgressGoals ?? 3,
          idleThresholdMs: data.settings?.idleThresholdMs ?? 5 * 60 * 1000,
          autoApproveAfterMs: data.settings?.autoApproveAfterMs ?? 30 * 60 * 1000,
          maxChainsPerHeartbeat: data.settings?.maxChainsPerHeartbeat ?? 3,
          adaptiveInterval: {
            enabled: data.settings?.adaptiveInterval?.enabled ?? false,
            activeMs: data.settings?.adaptiveInterval?.activeMs ?? 5 * 60 * 1000,
            idleMs: data.settings?.adaptiveInterval?.idleMs ?? 2 * 60 * 60 * 1000,
            criticalMs: data.settings?.adaptiveInterval?.criticalMs ?? 2 * 60 * 1000,
          },
          retryBaseDelayMs: data.settings?.retryBaseDelayMs ?? 5 * 60 * 1000,
          retryMaxDelayMs: data.settings?.retryMaxDelayMs ?? 2 * 60 * 60 * 1000,
          escalation: {
            enabled: data.settings?.escalation?.enabled ?? true,
            lowToMediumMs: data.settings?.escalation?.lowToMediumMs ?? 24 * 60 * 60 * 1000,
            mediumToHighMs: data.settings?.escalation?.mediumToHighMs ?? 48 * 60 * 60 * 1000,
            highToCriticalMs: data.settings?.escalation?.highToCriticalMs ?? 72 * 60 * 60 * 1000,
          },
          dailyReport: {
            enabled: data.settings?.dailyReport?.enabled ?? false,
            timeHour: data.settings?.dailyReport?.timeHour ?? 9,
          },
        },
      };
    }
  } catch (err) {
    console.error('[goals] Failed to load goals.json:', (err as Error).message);
  }
  // Return default
  return {
    version: 1,
    goals: [],
    settings: {
      autoProcessDuringIdle: true,
      maxInProgressGoals: 3,
      idleThresholdMs: 5 * 60 * 1000,
      autoApproveAfterMs: 30 * 60 * 1000,
      maxChainsPerHeartbeat: 3,
      adaptiveInterval: {
        enabled: false,
        activeMs: 5 * 60 * 1000,
        idleMs: 2 * 60 * 60 * 1000,
        criticalMs: 2 * 60 * 1000,
      },
      retryBaseDelayMs: 5 * 60 * 1000,
      retryMaxDelayMs: 2 * 60 * 60 * 1000,
      escalation: {
        enabled: true,
        lowToMediumMs: 24 * 60 * 60 * 1000,
        mediumToHighMs: 48 * 60 * 60 * 1000,
        highToCriticalMs: 72 * 60 * 60 * 1000,
      },
      dailyReport: {
        enabled: false,
        timeHour: 9,
      },
    },
  };
}

/** Save goals to JSON file */
function saveGoalsFile(memoryDir: string, data: GoalsFile): void {
  const jsonPath = join(memoryDir, GOALS_JSON);
  writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  
  // Also generate human-readable GOALS.md for visibility
  generateGoalsMd(memoryDir, data);
}

/** Generate human-readable GOALS.md */
function generateGoalsMd(memoryDir: string, data: GoalsFile): void {
  const lines: string[] = [
    '# Goal Queue',
    '',
    '_Autonomous goal tracking for continuous operation._',
    '',
    '## Status Legend',
    '- 🔴 `pending` - Waiting to be started',
    '- 🟡 `in_progress` - Currently being worked on',
    '- 🟢 `completed` - Successfully finished',
    '- 🔵 `paused` - Temporarily paused',
    '- ⚫ `failed` - Failed or blocked (see reason)',
    '- 💡 `suggested` - Auto-extracted, awaiting approval',
    '- 🔀 `decomposed` - Split into sub-goals',
    '',
  ];

  // Group by status
  const pending = data.goals.filter(g => g.status === 'pending');
  const inProgress = data.goals.filter(g => g.status === 'in_progress');
  const paused = data.goals.filter(g => g.status === 'paused');
  const completed = data.goals.filter(g => g.status === 'completed');
  const failed = data.goals.filter(g => g.status === 'failed');
  const suggested = data.goals.filter(g => g.status === 'suggested');
  const decomposed = data.goals.filter(g => g.status === 'decomposed');
  const recurring = data.goals.filter(g => g.recurring?.enabled && g.status !== 'completed' && g.status !== 'failed');

  // Active goals first
  if (inProgress.length > 0) {
    lines.push('## 🟡 In Progress');
    for (const goal of inProgress) {
      lines.push(formatGoalMd(goal));
    }
    lines.push('');
  }

  if (pending.length > 0) {
    lines.push('## 🔴 Pending');
    // Sort by priority
    const sorted = pending.sort((a, b) => priorityValue(b.priority) - priorityValue(a.priority));
    for (const goal of sorted) {
      lines.push(formatGoalMd(goal));
    }
    lines.push('');
  }

  if (suggested.length > 0) {
    lines.push('## 💡 Suggested');
    lines.push('_Auto-extracted goals awaiting approval or auto-approve timeout._');
    lines.push('');
    for (const goal of suggested) {
      lines.push(formatGoalMd(goal));
    }
    lines.push('');
  }

  if (recurring.length > 0) {
    lines.push('## 🔄 Recurring');
    for (const goal of recurring) {
      const intervalLabel = formatDuration(goal.recurring!.intervalMs);
      lines.push(formatGoalMd(goal) + `\n- **Repeats**: every ${intervalLabel}`);
    }
    lines.push('');
  }

  if (paused.length > 0) {
    lines.push('## 🔵 Paused');
    for (const goal of paused) {
      lines.push(formatGoalMd(goal));
    }
    lines.push('');
  }

  if (decomposed.length > 0) {
    lines.push('## 🔀 Decomposed');
    for (const goal of decomposed) {
      const children = data.goals.filter(g => g.parentGoalId === goal.id);
      const done = children.filter(g => g.status === 'completed').length;
      lines.push(formatGoalMd(goal) + `\n- **Sub-goals**: ${done}/${children.length} complete`);
    }
    lines.push('');
  }

  // Summary
  lines.push('## Statistics');
  lines.push(`- Total: ${data.goals.length}`);
  lines.push(`- Completed: ${completed.length}`);
  lines.push(`- Failed: ${failed.length}`);
  lines.push(`- In Progress: ${inProgress.length}`);
  lines.push(`- Pending: ${pending.length}`);
  if (suggested.length) lines.push(`- Suggested: ${suggested.length}`);
  if (decomposed.length) lines.push(`- Decomposed: ${decomposed.length}`);
  lines.push('');
  lines.push('---');
  lines.push(`_Last updated: ${new Date().toISOString()}_`);

  const mdPath = join(memoryDir, GOALS_FILE);
  writeFileSync(mdPath, lines.join('\n'));
}

/** Format a duration in ms to human-readable string */
function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}min`;
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}hr`;
  return `${(ms / 86400000).toFixed(1)}d`;
}

/** Format a goal as markdown */
function formatGoalMd(goal: Goal): string {
  const priorityEmoji = { critical: '🔥', high: '⬆️', medium: '➡️', low: '⬇️' };
  const lines: string[] = [
    `### ${priorityEmoji[goal.priority]} ${goal.title}`,
    `- **ID**: \`${goal.id}\``,
    `- **Status**: \`${goal.status}\``,
    `- **Priority**: ${goal.priority}${goal.originalPriority && goal.originalPriority !== goal.priority ? ` (escalated from ${goal.originalPriority})` : ''}`,
    `- **Created**: ${new Date(goal.createdAt).toLocaleDateString()}`,
  ];
  
  if (goal.source && goal.source !== 'manual') {
    lines.push(`- **Source**: ${goal.source}`);
  }
  if (goal.sessionOrigin) {
    lines.push(`- **Origin Session**: ${goal.sessionOrigin}`);
  }
  if (goal.parentGoalId) {
    lines.push(`- **Parent Goal**: \`${goal.parentGoalId}\``);
  }
  if (goal.description) {
    lines.push('', goal.description);
  }
  
  if (goal.progress) {
    lines.push('', '**Progress:**', goal.progress);
  }
  
  if (goal.subtasks && goal.subtasks.length > 0) {
    lines.push('', '**Subtasks:**');
    const completed = new Set(goal.completedSubtasks || []);
    for (const subtask of goal.subtasks) {
      const check = completed.has(subtask) ? '✅' : '⬜';
      lines.push(`- ${check} ${subtask}`);
    }
  }
  
  if (goal.blockers && goal.blockers.length > 0) {
    lines.push('', '**Blockers:**');
    for (const blocker of goal.blockers) {
      lines.push(`- 🚫 ${blocker}`);
    }
  }
  
  if (goal.failedReason) {
    lines.push('', `**Failed Reason:** ${goal.failedReason}`);
  }

  if (goal.retryCount && goal.retryCount > 0) {
    lines.push(`- **Retries**: ${goal.retryCount}/${goal.maxRetries ?? 3}`);
  }
  
  lines.push('');
  return lines.join('\n');
}

/** Get priority numeric value for sorting */
function priorityValue(p: GoalPriority): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[p] || 0;
}

/** Get next goal to work on */
function getNextGoal(data: GoalsFile): Goal | null {
  const inProgressCount = data.goals.filter(g => g.status === 'in_progress').length;
  if (inProgressCount >= data.settings.maxInProgressGoals) {
    return null;
  }
  
  const pending = data.goals
    .filter(g => g.status === 'pending')
    .filter(g => {
      // Check dependencies
      if (!g.dependencies || g.dependencies.length === 0) return true;
      return g.dependencies.every(depId => {
        const dep = data.goals.find(d => d.id === depId);
        return dep?.status === 'completed';
      });
    })
    .sort((a, b) => priorityValue(b.priority) - priorityValue(a.priority));
  
  return pending[0] || null;
}

// ── Goals Tool ────────────────────────────────────────────────────────────

const goalsTool: Tool = {
  name: 'goals',
  description: [
    'Manage a persistent goal queue for autonomous operation and task tracking.',
    '',
    'WHEN TO USE:',
    '- When you need to track long-term objectives',
    '- For breaking down complex tasks into manageable goals',
    '- When you want to maintain a queue of work items',
    '- For autonomous operation during idle times or heartbeat checks',
    '- When you need to track progress on multiple concurrent tasks',
    '- For systematic task completion with dependencies',
    '- For organizing work with priorities and status tracking',
    '',
    'ACTIONS:',
    '',
    'list: List all goals with filtering options',
    '  Parameters: filter (optional: pending|in_progress|completed|failed|paused|suggested|decomposed)',
    '  Returns: Goals with status, priority, and ID',
    '  Example: { "action": "list", "filter": "in_progress" }',
    '',
    'add: Create a new goal with details',
    '  Parameters: title (required), description, priority, subtasks, dependencies',
    '  Sets status to "pending" and creates a new goal entry',
    '  Example: { "action": "add", "title": "Refactor auth module", "priority": "high", "subtasks": ["Update interfaces", "Test new implementation"] }',
    '',
    'get: Get detailed information about a specific goal',
    '  Parameters: id (required)',
    '  Returns: Complete goal details including description, progress, blockers, and subtasks',
    '  Example: { "action": "get", "id": "goal123" }',
    '',
    'update: Update goal properties',
    '  Parameters: id (required), status, progress, description, blocker',
    '  Updates specific properties of a goal without changing others',
    '  Example: { "action": "update", "id": "goal123", "progress": "50% completed", "status": "in_progress" }',
    '',
    'start: Mark a goal as in_progress',
    '  Parameters: id (required)',
    '  Checks dependencies before starting, sets status to "in_progress"',
    '  Example: { "action": "start", "id": "goal123" }',
    '',
    'complete: Mark a goal as completed',
    '  Parameters: id (required)',
    '  Updates status to "completed", archives to completed-goals.md',
    '  Example: { "action": "complete", "id": "goal123" }',
    '',
    'fail: Mark a goal as failed',
    '  Parameters: id (required), reason (required)',
    '  Sets status to "failed" with failure reason',
    '  Example: { "action": "fail", "id": "goal123", "reason": "External dependency not available" }',
    '',
    'pause: Temporarily pause a goal',
    '  Parameters: id (required)',
    '  Sets status to "paused" while preserving progress',
    '  Example: { "action": "pause", "id": "goal123" }',
    '',
    'resume: Resume a paused goal',
    '  Parameters: id (required)',
    '  Sets status to "pending" allowing it to be started again',
    '  Example: { "action": "resume", "id": "goal123" }',
    '',
    'delete: Remove a goal permanently',
    '  Parameters: id (required)',
    '  Removes goal from queue (use carefully)',
    '  Example: { "action": "delete", "id": "goal123" }',
    '',
    'next: Get the next highest-priority goal to work on',
    '  Parameters: none',
    '  Respects priorities, dependencies, and max in-progress limits',
    '  Example: { "action": "next" }',
    '',
    'subtask: Mark a subtask as completed',
    '  Parameters: id (required), subtask (required)',
    '  Updates progress on a goal\'s checklist',
    '  Example: { "action": "subtask", "id": "goal123", "subtask": "Update documentation" }',
    '',
    'stats: Show goal statistics and metrics',
    '  Parameters: none',
    '  Returns counts by status, priority, and other metrics',
    '  Example: { "action": "stats" }',
    '',
    'settings: View or update goal processing settings',
    '  Parameters: setting, value (for updates)',
    '  Controls auto-processing, concurrency limits, and timing',
    '  Example: { "action": "settings" } or { "action": "settings", "setting": "maxInProgressGoals", "value": "2" }',
    '',
    'GOAL STATES:',
    '- pending: Waiting to be started',
    '- in_progress: Currently being worked on',
    '- completed: Successfully finished and archived',
    '- failed: Failed or blocked with reason',
    '- paused: Temporarily suspended',
    '- suggested: Auto-extracted, awaiting approval',
    '- decomposed: Split into sub-goals',
    '',
    'PRIORITY LEVELS:',
    '- critical: Must be done immediately (🔥)',
    '- high: Important and time-sensitive (⬆️)',
    '- medium: Standard priority (➡️)',
    '- low: Can be deferred (⬇️)',
    '',
    'FEATURES:',
    '- Persistent storage across sessions',
    '- Dependency management between goals',
    '- Subtask checklists for complex goals',
    '- Priority-based processing order',
    '- Progress tracking and blocker identification',
    '- Automatic human-readable GOALS.md generation',
    '- Archiving of completed goals',
    '- Autonomous processing capabilities',
    '- Goal decomposition into sub-goals',
    '- Recurring goals that auto-requeue after completion',
    '- Auto-extraction of goals from conversation text',
    '- Failure recovery with exponential backoff retry',
    '- Priority auto-escalation for stale goals',
    '- Cross-session goal awareness',
    '',
    'ADVANCED ACTIONS:',
    '',
    'extract: Extract implied goals from conversation text',
    '  Parameters: text (required)',
    '  Creates goals with status "suggested" — they auto-approve after timeout or use approve action',
    '  Example: { "action": "extract", "text": "I need to fix the login page and update the docs" }',
    '',
    'approve: Approve a suggested goal (promotes to pending)',
    '  Parameters: id (required)',
    '  Example: { "action": "approve", "id": "goal123" }',
    '',
    'decompose: Break a goal into sub-goals',
    '  Parameters: id (required), subtasks (required array of sub-goal titles), strategy (sequential|parallel, default: parallel)',
    '  Creates child goals linked to parent, parent status becomes "decomposed"',
    '  Example: { "action": "decompose", "id": "goal123", "subtasks": ["Design API", "Implement endpoints", "Write tests"], "strategy": "sequential" }',
    '',
    'add_recurring: Create a recurring goal that re-queues after completion',
    '  Parameters: title (required), description, priority, interval (required, in minutes)',
    '  Example: { "action": "add_recurring", "title": "Check server health", "interval": 60, "priority": "medium" }',
    '',
    'retry: Manually retry a failed goal',
    '  Parameters: id (required), strategy (optional new approach description)',
    '  Example: { "action": "retry", "id": "goal123", "strategy": "Try a different API endpoint" }',
    '',
    'HOW TO USE:',
    '- Start with `goals action=add` to create new goals',
    '- Use `goals action=next` to identify priority work',
    '- Track progress with `goals action=update`',
    '- Mark completion with `goals action=complete`',
    '- Monitor status with `goals action=list` or `goals action=stats`',
    '- Use `goals action=subtask` for checklist progress',
    '- Set dependencies to control execution order',
    '',
    'BENEFITS:',
    '- Maintains focus on important long-term objectives',
    '- Enables autonomous operation during idle times',
    '- Tracks progress and prevents work from being forgotten',
    '- Helps manage complex multi-step tasks',
    '- Provides accountability for commitments',
    '- Integrates with heartbeat and auto-processing systems',
    '',
    'SAFETY NOTES:',
    '- Goals persist in JSON format in memory directory',
    '- Completed goals are archived separately',
    '- Dependencies ensure proper task ordering',
    '- Max in-progress limits prevent overcommitment',
    '- Use carefully with delete action as it permanently removes goals',
    '- All changes update human-readable GOALS.md file',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: list|add|get|update|start|complete|fail|pause|resume|delete|next|subtask|stats|settings|extract|approve|decompose|add_recurring|retry',
      },
      id: { type: 'string', description: 'Goal ID (for get, update, start, complete, fail, pause, resume, delete, subtask, approve, decompose, retry)' },
      title: { type: 'string', description: 'Goal title (for add, add_recurring)' },
      description: { type: 'string', description: 'Goal description (for add, update, add_recurring)' },
      priority: { type: 'string', description: 'Priority: critical|high|medium|low (default: medium)' },
      status: { type: 'string', description: 'New status (for update)' },
      progress: { type: 'string', description: 'Progress notes (for update)' },
      subtasks: { type: 'array', items: { type: 'string' }, description: 'List of subtasks (for add) or sub-goal titles (for decompose)' },
      subtask: { type: 'string', description: 'Subtask to mark complete (for subtask action)' },
      blocker: { type: 'string', description: 'Blocker to add (for update)' },
      reason: { type: 'string', description: 'Failure reason (for fail)' },
      dependencies: { type: 'array', items: { type: 'string' }, description: 'Goal IDs this depends on (for add)' },
      filter: { type: 'string', description: 'Filter by status (for list): pending|in_progress|completed|failed|paused|suggested|decomposed' },
      setting: { type: 'string', description: 'Setting name to update (for settings)' },
      value: { type: 'string', description: 'Setting value (for settings)' },
      text: { type: 'string', description: 'Conversation text to extract goals from (for extract)' },
      strategy: { type: 'string', description: 'Decomposition strategy: sequential|parallel (for decompose) or new approach (for retry)' },
      interval: { type: 'number', description: 'Interval in minutes for recurring goals (for add_recurring)' },
    },
    required: ['action'],
  },
  async execute(params) {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    
    const memoryDir = memoryManagerRef.getDirectory();
    const data = loadGoalsFile(memoryDir);
    const action = params.action as string;
    
    switch (action) {
      case 'list': {
        const filter = params.filter as GoalStatus | undefined;
        let goals = data.goals;
        if (filter) {
          goals = goals.filter(g => g.status === filter);
        }
        if (goals.length === 0) {
          return { output: filter ? `No goals with status "${filter}".` : 'No goals yet. Use `goals action=add` to create one.' };
        }
        
        const lines = goals.map(g => {
          const statusEmoji = {
            pending: '🔴',
            in_progress: '🟡',
            completed: '🟢',
            failed: '⚫',
            paused: '🔵',
            suggested: '💡',
            decomposed: '🔀',
          } as Record<string, string>;
          const priorityEmoji = { critical: '🔥', high: '⬆️', medium: '➡️', low: '⬇️' };
          return `${statusEmoji[g.status]} ${priorityEmoji[g.priority]} **${g.title}** \`${g.id}\``;
        });
        
        return { output: `Goals (${goals.length}):\n` + lines.join('\n') };
      }
      
      case 'add': {
        const title = params.title as string;
        if (!title) return { output: '', error: 'title is required for add' };
        
        const goal: Goal = {
          id: generateGoalId(),
          title,
          description: (params.description as string) || '',
          status: 'pending',
          priority: (params.priority as GoalPriority) || 'medium',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          subtasks: params.subtasks as string[] | undefined,
          completedSubtasks: [],
          dependencies: params.dependencies as string[] | undefined,
          source: 'manual',
        };
        
        data.goals.push(goal);
        saveGoalsFile(memoryDir, data);
        
        return { output: `Goal created: "${title}" [${goal.id}]\nPriority: ${goal.priority}\nStatus: pending\n\nView all goals with \`goals action=list\`` };
      }
      
      case 'get': {
        const id = params.id as string;
        if (!id) return { output: '', error: 'id is required for get' };
        
        const goal = data.goals.find(g => g.id === id);
        if (!goal) return { output: '', error: `Goal "${id}" not found` };
        
        return { output: formatGoalMd(goal) };
      }
      
      case 'update': {
        const id = params.id as string;
        if (!id) return { output: '', error: 'id is required for update' };
        
        const goal = data.goals.find(g => g.id === id);
        if (!goal) return { output: '', error: `Goal "${id}" not found` };
        
        if (params.status) goal.status = params.status as GoalStatus;
        if (params.progress) goal.progress = params.progress as string;
        if (params.description) goal.description = params.description as string;
        if (params.blocker) {
          if (!goal.blockers) goal.blockers = [];
          goal.blockers.push(params.blocker as string);
        }
        goal.updatedAt = Date.now();
        
        saveGoalsFile(memoryDir, data);
        return { output: `Goal "${goal.title}" updated. Status: ${goal.status}` };
      }
      
      case 'start': {
        const id = params.id as string;
        if (!id) return { output: '', error: 'id is required for start' };
        
        const goal = data.goals.find(g => g.id === id);
        if (!goal) return { output: '', error: `Goal "${id}" not found` };
        
        // Check dependencies
        if (goal.dependencies && goal.dependencies.length > 0) {
          const unmet = goal.dependencies.filter(depId => {
            const dep = data.goals.find(d => d.id === depId);
            return dep?.status !== 'completed';
          });
          if (unmet.length > 0) {
            return { output: '', error: `Cannot start: dependencies not completed: ${unmet.join(', ')}` };
          }
        }
        
        goal.status = 'in_progress';
        goal.updatedAt = Date.now();
        saveGoalsFile(memoryDir, data);
        
        return { output: `Started working on: "${goal.title}" [${goal.id}]\n\nUse \`goals action=update id="${id}" progress="..."\` to track progress.` };
      }
      
      case 'complete': {
        const id = params.id as string;
        if (!id) return { output: '', error: 'id is required for complete' };
        
        const goal = data.goals.find(g => g.id === id);
        if (!goal) return { output: '', error: `Goal "${id}" not found` };
        
        goal.status = 'completed';
        goal.completedAt = Date.now();
        goal.updatedAt = Date.now();
        saveGoalsFile(memoryDir, data);
        
        // Archive completed goal
        const archiveEntry = `\n## ${new Date().toISOString().split('T')[0]} - Completed Goal\n${formatGoalMd(goal)}\n`;
        memoryManagerRef.appendArchive('completed-goals', archiveEntry);
        
        return { output: `✅ Goal completed: "${goal.title}"\n\nArchived to completed-goals.md` };
      }
      
      case 'fail': {
        const id = params.id as string;
        const reason = params.reason as string;
        if (!id) return { output: '', error: 'id is required for fail' };
        if (!reason) return { output: '', error: 'reason is required for fail' };
        
        const goal = data.goals.find(g => g.id === id);
        if (!goal) return { output: '', error: `Goal "${id}" not found` };
        
        goal.status = 'failed';
        goal.failedReason = reason;
        goal.updatedAt = Date.now();
        saveGoalsFile(memoryDir, data);
        
        return { output: `⚫ Goal failed: "${goal.title}"\nReason: ${reason}` };
      }
      
      case 'pause': {
        const id = params.id as string;
        if (!id) return { output: '', error: 'id is required for pause' };
        
        const goal = data.goals.find(g => g.id === id);
        if (!goal) return { output: '', error: `Goal "${id}" not found` };
        
        goal.status = 'paused';
        goal.updatedAt = Date.now();
        saveGoalsFile(memoryDir, data);
        
        return { output: `Paused: "${goal.title}"` };
      }
      
      case 'resume': {
        const id = params.id as string;
        if (!id) return { output: '', error: 'id is required for resume' };
        
        const goal = data.goals.find(g => g.id === id);
        if (!goal) return { output: '', error: `Goal "${id}" not found` };
        
        goal.status = 'pending';
        goal.updatedAt = Date.now();
        saveGoalsFile(memoryDir, data);
        
        return { output: `Resumed: "${goal.title}" (status: pending)` };
      }
      
      case 'delete': {
        const id = params.id as string;
        if (!id) return { output: '', error: 'id is required for delete' };
        
        const idx = data.goals.findIndex(g => g.id === id);
        if (idx === -1) return { output: '', error: `Goal "${id}" not found` };
        
        const [removed] = data.goals.splice(idx, 1);
        saveGoalsFile(memoryDir, data);
        
        return { output: `Deleted: "${removed.title}"` };
      }
      
      case 'next': {
        const next = getNextGoal(data);
        if (!next) {
          const inProgress = data.goals.filter(g => g.status === 'in_progress');
          if (inProgress.length > 0) {
            return { output: `No new goals to start. ${inProgress.length} goal(s) already in progress:\n` + 
              inProgress.map(g => `- 🟡 ${g.title} [${g.id}]`).join('\n') };
          }
          return { output: 'No pending goals. Use `goals action=add` to create one.' };
        }
        
        return { output: `**Next goal to work on:**\n\n${formatGoalMd(next)}\n\nStart it with: \`goals action=start id="${next.id}"\`` };
      }
      
      case 'subtask': {
        const id = params.id as string;
        const subtask = params.subtask as string;
        if (!id) return { output: '', error: 'id is required for subtask' };
        if (!subtask) return { output: '', error: 'subtask is required for subtask' };
        
        const goal = data.goals.find(g => g.id === id);
        if (!goal) return { output: '', error: `Goal "${id}" not found` };
        
        if (!goal.subtasks?.includes(subtask)) {
          return { output: '', error: `Subtask "${subtask}" not found in goal` };
        }
        
        if (!goal.completedSubtasks) goal.completedSubtasks = [];
        goal.completedSubtasks.push(subtask);
        goal.updatedAt = Date.now();
        saveGoalsFile(memoryDir, data);
        
        const remaining = goal.subtasks.length - goal.completedSubtasks.length;
        return { output: `✅ Subtask completed: "${subtask}"\n${remaining} subtask(s) remaining for "${goal.title}"` };
      }
      
      case 'stats': {
        const stats = {
          total: data.goals.length,
          pending: data.goals.filter(g => g.status === 'pending').length,
          inProgress: data.goals.filter(g => g.status === 'in_progress').length,
          completed: data.goals.filter(g => g.status === 'completed').length,
          failed: data.goals.filter(g => g.status === 'failed').length,
          paused: data.goals.filter(g => g.status === 'paused').length,
          critical: data.goals.filter(g => g.priority === 'critical' && g.status !== 'completed').length,
        };
        
        return { output: `Goal Statistics:\n- Total: ${stats.total}\n- In Progress: ${stats.inProgress}\n- Pending: ${stats.pending}\n- Completed: ${stats.completed}\n- Failed: ${stats.failed}\n- Paused: ${stats.paused}\n- Critical Priority Active: ${stats.critical}` };
      }
      
      case 'settings': {
        if (params.setting && params.value !== undefined) {
          const key = params.setting as keyof typeof data.settings;
          if (key in data.settings) {
            if (typeof data.settings[key as keyof typeof data.settings] === 'boolean') {
              (data.settings as any)[key] = params.value === 'true';
            } else if (typeof data.settings[key as keyof typeof data.settings] === 'number') {
              (data.settings as any)[key] = parseInt(params.value as string, 10);
            } else {
              (data.settings as any)[key] = params.value;
            }
            saveGoalsFile(memoryDir, data);
            return { output: `Setting "${key}" updated to: ${(data.settings as any)[key]}` };
          }
          return { output: '', error: `Unknown setting: ${key}` };
        }
        
        return { output: [
          'Goal Settings:',
          `- autoProcessDuringIdle: ${data.settings.autoProcessDuringIdle}`,
          `- maxInProgressGoals: ${data.settings.maxInProgressGoals}`,
          `- idleThresholdMs: ${data.settings.idleThresholdMs}`,
          `- autoApproveAfterMs: ${data.settings.autoApproveAfterMs}`,
          `- maxChainsPerHeartbeat: ${data.settings.maxChainsPerHeartbeat}`,
          `- adaptiveInterval: ${JSON.stringify(data.settings.adaptiveInterval)}`,
          `- retryBaseDelayMs: ${data.settings.retryBaseDelayMs}`,
          `- retryMaxDelayMs: ${data.settings.retryMaxDelayMs}`,
          `- escalation: ${JSON.stringify(data.settings.escalation)}`,
          `- dailyReport: ${JSON.stringify(data.settings.dailyReport)}`,
        ].join('\n') };
      }

      // ── Feature 1: Extract goals from conversation text ──
      case 'extract': {
        const text = params.text as string;
        if (!text) return { output: '', error: 'text is required for extract' };

        const patterns = [
          /(?:i need to|need to|have to|must|should|gotta)\s+(.{10,80})/gi,
          /(?:can you|please|could you)\s+(.{10,80})/gi,
          /(?:todo|fixme|fix|implement|create|build|set up|configure|deploy|update|refactor|migrate)\s+(.{5,80})/gi,
          /(?:remind me to|don't forget to|remember to)\s+(.{10,80})/gi,
          /(?:later|tomorrow|next week|eventually|someday|when i have time)\s*[,:]?\s*(.{10,80})/gi,
          /(?:we should|let's|let me)\s+(.{10,80})/gi,
        ];

        const extracted: string[] = [];
        for (const pattern of patterns) {
          let match;
          while ((match = pattern.exec(text)) !== null) {
            const task = match[1].trim().replace(/[.!?,;]+$/, '').trim();
            if (task.length >= 5 && !extracted.some(e => e.toLowerCase() === task.toLowerCase())) {
              extracted.push(task);
            }
          }
        }

        if (extracted.length === 0) {
          return { output: 'No implied goals found in the provided text.' };
        }

        const created: string[] = [];
        for (const task of extracted.slice(0, 10)) {
          const goal: Goal = {
            id: generateGoalId(),
            title: task.slice(0, 80),
            description: `Auto-extracted from conversation: "${task}"`,
            status: 'suggested',
            priority: 'medium',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            source: 'auto-extracted',
          };
          data.goals.push(goal);
          created.push(`💡 ${goal.title} [\`${goal.id}\`]`);
        }
        saveGoalsFile(memoryDir, data);

        return { output: `Extracted ${created.length} suggested goal(s):\n${created.join('\n')}\n\nApprove with \`goals action=approve id="..."\` or they auto-approve after ${formatDuration(data.settings.autoApproveAfterMs)}` };
      }

      // ── Feature 1: Approve a suggested goal ──
      case 'approve': {
        const id = params.id as string;
        if (!id) return { output: '', error: 'id is required for approve' };

        const goal = data.goals.find(g => g.id === id);
        if (!goal) return { output: '', error: `Goal "${id}" not found` };
        if (goal.status !== 'suggested') return { output: '', error: `Goal "${id}" is not in suggested status (current: ${goal.status})` };

        goal.status = 'pending';
        goal.updatedAt = Date.now();
        saveGoalsFile(memoryDir, data);

        return { output: `✅ Approved: "${goal.title}" — now pending.` };
      }

      // ── Feature 4: Decompose a goal into sub-goals ──
      case 'decompose': {
        const id = params.id as string;
        const subtaskTitles = params.subtasks as string[];
        const strategy = (params.strategy as string) || 'parallel';
        if (!id) return { output: '', error: 'id is required for decompose' };
        if (!subtaskTitles || subtaskTitles.length === 0) return { output: '', error: 'subtasks array is required for decompose' };

        const goal = data.goals.find(g => g.id === id);
        if (!goal) return { output: '', error: `Goal "${id}" not found` };

        // Create child goals
        const childIds: string[] = [];
        for (let i = 0; i < subtaskTitles.length; i++) {
          const childGoal: Goal = {
            id: generateGoalId(),
            title: subtaskTitles[i],
            description: `Sub-goal of "${goal.title}"`,
            status: 'pending',
            priority: goal.priority,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            parentGoalId: id,
            source: 'decomposed',
            dependencies: strategy === 'sequential' && i > 0 ? [childIds[i - 1]] : undefined,
          };
          data.goals.push(childGoal);
          childIds.push(childGoal.id);
        }

        // Mark parent as decomposed
        goal.status = 'decomposed';
        goal.updatedAt = Date.now();
        saveGoalsFile(memoryDir, data);

        return { output: `🔀 Decomposed "${goal.title}" into ${childIds.length} sub-goals (${strategy}):\n${subtaskTitles.map((t, i) => `  ${i + 1}. ${t} [\`${childIds[i]}\`]`).join('\n')}` };
      }

      // ── Feature 5: Add a recurring goal ──
      case 'add_recurring': {
        const title = params.title as string;
        const interval = params.interval as number;
        if (!title) return { output: '', error: 'title is required for add_recurring' };
        if (!interval || interval < 1) return { output: '', error: 'interval (in minutes, >= 1) is required for add_recurring' };

        const goal: Goal = {
          id: generateGoalId(),
          title,
          description: (params.description as string) || '',
          status: 'pending',
          priority: (params.priority as GoalPriority) || 'medium',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: 'recurring',
          recurring: {
            enabled: true,
            intervalMs: interval * 60 * 1000,
          },
        };

        data.goals.push(goal);
        saveGoalsFile(memoryDir, data);

        return { output: `🔄 Recurring goal created: "${title}" [${goal.id}]\nRepeats every ${formatDuration(goal.recurring!.intervalMs)}\nPriority: ${goal.priority}` };
      }

      // ── Feature 6: Retry a failed goal ──
      case 'retry': {
        const id = params.id as string;
        if (!id) return { output: '', error: 'id is required for retry' };

        const goal = data.goals.find(g => g.id === id);
        if (!goal) return { output: '', error: `Goal "${id}" not found` };
        if (goal.status !== 'failed') return { output: '', error: `Goal "${id}" is not failed (current: ${goal.status})` };

        const maxRetries = goal.maxRetries ?? 3;
        const retryCount = (goal.retryCount ?? 0) + 1;
        if (retryCount > maxRetries) {
          return { output: '', error: `Goal "${id}" has exceeded max retries (${maxRetries}). Delete and recreate to try again.` };
        }

        // Store the failure reason as retry context
        if (!goal.retryStrategy) goal.retryStrategy = [];
        if (goal.failedReason) goal.retryStrategy.push(`Attempt ${retryCount - 1} failed: ${goal.failedReason}`);
        if (params.strategy) goal.retryStrategy.push(`New strategy: ${params.strategy}`);

        goal.status = 'pending';
        goal.retryCount = retryCount;
        goal.lastRetryAt = Date.now();
        goal.failedReason = undefined;
        goal.updatedAt = Date.now();
        saveGoalsFile(memoryDir, data);

        return { output: `🔄 Retrying: "${goal.title}" (attempt ${retryCount}/${maxRetries})\n${goal.retryStrategy.length ? 'Context:\n' + goal.retryStrategy.map(s => `  - ${s}`).join('\n') : ''}` };
      }
      
      default:
        return { output: '', error: `Unknown action "${action}"` };
    }
  },
};

// ── Helper for heartbeat integration ───────────────────────────────────────

/** Get next goal to work on (for autonomous processing) */
export function getAutonomousGoal(memoryDir: string): Goal | null {
  const data = loadGoalsFile(memoryDir);
  return getNextGoal(data);
}

/** Check if auto-processing is enabled */
export function isAutoProcessEnabled(memoryDir: string): boolean {
  const data = loadGoalsFile(memoryDir);
  return data.settings.autoProcessDuringIdle;
}

/** Promote next pending goal to in_progress */
export function promoteNextGoal(memoryDir: string): Goal | null {
  const data = loadGoalsFile(memoryDir);
  const next = getNextGoal(data);
  if (!next) return null;
  
  next.status = 'in_progress';
  next.updatedAt = Date.now();
  saveGoalsFile(memoryDir, data);
  return next;
}

// ── Feature 2: Goal Chaining ──────────────────────────────────────────────

/** Get goals whose dependencies are now all completed after a goal was completed */
export function getUnblockedDependents(memoryDir: string): Goal[] {
  const data = loadGoalsFile(memoryDir);
  return data.goals.filter(g => {
    if (g.status !== 'pending') return false;
    if (!g.dependencies || g.dependencies.length === 0) return false;
    return g.dependencies.every(depId => {
      const dep = data.goals.find(d => d.id === depId);
      return dep?.status === 'completed';
    });
  });
}

/** Check and auto-complete decomposed parent goals whose children are all done */
export function checkDecomposedParents(memoryDir: string): Goal[] {
  const data = loadGoalsFile(memoryDir);
  const completed: Goal[] = [];
  
  for (const goal of data.goals) {
    if (goal.status !== 'decomposed') continue;
    const children = data.goals.filter(g => g.parentGoalId === goal.id);
    if (children.length === 0) continue;
    if (children.every(c => c.status === 'completed')) {
      goal.status = 'completed';
      goal.completedAt = Date.now();
      goal.updatedAt = Date.now();
      completed.push(goal);
    }
  }
  
  if (completed.length > 0) saveGoalsFile(memoryDir, data);
  return completed;
}

// ── Feature 1: Auto-approve suggested goals ───────────────────────────────

/** Auto-approve suggested goals that have been waiting longer than autoApproveAfterMs */
export function autoApproveSuggestedGoals(memoryDir: string): Goal[] {
  const data = loadGoalsFile(memoryDir);
  if (data.settings.autoApproveAfterMs < 0) return []; // -1 = never
  
  const now = Date.now();
  const threshold = data.settings.autoApproveAfterMs;
  const approved: Goal[] = [];
  
  for (const goal of data.goals) {
    if (goal.status !== 'suggested') continue;
    if (now - goal.createdAt >= threshold) {
      goal.status = 'pending';
      goal.updatedAt = now;
      approved.push(goal);
    }
  }
  
  if (approved.length > 0) saveGoalsFile(memoryDir, data);
  return approved;
}

// ── Feature 3: Adaptive Heartbeat Intervals ───────────────────────────────

/** Get the recommended heartbeat interval based on current goal state */
export function getAdaptiveInterval(memoryDir: string): number | null {
  const data = loadGoalsFile(memoryDir);
  if (!data.settings.adaptiveInterval.enabled) return null;
  
  const { activeMs, idleMs, criticalMs } = data.settings.adaptiveInterval;
  const activeGoals = data.goals.filter(g => g.status === 'in_progress' || g.status === 'pending');
  const criticalGoals = activeGoals.filter(g => g.priority === 'critical');
  
  if (criticalGoals.length > 0) return criticalMs;
  if (activeGoals.length > 0) return activeMs;
  return idleMs;
}

// ── Feature 5: Recurring Goals ────────────────────────────────────────────

/** Re-queue completed recurring goals that are past their interval */
export function requeueRecurringGoals(memoryDir: string): Goal[] {
  const data = loadGoalsFile(memoryDir);
  const now = Date.now();
  const requeued: Goal[] = [];
  
  for (const goal of data.goals) {
    if (!goal.recurring?.enabled) continue;
    if (goal.status !== 'completed') continue;
    
    const lastRun = goal.recurring.lastRunAt || goal.completedAt || goal.updatedAt;
    if (now - lastRun < goal.recurring.intervalMs) continue;
    
    // Create new instance of the recurring goal
    const newGoal: Goal = {
      id: generateGoalId(),
      title: goal.title,
      description: goal.description,
      status: 'pending',
      priority: goal.priority,
      createdAt: now,
      updatedAt: now,
      source: 'recurring',
      recurring: {
        enabled: true,
        intervalMs: goal.recurring.intervalMs,
        lastRunAt: now,
        templateGoalId: goal.recurring.templateGoalId || goal.id,
      },
    };
    
    // Update the completed goal's lastRunAt so it doesn't re-trigger
    goal.recurring.lastRunAt = now;
    
    data.goals.push(newGoal);
    requeued.push(newGoal);
  }
  
  if (requeued.length > 0) saveGoalsFile(memoryDir, data);
  return requeued;
}

// ── Feature 6: Failure Recovery & Retry ───────────────────────────────────

/** Get failed goals that are eligible for automatic retry */
export function getRetryableGoals(memoryDir: string): Goal[] {
  const data = loadGoalsFile(memoryDir);
  const now = Date.now();
  
  return data.goals.filter(g => {
    if (g.status !== 'failed') return false;
    const maxRetries = g.maxRetries ?? 3;
    if ((g.retryCount ?? 0) >= maxRetries) return false;
    
    // Check exponential backoff
    if (g.lastRetryAt) {
      const retryCount = g.retryCount ?? 0;
      const delay = Math.min(
        data.settings.retryBaseDelayMs * Math.pow(2, retryCount),
        data.settings.retryMaxDelayMs,
      );
      if (now - g.lastRetryAt < delay) return false;
    }
    
    return true;
  });
}

/** Auto-retry eligible failed goals */
export function autoRetryFailedGoals(memoryDir: string): Goal[] {
  const data = loadGoalsFile(memoryDir);
  const now = Date.now();
  const retried: Goal[] = [];
  
  for (const goal of data.goals) {
    if (goal.status !== 'failed') continue;
    const maxRetries = goal.maxRetries ?? 3;
    const retryCount = goal.retryCount ?? 0;
    if (retryCount >= maxRetries) continue;
    
    // Check exponential backoff
    if (goal.lastRetryAt) {
      const delay = Math.min(
        data.settings.retryBaseDelayMs * Math.pow(2, retryCount),
        data.settings.retryMaxDelayMs,
      );
      if (now - goal.lastRetryAt < delay) continue;
    }
    
    // Auto-retry
    if (!goal.retryStrategy) goal.retryStrategy = [];
    if (goal.failedReason) goal.retryStrategy.push(`Auto-retry attempt ${retryCount + 1}: previous failure: ${goal.failedReason}`);
    
    goal.status = 'pending';
    goal.retryCount = retryCount + 1;
    goal.lastRetryAt = now;
    goal.failedReason = undefined;
    goal.updatedAt = now;
    retried.push(goal);
  }
  
  if (retried.length > 0) saveGoalsFile(memoryDir, data);
  return retried;
}

// ── Feature 7: Priority Auto-Escalation ───────────────────────────────────

/** Escalate priorities of goals that have been pending too long */
export function escalateGoals(memoryDir: string): Goal[] {
  const data = loadGoalsFile(memoryDir);
  if (!data.settings.escalation.enabled) return [];
  
  const now = Date.now();
  const { lowToMediumMs, mediumToHighMs, highToCriticalMs } = data.settings.escalation;
  const escalated: Goal[] = [];
  
  for (const goal of data.goals) {
    if (goal.status !== 'pending') continue;
    const age = now - goal.createdAt;
    
    let newPriority: GoalPriority | null = null;
    if (goal.priority === 'low' && age >= lowToMediumMs) {
      newPriority = 'medium';
    } else if (goal.priority === 'medium' && age >= mediumToHighMs) {
      newPriority = 'high';
    } else if (goal.priority === 'high' && age >= highToCriticalMs) {
      newPriority = 'critical';
    }
    
    if (newPriority) {
      if (!goal.originalPriority) goal.originalPriority = goal.priority;
      goal.priority = newPriority;
      goal.updatedAt = now;
      escalated.push(goal);
    }
  }
  
  if (escalated.length > 0) saveGoalsFile(memoryDir, data);
  return escalated;
}

// ── Feature 8: Cross-Session Goal Summary ─────────────────────────────────

/** Get a brief summary of active goals for system prompt injection */
export function getGoalsSummary(memoryDir: string): string {
  const data = loadGoalsFile(memoryDir);
  const inProgress = data.goals.filter(g => g.status === 'in_progress');
  const pending = data.goals.filter(g => g.status === 'pending');
  const suggested = data.goals.filter(g => g.status === 'suggested');
  const failed = data.goals.filter(g => g.status === 'failed');
  const critical = data.goals.filter(g => g.priority === 'critical' && !['completed', 'failed'].includes(g.status));
  
  if (inProgress.length === 0 && pending.length === 0 && suggested.length === 0) return '';
  
  const parts: string[] = ['[Active Goals]'];
  if (critical.length > 0) parts.push(`🔥 ${critical.length} critical`);
  if (inProgress.length > 0) parts.push(`🟡 ${inProgress.length} in-progress: ${inProgress.map(g => g.title).join(', ')}`);
  if (pending.length > 0) parts.push(`🔴 ${pending.length} pending`);
  if (suggested.length > 0) parts.push(`💡 ${suggested.length} suggested`);
  if (failed.length > 0) parts.push(`⚫ ${failed.length} failed`);
  
  return parts.join(' | ');
}

// ── Feature 9: Daily Report ───────────────────────────────────────────────

/** Generate a daily report of goal activity */
export function generateDailyReport(memoryDir: string): string | null {
  const data = loadGoalsFile(memoryDir);
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  
  // Check if we should generate (hasn't been done today)
  if (!data.settings.dailyReport.enabled) return null;
  if (data.lastDailyReport && data.lastDailyReport >= todayMs) return null;
  
  const currentHour = new Date().getHours();
  if (currentHour < data.settings.dailyReport.timeHour) return null;
  
  // Generate report
  const completedToday = data.goals.filter(g => g.completedAt && g.completedAt >= todayMs);
  const failedToday = data.goals.filter(g => g.status === 'failed' && g.updatedAt >= todayMs);
  const inProgress = data.goals.filter(g => g.status === 'in_progress');
  const pending = data.goals.filter(g => g.status === 'pending');
  const suggested = data.goals.filter(g => g.status === 'suggested');
  const escalatedToday = data.goals.filter(g => g.originalPriority && g.updatedAt >= todayMs);
  const retriedToday = data.goals.filter(g => g.lastRetryAt && g.lastRetryAt >= todayMs);
  
  const dateStr = new Date().toISOString().split('T')[0];
  const lines: string[] = [
    `# Daily Goal Report — ${dateStr}`,
    '',
  ];
  
  if (completedToday.length > 0) {
    lines.push('## ✅ Completed Today');
    for (const g of completedToday) lines.push(`- ${g.title}`);
    lines.push('');
  }
  
  if (failedToday.length > 0) {
    lines.push('## ⚫ Failed Today');
    for (const g of failedToday) lines.push(`- ${g.title}: ${g.failedReason || 'no reason'}`);
    lines.push('');
  }
  
  if (inProgress.length > 0) {
    lines.push('## 🟡 In Progress');
    for (const g of inProgress) lines.push(`- ${g.title} (${g.priority})`);
    lines.push('');
  }
  
  if (pending.length > 0) {
    lines.push('## 🔴 Pending');
    lines.push(`${pending.length} goal(s) waiting.`);
    lines.push('');
  }
  
  if (suggested.length > 0) {
    lines.push('## 💡 Suggested');
    lines.push(`${suggested.length} suggested goal(s) awaiting approval.`);
    lines.push('');
  }
  
  if (escalatedToday.length > 0) {
    lines.push('## ⬆️ Escalated Today');
    for (const g of escalatedToday) lines.push(`- ${g.title}: ${g.originalPriority} → ${g.priority}`);
    lines.push('');
  }
  
  if (retriedToday.length > 0) {
    lines.push('## 🔄 Retried Today');
    for (const g of retriedToday) lines.push(`- ${g.title} (attempt ${g.retryCount}/${g.maxRetries ?? 3})`);
    lines.push('');
  }
  
  // Summary stats
  lines.push('## 📊 Summary');
  lines.push(`- Completed today: ${completedToday.length}`);
  lines.push(`- Failed today: ${failedToday.length}`);
  lines.push(`- Active (in progress): ${inProgress.length}`);
  lines.push(`- Pending: ${pending.length}`);
  lines.push(`- Total goals: ${data.goals.length}`);
  lines.push('');
  lines.push(`_Generated at ${new Date().toISOString()}_`);
  
  const report = lines.join('\n');
  
  // Save report to reports directory
  try {
    const reportsDir = join(memoryDir, 'reports');
    if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
    writeFileSync(join(reportsDir, `${dateStr}.md`), report);
  } catch {}
  
  // Update last report timestamp
  data.lastDailyReport = now;
  saveGoalsFile(memoryDir, data);
  
  return report;
}

// ── Export ────────────────────────────────────────────────────────────────

export { goalsTool };
export const goalsTools = [goalsTool];
