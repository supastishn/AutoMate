#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, saveConfig, getConfigPath, getConfigDir, watchConfig, onConfigChange } from './config/loader.js';
import { Agent } from './agent/agent.js';
import { SessionManager } from './gateway/session-manager.js';
import { GatewayServer } from './gateway/server.js';
import { DiscordChannel } from './channels/discord.js';
import { SkillsLoader } from './skills/loader.js';
import { MemoryManager } from './memory/manager.js';
import { Scheduler } from './cron/scheduler.js';
import { runOnboardWizard } from './onboard/wizard.js';
import { wireHeartbeat, isHeartbeatJob, isHeartbeatTask, heartbeatTaskId } from './heartbeat/manager.js';
import { syncConfigToGoals } from './agent/tools/goals.js';
import { PluginManager } from './plugins/manager.js';
import { AgentRouter } from './agents/router.js';
import { setSubAgentPersistPath, getInterruptedAgents, cleanupFinishedAgents } from './agent/tools/subagent.js';
import { setCanvasPersistPath, setCanvasUploadDir, setCanvasServices } from './canvas/canvas-manager.js';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync } from 'node:fs';
import {
  fetchRegistry, searchSkills, installSkill, uninstallSkill,
  updateSkill, updateAllSkills, listInstalled,
  printSkillList, printInstalledList,
} from './clawhub/registry.js';

