/**
 * Autonomy Tools — Self-evaluation, Self-testing, and Metacognition
 *
 * These tools enable the agent to:
 * 1. Evaluate its own task outcomes (success/failure, lessons learned)
 * 2. Test and validate generated code, skills, and plugins
 * 3. Reflect on its own thinking process (metacognition)
 */

import type { Tool } from '../tool-registry.js';
import type { MemoryManager } from '../../memory/manager.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let memoryManagerRef: MemoryManager | null = null;

export function setAutonomyMemoryManager(mm: MemoryManager): void {
  memoryManagerRef = mm;
}

// ═══════════════════════════════════════════════════════════════════════════
// SELF-EVALUATION TOOL
// ═══════════════════════════════════════════════════════════════════════════

export interface TaskOutcome {
  id: string;
  timestamp: number;
  task: string;
  success: boolean;
  confidence: number;        // 0.0 - 1.0
  lessons: string[];         // What was learned
  improvements: string[];    // How to do better next time
  filesModified?: string[];
  toolsUsed: string[];
  duration?: number;         // milliseconds
  goalId?: string;           // Link to goals system
  sessionId?: string;
}

interface OutcomesFile {
  version: number;
  outcomes: TaskOutcome[];
  patterns: {
    lesson: string;
    frequency: number;
    lastSeen: number;
  }[];
}

function loadOutcomes(memoryDir: string): OutcomesFile {
  const path = join(memoryDir, 'outcomes.json');
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      return {
        version: data.version || 1,
        outcomes: data.outcomes || [],
        patterns: data.patterns || [],
      };
    }
  } catch (err) {
    console.error('[autonomy] Failed to load outcomes:', (err as Error).message);
  }
  return { version: 1, outcomes: [], patterns: [] };
}

