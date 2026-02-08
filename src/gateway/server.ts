import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config/schema.js';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from './session-manager.js';
import type { WebSocket } from 'ws';

interface WebChatClient {
  ws: WebSocket;
  sessionId: string;
  connectedAt: string;
}

export class GatewayServer {
  private app = Fastify({ logger: false });
  private config: Config;
  private agent: Agent;
  private sessionManager: SessionManager;
  private webChatClients: Map<string, WebChatClient> = new Map();
  private startTime = Date.now();

  constructor(config: Config, agent: Agent, sessionManager: SessionManager) {
    this.config = config;
    this.agent = agent;
    this.sessionManager = sessionManager;
  }

  async start(): Promise<void> {
    await this.app.register(fastifyCors, { origin: true });
    await this.app.register(fastifyWebsocket);

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

    // Config (read only for safety)
    this.app.get('/api/config', async () => ({
      config: {
        agent: { model: this.config.agent.model, maxTokens: this.config.agent.maxTokens },
        gateway: { port: this.config.gateway.port },
        channels: { discord: { enabled: this.config.channels.discord.enabled } },
        browser: this.config.browser,
      },
    }));

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

    // Status
    this.app.get('/api/status', async () => ({
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      sessions: this.sessionManager.listSessions().length,
      webchat_clients: this.webChatClients.size,
      model: this.config.agent.model,
    }));
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

      // Send welcome
      socket.send(JSON.stringify({
        type: 'connected',
        session_id: sessionId,
        client_id: clientId,
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

            // Send typing indicator
            socket.send(JSON.stringify({ type: 'typing', active: true }));

            // Stream response
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

  async stop(): Promise<void> {
    this.sessionManager.saveAll();
    await this.app.close();
  }
}
