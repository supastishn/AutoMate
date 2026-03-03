import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import { LLMClient, type LLMMessage, type StreamChunk, type ContentPart } from './llm-client.js';
import { ToolRegistry, type ToolContext, type Tool, type SessionToolView, type ToolRegistryStats } from './tool-registry.js';
import { bashTool, bashTools, setBackgroundShellNotifier } from './tools/bash.js';
import { readFileTool, writeFileTool, editFileTool, applyPatchTool, listFilesTool, searchInFileTool } from './tools/files.js';
import { browserTools, setBrowserConfig, setBrowserImageBroadcaster } from './tools/browser.js';
import { sessionTools, setSessionManager, setAgent, getRecentSessionActivity } from './tools/sessions.js';
import { memoryTools, setMemoryManager } from './tools/memory.js';
import { webTools } from './tools/web.js';
import { imageTools, setImageConfig, setImageBroadcaster, setAddMessageToSession } from './tools/image.js';
import { cronTools, setScheduler } from './tools/cron.js';
import { processTools } from './tools/process.js';
import { mcpTools, setMCPConfig } from './tools/mcp.js';
import { canvasTools, setCanvasBroadcaster } from '../canvas/canvas-manager.js';
import { clawHubTools, setClawHubConfig } from '../clawhub/registry.js';
import { skillBuilderTools, setSkillBuilderConfig } from './tools/skill-builder.js';
import { subAgentTools, setSubAgentSpawner, setSubAgentNotifier, setSubAgentProfiles, isSubAgentFinished, consumeSubAgentFinish } from './tools/subagent.js';
import { skillTools, setSkillsLoader as setSkillToolLoader, getSessionSkillsInjection, autoLoadSessionSkills } from './tools/skills.js';
import { sharedMemoryTools, setSharedMemoryDir } from './tools/shared-memory.js';
import { pluginTools, setPluginManager, setPluginReloadCallback } from '../plugins/manager.js';
import { ttsTools, setTTSConfig } from './tools/tts.js';
import { gatewayTools, setGatewayControls } from './tools/gateway.js';
import { messageTools, setMessageAgent } from './tools/message.js';
import { agentsListTools, setAgentsRouter } from './tools/agents-list.js';
import { goalsTools, setGoalsMemoryManager, getGoalsSummary } from './tools/goals.js';
import { autonomyTools, setAutonomyMemoryManager, getLearnedPatterns, getCurrentMetacognition } from './tools/autonomy.js';
import { heartbeatTasksTools, setHeartbeatTasksManager } from './tools/heartbeat-tasks.js';
import type { PluginManager } from '../plugins/manager.js';
import type { PresenceManager } from '../gateway/presence.js';
import type { SessionManager } from '../gateway/session-manager.js';
import type { MemoryManager } from '../memory/manager.js';
import type { Scheduler } from '../cron/scheduler.js';
import type { SkillsLoader } from '../skills/loader.js';
import type { AgentRouter } from '../agents/router.js';

