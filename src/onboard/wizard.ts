import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { saveConfig, getConfigPath, ensureConfigDir, loadConfig } from '../config/loader.js';
import type { Config } from '../config/schema.js';

type RL = ReturnType<typeof createInterface>;

function ask(rl: RL, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` ${chalk.dim(`(${defaultVal})`)}` : '';
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

function askYesNo(rl: RL, question: string, defaultVal = false): Promise<boolean> {
  const hint = defaultVal ? 'Y/n' : 'y/N';
  return new Promise((resolve) => {
    rl.question(`  ${question} ${chalk.dim(`(${hint})`)}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (!a) resolve(defaultVal);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

function askChoice(rl: RL, question: string, choices: string[], defaultVal?: string): Promise<string> {
  const choiceStr = choices.join(' / ');
  const suffix = defaultVal ? ` ${chalk.dim(`(${defaultVal})`)}` : '';
  return new Promise((resolve) => {
    rl.question(`  ${question} [${choiceStr}]${suffix}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (!a && defaultVal) resolve(defaultVal);
      else if (choices.includes(a)) resolve(a);
      else resolve(defaultVal || choices[0]);
    });
  });
}

function askList(rl: RL, question: string, defaultVal?: string): Promise<string[]> {
  const suffix = defaultVal ? ` ${chalk.dim(`(${defaultVal})`)}` : '';
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      const raw = answer.trim() || defaultVal || '';
      if (!raw) resolve([]);
      else resolve(raw.split(',').map(s => s.trim()).filter(Boolean));
    });
  });
}

function section(title: string, step: number, desc?: string) {
  console.log('');
  console.log(chalk.cyan(`  ${step}. ${title}`));
  if (desc) console.log(chalk.dim(`     ${desc}`));
  console.log('');
}

// ── Deep merge utility ──
function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

// ── Section functions ──

async function askAiModel(rl: RL, current?: Config['agent']): Promise<Record<string, any>> {
  section('AI Model', 1, 'Works with any OpenAI-compatible API (OpenAI, Anthropic proxy, Ollama, LiteLLM, OpenRouter)');

  const apiBase = await ask(rl, 'API base URL', current?.apiBase ?? 'http://localhost:4141/v1');
  const model = await ask(rl, 'Model name', current?.model ?? 'claude-opus-4.6');
  const apiKey = await ask(rl, 'API key (leave empty if not needed)', current?.apiKey ?? '');
  const maxTokensStr = await ask(rl, 'Max output tokens', String(current?.maxTokens ?? 8192));
  const maxTokens = parseInt(maxTokensStr) || 8192;
  const tempStr = await ask(rl, 'Temperature (0.0-1.0)', String(current?.temperature ?? 0.3));
  const temperature = parseFloat(tempStr) || 0.3;

  return {
    agent: {
      model,
      apiBase,
      ...(apiKey ? { apiKey } : {}),
      maxTokens,
      temperature,
    },
  };
}

async function askGateway(rl: RL, current?: Config['gateway']): Promise<Record<string, any>> {
  section('Gateway Security', 2, 'Controls who can access the AutoMate web API');

  const host = await ask(rl, 'Bind address (127.0.0.1 = local only, 0.0.0.0 = public)', current?.host ?? '127.0.0.1');
  const portStr = await ask(rl, 'Port', String(current?.port ?? 18789));
  const port = parseInt(portStr) || 18789;
  const authMode = await askChoice(rl, 'Auth mode', ['none', 'token', 'password'], current?.auth?.mode ?? 'token') as 'none' | 'token' | 'password';

  let authToken = '';
  let authPassword = '';
  if (authMode === 'token') {
    authToken = await ask(rl, 'Auth token (leave empty to auto-generate)', current?.auth?.token ?? '');
    if (!authToken) {
      authToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      console.log(chalk.dim(`     Generated: ${authToken}`));
    }
  } else if (authMode === 'password') {
    authPassword = await ask(rl, 'Password', current?.auth?.password ?? '');
  }

  return {
    gateway: {
      port,
      host,
      auth: {
        mode: authMode,
        ...(authMode === 'token' && authToken ? { token: authToken } : {}),
        ...(authMode === 'password' && authPassword ? { password: authPassword } : {}),
      },
    },
  };
}

