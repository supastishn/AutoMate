import { readFileSync, writeFileSync, existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { ConfigSchema, type Config } from './schema.js';
import { setSubAgentMaxConcurrent } from '../agent/tools/subagent.js';

const CONFIG_DIR = join(homedir(), '.automate');
const CONFIG_FILE_JSON = join(CONFIG_DIR, 'automate.json');
const CONFIG_FILE_YAML = join(CONFIG_DIR, 'automate.yaml');

// Config file watcher for live reload
let configWatcher: FSWatcher | null = null;
let configChangeCallbacks: ((config: Config) => void)[] = [];
let lastConfigMtime = 0;
// Cached config for getCurrentConfig()
let cachedConfig: Config | null = null;

export function resolveHome(p: string): string {
  if (p.startsWith('~')) return p.replace('~', homedir());
  // Resolve relative paths against ~/.automate, not cwd
  if (!p.startsWith('/')) return join(CONFIG_DIR, p);
  return p;
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/** Substitute environment variables in config values: ${VAR} or ${VAR:default} */
function substituteEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    // Replace ${VAR} or ${VAR:default} patterns
    return obj.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (match, varName, defaultVal) => {
      const envVal = process.env[varName];
      if (envVal !== undefined) return envVal;
      if (defaultVal !== undefined) return defaultVal;
      return match; // leave as-is if no env var and no default
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(item => substituteEnvVars(item));
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = substituteEnvVars(val);
    }
    return result;
  }
  return obj;
}

/** Parse YAML (simple subset parser - handles common cases) */
function parseYaml(content: string): Record<string, unknown> {
  try {
    // Try to use js-yaml if available
    const yaml = require('js-yaml');
    return yaml.load(content) || {};
  } catch {
    // Fallback: simple YAML parser for basic configs
    return parseSimpleYaml(content);
  }
}

/** Simple YAML parser for basic key-value configs */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: result }];
  
  for (const line of lines) {
    // Skip comments and empty lines
    if (line.trim().startsWith('#') || line.trim() === '') continue;
    
    const match = line.match(/^(\s*)([^:]+):\s*(.*)$/);
    if (!match) continue;
    
    const indent = match[1].length;
    const key = match[2].trim();
    let value: any = match[3].trim();
    
    // Pop stack until we find parent level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    
    const parent = stack[stack.length - 1].obj;
    
    if (value === '' || value === '|' || value === '>') {
      // Nested object or multiline string (simplified: treat as nested object)
      const nested: Record<string, unknown> = {};
      parent[key] = nested;
      stack.push({ indent, obj: nested });
    } else {
      // Parse value
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (value === 'null' || value === '~') value = null;
      else if (/^-?\d+$/.test(value)) value = parseInt(value, 10);
      else if (/^-?\d+\.\d+$/.test(value)) value = parseFloat(value);
      else if (value.startsWith('[') && value.endsWith(']')) {
        // Simple array
        value = value.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^['"]|['"]$/g, ''));
      } else if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      parent[key] = value;
    }
  }
  
  return result;
}

/** Load and merge config includes */
function loadWithIncludes(configPath: string, visited: Set<string> = new Set()): Record<string, unknown> {
  if (visited.has(configPath)) {
    console.warn(`[config] Circular include detected: ${configPath}`);
    return {};
  }
  visited.add(configPath);
  
  if (!existsSync(configPath)) return {};
  
  let raw: Record<string, unknown>;
  const ext = extname(configPath).toLowerCase();
  const content = readFileSync(configPath, 'utf-8');
  
  if (ext === '.yaml' || ext === '.yml') {
    raw = parseYaml(content);
  } else {
    try {
      raw = JSON.parse(content);
    } catch {
      console.warn(`[config] Could not parse ${configPath}`);
      return {};
    }
  }
  
  // Process includes
  const includes = raw._includes as string[] | string | undefined;
  delete raw._includes;
  
  if (includes) {
    const includeList = Array.isArray(includes) ? includes : [includes];
    for (const inc of includeList) {
      const incPath = resolveHome(inc);
      const included = loadWithIncludes(incPath, visited);
      raw = deepMerge(included, raw);
    }
  }
  
  return raw;
}

/** Deep merge two objects */
function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/** Get the config file path (prefers YAML if exists) */
function getConfigFilePath(): string {
  if (existsSync(CONFIG_FILE_YAML)) return CONFIG_FILE_YAML;
  return CONFIG_FILE_JSON;
}

