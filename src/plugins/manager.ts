/**
 * Plugin SDK — formal extension architecture for AutoMate.
 * 
 * Plugins can provide:
 * - Tools (new agent capabilities)
 * - Channels (new messaging integrations)
 * - Middleware (pre/post processing hooks)
 * - Scheduled tasks
 * 
 * Plugins are loaded from the plugins directory, each as a directory
 * containing a plugin.json manifest and an index.ts/js entry point.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolContext } from '../agent/tool-registry.js';
import type { Config } from '../config/schema.js';

// ── Plugin Interfaces ────────────────────────────────────────────────────

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  type: 'tools' | 'channel' | 'middleware' | 'mixed';
  entry: string;              // relative path to entry module (e.g. "index.js")
  dependencies?: string[];    // npm package names (informational)
  config?: Record<string, {   // plugin-specific config schema
    type: string;
    description: string;
    default?: unknown;
    required?: boolean;
  }>;
}

export interface PluginContext {
  config: Config;
  pluginDir: string;
  pluginConfig: Record<string, unknown>;
  log: (msg: string) => void;
}

export interface PluginExports {
  /** Called when the plugin is loaded. Return tools, channel, or middleware. */
  activate(ctx: PluginContext): Promise<PluginActivation> | PluginActivation;
  /** Called when the plugin is unloaded. Clean up resources. */
  deactivate?(): Promise<void> | void;
}

export interface PluginActivation {
  tools?: Tool[];
  channel?: PluginChannel;
  middleware?: PluginMiddleware;
  onMessage?: (sessionId: string, message: string) => void;  // event hook
}

export interface PluginChannel {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send?(sessionId: string, message: string): Promise<void>;
}

