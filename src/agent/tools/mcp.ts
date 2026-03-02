import { spawn, type ChildProcess } from 'node:child_process';
import type { Tool } from '../tool-registry.js';
import { getCurrentConfig, saveConfig, getConfigPath } from '../../config/loader.js';

type MCPTransport = 'stdio' | 'sse' | 'http';

interface MCPServerConfig {
  name: string;
  enabled?: boolean;
  description?: string;
  transport?: MCPTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

interface MCPRuntimeState {
  process?: ChildProcess;
  stdout: string;
  stderr: string;
  startedAt: number;
  exitCode: number | null;
  remoteHealthy?: boolean;
  remoteStatus?: number;
  lastCheckAt?: number;
}

const mcpConfigs: Map<string, MCPServerConfig> = new Map();
const mcpRuntime: Map<string, MCPRuntimeState> = new Map();
const MAX_LOG_BUFFER = 100 * 1024;

function asTransport(value?: string): MCPTransport {
  if (value === 'sse' || value === 'http') return value;
  return 'stdio';
}

function normalizeServer(server: MCPServerConfig): MCPServerConfig {
  return {
    name: server.name,
    enabled: server.enabled !== false,
    description: server.description,
    transport: asTransport(server.transport),
    command: server.command,
    args: Array.isArray(server.args) ? server.args : [],
    env: server.env || {},
    url: server.url,
  };
}

/** Apply MCP config updates at runtime. */
export function setMCPConfig(config?: { servers?: MCPServerConfig[] }): void {
  const next = new Map<string, MCPServerConfig>();
  for (const raw of config?.servers || []) {
    if (!raw?.name) continue;
    next.set(raw.name, normalizeServer(raw));
  }

  // Stop/remove runtime entries for servers no longer configured
  for (const [name, state] of mcpRuntime.entries()) {
    if (next.has(name)) continue;
    if (state.process && state.exitCode === null) {
      try { state.process.kill('SIGTERM'); } catch {}
    }
    mcpRuntime.delete(name);
  }

  mcpConfigs.clear();
  for (const [name, server] of next.entries()) {
    mcpConfigs.set(name, server);
  }
}

function getServer(name?: string): MCPServerConfig | undefined {
  if (!name) return undefined;
  return mcpConfigs.get(name);
}

function formatRuntime(name: string, server: MCPServerConfig): string {
  const state = mcpRuntime.get(name);
  if (!state) return `${name} [${server.transport}] ${server.enabled === false ? 'disabled' : 'idle'}`;
  if (state.process) {
    const running = state.exitCode === null;
    return `${name} [stdio] ${running ? `running (pid ${state.process.pid})` : `exited (${state.exitCode})`}`;
  }
  if (typeof state.remoteHealthy === 'boolean') {
    const status = state.remoteHealthy ? 'reachable' : 'unreachable';
    return `${name} [${server.transport}] ${status}${state.remoteStatus ? ` (HTTP ${state.remoteStatus})` : ''}`;
  }
  return `${name} [${server.transport}] idle`;
}

function trimTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

async function probeRemote(url: string): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body: body.slice(0, 500) };
  } finally {
    clearTimeout(timeout);
  }
}