/** Fix invalid config values that could cause validation errors */
function fixInvalidConfigValues(config: Record<string, unknown>): Record<string, unknown> {
  // Fix invalid thinkingLevel values
  if (config.agent && typeof config.agent === 'object') {
    const agent = config.agent as Record<string, unknown>;
    if (agent.thinkingLevel && typeof agent.thinkingLevel === 'string') {
      const validThinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
      if (!validThinkingLevels.includes(agent.thinkingLevel)) {
        console.warn(`[config] Invalid thinkingLevel "${agent.thinkingLevel}", resetting to "off"`);
        agent.thinkingLevel = 'off';
      }
    }
  }

  // Fix invalid powerSteering.role values
  if (config.agent && typeof config.agent === 'object') {
    const agent = config.agent as Record<string, unknown>;
    if (agent.powerSteering && typeof agent.powerSteering === 'object') {
      const powerSteering = agent.powerSteering as Record<string, unknown>;
      if (powerSteering.role && typeof powerSteering.role === 'string') {
        const validPowerSteeringRoles = ['system', 'user', 'both'];
        if (!validPowerSteeringRoles.includes(powerSteering.role)) {
          console.warn(`[config] Invalid powerSteering.role "${powerSteering.role}", resetting to "system"`);
          powerSteering.role = 'system';
        }
      }
    }
  }

  // Fix invalid gateway auth mode values
  if (config.gateway && typeof config.gateway === 'object') {
    const gateway = config.gateway as Record<string, unknown>;
    if (gateway.auth && typeof gateway.auth === 'object') {
      const auth = gateway.auth as Record<string, unknown>;
      if (auth.mode && typeof auth.mode === 'string') {
        const validAuthModes = ['none', 'token', 'password'];
        if (!validAuthModes.includes(auth.mode)) {
          console.warn(`[config] Invalid gateway.auth.mode "${auth.mode}", resetting to "token"`);
          auth.mode = 'token';
        }
      }
    }
  }

  // Fix invalid loadBalancing strategy values
  if (config.agent && typeof config.agent === 'object') {
    const agent = config.agent as Record<string, unknown>;
    if (agent.loadBalancing && typeof agent.loadBalancing === 'object') {
      const loadBalancing = agent.loadBalancing as Record<string, unknown>;
      if (loadBalancing.strategy && typeof loadBalancing.strategy === 'string') {
        const validStrategies = ['round-robin', 'random'];
        if (!validStrategies.includes(loadBalancing.strategy)) {
          console.warn(`[config] Invalid loadBalancing.strategy "${loadBalancing.strategy}", resetting to "round-robin"`);
          loadBalancing.strategy = 'round-robin';
        }
      }
    }
  }

  // Fix invalid TTS provider values
  if (config.tts && typeof config.tts === 'object') {
    const tts = config.tts as Record<string, unknown>;
    if (tts.provider && typeof tts.provider === 'string') {
      const validProviders = ['elevenlabs', 'openai'];
      if (!validProviders.includes(tts.provider)) {
        console.warn(`[config] Invalid tts.provider "${tts.provider}", resetting to "elevenlabs"`);
        tts.provider = 'elevenlabs';
      }
    }
  }

  // Fix invalid memory embedding provider values
  if (config.memory && typeof config.memory === 'object') {
    const memory = config.memory as Record<string, unknown>;
    if (memory.embedding && typeof memory.embedding === 'object') {
      const embedding = memory.embedding as Record<string, unknown>;
      if (embedding.provider && typeof embedding.provider === 'string') {
        const validProviders = ['openai', 'gemini', 'voyage', 'local'];
        if (!validProviders.includes(embedding.provider)) {
          console.warn(`[config] Invalid memory.embedding.provider "${embedding.provider}", resetting to "openai"`);
          embedding.provider = 'openai';
        }
      }
    }
  }

  // Fix invalid memory citations values
  if (config.memory && typeof config.memory === 'object') {
    const memory = config.memory as Record<string, unknown>;
    if (memory.citations && typeof memory.citations === 'string') {
      const validCitations = ['full', 'file-only', 'none'];
      if (!validCitations.includes(memory.citations)) {
        console.warn(`[config] Invalid memory.citations "${memory.citations}", resetting to "full"`);
        memory.citations = 'full';
      }
    }
  }

  return config;
}

