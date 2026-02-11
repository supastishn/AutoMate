/**
 * Plugin SDK — formal extension architecture for AutoMate.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Tool, ToolContext } from '../agent/tool-registry.js';
import type { Config } from '../config/schema.js';

// ── Plugin Interfaces ────────────────────────────────────────────────────

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  type: 'tools' | 'channel' | 'middleware' | 'mixed';
  entry: string;
  dependencies?: string[];
  config?: Record<string, { type: string; description: string; default?: unknown; required?: boolean }>;
}

export interface PluginContext {
  config: Config;
  pluginDir: string;
  pluginConfig: Record<string, unknown>;
  log: (msg: string) => void;
  events: {
    emit(event: string, ...args: any[]): void;
    on(event: string, handler: (...args: any[]) => void): void;
    off(event: string, handler: (...args: any[]) => void): void;
  };
  services?: {
    memory?: any;
    sessions?: any;
    scheduler?: any;
  };
}

export interface PluginExports {
  activate(ctx: PluginContext): Promise<PluginActivation> | PluginActivation;
  deactivate?(): Promise<void> | void;
}

export interface PluginActivation {
  tools?: Tool[];
  channel?: PluginChannel;
  middleware?: PluginMiddleware;
  onMessage?: (sessionId: string, message: string) => void;
  // Lifecycle hooks
  onSessionStart?(sessionId: string): void;
  onSessionEnd?(sessionId: string): void;
  onToolCall?(toolName: string, params: Record<string, unknown>): void;
  onToolResult?(toolName: string, result: string): void;
  onCompact?(sessionId: string): void;
}

export interface PluginChannel {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send?(sessionId: string, message: string): Promise<void>;
}

export interface PluginMiddleware {
  beforeMessage?(sessionId: string, message: string): Promise<string | null> | string | null;
  afterResponse?(sessionId: string, response: string): Promise<string> | string;
}

// ── Loaded Plugin ────────────────────────────────────────────────────────

export interface LoadedPlugin {
  manifest: PluginManifest;
  activation: PluginActivation;
  exports: PluginExports;
  directory: string;
  tools: Tool[];
  channel?: PluginChannel;
  middleware?: PluginMiddleware;
}

// ── Plugin Manager ───────────────────────────────────────────────────────

export class PluginManager {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private pluginsDir: string;
  private config: Config;

  // Event bus
  private eventBus: Map<string, Set<(...args: any[]) => void>> = new Map();

  // Core service refs (set externally)
  private coreServices: { memory?: any; sessions?: any; scheduler?: any } = {};

  // Hot-reload watcher
  private watcher: FSWatcher | null = null;
  private dirtyPlugins: Set<string> = new Set();
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(config: Config, pluginsDir?: string) {
    this.config = config;
    this.pluginsDir = pluginsDir || config.plugins?.directory || join(homedir(), '.automate', 'plugins');
    if (!existsSync(this.pluginsDir)) mkdirSync(this.pluginsDir, { recursive: true });
  }

  // ── Core service injection ──────────────────────────────────────────

  setCoreServices(memory?: any, sessions?: any, scheduler?: any): void {
    this.coreServices = { memory, sessions, scheduler };
  }

  // ── Event bus ───────────────────────────────────────────────────────

  emit(event: string, ...args: any[]): void {
    const handlers = this.eventBus.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(...args); } catch (err) {
        console.error(`[plugin:event] Error in handler for "${event}":`, (err as Error).message);
      }
    }
  }

  on(event: string, handler: (...args: any[]) => void): void {
    if (!this.eventBus.has(event)) this.eventBus.set(event, new Set());
    this.eventBus.get(event)!.add(handler);
  }

  off(event: string, handler: (...args: any[]) => void): void {
    this.eventBus.get(event)?.delete(handler);
  }

  // ── Lifecycle hook firers ───────────────────────────────────────────

  fireSessionStart(sessionId: string): void {
    for (const p of this.plugins.values()) {
      try { p.activation.onSessionStart?.(sessionId); } catch {}
    }
    this.emit('session:start', sessionId);
  }

  fireSessionEnd(sessionId: string): void {
    for (const p of this.plugins.values()) {
      try { p.activation.onSessionEnd?.(sessionId); } catch {}
    }
    this.emit('session:end', sessionId);
  }

  fireToolCall(toolName: string, params: Record<string, unknown>): void {
    for (const p of this.plugins.values()) {
      try { p.activation.onToolCall?.(toolName, params); } catch {}
    }
    this.emit('tool:call', toolName, params);
  }

  fireToolResult(toolName: string, result: string): void {
    for (const p of this.plugins.values()) {
      try { p.activation.onToolResult?.(toolName, result); } catch {}
    }
    this.emit('tool:result', toolName, result);
  }

  fireCompact(sessionId: string): void {
    for (const p of this.plugins.values()) {
      try { p.activation.onCompact?.(sessionId); } catch {}
    }
    this.emit('session:compact', sessionId);
  }

  // ── Config storage ──────────────────────────────────────────────────

  private getConfigPath(pluginName: string): string {
    return join(this.pluginsDir, pluginName, 'config.json');
  }

  loadPluginConfig(name: string): Record<string, unknown> {
    const configPath = this.getConfigPath(name);
    let stored: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try { stored = JSON.parse(readFileSync(configPath, 'utf-8')); } catch {}
    }

    // Merge with defaults from manifest
    const plugin = this.plugins.get(name);
    const schema = plugin?.manifest.config;
    if (schema) {
      for (const [key, def] of Object.entries(schema)) {
        if (!(key in stored) && def.default !== undefined) {
          stored[key] = def.default;
        }
      }
    }

    return stored;
  }

  savePluginConfig(name: string, config: Record<string, unknown>): { success: boolean; errors?: string[] } {
    const plugin = this.plugins.get(name);
    const schema = plugin?.manifest.config;
    const errors: string[] = [];

    // Basic type validation against manifest schema
    if (schema) {
      for (const [key, def] of Object.entries(schema)) {
        if (def.required && !(key in config)) {
          errors.push(`Missing required config key: ${key}`);
        }
        if (key in config && def.type) {
          const actual = typeof config[key];
          if (def.type === 'number' && actual !== 'number') errors.push(`${key}: expected number, got ${actual}`);
          if (def.type === 'string' && actual !== 'string') errors.push(`${key}: expected string, got ${actual}`);
          if (def.type === 'boolean' && actual !== 'boolean') errors.push(`${key}: expected boolean, got ${actual}`);
        }
      }
    }

    if (errors.length > 0) return { success: false, errors };

    const configPath = this.getConfigPath(name);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return { success: true };
  }

  private getPluginConfig(pluginName: string): Record<string, unknown> {
    return this.loadPluginConfig(pluginName);
  }

  // ── Dependency resolution ───────────────────────────────────────────

  private resolveDependencyOrder(dirNames: string[]): string[] {
    // Read manifests to build dep graph
    const manifests = new Map<string, PluginManifest>();
    for (const name of dirNames) {
      const manifestPath = join(this.pluginsDir, name, 'plugin.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const m: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        manifests.set(m.name, m);
      } catch {}
    }

    // Topological sort (Kahn's algorithm)
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();
    const nameToDir = new Map<string, string>();

    for (const name of dirNames) {
      const manifestPath = join(this.pluginsDir, name, 'plugin.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const m: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        nameToDir.set(m.name, name);
        if (!inDegree.has(m.name)) inDegree.set(m.name, 0);
        if (!adjList.has(m.name)) adjList.set(m.name, []);
        for (const dep of (m.dependencies || [])) {
          if (!adjList.has(dep)) adjList.set(dep, []);
          adjList.get(dep)!.push(m.name);
          inDegree.set(m.name, (inDegree.get(m.name) || 0) + 1);
          if (!inDegree.has(dep)) inDegree.set(dep, 0);
        }
      } catch {}
    }

    const queue: string[] = [];
    for (const [name, deg] of inDegree) {
      if (deg === 0) queue.push(name);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const dirName = nameToDir.get(current);
      if (dirName) sorted.push(dirName);
      for (const next of (adjList.get(current) || [])) {
        const newDeg = (inDegree.get(next) || 1) - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }
    }

    // Append any dirs not in the sorted list (no manifest / isolated)
    for (const d of dirNames) {
      if (!sorted.includes(d)) sorted.push(d);
    }

    return sorted;
  }

  // ── Load / unload ───────────────────────────────────────────────────

  async loadAll(): Promise<LoadedPlugin[]> {
    if (!existsSync(this.pluginsDir)) return [];
    const dirs = readdirSync(this.pluginsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const ordered = this.resolveDependencyOrder(dirs);
    const loaded: LoadedPlugin[] = [];
    for (const dir of ordered) {
      try { const plugin = await this.loadPlugin(dir); if (plugin) loaded.push(plugin); }
      catch (err) { console.error(`[plugin] Failed to load "${dir}": ${(err as Error).message}`); }
    }
    return loaded;
  }

  async loadPlugin(name: string): Promise<LoadedPlugin | null> {
    const pluginDir = join(this.pluginsDir, name);
    const manifestPath = join(pluginDir, 'plugin.json');
    if (!existsSync(manifestPath)) { console.warn(`[plugin] No plugin.json found in ${name}/`); return null; }
    const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const entryPath = join(pluginDir, manifest.entry);
    if (!existsSync(entryPath)) { console.error(`[plugin] Entry file not found: ${manifest.entry} in ${name}/`); return null; }

    const pluginModule = await import(entryPath) as PluginExports;
    const pluginConfig = this.getPluginConfig(manifest.name);
    const ctx: PluginContext = {
      config: this.config, pluginDir, pluginConfig,
      log: (msg: string) => console.log(`[plugin:${manifest.name}] ${msg}`),
      events: {
        emit: (event: string, ...args: any[]) => this.emit(event, ...args),
        on: (event: string, handler: (...args: any[]) => void) => this.on(event, handler),
        off: (event: string, handler: (...args: any[]) => void) => this.off(event, handler),
      },
      services: this.coreServices,
    };

    const activation = await pluginModule.activate(ctx);
    const loaded: LoadedPlugin = {
      manifest, activation, exports: pluginModule, directory: pluginDir,
      tools: activation.tools || [], channel: activation.channel, middleware: activation.middleware,
    };
    this.plugins.set(manifest.name, loaded);
    return loaded;
  }

  async unloadPlugin(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;
    if (plugin.channel) await plugin.channel.stop();
    if (plugin.exports.deactivate) await plugin.exports.deactivate();
    this.plugins.delete(name);
    return true;
  }

  // ── Hot-reload watching ─────────────────────────────────────────────

  startWatching(): void {
    if (this.watcher) return;
    if (!existsSync(this.pluginsDir)) return;
    try {
      this.watcher = watch(this.pluginsDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        // Extract plugin dir name from changed file path
        const pluginName = filename.split('/')[0] || filename.split('\\')[0];
        if (!pluginName) return;
        this.dirtyPlugins.add(pluginName);
        // Debounce: wait 500ms before reloading
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.reloadDirtyPlugins(), 500);
      });
    } catch {
      // recursive watch not supported on all platforms
    }
  }

  stopWatching(): void {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
  }

  private async reloadDirtyPlugins(): Promise<void> {
    const dirty = [...this.dirtyPlugins];
    this.dirtyPlugins.clear();
    for (const name of dirty) {
      try {
        // Unload if currently loaded
        const existing = [...this.plugins.entries()].find(([_, p]) => p.directory.endsWith(name));
        if (existing) {
          await this.unloadPlugin(existing[0]);
        }
        await this.loadPlugin(name);
        console.log(`[plugin] Hot-reloaded "${name}"`);
      } catch (err) {
        console.error(`[plugin] Hot-reload failed for "${name}": ${(err as Error).message}`);
      }
    }
    if (pluginReloadCallback) pluginReloadCallback();
  }

  // ── Query ───────────────────────────────────────────────────────────

  getPlugins(): LoadedPlugin[] { return Array.from(this.plugins.values()); }

  getAllTools(): Tool[] {
    const tools: Tool[] = [];
    for (const plugin of this.plugins.values()) tools.push(...plugin.tools);
    return tools;
  }

  getAllMiddleware(): PluginMiddleware[] {
    const mw: PluginMiddleware[] = [];
    for (const plugin of this.plugins.values()) if (plugin.middleware) mw.push(plugin.middleware);
    return mw;
  }

  getAllChannels(): PluginChannel[] {
    const channels: PluginChannel[] = [];
    for (const plugin of this.plugins.values()) if (plugin.channel) channels.push(plugin.channel);
    return channels;
  }

  async runBeforeMessage(sessionId: string, message: string): Promise<string | null> {
    let current: string | null = message;
    for (const plugin of this.plugins.values()) {
      if (plugin.middleware?.beforeMessage && current !== null) current = await plugin.middleware.beforeMessage(sessionId, current);
    }
    return current;
  }

  async runAfterResponse(sessionId: string, response: string): Promise<string> {
    let current = response;
    for (const plugin of this.plugins.values()) {
      if (plugin.middleware?.afterResponse) current = await plugin.middleware.afterResponse(sessionId, current);
    }
    return current;
  }

  static scaffold(pluginsDir: string, name: string, type: PluginManifest['type'] = 'tools'): string {
    const pluginDir = join(pluginsDir, name);
    if (existsSync(pluginDir)) throw new Error(`Plugin "${name}" already exists at ${pluginDir}`);
    mkdirSync(pluginDir, { recursive: true });

    const manifest: PluginManifest = {
      name, version: '0.1.0', description: `AutoMate plugin: ${name}`, type, entry: 'index.js',
      config: { enabled: { type: 'boolean', description: 'Enable this plugin', default: true } },
    };
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));

    let entryContent: string;
    if (type === 'tools') {
      entryContent = `// ${name} plugin - tools type
// Available in ctx:
//   ctx.config        - global AutoMate config
//   ctx.pluginDir     - this plugin's directory
//   ctx.pluginConfig  - plugin-specific config (from config.json, merged with manifest defaults)
//   ctx.log(msg)      - log with plugin prefix
//   ctx.events.emit/on/off - event bus for cross-plugin communication
//   ctx.services      - {memory, sessions, scheduler} core service references

export function activate(ctx) {
  ctx.log('Plugin activated');
  
  // Listen to events from other plugins or core
  ctx.events.on('custom:event', (data) => {
    ctx.log('Received custom event: ' + JSON.stringify(data));
  });

  return {
    tools: [{
      name: '${name}_example',
      description: 'Example tool from ${name}',
      parameters: { type: 'object', properties: { input: { type: 'string', description: 'Input text' } }, required: ['input'] },
      async execute(params) {
        // Emit event for other plugins
        ctx.events.emit('${name}:called', { input: params.input });
        return { output: 'Hello from ${name}: ' + params.input };
      },
    }],
    // Lifecycle hooks (all optional)
    onSessionStart(sessionId) { ctx.log('Session started: ' + sessionId); },
    onSessionEnd(sessionId) { ctx.log('Session ended: ' + sessionId); },
    onToolCall(toolName, params) { ctx.log('Tool called: ' + toolName); },
    onToolResult(toolName, result) { ctx.log('Tool result: ' + toolName); },
    onCompact(sessionId) { ctx.log('Session compacted: ' + sessionId); },
  };
}

export function deactivate() {}
`;
    } else if (type === 'channel') {
      entryContent = `// ${name} plugin - channel type
export function activate(ctx) {
  ctx.log('Channel plugin activated');
  return {
    channel: {
      name: '${name}',
      async start() { ctx.log('Channel started'); },
      async stop() { ctx.log('Channel stopped'); },
      async send(sessionId, message) { ctx.log('Sending: ' + message.slice(0, 50)); },
    },
    onSessionStart(sessionId) { ctx.log('Session started: ' + sessionId); },
  };
}
export function deactivate() {}
`;
    } else if (type === 'middleware') {
      entryContent = `// ${name} plugin - middleware type
export function activate(ctx) {
  ctx.log('Middleware plugin activated');
  return {
    middleware: {
      async beforeMessage(sessionId, message) {
        // Transform incoming messages before AI sees them
        return message;
      },
      async afterResponse(sessionId, response) {
        // Transform AI responses before user sees them
        return response;
      },
    },
    onToolCall(toolName, params) { ctx.log('Intercepted tool call: ' + toolName); },
  };
}
export function deactivate() {}
`;
    } else {
      entryContent = `// ${name} plugin - mixed type
export function activate(ctx) {
  ctx.log('Plugin activated');
  return {
    tools: [],
    middleware: {
      async beforeMessage(s, m) { return m; },
      async afterResponse(s, r) { return r; },
    },
    onSessionStart(sessionId) { ctx.log('Session: ' + sessionId); },
  };
}
export function deactivate() {}
`;
    }
    writeFileSync(join(pluginDir, 'index.js'), entryContent);
    return pluginDir;
  }
}

// ── Unified plugin management tool ────────────────────────────────────────

let pluginManagerRef: PluginManager | null = null;
let pluginReloadCallback: (() => void) | null = null;

export function setPluginManager(pm: PluginManager): void {
  pluginManagerRef = pm;
}

/** Register a callback invoked after plugin reload/create to refresh tool registry. */
export function setPluginReloadCallback(cb: () => void): void {
  pluginReloadCallback = cb;
}