async function askDiscord(rl: RL, current?: Config['channels']['discord']): Promise<Record<string, any>> {
  section('Discord Channel', 3, 'Connect AutoMate to a Discord bot');

  const discordEnabled = await askYesNo(rl, 'Enable Discord bot?', current?.enabled ?? false);
  let discordToken = '';
  let discordClientId = '';
  let discordPublicMode = false;
  let discordOwnerIds: string[] = [];
  let discordAllowFrom: string[] = ['*'];
  let discordAllowChannels: string[] = ['*'];
  let discordPublicTools: string[] = [];
  let discordProactiveChannelId = '';
  let discordUseEmbeds = true;
  let discordUseThreads = true;
  let discordStreamEdits = true;
  let discordShowButtons = true;
  let discordRegisterSlash = true;

  if (discordEnabled) {
    console.log(chalk.dim('     Create a bot at https://discord.com/developers/applications'));
    console.log(chalk.dim('     Required intents: Message Content, Guild Messages, Direct Messages'));
    console.log('');

    discordToken = await ask(rl, 'Bot token', current?.token ?? '');
    discordClientId = await ask(rl, 'Client/Application ID (for slash commands)', current?.clientId ?? '');
    console.log('');

    // Multi-user / public server mode
    console.log(chalk.dim('     Public mode: bot chats with everyone, but only owners can use tools'));
    discordPublicMode = await askYesNo(rl, 'Enable public mode (multi-user server)?', current?.publicMode ?? false);

    if (discordPublicMode) {
      console.log(chalk.dim('     Owner IDs: Discord user IDs with full tool access'));
      console.log(chalk.dim('     Get your ID: Discord settings > Advanced > Developer Mode, right-click yourself'));
      const ownerDefault = current?.ownerIds?.length ? current.ownerIds.join(',') : '';
      const ownerList = await ask(rl, 'Owner user IDs (comma-separated)', ownerDefault);
      discordOwnerIds = ownerList ? ownerList.split(',').map(s => s.trim()).filter(Boolean) : [];

      discordAllowFrom = ['*']; // everyone can chat in public mode

      console.log(chalk.dim('     Public tools: what non-owners can use (empty = chat only, no tools)'));
      console.log(chalk.dim('     Available: read_file, list_directory, search_files, web_search, web_fetch, analyze_image'));
      const pubToolsDefault = current?.publicTools?.length ? current.publicTools.join(',') : 'web_search,analyze_image';
      const pubTools = await ask(rl, 'Public tools (comma-separated, or "none")', pubToolsDefault);
      if (pubTools === 'none') {
        discordPublicTools = [];
      } else {
        discordPublicTools = pubTools.split(',').map(s => s.trim()).filter(Boolean);
      }
    } else {
      console.log(chalk.dim('     Restrict to specific Discord user IDs, or * for anyone'));
      const allowDefault = current?.allowFrom?.length ? current.allowFrom.join(',') : '*';
      const allowStr = await ask(rl, 'Allowed user IDs (comma-separated, * = anyone)', allowDefault);
      discordAllowFrom = allowStr.split(',').map(s => s.trim()).filter(Boolean);
    }

    console.log('');
    console.log(chalk.dim('     Channel restrictions: limit bot to specific channel IDs, or * for all'));
    const chanDefault = current?.allowChannels?.length ? current.allowChannels.join(',') : '*';
    const chanStr = await ask(rl, 'Allowed channel IDs (comma-separated, * = all)', chanDefault);
    discordAllowChannels = chanStr.split(',').map(s => s.trim()).filter(Boolean);

    discordProactiveChannelId = await ask(rl, 'Proactive message channel ID (for cron/heartbeat results, leave empty to skip)', current?.proactiveChannelId ?? '');
    console.log('');

    // UI preferences
    console.log(chalk.dim('     Response style'));
    discordUseEmbeds = await askYesNo(rl, 'Use rich embeds?', current?.useEmbeds ?? true);
    discordShowButtons = await askYesNo(rl, 'Show action buttons (Reset/Status/Compact)?', current?.showButtons ?? true);
    discordUseThreads = await askYesNo(rl, 'Auto-create threads for long conversations?', current?.useThreads ?? true);
    discordStreamEdits = await askYesNo(rl, 'Stream responses via message editing?', current?.streamEdits ?? true);
    discordRegisterSlash = await askYesNo(rl, 'Register slash commands (/chat, /status, etc.)?', current?.registerSlashCommands ?? true);
  }

  return {
    channels: {
      discord: {
        enabled: discordEnabled,
        ...(discordToken ? { token: discordToken } : {}),
        ...(discordClientId ? { clientId: discordClientId } : {}),
        allowFrom: discordAllowFrom,
        allowChannels: discordAllowChannels,
        ...(discordPublicMode ? {
          publicMode: true,
          ownerIds: discordOwnerIds,
          publicTools: discordPublicTools,
        } : {}),
        ...(discordProactiveChannelId ? { proactiveChannelId: discordProactiveChannelId } : {}),
        useEmbeds: discordUseEmbeds,
        useThreads: discordUseThreads,
        streamEdits: discordStreamEdits,
        showButtons: discordShowButtons,
        registerSlashCommands: discordRegisterSlash,
      },
    },
  };
}

