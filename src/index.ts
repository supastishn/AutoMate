#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, saveConfig, getConfigPath, getConfigDir } from './config/loader.js';
import { Agent } from './agent/agent.js';
import { SessionManager } from './gateway/session-manager.js';
import { GatewayServer } from './gateway/server.js';
import { DiscordChannel } from './channels/discord.js';
import { SkillsLoader } from './skills/loader.js';
import { MemoryManager } from './memory/manager.js';
import { Scheduler } from './cron/scheduler.js';
import { runOnboardWizard } from './onboard/wizard.js';
import { wireHeartbeat } from './heartbeat/manager.js';
import { PluginManager } from './plugins/manager.js';
import { AgentRouter } from './agents/router.js';
import {
  fetchRegistry, searchSkills, installSkill, uninstallSkill,
  updateSkill, updateAllSkills, listInstalled,
  printSkillList, printInstalledList,
} from './clawhub/registry.js';

const program = new Command();

program
  .name('automate')
  .description('AutoMate - Fast personal AI assistant')
  .version('0.1.0');

// Gateway command
program
  .command('gateway')
  .description('Start the AutoMate gateway server')
  .option('-p, --port <port>', 'Port number', '18789')
  .option('-v, --verbose', 'Verbose logging')
  .option('-c, --config <path>', 'Config file path')
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    if (opts.port) config.gateway.port = parseInt(opts.port);

    const startTime = Date.now();
    
    // Load skills
    const skillsLoader = new SkillsLoader(config);
    const skills = skillsLoader.loadAll();
    // NOTE: Skills and memory are NOT baked into the system prompt here.
    // The agent builds the full prompt dynamically on every message
    // so hot-reload and memory updates take effect immediately.

    // Init memory manager
    const memoryManager = new MemoryManager(config.memory.directory, config.memory.embedding);

    // Init session manager
    const sessionManager = new SessionManager(config);

    // Init agent
    const agent = new Agent(config, sessionManager);

    // Wire memory manager into agent
    agent.setMemoryManager(memoryManager);

    // Wire skills loader into agent (for ClawHub hot-install)
    agent.setSkillsLoader(skillsLoader);

    // Background: index memory files for semantic search
    memoryManager.indexAll().then(r => {
      if (r.files > 0) console.log(`[memory] Indexed ${r.files} files (${r.indexed} chunks)`);
    }).catch(() => {/* embedding service may not be available yet */});

    // Declare references early so scheduler callback can use them
    let heartbeatManager: any;
    let discord: DiscordChannel | undefined;

    // Init scheduler (cron jobs)
    let scheduler: Scheduler | undefined;
    if (config.cron.enabled) {
      scheduler = new Scheduler(config.cron.directory, (job) => {
        // Heartbeat jobs trigger the heartbeat manager
        if (job.prompt === '__heartbeat__' && heartbeatManager) {
          heartbeatManager.trigger().catch((err: Error) => {
            console.error(`[heartbeat] Trigger failed: ${err.message}`);
          });
          return;
        }
        const sessionId = job.sessionId || `cron:${job.id}:${Date.now()}`;
        agent.processMessage(sessionId, job.prompt).then(result => {
          // Send cron results to Discord if configured
          if (discord && result?.content) {
            discord.sendProactive(`**[Cron: ${job.name}]**\n${result.content}`, sessionId).catch(err => {
              console.error(`[cron] Discord proactive send failed: ${err}`);
            });
          }
        }).catch(err => {
          console.error(`[cron] Job "${job.name}" failed: ${err}`);
        });
      });
      agent.setScheduler(scheduler);
    }

    // Start skills hot-reload watcher
    skillsLoader.startWatching();

    // Load plugins
    let pluginManager: PluginManager | undefined;
    if (config.plugins?.enabled !== false) {
      pluginManager = new PluginManager(config, config.plugins?.directory);
      try {
        const loaded = await pluginManager.loadAll();
        if (loaded.length > 0) {
          agent.setPluginManager(pluginManager);
          console.log(`  Plugins: ${loaded.map(p => p.manifest.name).join(', ')}`);
          // Start plugin channels
          for (const plugin of loaded) {
            if (plugin.channel) {
              await plugin.channel.start();
            }
          }
        }
      } catch (err) {
        console.error(`[plugins] Failed to load: ${err}`);
      }
    }

    // Wire heartbeat system
    if (config.heartbeat?.enabled && scheduler) {
      heartbeatManager = wireHeartbeat(memoryManager, agent, scheduler, true);
      agent.setHeartbeatManager(heartbeatManager);
    } else if (scheduler) {
      // Create but don't auto-start (user can /heartbeat on)
      heartbeatManager = wireHeartbeat(memoryManager, agent, scheduler, false);
      agent.setHeartbeatManager(heartbeatManager);
    }

    // Start gateway
    const gateway = new GatewayServer(config, agent, sessionManager);

    // Wire heartbeat broadcaster to push live events to all WebSocket clients
    if (heartbeatManager) {
      heartbeatManager.setBroadcaster((msg: Record<string, unknown>) => gateway.broadcastToAll(msg));
    }

    // Wire multi-agent router if agents are configured
    let agentRouter: AgentRouter | undefined;
    if (config.agents && config.agents.length > 0) {
      agentRouter = new AgentRouter(config);
      await agentRouter.initAgents(config.agents);
      gateway.setRouter(agentRouter);
      console.log(`  Agents: ${config.agents.map(a => a.name).join(', ')}`);
    }

    await gateway.start();

    // Start Discord if configured
    if (config.channels.discord.enabled && config.channels.discord.token) {
      discord = new DiscordChannel(config, agent);
      await discord.start();
    }

    const bootTime = Date.now() - startTime;
    console.log(`AutoMate started in ${bootTime}ms`);
    console.log(`  Model: ${config.agent.model}`);
    if (config.agent.providers.length > 0) {
      console.log(`  Failover: ${config.agent.providers.length} backup provider(s)`);
    }
    console.log(`  Gateway: http://${config.gateway.host}:${config.gateway.port}`);
    console.log(`  Dashboard: http://${config.gateway.host}:${config.gateway.port}`);
    console.log(`  WebSocket: ws://${config.gateway.host}:${config.gateway.port}/ws`);
    if (config.canvas?.enabled !== false) {
      console.log(`  Canvas: ws://${config.gateway.host}:${config.gateway.port}/ws/canvas`);
    }
    if (skills.length > 0) {
      console.log(`  Skills: ${skills.map(s => s.name).join(', ')}`);
    }
    if (discord) {
      console.log(`  Discord: connected`);
    }
    if (scheduler) {
      console.log(`  Cron: enabled (${scheduler.listJobs().length} jobs)`);
    }
    if (heartbeatManager?.isActive()) {
      console.log(`  Heartbeat: enabled (every ${config.heartbeat?.intervalMinutes || 30}min)`);
    }
    console.log(`  Memory: ${config.memory.directory}`);
    console.log(`  Config: ${getConfigPath()}`);
    console.log(`  Data: ${getConfigDir()}`);

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      if (agentRouter) agentRouter.shutdown();
      if (scheduler) scheduler.stop();
      skillsLoader.stopWatching();
      sessionManager.saveAll();
      if (discord) await discord.stop();
      // Stop plugin channels
      if (pluginManager) {
        for (const plugin of pluginManager.getPlugins()) {
          if (plugin.channel) await plugin.channel.stop();
        }
      }
      await gateway.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// Chat command (direct CLI chat)