export const pluginTools: Tool[] = [
  {
    name: 'plugin',
    description: [
      'Manage AutoMate plugins.',
      'Actions: list, scaffold, reload, create, config.',
      'list — list all loaded plugins with types and tools.',
      'scaffold — create a new plugin scaffold with boilerplate demonstrating lifecycle hooks, events, and services.',
      'reload — reload all plugins from the plugins directory.',
      'create — create a complete plugin with provided code (immediately loaded). Supports dependencies and configSchema params.',
      'config — get or set plugin configuration (use key/value params).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: list|scaffold|reload|create|config',
        },
        name: { type: 'string', description: 'Plugin name (for scaffold, create, config)' },
        type: { type: 'string', description: 'Plugin type (for scaffold, create)', enum: ['tools', 'channel', 'middleware', 'mixed'] },
        description: { type: 'string', description: 'Plugin description (for create)' },
        code: { type: 'string', description: 'Full index.js content (for create)' },
        dependencies: { type: 'array', items: { type: 'string' }, description: 'Plugin dependencies (for create) - names of plugins that must load first' },
        configSchema: { type: 'object', description: 'Config schema (for create) - object with keys as config names and values as {type, description, default?, required?}' },
        key: { type: 'string', description: 'Config key (for config set)' },
        value: { type: 'string', description: 'Config value as JSON (for config set)' },
        subaction: { type: 'string', description: 'Config sub-action: get|set (for config)' },
      },
      required: ['action'],
    },
    async execute(params) {
      if (!pluginManagerRef) return { output: '', error: 'Plugin manager not available' };
      const action = params.action as string;

      switch (action) {
        case 'list': {
          const plugins = pluginManagerRef.getPlugins();
          if (plugins.length === 0) return { output: 'No plugins loaded.' };
          const lines = plugins.map(p =>
            `  ${p.manifest.name} v${p.manifest.version} [${p.manifest.type}] — ${p.manifest.description}` +
            (p.tools.length > 0 ? `\n    Tools: ${p.tools.map(t => t.name).join(', ')}` : '') +
            (p.channel ? `\n    Channel: ${p.channel.name}` : '')
          );
          return { output: `Plugins (${plugins.length}):\n${lines.join('\n')}` };
        }

        case 'scaffold': {
          const name = (params.name as string)?.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
          if (!name) return { output: '', error: 'name is required for scaffold' };
          const type = (params.type as PluginManifest['type']) || 'tools';
          try {
            const dir = PluginManager.scaffold(pluginManagerRef['pluginsDir'], name, type);
            return { output: `Plugin "${name}" scaffolded at ${dir}\n\nFiles:\n  plugin.json — manifest\n  index.js — entry point\n\nUse plugin reload to load it.` };
          } catch (err) {
            return { output: '', error: (err as Error).message };
          }
        }

        case 'reload': {
          try {
            const loaded = await pluginManagerRef.loadAll();
            if (pluginReloadCallback) pluginReloadCallback();
            return { output: `Reloaded ${loaded.length} plugins: ${loaded.map(p => p.manifest.name).join(', ') || 'none'}` };
          } catch (err) {
            return { output: '', error: `Reload failed: ${(err as Error).message}` };
          }
        }

        case 'create': {
          const name = (params.name as string)?.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
          const code = params.code as string;
          if (!name || !code) return { output: '', error: 'name and code are required for create' };
          const description = (params.description as string) || `AutoMate plugin: ${name}`;
          const type = (params.type as PluginManifest['type']) || 'tools';
          const dependencies = (params.dependencies as string[]) || undefined;
          const configSchema = params.configSchema as Record<string, { type: string; description: string; default?: unknown; required?: boolean }> | undefined;

          const pluginsDir = pluginManagerRef['pluginsDir'];
          const pluginDir = join(pluginsDir, name);
          mkdirSync(pluginDir, { recursive: true });

          const manifest: PluginManifest = { name, version: '0.1.0', description, type, entry: 'index.js' };
          if (dependencies && dependencies.length > 0) manifest.dependencies = dependencies;
          if (configSchema && Object.keys(configSchema).length > 0) manifest.config = configSchema;
          writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));
          writeFileSync(join(pluginDir, 'index.js'), code);

          try {
            const loaded = await pluginManagerRef.loadPlugin(name);
            if (!loaded) return { output: '', error: 'Plugin created but failed to load.' };
            if (pluginReloadCallback) pluginReloadCallback();
            const toolNames = loaded.tools.map(t => t.name).join(', ');
            return { output: `Plugin "${name}" created and loaded!\n  Type: ${type}\n  Tools: ${toolNames || 'none'}\n  Channel: ${loaded.channel?.name || 'none'}\n  Dependencies: ${dependencies?.join(', ') || 'none'}\n  Config schema: ${configSchema ? Object.keys(configSchema).join(', ') : 'none'}\n  Path: ${pluginDir}` };
          } catch (err) {
            return { output: '', error: `Plugin created at ${pluginDir} but failed to load: ${(err as Error).message}` };
          }
        }

        case 'config': {
          const name = params.name as string;
          if (!name) return { output: '', error: 'name is required for config' };
          const sub = (params.subaction as string) || 'get';

          if (sub === 'get') {
            const cfg = pluginManagerRef.loadPluginConfig(name);
            if (Object.keys(cfg).length === 0) return { output: `No config for plugin "${name}".` };
            const lines = Object.entries(cfg).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`);
            return { output: `Config for "${name}":\n${lines.join('\n')}` };
          }

          if (sub === 'set') {
            const key = params.key as string;
            const value = params.value as string;
            if (!key || value === undefined) return { output: '', error: 'key and value are required for config set' };
            let parsed: unknown;
            try { parsed = JSON.parse(value); } catch { parsed = value; }
            const cfg = pluginManagerRef.loadPluginConfig(name);
            cfg[key] = parsed;
            const result = pluginManagerRef.savePluginConfig(name, cfg);
            if (!result.success) return { output: '', error: `Validation errors:\n${result.errors?.join('\n')}` };
            return { output: `Set ${name}.${key} = ${JSON.stringify(parsed)}` };
          }

          return { output: '', error: `Unknown config subaction "${sub}". Use get or set.` };
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: list, scaffold, reload, create, config` };
      }
    },
  },
];