async function askFeatures(rl: RL, current?: Partial<Config>): Promise<Record<string, any>> {
  section('Features', 4, 'Enable or disable major subsystems');

  const browserEnabled = await askYesNo(rl, 'Enable browser automation (requires Python + Chrome)?', current?.browser?.enabled ?? true);
  const cronEnabled = await askYesNo(rl, 'Enable cron scheduler?', current?.cron?.enabled ?? true);
  const webhooksEnabled = await askYesNo(rl, 'Enable incoming webhooks?', current?.webhooks?.enabled ?? false);
  const canvasEnabled = await askYesNo(rl, 'Enable canvas (collaborative drawing/notes in web UI)?', current?.canvas?.enabled ?? true);
  const pluginsEnabled = await askYesNo(rl, 'Enable plugin system?', current?.plugins?.enabled ?? true);
  const heartbeatEnabled = await askYesNo(rl, 'Enable heartbeat (periodic agent check-ins)?', current?.heartbeat?.enabled ?? false);
  let heartbeatInterval = current?.heartbeat?.intervalMinutes ?? 30;
  if (heartbeatEnabled) {
    const hbStr = await ask(rl, 'Heartbeat interval (minutes)', String(heartbeatInterval));
    heartbeatInterval = parseInt(hbStr) || 30;
  }

  return {
    browser: { enabled: browserEnabled, headless: true },
    cron: { enabled: cronEnabled, directory: current?.cron?.directory ?? '~/.automate/cron' },
    webhooks: { enabled: webhooksEnabled },
    canvas: { enabled: canvasEnabled },
    plugins: { enabled: pluginsEnabled, directory: current?.plugins?.directory ?? '~/.automate/plugins' },
    heartbeat: { enabled: heartbeatEnabled, intervalMinutes: heartbeatInterval },
  };
}

async function askMemorySessions(
  rl: RL,
  current?: Partial<Config>,
  agentApiBase?: string,
  agentApiKey?: string,
): Promise<Record<string, any>> {
  section('Memory & Sessions', 5, 'Configure memory, sessions, and semantic search');

  const memoryDir = await ask(rl, 'Memory directory', current?.memory?.directory ?? '~/.automate/memory');
  const sharedMemDir = await ask(rl, 'Shared memory directory (multi-agent)', current?.memory?.sharedDirectory ?? '~/.automate/shared');
  const sessionsDir = await ask(rl, 'Sessions directory', current?.sessions?.directory ?? '~/.automate/sessions');
  const contextLimitStr = await ask(rl, 'Context token limit before auto-compact', String(current?.sessions?.contextLimit ?? 120000));
  const contextLimit = parseInt(contextLimitStr) || 120000;
  const compactAtStr = await ask(rl, 'Compact at (fraction of limit, 0-1)', String(current?.sessions?.compactAt ?? 0.8));
  const compactAt = parseFloat(compactAtStr) || 0.8;

  console.log('');
  console.log(chalk.dim('     Semantic search: uses embeddings for smarter memory recall'));
  const embeddingEnabled = await askYesNo(rl, 'Enable semantic search (requires embedding API)?', current?.memory?.embedding?.enabled ?? true);
  let embeddingModel = current?.memory?.embedding?.model ?? 'text-embedding-3-small';
  const fallbackApiBase = agentApiBase ?? current?.agent?.apiBase ?? 'http://localhost:4141/v1';
  const fallbackApiKey = agentApiKey ?? current?.agent?.apiKey ?? '';
  let embeddingApiBase = current?.memory?.embedding?.apiBase ?? fallbackApiBase;
  let embeddingApiKey = current?.memory?.embedding?.apiKey ?? fallbackApiKey;
  if (embeddingEnabled) {
    embeddingModel = await ask(rl, 'Embedding model', embeddingModel);
    embeddingApiBase = await ask(rl, 'Embedding API base (same as main API?)', embeddingApiBase);
    const embKey = await ask(rl, 'Embedding API key (leave empty to reuse main key)');
    if (embKey) embeddingApiKey = embKey;
  }

  return {
    memory: {
      directory: memoryDir,
      sharedDirectory: sharedMemDir,
      embedding: {
        enabled: embeddingEnabled,
        ...(embeddingEnabled ? {
          model: embeddingModel,
          apiBase: embeddingApiBase,
          ...(embeddingApiKey ? { apiKey: embeddingApiKey } : {}),
        } : {}),
      },
    },
    sessions: {
      directory: sessionsDir,
      contextLimit,
      compactAt,
    },
  };
}

