#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, saveConfig, getConfigPath, getConfigDir } from './config/loader.js';
import { Agent } from './agent/agent.js';
import { SessionManager } from './gateway/session-manager.js';
import { GatewayServer } from './gateway/server.js';
import { DiscordChannel } from './channels/discord.js';
import { SkillsLoader } from './skills/loader.js';

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
    
    // Inject skills into system prompt
    const skillsPrompt = skillsLoader.getSystemPromptInjection();
    if (skillsPrompt) {
      config.agent.systemPrompt += skillsPrompt;
    }

    // Init session manager
    const sessionManager = new SessionManager(config);

    // Init agent
    const agent = new Agent(config, sessionManager);

    // Start gateway
    const gateway = new GatewayServer(config, agent, sessionManager);
    await gateway.start();

    // Start Discord if configured
    let discord: DiscordChannel | undefined;
    if (config.channels.discord.enabled && config.channels.discord.token) {
      discord = new DiscordChannel(config, agent);
      await discord.start();
    }

    const bootTime = Date.now() - startTime;
    console.log(`AutoMate started in ${bootTime}ms`);
    console.log(`  Model: ${config.agent.model}`);
    console.log(`  Gateway: http://${config.gateway.host}:${config.gateway.port}`);
    console.log(`  Dashboard: http://${config.gateway.host}:${config.gateway.port}`);
    console.log(`  WebSocket: ws://${config.gateway.host}:${config.gateway.port}/ws`);
    if (skills.length > 0) {
      console.log(`  Skills: ${skills.map(s => s.name).join(', ')}`);
    }
    if (discord) {
      console.log(`  Discord: connected`);
    }
    console.log(`  Config: ${getConfigPath()}`);
    console.log(`  Data: ${getConfigDir()}`);

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      sessionManager.saveAll();
      if (discord) await discord.stop();
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
    const skillsPrompt = skillsLoader.getSystemPromptInjection();
    if (skillsPrompt) config.agent.systemPrompt += skillsPrompt;
    skillsLoader.loadAll();

    const agent = new Agent(config, sessionManager);
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
        const cmdResult = agent.handleCommand(sessionId, input);
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

program.parse();