/** Helper to get text from content (handles both string and ContentPart[]) */
function getTextFromContent(content: string | ContentPart[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  // ContentPart[] - extract text parts
  return content
    .filter(part => part.type === 'text' && part.text)
    .map(part => part.text)
    .join(' ');
}

/** Build a structured runtime line (OpenClaw-style). */
function buildRuntimeLine(params: {
  sessionId?: string;
  model?: string;
  defaultModel?: string;
  os?: string;
  arch?: string;
  node?: string;
  shell?: string;
  elevated?: boolean;
  thinkingLevel?: string;
}): string {
  const parts: string[] = [];
  if (params.sessionId) parts.push(`session=${params.sessionId.slice(0, 8)}`);
  if (params.os) parts.push(`os=${params.os}${params.arch ? ` (${params.arch})` : ''}`);
  else if (params.arch) parts.push(`arch=${params.arch}`);
  if (params.node) parts.push(`node=${params.node}`);
  if (params.model) parts.push(`model=${params.model}`);
  if (params.defaultModel && params.defaultModel !== params.model) {
    parts.push(`default_model=${params.defaultModel}`);
  }
  if (params.shell) parts.push(`shell=${params.shell}`);
  if (params.elevated !== undefined) parts.push(`elevated=${params.elevated}`);
  parts.push(`thinking=${params.thinkingLevel ?? 'off'}`);
  return `Runtime: ${parts.join(' | ')}`;
}

export interface AgentResponse {
  content: string;
  toolCalls: { name: string; result: string; arguments?: string }[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export type StreamCallback = (chunk: string) => void;
export type ToolCallCallback = (toolCall: { name: string; arguments?: string; result: string }) => void;

/** Default instructions injected into every compaction (manual /compact and auto-compact). */
const COMPACT_TASK_DIRECTIVE = [
  'IMPORTANT: You MUST include an additional section called "## Current Task & Repository Actions" placed right after "## Current Task State". This section must contain:',
  '1. **Active Goal**: A clear, specific one-line statement of what the user is trying to accomplish right now.',
  '2. **Remaining Steps**: A numbered checklist of concrete steps still needed to finish the current task (files to edit, commands to run, tests to pass, etc.).',
  '3. **Modified / Key Files**: List every file that was created, edited, or is central to the current work, with a brief note on each.',
  '4. **Repo Conventions & Patterns**: Any project-specific conventions, build commands, directory layout rules, or patterns discovered during the conversation.',
  '5. **Blockers & Open Questions**: Anything unresolved that might block progress.',
  '',
  'Be extremely specific — include exact file paths, function names, shell commands, and error messages. The next assistant must be able to pick up and continue the work immediately without re-exploring the repository.',
].join('\n');

export class Agent {
  private llm: LLMClient;
  private tools: ToolRegistry;
  private config: Config;
  private useDeferredTools: boolean;
  private sessionManager: SessionManager;
  private memoryManager: MemoryManager | null = null;
  private skillsLoader: SkillsLoader | null = null;
  private presenceManager: PresenceManager | null = null;
  private pluginManager: PluginManager | null = null;
  private scheduler: Scheduler | null = null;
  private processing: Set<string> = new Set();
  private messageQueue: Map<string, { message: string; onStream?: StreamCallback; onToolCall?: ToolCallCallback; resolve: Function; reject: Function }[]> = new Map();
  // Per-session pending injections: messages to inject after tool results (at safe points)
  private pendingInjections: Map<string, { role: 'user' | 'system'; content: string }[]> = new Map();
  // Per-session elevated permissions: sessionId -> elevated state
  private elevatedSessions: Set<string> = new Set();
  // Per-session abort controllers for interrupt support
  private abortControllers: Map<string, AbortController> = new Map();
  private sendToSessionFn: ((sessionId: string, payload: Record<string, unknown>) => void) | null = null;
  private runTokenTotals = { prompt: 0, completion: 0, total: 0 };

  /**
   * Sanitize tool_calls before saving to session: fix malformed JSON arguments
   * that would cause "Invalid JSON format in tool call arguments" when replayed.
   */
  private sanitizeToolCalls(toolCalls: any[]): any[] {
    return toolCalls.map(tc => {
      if (!tc.function?.arguments) return tc;
      const args = tc.function.arguments;
      try {
        JSON.parse(args);
        return tc; // valid JSON, keep as-is
      } catch {
        // Try to repair truncated JSON: add missing closing braces/brackets
        let repaired = args;
        const opens = (repaired.match(/[{[]/g) || []).length;
        const closes = (repaired.match(/[}\]]/g) || []).length;
        const missing = opens - closes;
        if (missing > 0) {
          for (let i = 0; i < missing; i++) repaired += '}';
          try {
            JSON.parse(repaired);
            return { ...tc, function: { ...tc.function, arguments: repaired } };
          } catch { /* fall through */ }
        }
        // Cannot repair — replace with empty object to prevent session corruption
        console.warn(`[agent] Sanitized malformed tool_call args for ${tc.function?.name}: ${args.slice(0, 100)}...`);
        return { ...tc, function: { ...tc.function, arguments: '{}' } };
      }
    });
  }

  constructor(config: Config, sessionManager: SessionManager) {
    this.config = config;
    this.useDeferredTools = config.tools.deferredLoading !== false;
    this.llm = new LLMClient(config);
    this.tools = new ToolRegistry();
    this.sessionManager = sessionManager;

    // Wire LLM into session manager for summary-based auto-compaction
    this.sessionManager.setLLMClient(this.llm);
    this.sessionManager.setDefaultCompactInstructions(COMPACT_TASK_DIRECTIVE);

    // Wire overhead estimator so token estimates include system prompt + tool definitions
    this.sessionManager.setOverheadEstimator((sid) => this._estimateOverhead(sid));

    // ── Core tools (always loaded — essential for every interaction) ──────

    this.tools.register(bashTool);
    // Register background shell tools
    for (const tool of bashTools.slice(1)) { // skip bashTool (already registered)
      this.tools.register(tool);
    }
    // File operations (read, write, edit, patch)
    this.tools.register(readFileTool);
    this.tools.register(writeFileTool);
    this.tools.register(editFileTool);
    this.tools.register(applyPatchTool);
    this.tools.register(listFilesTool);
    this.tools.register(searchInFileTool);

    // Memory & identity — always available
    for (const tool of memoryTools) {
      this.tools.register(tool);
    }

    // ── Meta-tools for lazy loading ──────────────────────────────────────

    this.tools.register(this._createListToolsTool());
    // load_tool and unload_tool only available when deferredLoading is enabled
    if (config.tools.deferredLoading !== false) {
      this.tools.register(this._createLoadToolTool());
      this.tools.register(this._createUnloadToolTool());
    }

    // ── Wire module-level setters (needed even before tools are promoted) ─

    setSessionManager(sessionManager);
    setAgent(this);
    setImageConfig(config.agent.apiBase, config.agent.model, config.agent.apiKey);
    setSubAgentProfiles(config.agent.subagent?.profiles || []);
    setMCPConfig(config.mcp);
    if (config.memory.sharedDirectory) {
      setSharedMemoryDir(config.memory.sharedDirectory);
    }

    // Helper: register tool as deferred or core based on config
    const registerTool = (tool: any, summary: string, actions?: string[]) => {
      if (this.useDeferredTools) {
        this.tools.registerDeferred({ tool, summary, actions });
      } else {
        this.tools.register(tool);
      }
    };

    // ── Deferred tools (or core if deferredLoading is false) ──────────────

    // Session management
    for (const tool of sessionTools) {
      registerTool(tool, 'Manage chat sessions: list, view history, send messages, spawn sub-sessions',
        ['list', 'history', 'send', 'spawn']);
    }

    // Web search & fetch
    for (const tool of webTools) {
      registerTool(tool, 'Search the web and fetch/scrape URLs', ['search', 'fetch']);
    }

    // Image tools
    for (const tool of imageTools) {
      registerTool(tool, 'Analyze images (vision), generate images (DALL-E), send images to chat',
        ['analyze', 'generate', 'send']);
    }

    // Browser automation
    if (config.browser.enabled) {
      setBrowserConfig({ 
        profileDir: config.browser.profileDir,
        extensions: config.browser.extensions,
        headless: config.browser.headless,
        engine: config.browser.engine,
        chromiumPath: config.browser.chromiumPath,
        chromeDriverPath: config.browser.chromeDriverPath,
      });
      for (const tool of browserTools) {
        registerTool(tool, 'Control a headless browser: navigate, click, type, screenshot, execute JS, fill forms',
          ['navigate', 'back', 'screenshot', 'click', 'type', 'find', 'scroll', 'get_page', 'get_html', 'execute_js', 'fill_form', 'select', 'wait_element', 'press_key', 'human_click', 'human_type', 'upload', 'close']);
      }
    }

    // Cron scheduling
    if (config.cron.enabled) {
      for (const tool of cronTools) {
        registerTool(tool, 'Schedule recurring tasks with cron expressions',
          ['create', 'list', 'delete', 'toggle']);
      }
    }

    // Heartbeat tasks (multiple named heartbeats)
    if (config.heartbeat?.enabled !== false) {
      for (const tool of heartbeatTasksTools) {
        registerTool(tool, 'Create and manage named heartbeat schedules with custom intervals and prompts',
          ['list', 'add', 'get', 'update', 'remove', 'trigger']);
      }
    }

    // Background processes
    for (const tool of processTools) {
      registerTool(tool, 'Run and manage long-running background processes',
        ['start', 'poll', 'write', 'kill', 'list']);
    }

    // MCP servers
    for (const tool of mcpTools) {
      registerTool(tool, 'Manage configured MCP servers at runtime',
        ['list', 'start', 'stop', 'restart', 'status', 'logs', 'test']);
    }

    // Canvas (collaborative document)
    if (config.canvas?.enabled !== false) {
      for (const tool of canvasTools) {
        registerTool(tool, 'Push content to a live canvas document visible in the Web UI',
          ['push', 'reset', 'snapshot']);
      }
    }

    // ClawHub (skill marketplace)
    for (const tool of clawHubTools) {
      registerTool(tool, 'Browse and install community skills from ClawHub marketplace',
        ['browse', 'search', 'preview', 'install', 'uninstall', 'update', 'list']);
    }

    // Skill builder (self-modification)
    for (const tool of skillBuilderTools) {
      registerTool(tool, 'Create and manage hot-reloadable SKILL.md files that extend your capabilities',
        ['create', 'edit', 'read', 'delete', 'list']);
    }

    // Sub-agents (subagent + subagent_poll + subagent_finish)
    for (const tool of subAgentTools) {
      const summary = tool.name === 'subagent_poll'
        ? 'Check status and results of parallel sub-agents (list, check by ID, clear)'
        : tool.name === 'subagent_finish'
        ? 'Signal that you (a sub-agent) have completed your task and return a final result'
        : 'Spawn autonomous sub-agents — blocking (wait) or parallel (background, poll later)';
      registerTool(tool, summary);
    }

    // Skill management (list, load, unload, show skills)
    for (const tool of skillTools) {
      this.tools.register(tool);
    }

    // Shared memory
    for (const tool of sharedMemoryTools) {
      registerTool(tool, 'Read/write shared memory files accessible across sessions and agents',
        ['read', 'write', 'append', 'list', 'delete']);
    }

    // Plugin management
    if (config.plugins?.enabled !== false) {
      for (const tool of pluginTools) {
        registerTool(tool, 'Create, scaffold, and manage runtime plugins that add new tools/channels/middleware',
          ['list', 'scaffold', 'reload', 'create']);
      }
    }

    // TTS (Text-to-Speech)
    if (config.tts?.enabled) {
      setTTSConfig({
        apiKey: config.tts.apiKey,
        voice: config.tts.voice,
        model: config.tts.model,
        outputDir: config.tts.outputDir,
      });
      for (const tool of ttsTools) {
        registerTool(tool, 'Convert text to speech audio using ElevenLabs', ['speak', 'voices']);
      }
    }

    // Gateway control
    setGatewayControls(config);
    for (const tool of gatewayTools) {
      registerTool(tool, 'Control gateway: view status, config, apply patches, reload',
        ['status', 'config', 'patch', 'reload']);
    }

    // Message tool (cross-session)
    setMessageAgent(this);
    for (const tool of messageTools) {
      registerTool(tool, 'Send messages and interactive questions to sessions', ['send', 'broadcast', 'ask_user_question']);
    }

    // Agents list
    for (const tool of agentsListTools) {
      registerTool(tool, 'List all configured agents in multi-agent mode');
    }


    // Goals (persistent goal queue for autonomous operation)
    for (const tool of goalsTools) {
      this.tools.register(tool);  // Always available - core autonomy feature
    }

    // Autonomy tools (self-eval, self-test, metacognition)
    for (const tool of autonomyTools) {
      this.tools.register(tool);  // Always available - core autonomy features
    }

    // Apply tool policy (allow/deny lists)
    this.tools.setPolicy(config.tools.allow, config.tools.deny);

    // Debug: log tool registration stats
    const stats = this.tools.getStats();

    // Wire sub-agent spawner
    this._wireSubAgentSpawner();
  }

  /** Set agent router reference for agents_list tool */
  setAgentRouter(router: AgentRouter | null): void {
    setAgentsRouter(router);
  }

  /** Rebuild full system prompt content with structured sections. */
  private _rebuildSystemContent(sessionView?: SessionToolView, sessionId?: string): string {
    const lines: string[] = [];
    const isElevated = sessionId ? this.elevatedSessions.has(sessionId) : false;

    // ── Core identity ──────────────────────────────────────────────────────
    lines.push(this.config.agent.systemPrompt || 'You are a personal assistant running inside AutoMate.');
    lines.push('');

    // ── Tooling ────────────────────────────────────────────────────────────
    lines.push('## Tooling');
    lines.push('Tool availability (filtered by policy):');
    lines.push('Tool names are case-sensitive. Call tools exactly as listed.');
    
    // List core tools
    const coreTools = ['bash', 'read_file', 'write_file', 'edit', 'apply_patch', 'list_files', 'search_in_file', 'memory', 'goals'];
    lines.push('');
    lines.push('Core tools (always available):');
    for (const name of coreTools) {
      lines.push(`- ${name}`);
    }

    // Inject tool catalog (deferred tools)
    const toolCatalog = this._buildToolCatalog(sessionView);
    if (toolCatalog) {
      lines.push(toolCatalog);
    }
    lines.push('');

    // ── Tool Call Style ────────────────────────────────────────────────────
    lines.push('## Tool Call Style');
    lines.push('Default: do not narrate routine, low-risk tool calls (just call the tool).');
    lines.push('Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.');
    lines.push('Keep narration brief and value-dense; avoid repeating obvious steps.');
    lines.push('Use plain human language for narration unless in a technical context.');
    lines.push('');

    // ── Workspace ──────────────────────────────────────────────────────────
    lines.push('## Workspace');
    lines.push(`Your working directory is: ${process.cwd()}`);
    lines.push('Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.');
    lines.push('');

    // ── Runtime ────────────────────────────────────────────────────────────
    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const dateStr = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    lines.push('## Runtime');
    lines.push(buildRuntimeLine({
      sessionId,
      model: this.config.agent.model,
      os: process.platform,
      arch: process.arch,
      node: process.version.replace('v', ''),
      shell: process.env.SHELL?.split('/').pop(),
      elevated: isElevated,
      thinkingLevel: (this.config.agent as any).thinkingLevel ?? 'off',
    }));
    lines.push(`Date: ${dateStr}, ${timeStr} (${this.config.timezone || 'UTC'})`);
    lines.push('');

    // ── Model Aliases ──────────────────────────────────────────────────────
    const modelsInfo = this._buildModelsInfo();
    if (modelsInfo) {
      lines.push(modelsInfo);
      lines.push('');
    }

    // ── Skills ─────────────────────────────────────────────────────────────
    if (this.skillsLoader) {
      this.skillsLoader.reloadIfChanged();
      const allSkills = this.skillsLoader.listSkills();
      if (allSkills.length > 0) {
        lines.push('## Skills');
        lines.push('Use `skill action=list` to see all skills, `skill action=load name="..."` to load one.');
        lines.push('');
        for (const s of allSkills) {
          const emoji = s.metadata?.emoji || '';
          lines.push(`- ${emoji} **${s.name}**: ${s.description.slice(0, 80)}`);
        }
        lines.push('');
      }
    }

    // Inject loaded skills for this session
    if (sessionId) {
      const sessionSkillsPrompt = getSessionSkillsInjection(sessionId);
      if (sessionSkillsPrompt) {
        lines.push(sessionSkillsPrompt);
        lines.push('');
      }
    }

    // ── Memory Recall ──────────────────────────────────────────────────────
    if (this.memoryManager) {
      lines.push('## Memory Recall');
      lines.push('Before answering anything about prior work, decisions, dates, people, preferences, or todos: use memory tools to search MEMORY.md + memory/*.md.');
      lines.push('Then use read_file to pull only the needed lines. If low confidence after search, say you checked.');
      lines.push('');

      // Inject learned patterns from self-evaluation
      const patterns = getLearnedPatterns(this.memoryManager.getDirectory());
      if (patterns.length > 0) {
        lines.push('## Learned Patterns');
        lines.push('Recurring lessons from past tasks:');
        for (const p of patterns) {
          lines.push(`- ${p}`);
        }
        lines.push('');
      }

      // Inject current metacognitive state if set
      const meta = getCurrentMetacognition(this.memoryManager.getDirectory());
      if (meta && Date.now() - meta.lastReflection < 30 * 60 * 1000) {
        lines.push('## Current Focus');
        if (meta.currentFocus) {
          lines.push(`**Task**: ${meta.currentFocus}`);
        }
        if (meta.uncertainty > 0.7) {
          lines.push('**Uncertainty**: HIGH — consider gathering more info');
        }
        if (meta.shouldEscalate) {
          lines.push(`**Alert**: This task was flagged for review: ${meta.escalateReason || 'reason unknown'}`);
        }
        if (meta.neededInfo.length > 0) {
          lines.push(`**Needed Info**: ${meta.neededInfo.join(', ')}`);
        }
        lines.push('');
      }

      // Feature 8: Inject active goal summary for cross-session awareness
      const goalSummary = getGoalsSummary(this.memoryManager.getDirectory());
      if (goalSummary) {
        lines.push('## Active Goals');
        lines.push(goalSummary);
        lines.push('Use `goals action=list` for details. Any session can add/complete goals.');
        lines.push('');
      }

      // Inject session role awareness (chat/work split)
      const roles = this.sessionManager.getSessionRoles();
      if (roles.chat || roles.work) {
        const currentRole = sessionId ? this.sessionManager.getSessionRole(sessionId) : null;
        lines.push('## Session Roles');
        if (currentRole) {
          lines.push(`You are in the **${currentRole}** session (\`${sessionId}\`).`);
        }
        if (roles.chat && (!currentRole || currentRole !== 'chat')) {
          lines.push(`💬 Chat session: \`${roles.chat}\` — user conversations, plugin messages`);
        }
        if (roles.work && (!currentRole || currentRole !== 'work')) {
          lines.push(`🔧 Work session: \`${roles.work}\` — heartbeats, cron, autonomous tasks`);
        }
        lines.push('');
        lines.push('**Cross-session actions**: `session action=send` (trigger processing), `session action=notify` (notification only), `session action=delegate` (offload task to work session).');

        // Cross-session context: show recent activity from the other session
        const otherRole = currentRole === 'chat' ? 'work' : 'chat';
        const otherId = roles[otherRole];
        if (otherId && sessionId !== otherId) {
          const activity = getRecentSessionActivity(otherId, 3);
          if (activity.length > 0) {
            lines.push('');
            lines.push(`**Recent ${otherRole} session activity** (\`${otherId}\`):`);
            for (const a of activity) {
              lines.push(`- ${a}`);
            }
          }
        }
        lines.push('');
      }
    }

    // ── Project Context (Memory Files) ─────────────────────────────────────
    if (this.memoryManager) {
      const memoryPrompt = this.memoryManager.getPromptInjection();
      if (memoryPrompt) {
        lines.push('# Project Context');
        lines.push('');
        lines.push('The following context files have been loaded:');
        lines.push(memoryPrompt);
      }
    }

    return lines.join('\n');
  }

  /** Build a lightweight power steering prompt (reminder prompt + environment, NO memory/skills/catalog).
   *  Used to periodically re-anchor the model in long conversations. */
  private _buildPowerSteeringPrompt(options?: { skipHeader?: boolean }): string {
    let content = options?.skipHeader ? '' : '';
    // Use reminderPrompt if set, otherwise fall back to systemPrompt
    const reminderPrompt = (this.config.agent as any).reminderPrompt || this.config.agent.systemPrompt;
    content += reminderPrompt;

    // Add current environment context
    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const dateStr = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    content += `\n\nCurrent time: ${dateStr}, ${timeStr}`;
    content += '\n\nStay focused on the user\'s current task. Use tools efficiently. Be concise.';

    return content;
  }

  /** Inject power steering messages into session if needed.
   *  Power steering messages are stored as hidden user messages with _meta.isPowerSteering=true.
   *  They appear in the UI as actual user messages but can be hidden via toggle. */
  private _injectPowerSteeringIfNeeded(sessionId: string): void {
    const ps = (this.config.agent as any).powerSteering;
    if (!ps?.enabled || !ps.interval || ps.interval <= 0) {
      return;
    }

    const interval = ps.interval;
    const messages = this.sessionManager.getMessages(sessionId);

    // Count non-hidden, non-power-steering messages (excluding initial system)
    let visibleMsgCount = 0;
    let lastPSIndex = -1;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const isHidden = msg._meta?.hidden;
      const isPS = msg._meta?.isPowerSteering;

      if (isPS) {
        lastPSIndex = i;
      } else if (msg.role !== 'system' && !isHidden) {
        visibleMsgCount++;
      }
    }

    // Check if we need to inject a new power steering message
    // Count messages since last power steering
    let msgSinceLastPS = 0;
    if (lastPSIndex >= 0) {
      for (let i = lastPSIndex + 1; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== 'system' && !msg._meta?.hidden && !msg._meta?.isPowerSteering) {
          msgSinceLastPS++;
        }
      }
    } else {
      msgSinceLastPS = visibleMsgCount;
    }

    // Only inject if we've passed the interval threshold
    if (msgSinceLastPS >= interval) {
      const mode = ps.mode || 'separate';
      const steeringContent = this._buildPowerSteeringPrompt({ skipHeader: mode === 'append' });

      if (mode === 'append') {
        // Append to the last user message instead of creating a separate message
        const messages = this.sessionManager.getMessages(sessionId);
        // Find the last visible user message
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.role === 'user' && !msg._meta?.hidden && !msg._meta?.isPowerSteering) {
            // Append power steering content to this message
            const originalContent = msg.content;
            const newContent = `${originalContent}\n\n(prompt)\n${steeringContent}`;

            // Update the message
            this.sessionManager.updateMessage(sessionId, i, {
              ...msg,
              content: newContent,
              _meta: {
                ...msg._meta,
                originalContent,
                hasPowerSteering: true,
              },
            });

            console.log(`[agent] Appended power steering to last user message after ${msgSinceLastPS} messages`);
            break;
          }
        }
      } else {
        // Default: inject as separate hidden message
        this.sessionManager.addMessage(sessionId, {
          role: 'user',
          content: steeringContent,
          _meta: {
            hidden: true,
            isPowerSteering: true,
          },
        });

        console.log(`[agent] Injected power steering message (hidden) after ${msgSinceLastPS} messages`);
      }
    }
  }

  /** Normalize punctuation in text: replace em dash, colon, semicolon, dash with comma */
  private _normalizePunctuation(text: string): string {
    const np = (this.config.agent as any).normalizePunctuation;
    if (!np?.enabled) return text;

    const charsToReplace = np.replace || ['—', '–', ':', ';', '-'];
    let result = text;
    for (const char of charsToReplace) {
      // Replace with comma and space for readability
      result = result.split(char).join(', ');
    }
    // Clean up double spaces that might result
    result = result.replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ');
    return result;
  }

  /** Strip _meta from messages before sending to LLM (LLM doesn't need our UI metadata) */
  private _stripMeta(messages: LLMMessage[]): LLMMessage[] {
    return messages.map(m => {
      const { _meta, ...rest } = m as any;
      return rest;
    });
  }

  /** Build models info section for system prompt (shows available models for subagent selection). */
  private _buildModelsInfo(): string {
    const providers = this.llm.listProviders();
    const aliases = this.config.agent.aliases || [];
    
    if (providers.length <= 1 && aliases.length === 0) {
      return ''; // No additional models or aliases
    }
    
    const lines: string[] = ['', '# Available Models'];
    lines.push('When spawning subagents, you can specify a model using the `model` parameter. Available options:');
    lines.push('');
    
    // List providers
    for (const p of providers) {
      const active = p.active ? ' (active)' : '';
      lines.push(`- "${p.name}" or "${p.model}"${active}`);
    }
    
    // List aliases
    if (aliases.length > 0) {
      lines.push('');
      lines.push('Model Aliases:');
      for (const a of aliases) {
        lines.push(`- "${a.name}" → ${a.model}`);
      }
    }
    
    lines.push('');
    lines.push('Example: `subagent name="researcher" task="..." model="gpt-4"`');
    lines.push('Example: `subagent name="fast-check" task="..." model="fast"`');
    
    return lines.join('\n');
  }

  /** Estimate the token overhead (system prompt + tool definitions) for a session.
   *  Called by session manager to produce accurate context-usage numbers. */
  private _estimateOverhead(sessionId: string): number {
    // System prompt size (includes skills, memory, catalog, environment)
    const sessionView = this.tools.getSessionView(sessionId);
    const systemContent = this._rebuildSystemContent(sessionView, sessionId);
    const systemTokens = Math.ceil(systemContent.length / 4);

    // Tool definitions JSON size
    const toolDefs = sessionView.getToolDefs();
    const toolDefsStr = JSON.stringify(toolDefs);
    const toolDefsTokens = Math.ceil(toolDefsStr.length / 4);

    return systemTokens + toolDefsTokens;
  }

  /** Build the tool catalog string for system prompt injection. */
  private _buildToolCatalog(sessionView?: SessionToolView): string {
    const catalog = sessionView
      ? sessionView.getDeferredCatalog()
      : this.tools.getDeferredCatalog();
    if (catalog.length === 0) return '';

    const lines = catalog.map(entry => {
      const actions = entry.actions ? ` (actions: ${entry.actions.join(', ')})` : '';
      return `  - ${entry.tool.name}: ${entry.summary}${actions}`;
    });

    return [
      '',
      '## Additional Tools',
      'The following tools are available but NOT YET LOADED. You MUST call `load_tool` with the tool name BEFORE you can use any of these.',
      'IMPORTANT: If you want to use any tool from this list, FIRST call load_tool, THEN call the tool. Do not just describe what you would do — actually call the tools.',
      'Use `list_tools` to see all available and loaded tools. Use `unload_tool` to free up tools you no longer need.',
      '',
      ...lines,
      '',
    ].join('\n');
  }

  /** Create the list_tools meta-tool. */
  private _createListToolsTool(): Tool {
    const registry = this.tools;
    return {
      name: 'list_tools',
      description: 'List all available tools — both currently loaded and available for loading. Shows which tools are active and which can be loaded with load_tool.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      async execute(_params, ctx) {
        const view = registry.getSessionView(ctx.sessionId);
        const active = view.getActiveTools().map(t => t.name).sort();
        const deferred = view.getDeferredCatalog();

        const lines: string[] = ['Loaded tools:'];
        for (const name of active) {
          lines.push(`  [loaded] ${name}`);
        }

        if (deferred.length > 0) {
          lines.push('');
          lines.push('Available tools (call load_tool to activate):');
          for (const entry of deferred) {
            const actions = entry.actions ? ` — actions: ${entry.actions.join(', ')}` : '';
            lines.push(`  [available] ${entry.tool.name}: ${entry.summary}${actions}`);
          }
        }

        return { output: lines.join('\n') };
      },
    };
  }

  /** Create the load_tool meta-tool. */
  private _createLoadToolTool(): Tool {
    const registry = this.tools;
    return {
      name: 'load_tool',
      description: 'Load an available tool into your active toolset. After loading, the tool becomes callable. Use list_tools to see available tools.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the tool to load (e.g. "web", "browser", "image", "cron")',
          },
        },
        required: ['name'],
      },
      async execute(params, ctx) {
        const name = params.name as string;
        if (!name) return { output: '', error: 'name is required' };
        const view = registry.getSessionView(ctx.sessionId);
        const result = view.promote(name);
        if (result.promoted) {
          return { output: `Tool "${name}" loaded and ready to use. ${result.description || ''}` };
        }
        return { output: '', error: result.error || `Failed to load tool "${name}"` };
      },
    };
  }

  /** Create the unload_tool meta-tool. */
  private _createUnloadToolTool(): Tool {
    const registry = this.tools;
    return {
      name: 'unload_tool',
      description: 'Unload a tool from your active toolset to free up context. The tool returns to the available pool and can be re-loaded later with load_tool. Meta-tools (list_tools, load_tool, unload_tool) cannot be unloaded.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the tool to unload (e.g. "web", "browser", "image")',
          },
        },
        required: ['name'],
      },
      async execute(params, ctx) {
        const name = params.name as string;
        if (!name) return { output: '', error: 'name is required' };
        const view = registry.getSessionView(ctx.sessionId);
        const result = view.demote(name);
        if (result.demoted) {
          return { output: `Tool "${name}" unloaded. It is now available in the catalog and can be re-loaded with load_tool.` };
        }
        return { output: '', error: result.error || `Failed to unload tool "${name}"` };
      },
    };
  }

  /** Wire in the memory manager (called from index.ts after construction) */
  setMemoryManager(mm: MemoryManager): void {
    this.memoryManager = mm;
    setMemoryManager(mm);
    setGoalsMemoryManager(mm);
    setAutonomyMemoryManager(mm);

    // Wire pre-compaction memory flush
    this.sessionManager.setBeforeCompactHook(async (sessionId, messages) => {
      if (this.pluginManager) this.pluginManager.fireCompact(sessionId);
      await this.preCompactionFlush(sessionId, messages);
    });

    // Wire auto-compact continuation handler
    this.sessionManager.setAutoCompactContinuationCallback((sessionId, continuationMessage) => {
      console.log(`[agent] Auto-compact continuation triggered for ${sessionId}`);
      // Process the continuation message asynchronously (don't await - fire and forget)
      this.processContinuationAfterCompact(sessionId, continuationMessage).catch(err => {
        console.error(`[agent] Continuation processing failed for ${sessionId}:`, err);
      });
    });
  }

  /** Wire in the scheduler (called from index.ts after construction) */
  setScheduler(s: Scheduler): void {
    this.scheduler = s;
    setScheduler(s);
  }

  /** Wire in the skills loader so ClawHub tools can hot-reload skills */
  setSkillsLoader(loader: SkillsLoader): void {
    this.skillsLoader = loader;
    setClawHubConfig(this.config.skills.directory, loader);
    setSkillBuilderConfig(this.config.skills.directory, loader);
    setSkillToolLoader(loader);  // Wire skill tool for on-demand loading
  }

  /** Get list of currently loaded skills (for API/UI) */
  getLoadedSkills(): { name: string; description: string }[] {
    if (!this.skillsLoader) return [];
    return this.skillsLoader.listSkills().map(s => ({
      name: s.name,
      description: s.description,
    }));
  }

  /** Wire in the presence manager for typing/status indicators */
  setPresenceManager(pm: PresenceManager): void {
    this.presenceManager = pm;
  }

  /** Wire in sendToSession so agent can stream responses for automated notifications (subagent, heartbeat, etc.) */
  setSendToSession(fn: (sessionId: string, payload: Record<string, unknown>) => void): void {
    this.sendToSessionFn = fn;
  }

  /** Send an out-of-band event to a session (used by interactive tools). */
  sendEventToSession(sessionId: string, payload: Record<string, unknown>): boolean {
    if (!this.sendToSessionFn) return false;
    this.sendToSessionFn(sessionId, payload);
    return true;
  }

  /** Persist an ask-user question card into session history so it survives reloads and gets indexed. */
  recordAskUserQuestion(
    sessionId: string,
    payload: { questionId: string; question: string; options?: string[]; allowCustomInput?: boolean; multiSelect?: boolean },
  ): void {
    const question = payload.question?.trim();
    if (!question) return;
    this.sessionManager.addMessage(sessionId, {
      role: 'assistant',
      content: question,
      _meta: {
        askUserQuestion: {
          id: payload.questionId,
          options: payload.options && payload.options.length > 0 ? payload.options : undefined,
          allowCustomInput: payload.allowCustomInput !== false,
          multiSelect: !!payload.multiSelect,
        },
      },
    });
  }

  /** Create stream/toolCall callbacks for a given session using sendToSession */
  private makeStreamCallbacks(sessionId: string): { onStream?: StreamCallback; onToolCall?: ToolCallCallback } {
    if (!this.sendToSessionFn) return {};
    const sendFn = this.sendToSessionFn;
    return {
      onStream: (chunk: string) => sendFn(sessionId, { type: 'stream', content: chunk }),
      onToolCall: (tc: { name: string; arguments?: string; result: string }) => sendFn(sessionId, { type: 'tool_call', name: tc.name, arguments: tc.arguments, result: tc.result }),
    };
  }

  /** Expose session manager for external use (e.g. Discord /session command) */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /** Update config at runtime (called by config watcher for live reload) */
  updateConfig(newConfig: Config): void {
    // Update agent config fields that can be hot-reloaded
    this.config.agent.systemPrompt = newConfig.agent.systemPrompt;
    this.config.agent.temperature = newConfig.agent.temperature;
    this.config.agent.maxTokens = newConfig.agent.maxTokens;
    this.config.agent.thinkingLevel = newConfig.agent.thinkingLevel;
    (this.config.agent as any).powerSteering = (newConfig.agent as any).powerSteering;
    this.config.agent.subagent = newConfig.agent.subagent;
    setSubAgentProfiles(newConfig.agent.subagent?.profiles || []);
    this.config.mcp = newConfig.mcp;
    setMCPConfig(newConfig.mcp);

    // Update browser config (requires restart for extensions)
    if (newConfig.browser.enabled) {
      setBrowserConfig({ 
        profileDir: newConfig.browser.profileDir,
        extensions: newConfig.browser.extensions,
        headless: newConfig.browser.headless,
        engine: newConfig.browser.engine,
        chromiumPath: newConfig.browser.chromiumPath,
        chromeDriverPath: newConfig.browser.chromeDriverPath,
      });
    }

    // Update LLM client settings
    this.llm.updateSettings({
      temperature: newConfig.agent.temperature,
      maxTokens: newConfig.agent.maxTokens,
      thinkingLevel: newConfig.agent.thinkingLevel,
    });
  }

  /** Wire in the plugin manager */
  setPluginManager(pm: PluginManager): void {
    this.pluginManager = pm;
    setPluginManager(pm);
    setPluginReloadCallback(() => this.refreshPluginTools());
    // Register plugin-provided tools as deferred or core based on config
    for (const tool of pm.getAllTools()) {
      if (this.useDeferredTools) {
        this.tools.registerDynamic(tool, `Plugin tool: ${tool.description.slice(0, 80)}`);
      } else {
        this.tools.register(tool);
      }
    }
  }

  /** Re-register plugin tools after plugin reload/create. */
  refreshPluginTools(): void {
    if (!this.pluginManager) return;
    const currentPluginToolNames = new Set(this.pluginManager.getAllTools().map(t => t.name));
    
    if (this.useDeferredTools) {
      // Remove stale dynamic tools no longer provided by any plugin
      for (const entry of this.tools.getGlobalDeferredCatalog()) {
        if (entry.summary?.startsWith('Plugin tool:') && !currentPluginToolNames.has(entry.tool.name)) {
          this.tools.removeDynamic(entry.tool.name);
        }
      }
      // Upsert current plugin tools (remove first to allow overwrite)
      for (const tool of this.pluginManager.getAllTools()) {
        this.tools.removeDynamic(tool.name);
        this.tools.registerDynamic(tool, `Plugin tool: ${tool.description.slice(0, 80)}`);
      }
    } else {
      // Auto-load mode: plugin tools are core tools
      // Remove stale core tools no longer provided by any plugin
      for (const tool of this.tools.getCoreTools()) {
        // Check if this looks like a plugin tool and is no longer in the current set
        // We can't easily detect plugin tools in core, so we check by name
        if (!currentPluginToolNames.has(tool.name)) {
          // Only remove if it was registered by us (not a built-in tool)
          // We use the description as a heuristic - plugin tools registered by us won't have special markers
          // Actually, let's be safe and just unregister by name if it's in the plugin tool names that are gone
          // But we need to know what was a plugin tool before. Let's use a different approach.
        }
      }
      // For safety in auto-load mode, just register all current plugin tools (duplicates are ignored by Map.set)
      for (const tool of this.pluginManager.getAllTools()) {
        this.tools.register(tool);
      }
    }
  }

  /** Wire sub-agent spawner into the subagent tools */
  private _wireSubAgentSpawner(): void {
    setSubAgentSpawner(async (opts) => {
      // Use existing session if resuming, otherwise create new
      const sessionId = opts.resumeSessionId || `subagent:${opts.name}:${Date.now()}`;
      const startTime = Date.now();
      const isResume = !!opts.resumeSessionId;

      // Inherit promoted tools from parent session (so subagents get plugin tools etc.)
      if (opts.parentSessionId) {
        const parentView = this.tools.getSessionView(opts.parentSessionId);
        const subView = this.tools.getSessionView(sessionId);
        for (const toolName of parentView.getPromotedNames()) {
          subView.promote(toolName);
        }
        // Also promote subagent_finish so the subagent can signal completion
        subView.promote('subagent_finish');
      }

      // Build system prompt for the sub-agent
      const subPrompt = opts.systemPrompt
        ? `${opts.systemPrompt}\n\nYou are a sub-agent named "${opts.name}". You have access to all tools (already loaded — no need to call load_tool). When you are DONE with your task, you MUST call the subagent_finish tool with your final result. Do NOT just respond with text — always finish by calling subagent_finish.`
        : `You are a sub-agent named "${opts.name}". You have access to all tools (already loaded — no need to call load_tool). When you are DONE with your task, you MUST call the subagent_finish tool with your final result. Do NOT just respond with text — always finish by calling subagent_finish.`;

      // For resume, add context about the restart
      const taskWithPrompt = isResume
        ? `[System: ${subPrompt}]\n\n${opts.task}`
        : `[System: ${subPrompt}]\n\n${opts.task}`;

      // Handle model selection for subagent
      const originalLlm = this.llm;
      let subagentLlm: LLMClient | null = null;
      
      if (opts.model) {
        // Check if it's an alias first
        const aliases = this.config.agent.aliases || [];
        const alias = aliases.find(a => a.name.toLowerCase() === opts.model!.toLowerCase());
        
        if (alias) {
          // Use alias - create a client with the aliased model
          subagentLlm = LLMClient.forModel(
            this.config,
            alias.model,
            alias.apiKey || this.config.agent.apiKey
          );
          // Override apiBase if specified in alias
          if (alias.apiBase) {
            (subagentLlm as any).providers[0].apiBase = alias.apiBase;
          }
          console.log(`[subagent] Using aliased model "${opts.model}" -> ${alias.model}`);
        } else {
          // Check if it's a known provider/model name
          const providers = this.llm.listProviders();
          const match = providers.find(p => 
            p.name.toLowerCase() === opts.model!.toLowerCase() ||
            p.model.toLowerCase() === opts.model!.toLowerCase()
          );
          
          if (match) {
            // Switch to this provider
            this.llm.switchModel(match.name);
            console.log(`[subagent] Using model "${match.name}" (${match.model})`);
          } else {
            // Unknown model - create a new client with this model name
            subagentLlm = LLMClient.forModel(this.config, opts.model);
            console.log(`[subagent] Using custom model "${opts.model}"`);
          }
        }
      } else {
        // Use default subagent model if configured
        const defaultSubagentModel = (this.config.agent as any).subagent?.defaultModel;
        if (defaultSubagentModel) {
          const providers = this.llm.listProviders();
          const match = providers.find(p => 
            p.name.toLowerCase() === defaultSubagentModel.toLowerCase() ||
            p.model.toLowerCase() === defaultSubagentModel.toLowerCase()
          );
          if (match) {
            this.llm.switchModel(match.name);
            console.log(`[subagent] Using default subagent model "${match.name}" (${match.model})`);
          }
        }
      }

      // Temporarily use the subagent LLM if created
      if (subagentLlm) {
        this.llm = subagentLlm;
      }

      try {
        const result = await Promise.race([
          this.processMessage(sessionId, taskWithPrompt, undefined, undefined, { maxIterations: opts.maxIterations }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), opts.timeout || 300000)
          ),
        ]);

        // Check if subagent_finish was called — use its result as the output
        const finishResult = consumeSubAgentFinish(sessionId);

        // Clean up session view
        this.tools.clearSessionView(sessionId);

        return {
          agentId: sessionId,
          name: opts.name,
          status: 'completed' as const,
          output: finishResult || result.content,
          toolCalls: result.toolCalls,
          duration: Date.now() - startTime,
        };
      } catch (err) {
        // Check if subagent_finish was already called before the error
        // (e.g. LLM call after finish tool might fail, but the work is done)
        const finishResult = consumeSubAgentFinish(sessionId);
        this.tools.clearSessionView(sessionId);

        if (finishResult) {
          return {
            agentId: sessionId,
            name: opts.name,
            status: 'completed' as const,
            output: finishResult,
            toolCalls: [],
            duration: Date.now() - startTime,
          };
        }

        const isTimeout = (err as Error).message === 'timeout';
        return {
          agentId: sessionId,
          name: opts.name,
          status: isTimeout ? 'timeout' as const : 'error' as const,
          output: isTimeout ? 'Sub-agent timed out.' : `Error: ${(err as Error).message}`,
          toolCalls: [],
          duration: Date.now() - startTime,
        };
      } finally {
        // Restore original LLM if we swapped it
        if (subagentLlm) {
          this.llm = originalLlm;
        }
      }
    });

    // Wire notifier so parallel sub-agents message the parent session when done
    setSubAgentNotifier((parentSessionId: string, message: string) => {
      // If parent session is currently processing, inject the notification
      // so it appears in the current conversation flow
      if (this.processing.has(parentSessionId)) {
        this.queueInjection(parentSessionId, message, 'user');
        // Also send to WebSocket so UI shows the notification immediately
        if (this.sendToSessionFn) {
          this.sendToSessionFn(parentSessionId, {
            type: 'notification',
            content: message,
            source: 'subagent',
          });
        }
        return;
      }
      // Parent is idle - process as a new message
      const { onStream, onToolCall } = this.makeStreamCallbacks(parentSessionId);
      this.processMessage(parentSessionId, message, onStream, onToolCall).then(result => {
        if (this.sendToSessionFn && result?.content) {
          this.sendToSessionFn(parentSessionId, { type: 'response', content: result.content, done: true });
        }
      }).catch((err) => {
        console.error(`[subagent-notifier] Failed to notify parent session ${parentSessionId}:`, err);
      });
    });

    // Wire notifier so background shells message the parent session when done
    setBackgroundShellNotifier((parentSessionId: string, message: string) => {
      // If parent session is currently processing, inject the notification
      if (this.processing.has(parentSessionId)) {
        this.queueInjection(parentSessionId, message, 'user');
        if (this.sendToSessionFn) {
          this.sendToSessionFn(parentSessionId, {
            type: 'notification',
            content: message,
            source: 'shell',
          });
        }
        return;
      }
      // Parent is idle - process as a new message
      const { onStream, onToolCall } = this.makeStreamCallbacks(parentSessionId);
      this.processMessage(parentSessionId, message, onStream, onToolCall).then(result => {
        if (this.sendToSessionFn && result?.content) {
          this.sendToSessionFn(parentSessionId, { type: 'response', content: result.content, done: true });
        }
      }).catch((err) => {
        console.error(`[shell-notifier] Failed to notify parent session ${parentSessionId}:`, err);
      });
    });
  }

  registerTool(tool: any): void {
    this.tools.register(tool);
  }

  /**
   * Safe message injection that works whether session is busy or idle.
   * - If session is processing: uses queueInjection (appears in current flow)
   * - If session is idle: starts a new processMessage
   *
   * Plugins should use this instead of calling processMessage directly.
   */
  injectMessage(sessionId: string, message: string, options?: { role?: 'user' | 'system'; source?: string }): void {
    const role = options?.role || 'user';
    const source = options?.source || 'plugin';

    // DND redirect: route automated messages to work session when DND is enabled
    if (source !== 'websocket' && source !== 'cross-session' && source !== 'delegation') {
      sessionId = this.sessionManager.getAutomatedSessionTarget(sessionId);
    }

    if (this.processing.has(sessionId)) {
      // Session is busy - inject into current flow
      this.queueInjection(sessionId, message, role);
      if (this.sendToSessionFn) {
        this.sendToSessionFn(sessionId, {
          type: 'notification',
          content: message,
          source,
        });
      }
      return;
    }

    // Session is idle - process as a new message
    const { onStream, onToolCall } = this.makeStreamCallbacks(sessionId);
    this.processMessage(sessionId, message, onStream, onToolCall).then(result => {
      if (this.sendToSessionFn && result?.content) {
        this.sendToSessionFn(sessionId, { type: 'response', content: result.content, done: true });
      }
    }).catch((err) => {
      console.error(`[agent] Failed to inject message to ${sessionId}:`, err);
    });
  }

  /** Register a tool as deferred (discoverable via catalog, loaded per-session via load_tool or programmatically). */
  registerDeferredTool(tool: any, summary: string): void {
    this.tools.registerDeferred({ tool, summary });
  }

  /** Promote a deferred tool for a specific session (makes it active without load_tool). */
  promoteToolForSession(sessionId: string, toolName: string): boolean {
    const view = this.tools.getSessionView(sessionId);
    const result = view.promote(toolName);
    return result.promoted;
  }

  /** Promote all deferred tools for a session. Returns list of promoted tool names. */
  promoteAllToolsForSession(sessionId: string): string[] {
    const view = this.tools.getSessionView(sessionId);
    const catalog = view.getDeferredCatalog();
    const promoted: string[] = [];
    for (const entry of catalog) {
      const result = view.promote(entry.tool.name);
      if (result.promoted) {
        promoted.push(entry.tool.name);
      }
    }
    return promoted;
  }

  /** Get list of deferred tool names available for loading. */
  getDeferredToolNames(): string[] {
    const catalog = this.tools.getDeferredCatalog();
    return catalog.map(entry => entry.tool.name);
  }

  /**
   * Queue a message injection to be inserted at the next safe point (after tool results).
   * This allows adding context or instructions mid-processing without breaking tool_call/tool_result pairs.
   */
  queueInjection(sessionId: string, content: string, role: 'user' | 'system' = 'user'): void {
    if (!this.pendingInjections.has(sessionId)) {
      this.pendingInjections.set(sessionId, []);
    }
    this.pendingInjections.get(sessionId)!.push({ role, content });
  }

  /**
   * Process any pending injections for a session (called after tool results are added).
   * Returns the number of injections processed.
   */
  private _processPendingInjections(sessionId: string): number {
    const injections = this.pendingInjections.get(sessionId);
    if (!injections || injections.length === 0) return 0;

    let count = 0;
    for (const injection of injections) {
      this.sessionManager.addMessage(sessionId, {
        role: injection.role,
        content: injection.content,
      });
      count++;
    }
    this.pendingInjections.delete(sessionId);
    return count;
  }

  /**
   * Check if there are pending injections for a session.
   */
  hasPendingInjections(sessionId: string): boolean {
    const injections = this.pendingInjections.get(sessionId);
    return !!(injections && injections.length > 0);
  }

  async processMessage(
    sessionId: string,
    userMessage: string,
    onStream?: StreamCallback,
    onToolCall?: ToolCallCallback,
    options?: { skipAddMessage?: boolean; maxIterations?: number },
  ): Promise<AgentResponse> {
    // Auto-elevate automated sessions (heartbeat, cron, plugins) so tools work without restrictions
    // Only webchat sessions require explicit /elevated on
    if (this.isAutomatedSession(sessionId) && !this.elevatedSessions.has(sessionId)) {
      this.elevatedSessions.add(sessionId);
    }

    // If session is busy, queue the message
    if (this.processing.has(sessionId)) {
      return new Promise((resolve, reject) => {
        if (!this.messageQueue.has(sessionId)) {
          this.messageQueue.set(sessionId, []);
        }
        this.messageQueue.get(sessionId)!.push({ message: userMessage, onStream, onToolCall, resolve, reject });
      });
    }

    // Create an AbortController for this session so it can be interrupted
    const ac = new AbortController();
    this.abortControllers.set(sessionId, ac);

    this.processing.add(sessionId);
    try {
      // Presence: mark as busy/typing
      if (this.presenceManager) this.presenceManager.startProcessing(sessionId);

      // Plugin middleware: beforeMessage
      let processedMessage = userMessage;
      if (this.pluginManager) {
        const filtered = await this.pluginManager.runBeforeMessage(sessionId, userMessage);
        if (filtered === null) {
          return { content: '(message blocked by plugin middleware)', toolCalls: [] };
        }
        processedMessage = filtered;
      }

      const result = await this._processMessage(
        sessionId,
        processedMessage,
        onStream,
        ac.signal,
        onToolCall,
        options?.skipAddMessage,
        options?.maxIterations,
      );

      // Plugin middleware: afterResponse
      if (this.pluginManager && result.content) {
        result.content = await this.pluginManager.runAfterResponse(sessionId, result.content);
      }

      // Presence: mark as done
      if (this.presenceManager) this.presenceManager.stopProcessing(sessionId);

      // Process queued messages
      while (this.messageQueue.has(sessionId)) {
        const queue = this.messageQueue.get(sessionId)!;
        if (queue.length === 0) {
          this.messageQueue.delete(sessionId);
          break;
        }
        const next = queue.shift()!;
        try {
          const r = await this._processMessage(sessionId, next.message, next.onStream, ac.signal, next.onToolCall);
          next.resolve(r);
        } catch (e) {
          next.reject(e);
        }
      }

      return result;
    } catch (error) {
      // If first message fails, reject all queued messages too
      const queue = this.messageQueue.get(sessionId);
      if (queue) {
        for (const item of queue) {
          item.reject(error);
        }
        this.messageQueue.delete(sessionId);
      }
      throw error;
    } finally {
      this.processing.delete(sessionId);
      this.abortControllers.delete(sessionId);
      // Ensure presence is cleared even on error
      if (this.presenceManager) this.presenceManager.stopProcessing(sessionId);
    }
  }

  /** Check if a session is currently being processed. */
  isProcessing(sessionId: string): boolean {
    return this.processing.has(sessionId);
  }

  /** Get all session IDs that are currently being processed. */
  getProcessingSessions(): string[] {
    return Array.from(this.processing);
  }

  /** Interrupt/abort a currently processing session. Returns true if a request was aborted. */
  interruptSession(sessionId: string): boolean {
    const ac = this.abortControllers.get(sessionId);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(sessionId);
      // Reject all queued messages so their promises don't hang
      const queue = this.messageQueue.get(sessionId);
      if (queue) {
        for (const item of queue) {
          item.reject(new Error('Session interrupted'));
        }
        this.messageQueue.delete(sessionId);
      }
      return true;
    }
    return false;
  }

  private async _processMessage(
    sessionId: string,
    userMessage: string,
    onStream?: StreamCallback,
    signal?: AbortSignal,
    onToolCall?: ToolCallCallback,
    skipAddMessage?: boolean,
    maxIterations?: number,
  ): Promise<AgentResponse> {
    const session = this.sessionManager.getOrCreate(
      sessionId.split(':')[0] || 'direct',
      sessionId.split(':').slice(1).join(':') || sessionId,
    );

    // Add user message (skip if this is a retry)
    if (!skipAddMessage) {
      this.sessionManager.addMessage(sessionId, { role: 'user', content: userMessage });
    }

    // Get per-session tool view
    const sessionView = this.tools.getSessionView(sessionId);
    
    // Auto-load configured skills for new sessions
    const autoLoadSkills = this.config.skills.autoLoad || [];
    if (autoLoadSkills.length > 0) {
      autoLoadSessionSkills(sessionId, autoLoadSkills);
    }

    // Build system prompt dynamically
    const systemMessage: LLMMessage = {
      role: 'system',
      content: this._rebuildSystemContent(sessionView, sessionId),
    };

    const toolCallResults: { name: string; result: string; arguments?: string }[] = [];
    const isElevated = this.elevatedSessions.has(sessionId);
    const ctx: ToolContext = { sessionId, workdir: process.cwd(), elevated: isElevated, signal };

    let iterations = 0;
    // No hard iteration cap - agent runs until task is done or context fills
    // (context compaction handles long-running tasks)

    while (true) {
      // Check if abort was requested
      if (signal?.aborted) {
        this.sessionManager.saveSession(sessionId);
        return { content: '(interrupted)', toolCalls: toolCallResults };
      }

      iterations++;
      if (maxIterations && iterations > maxIterations) {
        const cappedMessage = `Stopped after ${maxIterations} iterations (max_iterations limit reached).`;
        this.sessionManager.addMessage(sessionId, { role: 'assistant', content: cappedMessage });
        this.sessionManager.saveSession(sessionId);
        return { content: cappedMessage, toolCalls: toolCallResults };
      }

      // Rebuild tool defs each iteration using session view (load/unload may change set)
      const toolDefs = sessionView.getToolDefs();
      if (toolDefs.length === 0) {
        const activeTools = sessionView.getActiveTools();
      }
      // Rebuild system prompt too (catalog shrinks/grows as tools are loaded/unloaded)
      systemMessage.content = this._rebuildSystemContent(sessionView, sessionId);
      
      // NEW: Fire beforeLLM hook for plugin context injection
      let prependedSystem = '';
      let prependedReminder = '';
      if (this.pluginManager) {
        const rawMessages = this.sessionManager.getMessages(sessionId);
        const usage = (this.pluginManager as any).sessionUsage?.get(sessionId);
        const beforeCtx = {
          sessionId,
          messageCount: rawMessages.length,
          toolCallCount: toolCallResults.length,
          errorCount: usage?.errorCount || 0,
          isMultiStep: toolCallResults.length > 0 || iterations > 1,
          recentTools: toolCallResults.slice(-5).map(t => t.name),
          systemPrompt: systemMessage.content || '',
          messages: rawMessages.slice(-10).map(m => ({ role: m.role, contentPreview: String(m.content || '').slice(0, 100) })),
        };
        const beforeResult = await this.pluginManager.fireBeforeLLM(beforeCtx);
        prependedSystem = beforeResult.prependSystem || '';
        prependedReminder = beforeResult.prependReminder || '';
        // Ensure requested tools are loaded
        if (beforeResult.ensureTools?.length) {
          for (const toolName of beforeResult.ensureTools) {
            sessionView.promote(toolName);
          }
        }
      }
      // Apply prepended content to system message
      if (prependedSystem) {
        systemMessage.content = prependedSystem + '\n\n' + systemMessage.content;
      }
      
      // Auto-repair tool pairs before getting messages (prevents "tool_use without tool_result" API errors)
      this.sessionManager.repairToolPairs(sessionId);
      // Inject power steering if needed (adds hidden user messages to session)
      this._injectPowerSteeringIfNeeded(sessionId);
      // Get messages and prune old tool outputs to save context
      let rawMessages = this.sessionManager.getMessages(sessionId);
      const prunedMessages = this.sessionManager.pruneOldToolOutputs(rawMessages, 50);
      
      // NEW: Insert reminder message after system if provided
      let messages: LLMMessage[];
      if (prependedReminder) {
        messages = this._stripMeta([
          systemMessage,
          { role: 'user', content: prependedReminder },
          ...prunedMessages
        ]);
      } else {
        messages = this._stripMeta([systemMessage, ...prunedMessages]);
      }

      if (onStream) {
        // Streaming mode
        let streamResult: { content: string; toolCalls: any[]; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } };
        try {
          streamResult = await this.streamCompletion(messages, toolDefs, onStream, signal);
        } catch (err) {
          // Handle abort during streaming
          if (signal?.aborted || (err as Error)?.message === 'Request aborted') {
            this.sessionManager.saveSession(sessionId);
            return { content: '(interrupted)', toolCalls: toolCallResults };
          }
          // NEW: Fire onError hook for LLM errors
          if (this.pluginManager) {
            this.pluginManager.fireError({
              sessionId,
              error: err as Error,
              phase: 'llm',
              retryCount: 0,
            }).catch(() => {});
          }
          throw err;
        }
        const { content, toolCalls, usage } = streamResult;

        // NEW: Fire afterLLM hook
        if (this.pluginManager) {
          this.pluginManager.fireAfterLLM({
            sessionId,
            responseTokens: usage?.completionTokens,
            totalTokens: usage?.totalTokens,
            hadToolCalls: toolCalls.length > 0,
            duration: Date.now() - (ctx as any).startTime || 0,
          }).catch(() => {});
        }

        if (usage) {
          console.log(`[agent] Got usage: prompt=${usage.promptTokens}, completion=${usage.completionTokens}, total=${usage.totalTokens}`);
          this.recordTokenUsage(sessionId, usage);
        } else {
          console.log(`[agent] WARNING: No usage data received from stream`);
        }

        if (toolCalls.length > 0) {
          // Process tool calls
          this.sessionManager.addMessage(sessionId, {
            role: 'assistant',
            content: content || null,
            tool_calls: this.sanitizeToolCalls(toolCalls),
          });

          // Execute tools sequentially with interrupt support (instead of parallel to allow interruption)
          const results = [];
          for (const tc of toolCalls) {
            // Check for interrupt before each tool execution
            if (signal?.aborted) {
              this.sessionManager.saveSession(sessionId);
              return { content: "(interrupted during tool execution)", toolCalls: toolCallResults };
            }
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              args = {};
            }
            // Notify stream that a tool is being used
            if (onStream) {
              onStream(`\n[used tool: ${tc.function.name}]\n`);
            }
            if (this.pluginManager) this.pluginManager.fireToolCall(tc.function.name, args);
            const result = await sessionView.execute(tc.function.name, args, ctx);
            if (this.pluginManager) this.pluginManager.fireToolResult(tc.function.name, result.output || result.error || "");
            // NEW: Fire onError hook for tool errors
            if (result.error && this.pluginManager) {
              this.pluginManager.fireError({
                sessionId,
                error: new Error(result.error),
                phase: 'tool',
                toolName: tc.function.name,
                toolParams: args,
                retryCount: 0,
              }).catch(() => {});
            }
            const toolResult = { name: tc.function.name, result: result.output || result.error || "", arguments: tc.function.arguments };
            toolCallResults.push(toolResult);
            if (onToolCall) onToolCall(toolResult);
            results.push({ id: tc.id, result });
          }

          // Add tool results - process pending injections after EACH result (safe point)
          for (const { id, result } of results) {
            this.sessionManager.addMessage(sessionId, {
              role: 'tool',
              content: result.error ? `Error: ${result.error}\n${result.output}` : result.output,
              tool_call_id: id,
            });
            // Process any pending injections after each tool result (safe point)
            this._processPendingInjections(sessionId);
          }

          // Track tool calls for memory reminder
          for (const tc of toolCalls) {
            const { shouldRemind } = this.sessionManager.trackToolCall(sessionId, tc.function.name);
            if (shouldRemind) {
              // Inject memory reminder as a system message
              this.sessionManager.addMessage(sessionId, {
                role: 'user',
                content: 'You have made 100+ tool calls without using memory tools. Commit every important fact, decision, file path, and ongoing task to memory in their proper tier (MEMORY.md for core facts, memory/topic.md for detailed topics, logs/ for daily progress).',
              });
            }
          }

          // Check if abort was requested after tool execution
          if (signal?.aborted) {
            this.sessionManager.saveSession(sessionId);
            return { content: '(interrupted during tool execution)', toolCalls: toolCallResults };
          }

          // Continue the loop for the next LLM call
          continue;
        }

        // Final response (no tool calls)
        // Check for pending injections before finalizing - if any, continue the loop
        if (this.hasPendingInjections(sessionId)) {
          if (content) {
            const normalizedContent = this._normalizePunctuation(content);
            this.sessionManager.addMessage(sessionId, { role: 'assistant', content: normalizedContent });
          }
          this._processPendingInjections(sessionId);
          continue;
        }

        // For subagent sessions: if subagent_finish hasn't been called, nudge to continue
        if (sessionId.startsWith('subagent:') && !isSubAgentFinished(sessionId)) {
          if (content) {
            const normalizedContent = this._normalizePunctuation(content);
            this.sessionManager.addMessage(sessionId, { role: 'assistant', content: normalizedContent });
          }
          this.sessionManager.addMessage(sessionId, {
            role: 'user',
            content: 'Continue working. When you are done, call the subagent_finish tool with your final result.',
          });
          continue;
        }

        if (content) {
          const normalizedContent = this._normalizePunctuation(content);
          this.sessionManager.addMessage(sessionId, { role: 'assistant', content: normalizedContent });
          this.sessionManager.saveSession(sessionId);
        }

        return { content: this._normalizePunctuation(content) || '', toolCalls: toolCallResults, usage };
      } else {
        // Non-streaming mode
        const response = await this.llm.chat(messages, toolDefs, undefined, signal);
        const choice = response.choices?.[0];
        if (!choice) {
          // API returned empty choices — if subagent_finish was called, that's fine
          if (sessionId.startsWith('subagent:') && isSubAgentFinished(sessionId)) {
            return { content: '', toolCalls: toolCallResults };
          }
          throw new Error('LLM returned empty choices');
        }
        const msg = choice.message;

        if (response.usage) {
          this.recordTokenUsage(sessionId, {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          });
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          this.sessionManager.addMessage(sessionId, {
            role: 'assistant',
            content: msg.content,
            tool_calls: this.sanitizeToolCalls(msg.tool_calls),
          });

          // Execute tools sequentially with interrupt support (instead of parallel to allow interruption)
          const results = [];
          for (const tc of msg.tool_calls) {
            // Check for interrupt before each tool execution
            if (signal?.aborted) {
              this.sessionManager.saveSession(sessionId);
              return { content: "(interrupted during tool execution)", toolCalls: toolCallResults };
            }
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              args = {};
            }
            if (this.pluginManager) this.pluginManager.fireToolCall(tc.function.name, args);
            const result = await sessionView.execute(tc.function.name, args, ctx);
            if (this.pluginManager) this.pluginManager.fireToolResult(tc.function.name, result.output || result.error || "");
            const toolResult = { name: tc.function.name, result: result.output || result.error || "", arguments: tc.function.arguments };
            toolCallResults.push(toolResult);
            if (onToolCall) onToolCall(toolResult);
            results.push({ id: tc.id, result });
          }
          for (const { id, result } of results) {
            this.sessionManager.addMessage(sessionId, {
              role: 'tool',
              content: result.error ? `Error: ${result.error}\n${result.output}` : result.output,
              tool_call_id: id,
            });
            // Process any pending injections after each tool result (safe point)
            // Queue is cleared after first injection, so subsequent results won't re-inject
            this._processPendingInjections(sessionId);
          }

          // Track tool calls for memory reminder
          for (const tc of msg.tool_calls) {
            const { shouldRemind } = this.sessionManager.trackToolCall(sessionId, tc.function.name);
            if (shouldRemind) {
              this.sessionManager.addMessage(sessionId, {
                role: 'user',
                content: 'You have made 100+ tool calls without using memory tools. Commit every important fact, decision, file path, and ongoing task to memory in their proper tier (MEMORY.md for core facts, memory/topic.md for detailed topics, logs/ for daily progress).',
              });
            }
          }

          // Check if abort was requested after tool execution
          if (signal?.aborted) {
            this.sessionManager.saveSession(sessionId);
            return { content: '(interrupted during tool execution)', toolCalls: toolCallResults };
          }

          continue;
        }

        const content = this._normalizePunctuation(getTextFromContent(msg.content));

        // Check for pending injections before finalizing - if any, continue the loop
        if (this.hasPendingInjections(sessionId)) {
          if (content) {
            this.sessionManager.addMessage(sessionId, { role: 'assistant', content });
          }
          this._processPendingInjections(sessionId);
          continue;
        }

        // For subagent sessions: if subagent_finish hasn't been called, nudge to continue
        if (sessionId.startsWith('subagent:') && !isSubAgentFinished(sessionId)) {
          if (content) {
            this.sessionManager.addMessage(sessionId, { role: 'assistant', content });
          }
          this.sessionManager.addMessage(sessionId, {
            role: 'user',
            content: 'Continue working. When you are done, call the subagent_finish tool with your final result.',
          });
          continue;
        }

        if (content) {
          this.sessionManager.addMessage(sessionId, { role: 'assistant', content });
          this.sessionManager.saveSession(sessionId);
        }

        return {
          content,
          toolCalls: toolCallResults,
          usage: response.usage ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          } : undefined,
        };
      }
    }
    // Unreachable - loop only exits via return statements
  }

  private async streamCompletion(
    messages: LLMMessage[],
    toolDefs: any[],
    onStream: StreamCallback,
    signal?: AbortSignal,
  ): Promise<{ content: string; reasoning?: string; toolCalls: any[]; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    let content = '';
    let reasoning = '';
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    const toolCalls: Map<number, { id: string; type: string; function: { name: string; arguments: string } }> = new Map();
    let chunkCount = 0;

    
    try {
      for await (const chunk of this.llm.chatStream(messages, toolDefs, signal)) {
        chunkCount++;
        // Capture usage from the final chunk (sent when stream_options.include_usage is true)
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }

        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Handle reasoning/thinking content (Claude, DeepSeek, etc.)
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          // Stream reasoning with special marker so UI can handle it
          onStream(`[think]${delta.reasoning_content}[/think]`);
        }

        if (delta.content) {
          content += delta.content;
          onStream(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCalls.has(tc.index)) {
              toolCalls.set(tc.index, {
                id: tc.id || '',
                type: tc.type || 'function',
                function: { name: tc.function?.name || '', arguments: '' },
              });
            }
            const existing = toolCalls.get(tc.index)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.function.name = tc.function.name;
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          }
        }
      }
    } catch (err) {
      // If aborted, rethrow so caller knows
      if (signal?.aborted || (err as Error)?.message === 'Request aborted') {
        throw new Error('Request aborted');
      }
      throw err;
    }

    if (content.length === 0 && toolCalls.size === 0) {
    }

    return {
      content: this._normalizePunctuation(content),
      reasoning: reasoning || undefined,
      toolCalls: Array.from(toolCalls.values()),
      usage,
    };
  }

  // Handle chat commands
  async handleCommand(sessionId: string, command: string): Promise<string | null> {
    const cmd = command.trim().toLowerCase();
    const parts = cmd.split(/\s+/);
    const rawParts = command.trim().split(/\s+/);
    
    if (cmd === '/new' || cmd === '/reset') {
      this.sessionManager.resetSession(sessionId);
      this.elevatedSessions.delete(sessionId);
      this.tools.clearSessionView(sessionId);
      return 'Session reset.';
    }

    if (cmd === '/factory-reset') {
      if (this.memoryManager) {
        this.memoryManager.factoryReset();
      }
      for (const s of this.sessionManager.listSessions()) {
        this.sessionManager.resetSession(s.id);
        this.tools.clearSessionView(s.id);
      }
      this.elevatedSessions.clear();
      return 'Factory reset complete. All memory, identity, and sessions wiped. BOOTSTRAP.md restored — next message will start the first-run conversation.';
    }
    
    if (cmd === '/status') {
      const session = this.sessionManager.getSession(sessionId);
      if (!session) return 'No active session.';
      const elevated = this.elevatedSessions.has(sessionId);
      const provider = this.llm.getCurrentProvider();
      const tokens = this.sessionManager.estimateTokens(sessionId);
      return [
        `Session: ${session.id}`,
        `Messages: ${session.messageCount}`,
        `Context: ~${tokens} tokens`,
        `Model: ${provider.model}`,
        `Provider: ${provider.name}`,
        `Elevated: ${elevated ? 'ON' : 'OFF'}`,
        `Created: ${session.createdAt}`,
      ].join('\n');
    }

    if (cmd === '/stats') {
      const sessionTotals = this.sessionManager.getSessionTokenTotals(sessionId);
      return [
        'Token Statistics:',
        'Session total:',
        `  Input: ${sessionTotals.prompt}`,
        `  Output: ${sessionTotals.completion}`,
        `  Total: ${sessionTotals.total}`,
        'Run total (this run):',
        `  Input: ${this.runTokenTotals.prompt}`,
        `  Output: ${this.runTokenTotals.completion}`,
        `  Total: ${this.runTokenTotals.total}`,
      ].join('\n');
    }
    
    // /compact [instructions]
    if (parts[0] === '/compact') {
      const userNotes = rawParts.slice(1).join(' ').trim();
      const instructions = userNotes
        ? `${COMPACT_TASK_DIRECTIVE}\n\nUser notes: ${userNotes}`
        : COMPACT_TASK_DIRECTIVE;
      return await this.sessionManager.compactWithSummary(sessionId, this.llm, instructions);
    }

    // /elevated on|off
    if (parts[0] === '/elevated') {
      const arg = parts[1];
      if (arg === 'on') {
        this.elevatedSessions.add(sessionId);
        return 'Elevated permissions ENABLED for this session. The agent now has access to all tools.';
      } else if (arg === 'off') {
        this.elevatedSessions.delete(sessionId);
        return 'Elevated permissions DISABLED for this session. Standard tool policy restored.';
      } else {
        const isElevated = this.elevatedSessions.has(sessionId);
        return `Elevated: ${isElevated ? 'ON' : 'OFF'}\nUsage: /elevated on|off`;
      }
    }

    // /model [name|index] — list or switch models
    if (parts[0] === '/model') {
      const arg = rawParts.slice(1).join(' ').trim();
      if (!arg || arg === 'list') {
        const providers = this.llm.listProviders();
        const lines = providers.map((p, i) =>
          `  ${p.active ? '>' : ' '} ${i}: ${p.name} (${p.model}) — ${p.apiBase}`
        );
        return `Available models:\n${lines.join('\n')}\n\nSwitch with: /model <name|index>`;
      }
      const result = this.llm.switchModel(arg);
      if (result.success) {
        return `Switched to ${result.provider} (${result.model})`;
      }
      return result.error || 'Unknown model.';
    }

    // /context — show what's in the system prompt and context sizes
    if (cmd === '/context' || cmd === '/context detail') {
      return this.getContextDiagnostics(sessionId);
    }

    // /index on|off|status|rebuild — manage semantic search indexing
    if (parts[0] === '/index') {
      return this._handleIndexCommand(parts[1]);
    }

    // /heartbeat on|off|status — manage proactive heartbeats
    if (parts[0] === '/heartbeat') {
      return this._handleHeartbeatCommand(parts[1]);
    }

    // /think [level] — set thinking/reasoning level
    if (parts[0] === '/think') {
      return this._handleThinkCommand(parts[1]);
    }

    // /verbose on|off — toggle verbose output
    if (parts[0] === '/verbose') {
      return this._handleVerboseCommand(sessionId, parts[1]);
    }

    // /usage [off|tokens|full] — toggle usage footer display
    if (parts[0] === '/usage') {
      return this._handleUsageCommand(sessionId, parts[1]);
    }

    // /repair — repair broken tool pairs in current session
    if (cmd === '/repair') {
      const removed = this.sessionManager.repairToolPairs(sessionId);
      if (removed > 0) {
        return `Repaired session: removed ${removed} orphaned tool messages.`;
      }
      return 'No orphaned tool messages found.';
    }

    // /request — show the API request that would be made (for debugging/copying)
    // /request save — save to a file in memory directory
    if (parts[0] === '/request') {
      const save = parts[1] === 'save';
      const result = this._buildRequestPreview(sessionId);
      
      if (save && this.memoryManager) {
        // Save to file
        const filename = `request-${Date.now()}.json`;
        const filepath = join(this.memoryManager.getDirectory(), filename);
        const session = this.sessionManager.getSession(sessionId);
        if (session) {
          const registry = this.getToolRegistry();
          const sessionView = registry.getSessionView(sessionId);
          const systemContent = this._rebuildSystemContent(sessionView, sessionId);
          const messages: any[] = [{ role: 'system', content: systemContent }];
          for (const msg of session.messages) {
            messages.push(msg);
          }
          const tools = sessionView.getToolDefs();
          const request = this.llm.buildRequestBody(messages, tools);
          writeFileSync(filepath, JSON.stringify(request, null, 2));
          const msg = `Request saved to: ${filepath}`;
          this.sessionManager.addMessage(sessionId, { role: 'user', content: '/request save' });
          this.sessionManager.addMessage(sessionId, { role: 'assistant', content: msg });
          return msg;
        }
      }
      
      // Add to session so it persists
      this.sessionManager.addMessage(sessionId, { role: 'user', content: '/request' });
      this.sessionManager.addMessage(sessionId, { role: 'assistant', content: result });
      return result;
    }

    // /help — list all available commands
    if (cmd === '/help') {
      return [
        'Available commands:',
        '  /new, /reset — reset session',
        '  /status — show session status',
        '  /stats — show token statistics (session + this run)',
        '  /compact [instructions] — compact session with AI summary',
        '  /session export — export session as JSON',
        '  /elevated on|off — toggle elevated permissions',
        '  /model [name|index] — list/switch models',
        '  /context — show context diagnostics',
        '  /request — show raw API request (full, no truncation)',
        '  /request save — save request to file',
        '  /index on|off|status|rebuild — manage semantic indexing',
        '  /heartbeat on|off|status|now|force — manage heartbeat',
        '  /think off|minimal|low|medium|high|xhigh — set thinking level',
        '  /verbose on|off — toggle verbose output',
        '  /usage off|tokens|full — toggle usage display',
        '  /repair — repair broken tool pairs',
        '  /factory-reset — wipe all data',
        '  /help — show this help',
      ].join('\n');
    }

    return null; // not a command
  }

  // Per-session settings
  private sessionSettings: Map<string, { verbose?: boolean; usage?: 'off' | 'tokens' | 'full' }> = new Map();

  /** Handle /think command */
  private _handleThinkCommand(arg?: string): string {
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
    const current = this.config.agent.thinkingLevel || 'off';

    if (!arg || arg === 'status') {
      return `Thinking level: ${current}\nValid levels: ${levels.join(', ')}`;
    }

    if (!levels.includes(arg as any)) {
      return `Invalid thinking level "${arg}". Valid: ${levels.join(', ')}`;
    }

    // Update config (runtime only, doesn't persist)
    (this.config.agent as any).thinkingLevel = arg;
    return `Thinking level set to: ${arg}`;
  }

  /** Handle /verbose command */
  private _handleVerboseCommand(sessionId: string, arg?: string): string {
    const settings = this.sessionSettings.get(sessionId) || {};

    if (!arg || arg === 'status') {
      return `Verbose: ${settings.verbose ? 'ON' : 'OFF'}\nUsage: /verbose on|off`;
    }

    if (arg === 'on') {
      settings.verbose = true;
      this.sessionSettings.set(sessionId, settings);
      return 'Verbose mode ENABLED. Tool calls will show detailed output.';
    } else if (arg === 'off') {
      settings.verbose = false;
      this.sessionSettings.set(sessionId, settings);
      return 'Verbose mode DISABLED.';
    }

    return 'Usage: /verbose on|off';
  }

  /** Handle /usage command */
  private _handleUsageCommand(sessionId: string, arg?: string): string {
    const settings = this.sessionSettings.get(sessionId) || {};

    if (!arg || arg === 'status') {
      return `Usage display: ${settings.usage || 'off'}\nOptions: off, tokens, full`;
    }

    if (arg === 'off' || arg === 'tokens' || arg === 'full') {
      settings.usage = arg;
      this.sessionSettings.set(sessionId, settings);
      return `Usage display set to: ${arg}`;
    }

    return 'Usage: /usage off|tokens|full';
  }

  /** Record API usage for session and process totals. */
  private recordTokenUsage(sessionId: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
    const provider = this.llm.getCurrentProvider();
    this.sessionManager.setCurrentModel(provider.model);
    this.sessionManager.setSessionTokens(sessionId, usage, provider.contextWindow);
    this.runTokenTotals.prompt += usage.promptTokens;
    this.runTokenTotals.completion += usage.completionTokens;
    this.runTokenTotals.total += usage.totalTokens;
  }

  /** Build a preview of the API request that would be sent (for debugging/copying) */
  private _buildRequestPreview(sessionId: string): string {
    // Get session messages
    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.messages.length === 0) {
      return 'No messages in session to build request from.';
    }

    // Build the system prompt
    const registry = this.getToolRegistry();
    const sessionView = registry.getSessionView(sessionId);
    const systemContent = this._rebuildSystemContent(sessionView, sessionId);

    // Build messages array
    const messages: any[] = [{ role: 'system', content: systemContent }];
    for (const msg of session.messages) {
      messages.push(msg);
    }

    // Get tool definitions
    const tools = sessionView.getToolDefs();

    // Build request - get the raw body
    const request = this.llm.buildRequestBody(messages, tools);

    // Format COMPLETE request without truncation
    const formatted = JSON.stringify(request.body, null, 2);

    return `## Raw API Request

**Endpoint:** \`${request.endpoint}\`
**Headers:** \`${JSON.stringify(request.headers)}\`

\`\`\`json
${formatted}
\`\`\`

**Stats:** ${messages.length} messages, ${tools?.length || 0} tools, ~${Math.ceil(JSON.stringify(request.body).length / 4)} tokens`;
  }

  /** Get session settings for a session */
  getSessionSettings(sessionId: string): { verbose?: boolean; usage?: 'off' | 'tokens' | 'full' } {
    return this.sessionSettings.get(sessionId) || {};
  }

  /** Build context diagnostics showing token usage */
  private getContextDiagnostics(sessionId: string): string {
    const lines: string[] = ['Context Diagnostics:', ''];

    // System prompt base
    const baseLen = this.config.agent.systemPrompt.length;
    lines.push(`  Base system prompt: ~${Math.ceil(baseLen / 4)} tokens`);

    // Skills
    if (this.skillsLoader) {
      const skillsPrompt = this.skillsLoader.getSystemPromptInjection();
      if (skillsPrompt) {
        lines.push(`  Skills injection: ~${Math.ceil(skillsPrompt.length / 4)} tokens`);
        const skills = this.skillsLoader.listSkills();
        for (const s of skills) {
          lines.push(`    ${s.name}: ~${Math.ceil(s.content.length / 4)} tokens`);
        }
      } else {
        lines.push(`  Skills: none loaded`);
      }
    }

    // Memory/identity files
    if (this.memoryManager) {
      const memPrompt = this.memoryManager.getPromptInjection();
      if (memPrompt) {
        lines.push(`  Memory injection: ~${Math.ceil(memPrompt.length / 4)} tokens`);
      }
      // Individual files
      const files = ['PERSONALITY.md', 'USER.md', 'IDENTITY.md', 'AGENTS.md', 'TOOLS.md', 'MEMORY.md'];
      for (const f of files) {
        const content = this.memoryManager.getIdentityFile(f);
        if (content) {
          const extra = f === 'MEMORY.md' ? ' (Tier 1 — core)' : '';
          lines.push(`    ${f}${extra}: ~${Math.ceil(content.length / 4)} tokens`);
        }
      }
      const tier2Files = this.memoryManager.listTier2();
      if (tier2Files.length > 0) {
        const totalSize = tier2Files.reduce((sum, f) => sum + f.size, 0);
        lines.push(`    Tier 2 topics: ${tier2Files.length} files, ~${Math.ceil(totalSize / 4)} tokens (on-demand, NOT injected)`);
      }
      const recentLogDates = this.memoryManager.getRecentLogDates(3);
      if (recentLogDates.length > 0) {
        lines.push(`    Daily logs: ${recentLogDates.length} recent (Tier 2, on-demand)`);
      }
      const archiveFiles = this.memoryManager.listArchive();
      if (archiveFiles.length > 0) {
        const totalSize = archiveFiles.reduce((sum, f) => sum + f.size, 0);
        lines.push(`    Archive: ${archiveFiles.length} files, ~${Math.ceil(totalSize / 4)} tokens (cold storage, on-demand)`);
      }
    }

    // Session messages
    const sessionTokens = this.sessionManager.estimateTokens(sessionId);
    const session = this.sessionManager.getSession(sessionId);
    const msgCount = session?.messages.length || 0;
    lines.push(`  Session messages: ${msgCount} msgs, ~${sessionTokens} tokens`);

    // Total
    let totalChars = baseLen;
    if (this.skillsLoader) totalChars += (this.skillsLoader.getSystemPromptInjection() || '').length;
    if (this.memoryManager) totalChars += (this.memoryManager.getPromptInjection() || '').length;
    totalChars += (sessionTokens * 4);
    lines.push('');
    lines.push(`  TOTAL: ~${Math.ceil(totalChars / 4)} tokens`);

    return lines.join('\n');
  }

  /** Handle /index command — toggle and manage semantic search indexing */
  private _handleIndexCommand(arg?: string): string {
    if (!this.memoryManager) {
      return 'Memory manager not available.';
    }

    const stats = this.memoryManager.getIndexStats();

    if (!arg || arg === 'status') {
      if (!stats.enabled) {
        return `Semantic indexing: OFF\nUsing legacy substring search.\nEnable: /index on`;
      }
      return [
        `Semantic indexing: ON`,
        `Chunks: ${stats.totalChunks}`,
        `Files: ${stats.indexedFiles.length}`,
        ...stats.indexedFiles.map(f => `  - ${f}`),
        '',
        `Commands: /index off | /index rebuild`,
      ].join('\n');
    }

    if (arg === 'on') {
      this.memoryManager.enableIndexing();
      // Trigger background indexing
      this.memoryManager.indexAll().then(r => {
        if (r.files > 0) console.log(`[memory] Indexed ${r.files} files (${r.indexed} chunks)`);
      }).catch(() => {});
      return 'Semantic indexing ENABLED. Background indexing started.';
    }

    if (arg === 'off') {
      this.memoryManager.disableIndexing();
      return 'Semantic indexing DISABLED. Using legacy substring search.';
    }

    if (arg === 'rebuild') {
      if (!stats.enabled) {
        return 'Indexing is disabled. Use /index on first.';
      }
      this.memoryManager.clearIndex();
      this.memoryManager.indexAll().then(r => {
        console.log(`[memory] Rebuilt index: ${r.files} files, ${r.indexed} chunks`);
      }).catch(err => {
        console.error(`[memory] Rebuild failed:`, err.message);
      });
      return 'Index cleared. Full rebuild started in background.';
    }

    return `Usage: /index [on|off|status|rebuild]`;
  }

  // Reference to heartbeat manager (set externally)
  private heartbeatManager: any = null;

  /** Set heartbeat manager reference */
  setHeartbeatManager(hb: any): void {
    this.heartbeatManager = hb;
    setHeartbeatTasksManager(hb);
  }

  /** Get heartbeat manager reference (for gateway API). */
  getHeartbeatManager(): any {
    return this.heartbeatManager;
  }

  /** Handle /heartbeat command */
  private _handleHeartbeatCommand(arg?: string): string {
    if (!this.heartbeatManager) {
      return 'Heartbeat system not available. Enable cron and heartbeat in config.';
    }

    if (!arg || arg === 'status') {
      const active = this.heartbeatManager.isActive();
      return `Heartbeat: ${active ? 'ON' : 'OFF'}\n` +
        (active ? 'The agent will periodically check HEARTBEAT.md and act on it.' : 'Use /heartbeat on to enable.');
    }

    if (arg === 'on') {
      this.heartbeatManager.start();
      return 'Heartbeat ENABLED. Will check HEARTBEAT.md periodically.';
    }

    if (arg === 'force') {
      this.heartbeatManager.start(undefined, true);
      return 'Heartbeat FORCE-STARTED. Existing job replaced with fresh interval.';
    }

    if (arg === 'off') {
      this.heartbeatManager.stop();
      return 'Heartbeat DISABLED.';
    }

    if (arg === 'now') {
      this.heartbeatManager.trigger().catch(() => {});
      return 'Heartbeat triggered manually. Check daily log for results.';
    }

    return 'Usage: /heartbeat [on|off|force|status|now]';
  }

  /** Pre-compaction memory flush: save important context before compaction via in-session message */
  private async preCompactionFlush(sessionId: string, messages: LLMMessage[]): Promise<void> {
    if (!this.memoryManager) return;

    // Build a summary of what's about to be compacted
    const nonSystem = messages.filter(m => m.role !== 'system' && m.role !== 'tool');
    if (nonSystem.length < 5) return; // too few messages to bother

    // Extract key information from messages about to be lost
    const recentContent = nonSystem
      .slice(0, -10) // the messages that WILL be removed (not the recent ones kept)
      .filter(m => m.content)
      .map(m => `[${m.role}] ${(m.content || '').slice(0, 200)}`)
      .join('\n');

    if (!recentContent || recentContent.length < 50) return;

    // Send as a user message in the session so it's visible in chat
    const flushPrompt = [
      '[MEMORY FLUSH]',
      '',
      'Session context is about to be compacted. Extract ONLY durable, important facts worth remembering from the conversation above:',
      'decisions made, user preferences learned, key outcomes, important context.',
      'Save them to memory (use memory tool with action write/append). Be extremely concise.',
      'If nothing notable, reply MEMORY_FLUSH_OK.',
      '',
      'Context being compacted:',
      recentContent.slice(0, 4000),
    ].join('\n');

    try {
      const { onStream, onToolCall } = this.makeStreamCallbacks(sessionId);
      const result = await this.processMessage(sessionId, flushPrompt, onStream, onToolCall);
      const response = result.content?.trim();

      // Also save to daily log as backup
      if (response && response !== 'MEMORY_FLUSH_OK' && response.length > 10) {
        this.memoryManager.appendDailyLog(`[auto-saved before compaction]\n${response}`);
        console.log(`[memory] Pre-compaction flush saved ${response.length} chars for session ${sessionId}`);
      }
    } catch (err) {
      // Fallback: silent failure — don't break the user's flow
      console.error(`[memory] Pre-compaction flush failed: ${err}`);
    }
  }

  /** Process continuation after auto-compact: stream response to the "Continue the task" message */
  private async processContinuationAfterCompact(sessionId: string, continuationMessage: string): Promise<void> {
    // Don't process if we're already processing this session (prevents infinite loop)
    if (this.processing.has(sessionId)) {
      console.log(`[agent] Skipping continuation for ${sessionId} - already processing`);
      return;
    }

    try {
      console.log(`[agent] Processing continuation for ${sessionId}: "${continuationMessage}"`);
      const { onStream, onToolCall } = this.makeStreamCallbacks(sessionId);
      await this.processMessage(sessionId, continuationMessage, onStream, onToolCall);
    } catch (err) {
      console.error(`[agent] Continuation processing error for ${sessionId}:`, err);
    }
  }

  /** Check if a session has elevated permissions */
  isElevated(sessionId: string): boolean {
    return this.elevatedSessions.has(sessionId);
  }

  /** Check if a session is automated (heartbeat, cron, plugin channels) vs interactive webchat */
  private isAutomatedSession(sessionId: string): boolean {
    if (!sessionId) return false;
    // Automated session patterns:
    // - heartbeat sessions: webchat:heartbeat, webchat:heartbeat:agentName
    // - cron sessions: cron:*, webchat:cron:*
    // - plugin channels: discord:*, telegram:*, slack:*, etc. (not webchat: prefix)
    // - subagent sessions: subagent:*
    if (sessionId.includes('heartbeat')) return true;
    if (sessionId.startsWith('cron:')) return true;
    if (sessionId.includes(':cron:')) return true;
    if (sessionId.startsWith('subagent:')) return true;
    // Plugin channels use their own prefixes (discord:, telegram:, etc.)
    // We consider anything NOT starting with 'webchat:' as potentially automated
    // BUT we also need to allow webchat:heartbeat which is already covered above
    if (!sessionId.startsWith('webchat:')) return true;
    return false;
  }

  /** Elevate a session programmatically (e.g. for heartbeat/cron) */
  elevateSession(sessionId: string): void {
    this.elevatedSessions.add(sessionId);
  }

  /** Process message with restricted tool access (for public/non-owner users) */
  async processMessageRestricted(
    sessionId: string,
    userMessage: string,
    allowedTools: string[],
    onStream?: StreamCallback,
  ): Promise<AgentResponse> {
    // If no tools allowed, process without any tool calls
    if (allowedTools.length === 0) {
      return this._processMessageChatOnly(sessionId, userMessage, onStream);
    }
    
    // Process with filtered tool set
    return this._processMessageWithFilteredTools(sessionId, userMessage, allowedTools, onStream);
  }

  /** Process message in chat-only mode (no tools) */
  private async _processMessageChatOnly(
    sessionId: string,
    userMessage: string,
    onStream?: StreamCallback,
  ): Promise<AgentResponse> {
    const session = this.sessionManager.getOrCreate(
      sessionId.split(':')[0] || 'direct',
      sessionId.split(':').slice(1).join(':') || sessionId,
    );

    this.sessionManager.addMessage(sessionId, { role: 'user', content: userMessage });

    let systemContent = this.config.agent.systemPrompt;
    systemContent += '\n\n[NOTICE: You are in public chat mode. You can converse freely but you do NOT have access to any tools. If the user asks you to perform actions, politely explain that only the bot owner can request tool usage.]';

    if (this.skillsLoader) {
      this.skillsLoader.reloadIfChanged();
      const skillsPrompt = this.skillsLoader.getSystemPromptInjection();
      if (skillsPrompt) systemContent += skillsPrompt;
    }

    if (this.memoryManager) {
      const memoryPrompt = this.memoryManager.getPromptInjection();
      if (memoryPrompt) systemContent += memoryPrompt;
    }

    const systemMessage: LLMMessage = { role: 'system', content: systemContent };
    // Auto-repair tool pairs before getting messages
    this.sessionManager.repairToolPairs(sessionId);
    const messages: LLMMessage[] = [systemMessage, ...this.sessionManager.getMessages(sessionId)];

    if (onStream) {
      let content = '';
      for await (const chunk of this.llm.chatStream(messages, [])) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          onStream(delta.content);
        }
      }
      const normalizedContent = this._normalizePunctuation(content);
      if (normalizedContent) {
        this.sessionManager.addMessage(sessionId, { role: 'assistant', content: normalizedContent });
        this.sessionManager.saveSession(sessionId);
      }
      return { content: normalizedContent, toolCalls: [] };
    } else {
      const response = await this.llm.chat(messages, []);
      const rawContent = response.choices[0]?.message?.content;
      const content = this._normalizePunctuation(getTextFromContent(rawContent));
      if (content) {
        this.sessionManager.addMessage(sessionId, { role: 'assistant', content });
        this.sessionManager.saveSession(sessionId);
      }
      return { content, toolCalls: [] };
    }
  }

  /** Process message with filtered tool access */
  private async _processMessageWithFilteredTools(
    sessionId: string,
    userMessage: string,
    allowedTools: string[],
    onStream?: StreamCallback,
  ): Promise<AgentResponse> {
    const session = this.sessionManager.getOrCreate(
      sessionId.split(':')[0] || 'direct',
      sessionId.split(':').slice(1).join(':') || sessionId,
    );

    this.sessionManager.addMessage(sessionId, { role: 'user', content: userMessage });

    let systemContent = this.config.agent.systemPrompt;
    systemContent += `\n\n[NOTICE: You are in public chat mode with LIMITED tool access. You can only use these tools: ${allowedTools.join(', ')}. If asked to perform other actions (like editing files, running commands, etc.), explain that only the bot owner can request those.]`;

    if (this.skillsLoader) {
      this.skillsLoader.reloadIfChanged();
      const skillsPrompt = this.skillsLoader.getSystemPromptInjection();
      if (skillsPrompt) systemContent += skillsPrompt;
    }

    if (this.memoryManager) {
      const memoryPrompt = this.memoryManager.getPromptInjection();
      if (memoryPrompt) systemContent += memoryPrompt;
    }

    const systemMessage: LLMMessage = { role: 'system', content: systemContent };
    const sessionView = this.tools.getSessionView(sessionId);
    const toolDefs = sessionView.getToolDefsFiltered(allowedTools);
    const ctx: ToolContext = { sessionId, workdir: process.cwd(), elevated: false };
    const toolCallResults: { name: string; result: string; arguments?: string }[] = [];

    let iterations = 0;
    const maxIterations = 20; // Lower limit for public users

    while (iterations < maxIterations) {
      iterations++;
      // Auto-repair tool pairs before getting messages
      this.sessionManager.repairToolPairs(sessionId);
      const messages: LLMMessage[] = [systemMessage, ...this.sessionManager.getMessages(sessionId)];

      if (onStream) {
        const { content, toolCalls, usage } = await this.streamCompletion(messages, toolDefs, onStream);

        if (toolCalls.length > 0) {
          this.sessionManager.addMessage(sessionId, {
            role: 'assistant',
            content: content || null,
            tool_calls: this.sanitizeToolCalls(toolCalls),
          });

          const results = await Promise.all(
            toolCalls.map(async (tc) => {
              // Double-check tool is allowed
              if (!this.tools.isToolAllowed(tc.function.name, allowedTools)) {
                return {
                  id: tc.id,
                  result: { output: '', error: `Tool '${tc.function.name}' not available in public mode` },
                };
              }
              let args: Record<string, unknown>;
              try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
              if (onStream) {
                onStream(`\n[used tool: ${tc.function.name}]\n`);
              }
              const result = await sessionView.execute(tc.function.name, args, ctx);
              toolCallResults.push({ name: tc.function.name, result: result.output || result.error || '', arguments: tc.function.arguments });
              return { id: tc.id, result };
            })
          );

          for (const { id, result } of results) {
            this.sessionManager.addMessage(sessionId, {
              role: 'tool',
              content: result.error ? `Error: ${result.error}\n${result.output}` : result.output,
              tool_call_id: id,
            });
          }
          continue;
        }

        const normalizedContent = this._normalizePunctuation(content);
        if (normalizedContent) {
          this.sessionManager.addMessage(sessionId, { role: 'assistant', content: normalizedContent });
          this.sessionManager.saveSession(sessionId);
        }
        return { content: normalizedContent || '', toolCalls: toolCallResults, usage };
      } else {
        const response = await this.llm.chat(messages, toolDefs);
        const msg = response.choices[0].message;

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const normalizedContent = this._normalizePunctuation(msg.content || '');
          this.sessionManager.addMessage(sessionId, {
            role: 'assistant',
            content: normalizedContent,
            tool_calls: this.sanitizeToolCalls(msg.tool_calls),
          });

          const results = await Promise.all(
            msg.tool_calls.map(async (tc) => {
              if (!this.tools.isToolAllowed(tc.function.name, allowedTools)) {
                return {
                  id: tc.id,
                  result: { output: '', error: `Tool '${tc.function.name}' not available in public mode` },
                };
              }
              let args: Record<string, unknown>;
              try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
              const result = await sessionView.execute(tc.function.name, args, ctx);
              toolCallResults.push({ name: tc.function.name, result: result.output || result.error || '', arguments: tc.function.arguments });
              return { id: tc.id, result };
            })
          );

          for (const { id, result } of results) {
            this.sessionManager.addMessage(sessionId, {
              role: 'tool',
              content: result.error ? `Error: ${result.error}\n${result.output}` : result.output,
              tool_call_id: id,
            });
          }
          continue;
        }

        const content = this._normalizePunctuation(getTextFromContent(msg.content));
        if (content) {
          this.sessionManager.addMessage(sessionId, { role: 'assistant', content });
          this.sessionManager.saveSession(sessionId);
        }
        return { content, toolCalls: toolCallResults };
      }
    }

    return { content: '(max iterations reached)', toolCalls: toolCallResults };
  }

  /** Get filtered tool definitions (for external use) */
  getToolDefsFiltered(allowedTools: string[]): any[] {
    return this.tools.getToolDefsFiltered(allowedTools);
  }

  /** Get the agent's configured name from IDENTITY.md (or null if not set) */
  getAgentName(): string | null {
    return this.memoryManager?.getAgentName() || null;
  }

  /** Get the memory manager reference */
  getMemoryManager(): MemoryManager | null {
    return this.memoryManager;
  }

  /** Get tool registry stats for dashboard. */
  getToolStats(): ToolRegistryStats {
    return this.tools.getStats();
  }

  /** Get the tool registry (for gateway dashboard API). */
  getToolRegistry(): ToolRegistry {
    return this.tools;
  }

  /** Get the scheduler reference (for gateway API). */
  getScheduler(): Scheduler | null {
    return this.scheduler;
  }

  /** Get the plugin manager reference (for gateway API). */
  getPluginManager(): PluginManager | null {
    return this.pluginManager;
  }

  /** Get the LLM client reference (for gateway API — model listing/switching). */
  getLLM(): LLMClient {
    return this.llm;
  }

  /** Get the config reference (for gateway API — doctor endpoint). */
  getConfig(): Config {
    return this.config;
  }
}
