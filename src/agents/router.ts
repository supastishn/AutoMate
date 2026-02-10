/**
 * Multi-Agent Router — manages multiple agent personalities with isolated
 * memory, sessions, skills, and channel routing.
 */

import { Agent } from '../agent/agent.js';
import { SessionManager } from '../gateway/session-manager.js';
import { MemoryManager } from '../memory/manager.js';
import { SkillsLoader } from '../skills/loader.js';
import { Scheduler } from '../cron/scheduler.js';
import type { Config } from '../config/schema.js';
import type { AgentResponse, StreamCallback } from '../agent/agent.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentProfile {
  name: string;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  memoryDir?: string;
  sessionsDir?: string;
  skillsDir?: string;
  elevated?: boolean;           // default elevated state
  channels?: string[];          // channel patterns this agent handles (e.g. "discord:*", "webchat:*")
  allowFrom?: string[];         // user IDs this agent accepts
  tools?: {
    allow?: string[];
    deny?: string[];
  };
}

export interface ManagedAgent {
  name: string;
  agent: Agent;
  sessionManager: SessionManager;
  memoryManager: MemoryManager;
  skillsLoader: SkillsLoader;
  scheduler?: Scheduler;
  channels: string[];           // channel patterns
  allowFrom: string[];
}

export class AgentRouter {
  private agents: Map<string, ManagedAgent> = new Map();
  private defaultAgentName: string | null = null;
  private baseConfig: Config;

  constructor(baseConfig: Config) {
    this.baseConfig = baseConfig;
  }

  /** Initialize agents from config. Creates isolated instances per profile. */
  async initAgents(profiles: AgentProfile[]): Promise<void> {
    for (const profile of profiles) {
      const managed = this.createManagedAgent(profile);
      this.agents.set(profile.name, managed);

      if (!this.defaultAgentName) {
        this.defaultAgentName = profile.name;
      }

      // Background index memory
      managed.memoryManager.indexAll().then(r => {
        if (r.files > 0) console.log(`[agent:${profile.name}] Indexed ${r.files} files (${r.indexed} chunks)`);
      }).catch(() => {});
    }
  }

  private createManagedAgent(profile: AgentProfile): ManagedAgent {
    // Build per-agent config by overlaying profile onto base config
    const agentConfig: Config = {
      ...this.baseConfig,
      agent: {
        ...this.baseConfig.agent,
        model: profile.model || this.baseConfig.agent.model,
        apiBase: profile.apiBase || this.baseConfig.agent.apiBase,
        apiKey: profile.apiKey || this.baseConfig.agent.apiKey,
        systemPrompt: profile.systemPrompt || this.baseConfig.agent.systemPrompt,
        maxTokens: profile.maxTokens || this.baseConfig.agent.maxTokens,
        temperature: profile.temperature ?? this.baseConfig.agent.temperature,
        providers: this.baseConfig.agent.providers,
      },
      memory: {
        ...this.baseConfig.memory,
        directory: profile.memoryDir || join(homedir(), '.automate', 'agents', profile.name, 'memory'),
      },
      sessions: {
        ...this.baseConfig.sessions,
        directory: profile.sessionsDir || join(homedir(), '.automate', 'agents', profile.name, 'sessions'),
      },
      skills: {
        ...this.baseConfig.skills,
        directory: profile.skillsDir || this.baseConfig.skills.directory,
      },
      tools: profile.tools ? {
        allow: profile.tools.allow || [],
        deny: profile.tools.deny || [],
      } : this.baseConfig.tools,
    };

    const sessionManager = new SessionManager(agentConfig);
    const memoryManager = new MemoryManager(agentConfig.memory.directory, agentConfig.memory.embedding);
    const skillsLoader = new SkillsLoader(agentConfig);
    skillsLoader.loadAll();

    const agent = new Agent(agentConfig, sessionManager);
    agent.setMemoryManager(memoryManager);
    agent.setSkillsLoader(skillsLoader);

    let scheduler: Scheduler | undefined;
    if (agentConfig.cron.enabled) {
      scheduler = new Scheduler(agentConfig.cron.directory, (job) => {
        const sessionId = job.sessionId || `cron:${job.id}:${Date.now()}`;
        agent.processMessage(sessionId, job.prompt).catch(err => {
          console.error(`[agent:${profile.name}] Cron job "${job.name}" failed: ${err}`);
        });
      });
      agent.setScheduler(scheduler);
    }

    return {
      name: profile.name,
      agent,
      sessionManager,
      memoryManager,
      skillsLoader,
      scheduler,
      channels: profile.channels || ['*'],
      allowFrom: profile.allowFrom || ['*'],
    };
  }