program
  .command('chat')
  .description('Chat with AutoMate from the terminal')
  .option('-m, --message <message>', 'Single message (non-interactive)')
  .option('-c, --config <path>', 'Config file path')
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const sessionManager = new SessionManager(config);
    const skillsLoader = new SkillsLoader(config);
    skillsLoader.loadAll();

    // Init memory manager
    const memoryManager = new MemoryManager(config.memory.directory, config.memory.embedding);

    const agent = new Agent(config, sessionManager);
    agent.setMemoryManager(memoryManager);
    agent.setSkillsLoader(skillsLoader);

    // Background: index memory for semantic search
    memoryManager.indexAll().then(r => {
      if (r.files > 0) console.log(`[memory] Indexed ${r.files} files (${r.indexed} chunks)`);
    }).catch(() => {});

    // Init scheduler for CLI mode too
    let scheduler: Scheduler | undefined;
    if (config.cron.enabled) {
      scheduler = new Scheduler(config.cron.directory, (job) => {
        const sessionId = job.sessionId || `cron:${job.id}:${Date.now()}`;
        agent.processMessage(sessionId, job.prompt).catch(err => {
          console.error(`[cron] Job "${job.name}" failed: ${err}`);
        });
      });
      agent.setScheduler(scheduler);
    }

    const sessionId = `cli:terminal:${Date.now()}`;

    if (opts.message) {
      // Single message mode
      const result = await agent.processMessage(sessionId, opts.message, (chunk) => {
        process.stdout.write(chunk);
      });
      console.log('');
      return;
    }

    // Interactive REPL
    console.log('AutoMate CLI Chat (type /new to reset, /status for info, Ctrl+C to exit)\n');

    const readline = await import('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'you> ',
    });

    rl.prompt();

    rl.on('line', async (line: string) => {
      const input = line.trim();
      if (!input) { rl.prompt(); return; }

      // Commands
      if (input.startsWith('/')) {
        const cmdResult = await agent.handleCommand(sessionId, input);
        if (cmdResult) {
          console.log(cmdResult);
          rl.prompt();
          return;
        }
      }

      process.stdout.write('\nautomate> ');
      await agent.processMessage(sessionId, input, (chunk) => {
        process.stdout.write(chunk);
      });
      console.log('\n');
      rl.prompt();
    });

    rl.on('close', () => {
      if (scheduler) scheduler.stop();
      sessionManager.saveAll();
      console.log('\nBye!');
      process.exit(0);
    });
  });