export interface PluginMiddleware {
  /** Called before the message is processed. Return modified message or null to block. */
  beforeMessage?(sessionId: string, message: string): Promise<string | null> | string | null;
  /** Called after the agent produces a response. Return modified response. */
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
    this.pluginsDir = pluginsDir || join(config.memory.directory, '..', 'plugins');
    if (!existsSync(this.pluginsDir)) {
      mkdirSync(this.pluginsDir, { recursive: true });
    }
  }

  /** Load all plugins from the plugins directory */
  async loadAll(): Promise<LoadedPlugin[]> {
    if (!existsSync(this.pluginsDir)) return [];

    const dirs = readdirSync(this.pluginsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    const loaded: LoadedPlugin[] = [];

    for (const dir of dirs) {
      try {
        const plugin = await this.loadPlugin(dir.name);
        if (plugin) loaded.push(plugin);
      } catch (err) {
        console.error(`[plugin] Failed to load "${dir.name}": ${(err as Error).message}`);
      }
    }

    return loaded;
  }

  /** Load a single plugin by directory name */
  async loadPlugin(name: string): Promise<LoadedPlugin | null> {
    const pluginDir = join(this.pluginsDir, name);
    const manifestPath = join(pluginDir, 'plugin.json');

    if (!existsSync(manifestPath)) {
      console.warn(`[plugin] No plugin.json found in ${name}/`);
      return null;
    }

    const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const entryPath = join(pluginDir, manifest.entry);

    if (!existsSync(entryPath)) {
      console.error(`[plugin] Entry file not found: ${manifest.entry} in ${name}/`);
      return null;
    }

    // Dynamic import the plugin
    const pluginModule = await import(entryPath) as PluginExports;

    // Build plugin context
    const pluginConfig = this.getPluginConfig(manifest.name);
    const ctx: PluginContext = {
      config: this.config,
      pluginDir,
      pluginConfig,
      log: (msg: string) => console.log(`[plugin:${manifest.name}] ${msg}`),
    };

    // Activate the plugin
    const activation = await pluginModule.activate(ctx);

    const loaded: LoadedPlugin = {
      manifest,
      activation,
      exports: pluginModule,
      directory: pluginDir,
      tools: activation.tools || [],
      channel: activation.channel,
      middleware: activation.middleware,
    };

    this.plugins.set(manifest.name, loaded);
    return loaded;
  }

  /** Unload a plugin by name */
  async unloadPlugin(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    if (plugin.channel) {
      await plugin.channel.stop();
    }

    if (plugin.exports.deactivate) {
      await plugin.exports.deactivate();
    }

    this.plugins.delete(name);
    return true;
  }

  /** Get all loaded plugins */
  getPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /** Get all tools from all plugins */
  getAllTools(): Tool[] {
    const tools: Tool[] = [];
    for (const plugin of this.plugins.values()) {
      tools.push(...plugin.tools);
    }
    return tools;
  }

  /** Get all middleware from all plugins (in load order) */
  getAllMiddleware(): PluginMiddleware[] {
    const mw: PluginMiddleware[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.middleware) mw.push(plugin.middleware);
    }
    return mw;
  }

  /** Get all channels from plugins */
  getAllChannels(): PluginChannel[] {
    const channels: PluginChannel[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.channel) channels.push(plugin.channel);
    }
    return channels;
  }

  /** Run beforeMessage middleware chain */
  async runBeforeMessage(sessionId: string, message: string): Promise<string | null> {
    let current: string | null = message;
    for (const plugin of this.plugins.values()) {
      if (plugin.middleware?.beforeMessage && current !== null) {
        current = await plugin.middleware.beforeMessage(sessionId, current);
      }
    }
    return current;
  }

  /** Run afterResponse middleware chain */
  async runAfterResponse(sessionId: string, response: string): Promise<string> {
    let current = response;
    for (const plugin of this.plugins.values()) {
      if (plugin.middleware?.afterResponse) {
        current = await plugin.middleware.afterResponse(sessionId, current);
      }
    }
    return current;
  }

  /** Get plugin-specific config from the main config */
  private getPluginConfig(pluginName: string): Record<string, unknown> {
    // Plugin configs stored under config path (loaded from automate.json)
    // For now, return empty — will be wired when config schema is updated
    return {};
  }

  /** Create a new plugin scaffold */
  static scaffold(pluginsDir: string, name: string, type: PluginManifest['type'] = 'tools'): string {
    const pluginDir = join(pluginsDir, name);
    if (existsSync(pluginDir)) {
      throw new Error(`Plugin "${name}" already exists at ${pluginDir}`);
    }

    mkdirSync(pluginDir, { recursive: true });

    // Write manifest
    const manifest: PluginManifest = {
      name,
      version: '0.1.0',
      description: `AutoMate plugin: ${name}`,
      type,
      entry: 'index.js',
    };
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));

    // Write entry file based on type
    let entryContent: string;
    if (type === 'tools') {
      entryContent = `// ${name} plugin for AutoMate
// Provides custom tools for the agent

export function activate(ctx) {
  ctx.log('Plugin activated');

  return {
    tools: [
      {
        name: '${name}_example',
        description: 'Example tool from the ${name} plugin',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Input text' },
          },
          required: ['input'],
        },
        async execute(params) {
          return { output: 'Hello from ${name}: ' + params.input };
        },
      },
    ],
  };
}

export function deactivate() {
  // Clean up resources
}
`;
    } else if (type === 'channel') {
      entryContent = `// ${name} channel plugin for AutoMate

export function activate(ctx) {
  ctx.log('Channel plugin activated');

  return {
    channel: {
      name: '${name}',
      async start() {
        ctx.log('Channel started');
        // Connect to your messaging platform here
      },
      async stop() {
        ctx.log('Channel stopped');
        // Disconnect cleanly
      },
      async send(sessionId, message) {
        // Send a message to the platform
        ctx.log('Sending: ' + message.slice(0, 50));
      },
    },
  };
}

export function deactivate() {}
`;
    } else if (type === 'middleware') {
      entryContent = `// ${name} middleware plugin for AutoMate

export function activate(ctx) {
  ctx.log('Middleware plugin activated');

  return {
    middleware: {
      async beforeMessage(sessionId, message) {
        // Transform or filter incoming messages
        // Return null to block, or modified message string
        return message;
      },
      async afterResponse(sessionId, response) {
        // Transform outgoing responses
        return response;
      },
    },
  };
}

export function deactivate() {}
`;
    } else {
      entryContent = `// ${name} mixed plugin for AutoMate

export function activate(ctx) {
  ctx.log('Plugin activated');

  return {
    tools: [],
    middleware: {
      async beforeMessage(sessionId, message) { return message; },
      async afterResponse(sessionId, response) { return response; },
    },
  };
}

export function deactivate() {}
`;
    }

    writeFileSync(join(pluginDir, 'index.js'), entryContent);

    return pluginDir;
  }
}

// ── Plugin management tools for the agent ────────────────────────────────

let pluginManagerRef: PluginManager | null = null;

export function setPluginManager(pm: PluginManager): void {
  pluginManagerRef = pm;
}