  /**
   * Route a message to the appropriate agent based on channel and user.
   * Channel format: "discord:guild:user", "webchat:ws:client", etc.
   */
  route(sessionId: string, userId?: string): ManagedAgent | null {
    // Try to match channel patterns
    for (const [, managed] of this.agents) {
      for (const pattern of managed.channels) {
        if (this.matchPattern(sessionId, pattern)) {
          // Check user access
          if (managed.allowFrom.includes('*') || (userId && managed.allowFrom.includes(userId))) {
            return managed;
          }
        }
      }
    }

    // Fall back to default agent
    if (this.defaultAgentName) {
      return this.agents.get(this.defaultAgentName) || null;
    }

    return null;
  }

  /** Process a message, routing to the correct agent */
  async processMessage(
    sessionId: string,
    message: string,
    onStream?: StreamCallback,
    userId?: string,
  ): Promise<AgentResponse & { agentName: string }> {
    const managed = this.route(sessionId, userId);
    if (!managed) {
      return { content: 'No agent available for this channel.', toolCalls: [], agentName: 'none' };
    }

    const result = await managed.agent.processMessage(sessionId, message, onStream);
    return { ...result, agentName: managed.name };
  }

  /** Handle a slash command, routing to correct agent */
  async handleCommand(sessionId: string, command: string, userId?: string): Promise<string | null> {
    // Router-level commands
    const parts = command.trim().toLowerCase().split(/\s+/);
    if (parts[0] === '/agents') {
      return this.handleAgentsCommand(parts.slice(1));
    }

    const managed = this.route(sessionId, userId);
    if (!managed) return 'No agent available for this channel.';
    return await managed.agent.handleCommand(sessionId, command);
  }

  private handleAgentsCommand(args: string[]): string {
    if (args.length === 0 || args[0] === 'list') {
      const lines = Array.from(this.agents.values()).map(m => {
        const isDefault = m.name === this.defaultAgentName;
        return `  ${isDefault ? '>' : ' '} ${m.name} — channels: ${m.channels.join(', ')}`;
      });
      return `Agents:\n${lines.join('\n')}`;
    }

    if (args[0] === 'switch' && args[1]) {
      const target = args[1];
      if (this.agents.has(target)) {
        this.defaultAgentName = target;
        return `Default agent switched to "${target}"`;
      }
      return `Agent "${target}" not found. Available: ${Array.from(this.agents.keys()).join(', ')}`;
    }

    return 'Usage: /agents [list|switch <name>]';
  }

  /** Check if a session ID matches a channel pattern */
  private matchPattern(sessionId: string, pattern: string): boolean {
    if (pattern === '*') return true;

    // Convert glob-like pattern to regex: "discord:*" -> /^discord:.*/
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return regex.test(sessionId);
  }

  /** Get a specific agent by name */
  getAgent(name: string): ManagedAgent | undefined {
    return this.agents.get(name);
  }

  /** Get all agents */
  getAllAgents(): ManagedAgent[] {
    return Array.from(this.agents.values());
  }

  /** Get default agent */
  getDefaultAgent(): ManagedAgent | null {
    if (!this.defaultAgentName) return null;
    return this.agents.get(this.defaultAgentName) || null;
  }

  /** Shutdown all agents */
  shutdown(): void {
    for (const [, managed] of this.agents) {
      if (managed.scheduler) managed.scheduler.stop();
      managed.skillsLoader.stopWatching();
      managed.sessionManager.saveAll();
    }
  }
}
