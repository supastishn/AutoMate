import type { Config } from '../config/schema.js';
import { LLMClient, type LLMMessage, type StreamChunk } from './llm-client.js';
import { ToolRegistry, type ToolContext } from './tool-registry.js';
import { bashTool } from './tools/bash.js';
import { readFileTool, writeFileTool, editFileTool, applyPatchTool } from './tools/files.js';
import { browserTools } from './tools/browser.js';
import { sessionTools, setSessionManager, setAgent } from './tools/sessions.js';
import { memoryTools, setMemoryManager } from './tools/memory.js';
import { webTools } from './tools/web.js';
import { imageTools, setImageConfig } from './tools/image.js';
import { cronTools, setScheduler } from './tools/cron.js';
import { processTools } from './tools/process.js';
import { canvasTools, setCanvasBroadcaster } from '../canvas/canvas-manager.js';
import { clawHubTools, setClawHubConfig } from '../clawhub/registry.js';
import { skillBuilderTools, setSkillBuilderConfig } from './tools/skill-builder.js';
import { imageSendingTools, setImageSendConfig, setImageBroadcaster } from './tools/image-send.js';
import { subAgentTools, setSubAgentSpawner } from './tools/subagent.js';
import { sharedMemoryTools, setSharedMemoryDir } from './tools/shared-memory.js';
import { pluginTools, setPluginManager } from '../plugins/manager.js';
import type { PluginManager } from '../plugins/manager.js';
import type { PresenceManager } from '../gateway/presence.js';
import type { SessionManager } from '../gateway/session-manager.js';
import type { MemoryManager } from '../memory/manager.js';
import type { Scheduler } from '../cron/scheduler.js';
import type { SkillsLoader } from '../skills/loader.js';