async function startServer(name: string, server: MCPServerConfig, workdir: string): Promise<string> {
  if (server.transport === 'stdio') {
    if (!server.command) throw new Error(`MCP server "${name}" is stdio but has no command configured.`);
    const existing = mcpRuntime.get(name);
    if (existing?.process && existing.exitCode === null) {
      return `MCP server "${name}" is already running (PID ${existing.process.pid}).`;
    }
    const child = spawn(server.command, server.args || [], {
      cwd: workdir,
      env: { ...process.env, ...(server.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const state: MCPRuntimeState = {
      process: child,
      stdout: '',
      stderr: '',
      startedAt: Date.now(),
      exitCode: null,
    };
    mcpRuntime.set(name, state);

    child.stdout?.on('data', (chunk: Buffer) => {
      state.stdout += chunk.toString();
      state.stdout = trimTail(state.stdout, MAX_LOG_BUFFER);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      state.stderr += chunk.toString();
      state.stderr = trimTail(state.stderr, MAX_LOG_BUFFER);
    });
    child.on('exit', (code) => {
      state.exitCode = code;
    });

    return `Started MCP server "${name}" (PID ${child.pid}).`;
  }

  if (!server.url) throw new Error(`MCP server "${name}" requires a URL for ${server.transport} transport.`);
  const check = await probeRemote(server.url);
  mcpRuntime.set(name, {
    stdout: '',
    stderr: '',
    startedAt: Date.now(),
    exitCode: null,
    remoteHealthy: check.ok,
    remoteStatus: check.status,
    lastCheckAt: Date.now(),
  });
  return `Remote MCP server "${name}" check: ${check.ok ? 'reachable' : 'unreachable'} (HTTP ${check.status}).`;
}

function stopServer(name: string): string {
  const state = mcpRuntime.get(name);
  if (!state) return `MCP server "${name}" is not running.`;
  if (state.process && state.exitCode === null) {
    try {
      state.process.kill('SIGTERM');
      mcpRuntime.delete(name);
      return `Stopped MCP server "${name}".`;
    } catch (err) {
      return `Failed to stop MCP server "${name}": ${(err as Error).message}`;
    }
  }
  mcpRuntime.delete(name);
  return `Cleared runtime state for MCP server "${name}".`;
}

export const mcpTools: Tool[] = [
  {
    name: 'mcp',
    description: 'Manage MCP servers at runtime (list, add, remove, start, stop, restart, status, logs, test).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove', 'start', 'stop', 'restart', 'status', 'logs', 'test'],
          description: 'Action to perform.',
        },
        name: { type: 'string', description: 'MCP server name (required for most actions).' },
        transport: { type: 'string', enum: ['stdio', 'sse', 'http'], description: 'Transport type (for add, default: stdio).' },
        command: { type: 'string', description: 'Command to run (for add, stdio transport).' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (for add).' },
        url: { type: 'string', description: 'Server URL (for add, sse/http transport).' },
        env: { type: 'object', description: 'Environment variables (for add).' },
        server_description: { type: 'string', description: 'Description of the server (for add).' },
        tail: { type: 'number', description: 'Tail size for logs action (default 4000 chars).' },
      },
      required: ['action'],
    },
    async execute(params, ctx) {
      const action = String(params.action || '');
      const name = params.name ? String(params.name) : undefined;

      if (action === 'list') {
        if (mcpConfigs.size === 0) return { output: 'No MCP servers configured.' };
        const lines = ['Configured MCP servers:'];
        for (const [serverName, server] of mcpConfigs.entries()) {
          lines.push(`- ${formatRuntime(serverName, server)}`);
        }
        return { output: lines.join('\n') };
      }

      if (action === 'add') {
        if (!name) return { output: '', error: 'Action "add" requires a server name.' };
        if (mcpConfigs.has(name)) return { output: '', error: `MCP server "${name}" already exists. Remove it first or use a different name.` };
        const newServer = normalizeServer({
          name,
          transport: asTransport(params.transport as string),
          command: params.command as string,
          args: params.args as string[],
          url: params.url as string,
          env: params.env as Record<string, string>,
          description: params.server_description as string,
        });
        mcpConfigs.set(name, newServer);
        // Persist to config
        try {
          const config = getCurrentConfig();
          if (config) {
            const servers = [...(config.mcp?.servers || []), newServer];
            (config as any).mcp = { ...config.mcp, servers };
            saveConfig(config);
          }
        } catch {}
        return { output: `MCP server "${name}" added (${newServer.transport}). Use action="start" to launch it.` };
      }

      if (action === 'remove') {
        if (!name) return { output: '', error: 'Action "remove" requires a server name.' };
        if (!mcpConfigs.has(name)) return { output: '', error: `MCP server "${name}" not found.` };
        // Stop if running
        const state = mcpRuntime.get(name);
        if (state?.process && state.exitCode === null) {
          try { state.process.kill('SIGTERM'); } catch {}
        }
        mcpRuntime.delete(name);
        mcpConfigs.delete(name);
        // Persist removal
        try {
          const config = getCurrentConfig();
          if (config) {
            const servers = (config.mcp?.servers || []).filter((s: any) => s.name !== name);
            (config as any).mcp = { ...config.mcp, servers };
            saveConfig(config);
          }
        } catch {}
        return { output: `MCP server "${name}" removed.` };
      }

      if (!name) {
        return { output: '', error: `Action "${action}" requires a server name.` };
      }
      const server = getServer(name);
      if (!server) {
        return { output: '', error: `MCP server "${name}" not found in config.` };
      }
      if (server.enabled === false && action !== 'status' && action !== 'logs' && action !== 'list') {
        return { output: '', error: `MCP server "${name}" is disabled in config.` };
      }

      try {
        switch (action) {
          case 'start':
            return { output: await startServer(name, server, ctx.workdir) };
          case 'stop':
            return { output: stopServer(name) };
          case 'restart':
            stopServer(name);
            return { output: await startServer(name, server, ctx.workdir) };
          case 'status': {
            return { output: formatRuntime(name, server) };
          }
          case 'logs': {
            const state = mcpRuntime.get(name);
            if (!state) return { output: `No runtime logs for MCP server "${name}".` };
            const tail = Math.max(200, Number(params.tail) || 4000);
            const stdout = trimTail(state.stdout || '', tail);
            const stderr = trimTail(state.stderr || '', tail);
            const sections = [`Logs for MCP server "${name}":`];
            sections.push(stdout ? `\n--- stdout ---\n${stdout}` : '\n--- stdout ---\n(no output)');
            sections.push(stderr ? `\n--- stderr ---\n${stderr}` : '\n--- stderr ---\n(no output)');
            return { output: sections.join('') };
          }
          case 'test': {
            if (server.transport === 'stdio') {
              const state = mcpRuntime.get(name);
              if (state?.process && state.exitCode === null) {
                return { output: `MCP stdio server "${name}" is running (PID ${state.process.pid}).` };
              }
              return { output: `MCP stdio server "${name}" is not running. Use action="start".` };
            }
            if (!server.url) return { output: '', error: `MCP server "${name}" has no URL configured.` };
            const check = await probeRemote(server.url);
            mcpRuntime.set(name, {
              stdout: '',
              stderr: '',
              startedAt: Date.now(),
              exitCode: null,
              remoteHealthy: check.ok,
              remoteStatus: check.status,
              lastCheckAt: Date.now(),
            });
            return {
              output: `MCP server "${name}" ${check.ok ? 'is reachable' : 'is not reachable'} (HTTP ${check.status}).${check.body ? `\nPreview: ${check.body}` : ''}`,
            };
          }
          default:
            return { output: '', error: `Unknown action "${action}".` };
        }
      } catch (err) {
        return { output: '', error: (err as Error).message };
      }
    },
  },
];
