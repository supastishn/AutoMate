import type { Config } from '../config/schema.js';
import { LLMClient, type LLMMessage, type StreamChunk } from './llm-client.js';
import { ToolRegistry, type ToolContext, type Tool, type SessionToolView, type ToolRegistryStats } from './tool-registry.js';
import { bashTool } from './tools/bash.js';
import { readFileTool, writeFileTool, editFileTool, applyPatchTool, hashlineEditTool } from './tools/files.js';
import { browserTools } from './tools/browser.js';
import { sessionTools, setSessionManager, setAgent } from './tools/sessions.js';
import { memoryTools, setMemoryManager } from './tools/memory.js';
import { webTools } from './tools/web.js';
import { imageTools, setImageConfig, setImageBroadcaster } from './tools/image.js';
import { cronTools, setScheduler } from './tools/cron.js';
import { processTools } from './tools/process.js';
import { canvasTools, setCanvasBroadcaster } from '../canvas/canvas-manager.js';
import { clawHubTools, setClawHubConfig } from '../clawhub/registry.js';
import { skillBuilderTools, setSkillBuilderConfig } from './tools/skill-builder.js';
import { subAgentTools, setSubAgentSpawner } from './tools/subagent.js';
import { sharedMemoryTools, setSharedMemoryDir } from './tools/shared-memory.js';
import { pluginTools, setPluginManager, setPluginReloadCallback } from '../plugins/manager.js';
import { ttsTools, setTTSConfig } from './tools/tts.js';
import { gatewayTools, setGatewayControls } from './tools/gateway.js';
import { messageTools, setMessageAgent } from './tools/message.js';
import { agentsListTools, setAgentsRouter } from './tools/agents-list.js';
import type { PluginManager } from '../plugins/manager.js';
import type { PresenceManager } from '../gateway/presence.js';
import type { SessionManager } from '../gateway/session-manager.js';
import type { MemoryManager } from '../memory/manager.js';
import type { Scheduler } from '../cron/scheduler.js';
import type { SkillsLoader } from '../skills/loader.js';
import type { AgentRouter } from '../agents/router.js';