async function askToolPolicy(rl: RL, current?: Config['tools']): Promise<Record<string, any>> {
  section('Tool Policy', 6, 'Restrict which tools the agent can use');

  console.log(chalk.dim('     Leave empty to allow all tools. Deny list always wins.'));
  const allowDefault = current?.allow?.length ? current.allow.join(',') : '';
  const denyDefault = current?.deny?.length ? current.deny.join(',') : '';
  const toolAllow = await askList(rl, 'Allowed tools (comma-separated, empty = all)', allowDefault || undefined);
  const toolDeny = await askList(rl, 'Denied tools (comma-separated, empty = none)', denyDefault || undefined);

  return {
    tools: {
      allow: toolAllow,
      deny: toolDeny,
    },
  };
}

async function askDirectories(rl: RL, current?: Partial<Config>): Promise<Record<string, any>> {
  section('Directories', 7, 'Where to store skills, cron jobs, and plugins');

  const skillsDir = await ask(rl, 'Skills directory', current?.skills?.directory ?? '~/.automate/skills');
  const cronEnabled = current?.cron?.enabled ?? true;
  const pluginsEnabled = current?.plugins?.enabled ?? true;
  const cronDir = cronEnabled
    ? await ask(rl, 'Cron jobs directory', current?.cron?.directory ?? '~/.automate/cron')
    : (current?.cron?.directory ?? '~/.automate/cron');
  const pluginsDir = pluginsEnabled
    ? await ask(rl, 'Plugins directory', current?.plugins?.directory ?? '~/.automate/plugins')
    : (current?.plugins?.directory ?? '~/.automate/plugins');

  return {
    skills: { directory: skillsDir },
    cron: { directory: cronDir },
    plugins: { directory: pluginsDir },
  };
}

