import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config/schema.js';
import { loadConfig, saveConfig, reloadConfig } from '../config/loader.js';
import { ConfigSchema } from '../config/schema.js';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from './session-manager.js';
import type { AgentRouter, AgentProfile } from '../agents/router.js';
import type { WebSocket } from 'ws';
import { setCanvasBroadcaster, getCanvas, getAllCanvases, type CanvasEvent } from '../canvas/canvas-manager.js';
import { setImageBroadcaster, type ImageEvent } from '../agent/tools/image.js';
import { PresenceManager, type PresenceEvent, type TypingEvent } from './presence.js';
import { fetchRegistry, searchSkills, fetchSkillContent, vetSkillContent, formatVetResult, installSkill, uninstallSkill, updateSkill, updateAllSkills, listInstalled } from '../clawhub/registry.js';

interface ContextInfo {
  used: number;
  limit: number;
  percent: number;
}

interface WebChatClient {
  ws: WebSocket;
  sessionId: string;
  connectedAt: string;
}

interface CanvasClient {
  ws: WebSocket;
  connectedAt: string;
}

export class GatewayServer {
  private app = Fastify({ logger: false });
  private config: Config;
  private agent: Agent;
  private sessionManager: SessionManager;
  private router: AgentRouter | null = null;
  private webChatClients: Map<string, WebChatClient> = new Map();
  private canvasClients: Map<string, CanvasClient> = new Map();
  private startTime = Date.now();
  private presenceManager: PresenceManager;

  constructor(config: Config, agent: Agent, sessionManager: SessionManager) {
    this.config = config;
    this.agent = agent;
    this.sessionManager = sessionManager;
    this.presenceManager = new PresenceManager(
      agent.getAgentName() || 'automate'
    );
    agent.setPresenceManager(this.presenceManager);
  }

  /** Set the multi-agent router. When set, agent APIs and message routing use the router. */
  setRouter(router: AgentRouter): void {
    this.router = router;
  }

  private getContextInfo(sessionId: string): ContextInfo {
    const used = this.sessionManager.estimateTokens(sessionId);
    const limit = this.config.sessions.contextLimit;
    return { used, limit, percent: Math.round((used / limit) * 100) };
  }

  async start(): Promise<void> {
    await this.app.register(fastifyCors, { origin: true });
    await this.app.register(fastifyWebsocket);
    await this.app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

    // Wire canvas broadcaster to push events to all canvas clients
    setCanvasBroadcaster((event: CanvasEvent) => {
      const msg = JSON.stringify(event);
      for (const [, client] of this.canvasClients) {
        try { client.ws.send(msg); } catch {}
      }
      // Also send to webchat clients so they know canvas updated
      for (const [, client] of this.webChatClients) {
        try { client.ws.send(msg); } catch {}
      }
    });

    // Wire image broadcaster to push images to all webchat clients
    setImageBroadcaster((event: ImageEvent) => {
      const msg = JSON.stringify(event);
      for (const [, client] of this.webChatClients) {
        try { client.ws.send(msg); } catch {}
      }
    });

    // Wire presence broadcaster to push typing/status to all webchat clients
    this.presenceManager.setBroadcaster((event: PresenceEvent | TypingEvent) => {
      const msg = JSON.stringify(event);
      for (const [, client] of this.webChatClients) {
        try { client.ws.send(msg); } catch {}
      }
    });

    // Serve dashboard static files
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const uiDist = join(__dirname, '..', '..', 'ui', 'dist');
    if (existsSync(uiDist)) {
      await this.app.register(fastifyStatic, {
        root: uiDist,
        prefix: '/',
        decorateReply: false,
      });
    }

    // Auth middleware
    this.app.addHook('onRequest', async (req, reply) => {
      // Skip auth for WS upgrade and static files
      if (req.url === '/ws' || !req.url.startsWith('/api/')) return;
      if (this.config.gateway.auth.mode === 'none') return;

      const token = req.headers.authorization?.replace('Bearer ', '');
      if (this.config.gateway.auth.mode === 'token' && token !== this.config.gateway.auth.token) {
        reply.code(401).send({ error: 'Unauthorized' });
      }
    });

    this.registerRoutes();
    this.registerWebSocket();
    this.registerCanvasWebSocket();

    await this.app.listen({
      port: this.config.gateway.port,
      host: this.config.gateway.host,
    });

    console.log(`Gateway running at http://${this.config.gateway.host}:${this.config.gateway.port}`);
  }