export interface AgentResponse {
  content: string;
  toolCalls: { name: string; result: string; arguments?: string }[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export type StreamCallback = (chunk: string) => void;
export type ToolCallCallback = (toolCall: { name: string; arguments?: string; result: string }) => void;

export class Agent {
  private llm: LLMClient;
  private tools: ToolRegistry;
  private config: Config;
  private sessionManager: SessionManager;
  private memoryManager: MemoryManager | null = null;
  private skillsLoader: SkillsLoader | null = null;
  private presenceManager: PresenceManager | null = null;
  private pluginManager: PluginManager | null = null;
  private scheduler: Scheduler | null = null;
  private processing: Set<string> = new Set();
  private messageQueue: Map<string, { message: string; onStream?: StreamCallback; resolve: Function; reject: Function }[]> = new Map();
  // Per-session elevated permissions: sessionId -> elevated state
  private elevatedSessions: Set<string> = new Set();
  // Per-session abort controllers for interrupt support
  private abortControllers: Map<string, AbortController> = new Map();

  constructor(config: Config, sessionManager: SessionManager) {
    this.config = config;
    this.llm = new LLMClient(config);
    this.tools = new ToolRegistry();
    this.sessionManager = sessionManager;

    // Wire LLM into session manager for summary-based auto-compaction
    this.sessionManager.setLLMClient(this.llm);

    // ── Core tools (always loaded — essential for every interaction) ──────

    this.tools.register(bashTool);
    this.tools.register(readFileTool);
    this.tools.register(writeFileTool);
    this.tools.register(editFileTool);
    this.tools.register(hashlineEditTool);
    this.tools.register(applyPatchTool);

    // Memory & identity — always available
    for (const tool of memoryTools) {
      this.tools.register(tool);
    }

    // ── Meta-tools for lazy loading ──────────────────────────────────────

    this.tools.register(this._createListToolsTool());
    this.tools.register(this._createLoadToolTool());
    this.tools.register(this._createUnloadToolTool());

    // ── Wire module-level setters (needed even before tools are promoted) ─

    setSessionManager(sessionManager);
    setAgent(this);
    setImageConfig(config.agent.apiBase, config.agent.model, config.agent.apiKey);
    if (config.memory.sharedDirectory) {
      setSharedMemoryDir(config.memory.sharedDirectory);
    }

    // ── Deferred tools (discoverable via list_tools, loaded via load_tool) ─

    // Session management
    for (const tool of sessionTools) {
      this.tools.registerDeferred({
        tool,
        summary: 'Manage chat sessions: list, view history, send messages, spawn sub-sessions',
        actions: ['list', 'history', 'send', 'spawn'],
      });
    }

    // Web search & fetch
    for (const tool of webTools) {
      this.tools.registerDeferred({
        tool,
        summary: 'Search the web and fetch/scrape URLs',
        actions: ['search', 'fetch'],
      });
    }

    // Image tools
    for (const tool of imageTools) {
      this.tools.registerDeferred({
        tool,
        summary: 'Analyze images (vision), generate images (DALL-E), send images to chat',
        actions: ['analyze', 'generate', 'send'],
      });
    }

    // Browser automation
    if (config.browser.enabled) {
      for (const tool of browserTools) {
        this.tools.registerDeferred({
          tool,
          summary: 'Control a headless browser: navigate, click, type, screenshot, execute JS, fill forms',
          actions: ['navigate', 'back', 'screenshot', 'click', 'type', 'find', 'scroll', 'get_page', 'get_html', 'execute_js', 'fill_form', 'select', 'wait_element', 'press_key', 'human_click', 'human_type', 'upload', 'close'],
          conditional: 'browser.enabled',
        });
      }
    }

    // Cron scheduling
    if (config.cron.enabled) {
      for (const tool of cronTools) {
        this.tools.registerDeferred({
          tool,
          summary: 'Schedule recurring tasks with cron expressions',
          actions: ['create', 'list', 'delete', 'toggle'],
          conditional: 'cron.enabled',
        });
      }
    }

    // Background processes
    for (const tool of processTools) {
      this.tools.registerDeferred({
        tool,
        summary: 'Run and manage long-running background processes',
        actions: ['start', 'poll', 'write', 'kill', 'list'],
      });
    }

    // Canvas (collaborative document)
    if (config.canvas?.enabled !== false) {
      for (const tool of canvasTools) {
        this.tools.registerDeferred({
          tool,
          summary: 'Push content to a live canvas document visible in the Web UI',
          actions: ['push', 'reset', 'snapshot'],
        });
      }
    }

    // ClawHub (skill marketplace)
    for (const tool of clawHubTools) {
      this.tools.registerDeferred({
        tool,
        summary: 'Browse and install community skills from ClawHub marketplace',
        actions: ['browse', 'search', 'preview', 'install', 'uninstall', 'update', 'list'],
      });
    }

    // Skill builder (self-modification)
    for (const tool of skillBuilderTools) {
      this.tools.registerDeferred({
        tool,
        summary: 'Create and manage hot-reloadable SKILL.md files that extend your capabilities',
        actions: ['create', 'edit', 'read', 'delete', 'list'],
      });
    }

    // Sub-agents
    for (const tool of subAgentTools) {
      this.tools.registerDeferred({
        tool,
        summary: 'Spawn autonomous sub-agents to handle tasks in parallel',
      });
    }

    // Shared memory
    for (const tool of sharedMemoryTools) {
      this.tools.registerDeferred({
        tool,
        summary: 'Read/write shared memory files accessible across sessions and agents',
        actions: ['read', 'write', 'append', 'list', 'delete'],
      });
    }

    // Plugin management
    if (config.plugins?.enabled !== false) {
      for (const tool of pluginTools) {
        this.tools.registerDeferred({
          tool,
          summary: 'Create, scaffold, and manage runtime plugins that add new tools/channels/middleware',
          actions: ['list', 'scaffold', 'reload', 'create'],
        });
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
        this.tools.registerDeferred({
          tool,
          summary: 'Convert text to speech audio using ElevenLabs',
          actions: ['speak', 'voices'],
        });
      }
    }

    // Gateway control
    setGatewayControls(config);
    for (const tool of gatewayTools) {
      this.tools.registerDeferred({
        tool,
        summary: 'Control gateway: view status, config, apply patches, reload',
        actions: ['status', 'config', 'patch', 'reload'],
      });
    }

    // Message tool (cross-session)
    setMessageAgent(this);
    for (const tool of messageTools) {
      this.tools.registerDeferred({
        tool,
        summary: 'Send messages to other sessions or agents',
        actions: ['send', 'broadcast'],
      });
    }

    // Agents list
    for (const tool of agentsListTools) {
      this.tools.registerDeferred({
        tool,
        summary: 'List all configured agents in multi-agent mode',
      });
    }

    // Apply tool policy (allow/deny lists)
    this.tools.setPolicy(config.tools.allow, config.tools.deny);

    // Wire sub-agent spawner
    this._wireSubAgentSpawner();
  }

  /** Set agent router reference for agents_list tool */
  setAgentRouter(router: AgentRouter | null): void {
    setAgentsRouter(router);
  }

  /** Rebuild full system prompt content (base + environment + catalog + skills + memory). */
  private _rebuildSystemContent(sessionView?: SessionToolView, sessionId?: string): string {
    let systemContent = this.config.agent.systemPrompt;

    // Inject environment context
    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const dateStr = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    systemContent += '\n\n# Environment';
    systemContent += `\n- Date: ${dateStr}`;
    systemContent += `\n- Time: ${timeStr}`;
    systemContent += `\n- Platform: ${process.platform}`;
    systemContent += `\n- Working Directory: ${process.cwd()}`;
    systemContent += `\n- Node: ${process.version}`;

    // Session context
    if (sessionId) {
      const isElevated = this.elevatedSessions.has(sessionId);
      systemContent += '\n\n# Session Context';
      systemContent += `\n- Session: ${sessionId}`;
      systemContent += `\n- Elevated: ${isElevated ? 'yes' : 'no'}`;
    }

    // Inject tool catalog (deferred tools the agent can load on demand)
    const toolCatalog = this._buildToolCatalog(sessionView);
    if (toolCatalog) {
      systemContent += toolCatalog;
    }

    // Inject skills (hot-reloaded)
    if (this.skillsLoader) {
      this.skillsLoader.reloadIfChanged();
      const skillsPrompt = this.skillsLoader.getSystemPromptInjection();
      if (skillsPrompt) {
        systemContent += skillsPrompt;
      }
    }

    // Inject memory & identity files
    if (this.memoryManager) {
      const memoryPrompt = this.memoryManager.getPromptInjection();
      if (memoryPrompt) {
        systemContent += memoryPrompt;
      }
    }

    return systemContent;
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
      'The following tools are available but not yet loaded. To use one, call `load_tool` with its name.',
      'You can also call `list_tools` to see all available and loaded tools. Use `unload_tool` to free up tools you no longer need.',
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

    // Wire pre-compaction memory flush
    this.sessionManager.setBeforeCompactHook(async (sessionId, messages) => {
      if (this.pluginManager) this.pluginManager.fireCompact(sessionId);
      await this.preCompactionFlush(sessionId, messages);
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

  /** Expose session manager for external use (e.g. Discord /session command) */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /** Wire in the plugin manager */
  setPluginManager(pm: PluginManager): void {
    this.pluginManager = pm;
    setPluginManager(pm);
    setPluginReloadCallback(() => this.refreshPluginTools());
    // Register plugin-provided tools as deferred (dynamically loadable)
    for (const tool of pm.getAllTools()) {
      this.tools.registerDynamic(tool, `Plugin tool: ${tool.description.slice(0, 80)}`);
    }
  }

  /** Re-register plugin tools after plugin reload/create. */
  refreshPluginTools(): void {
    if (!this.pluginManager) return;
    const currentPluginToolNames = new Set(this.pluginManager.getAllTools().map(t => t.name));
    // Remove stale dynamic tools no longer provided by any plugin
    for (const entry of this.tools.getGlobalDeferredCatalog()) {
      if (entry.summary.startsWith('Plugin tool:') && !currentPluginToolNames.has(entry.tool.name)) {
        this.tools.removeDynamic(entry.tool.name);
      }
    }
    // Upsert current plugin tools (remove first to allow overwrite)
    for (const tool of this.pluginManager.getAllTools()) {
      this.tools.removeDynamic(tool.name);
      this.tools.registerDynamic(tool, `Plugin tool: ${tool.description.slice(0, 80)}`);
    }
  }

  /** Wire sub-agent spawner into the subagent tools */
  private _wireSubAgentSpawner(): void {
    setSubAgentSpawner(async (opts) => {
      const sessionId = `subagent:${opts.name}:${Date.now()}`;
      const startTime = Date.now();

      // Build system prompt for the sub-agent
      const subPrompt = opts.systemPrompt
        ? `${opts.systemPrompt}\n\nYou are a sub-agent named "${opts.name}". Complete the task below and provide a clear, concise final answer.`
        : `You are a sub-agent named "${opts.name}". Complete the task below and provide a clear, concise final answer.`;

      // Temporarily inject system prompt
      const originalPrompt = this.config.agent.systemPrompt;

      if (!opts.reportBack) {
        // Fire and forget
        this.processMessage(sessionId, opts.task).catch(() => {});
        return {
          agentId: sessionId,
          name: opts.name,
          status: 'completed',
          output: 'Running in background.',
          toolCalls: [],
          duration: 0,
        };
      }

      // Wait for result with timeout
      try {
        const result = await Promise.race([
          this.processMessage(sessionId, `[System: ${subPrompt}]\n\n${opts.task}`),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), opts.timeout || 300000)
          ),
        ]);

        return {
          agentId: sessionId,
          name: opts.name,
          status: 'completed',
          output: result.content,
          toolCalls: result.toolCalls,
          duration: Date.now() - startTime,
        };
      } catch (err) {
        const isTimeout = (err as Error).message === 'timeout';
        return {
          agentId: sessionId,
          name: opts.name,
          status: isTimeout ? 'timeout' : 'error',
          output: isTimeout ? 'Sub-agent timed out.' : `Error: ${(err as Error).message}`,
          toolCalls: [],
          duration: Date.now() - startTime,
        };
      }
    });
  }

  registerTool(tool: any): void {
    this.tools.register(tool);
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

  async processMessage(
    sessionId: string,
    userMessage: string,
    onStream?: StreamCallback,
    onToolCall?: ToolCallCallback,
  ): Promise<AgentResponse> {
    // If session is busy, queue the message
    if (this.processing.has(sessionId)) {
      return new Promise((resolve, reject) => {
        if (!this.messageQueue.has(sessionId)) {
          this.messageQueue.set(sessionId, []);
        }
        this.messageQueue.get(sessionId)!.push({ message: userMessage, onStream, resolve, reject });
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

      const result = await this._processMessage(sessionId, processedMessage, onStream, ac.signal, onToolCall);

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
          const r = await this._processMessage(sessionId, next.message, next.onStream);
          next.resolve(r);
        } catch (e) {
          next.reject(e);
        }
      }

      return result;
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

  /** Interrupt/abort a currently processing session. Returns true if a request was aborted. */
  interruptSession(sessionId: string): boolean {
    const ac = this.abortControllers.get(sessionId);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(sessionId);
      // Clear the message queue so queued messages don't fire
      this.messageQueue.delete(sessionId);
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
  ): Promise<AgentResponse> {
    const session = this.sessionManager.getOrCreate(
      sessionId.split(':')[0] || 'direct',
      sessionId.split(':').slice(1).join(':') || sessionId,
    );

    // Add user message
    this.sessionManager.addMessage(sessionId, { role: 'user', content: userMessage });

    // Get per-session tool view
    const sessionView = this.tools.getSessionView(sessionId);

    // Build system prompt dynamically
    const systemMessage: LLMMessage = {
      role: 'system',
      content: this._rebuildSystemContent(sessionView, sessionId),
    };

    const toolCallResults: { name: string; result: string; arguments?: string }[] = [];
    const isElevated = this.elevatedSessions.has(sessionId);
    const ctx: ToolContext = { sessionId, workdir: process.cwd(), elevated: isElevated };

    let iterations = 0;
    const maxIterations = 50; // safety limit

    while (iterations < maxIterations) {
      iterations++;

      // Rebuild tool defs each iteration using session view (load/unload may change set)
      const toolDefs = sessionView.getToolDefs();
      // Rebuild system prompt too (catalog shrinks/grows as tools are loaded/unloaded)
      systemMessage.content = this._rebuildSystemContent(sessionView, sessionId);
      const messages: LLMMessage[] = [systemMessage, ...this.sessionManager.getMessages(sessionId)];

      if (onStream) {
        // Streaming mode
        const { content, toolCalls, usage } = await this.streamCompletion(messages, toolDefs, onStream, signal);

        if (toolCalls.length > 0) {
          // Process tool calls
          this.sessionManager.addMessage(sessionId, {
            role: 'assistant',
            content: content || null,
            tool_calls: toolCalls,
          });

          // Execute tools in parallel for speed (using session view)
          const results = await Promise.all(
            toolCalls.map(async (tc) => {
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
              if (this.pluginManager) this.pluginManager.fireToolResult(tc.function.name, result.output || result.error || '');
              const toolResult = { name: tc.function.name, result: result.output || result.error || '', arguments: tc.function.arguments };
              toolCallResults.push(toolResult);
              if (onToolCall) onToolCall(toolResult);
              return { id: tc.id, result };
            })
          );

          // Add tool results
          for (const { id, result } of results) {
            this.sessionManager.addMessage(sessionId, {
              role: 'tool',
              content: result.error ? `Error: ${result.error}\n${result.output}` : result.output,
              tool_call_id: id,
            });
          }

          // Continue the loop for the next LLM call
          continue;
        }

        // Final response (no tool calls)
        if (content) {
          this.sessionManager.addMessage(sessionId, { role: 'assistant', content });
          this.sessionManager.saveSession(sessionId);
        }

        return { content: content || '', toolCalls: toolCallResults, usage };
      } else {
        // Non-streaming mode
        const response = await this.llm.chat(messages, toolDefs, undefined, signal);
        const choice = response.choices[0];
        const msg = choice.message;

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          this.sessionManager.addMessage(sessionId, {
            role: 'assistant',
            content: msg.content,
            tool_calls: msg.tool_calls,
          });

          const results = await Promise.all(
            msg.tool_calls.map(async (tc) => {
              let args: Record<string, unknown>;
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {
                args = {};
              }
              if (this.pluginManager) this.pluginManager.fireToolCall(tc.function.name, args);
              const result = await sessionView.execute(tc.function.name, args, ctx);
              if (this.pluginManager) this.pluginManager.fireToolResult(tc.function.name, result.output || result.error || '');
              const toolResult = { name: tc.function.name, result: result.output || result.error || '', arguments: tc.function.arguments };
              toolCallResults.push(toolResult);
              if (onToolCall) onToolCall(toolResult);
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

        const content = msg.content || '';
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

    return { content: '(max tool iterations reached)', toolCalls: toolCallResults };
  }

  private async streamCompletion(
    messages: LLMMessage[],
    toolDefs: any[],
    onStream: StreamCallback,
    signal?: AbortSignal,
  ): Promise<{ content: string; toolCalls: any[]; usage?: any }> {
    let content = '';
    const toolCalls: Map<number, { id: string; type: string; function: { name: string; arguments: string } }> = new Map();

    for await (const chunk of this.llm.chatStream(messages, toolDefs, signal)) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

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

    return {
      content,
      toolCalls: Array.from(toolCalls.values()),
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
    
    // /compact [instructions]
    if (parts[0] === '/compact') {
      const instructions = rawParts.slice(1).join(' ') || undefined;
      return await this.sessionManager.compactWithSummary(sessionId, this.llm, instructions);
    }

    // /session main — mark current session as the main session
    if (parts[0] === '/session' && parts[1] === 'main') {
      const current = this.sessionManager.getMainSessionId();
      if (current === sessionId) {
        // Toggle off
        this.sessionManager.setMainSession(null);
        if (this.heartbeatManager?.setTargetSession) {
          this.heartbeatManager.setTargetSession('webchat:heartbeat');
        }
        return `Cleared main session (was ${sessionId}).`;
      }
      this.sessionManager.setMainSession(sessionId);
      if (this.heartbeatManager?.setTargetSession) {
        this.heartbeatManager.setTargetSession(sessionId);
      }
      return `Set ${sessionId} as main session. New webchat connections and heartbeats will use this session.`;
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

    // /help — list all available commands
    if (cmd === '/help') {
      return [
        'Available commands:',
        '  /new, /reset — reset session',
        '  /status — show session status',
        '  /compact [instructions] — compact session with AI summary',
        '  /session main — toggle this as main session',
        '  /elevated on|off — toggle elevated permissions',
        '  /model [name|index] — list/switch models',
        '  /context — show context diagnostics',
        '  /index on|off|status|rebuild — manage semantic indexing',
        '  /heartbeat on|off|status|now|force — manage heartbeat',
        '  /think off|minimal|low|medium|high — set thinking level',
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
    const levels = ['off', 'minimal', 'low', 'medium', 'high'] as const;
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
          lines.push(`    ${f}: ~${Math.ceil(content.length / 4)} tokens`);
        }
      }
      const recentLogs = this.memoryManager.getRecentDailyLogs();
      if (recentLogs) {
        lines.push(`    Daily logs: ~${Math.ceil(recentLogs.length / 4)} tokens`);
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

  /** Pre-compaction memory flush: silently save important context before compaction */
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

    // Try a silent LLM call to extract durable notes
    try {
      const flushPrompt: LLMMessage[] = [
        {
          role: 'system',
          content: 'You are a memory extraction assistant. The following conversation context is about to be compacted (lost). Extract ONLY durable, important facts worth remembering: decisions made, user preferences learned, key outcomes, important context. Be extremely concise. Output a short bullet list, or "NOTHING" if nothing is worth saving. Do NOT include conversation noise, greetings, or ephemeral details.',
        },
        {
          role: 'user',
          content: `Extract durable notes from this conversation context:\n\n${recentContent.slice(0, 4000)}`,
        },
      ];

      const response = await this.llm.chat(flushPrompt);
      const extracted = response.choices[0]?.message?.content?.trim();

      if (extracted && extracted !== 'NOTHING' && extracted.length > 10) {
        const date = new Date().toISOString().split('T')[0];
        this.memoryManager.appendDailyLog(`[auto-saved before compaction]\n${extracted}`);
        console.log(`[memory] Pre-compaction flush saved ${extracted.length} chars for session ${sessionId}`);
      }
    } catch (err) {
      // Silent failure — don't break the user's flow
      console.error(`[memory] Pre-compaction flush failed: ${err}`);
    }
  }

  /** Check if a session has elevated permissions */
  isElevated(sessionId: string): boolean {
    return this.elevatedSessions.has(sessionId);
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
      if (content) {
        this.sessionManager.addMessage(sessionId, { role: 'assistant', content });
        this.sessionManager.saveSession(sessionId);
      }
      return { content, toolCalls: [] };
    } else {
      const response = await this.llm.chat(messages, []);
      const content = response.choices[0]?.message?.content || '';
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
      const messages: LLMMessage[] = [systemMessage, ...this.sessionManager.getMessages(sessionId)];

      if (onStream) {
        const { content, toolCalls, usage } = await this.streamCompletion(messages, toolDefs, onStream);

        if (toolCalls.length > 0) {
          this.sessionManager.addMessage(sessionId, {
            role: 'assistant',
            content: content || null,
            tool_calls: toolCalls,
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

        if (content) {
          this.sessionManager.addMessage(sessionId, { role: 'assistant', content });
          this.sessionManager.saveSession(sessionId);
        }
        return { content: content || '', toolCalls: toolCallResults, usage };
      } else {
        const response = await this.llm.chat(messages, toolDefs);
        const msg = response.choices[0].message;

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          this.sessionManager.addMessage(sessionId, {
            role: 'assistant',
            content: msg.content,
            tool_calls: msg.tool_calls,
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

        const content = msg.content || '';
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