// Status command
program
  .command('status')
  .description('Check gateway status')
  .option('-p, --port <port>', 'Gateway port', '18789')
  .action(async (opts) => {
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/api/health`);
      const data = await res.json();
      console.log('Gateway Status:', JSON.stringify(data, null, 2));
    } catch {
      console.log('Gateway is not running.');
    }
  });

// Config command
program
  .command('config')
  .description('Show or edit configuration')
  .option('--path', 'Show config file path')
  .action((opts) => {
    if (opts.path) {
      console.log(getConfigPath());
      return;
    }
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
  });

// Factory reset command
program
  .command('factory-reset')
  .description('Wipe all memory, identity, sessions — restore to first-run state')
  .option('-c, --config <path>', 'Config file path')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (opts) => {
    if (!opts.yes) {
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(resolve => {
        rl.question('This will delete ALL memory, identity, and session files. Are you sure? (y/N): ', resolve);
      });
      rl.close();
      if (answer.trim().toLowerCase() !== 'y') {
        console.log('Aborted.');
        return;
      }
    }
    const config = loadConfig(opts.config);
    const mm = new MemoryManager(config.memory.directory, config.memory.embedding);
    mm.factoryReset();
    const sm = new SessionManager(config);
    for (const s of sm.listSessions()) {
      sm.deleteSession(s.id);
    }
    console.log('Factory reset complete. All memory, identity, and sessions wiped.');
    console.log('Default templates restored. Next run will start the bootstrap conversation.');
  });

// Doctor command
program
  .command('doctor')
  .description('Security audit - check AutoMate configuration for issues')
  .option('-c, --config <path>', 'Config file path')
  .action((opts) => {
    const config = loadConfig(opts.config);
    const issues: string[] = [];
    const ok: string[] = [];

    // Auth check
    if (config.gateway.auth.mode === 'none') {
      issues.push('[WARN] Auth mode is "none" - anyone can access the API');
    } else {
      ok.push('[OK] Auth mode: ' + config.gateway.auth.mode);
    }

    if (config.gateway.auth.mode === 'token' && !config.gateway.auth.token) {
      issues.push('[WARN] Token auth enabled but no token set');
    }

    // Network binding
    if (config.gateway.host !== '127.0.0.1' && config.gateway.host !== 'localhost') {
      issues.push(`[WARN] Gateway bound to ${config.gateway.host} - exposed to network`);
    } else {
      ok.push('[OK] Gateway bound to localhost only');
    }

    // Discord
    if (config.channels.discord.enabled) {
      if (config.channels.discord.allowFrom.includes('*')) {
        issues.push('[WARN] Discord allows messages from ALL users');
      } else {
        ok.push(`[OK] Discord restricted to ${config.channels.discord.allowFrom.length} users`);
      }
    }

    // Tool policy
    if (config.tools.deny.length > 0) {
      ok.push(`[OK] ${config.tools.deny.length} tools denied by policy`);
    } else {
      issues.push('[INFO] No tool deny list configured - agent can use all tools');
    }

    // Browser
    if (config.browser.enabled) {
      issues.push('[INFO] Browser automation enabled - agent can browse the web');
    }

    // Webhooks
    if (config.webhooks.enabled && !config.webhooks.token) {
      issues.push('[WARN] Webhooks enabled without auth token');
    }

    // Cron
    if (config.cron.enabled) {
      ok.push('[OK] Cron scheduler enabled');
    }

    // Memory
    ok.push(`[OK] Memory directory: ${config.memory.directory}`);

    console.log('\nAutoMate Security Audit\n');
    for (const msg of ok) console.log('  ' + msg);
    for (const msg of issues) console.log('  ' + msg);
    console.log(`\n  ${ok.length} passed, ${issues.length} warnings/info\n`);
  });

// Send command
program
  .command('send')
  .description('Send a message to the agent via the gateway')
  .argument('<message>', 'Message to send')
  .option('-p, --port <port>', 'Gateway port', '18789')
  .option('-s, --session <id>', 'Session ID')
  .action(async (message, opts) => {
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, session_id: opts.session }),
      });
      const data = await res.json() as any;
      console.log(data.response);
    } catch {
      console.log('Failed to connect to gateway. Is it running?');
    }
  });

// Onboard command
program
  .command('onboard')
  .description('Interactive setup wizard for first-time configuration')
  .action(async () => {
    await runOnboardWizard();
  });

// ClawHub commands
const clawhub = program
  .command('clawhub')
  .description('Browse, install, and manage skills from the ClawHub community registry');

clawhub
  .command('browse')
  .description('Browse all available skills in the ClawHub registry')
  .action(async () => {
    console.log('\nFetching skills from ClawHub...\n');
    const skills = await fetchRegistry();
    printSkillList(skills);
    console.log(`  ${skills.length} skills available. Install with: automate clawhub install <repo>\n`);
  });

clawhub
  .command('search')
  .description('Search for skills by name, description, or tag')
  .argument('<query>', 'Search query')
  .action(async (query) => {
    console.log(`\nSearching ClawHub for "${query}"...\n`);
    const skills = await searchSkills(query);
    printSkillList(skills);
    if (skills.length === 0) {
      console.log('  Try a different search term, or browse all with: automate clawhub browse\n');
    }
  });

clawhub
  .command('install')
  .description('Install a skill from a GitHub repo')
  .argument('<repo>', 'GitHub repo (user/repo or full URL)')
  .option('-c, --config <path>', 'Config file path')
  .action(async (repo, opts) => {
    const config = loadConfig(opts.config);
    console.log(`\nInstalling skill from ${repo}...\n`);
    const result = await installSkill(repo, config.skills.directory);
    if (result.success) {
      const chalk = (await import('chalk')).default;
      console.log(chalk.green(`  Installed "${result.name}" to ${config.skills.directory}/${result.name}/`));
      console.log('  It will be automatically loaded on next gateway start (or hot-reloaded if running).\n');
    } else {
      const chalk = (await import('chalk')).default;
      console.log(chalk.red(`  Failed: ${result.error}\n`));
    }
  });

clawhub
  .command('uninstall')
  .description('Uninstall a ClawHub skill')
  .argument('<name>', 'Skill name')
  .option('-c, --config <path>', 'Config file path')
  .action(async (name, opts) => {
    const config = loadConfig(opts.config);
    const result = uninstallSkill(name, config.skills.directory);
    const chalk = (await import('chalk')).default;
    if (result.success) {
      console.log(chalk.green(`  Uninstalled "${name}"\n`));
    } else {
      console.log(chalk.red(`  Failed: ${result.error}\n`));
    }
  });

clawhub
  .command('update')
  .description('Update an installed skill (or all skills)')
  .argument('[name]', 'Skill name (omit to update all)')
  .option('-c, --config <path>', 'Config file path')
  .action(async (name, opts) => {
    const config = loadConfig(opts.config);
    const chalk = (await import('chalk')).default;
    if (name) {
      console.log(`\nUpdating "${name}"...\n`);
      const result = await updateSkill(name, config.skills.directory);
      if (result.success) {
        console.log(chalk.green(`  Updated "${name}"\n`));
      } else {
        console.log(chalk.red(`  Failed: ${result.error}\n`));
      }
    } else {
      console.log('\nUpdating all ClawHub skills...\n');
      const result = await updateAllSkills(config.skills.directory);
      if (result.updated.length > 0) {
        console.log(chalk.green(`  Updated: ${result.updated.join(', ')}`));
      }
      if (result.failed.length > 0) {
        console.log(chalk.red(`  Failed: ${result.failed.join(', ')}`));
      }
      if (result.updated.length === 0 && result.failed.length === 0) {
        console.log('  No ClawHub skills installed.\n');
      }
      console.log('');
    }
  });

clawhub
  .command('list')
  .description('List installed ClawHub skills')
  .option('-c, --config <path>', 'Config file path')
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    console.log('\nInstalled ClawHub skills:\n');
    const installed = listInstalled(config.skills.directory);
    printInstalledList(installed);
    console.log('');
  });

program.parse();