// ── Print summary ──
function printSummary(config: Record<string, any>) {
  const configPath = getConfigPath();

  console.log('');
  console.log(chalk.dim('  ─────────────────────────────────────'));
  console.log(chalk.green.bold('  Setup complete!'));
  console.log('');
  console.log(`  Config saved to: ${chalk.cyan(configPath)}`);
  console.log('');

  console.log(chalk.dim('  Configuration summary:'));
  console.log(`    Model:      ${chalk.white(config.agent?.model ?? '?')} @ ${chalk.white(config.agent?.apiBase ?? '?')}`);
  console.log(`    Gateway:    ${chalk.white(`${config.gateway?.host ?? '?'}:${config.gateway?.port ?? '?'}`)} (auth: ${config.gateway?.auth?.mode ?? '?'})`);

  const discord = config.channels?.discord;
  if (discord?.enabled) {
    console.log(`    Discord:    ${chalk.green('enabled')}${discord.publicMode ? chalk.yellow(' (public mode)') : ''}`);
    if (discord.ownerIds?.length > 0) {
      console.log(`    Owners:     ${discord.ownerIds.join(', ')}`);
    }
  }

  console.log(`    Browser:    ${config.browser?.enabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
  console.log(`    Cron:       ${config.cron?.enabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
  const hb = config.heartbeat;
  console.log(`    Heartbeat:  ${hb?.enabled ? chalk.green(`every ${hb.intervalMinutes}m`) : chalk.dim('disabled')}`);
  console.log(`    Embedding:  ${config.memory?.embedding?.enabled ? chalk.green('enabled') : chalk.dim('disabled')}`);

  const toolDeny = config.tools?.deny ?? [];
  if (toolDeny.length > 0) {
    console.log(`    Denied:     ${toolDeny.join(', ')}`);
  }
  console.log('');

  console.log('  Next steps:');
  console.log(`    ${chalk.cyan('automate gateway')}     Start the gateway server`);
  console.log(`    ${chalk.cyan('automate chat')}        Start a CLI chat session`);
  if (discord?.enabled && !discord.token) {
    console.log('');
    console.log(chalk.yellow('  Warning: Discord enabled but no token set. Add it to the config file.'));
  }
  const authMode = config.gateway?.auth?.mode;
  const authToken = config.gateway?.auth?.token;
  if (authMode === 'token' && authToken) {
    console.log('');
    console.log(`  Auth token: ${chalk.yellow(authToken)}`);
    console.log(chalk.dim('  (save this, it won\'t be shown again)'));
  }
  console.log('');
}

// ── Main wizard ──

export async function runOnboardWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('');
  console.log(chalk.cyan.bold('  AutoMate Setup Wizard'));
  console.log(chalk.dim('  ─────────────────────────────────────'));
  console.log(chalk.dim('  Press Enter to accept defaults. Ctrl+C to abort.'));
  console.log('');

  const configPath = getConfigPath();

  if (existsSync(configPath)) {
    // ── Section-based editing mode ──
    // Read raw JSON so we show original values (with ~ paths) not resolved ones
    let currentConfig: Record<string, any>;
    try {
      const { readFileSync } = await import('node:fs');
      currentConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      currentConfig = {};
    }

    console.log(chalk.yellow(`  Existing config found at ${configPath}`));
    console.log('');

    let running = true;
    while (running) {
      console.log(chalk.cyan('  Which section would you like to edit?'));
      console.log('');
      console.log('    1. AI Model');
      console.log('    2. Gateway Security');
      console.log('    3. Discord Channel');
      console.log('    4. Features');
      console.log('    5. Memory & Sessions');
      console.log('    6. Tool Policy');
      console.log('    7. Directories');
      console.log('    8. Re-run full wizard');
      console.log('    9. Exit');
      console.log('');

      const choice = await ask(rl, 'Pick a section (1-9)', '9');

      let partial: Record<string, any> | null = null;

      switch (choice) {
        case '1':
          partial = await askAiModel(rl, currentConfig.agent);
          break;
        case '2':
          partial = await askGateway(rl, currentConfig.gateway);
          break;
        case '3':
          partial = await askDiscord(rl, currentConfig.channels?.discord);
          break;
        case '4':
          partial = await askFeatures(rl, currentConfig as Partial<Config>);
          break;
        case '5':
          partial = await askMemorySessions(
            rl,
            currentConfig as Partial<Config>,
            currentConfig.agent?.apiBase,
            currentConfig.agent?.apiKey,
          );
          break;
        case '6':
          partial = await askToolPolicy(rl, currentConfig.tools);
          break;
        case '7':
          partial = await askDirectories(rl, currentConfig as Partial<Config>);
          break;
        case '8': {
          // Re-run full wizard from scratch
          const full = await runFullWizard(rl);
          currentConfig = full;
          ensureConfigDir();
          saveConfig(currentConfig as any);
          printSummary(currentConfig);
          running = false;
          break;
        }
        case '9':
          running = false;
          break;
        default:
          console.log(chalk.yellow('  Invalid choice, try again.'));
          break;
      }

      if (partial) {
        currentConfig = deepMerge(currentConfig, partial);
        ensureConfigDir();
        saveConfig(currentConfig as any);
        console.log(chalk.green('  Section saved.'));
        console.log('');
      }
    }

    rl.close();
    return;
  }

  // ── Fresh install: run full wizard ──
  const config = await runFullWizard(rl);
  rl.close();

  ensureConfigDir();
  saveConfig(config as any);
  printSummary(config);
}

async function runFullWizard(rl: RL): Promise<Record<string, any>> {
  const step1 = await askAiModel(rl);
  const step2 = await askGateway(rl);
  const step3 = await askDiscord(rl);
  const step4 = await askFeatures(rl);
  const step5 = await askMemorySessions(
    rl,
    undefined,
    step1.agent?.apiBase,
    step1.agent?.apiKey,
  );
  const step6 = await askToolPolicy(rl);
  const step7 = await askDirectories(rl);

  let config: Record<string, any> = {};
  config = deepMerge(config, step1);
  config = deepMerge(config, step2);
  config = deepMerge(config, step3);
  config = deepMerge(config, step4);
  config = deepMerge(config, step5);
  config = deepMerge(config, step6);
  config = deepMerge(config, step7);

  return config;
}