/** Sync termux-job-scheduler registration with config toggle */
function syncTermuxScheduler(config: any): void {
  const enabled = config.heartbeat?.termuxScheduler === true && config.heartbeat?.enabled !== false;
  const intervalMs = (config.heartbeat?.intervalMinutes || 60) * 60 * 1000;

  try {
    const which = execSync('which termux-job-scheduler 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (!which) return;

    if (enabled) {
      const scriptSrc = join(import.meta.dirname || '.', '..', 'bin', 'termux-heartbeat.sh');
      const scriptDst = join(getConfigDir(), 'termux-heartbeat.sh');
      if (existsSync(scriptSrc)) {
        copyFileSync(scriptSrc, scriptDst);
        chmodSync(scriptDst, 0o755);
      }
      execSync(`termux-job-scheduler --script "${scriptDst}" --period-ms ${intervalMs} --persisted true --battery-not-low true`, { stdio: 'pipe', timeout: 10000 });
      console.log(`  Termux scheduler: registered (every ${config.heartbeat?.intervalMinutes || 60}min)`);
    } else {
      execSync('termux-job-scheduler --cancel-all', { stdio: 'pipe', timeout: 10000 });
    }
  } catch {
    // Not on Termux or termux-api not installed — silently ignore
  }
}

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

    // Sync process timezone to user's configured timezone
    if (config.timezone && config.timezone !== 'UTC') {
      process.env.TZ = config.timezone;
    }

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

    // Wire memory manager into session manager for transcript indexing
    if (config.memory.indexTranscripts !== false) {
      sessionManager.setMemoryManager(memoryManager);
    }

    // Init agent
    const agent = new Agent(config, sessionManager);

    // Wire memory manager into agent
    agent.setMemoryManager(memoryManager);

    // Set up subagent persistence path (inside sessions dir)
    const subagentPersistPath = join(config.sessions.directory.replace(/^~/, process.env.HOME || ''), 'subagents.json');
    setSubAgentPersistPath(subagentPersistPath);

    // Set up all-time stats persistence
    const statsPath = join(getConfigDir(), 'stats.json');
    agent.setStatsPath(statsPath);

    // Set up canvas persistence path (inside sessions dir)
    const canvasPersistPath = join(config.sessions.directory.replace(/^~/, process.env.HOME || ''), 'canvases.json');
    setCanvasPersistPath(canvasPersistPath);
    // Set up canvas upload directory
    const canvasUploadDir = join(config.memory.directory.replace(/^~/, process.env.HOME || ''), 'uploads');
    setCanvasUploadDir(canvasUploadDir);
    // Wire core services to canvas (same access as plugins)
    setCanvasServices({ memory: memoryManager, sessions: undefined, scheduler: undefined, agent });

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
        if (isHeartbeatJob(job.prompt) && heartbeatManager) {
          heartbeatManager.trigger().catch((err: Error) => {
            console.error(`[heartbeat] Trigger failed: ${err.message}`);
          });
          return;
        }
        // Heartbeat task jobs trigger specific tasks
        if (isHeartbeatTask(job.prompt) && heartbeatManager) {
          const taskId = heartbeatTaskId(job.prompt);
          if (taskId) {
            heartbeatManager.triggerTask(taskId).catch((err: Error) => {
              console.error(`[heartbeat] Task trigger failed: ${err.message}`);
            });
          }
          return;
        }
        const sessionId = job.sessionId || sessionManager.getSessionByRole('work') || `cron:${job.id}:${Date.now()}`;
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

    // Start config file watcher for live reload
    onConfigChange((newConfig) => {
      // Update agent config (system prompt, power steering, etc.)
      agent.updateConfig(newConfig);
      // Sync heartbeat config → goals.json settings
      syncConfigToGoals(memoryManager.getDirectory(), {
        adaptiveInterval: newConfig.heartbeat?.adaptiveInterval,
        dailyReport: newConfig.heartbeat?.dailyReport,
        autoProcessGoals: newConfig.heartbeat?.autoProcessGoals,
        maxInProgressGoals: newConfig.heartbeat?.maxInProgressGoals,
        escalation: newConfig.heartbeat?.escalation,
        autoApproveMinutes: newConfig.heartbeat?.autoApproveMinutes,
      });
      // Update heartbeat interval and jitter if changed
      if (heartbeatManager && newConfig.heartbeat?.intervalMinutes) {
        const newIntervalMs = newConfig.heartbeat.intervalMinutes * 60 * 1000;
        const newJitterMs = (newConfig.heartbeat.jitterMinutes || 0) * 60 * 1000;
        heartbeatManager.updateInterval(newIntervalMs, newJitterMs);
        console.log(`[config] Applied: systemPrompt, powerSteering, temperature, maxTokens, heartbeat.intervalMinutes=${newConfig.heartbeat.intervalMinutes}, jitterMinutes=${newConfig.heartbeat.jitterMinutes || 0}`);
      } else {
        console.log(`[config] Applied: systemPrompt, powerSteering, temperature, maxTokens`);
      }
      // Sync termux scheduler on config change
      syncTermuxScheduler(newConfig);
    });
    watchConfig();

    // Load plugins
    let pluginManager: PluginManager | undefined;
    if (config.plugins?.enabled !== false) {
      pluginManager = new PluginManager(config, config.plugins?.directory);
      pluginManager.setCoreServices(memoryManager, sessionManager, scheduler, agent);
      try {
        const loaded = await pluginManager.loadAll();
        // Always wire the plugin manager so the `plugin create` tool works even with 0 plugins
        agent.setPluginManager(pluginManager);
        if (loaded.length > 0) {
          console.log(`  Plugins: ${loaded.map(p => p.manifest.name).join(', ')}`);
          // Start plugin channels
          for (const plugin of loaded) {
            if (plugin.channel) {
              await plugin.channel.start();
            }
          }
        }
        pluginManager.startWatching();
      } catch (err) {
        console.error(`[plugins] Failed to load: ${err}`);
      }
    }

    // Sync heartbeat config → goals.json settings
    syncConfigToGoals(memoryManager.getDirectory(), {
      adaptiveInterval: config.heartbeat?.adaptiveInterval,
      dailyReport: config.heartbeat?.dailyReport,
      autoProcessGoals: config.heartbeat?.autoProcessGoals,
      maxInProgressGoals: config.heartbeat?.maxInProgressGoals,
      escalation: config.heartbeat?.escalation,
      autoApproveMinutes: config.heartbeat?.autoApproveMinutes,
    });

    // Wire heartbeat system
    const heartbeatIntervalMs = (config.heartbeat?.intervalMinutes || 60) * 60 * 1000;
    const heartbeatJitterMs = (config.heartbeat?.jitterMinutes ?? 1) * 60 * 1000;
    // Heartbeats use work session if set, otherwise dedicated heartbeat session
    const heartbeatSessionId = sessionManager.getSessionByRole('work')
      || (config.heartbeat as any)?.sessionId
      || 'webchat:heartbeat';
    if (config.heartbeat?.enabled && scheduler) {
      heartbeatManager = wireHeartbeat(memoryManager, agent, scheduler, true, undefined, heartbeatIntervalMs, heartbeatJitterMs);
      heartbeatManager.setTargetSession(heartbeatSessionId);
      agent.setHeartbeatManager(heartbeatManager);
    } else if (scheduler) {
      // Create but don't auto-start (user can /heartbeat on)
      heartbeatManager = wireHeartbeat(memoryManager, agent, scheduler, false, undefined, heartbeatIntervalMs, heartbeatJitterMs);
      heartbeatManager.setTargetSession(heartbeatSessionId);
      agent.setHeartbeatManager(heartbeatManager);
    }

    // Sync termux-job-scheduler if toggled
    syncTermuxScheduler(config);

    // Start gateway
    const gateway = new GatewayServer(config, agent, sessionManager);

    // Wire gateway broadcast functions to plugin manager so plugins can stream responses to webchat
    if (pluginManager) {
      pluginManager.setGatewayBroadcast(
        (sessionId, payload) => gateway.sendToSession(sessionId, payload),
        (payload) => gateway.broadcastToAll(payload),
      );
    }

    // Wire gateway broadcast functions to canvas (same power as plugins)
    setCanvasServices({
      memory: memoryManager, sessions: sessionManager, scheduler, agent,
      sendToSession: (sessionId, payload) => gateway.sendToSession(sessionId, payload),
      broadcastToAll: (payload) => gateway.broadcastToAll(payload),
    });

    // Wire sendToSession to agent so automated notifications (subagent, heartbeat) stream to webchat
    agent.setSendToSession((sessionId, payload) => gateway.sendToSession(sessionId, payload));

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
      // Wire heartbeat broadcaster to push live events from per-agent heartbeats
      agentRouter.setHeartbeatBroadcaster((msg: Record<string, unknown>) => gateway.broadcastToAll(msg));
      const agentNames = config.agents.map(a => a.name);
      const hbAgents = config.agents.filter(a => a.heartbeat?.enabled).map(a => a.name);
      console.log(`  Agents: ${agentNames.join(', ')}`);
      if (hbAgents.length > 0) {
        console.log(`  Per-agent heartbeats: ${hbAgents.join(', ')}`);
      }
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
      console.log(`  Heartbeat: enabled (every ${config.heartbeat?.intervalMinutes || 60}min)`);
    }
    console.log(`  Memory: ${config.memory.directory}`);
    console.log(`  Config: ${getConfigPath()}`);
    console.log(`  Data: ${getConfigDir()}`);

    // Mark interrupted subagents as expired (don't auto-resume — wastes API calls)
    const interruptedAgents = getInterruptedAgents();
    if (interruptedAgents.length > 0) {
      console.log(`  Expired ${interruptedAgents.length} interrupted subagent(s) from previous run.`);
    }

    // Clean up old finished subagents (>24h)
    const cleaned = cleanupFinishedAgents();
    if (cleaned > 0) {
      console.log(`  Cleaned up ${cleaned} old finished subagent(s).`);
    }

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

    // Sync timezone
    if (config.timezone && config.timezone !== 'UTC') {
      process.env.TZ = config.timezone;
    }

    const sessionManager = new SessionManager(config);
    const skillsLoader = new SkillsLoader(config);
    skillsLoader.loadAll();

    // Init memory manager
    const memoryManager = new MemoryManager(config.memory.directory, config.memory.embedding);

    // Wire transcript indexing in CLI mode too
    if (config.memory.indexTranscripts !== false) {
      sessionManager.setMemoryManager(memoryManager);
    }

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
