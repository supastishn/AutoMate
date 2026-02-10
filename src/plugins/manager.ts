/**
 * Plugin SDK — formal extension architecture for AutoMate.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  constructor(config: Config, pluginsDir?: string) {
    this.config = config;
    this.pluginsDir = pluginsDir || config.plugins?.directory || join(homedir(), '.automate', 'plugins');
    if (!existsSync(this.pluginsDir)) mkdirSync(this.pluginsDir, { recursive: true });
  }

  async loadAll(): Promise<LoadedPlugin[]> {
    if (!existsSync(this.pluginsDir)) return [];
    const dirs = readdirSync(this.pluginsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    const loaded: LoadedPlugin[] = [];
    for (const dir of dirs) {
      try { const plugin = await this.loadPlugin(dir.name); if (plugin) loaded.push(plugin); }
      catch (err) { console.error(`[plugin] Failed to load "${dir.name}": ${(err as Error).message}`); }
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

  private getPluginConfig(pluginName: string): Record<string, unknown> { return {}; }

  static scaffold(pluginsDir: string, name: string, type: PluginManifest['type'] = 'tools'): string {
    const pluginDir = join(pluginsDir, name);
    if (existsSync(pluginDir)) throw new Error(`Plugin "${name}" already exists at ${pluginDir}`);
    mkdirSync(pluginDir, { recursive: true });

    const manifest: PluginManifest = { name, version: '0.1.0', description: `AutoMate plugin: ${name}`, type, entry: 'index.js' };
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));

    let entryContent: string;
    if (type === 'tools') {
      entryContent = `export function activate(ctx) {\n  ctx.log('Plugin activated');\n  return {\n    tools: [{\n      name: '${name}_example',\n      description: 'Example tool from ${name}',\n      parameters: { type: 'object', properties: { input: { type: 'string', description: 'Input text' } }, required: ['input'] },\n      async execute(params) { return { output: 'Hello from ${name}: ' + params.input }; },\n    }],\n  };\n}\nexport function deactivate() {}\n`;
    } else if (type === 'channel') {
      entryContent = `export function activate(ctx) {\n  ctx.log('Channel plugin activated');\n  return {\n    channel: {\n      name: '${name}',\n      async start() { ctx.log('Channel started'); },\n      async stop() { ctx.log('Channel stopped'); },\n      async send(sessionId, message) { ctx.log('Sending: ' + message.slice(0, 50)); },\n    },\n  };\n}\nexport function deactivate() {}\n`;
    } else if (type === 'middleware') {
      entryContent = `export function activate(ctx) {\n  ctx.log('Middleware plugin activated');\n  return {\n    middleware: {\n      async beforeMessage(sessionId, message) { return message; },\n      async afterResponse(sessionId, response) { return response; },\n    },\n  };\n}\nexport function deactivate() {}\n`;
    } else {
      entryContent = `export function activate(ctx) {\n  ctx.log('Plugin activated');\n  return { tools: [], middleware: { async beforeMessage(s, m) { return m; }, async afterResponse(s, r) { return r; } } };\n}\nexport function deactivate() {}\n`;
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
      'Actions: list, scaffold, reload, create.',
      'list — list all loaded plugins with types and tools.',
      'scaffold — create a new plugin scaffold with boilerplate.',
      'reload — reload all plugins from the plugins directory.',
      'create — create a complete plugin with provided code (immediately loaded).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: list|scaffold|reload|create',
        },
        name: { type: 'string', description: 'Plugin name (for scaffold, create)' },
        type: { type: 'string', description: 'Plugin type (for scaffold, create)', enum: ['tools', 'channel', 'middleware', 'mixed'] },
        description: { type: 'string', description: 'Plugin description (for create)' },
        code: { type: 'string', description: 'Full index.js content (for create)' },
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

          const pluginsDir = pluginManagerRef['pluginsDir'];
          const pluginDir = join(pluginsDir, name);
          mkdirSync(pluginDir, { recursive: true });

          const manifest: PluginManifest = { name, version: '0.1.0', description, type, entry: 'index.js' };
          writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));
          writeFileSync(join(pluginDir, 'index.js'), code);

          try {
            const loaded = await pluginManagerRef.loadPlugin(name);
            if (!loaded) return { output: '', error: 'Plugin created but failed to load.' };
            if (pluginReloadCallback) pluginReloadCallback();
            const toolNames = loaded.tools.map(t => t.name).join(', ');
            return { output: `Plugin "${name}" created and loaded!\n  Type: ${type}\n  Tools: ${toolNames || 'none'}\n  Channel: ${loaded.channel?.name || 'none'}\n  Path: ${pluginDir}` };
          } catch (err) {
            return { output: '', error: `Plugin created at ${pluginDir} but failed to load: ${(err as Error).message}` };
          }
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: list, scaffold, reload, create` };
      }
    },
  },
];
