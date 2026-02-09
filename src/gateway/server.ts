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
import type { WebSocket } from 'ws';
import { setCanvasBroadcaster, getCanvas, getAllCanvases, type CanvasEvent } from '../canvas/canvas-manager.js';
import { setImageBroadcaster, type ImageEvent } from '../agent/tools/image-send.js';
import { PresenceManager, type PresenceEvent, type TypingEvent } from './presence.js';

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
      this.sessionManager.resetSession(req.params.id);
      return { ok: true };
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
        const cmdResult = this.agent.handleCommand(sessionId, message);
        if (cmdResult) return { response: cmdResult, session_id: sessionId };
      }

      const result = await this.agent.processMessage(sessionId, message);
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
  }

  private registerWebSocket(): void {
    this.app.get('/ws', { websocket: true }, (socket, req) => {
      const clientId = `webchat:ws:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sessionId = `webchat:${clientId}`;

      this.webChatClients.set(clientId, {
        ws: socket as unknown as WebSocket,
        sessionId,
        connectedAt: new Date().toISOString(),
      });

      // Send welcome with presence state
      socket.send(JSON.stringify({
        type: 'connected',
        session_id: sessionId,
        client_id: clientId,
        presence: this.presenceManager.getState(),
      }));

      socket.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'message') {
            const content = msg.content as string;

            // Check commands
            if (content.startsWith('/')) {
              const cmdResult = this.agent.handleCommand(sessionId, content);
              if (cmdResult) {
                socket.send(JSON.stringify({ type: 'response', content: cmdResult, done: true }));
                return;
              }
            }

            // Stream response (typing indicator is now handled by PresenceManager)
            const result = await this.agent.processMessage(sessionId, content, (chunk) => {
              socket.send(JSON.stringify({ type: 'stream', content: chunk }));
            });

            // Send completion
            socket.send(JSON.stringify({
              type: 'response',
              content: result.content,
              tool_calls: result.toolCalls,
              usage: result.usage,
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

  async stop(): Promise<void> {
    this.presenceManager.shutdown();
    this.sessionManager.saveAll();
    await this.app.close();
  }
}