export const pluginListTool: Tool = {
  name: 'plugin_list',
  description: 'List all loaded AutoMate plugins with their types, tools, and status.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    if (!pluginManagerRef) return { output: '', error: 'Plugin manager not available' };
    const plugins = pluginManagerRef.getPlugins();
    if (plugins.length === 0) return { output: 'No plugins loaded.' };
    const lines = plugins.map(p =>
      `  ${p.manifest.name} v${p.manifest.version} [${p.manifest.type}] — ${p.manifest.description}` +
      (p.tools.length > 0 ? `\n    Tools: ${p.tools.map(t => t.name).join(', ')}` : '') +
      (p.channel ? `\n    Channel: ${p.channel.name}` : '')
    );
    return { output: `Plugins (${plugins.length}):\n${lines.join('\n')}` };
  },
};

export const pluginScaffoldTool: Tool = {
  name: 'plugin_scaffold',
  description: 'Create a new plugin scaffold with boilerplate code. Creates a plugin directory with plugin.json manifest and index.js entry point.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Plugin name (lowercase-hyphenated e.g. "weather-alerts")' },
      type: {
        type: 'string',
        description: 'Plugin type',
        enum: ['tools', 'channel', 'middleware', 'mixed'],
      },
    },
    required: ['name'],
  },
  async execute(params) {
    if (!pluginManagerRef) return { output: '', error: 'Plugin manager not available' };
    const name = (params.name as string).toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    const type = (params.type as PluginManifest['type']) || 'tools';

    try {
      const pluginsDir = join(pluginManagerRef['pluginsDir']); // access private field
      const dir = PluginManager.scaffold(pluginsDir, name, type);
      return { output: `Plugin "${name}" scaffolded at ${dir}\n\nFiles created:\n  plugin.json — manifest\n  index.js — entry point\n\nEdit index.js to add your logic, then use plugin_reload to load it.` };
    } catch (err) {
      return { output: '', error: (err as Error).message };
    }
  },
};

export const pluginReloadTool: Tool = {
  name: 'plugin_reload',
  description: 'Reload all plugins from the plugins directory. Use after creating or editing plugins.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    if (!pluginManagerRef) return { output: '', error: 'Plugin manager not available' };
    try {
      const loaded = await pluginManagerRef.loadAll();
      return { output: `Reloaded ${loaded.length} plugins: ${loaded.map(p => p.manifest.name).join(', ') || 'none'}` };
    } catch (err) {
      return { output: '', error: `Reload failed: ${(err as Error).message}` };
    }
  },
};

export const pluginCreateTool: Tool = {
  name: 'plugin_create',
  description: 'Create a complete plugin by providing the full index.js code and manifest. This is the advanced version of plugin_scaffold — use it when you know exactly what code the plugin should contain. The plugin is immediately loaded after creation.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Plugin name' },
      description: { type: 'string', description: 'What the plugin does' },
      type: { type: 'string', description: 'Plugin type', enum: ['tools', 'channel', 'middleware', 'mixed'] },
      code: { type: 'string', description: 'Full index.js content (JavaScript, ESM exports)' },
    },
    required: ['name', 'code'],
  },
  async execute(params) {
    if (!pluginManagerRef) return { output: '', error: 'Plugin manager not available' };

    const name = (params.name as string).toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    const description = (params.description as string) || `AutoMate plugin: ${name}`;
    const type = (params.type as PluginManifest['type']) || 'tools';
    const code = params.code as string;

    const pluginsDir = pluginManagerRef['pluginsDir'];
    const pluginDir = join(pluginsDir, name);

    mkdirSync(pluginDir, { recursive: true });

    // Write manifest
    const manifest: PluginManifest = {
      name,
      version: '0.1.0',
      description,
      type,
      entry: 'index.js',
    };
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(pluginDir, 'index.js'), code);

    // Load the plugin
    try {
      const loaded = await pluginManagerRef.loadPlugin(name);
      if (!loaded) return { output: '', error: 'Plugin created but failed to load. Check index.js exports.' };
      const toolNames = loaded.tools.map(t => t.name).join(', ');
      return {
        output: `Plugin "${name}" created and loaded!\n  Type: ${type}\n  Tools: ${toolNames || 'none'}\n  Channel: ${loaded.channel?.name || 'none'}\n  Path: ${pluginDir}`,
      };
    } catch (err) {
      return { output: '', error: `Plugin created at ${pluginDir} but failed to load: ${(err as Error).message}` };
    }
  },
};

export const pluginTools = [
  pluginListTool,
  pluginScaffoldTool,
  pluginReloadTool,
  pluginCreateTool,
];
