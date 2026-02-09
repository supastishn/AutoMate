import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { saveConfig, getConfigPath, ensureConfigDir } from '../config/loader.js';
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

export async function runOnboardWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('');
  console.log(chalk.cyan.bold('  AutoMate Setup Wizard'));
  console.log(chalk.dim('  ─────────────────────────────────────'));
  console.log(chalk.dim('  Press Enter to accept defaults. Ctrl+C to abort.'));
  console.log('');

  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    console.log(chalk.yellow(`  Existing config found at ${configPath}`));
    const overwrite = await askYesNo(rl, 'Overwrite existing config?', false);
    if (!overwrite) {
      console.log(chalk.dim('  Aborted.'));
      rl.close();
      return;
    }
  }

  // ── Step 1: AI Model ──
  section('AI Model', 1, 'Works with any OpenAI-compatible API (OpenAI, Anthropic proxy, Ollama, LiteLLM, OpenRouter)');

  const apiBase = await ask(rl, 'API base URL', 'http://localhost:4141/v1');
  const model = await ask(rl, 'Model name', 'claude-opus-4.6');
  const apiKey = await ask(rl, 'API key (leave empty if not needed)');
  const maxTokensStr = await ask(rl, 'Max output tokens', '8192');
  const maxTokens = parseInt(maxTokensStr) || 8192;
  const tempStr = await ask(rl, 'Temperature (0.0-1.0)', '0.3');
  const temperature = parseFloat(tempStr) || 0.3;

  // ── Step 2: Gateway Security ──
  section('Gateway Security', 2, 'Controls who can access the AutoMate web API');

  const host = await ask(rl, 'Bind address (127.0.0.1 = local only, 0.0.0.0 = public)', '127.0.0.1');
  const portStr = await ask(rl, 'Port', '18789');
  const port = parseInt(portStr) || 18789;
  const authMode = await askChoice(rl, 'Auth mode', ['none', 'token', 'password'], 'token') as 'none' | 'token' | 'password';

  let authToken = '';
  let authPassword = '';
  if (authMode === 'token') {
    authToken = await ask(rl, 'Auth token (leave empty to auto-generate)');
    if (!authToken) {
      authToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      console.log(chalk.dim(`     Generated: ${authToken}`));
    }
  } else if (authMode === 'password') {
    authPassword = await ask(rl, 'Password');
  }

  // ── Step 3: Discord ──
  section('Discord Channel', 3, 'Connect AutoMate to a Discord bot');

  const discordEnabled = await askYesNo(rl, 'Enable Discord bot?', false);
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

    discordToken = await ask(rl, 'Bot token');
    discordClientId = await ask(rl, 'Client/Application ID (for slash commands)');
    console.log('');

    // Multi-user / public server mode
    console.log(chalk.dim('     Public mode: bot chats with everyone, but only owners can use tools'));
    discordPublicMode = await askYesNo(rl, 'Enable public mode (multi-user server)?', false);

    if (discordPublicMode) {
      console.log(chalk.dim('     Owner IDs: Discord user IDs with full tool access'));
      console.log(chalk.dim('     Get your ID: Discord settings > Advanced > Developer Mode, right-click yourself'));
      const ownerList = await ask(rl, 'Owner user IDs (comma-separated)');
      discordOwnerIds = ownerList ? ownerList.split(',').map(s => s.trim()).filter(Boolean) : [];

      discordAllowFrom = ['*']; // everyone can chat in public mode

      console.log(chalk.dim('     Public tools: what non-owners can use (empty = chat only, no tools)'));
      console.log(chalk.dim('     Available: read_file, list_directory, search_files, web_search, web_fetch, analyze_image'));
      const pubTools = await ask(rl, 'Public tools (comma-separated, or "none")', 'web_search,analyze_image');
      if (pubTools === 'none') {
        discordPublicTools = [];
      } else {
        discordPublicTools = pubTools.split(',').map(s => s.trim()).filter(Boolean);
      }
    } else {
      console.log(chalk.dim('     Restrict to specific Discord user IDs, or * for anyone'));
      const allowStr = await ask(rl, 'Allowed user IDs (comma-separated, * = anyone)', '*');
      discordAllowFrom = allowStr.split(',').map(s => s.trim()).filter(Boolean);
    }

    console.log('');
    console.log(chalk.dim('     Channel restrictions: limit bot to specific channel IDs, or * for all'));
    const chanStr = await ask(rl, 'Allowed channel IDs (comma-separated, * = all)', '*');
    discordAllowChannels = chanStr.split(',').map(s => s.trim()).filter(Boolean);

    discordProactiveChannelId = await ask(rl, 'Proactive message channel ID (for cron/heartbeat results, leave empty to skip)');
    console.log('');

    // UI preferences
    console.log(chalk.dim('     Response style'));
    discordUseEmbeds = await askYesNo(rl, 'Use rich embeds?', true);
    discordShowButtons = await askYesNo(rl, 'Show action buttons (Reset/Status/Compact)?', true);
    discordUseThreads = await askYesNo(rl, 'Auto-create threads for long conversations?', true);
    discordStreamEdits = await askYesNo(rl, 'Stream responses via message editing?', true);
    discordRegisterSlash = await askYesNo(rl, 'Register slash commands (/chat, /status, etc.)?', true);
  }

  // ── Step 4: Features ──
  section('Features', 4, 'Enable or disable major subsystems');

  const browserEnabled = await askYesNo(rl, 'Enable browser automation (requires Python + Chrome)?', true);
  const cronEnabled = await askYesNo(rl, 'Enable cron scheduler?', true);
  const webhooksEnabled = await askYesNo(rl, 'Enable incoming webhooks?', false);
  const canvasEnabled = await askYesNo(rl, 'Enable canvas (collaborative drawing/notes in web UI)?', true);
  const pluginsEnabled = await askYesNo(rl, 'Enable plugin system?', true);
  const heartbeatEnabled = await askYesNo(rl, 'Enable heartbeat (periodic agent check-ins)?', false);
  let heartbeatInterval = 30;
  if (heartbeatEnabled) {
    const hbStr = await ask(rl, 'Heartbeat interval (minutes)', '30');
    heartbeatInterval = parseInt(hbStr) || 30;
  }

  // ── Step 5: Memory & Sessions ──
  section('Memory & Sessions', 5, 'Configure memory, sessions, and semantic search');

  const memoryDir = await ask(rl, 'Memory directory', '~/.automate/memory');
  const sharedMemDir = await ask(rl, 'Shared memory directory (multi-agent)', '~/.automate/shared');
  const sessionsDir = await ask(rl, 'Sessions directory', '~/.automate/sessions');
  const maxHistoryStr = await ask(rl, 'Max messages per session before compaction', '200');
  const maxHistory = parseInt(maxHistoryStr) || 200;
  const compactStr = await ask(rl, 'Compact threshold (when to start compacting)', '150');
  const compactThreshold = parseInt(compactStr) || 150;

  console.log('');
  console.log(chalk.dim('     Semantic search: uses embeddings for smarter memory recall'));
  const embeddingEnabled = await askYesNo(rl, 'Enable semantic search (requires embedding API)?', true);
  let embeddingModel = 'text-embedding-3-small';
  let embeddingApiBase = apiBase;
  let embeddingApiKey = apiKey;
  if (embeddingEnabled) {
    embeddingModel = await ask(rl, 'Embedding model', 'text-embedding-3-small');
    embeddingApiBase = await ask(rl, 'Embedding API base (same as main API?)', apiBase);
    const embKey = await ask(rl, 'Embedding API key (leave empty to reuse main key)');
    if (embKey) embeddingApiKey = embKey;
  }

  // ── Step 6: Tool Policy ──
  section('Tool Policy', 6, 'Restrict which tools the agent can use');

  console.log(chalk.dim('     Leave empty to allow all tools. Deny list always wins.'));
  const toolAllow = await askList(rl, 'Allowed tools (comma-separated, empty = all)');
  const toolDeny = await askList(rl, 'Denied tools (comma-separated, empty = none)');

  // ── Step 7: Directories ──
  section('Directories', 7, 'Where to store skills, cron jobs, and plugins');

  const skillsDir = await ask(rl, 'Skills directory', '~/.automate/skills');
  const cronDir = cronEnabled ? await ask(rl, 'Cron jobs directory', '~/.automate/cron') : '~/.automate/cron';
  const pluginsDir = pluginsEnabled ? await ask(rl, 'Plugins directory', '~/.automate/plugins') : '~/.automate/plugins';

  rl.close();

  // ── Build config ──
  const config: Record<string, any> = {
    agent: {
      model,
      apiBase,
      ...(apiKey ? { apiKey } : {}),
      maxTokens,
      temperature,
    },
    gateway: {
      port,
      host,
      auth: {
        mode: authMode,
        ...(authMode === 'token' && authToken ? { token: authToken } : {}),
        ...(authMode === 'password' && authPassword ? { password: authPassword } : {}),
      },
    },
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
    browser: {
      enabled: browserEnabled,
      headless: true,
    },
    cron: {
      enabled: cronEnabled,
      directory: cronDir,
    },
    webhooks: {
      enabled: webhooksEnabled,
    },
    canvas: {
      enabled: canvasEnabled,
    },
    plugins: {
      enabled: pluginsEnabled,
      directory: pluginsDir,
    },
    heartbeat: {
      enabled: heartbeatEnabled,
      intervalMinutes: heartbeatInterval,
    },
    skills: {
      directory: skillsDir,
    },
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
      maxHistory,
      compactThreshold,
    },
    tools: {
      allow: toolAllow,
      deny: toolDeny,
    },
  };

  ensureConfigDir();
  saveConfig(config as any);

  // ── Summary ──
  console.log('');
  console.log(chalk.dim('  ─────────────────────────────────────'));
  console.log(chalk.green.bold('  Setup complete!'));
  console.log('');
  console.log(`  Config saved to: ${chalk.cyan(configPath)}`);
  console.log('');

  // Print key settings
  console.log(chalk.dim('  Configuration summary:'));
  console.log(`    Model:      ${chalk.white(model)} @ ${chalk.white(apiBase)}`);
  console.log(`    Gateway:    ${chalk.white(`${host}:${port}`)} (auth: ${authMode})`);
  if (discordEnabled) {
    console.log(`    Discord:    ${chalk.green('enabled')}${discordPublicMode ? chalk.yellow(' (public mode)') : ''}`);
    if (discordOwnerIds.length > 0) {
      console.log(`    Owners:     ${discordOwnerIds.join(', ')}`);
    }
  }
  console.log(`    Browser:    ${browserEnabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
  console.log(`    Cron:       ${cronEnabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
  console.log(`    Heartbeat:  ${heartbeatEnabled ? chalk.green(`every ${heartbeatInterval}m`) : chalk.dim('disabled')}`);
  console.log(`    Embedding:  ${embeddingEnabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
  if (toolDeny.length > 0) {
    console.log(`    Denied:     ${toolDeny.join(', ')}`);
  }
  console.log('');

  console.log('  Next steps:');
  console.log(`    ${chalk.cyan('automate gateway')}     Start the gateway server`);
  console.log(`    ${chalk.cyan('automate chat')}        Start a CLI chat session`);
  if (discordEnabled && !discordToken) {
    console.log('');
    console.log(chalk.yellow('  Warning: Discord enabled but no token set. Add it to the config file.'));
  }
  if (authMode === 'token' && authToken) {
    console.log('');
    console.log(`  Auth token: ${chalk.yellow(authToken)}`);
    console.log(chalk.dim('  (save this, it won\'t be shown again)'));
  }
  console.log('');
}