export function loadConfig(path?: string): Config {
  const configPath = path || getConfigFilePath();
  ensureConfigDir();

  let raw = loadWithIncludes(configPath);
  
  // Apply environment variable substitution
  raw = substituteEnvVars(raw);
  
  // Apply AUTOMATE_* environment variable overrides
  applyEnvOverrides(raw);

  // Fix any invalid config values that could cause validation errors
  raw = fixInvalidConfigValues(raw);

  const config = ConfigSchema.parse(raw);

  // Resolve ~ paths
  config.skills.directory = resolveHome(config.skills.directory);
  config.sessions.directory = resolveHome(config.sessions.directory);
  config.memory.directory = resolveHome(config.memory.directory);
  config.memory.sharedDirectory = resolveHome(config.memory.sharedDirectory);
  config.cron.directory = resolveHome(config.cron.directory);
  if (config.plugins?.directory) {
    config.plugins.directory = resolveHome(config.plugins.directory);
  }

  // Ensure directories exist
  mkdirSync(config.skills.directory, { recursive: true });
  mkdirSync(config.sessions.directory, { recursive: true });
  mkdirSync(config.memory.directory, { recursive: true });
  mkdirSync(config.memory.sharedDirectory, { recursive: true });
  mkdirSync(config.cron.directory, { recursive: true });
  if (config.plugins?.directory) {
    mkdirSync(config.plugins.directory, { recursive: true });
  }

  // Set subagent concurrency limit
  setSubAgentMaxConcurrent(config.agent.subagent?.maxConcurrent ?? 3);

  // Cache for getCurrentConfig()
  cachedConfig = config;

  return config;
}

/** Apply AUTOMATE_* environment variable overrides */
function applyEnvOverrides(config: Record<string, unknown>): void {
  const envMappings: Record<string, string[]> = {
    AUTOMATE_MODEL: ['agent', 'model'],
    AUTOMATE_API_KEY: ['agent', 'apiKey'],
    AUTOMATE_API_BASE: ['agent', 'apiBase'],
    AUTOMATE_PORT: ['gateway', 'port'],
    AUTOMATE_HOST: ['gateway', 'host'],
    AUTOMATE_AUTH_TOKEN: ['gateway', 'auth', 'token'],
    AUTOMATE_DISCORD_TOKEN: ['channels', 'discord', 'token'],
    AUTOMATE_EMBEDDING_API_KEY: ['memory', 'embedding', 'apiKey'],
  };

  for (const [envVar, path] of Object.entries(envMappings)) {
    const value = process.env[envVar];
    if (value !== undefined) {
      let current: any = config;
      for (let i = 0; i < path.length - 1; i++) {
        if (!current[path[i]]) current[path[i]] = {};
        current = current[path[i]];
      }
      // Convert to appropriate type
      const key = path[path.length - 1];
      if (key === 'port') {
        current[key] = parseInt(value, 10);
      } else {
        current[key] = value;
      }
    }
  }
}

export function reloadConfig(path?: string): Config {
  // Same as loadConfig but doesn't create dirs (they already exist)
  const configPath = path || getConfigFilePath();
  let raw = loadWithIncludes(configPath);
  raw = substituteEnvVars(raw);
  applyEnvOverrides(raw);
  
  // Fix any invalid config values that could cause validation errors
  raw = fixInvalidConfigValues(raw);

  const config = ConfigSchema.parse(raw);
  config.skills.directory = resolveHome(config.skills.directory);
  config.sessions.directory = resolveHome(config.sessions.directory);
  config.memory.directory = resolveHome(config.memory.directory);
  config.memory.sharedDirectory = resolveHome(config.memory.sharedDirectory);
  config.cron.directory = resolveHome(config.cron.directory);
  if (config.plugins?.directory) {
    config.plugins.directory = resolveHome(config.plugins.directory);
  }

  // Update subagent concurrency limit on reload
  setSubAgentMaxConcurrent(config.agent.subagent?.maxConcurrent ?? 3);

  // Update cache for getCurrentConfig()
  cachedConfig = config;

  return config;
}

export function saveConfig(config: Partial<Config>, path?: string): void {
  const configPath = path || CONFIG_FILE_JSON;
  ensureConfigDir();
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function getConfigPath(): string {
  return getConfigFilePath();
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

/** Get the currently loaded config (returns null if not yet loaded) */
export function getCurrentConfig(): Config | null {
  return cachedConfig;
}

/** Register a callback to be called when config file changes */
export function onConfigChange(callback: (config: Config) => void): void {
  configChangeCallbacks.push(callback);
}

/** Start watching the config file for changes */
export function watchConfig(): void {
  if (configWatcher) return; // already watching

  const configPath = getConfigFilePath();
  if (!existsSync(configPath)) return;

  console.log(`[config] Watching ${configPath} for live reload`);

  // Debounce: only reload if file changed at least 500ms ago
  let debounceTimer: NodeJS.Timeout | null = null;

  configWatcher = watch(configPath, (eventType) => {
    if (eventType !== 'change') return;

    // Debounce rapid changes
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const newConfig = reloadConfig(configPath);
        console.log(`[config] Config reloaded (live)`);
        for (const cb of configChangeCallbacks) {
          try {
            cb(newConfig);
          } catch (err) {
            console.error(`[config] Callback error:`, err);
          }
        }
      } catch (err) {
        console.error(`[config] Failed to reload config:`, err);
      }
    }, 500);
  });
}

/** Stop watching the config file */
export function unwatchConfig(): void {
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
  configChangeCallbacks = [];
}