  private registerRoutes(): void {
    // Health
    this.app.get('/api/health', async () => ({
      status: 'ok',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      model: this.config.agent.model,
      version: '0.1.0',
    }));

    // ── OpenAI-compatible API ─────────────────────────────────────────────
    // POST /v1/chat/completions — standard OpenAI chat completions endpoint
    this.app.post<{ Body: { messages?: any[]; stream?: boolean; model?: string } }>('/v1/chat/completions', async (req, reply) => {
      const body = req.body;
      const messages = body.messages || [];
      const stream = body.stream || false;
      const model = body.model || this.config.agent.model;
      
      // Extract user message from messages array
      const userMessages = messages.filter((m: any) => m.role === 'user');
      const lastUserMessage = userMessages[userMessages.length - 1]?.content || '';
      
      // Create or reuse session
      const sessionId = `openai-api:${Date.now()}`;
      
      // Inject any system messages into context
      const systemMessage = messages.find((m: any) => m.role === 'system');
      if (systemMessage) {
        this.sessionManager.getOrCreate('openai-api', sessionId);
        // System message will be handled by agent's system prompt
      }

      if (stream) {
        // SSE streaming response
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const id = `chatcmpl-${Date.now()}`;
        let fullContent = '';

        try {
          await this.agent.processMessage(sessionId, lastUserMessage, (chunk) => {
            fullContent += chunk;
            const data = {
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{
                index: 0,
                delta: { content: chunk },
                finish_reason: null,
              }],
            };
            reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
          });

          // Send final chunk
          const finalData = {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop',
            }],
          };
          reply.raw.write(`data: ${JSON.stringify(finalData)}\n\n`);
          reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();
        } catch (err) {
          const errorData = { error: { message: (err as Error).message, type: 'server_error' } };
          reply.raw.write(`data: ${JSON.stringify(errorData)}\n\n`);
          reply.raw.end();
        }
        return;
      }