function saveOutcomes(memoryDir: string, data: OutcomesFile): void {
  const path = join(memoryDir, 'outcomes.json');
  // Keep last 500 outcomes
  data.outcomes = data.outcomes.slice(-500);
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function extractPatterns(data: OutcomesFile): void {
  const lessonCounts = new Map<string, { count: number; lastSeen: number }>();
  
  for (const outcome of data.outcomes) {
    for (const lesson of outcome.lessons) {
      const key = lesson.toLowerCase().slice(0, 100);
      const existing = lessonCounts.get(key) || { count: 0, lastSeen: 0 };
      lessonCounts.set(key, {
        count: existing.count + 1,
        lastSeen: outcome.timestamp,
      });
    }
  }
  
  data.patterns = Array.from(lessonCounts.entries())
    .filter(([_, v]) => v.count >= 2)
    .map(([lesson, v]) => ({
      lesson: lesson.slice(0, 200),
      frequency: v.count,
      lastSeen: v.lastSeen,
    }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 50);
}

const selfEvalTool: Tool = {
  name: 'self-eval',
  description: [
    'Self-evaluation for reflecting on completed tasks. Tracks outcomes and patterns.',
    'Actions: record (task outcome with lessons/confidence), list, patterns, stats, search.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: record|list|patterns|stats|search' },
      task: { type: 'string', description: 'Task description (for record)' },
      success: { type: 'boolean', description: 'Was task successful? (for record)' },
      confidence: { type: 'number', description: 'Confidence 0.0-1.0 (for record)' },
      lessons: { type: 'array', items: { type: 'string' }, description: 'Lessons learned' },
      improvements: { type: 'array', items: { type: 'string' }, description: 'Improvement suggestions' },
      files: { type: 'array', items: { type: 'string' }, description: 'Files modified' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Tools used' },
      duration: { type: 'number', description: 'Task duration in ms' },
      goalId: { type: 'string', description: 'Linked goal ID' },
      query: { type: 'string', description: 'Search query (for search)' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
    required: ['action'],
  },
  async execute(params) {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    
    const memoryDir = memoryManagerRef.getDirectory();
    const data = loadOutcomes(memoryDir);
    const action = params.action as string;
    
    switch (action) {
      case 'record': {
        const task = params.task as string;
        if (!task) return { output: '', error: 'task is required for record' };
        
        const success = typeof params.success === 'boolean' ? params.success : true;
        const confidence = typeof params.confidence === 'number' ? params.confidence : 0.8;
        
        const outcome: TaskOutcome = {
          id: `outcome_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: Date.now(),
          task,
          success,
          confidence,
          lessons: (params.lessons as string[]) || [],
          improvements: (params.improvements as string[]) || [],
          filesModified: params.files as string[],
          toolsUsed: (params.tools as string[]) || [],
          duration: params.duration as number | undefined,
          goalId: params.goalId as string | undefined,
        };
        
        data.outcomes.push(outcome);
        extractPatterns(data);
        saveOutcomes(memoryDir, data);
        
        // Also log to daily log
        const logEntry = `## Self-Evaluation\n**Task**: ${task}\n**Success**: ${outcome.success ? '✅' : '❌'}\n**Confidence**: ${(outcome.confidence * 100).toFixed(0)}%\n${outcome.lessons.length > 0 ? `**Lessons**:\n${outcome.lessons.map(l => `- ${l}`).join('\n')}` : ''}`;
        memoryManagerRef.appendDailyLog(logEntry);
        
        return { output: `Recorded outcome: "${task.slice(0, 50)}..."\nSuccess: ${outcome.success ? '✅' : '❌'} | Confidence: ${(outcome.confidence * 100).toFixed(0)}%\nLessons: ${outcome.lessons.length} | Improvements: ${outcome.improvements.length}` };
      }
      
      case 'list': {
        const limit = (params.limit as number) || 10;
        const recent = data.outcomes.slice(-limit).reverse();
        
        if (recent.length === 0) {
          return { output: 'No outcomes recorded yet. Use `self_eval action=record` to record one.' };
        }
        
        const lines = recent.map(o => {
          const status = o.success ? '✅' : '❌';
          const conf = `${(o.confidence * 100).toFixed(0)}%`;
          const date = new Date(o.timestamp).toLocaleDateString();
          return `${status} [${conf}] ${o.task.slice(0, 60)}... (${date})`;
        });
        
        return { output: `Recent Outcomes (${recent.length}):\n` + lines.join('\n') };
      }
      
      case 'patterns': {
        if (data.patterns.length === 0) {
          return { output: 'No recurring patterns yet. Record more outcomes to identify patterns.' };
        }
        
        const lines = data.patterns.slice(0, 20).map(p => {
          const freq = p.frequency > 5 ? '🔥' : p.frequency > 2 ? '⬆️' : '➡️';
          return `${freq} (${p.frequency}x) ${p.lesson.slice(0, 80)}`;
        });
        
        return { output: `Recurring Lessons (${data.patterns.length}):\n` + lines.join('\n') };
      }
      
      case 'stats': {
        const total = data.outcomes.length;
        const successful = data.outcomes.filter(o => o.success).length;
        const avgConfidence = total > 0
          ? data.outcomes.reduce((sum, o) => sum + o.confidence, 0) / total
          : 0;
        const lessonsCount = data.outcomes.reduce((sum, o) => sum + o.lessons.length, 0);
        
        return { output: `Self-Evaluation Statistics:\n- Total Outcomes: ${total}\n- Success Rate: ${total > 0 ? ((successful / total) * 100).toFixed(1) : 0}%\n- Avg Confidence: ${(avgConfidence * 100).toFixed(1)}%\n- Lessons Recorded: ${lessonsCount}\n- Recurring Patterns: ${data.patterns.length}` };
      }
      
      case 'search': {
        const query = (params.query as string)?.toLowerCase();
        if (!query) return { output: '', error: 'query is required for search' };
        
        const matches = data.outcomes.filter(o =>
          o.task.toLowerCase().includes(query) ||
          o.lessons.some(l => l.toLowerCase().includes(query))
        ).slice(-20);
        
        if (matches.length === 0) {
          return { output: `No outcomes matching "${query}"` };
        }
        
        const lines = matches.map(o => {
          const status = o.success ? '✅' : '❌';
          return `${status} ${o.task.slice(0, 80)}`;
        });
        
        return { output: `Found ${matches.length} matching outcomes:\n` + lines.join('\n') };
      }
      
      default:
        return { output: '', error: `Unknown action "${action}"` };
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// SELF-TESTING TOOL
// ═══════════════════════════════════════════════════════════════════════════

const selfTestTool: Tool = {
      name: 'self-test',  description: [
    'Validate code, skills, plugins, and projects for common issues.',
    'Actions: file (check single file), project (test instructions), skill, plugin, report.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: file|project|skill|plugin|report' },
      path: { type: 'string', description: 'File/directory path to test' },
      skillName: { type: 'string', description: 'Skill name to validate' },
      pluginName: { type: 'string', description: 'Plugin name to validate' },
      command: { type: 'string', description: 'Custom test command (for project)' },
      fix: { type: 'boolean', description: 'Attempt to auto-fix issues' },
    },
    required: ['action'],
  },
  async execute(params, ctx) {
    const action = params.action as string;
    
    switch (action) {
      case 'file': {
        const path = params.path as string;
        if (!path) return { output: '', error: 'path is required for file' };
        
        const issues: string[] = [];
        const suggestions: string[] = [];
        
        // Check file extension
        const ext = path.split('.').pop()?.toLowerCase();
        
        // Basic validation based on file type
        if (['ts', 'tsx', 'js', 'jsx'].includes(ext || '')) {
          // JavaScript/TypeScript validation
          try {
            const content = readFileSync(path, 'utf-8');
            
            // Check for common issues
            if (content.includes('console.log') && !path.includes('test')) {
              issues.push('Contains console.log statements');
            }
            if (content.includes('TODO:') || content.includes('FIXME:')) {
              issues.push('Contains TODO/FIXME comments');
            }
            if (content.includes('any') && ext?.startsWith('ts')) {
              issues.push('Uses "any" type (consider stricter typing)');
            }
            if (!content.includes('export') && !content.includes('import')) {
              suggestions.push('File has no imports/exports — is it complete?');
            }
          } catch (err) {
            return { output: '', error: `Failed to read file: ${(err as Error).message}` };
          }
        }
        
        if (issues.length === 0 && suggestions.length === 0) {
          return { output: `✅ File "${path}" passed basic validation` };
        }
        
        let output = `File "${path}" validation:\n`;
        if (issues.length > 0) {
          output += `\n⚠️ Issues:\n${issues.map(i => `- ${i}`).join('\n')}`;
        }
        if (suggestions.length > 0) {
          output += `\n\n💡 Suggestions:\n${suggestions.map(s => `- ${s}`).join('\n')}`;
        }
        return { output };
      }
      
      case 'project': {
        const command = (params.command as string) || 'npm test';
        // This would need to spawn a shell process
        // For now, return instructions
        return { output: `To run project tests, use the bash tool:\n\`\`\`\n${command}\n\`\`\`\n\nFor TypeScript projects, also run:\n- \`npx tsc --noEmit\` (type check)\n- \`npm run lint\` (if available)` };
      }
      
      case 'skill': {
        const skillName = params.skillName as string;
        if (!skillName) return { output: '', error: 'skillName is required for skill' };
        
        const issues: string[] = [];
        
        // Would need to access the skills loader to validate
        // For now, provide guidance
        return { output: `Skill validation for "${skillName}":\n\nA valid skill should:\n- Have a SKILL.md file\n- Include a clear description\n- List any requirements (bins, env)\n- Be properly formatted in markdown\n\nCheck the skill file manually or use \`read_file\` to view it.` };
      }
      
      case 'plugin': {
        const pluginName = params.pluginName as string;
        if (!pluginName) return { output: '', error: 'pluginName is required for plugin' };
        
        return { output: `Plugin validation for "${pluginName}":\n\nA valid plugin should:\n- Have an index.ts or index.js entry point\n- Export the correct plugin interface\n- Include proper error handling\n- Not throw uncaught exceptions\n\nUse \`read_file\` to inspect the plugin code.` };
      }
      
      case 'report': {
        return { output: `Test Report Summary:\n\nTo generate a full report:\n1. Run \`npm test\` or your test command\n2. Run \`npx tsc --noEmit\` for TypeScript\n3. Run \`npm run lint\` if available\n4. Use \`self_eval action=list\` to see recent task outcomes` };
      }
      
      default:
        return { output: '', error: `Unknown action "${action}"` };
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// METACOGNITION TOOL
// ═══════════════════════════════════════════════════════════════════════════

export interface MetacognitionState {
  currentFocus?: string;
  uncertainty: number;          // 0.0 - 1.0
  neededInfo: string[];
  alternativeApproaches: string[];
  shouldEscalate: boolean;
  escalateReason?: string;
  confidenceInPlan: number;     // 0.0 - 1.0
  lastReflection: number;
}

interface MetacognitionFile {
  version: number;
  current?: MetacognitionState;
  history: {
    timestamp: number;
    state: MetacognitionState;
    action: string;
  }[];
}

function loadMetacognition(memoryDir: string): MetacognitionFile {
  const path = join(memoryDir, 'metacognition.json');
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      return {
        version: data.version || 1,
        current: data.current,
        history: data.history || [],
      };
    }
  } catch (err) {
    console.error('[autonomy] Failed to load metacognition:', (err as Error).message);
  }
  return { version: 1, history: [] };
}

function saveMetacognition(memoryDir: string, data: MetacognitionFile): void {
  const path = join(memoryDir, 'metacognition.json');
  data.history = data.history.slice(-100); // Keep last 100
  writeFileSync(path, JSON.stringify(data, null, 2));
}

const metacognitionTool: Tool = {
      name: 'metacognition',  description: [
    'Reflect on your own thinking and decision-making process.',
    'Actions: assess (focus/uncertainty/confidence), uncertain, confident, escalate, alternatives, status, history.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: assess|uncertain|confident|escalate|alternatives|status|history' },
      focus: { type: 'string', description: 'Current focus/task' },
      uncertainty: { type: 'number', description: 'Uncertainty level 0.0-1.0' },
      neededInfo: { type: 'array', items: { type: 'string' }, description: 'Information needed' },
      alternatives: { type: 'array', items: { type: 'string' }, description: 'Alternative approaches' },
      reason: { type: 'string', description: 'Reason for escalation' },
      confidence: { type: 'number', description: 'Confidence in current plan 0.0-1.0' },
    },
    required: ['action'],
  },
  async execute(params) {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    
    const memoryDir = memoryManagerRef.getDirectory();
    const data = loadMetacognition(memoryDir);
    const action = params.action as string;
    const now = Date.now();
    
    switch (action) {
      case 'assess': {
        const state: MetacognitionState = {
          currentFocus: params.focus as string,
          uncertainty: (params.uncertainty as number) ?? 0.5,
          neededInfo: (params.neededInfo as string[]) || [],
          alternativeApproaches: [],
          shouldEscalate: false,
          confidenceInPlan: (params.confidence as number) ?? 0.7,
          lastReflection: now,
        };
        
        data.current = state;
        data.history.push({ timestamp: now, state, action: 'assess' });
        saveMetacognition(memoryDir, data);
        
        const focusStr = state.currentFocus ? `"${state.currentFocus.slice(0, 60)}"` : 'Not specified';
        const uncStr = state.uncertainty > 0.7 ? '⚠️ HIGH' : state.uncertainty > 0.4 ? '⚡ MEDIUM' : '✅ LOW';
        const confStr = `${(state.confidenceInPlan * 100).toFixed(0)}%`;
        
        let output = `Metacognitive Assessment:\n`;
        output += `- Focus: ${focusStr}\n`;
        output += `- Uncertainty: ${uncStr} (${(state.uncertainty * 100).toFixed(0)}%)\n`;
        output += `- Confidence: ${confStr}\n`;
        
        if (state.neededInfo.length > 0) {
          output += `- Needed Info:\n${state.neededInfo.map(i => `  - ${i}`).join('\n')}\n`;
        }
        
        if (state.uncertainty > 0.7 || state.confidenceInPlan < 0.5) {
          output += `\n💡 Consider: gathering more information or asking for clarification.`;
        }
        
        return { output };
      }
      
      case 'uncertain': {
        const needed = (params.neededInfo as string[]) || [];
        const state: MetacognitionState = {
          currentFocus: data.current?.currentFocus,
          uncertainty: 0.8,
          neededInfo: needed,
          alternativeApproaches: [],
          shouldEscalate: false,
          confidenceInPlan: 0.4,
          lastReflection: now,
        };
        
        data.current = state;
        data.history.push({ timestamp: now, state, action: 'uncertain' });
        saveMetacognition(memoryDir, data);
        
        if (needed.length > 0) {
          return { output: `⚠️ Marked as uncertain.\n\nNeeded information:\n${needed.map(i => `- ${i}`).join('\n')}\n\nConsider: asking the user, searching the web, or reading relevant files.` };
        }
        return { output: `⚠️ Marked as uncertain. Consider gathering more information before proceeding.` };
      }
      
      case 'confident': {
        const conf = (params.confidence as number) ?? 0.9;
        const state: MetacognitionState = {
          currentFocus: data.current?.currentFocus,
          uncertainty: 0.2,
          neededInfo: [],
          alternativeApproaches: [],
          shouldEscalate: false,
          confidenceInPlan: conf,
          lastReflection: now,
        };
        
        data.current = state;
        data.history.push({ timestamp: now, state, action: 'confident' });
        saveMetacognition(memoryDir, data);
        
        return { output: `✅ Confidence recorded: ${(conf * 100).toFixed(0)}%\n\nProceeding with high confidence in the current approach.` };
      }
      
      case 'escalate': {
        const reason = params.reason as string;
        const state: MetacognitionState = {
          currentFocus: data.current?.currentFocus,
          uncertainty: 0.9,
          neededInfo: data.current?.neededInfo || [],
          alternativeApproaches: [],
          shouldEscalate: true,
          escalateReason: reason,
          confidenceInPlan: 0.2,
          lastReflection: now,
        };
        
        data.current = state;
        data.history.push({ timestamp: now, state, action: 'escalate' });
        saveMetacognition(memoryDir, data);
        
        // Log escalation
        const logEntry = `## ⚠️ Escalation\n**Reason**: ${reason || 'Not specified'}\n**Focus**: ${state.currentFocus || 'Unknown'}`;
        memoryManagerRef.appendDailyLog(logEntry);
        
        return { output: `🚨 Escalation flagged.\n\nReason: ${reason || 'Not specified'}\n\nThis task should be reviewed by the user or requires additional input before proceeding.\n\nConsider:\n- Asking the user for clarification\n- Breaking the task into smaller parts\n- Using a different approach` };
      }
      
      case 'alternatives': {
        const alts = (params.alternatives as string[]) || [];
        if (alts.length === 0) {
          return { output: 'Please provide alternatives to consider:\n`reflect action=alternatives alternatives=["approach 1", "approach 2"]`' };
        }
        
        const state: MetacognitionState = {
          ...data.current,
          alternativeApproaches: alts,
          lastReflection: now,
        } as MetacognitionState;
        
        data.current = state;
        data.history.push({ timestamp: now, state, action: 'alternatives' });
        saveMetacognition(memoryDir, data);
        
        return { output: `Alternative approaches to consider:\n${alts.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nEvaluate each before deciding on the best path forward.` };
      }
      
      case 'status': {
        if (!data.current) {
          return { output: 'No current metacognitive state. Use `reflect action=assess` to create one.' };
        }
        
        const s = data.current;
        const lines: string[] = ['Current Metacognitive State:'];
        lines.push(`- Focus: ${s.currentFocus || 'Not set'}`);
        lines.push(`- Uncertainty: ${(s.uncertainty * 100).toFixed(0)}% ${s.uncertainty > 0.7 ? '⚠️' : ''}`);
        lines.push(`- Confidence: ${(s.confidenceInPlan * 100).toFixed(0)}%`);
        lines.push(`- Should Escalate: ${s.shouldEscalate ? '🚨 YES' : '✅ No'}`);
        
        if (s.neededInfo.length > 0) {
          lines.push(`- Needed Info: ${s.neededInfo.join(', ')}`);
        }
        if (s.alternativeApproaches.length > 0) {
          lines.push(`- Alternatives: ${s.alternativeApproaches.length} options`);
        }
        if (s.escalateReason) {
          lines.push(`- Escalation Reason: ${s.escalateReason}`);
        }
        
        lines.push(`- Last Reflection: ${new Date(s.lastReflection).toLocaleString()}`);
        
        return { output: lines.join('\n') };
      }
      
      case 'history': {
        const recent = data.history.slice(-10).reverse();
        if (recent.length === 0) {
          return { output: 'No reflection history yet.' };
        }
        
        const lines = recent.map(h => {
          const time = new Date(h.timestamp).toLocaleTimeString();
          const unc = `${(h.state.uncertainty * 100).toFixed(0)}%`;
          return `[${time}] ${h.action}: uncertainty=${unc}`;
        });
        
        return { output: `Recent Reflections:\n${lines.join('\n')}` };
      }
      
      default:
        return { output: '', error: `Unknown action "${action}"` };
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// PROPOSE GOALS TOOL
// ═══════════════════════════════════════════════════════════════════════════

const proposeGoalsTool: Tool = {
  name: 'propose_goals',
  description: [
    'Analyze patterns and suggest new goals from past outcomes, memory files, and observations.',
    'Actions: suggest/from_patterns (from learned patterns), from_memory (scan for TODOs/action items), add_suggested (promote to active goal).',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: suggest|from_patterns|from_memory|add_suggested' },
      goalIndex: { type: 'number', description: 'Index of suggested goal to add (for add_suggested)' },
      priority: { type: 'string', description: 'Priority override for add_suggested: critical|high|medium|low' },
    },
    required: ['action'],
  },
  async execute(params) {
    if (!memoryManagerRef) return { output: '', error: 'Memory manager not available' };
    
    const memoryDir = memoryManagerRef.getDirectory();
    const data = loadOutcomes(memoryDir);
    const action = params.action as string;
    
    // Store suggestions in memory for add_suggested
    const suggestionsPath = join(memoryDir, 'goal-suggestions.json');
    
    switch (action) {
      case 'suggest':
      case 'from_patterns': {
        const suggestions: { title: string; description: string; reason: string; priority: string }[] = [];
        
        // Extract from recurring patterns (lessons that appear multiple times)
        for (const pattern of data.patterns) {
          if (pattern.frequency >= 2) {
            // This is a recurring issue - suggest fixing it
            suggestions.push({
              title: `Address recurring issue: ${pattern.lesson.slice(0, 50)}`,
              description: `This pattern has appeared ${pattern.frequency} times in task outcomes. Consider creating a systematic solution.`,
              reason: 'Recurring pattern from self-evaluations',
              priority: pattern.frequency >= 4 ? 'high' : 'medium',
            });
          }
        }
        
        // Extract from failed tasks
        const recentFailures = data.outcomes
          .filter(o => !o.success)
          .slice(-5);
        
        for (const failure of recentFailures) {
          suggestions.push({
            title: `Retry/fix: ${failure.task.slice(0, 50)}`,
            description: `Previously failed task. Lessons: ${failure.lessons.join('; ') || 'none recorded'}`,
            reason: 'Previously failed task',
            priority: 'high',
          });
        }
        
        // Extract from low-confidence successes
        const lowConfidence = data.outcomes
          .filter(o => o.success && o.confidence < 0.7)
          .slice(-3);
        
        for (const outcome of lowConfidence) {
          suggestions.push({
            title: `Improve: ${outcome.task.slice(0, 50)}`,
            description: `Completed with low confidence (${(outcome.confidence * 100).toFixed(0)}%). Improvements: ${outcome.improvements.join('; ') || 'review needed'}`,
            reason: 'Low confidence completion',
            priority: 'medium',
          });
        }
        
        if (suggestions.length === 0) {
          return { output: 'No goal suggestions found. Keep recording task outcomes with `self_eval` to enable pattern-based suggestions.' };
        }
        
        // Store suggestions for add_suggested
        writeFileSync(suggestionsPath, JSON.stringify(suggestions, null, 2));
        
        const lines = suggestions.map((s, i) => {
          const priorityEmoji = { critical: '🔥', high: '⬆️', medium: '➡️', low: '⬇️' };
          return `${i}. ${priorityEmoji[s.priority as keyof typeof priorityEmoji] || '➡️'} **${s.title}**\n   _${s.reason}_`;
        });
        
        return { output: `Goal Suggestions (${suggestions.length}):\n` + lines.join('\n') + '\n\nAdd one with: `propose_goals action=add_suggested goalIndex=0`' };
      }
      
      case 'from_memory': {
        const memory = memoryManagerRef.getMemory();
        const user = memoryManagerRef.getIdentityFile('USER.md');
        const suggestions: { title: string; description: string; reason: string; priority: string }[] = [];
        
        // Look for action items in memory
        const actionPatterns = [
          /(?:TODO|FIXME|XXX|HACK|BUG):\s*(.+)/gi,
          /(?:need to|should|must|have to)\s+(.+)/gi,
          /(?:remember to|don't forget to)\s+(.+)/gi,
        ];
        
        const fullContent = `${memory}\n${user || ''}`;
        for (const pattern of actionPatterns) {
          let match;
          while ((match = pattern.exec(fullContent)) !== null) {
            suggestions.push({
              title: match[1].slice(0, 60),
              description: `Found in memory files: "${match[0]}"`,
              reason: 'Action item found in memory',
              priority: 'medium',
            });
          }
        }
        
        if (suggestions.length === 0) {
          return { output: 'No action items found in memory files. Add TODOs or action items to MEMORY.md or USER.md to enable detection.' };
        }
        
        // Dedupe and store
        const unique = suggestions.filter((s, i, arr) => 
          arr.findIndex(x => x.title === s.title) === i
        ).slice(0, 10);
        
        writeFileSync(suggestionsPath, JSON.stringify(unique, null, 2));
        
        const lines = unique.map((s, i) => `${i}. **${s.title}**\n   _${s.reason}_`);
        return { output: `Action Items Found (${unique.length}):\n` + lines.join('\n') + '\n\nAdd one with: `propose_goals action=add_suggested goalIndex=0`' };
      }
      
      case 'add_suggested': {
        const idx = params.goalIndex as number;
        if (typeof idx !== 'number') return { output: '', error: 'goalIndex is required for add_suggested' };
        
        let suggestions: { title: string; description: string; reason: string; priority: string }[] = [];
        try {
          if (existsSync(suggestionsPath)) {
            suggestions = JSON.parse(readFileSync(suggestionsPath, 'utf-8'));
          }
        } catch {}
        
        if (idx < 0 || idx >= suggestions.length) {
          return { output: '', error: `Invalid goalIndex ${idx}. Valid range: 0-${suggestions.length - 1}` };
        }
        
        const goal = suggestions[idx];
        
        // Import goals tool to add the goal
        const { goalsTool } = await import('./goals.js');
        const result = await goalsTool.execute({
          action: 'add',
          title: goal.title,
          description: goal.description,
          priority: params.priority || goal.priority,
        }, { sessionId: 'autonomous', workdir: process.cwd() });
        
        if (result.error) {
          return { output: '', error: result.error };
        }
        
        // Remove from suggestions
        suggestions.splice(idx, 1);
        writeFileSync(suggestionsPath, JSON.stringify(suggestions, null, 2));
        
        return { output: `✅ Added goal: "${goal.title}"\n\n${result.output}` };
      }
      
      default:
        return { output: '', error: `Unknown action "${action}"` };
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export { selfEvalTool, selfTestTool, metacognitionTool, proposeGoalsTool };
export const autonomyTools = [selfEvalTool, selfTestTool, metacognitionTool, proposeGoalsTool];

/** Get learned patterns for injection into system prompt */
export function getLearnedPatterns(memoryDir: string): string[] {
  const data = loadOutcomes(memoryDir);
  return data.patterns.slice(0, 10).map(p => p.lesson);
}

/** Get current metacognitive state */
export function getCurrentMetacognition(memoryDir: string): MetacognitionState | null {
  const data = loadMetacognition(memoryDir);
  return data.current || null;
}
