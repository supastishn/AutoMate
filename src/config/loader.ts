import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { ConfigSchema, type Config } from './schema.js';

const CONFIG_DIR = join(homedir(), '.automate');
const CONFIG_FILE_JSON = join(CONFIG_DIR, 'automate.json');
const CONFIG_FILE_YAML = join(CONFIG_DIR, 'automate.yaml');

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

export function loadConfig(path?: string): Config {
  const configPath = path || getConfigFilePath();
  ensureConfigDir();

  let raw = loadWithIncludes(configPath);
  
  // Apply environment variable substitution
  raw = substituteEnvVars(raw);
  
  // Apply AUTOMATE_* environment variable overrides
  applyEnvOverrides(raw);

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
  
  const config = ConfigSchema.parse(raw);
  config.skills.directory = resolveHome(config.skills.directory);
  config.sessions.directory = resolveHome(config.sessions.directory);
  config.memory.directory = resolveHome(config.memory.directory);
  config.memory.sharedDirectory = resolveHome(config.memory.sharedDirectory);
  config.cron.directory = resolveHome(config.cron.directory);
  if (config.plugins?.directory) {
    config.plugins.directory = resolveHome(config.plugins.directory);
  }
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
