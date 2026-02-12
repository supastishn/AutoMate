/**
 * Gateway tool — runtime control of the gateway server
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { Tool, ToolContext } from '../tool-registry.js';
import type { Config } from '../../config/schema.js';
import { getConfigPath, reloadConfig, saveConfig } from '../../config/loader.js';

// References set by server.ts
let gatewayRestartFn: (() => Promise<void>) | null = null;
let configRef: Config | null = null;

export function setGatewayControls(config: Config, restartFn?: () => Promise<void>): void {
  configRef = config;
  if (restartFn) gatewayRestartFn = restartFn;
}

export const gatewayTools: Tool[] = [
  {
    name: 'gateway',
    description: [
      'Control the AutoMate gateway server.',
      'Actions: status, config, patch, reload.',
      'status — get gateway status and uptime.',
      'config — view current config (keys masked).',
      'patch — apply a JSON patch to config.',
      'reload — reload config from disk without restart.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: status|config|patch|reload',
        },
        patch: {
          type: 'object',
          description: 'JSON object to deep-merge into config (for patch action)',
        },
      },
      required: ['action'],
    },
    async execute(params) {
      const action = params.action as string;

      switch (action) {
        case 'status': {
          if (!configRef) return { output: 'Gateway config not available.' };
          return {
            output: [
              `Gateway Status:`,
              `  Host: ${configRef.gateway.host}:${configRef.gateway.port}`,
              `  Auth: ${configRef.gateway.auth.mode}`,
              `  Model: ${configRef.agent.model}`,
              `  Browser: ${configRef.browser.enabled ? 'enabled' : 'disabled'}`,
              `  Cron: ${configRef.cron.enabled ? 'enabled' : 'disabled'}`,
              `  Plugins: ${configRef.plugins?.enabled !== false ? 'enabled' : 'disabled'}`,
            ].join('\n'),
          };
        }

        case 'config': {
          if (!configRef) return { output: 'Gateway config not available.' };
          // Return masked config
          const masked = JSON.parse(JSON.stringify(configRef));
          if (masked.agent?.apiKey) masked.agent.apiKey = '***';
          if (masked.gateway?.auth?.token) masked.gateway.auth.token = '***';
          if (masked.gateway?.auth?.password) masked.gateway.auth.password = '***';
          if (masked.channels?.discord?.token) masked.channels.discord.token = '***';
          if (masked.memory?.embedding?.apiKey) masked.memory.embedding.apiKey = '***';
          if (masked.webhooks?.token) masked.webhooks.token = '***';
          return { output: JSON.stringify(masked, null, 2) };
        }

        case 'patch': {
          const patch = params.patch as Record<string, unknown>;
          if (!patch || typeof patch !== 'object') {
            return { output: '', error: 'patch object is required' };
          }

          try {
            // Load current config from disk
            const configPath = getConfigPath();
            let current: Record<string, unknown> = {};
            if (existsSync(configPath)) {
              current = JSON.parse(readFileSync(configPath, 'utf-8'));
            }

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

            const merged = deepMerge(current, patch);
            saveConfig(merged);

            // Reload into memory
            const reloaded = reloadConfig();
            if (configRef) Object.assign(configRef, reloaded);

            return { output: `Config patched and reloaded. Changed keys: ${Object.keys(patch).join(', ')}` };
          } catch (err) {
            return { output: '', error: `Patch failed: ${(err as Error).message}` };
          }
        }

        case 'reload': {
          try {
            const reloaded = reloadConfig();
            if (configRef) Object.assign(configRef, reloaded);
            return { output: 'Config reloaded from disk.' };
          } catch (err) {
            return { output: '', error: `Reload failed: ${(err as Error).message}` };
          }
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: status, config, patch, reload` };
      }
    },
  },
];
