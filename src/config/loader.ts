import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigSchema, type Config } from './schema.js';

const CONFIG_DIR = join(homedir(), '.automate');
const CONFIG_FILE = join(CONFIG_DIR, 'automate.json');

export function resolveHome(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : resolve(p);
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(path?: string): Config {
  const configPath = path || CONFIG_FILE;
  ensureConfigDir();

  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      console.warn(`Warning: Could not parse ${configPath}, using defaults`);
    }
  }

  const config = ConfigSchema.parse(raw);

  // Resolve ~ paths
  config.skills.directory = resolveHome(config.skills.directory);
  config.sessions.directory = resolveHome(config.sessions.directory);

  // Ensure directories exist
  mkdirSync(config.skills.directory, { recursive: true });
  mkdirSync(config.sessions.directory, { recursive: true });

  return config;
}

export function saveConfig(config: Partial<Config>, path?: string): void {
  const configPath = path || CONFIG_FILE;
  ensureConfigDir();
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