export interface AgentResponse {
  content: string;
  toolCalls: { name: string; result: string }[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export type StreamCallback = (chunk: string) => void;

export class Agent {
  private llm: LLMClient;
  private tools: ToolRegistry;
  private config: Config;
  private sessionManager: SessionManager;
  private memoryManager: MemoryManager | null = null;
  private skillsLoader: SkillsLoader | null = null;
  private presenceManager: PresenceManager | null = null;
  private pluginManager: PluginManager | null = null;
  private processing: Set<string> = new Set();
  private messageQueue: Map<string, { message: string; onStream?: StreamCallback; resolve: Function; reject: Function }[]> = new Map();
  // Per-session elevated permissions: sessionId -> elevated state
  private elevatedSessions: Set<string> = new Set();

  constructor(config: Config, sessionManager: SessionManager) {
    this.config = config;
    this.llm = new LLMClient(config);
    this.tools = new ToolRegistry();
    this.sessionManager = sessionManager;

    // Register built-in tools
    this.tools.register(bashTool);
    this.tools.register(readFileTool);
    this.tools.register(writeFileTool);
    this.tools.register(editFileTool);
    this.tools.register(applyPatchTool);

    // Browser tools
    if (config.browser.enabled) {
      for (const tool of browserTools) {
        this.tools.register(tool);
      }
    }

    // Session tools
    setSessionManager(sessionManager);
    setAgent(this);
    for (const tool of sessionTools) {
      this.tools.register(tool);
    }

    // Memory tools
    for (const tool of memoryTools) {
      this.tools.register(tool);
    }

    // Web tools (search + fetch)
    for (const tool of webTools) {
      this.tools.register(tool);
    }

    // Image analysis tool
    setImageConfig(config.agent.apiBase, config.agent.model);
    for (const tool of imageTools) {
      this.tools.register(tool);
    }

    // Image sending/generation tools
    setImageSendConfig(config.agent.apiBase, config.agent.apiKey);
    for (const tool of imageSendingTools) {
      this.tools.register(tool);
    }

    // Cron tools
    if (config.cron.enabled) {
      for (const tool of cronTools) {
        this.tools.register(tool);
      }
    }

    // Background process tools
    for (const tool of processTools) {
      this.tools.register(tool);
    }

    // Canvas tools
    if (config.canvas?.enabled !== false) {
      for (const tool of canvasTools) {
        this.tools.register(tool);
      }
    }

    // ClawHub tools (search, preview, install, uninstall, list)
    for (const tool of clawHubTools) {
      this.tools.register(tool);
    }

    // Self-building skill tools
    for (const tool of skillBuilderTools) {
      this.tools.register(tool);
    }

    // Sub-agent tools
    for (const tool of subAgentTools) {
      this.tools.register(tool);
    }

    // Shared memory tools
    if (config.memory.sharedDirectory) {
      setSharedMemoryDir(config.memory.sharedDirectory);
    }
    for (const tool of sharedMemoryTools) {
      this.tools.register(tool);
    }

    // Plugin management tools
    if (config.plugins?.enabled !== false) {
      for (const tool of pluginTools) {
        this.tools.register(tool);
      }
    }

    // Apply tool policy (allow/deny lists)
    this.tools.setPolicy(config.tools.allow, config.tools.deny);

    // Wire sub-agent spawner
    this._wireSubAgentSpawner();
  }

  /** Wire in the memory manager (called from index.ts after construction) */
  setMemoryManager(mm: MemoryManager): void {
    this.memoryManager = mm;
    setMemoryManager(mm);

    // Wire pre-compaction memory flush
    this.sessionManager.setBeforeCompactHook(async (sessionId, messages) => {
      await this.preCompactionFlush(sessionId, messages);
    });
  }

  /** Wire in the scheduler (called from index.ts after construction) */
  setScheduler(s: Scheduler): void {
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

  /** Wire in the plugin manager */
  setPluginManager(pm: PluginManager): void {
    this.pluginManager = pm;
    setPluginManager(pm);
    // Register plugin-provided tools
    for (const tool of pm.getAllTools()) {
      this.tools.register(tool);
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

  async processMessage(
    sessionId: string,
    userMessage: string,
    onStream?: StreamCallback,
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

      const result = await this._processMessage(sessionId, processedMessage, onStream);

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
      // Ensure presence is cleared even on error
      if (this.presenceManager) this.presenceManager.stopProcessing(sessionId);
    }
  }

  private async _processMessage(
    sessionId: string,
    userMessage: string,
    onStream?: StreamCallback,
  ): Promise<AgentResponse> {
    const session = this.sessionManager.getOrCreate(
      sessionId.split(':')[0] || 'direct',
      sessionId.split(':').slice(1).join(':') || sessionId,
    );

    // Add user message
    this.sessionManager.addMessage(sessionId, { role: 'user', content: userMessage });

    // Build system prompt dynamically (fresh reads every message)
    let systemContent = this.config.agent.systemPrompt;

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

    const systemMessage: LLMMessage = {
      role: 'system',
      content: systemContent,
    };

    const toolCallResults: { name: string; result: string }[] = [];
    const isElevated = this.elevatedSessions.has(sessionId);
    const toolDefs = isElevated ? this.tools.getToolDefsElevated() : this.tools.getToolDefs();
    const ctx: ToolContext = { sessionId, workdir: process.cwd(), elevated: isElevated };

    let iterations = 0;
    const maxIterations = 50; // safety limit

    while (iterations < maxIterations) {
      iterations++;

      const messages: LLMMessage[] = [systemMessage, ...this.sessionManager.getMessages(sessionId)];

      if (onStream) {
        // Streaming mode
        const { content, toolCalls, usage } = await this.streamCompletion(messages, toolDefs, onStream);

        if (toolCalls.length > 0) {
          // Process tool calls
          this.sessionManager.addMessage(sessionId, {
            role: 'assistant',
            content: content || null,
            tool_calls: toolCalls,
          });

          // Execute tools in parallel for speed
          const results = await Promise.all(
            toolCalls.map(async (tc) => {
              let args: Record<string, unknown>;
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {
                args = {};
              }
              const result = await this.tools.execute(tc.function.name, args, ctx);
              toolCallResults.push({ name: tc.function.name, result: result.output || result.error || '' });
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
        const response = await this.llm.chat(messages, toolDefs);
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
              const result = await this.tools.execute(tc.function.name, args, ctx);
              toolCallResults.push({ name: tc.function.name, result: result.output || result.error || '' });
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
  ): Promise<{ content: string; toolCalls: any[]; usage?: any }> {
    let content = '';
    const toolCalls: Map<number, { id: string; type: string; function: { name: string; arguments: string } }> = new Map();

    for await (const chunk of this.llm.chatStream(messages, toolDefs)) {
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
  handleCommand(sessionId: string, command: string): string | null {
    const cmd = command.trim().toLowerCase();
    const parts = cmd.split(/\s+/);
    const rawParts = command.trim().split(/\s+/);
    
    if (cmd === '/new' || cmd === '/reset') {
      this.sessionManager.resetSession(sessionId);
      this.elevatedSessions.delete(sessionId);
      return 'Session reset.';
    }

    if (cmd === '/factory-reset') {
      if (this.memoryManager) {
        this.memoryManager.factoryReset();
      }
      for (const s of this.sessionManager.listSessions()) {
        this.sessionManager.resetSession(s.id);
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
      const instructions = rawParts.slice(1).join(' ');
      if (instructions) {
        return this.sessionManager.compactWithInstructions(sessionId, instructions);
      }
      this.sessionManager.compact(sessionId);
      this.sessionManager.saveSession(sessionId);
      return 'Session compacted.';
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

    return null; // not a command
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

    if (arg === 'off') {
      this.heartbeatManager.stop();
      return 'Heartbeat DISABLED.';
    }

    if (arg === 'now') {
      this.heartbeatManager.trigger().catch(() => {});
      return 'Heartbeat triggered manually. Check daily log for results.';
    }

    return 'Usage: /heartbeat [on|off|status|now]';
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
    const toolDefs = this.tools.getToolDefsFiltered(allowedTools);
    const ctx: ToolContext = { sessionId, workdir: process.cwd(), elevated: false };
    const toolCallResults: { name: string; result: string }[] = [];

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
              const result = await this.tools.execute(tc.function.name, args, ctx);
              toolCallResults.push({ name: tc.function.name, result: result.output || result.error || '' });
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
              const result = await this.tools.execute(tc.function.name, args, ctx);
              toolCallResults.push({ name: tc.function.name, result: result.output || result.error || '' });
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
}
