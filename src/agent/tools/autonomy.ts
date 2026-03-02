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
    'Self-evaluation tool for reflecting on completed tasks and learning from experience.',
    'Record outcomes, lessons learned, and improvement suggestions.',
    'The system tracks patterns across evaluations for continuous improvement.',
    '',
    'WHEN TO USE:',
    '- After completing a significant task or project',
    '- When you notice recurring mistakes or problems',
    '- To track your success rate and build confidence over time',
    '- To identify areas where you need improvement',
    '- To capture lessons learned for future reference',
    '- When you want to analyze your performance patterns',
    '',
    'ACTIONS:',
    '',
    'record: Record a task outcome with detailed information',
    '  Parameters: task, success, confidence, lessons, improvements, files, tools, duration, goalId',
    '  Side effect: Automatically logs summary to today\'s daily log',
    '  Example: { "action": "record", "task": "Fixed the API issue", "success": true, "confidence": 0.8, "lessons": ["Always check logs first", "Use the memory tool for debugging"] }',
    '',
    'list: List recent task outcomes',
    '  Parameters: limit (number, default 10)',
    '  Returns: Recent outcomes with success status and confidence',
    '  Example: { "action": "list", "limit": 5 }',
    '',
    'patterns: Show recurring lessons learned (patterns)',
    '  Parameters: none',
    '  Returns: Common issues or lessons that appear across multiple tasks',
    '  Example: { "action": "patterns" }',
    '',
    'stats: Show evaluation statistics',
    '  Parameters: none',
    '  Returns: Success rate, average confidence, total outcomes, and pattern counts',
    '  Example: { "action": "stats" }',
    '',
    'search: Search outcomes by keyword',
    '  Parameters: query, limit (number, default 10)',
    '  Returns: Outcomes matching the search query',
    '  Example: { "action": "search", "query": "debugging" }',
    '',
    'HOW TO USE:',
    '- Use record action to document task completion and reflect on the process',
    '- Rate success and confidence to track performance over time',
    '- Include specific lessons and improvements for future reference',
    '- Use patterns to identify recurring issues needing attention',
    '- Use stats to understand overall performance trends',
    '- Use search to find similar past tasks',
    '',
    'BENEFITS:',
    '- Builds a repository of lessons learned',
    '- Identifies recurring patterns in work',
    '- Tracks improvement over time',
    '- Helps avoid repeating the same mistakes',
    '- Provides data for better decision making',
    '- Contributes to system prompt with learned patterns',
    '',
    'SAFETY NOTES:',
    '- Records are kept for 500 most recent outcomes',
    '- Patterns are extracted from lessons that appear multiple times',
    '- All records contribute to learned patterns in system prompt',
    '- Use honestly for best results',
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
    'Self-testing and validation tool for code, skills, plugins, and projects.',
    'Run tests, validate syntax, and check for common issues to ensure quality.',
    '',
    'WHEN TO USE:',
    '- Before committing changes to code',
    '- After modifying skill files',
    '- When creating or updating plugins',
    '- When you want to validate file syntax',
    '- As part of a quality assurance process',
    '- To check for common mistakes or issues',
    '- Before and after making significant changes',
    '',
    'ACTIONS:',
    '',
    'file: Validate a single file for common issues',
    '  Parameters: path (required)',
    '  Checks: Console logs, TODO/FIXME comments, type issues (for TS), imports/exports',
    '  Example: { "action": "file", "path": "src/utils.ts" }',
    '',
    'project: Generate instructions for project-wide testing',
    '  Parameters: command (optional, default "npm test")',
    '  Returns: Guidance on how to run project tests, type checking, and linting',
    '  Example: { "action": "project", "command": "npm run test:unit" }',
    '',
    'skill: Validate a skill for correctness',
    '  Parameters: skillName (required)',
    '  Checks: Proper formatting, requirements, and structure of skill files',
    '  Example: { "action": "skill", "skillName": "web-scraper" }',
    '',
    'plugin: Validate a plugin for common issues',
    '  Parameters: pluginName (required)',
    '  Checks: Entry point, interface compliance, error handling',
    '  Example: { "action": "plugin", "pluginName": "my-custom-plugin" }',
    '',
    'report: Generate a test report summary',
    '  Parameters: none',
    '  Returns: Instructions for generating comprehensive test reports',
    '  Example: { "action": "report" }',
    '',
    'HOW TO USE:',
    '- Use file action to check specific files for common issues',
    '- Use project action to get instructions for comprehensive project testing',
    '- Use skill action to validate custom skills before using them',
    '- Use plugin action to validate plugins before activation',
    '- Use report action to understand how to get overall test coverage',
    '',
    'VALIDATION CHECKS:',
    '- JavaScript/TypeScript: Console logs, TODOs, type issues, import/export structure',
    '- Skills: Proper markdown format, requirements, clear descriptions',
    '- Plugins: Proper interface, error handling, entry points',
    '- General: Common patterns that indicate issues',
    '',
    'SAFETY NOTES:',
    '- Does not modify files, only checks them',
    '- Provides guidance rather than executing potentially destructive commands',
    '- Focuses on common issues that could cause problems',
    '- Encourages proactive quality assurance',
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
    'Metacognition tool for thinking about your own thinking and decision-making process.',
    'Use this to assess uncertainty, identify missing information, consider alternatives, and plan better.',
    '',
    'WHEN TO USE:',
    '- When you\'re unsure about the best approach to a task',
    '- When you need information that you don\'t currently have',
    '- When a task is complex and requires careful planning',
    '- When you want to consider multiple approaches before acting',
    '- When you feel uncertain about your current path',
    '- When you need to escalate to the user for input',
    '- When you want to reflect on your current focus and confidence',
    '',
    'ACTIONS:',
    '',
    'assess: Perform a comprehensive assessment of current state',
    '  Parameters: focus, uncertainty (0.0-1.0), neededInfo, confidence (0.0-1.0)',
    '  Records current focus, uncertainty level, needed information, and confidence',
    '  Example: { "action": "assess", "focus": "Debugging the API issue", "uncertainty": 0.6, "neededInfo": ["API logs", "recent changes"] }',
    '',
    'uncertain: Mark that you need more information',
    '  Parameters: neededInfo (array)',
    '  Sets high uncertainty and low confidence, records needed information',
    '  Example: { "action": "uncertain", "neededInfo": ["Database schema", "API documentation"] }',
    '',
    'confident: Mark that you have high confidence in your approach',
    '  Parameters: confidence (0.0-1.0)',
    '  Sets low uncertainty and records high confidence level',
    '  Example: { "action": "confident", "confidence": 0.9 }',
    '',
    'escalate: Flag that this task needs user input or escalation',
    '  Parameters: reason',
    '  Sets shouldEscalate flag and records the reason',
    '  Example: { "action": "escalate", "reason": "Need user decision on architecture change" }',
    '',
    'alternatives: Consider and record alternative approaches',
    '  Parameters: alternatives (array)',
    '  Records multiple approaches for consideration',
    '  Example: { "action": "alternatives", "alternatives": ["Refactor existing code", "Write new module", "Use third-party library"] }',
    '',
    'status: Show current metacognitive state',
    '  Parameters: none',
    '  Returns current focus, uncertainty, confidence, escalation status, and other state',
    '  Example: { "action": "status" }',
    '',
    'history: Show recent metacognitive reflections',
    '  Parameters: none',
    '  Returns the last 10 reflection events with timestamps',
    '  Example: { "action": "history" }',
    '',
    'METACOGNITIVE STATES:',
    '- Uncertainty level: 0.0-1.0 scale (0.0 = completely certain, 1.0 = completely uncertain)',
    '- Confidence level: 0.0-1.0 scale (0.0 = no confidence, 1.0 = complete confidence)',
    '- Escalation needed: Indicates when user input is required',
    '- Focus: Current task or objective',
    '- Needed information: Specific data or knowledge gaps',
    '',
    'HOW TO USE:',
    '- Use assess for general state evaluation',
    '- Use uncertain when you encounter knowledge gaps',
    '- Use confident after successful approach validation',
    '- Use escalate for decisions requiring user input',
    '- Use alternatives to explore multiple solutions',
    '- Use status to check current state',
    '- Use history to review past reflections',
    '',
    'BENEFITS:',
    '- Improves decision-making by acknowledging uncertainty',
    '- Identifies knowledge gaps that need filling',
    '- Tracks confidence levels over time',
    '- Flags when escalation to user is needed',
    '- Records alternative approaches for future reference',
    '- Contributes to system prompt with current focus information',
    '',
    'SAFETY NOTES:',
    '- Maintains last 100 reflection history entries',
    '- State contributes to system prompt for better context awareness',
    '- Escalation flags help prevent getting stuck on user-dependent decisions',
    '- Use honestly for best results',
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
    'Analyze patterns and suggest new goals based on past outcomes, user context, and observations.',
    'Use this to proactively identify things that should be done and enable autonomous goal creation.',
    '',
    'WHEN TO USE:',
    '- When you want to identify proactive tasks based on past patterns',
    '- To automatically generate goals from recurring issues',
    '- To find action items in memory files that should be addressed',
    '- When you want to be more autonomous and proactive',
    '- To identify tasks that keep failing and need systematic fixes',
    '- To discover TODOs and action items in memory files',
    '- To convert lessons learned into actionable goals',
    '',
    'ACTIONS:',
    '',
    'suggest/from_patterns: Generate goal suggestions from learned patterns',
    '  Parameters: none',
    '  Scans past outcomes for recurring lessons, failures, and low-confidence tasks',
    '  Returns: Goals based on recurring issues and past failures',
    '  Example: { "action": "suggest" }',
    '',
    'from_memory: Scan MEMORY.md and USER.md for implied tasks',
    '  Parameters: none',
    '  Searches for TODOs, FIXMEs, and action-oriented language in memory files',
    '  Returns: Goals based on explicit action items in memory',
    '  Example: { "action": "from_memory" }',
    '',
    'add_suggested: Add a suggested goal to the main goals system',
    '  Parameters: goalIndex (required), priority (optional)',
    '  Takes a goal from the last suggestions list and adds it to active goals',
    '  Example: { "action": "add_suggested", "goalIndex": 0, "priority": "high" }',
    '',
    'GOAL SUGGESTION CATEGORIES:',
    '- Recurring issues: Patterns that appear multiple times in self-evaluations',
    '- Failed tasks: Previously failed tasks that should be retried',
    '- Low-confidence completions: Tasks completed with low confidence that need improvement',
    '- Memory action items: TODOs, FIXMEs, and action-oriented statements in memory files',
    '- Systematic issues: Problems that need structural solutions rather than one-off fixes',
    '',
    'HOW TO USE:',
    '- Use suggest to generate proactive goals from learned patterns',
    '- Use from_memory to find explicit action items in memory files',
    '- Review suggestions and use add_suggested to convert promising ones to active goals',
    '- Prioritize goals based on impact and urgency',
    '- Use regularly to maintain proactive task pipeline',
    '',
    'BENEFITS:',
    '- Enables autonomous operation without constant user direction',
    '- Converts lessons learned into actionable improvements',
    '- Identifies systematic issues needing attention',
    '- Bridges the gap between passive task tracking and proactive work',
    '- Finds forgotten TODOs and action items in memory',
    '- Creates a pipeline of tasks that improve system quality over time',
    '',
    'SAFETY NOTES:',
    '- Stores up to 10 most recent suggestions in memory directory',
    '- Connects to main goals system to add suggested goals',
    '- Focuses on meaningful improvements rather than busy work',
    '- Uses past outcomes to identify genuine improvement opportunities',
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