      // Non-streaming response
      try {
        const result = await this.agent.processMessage(sessionId, lastUserMessage);
        return {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: result.content,
            },
            finish_reason: 'stop',
          }],
          usage: result.usage ? {
            prompt_tokens: result.usage.promptTokens,
            completion_tokens: result.usage.completionTokens,
            total_tokens: result.usage.totalTokens,
          } : undefined,
        };
      } catch (err) {
        return reply.code(500).send({
          error: { message: (err as Error).message, type: 'server_error' },
        });
      }
    });

    // GET /v1/models — list available models
    this.app.get('/v1/models', async () => {
      const llm = this.agent.getLLM();
      const providers = llm.listProviders();
      return {
        object: 'list',
        data: providers.map(p => ({
          id: p.model,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'automate',
        })),
      };
    });

    // Sessions
    this.app.get('/api/sessions', async () => ({
      sessions: this.sessionManager.listSessions(),
    }));

    this.app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
      const session = this.sessionManager.getSession(req.params.id);
      if (!session) return { error: 'Not found' };
      return { session };
    });

    this.app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
      this.sessionManager.deleteSession(req.params.id);
      return { ok: true };
    });

    // Duplicate session
    this.app.post<{ Params: { id: string } }>('/api/sessions/:id/duplicate', async (req, reply) => {
      const dup = this.sessionManager.duplicateSession(req.params.id);
      if (!dup) return reply.code(404).send({ error: 'Session not found' });
      this.broadcastDataUpdate('sessions');
      return { ok: true, session: { id: dup.id, channel: dup.channel, messageCount: dup.messageCount } };
    });

    // Main session: get/set
    this.app.get('/api/sessions/main', async () => {
      return { mainSessionId: this.sessionManager.getMainSessionId() };
    });

    this.app.post<{ Body: { sessionId: string | null } }>('/api/sessions/main', async (req) => {
      const { sessionId } = req.body as any;
      this.sessionManager.setMainSession(sessionId || null);
      // Update heartbeat target session if heartbeat manager exists
      const hb = this.agent.getHeartbeatManager?.();
      if (hb && typeof hb.setTargetSession === 'function') {
        hb.setTargetSession(sessionId || 'webchat:heartbeat');
      }
      return { ok: true, mainSessionId: this.sessionManager.getMainSessionId() };
    });

    // Export session as downloadable JSON
    this.app.get<{ Params: { id: string } }>('/api/sessions/:id/export', async (req, reply) => {
      const session = this.sessionManager.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: 'Session not found' });
      const exportData = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        session: {
          id: session.id,
          channel: session.channel,
          userId: session.userId,
          messages: session.messages,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      };
      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', `attachment; filename="session-${session.id.replace(/[^a-zA-Z0-9-_]/g, '_')}.json"`);
      return exportData;
    });

    // Import session from JSON
    this.app.post<{ Body: { session: any } }>('/api/sessions/import', async (req, reply) => {
      try {
        const importData = (req.body as any).session || req.body;
        if (!importData.messages || !Array.isArray(importData.messages)) {
          return reply.code(400).send({ error: 'Invalid session format: missing messages array' });
        }
        const channel = importData.channel || 'imported';
        const userId = importData.userId || 'import';
        this.sessionManager.getOrCreate(channel, userId);
        // Restore messages
        for (const msg of importData.messages) {
          this.sessionManager.addMessage(`${channel}:${userId}`, {
            role: msg.role,
            content: msg.content || '',
            ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
          });
        }
        return { ok: true, sessionId: `${channel}:${userId}`, messageCount: importData.messages.length };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message || 'Import failed' });
      }
    });

    // Config (read only, safe subset for backward compat)
    this.app.get('/api/config', async () => ({
      config: {
        agent: { model: this.config.agent.model, maxTokens: this.config.agent.maxTokens },
        gateway: { port: this.config.gateway.port },
        channels: { discord: { enabled: this.config.channels.discord.enabled } },
        browser: this.config.browser,
      },
    }));

    // Full config (API keys masked)
    this.app.get('/api/config/full', async () => {
      const masked = JSON.parse(JSON.stringify(this.config));
      // Mask sensitive fields
      if (masked.agent?.apiKey) masked.agent.apiKey = '***';
      if (masked.gateway?.auth?.token) masked.gateway.auth.token = '***';
      if (masked.gateway?.auth?.password) masked.gateway.auth.password = '***';
      if (masked.channels?.discord?.token) masked.channels.discord.token = '***';
      if (masked.memory?.embedding?.apiKey) masked.memory.embedding.apiKey = '***';
      if (masked.webhooks?.token) masked.webhooks.token = '***';
      return { config: masked };
    });

    // Update config (partial deep-merge)
    this.app.put<{ Body: Record<string, any> }>('/api/config', async (req, reply) => {
      try {
        const updates = req.body;
        // Load current raw config from disk
        const currentRaw = JSON.parse(JSON.stringify(this.config));
        
        // Remove masked values from updates (don't overwrite real keys with ***)
        const cleanUpdates = JSON.parse(JSON.stringify(updates));
        const removeMasked = (obj: any) => {
          for (const key of Object.keys(obj)) {
            if (obj[key] === '***') {
              delete obj[key];
            } else if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
              removeMasked(obj[key]);
            }
          }
        };
        removeMasked(cleanUpdates);
        
        // Deep merge
        const deepMerge = (target: any, source: any): any => {
          const result = { ...target };
          for (const key of Object.keys(source)) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
              result[key] = deepMerge(target[key] || {}, source[key]);
            } else {
              result[key] = source[key];
            }
          }
          return result;
        };
        
        const merged = deepMerge(currentRaw, cleanUpdates);
        
        // Validate
        ConfigSchema.parse(merged);
        
        // Save to disk
        saveConfig(merged);
        
        // Reload into memory
        const reloaded = reloadConfig();
        Object.assign(this.config, reloaded);
        
        return { ok: true, message: 'Config updated and reloaded' };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message || 'Invalid config' });
      }
    });

    // Chat API (REST, non-streaming)
    this.app.post<{ Body: { message: string; session_id?: string } }>('/api/chat', async (req) => {
      const { message, session_id } = req.body;
      const sessionId = session_id || `webchat:rest:${Date.now()}`;

      // Check for commands
      if (message.startsWith('/')) {
        const cmdResult = this.router
          ? await this.router.handleCommand(sessionId, message)
          : await this.agent.handleCommand(sessionId, message);
        if (cmdResult) return { response: cmdResult, session_id: sessionId };
      }

      const result = this.router
        ? await this.router.processMessage(sessionId, message)
        : await this.agent.processMessage(sessionId, message);
      return {
        response: result.content,
        session_id: sessionId,
        tool_calls: result.toolCalls,
        usage: result.usage,
      };
    });

    // Webhooks
    this.app.post<{ Body: { event: string; data?: any; session_id?: string } }>('/api/webhook', async (req, reply) => {
      if (!(this.config as any).webhooks?.enabled) {
        return reply.code(404).send({ error: 'Webhooks not enabled' });
      }

      const token = req.headers['x-webhook-token'] || req.headers.authorization?.replace('Bearer ', '');
      if ((this.config as any).webhooks.token && token !== (this.config as any).webhooks.token) {
        return reply.code(401).send({ error: 'Invalid webhook token' });
      }

      const { event, data, session_id } = req.body;
      const sessionId = session_id || `webhook:${event}:${Date.now()}`;
      const message = `[Webhook event: ${event}]\n${data ? JSON.stringify(data, null, 2) : 'No data'}`;

      // Process asynchronously
      this.agent.processMessage(sessionId, message).catch(err => {
        console.error(`Webhook processing error: ${err}`);
      });

      return { ok: true, session_id: sessionId };
    });

    // Status
    this.app.get('/api/status', async () => ({
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      sessions: this.sessionManager.listSessions().length,
      webchat_clients: this.webChatClients.size,
      canvas_clients: this.canvasClients.size,
      model: this.config.agent.model,
      presence: this.presenceManager.getState(),
    }));

    // Canvas API
    this.app.get('/api/canvas', async () => ({
      canvases: getAllCanvases().map(c => ({
        id: c.id,
        title: c.title,
        contentType: c.contentType,
        language: c.language,
        contentLength: c.content.length,
        updatedAt: c.updatedAt,
      })),
    }));

    // File upload API
    this.app.post('/api/upload', async (req, reply) => {
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: 'No file uploaded' });

      const uploadDir = join(this.config.memory.directory, 'uploads');
      mkdirSync(uploadDir, { recursive: true });

      const filename = `${Date.now()}-${data.filename}`;
      const filepath = join(uploadDir, filename);
      const buf = await data.toBuffer();
      writeFileSync(filepath, buf);

      return {
        ok: true,
        filename: data.filename,
        path: filepath,
        size: buf.length,
        mimetype: data.mimetype,
      };
    });

    // Skills API (live skills list)
    this.app.get('/api/skills', async () => {
      const skills = this.agent.getLoadedSkills?.() || [];
      return { skills };
    });

    // Direct skill uninstall (no AI chat round-trip)
    this.app.post<{ Body: { name: string } }>('/api/skills/uninstall', async (req) => {
      const name = req.body.name;
      if (!name) return { success: false, error: 'name is required' };
      const skillsDir = this.config.skills.directory;
      const result = uninstallSkill(name, skillsDir);
      if (result.success) {
        // Reload skills so the agent picks up the change
        const loader = (this.agent as any).skillsLoader;
        if (loader) loader.loadAll();
        this.broadcastDataUpdate('skills');
      }
      return result;
    });

    // Dashboard API (aggregated stats for the dashboard page)
    this.app.get('/api/dashboard', async () => {
      const toolStats = this.agent.getToolStats();
      const sessions = this.sessionManager.listSessions();
      const mm = this.agent.getMemoryManager();

      // Memory stats
      let memoryStats: any = null;
      if (mm) {
        const indexStats = mm.getIndexStats();
        memoryStats = {
          indexEnabled: indexStats.enabled,
          totalChunks: indexStats.totalChunks,
          indexedFiles: indexStats.indexedFiles,
          identityFiles: ['PERSONALITY.md', 'USER.md', 'IDENTITY.md', 'AGENTS.md', 'TOOLS.md', 'MEMORY.md']
            .map(f => {
              const content = mm.getIdentityFile(f);
              return { name: f, size: content ? content.length : 0, exists: !!content };
            }),
        };
      }

      // Session breakdown
      const sessionBreakdown = {
        total: sessions.length,
        byChannel: {} as Record<string, number>,
        totalMessages: 0,
      };
      for (const s of sessions) {
        sessionBreakdown.byChannel[s.channel] = (sessionBreakdown.byChannel[s.channel] || 0) + 1;
        sessionBreakdown.totalMessages += s.messageCount;
      }

      // Heartbeat log
      const hb = this.agent.getHeartbeatManager?.();
      const heartbeatLog = hb ? hb.getLog(20) : [];

      return {
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        model: this.config.agent.model,
        tools: toolStats,
        memory: memoryStats,
        sessions: sessionBreakdown,
        webchatClients: this.webChatClients.size,
        canvasClients: this.canvasClients.size,
        presence: this.presenceManager.getState(),
        skills: this.agent.getLoadedSkills?.() || [],
        plugins: this.agent.getToolStats().deferredTools.filter(t => t.summary.startsWith('Plugin tool:')),
        heartbeatLog,
      };
    });

    // ── Heartbeat Log API ─────────────────────────────────────────────
    this.app.get('/api/heartbeat/log', async (req) => {
      const hb = this.agent.getHeartbeatManager?.();
      if (!hb) return { entries: [], error: 'Heartbeat not available' };
      const limit = (req.query as any).limit ? parseInt((req.query as any).limit) : 50;
      return { entries: hb.getLog(limit) };
    });

    // ── Cron API ──────────────────────────────────────────────────────
    this.app.get('/api/cron', async () => {
      const scheduler = this.agent.getScheduler();
      if (!scheduler) return { error: 'Scheduler not available', jobs: [] };
      return { jobs: scheduler.listJobs() };
    });

    this.app.post<{ Body: { name: string; prompt: string; schedule: any; sessionId?: string } }>('/api/cron', async (req) => {
      const scheduler = this.agent.getScheduler();
      if (!scheduler) return { error: 'Scheduler not available' };
      const { name, prompt, schedule, sessionId } = req.body;
      const job = scheduler.addJob(name, prompt, schedule, sessionId);
      this.broadcastDataUpdate('cron', scheduler.listJobs());
      return { ok: true, job };
    });

    this.app.delete<{ Params: { id: string } }>('/api/cron/:id', async (req) => {
      const scheduler = this.agent.getScheduler();
      if (!scheduler) return { error: 'Scheduler not available' };
      scheduler.removeJob(req.params.id);
      this.broadcastDataUpdate('cron', scheduler.listJobs());
      return { ok: true };
    });

    this.app.put<{ Params: { id: string } }>('/api/cron/:id/toggle', async (req) => {
      const scheduler = this.agent.getScheduler();
      if (!scheduler) return { error: 'Scheduler not available' };
      const job = scheduler.getJob(req.params.id);
      if (!job) return { error: 'Job not found' };
      if (job.enabled) {
        scheduler.disableJob(req.params.id);
      } else {
        scheduler.enableJob(req.params.id);
      }
      this.broadcastDataUpdate('cron', scheduler.listJobs());
      return { ok: true, enabled: !job.enabled };
    });

    // ── Memory API ───────────────────────────────────────────────────
    this.app.get('/api/memory/files', async () => {
      const mm = this.agent.getMemoryManager();
      if (!mm) return { error: 'Memory manager not available', files: [] };
      return { files: mm.listFiles() };
    });

    this.app.get<{ Params: { name: string } }>('/api/memory/file/:name', async (req) => {
      const mm = this.agent.getMemoryManager();
      if (!mm) return { error: 'Memory manager not available' };
      const content = mm.getIdentityFile(req.params.name);
      return { name: req.params.name, content: content || '' };
    });

    this.app.put<{ Params: { name: string }; Body: { content: string } }>('/api/memory/file/:name', async (req) => {
      const mm = this.agent.getMemoryManager();
      if (!mm) return { error: 'Memory manager not available' };
      mm.saveIdentityFile(req.params.name, req.body.content);
      this.broadcastDataUpdate('memory_files');
      return { ok: true };
    });

    this.app.post<{ Body: { query: string; limit?: number } }>('/api/memory/search', async (req) => {
      const mm = this.agent.getMemoryManager();
      if (!mm) return { error: 'Memory manager not available', results: [] };
      const results = await mm.semanticSearch(req.body.query, req.body.limit || 10);
      return { results };
    });

    // ── Plugins API ──────────────────────────────────────────────────
    this.app.get('/api/plugins', async () => {
      const pm = this.agent.getPluginManager();
      if (!pm) return { error: 'Plugin manager not available', plugins: [] };
      return { plugins: pm.getPlugins() };
    });

    this.app.post('/api/plugins/reload', async () => {
      const pm = this.agent.getPluginManager();
      if (!pm) return { error: 'Plugin manager not available' };
      await pm.loadAll();
      this.agent.refreshPluginTools();
      this.broadcastDataUpdate('plugins', pm.getPlugins());
      return { ok: true, plugins: pm.getPlugins() };
    });

    this.app.post<{ Body: { name: string; type?: string } }>('/api/plugins/scaffold', async (req, reply) => {
      const pm = this.agent.getPluginManager();
      if (!pm) return reply.code(400).send({ error: 'Plugin manager not available' });
      try {
        const { PluginManager } = await import('../plugins/manager.js');
        const pluginDir = this.config.plugins?.directory || join(this.config.memory.directory, 'plugins');
        PluginManager.scaffold(pluginDir, req.body.name, (req.body.type || 'tool') as any);
        this.broadcastDataUpdate('plugins');
        return { ok: true, name: req.body.name };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

    // ── Doctor API (security audit) ──────────────────────────────────
    this.app.get('/api/doctor', async () => {
      const config = this.agent.getConfig();
      const issues: string[] = [];
      const ok: string[] = [];

      if (config.gateway.auth.mode === 'none') {
        issues.push('[WARN] Auth mode is "none" - anyone can access the API');
      } else {
        ok.push('[OK] Auth mode: ' + config.gateway.auth.mode);
      }
      if (config.gateway.auth.mode === 'token' && !config.gateway.auth.token) {
        issues.push('[WARN] Token auth enabled but no token set');
      }
      if (config.gateway.host !== '127.0.0.1' && config.gateway.host !== 'localhost') {
        issues.push(`[WARN] Gateway bound to ${config.gateway.host} - exposed to network`);
      } else {
        ok.push('[OK] Gateway bound to localhost only');
      }
      if (config.channels.discord.enabled) {
        if (config.channels.discord.allowFrom.includes('*')) {
          issues.push('[WARN] Discord allows messages from ALL users');
        } else {
          ok.push(`[OK] Discord restricted to ${config.channels.discord.allowFrom.length} users`);
        }
      }
      if (config.tools.deny.length > 0) {
        ok.push(`[OK] ${config.tools.deny.length} tools denied by policy`);
      } else {
        issues.push('[INFO] No tool deny list configured - agent can use all tools');
      }
      if (config.browser.enabled) {
        issues.push('[INFO] Browser automation enabled - agent can browse the web');
      }
      if ((config as any).webhooks?.enabled && !(config as any).webhooks?.token) {
        issues.push('[WARN] Webhooks enabled without auth token');
      }
      if (config.cron.enabled) {
        ok.push('[OK] Cron scheduler enabled');
      }
      ok.push(`[OK] Memory directory: ${config.memory.directory}`);

      return { ok, issues, total: { passed: ok.length, warnings: issues.length } };
    });

    // ── Command API (execute slash commands from UI) ──────────────────
    this.app.post<{ Body: { command: string; sessionId?: string } }>('/api/command', async (req) => {
      const sessionId = req.body.sessionId || `webchat:api:${Date.now()}`;
      const result = await this.agent.handleCommand(sessionId, req.body.command);
      return { result: result || 'Unknown command', sessionId };
    });

    // ── Tool load/unload API ─────────────────────────────────────────
    this.app.post<{ Body: { name: string; sessionId?: string } }>('/api/tools/load', async (req) => {
      const sessionId = req.body.sessionId || 'webchat:api:default';
      const view = this.agent.getToolRegistry().getSessionView(sessionId);
      const result = view.promote(req.body.name);
      this.broadcastDataUpdate('tools');
      return result;
    });

    this.app.post<{ Body: { name: string; sessionId?: string } }>('/api/tools/unload', async (req) => {
      const sessionId = req.body.sessionId || 'webchat:api:default';
      const view = this.agent.getToolRegistry().getSessionView(sessionId);
      const result = view.demote(req.body.name);
      this.broadcastDataUpdate('tools');
      return result;
    });

    // ── Models API ───────────────────────────────────────────────────
    this.app.get('/api/models', async () => {
      const llm = this.agent.getLLM();
      return { providers: llm.listProviders(), current: llm.getCurrentProvider() };
    });

    this.app.post<{ Body: { name: string } }>('/api/models/switch', async (req) => {
      const llm = this.agent.getLLM();
      const result = llm.switchModel(req.body.name);
      return result;
    });

    // ── ClawHub API ───────────────────────────────────────────────────
    this.app.get('/api/clawhub/browse', async () => {
      const skills = await fetchRegistry();
      return { skills };
    });

    this.app.get<{ Querystring: { q?: string } }>('/api/clawhub/search', async (req) => {
      const q = (req.query as any).q || '';
      if (!q) return { skills: await fetchRegistry() };
      const skills = await searchSkills(q);
      return { skills };
    });

    this.app.post<{ Body: { repo: string } }>('/api/clawhub/preview', async (req) => {
      const fetched = await fetchSkillContent(req.body.repo);
      if ('error' in fetched) return { error: fetched.error };
      const vet = vetSkillContent(fetched.content);
      return { repo: fetched.repo, content: fetched.content, vet };
    });

    this.app.post<{ Body: { repo: string } }>('/api/clawhub/install', async (req) => {
      const skillsDir = this.config.skills.directory;
      const result = await installSkill(req.body.repo, skillsDir);
      if (result.success) this.broadcastDataUpdate('skills');
      return result;
    });

    this.app.post<{ Body: { name: string } }>('/api/clawhub/uninstall', async (req) => {
      const skillsDir = this.config.skills.directory;
      const result = uninstallSkill(req.body.name, skillsDir);
      if (result.success) this.broadcastDataUpdate('skills');
      return result;
    });

    this.app.post<{ Body: { name?: string; all?: boolean } }>('/api/clawhub/update', async (req) => {
      const skillsDir = this.config.skills.directory;
      if (req.body.all) {
        const result = await updateAllSkills(skillsDir);
        this.broadcastDataUpdate('skills');
        return result;
      }
      if (!req.body.name) return { success: false, error: 'name or all=true required' };
      const result = await updateSkill(req.body.name, skillsDir);
      if (result.success) this.broadcastDataUpdate('skills');
      return result;
    });

    this.app.get('/api/clawhub/installed', async () => {
      const skillsDir = this.config.skills.directory;
      const installed = listInstalled(skillsDir);
      return { installed };
    });

    // ── Agents API ────────────────────────────────────────────────────
    this.app.get('/api/agents', async () => {
      if (!this.router) {
        return { agents: [], defaultAgent: null, message: 'Multi-agent router not active' };
      }
      const all = this.router.getAllAgents();
      const defaultAgent = this.router.getDefaultAgent();
      return {
        agents: all.map(m => ({
          name: m.name,
          channels: m.channels,
          allowFrom: m.allowFrom,
          isDefault: defaultAgent?.name === m.name,
          model: m.agent.getConfig().agent.model,
          sessionCount: m.sessionManager.listSessions().length,
        })),
        defaultAgent: defaultAgent?.name || null,
      };
    });

    this.app.post<{ Body: AgentProfile }>('/api/agents', async (req, reply) => {
      if (!this.router) {
        return reply.code(400).send({ error: 'Multi-agent router not active. Configure agents in config.' });
      }
      const profile = req.body;
      if (!profile.name) {
        return reply.code(400).send({ error: 'Agent name is required' });
      }
      if (this.router.getAgent(profile.name)) {
        return reply.code(409).send({ error: `Agent "${profile.name}" already exists` });
      }
      try {
        await this.router.initAgents([profile]);
        this.broadcastDataUpdate('agents');
        return { ok: true, name: profile.name };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message || 'Failed to create agent' });
      }
    });

    this.app.post<{ Body: { name: string } }>('/api/agents/default', async (req, reply) => {
      if (!this.router) {
        return reply.code(400).send({ error: 'Multi-agent router not active' });
      }
      const { name } = req.body;
      const agent = this.router.getAgent(name);
      if (!agent) {
        return reply.code(404).send({ error: `Agent "${name}" not found` });
      }
      // Use the router's internal default switch (via handleCommand)
      const result = await this.router.handleCommand('system', `/agents switch ${name}`);
      this.broadcastDataUpdate('agents');
      return { ok: true, message: result };
    });

    this.app.delete<{ Params: { name: string } }>('/api/agents/:name', async (req, reply) => {
      if (!this.router) {
        return reply.code(400).send({ error: 'Multi-agent router not active' });
      }
      const { name } = req.params;
      const agent = this.router.getAgent(name);
      if (!agent) {
        return reply.code(404).send({ error: `Agent "${name}" not found` });
      }
      // Shut down the agent's resources
      if (agent.scheduler) agent.scheduler.stop();
      agent.skillsLoader.stopWatching();
      agent.sessionManager.saveAll();
      // Remove from router (we need to add this method or use internal map)
      (this.router as any).agents?.delete(name);
      this.broadcastDataUpdate('agents');
      return { ok: true };
    });

    // ── Plugin Unload API ─────────────────────────────────────────────
    this.app.post<{ Body: { name: string } }>('/api/plugins/unload', async (req, reply) => {
      const pm = this.agent.getPluginManager();
      if (!pm) return reply.code(400).send({ error: 'Plugin manager not available' });
      try {
        const result = await pm.unloadPlugin(req.body.name);
        if (result) {
          this.agent.refreshPluginTools();
          this.broadcastDataUpdate('plugins', pm.getPlugins());
          return { ok: true, name: req.body.name };
        }
        return reply.code(404).send({ error: `Plugin "${req.body.name}" not found or already unloaded` });
      } catch (err: any) {
        return reply.code(400).send({ error: err.message || 'Failed to unload plugin' });
      }
    });
  }

  private registerWebSocket(): void {
    this.app.get('/ws', { websocket: true }, (socket, req) => {
      const clientId = `webchat:ws:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Use main session if set, otherwise create a new one per client
      const mainId = this.sessionManager.getMainSessionId();
      let sessionId = mainId || `webchat:${clientId}`;

      this.webChatClients.set(clientId, {
        ws: socket as unknown as WebSocket,
        sessionId,
        connectedAt: new Date().toISOString(),
      });

      // Send welcome with presence state + processing flag
      const isProcessing = this.agent.isProcessing(sessionId);
      socket.send(JSON.stringify({
        type: 'connected',
        session_id: sessionId,
        client_id: clientId,
        presence: this.presenceManager.getState(),
        context: this.getContextInfo(sessionId),
        processing: isProcessing,
      }));

      // If connecting to an existing session with messages, send history immediately
      const existingSession = this.sessionManager.getSession(sessionId);
      if (existingSession && existingSession.messages.length > 0) {
        socket.send(JSON.stringify({
          type: 'session_loaded',
          session_id: sessionId,
          messages: this.mapSessionMessages(existingSession.messages),
          context: this.getContextInfo(sessionId),
        }));
      }

      socket.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'message') {
            const content = msg.content as string;

            // Check commands — route through router if available
            if (content.startsWith('/')) {
              const cmdResult = this.router
                ? await this.router.handleCommand(sessionId, content)
                : await this.agent.handleCommand(sessionId, content);
              if (cmdResult) {
                socket.send(JSON.stringify({ type: 'response', content: cmdResult, done: true }));
                return;
              }
            }

            // Stream response — route through router if available
            const onStream = (chunk: string) => {
              socket.send(JSON.stringify({ type: 'stream', content: chunk }));
            };
            const onToolCall = (tc: { name: string; arguments?: string; result: string }) => {
              socket.send(JSON.stringify({ type: 'tool_call', name: tc.name, arguments: tc.arguments, result: tc.result }));
            };
            const result = this.router
              ? await this.router.processMessage(sessionId, content, onStream)
              : await this.agent.processMessage(sessionId, content, onStream, onToolCall);

            // Send completion
            socket.send(JSON.stringify({
              type: 'response',
              content: result.content,
              tool_calls: result.toolCalls,
              usage: result.usage,
              context: this.getContextInfo(sessionId),
              done: true,
            }));
          }

          // User typing indicator — broadcast to other clients
          if (msg.type === 'typing') {
            const typingMsg = JSON.stringify({
              type: 'user_typing',
              active: msg.active,
              clientId,
              sessionId,
              timestamp: Date.now(),
            });
            for (const [id, client] of this.webChatClients) {
              if (id !== clientId) {
                try { client.ws.send(typingMsg); } catch {}
              }
            }
          }

          if (msg.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong' }));
          }

          // Interrupt/abort a currently streaming response
          if (msg.type === 'interrupt') {
            const aborted = this.router
              ? this.router.interruptSession(sessionId)
              : this.agent.interruptSession(sessionId);
            socket.send(JSON.stringify({
              type: 'interrupted',
              session_id: sessionId,
              aborted,
            }));
          }

          // Load/resume an existing session
          if (msg.type === 'load_session') {
            const targetId = msg.session_id as string;
            const session = this.sessionManager.getSession(targetId);
            if (!session) {
              socket.send(JSON.stringify({ type: 'error', message: `Session not found: ${targetId}` }));
              return;
            }
            // Update this client's sessionId to the loaded session
            const client = this.webChatClients.get(clientId);
            if (client) client.sessionId = targetId;
            sessionId = targetId;
            // Send session history back to client
            // Include tool_calls metadata for assistant messages so UI can render them
            // Pair tool-role results with their parent assistant tool_calls
            socket.send(JSON.stringify({
              type: 'session_loaded',
              session_id: targetId,
              messages: this.mapSessionMessages(session.messages),
              context: this.getContextInfo(targetId),
            }));
          }

          // Delete a message and its associated responses
          if (msg.type === 'delete_message') {
            const index = msg.index as number;
            const deleted = this.sessionManager.deleteMessageAt(sessionId, index);
            const session = this.sessionManager.getSession(sessionId);
            socket.send(JSON.stringify({
              type: 'messages_updated',
              session_id: sessionId,
              messages: session ? this.mapSessionMessages(session.messages) : [],
              context: this.getContextInfo(sessionId),
              deleted_count: deleted.length,
            }));
          }

          // Edit a message's content
          if (msg.type === 'edit_message') {
            const index = msg.index as number;
            const content = msg.content as string;
            const success = this.sessionManager.editMessageAt(sessionId, index, content);
            const session = this.sessionManager.getSession(sessionId);
            socket.send(JSON.stringify({
              type: 'messages_updated',
              session_id: sessionId,
              messages: session ? this.mapSessionMessages(session.messages) : [],
              context: this.getContextInfo(sessionId),
              success,
            }));
          }

          // Retry a message - regenerate response using context up to that point
          if (msg.type === 'retry_message') {
            const index = msg.index as number;
            const session = this.sessionManager.getSession(sessionId);
            if (!session || index < 0 || index >= session.messages.length) {
              socket.send(JSON.stringify({ type: 'error', message: 'Invalid message index' }));
              return;
            }

            const targetMsg = session.messages[index];
            
            // For user messages: re-send the user message
            // For assistant messages: re-send the previous user message
            let userMsgIndex = index;
            let userContent = targetMsg.content;
            
            if (targetMsg.role === 'assistant') {
              // Find the user message before this assistant message
              userMsgIndex = index - 1;
              while (userMsgIndex >= 0 && session.messages[userMsgIndex].role !== 'user') {
                userMsgIndex--;
              }
              if (userMsgIndex < 0) {
                socket.send(JSON.stringify({ type: 'error', message: 'No user message found before this response' }));
                return;
              }
              userContent = session.messages[userMsgIndex].content || '';
            }

            // Find where the response ends (next user message or end)
            let endIndex = userMsgIndex + 1;
            while (endIndex < session.messages.length && session.messages[endIndex].role !== 'user') {
              endIndex++;
            }

            // Store messages after the response we're regenerating (to preserve them)
            const messagesAfter = session.messages.slice(endIndex);

            // Delete from userMsgIndex+1 to endIndex (the old response)
            session.messages.splice(userMsgIndex + 1, endIndex - userMsgIndex - 1);
            this.sessionManager.saveSession(sessionId);

            // Now regenerate the response
            const result = this.router
              ? await this.router.processMessage(sessionId, userContent, (chunk) => {
                  socket.send(JSON.stringify({ type: 'stream', content: chunk }));
                })
              : await this.agent.processMessage(sessionId, userContent, (chunk) => {
                  socket.send(JSON.stringify({ type: 'stream', content: chunk }));
                });

            // Re-add the messages that were after the regenerated response
            for (const msg of messagesAfter) {
              this.sessionManager.addMessage(sessionId, msg);
            }

            // Send completion with updated messages
            const updatedSession = this.sessionManager.getSession(sessionId);
            socket.send(JSON.stringify({
              type: 'retry_complete',
              session_id: sessionId,
              content: result.content,
              tool_calls: result.toolCalls,
              usage: result.usage,
              messages: updatedSession ? this.mapSessionMessages(updatedSession.messages) : [],
              context: this.getContextInfo(sessionId),
            }));
          }
        } catch (err) {
          socket.send(JSON.stringify({ type: 'error', message: String(err) }));
        }
      });

      socket.on('close', () => {
        this.webChatClients.delete(clientId);
        this.sessionManager.saveSession(sessionId);
      });
    });
  }

  private registerCanvasWebSocket(): void {
    this.app.get('/ws/canvas', { websocket: true }, (socket, req) => {
      const clientId = `canvas:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      this.canvasClients.set(clientId, {
        ws: socket as unknown as WebSocket,
        connectedAt: new Date().toISOString(),
      });

      socket.send(JSON.stringify({
        type: 'connected',
        client_id: clientId,
        canvases: getAllCanvases().map(c => ({
          id: c.id,
          title: c.title,
          content: c.content,
          contentType: c.contentType,
          language: c.language,
        })),
      }));

      socket.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong' }));
          }
        } catch {}
      });

      socket.on('close', () => {
        this.canvasClients.delete(clientId);
      });
    });
  }

  /** Map raw session messages to a client-friendly format, pairing tool results with assistant tool_calls. */
  private mapSessionMessages(messages: any[]): any[] {
    // Build a map of tool_call_id → result content from tool-role messages
    const toolResults = new Map<string, string>();
    for (const m of messages) {
      if (m.role === 'tool' && m.tool_call_id) {
        toolResults.set(m.tool_call_id, m.content || '');
      }
    }

    return messages
      .map((m, idx) => ({ m, idx }))
      .filter(({ m }) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
      .map(({ m, idx }) => {
        const mapped: any = { role: m.role, content: m.content || '', serverIndex: idx };
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
          mapped.tool_calls = m.tool_calls.map((tc: any) => ({
            name: tc.function?.name || tc.function,
            arguments: tc.function?.arguments || '',
            result: toolResults.get(tc.id) || '',
          }));
        }
        return mapped;
      });
  }

  private broadcastDataUpdate(resource: string, data?: any): void {
    const msg = JSON.stringify({ type: 'data_update', resource, data });
    for (const [, client] of this.webChatClients) {
      try { client.ws.send(msg); } catch {}
    }
  }

  async stop(): Promise<void> {
    this.presenceManager.shutdown();
    this.sessionManager.saveAll();
    await this.app.close();
  }

  /** Broadcast a raw JSON message to all connected WebSocket chat clients. */
  broadcastToAll(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    for (const [, client] of this.webChatClients) {
      try { client.ws.send(data); } catch {}
    }
  }
}