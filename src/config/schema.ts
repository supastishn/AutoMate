import { z } from 'zod';

export const ProviderSchema = z.object({
  name: z.string().optional(),
  model: z.string(),
  apiBase: z.string(),
  apiKey: z.string().optional(),
  apiType: z.enum(['chat', 'responses', 'puter']).default('chat'),  // chat = /chat/completions, responses = /responses, puter = @heyputer/puter.js
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  priority: z.number().default(0),  // lower = tried first
  cooldownMs: z.number().optional(), // cooldown after error before retry
  lastError: z.number().optional(),  // timestamp of last error (runtime only)
  contextWindow: z.number().optional(),  // model's context window size (overrides sessions.contextLimit)
});

export type Provider = z.infer<typeof ProviderSchema>;

// Model alias: shorthand names for full model specs
export const ModelAliasSchema = z.object({
  name: z.string(),              // alias name (e.g. "fast", "smart", "cheap")
  model: z.string(),             // full model name
  apiBase: z.string().optional(), // override apiBase
  apiKey: z.string().optional(),  // override apiKey
});

export type ModelAlias = z.infer<typeof ModelAliasSchema>;

export const AgentProfileSchema = z.object({
  name: z.string(),
  model: z.string().optional(),
  apiBase: z.string().optional(),
  apiKey: z.string().optional(),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  memoryDir: z.string().optional(),
  sessionsDir: z.string().optional(),
  skillsDir: z.string().optional(),
  elevated: z.boolean().optional(),
  channels: z.array(z.string()).default(['*']),     // channel patterns e.g. "discord:*"
  allowFrom: z.array(z.string()).default(['*']),    // user IDs
  tools: z.object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }).optional(),
  heartbeat: z.object({
    enabled: z.boolean().default(false),
    intervalMinutes: z.number().default(60),
  }).optional(),
});

// Subagent configuration
export const SubagentProfileSchema = z.object({
  name: z.string(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  maxIterations: z.number().min(1).max(200).optional(),
  timeoutMs: z.number().min(1000).max(24 * 60 * 60 * 1000).optional(),
});

export const SubagentConfigSchema = z.object({
  // Default model for subagents (if not specified in tool call)
  defaultModel: z.string().optional(),
  // Use same API key as parent (default true)
  useParentApiKey: z.boolean().default(true),
  // Maximum number of subagents that can run simultaneously
  // Additional subagents will be queued until a slot frees up
  maxConcurrent: z.number().min(1).max(20).default(3),
  // Custom reusable subagent profiles for UI and prompt tooling
  profiles: z.array(SubagentProfileSchema).default([]),
}).default({});

// MCP (Model Context Protocol) server configuration
export const MCPServerSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
  transport: z.enum(['stdio', 'sse', 'http']).default('stdio'),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().optional(),
});

export const MCPConfigSchema = z.object({
  servers: z.array(MCPServerSchema).default([]),
}).default({});

// Load balancing configuration
export const LoadBalancingSchema = z.object({
  // Enable load balancing (rotate through models)
  enabled: z.boolean().default(false),
  // Switch model every N requests (0 = disabled)
  switchEvery: z.number().default(0),
  // Strategy: 'round-robin' or 'random'
  strategy: z.enum(['round-robin', 'random']).default('round-robin'),
}).default({});

// Rate limiting configuration (artificial delays before API calls)
export const RateLimitSchema = z.object({
  // Enable artificial rate limiting
  enabled: z.boolean().default(false),
  // Minimum delay between requests (ms)
  minDelayMs: z.number().default(0),
  // Maximum delay between requests (ms) - random between min and max
  maxDelayMs: z.number().default(0),
  // Delay per token in response (ms) - for streaming
  perTokenDelayMs: z.number().default(0),
}).default({});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;
export type SubagentProfile = z.infer<typeof SubagentProfileSchema>;
export type MCPServer = z.infer<typeof MCPServerSchema>;
export type MCPConfig = z.infer<typeof MCPConfigSchema>;
export type LoadBalancingConfig = z.infer<typeof LoadBalancingSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitSchema>;

// TTS configuration
export const TTSConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['elevenlabs', 'openai']).default('elevenlabs'),
  apiKey: z.string().optional(),
  voice: z.string().optional(),
  model: z.string().optional(),
  outputDir: z.string().optional(),
}).default({});

export const ConfigSchema = z.object({
  agent: z.object({
    model: z.string().default('claude-opus-4.6'),
    apiBase: z.string().default('http://localhost:4141/v1'),
    apiKey: z.string().optional(),
    apiType: z.enum(['chat', 'responses', 'puter']).default('chat'),  // chat = /chat/completions, responses = /responses, puter = @heyputer/puter.js
    systemPrompt: z.string().default('You are AutoMate, a fast and capable personal AI assistant. You have access to tools for running shell commands, reading/writing files, browsing the web, and more. Be concise and effective.\n\n## Autonomous Behavior\n\nYou are PROACTIVE. You don\'t just wait for instructions — you take initiative:\n\n**Goal Management:**\n- When you complete a task that was tracked as a goal, IMMEDIATELY mark it complete: `goals action=complete id="..."\n- When you start working on something meaningful, ADD it as a goal if it\'s not trivial\n- Check pending goals regularly with `goals action=next` and pick up work autonomously\n\n**Memory Maintenance:**\n- When you learn something important about the user, UPDATE USER.md or MEMORY.md\n- When you complete items in HEARTBEAT.md, REMOVE them or mark them done\n- Don\'t let stale tasks accumulate — clean up as you go\n- Archive completed projects to keep memory files focused\n\n**Self-Direction:**\n- If you notice something that needs doing, propose it or just do it\n- Use `goals action=add` to create tasks for yourself, then work through them\n- Review your goals list periodically and prune obsolete items\n\nYou are not a passive responder. You are an active collaborator who maintains your own state and initiates work.'),
    // Shorter prompt used for power steering reminders (defaults to systemPrompt if not set)
    reminderPrompt: z.string().optional(),
    maxTokens: z.number().default(8192),
    maxSystemPromptTokens: z.number().default(32000),  // hard cap on system prompt size
    temperature: z.number().default(0.3),
    // Thinking/reasoning level: off, minimal, low, medium, high, xhigh
    thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).default('off'),
    // Failover providers: if the primary fails, try these in order
    providers: z.array(ProviderSchema).default([]),
    // Model aliases for quick switching
    aliases: z.array(ModelAliasSchema).default([]),
    // Power steering: periodically re-inject system prompt to keep model on track
    powerSteering: z.object({
      enabled: z.boolean().default(true),
      interval: z.number().default(25),  // re-inject every N messages
      role: z.enum(['system', 'user', 'both']).default('system'),  // inject as system, user, or both for maximum effect
      mode: z.enum(['separate', 'append']).default('separate'),  // separate = hidden message, append = append to user msg
    }).default({}),
    // Subagent configuration
    subagent: SubagentConfigSchema,
    // Load balancing (rotate through models)
    loadBalancing: LoadBalancingSchema,
    // Artificial rate limiting (delays before API calls)
    rateLimit: RateLimitSchema,
    // Response normalization: replace punctuation with comma
    normalizePunctuation: z.object({
      enabled: z.boolean().default(false),
      // Characters to replace with comma: em dash, en dash, colon, semicolon, regular dash
      replace: z.array(z.string()).default(['—', '–', ':', ';', '-']),
    }).default({}),
  }).default({}),
  // Multi-agent: define named agents with isolated memory/sessions/skills
  agents: z.array(AgentProfileSchema).default([]),
  gateway: z.object({
    port: z.number().default(18789),
    host: z.string().default('127.0.0.1'),
    auth: z.object({
      mode: z.enum(['none', 'token', 'password']).default('token'),
      token: z.string().optional(),
      password: z.string().optional(),
    }).default({}),
  }).default({}),
  channels: z.object({
    discord: z.object({
      enabled: z.boolean().default(false),
      token: z.string().optional(),
      clientId: z.string().optional(),          // for slash command registration
      allowFrom: z.array(z.string()).default(['*']),
      allowChannels: z.array(z.string()).default(['*']),  // channel/category IDs or '*'
      // Multi-user authorization: owner IDs have full tool access, others get chat-only
      ownerIds: z.array(z.string()).default([]),  // Discord user IDs with full access (empty = allowFrom are owners)
      publicMode: z.boolean().default(false),     // If true, bot chats with everyone but restricts tools
      // Tools that non-owners can use (read-only by default)
      publicTools: z.array(z.string()).default([
        'read_file', 'list_directory', 'search_files', 'web_search', 'analyze_image',
      ]),
      useEmbeds: z.boolean().default(true),       // rich embed responses
      useThreads: z.boolean().default(true),      // auto-create threads for long convos
      threadThreshold: z.number().default(3),     // messages before creating thread
      streamEdits: z.boolean().default(true),     // progressive message editing
      streamEditInterval: z.number().default(1000), // ms between edits during streaming
      registerSlashCommands: z.boolean().default(true), // register Discord slash commands
      showButtons: z.boolean().default(true),     // show action buttons on responses
      reactOnReceive: z.boolean().default(true),  // react with eyes when processing
      // Proactive messaging: channel ID where cron/heartbeat results are sent
      proactiveChannelId: z.string().optional(),
      // Track message edits/deletes
      trackEdits: z.boolean().default(true),
      trackDeletes: z.boolean().default(true),
      // Per-server overrides: customize model/prompt per guild
      serverOverrides: z.record(z.string(), z.object({
        model: z.string().optional(),
        systemPrompt: z.string().optional(),
        agentName: z.string().optional(),
      })).default({}),
    }).default({}),
  }).default({}),
  browser: z.object({
    enabled: z.boolean().default(true),
    engine: z.enum(['playwright', 'selenium']).default('playwright'),
    headless: z.boolean().default(true),
    chromiumPath: z.string().default('/usr/bin/chromium'),
    chromeDriverPath: z.string().default('/usr/bin/chromedriver'),
    profileDir: z.string().default('~/.automate/chrome-profile'),  // persistent Chrome profile (cookies, logins, etc.)
    extensions: z.string().optional(),  // comma-separated paths to unpacked Chrome extensions
  }).default({}),
  skills: z.object({
    directory: z.string().default('~/.automate/skills'),
    extraDirs: z.array(z.string()).optional(),   // additional skill dirs (lower precedence)
    autoLoad: z.array(z.string()).default([]),   // skill names to auto-load on session start
  }).default({}),
  memory: z.object({
    directory: z.string().default('~/.automate/memory'),
    sharedDirectory: z.string().default('~/.automate/shared'),  // shared memory across agents
    indexTranscripts: z.boolean().default(true),  // index chat transcripts for search
    embedding: z.object({
      enabled: z.boolean().default(true),
      provider: z.enum(['openai', 'gemini', 'voyage', 'local']).default('openai'),
      model: z.string().default('text-embedding-3-small'),
      apiBase: z.string().default('http://localhost:4141/v1'),
      apiKey: z.string().optional(),
      chunkSize: z.number().default(512),       // chars per chunk
      chunkOverlap: z.number().default(64),     // overlap between chunks
      vectorWeight: z.number().default(0.6),    // weight for cosine similarity in hybrid
      bm25Weight: z.number().default(0.4),      // weight for BM25 in hybrid
      topK: z.number().default(10),             // default results to return
    }).default({}),
    // Citation mode: how to cite sources in search results
    citations: z.enum(['full', 'file-only', 'none']).default('full'),
    // Auto-search: automatically search memory after each user message and inject relevant results
    autoSearch: z.object({
      enabled: z.boolean().default(false),
      maxResults: z.number().default(3),       // max results to inject
      minScore: z.number().default(0.3),       // minimum relevance score (0-1)
    }).default({}),
  }).default({}),
  cron: z.object({
    enabled: z.boolean().default(true),
    directory: z.string().default('~/.automate/cron'),
  }).default({}),
  tools: z.object({
    allow: z.array(z.string()).default([]),  // empty = allow all
    deny: z.array(z.string()).default([]),   // deny always wins
    // Tool approval: require user approval for dangerous tools
    requireApproval: z.array(z.string()).default([]), // tools that need approval
    // Deferred loading: when false, all tools are loaded by default (no load/unload needed)
    deferredLoading: z.boolean().default(true),
    // Disable file pagination - always read full files (ignore offset/limit params)
    disableFilePagination: z.boolean().default(false),
  }).default({}),
  mcp: MCPConfigSchema,
  webhooks: z.object({
    enabled: z.boolean().default(false),
    token: z.string().optional(),           // auth token for incoming webhooks
  }).default({}),
  sessions: z.object({
    directory: z.string().default('~/.automate/sessions'),
    contextLimit: z.number().default(120000),    // default max tokens (used if model has no contextWindow)
    compactAt: z.number().default(0.8),          // trigger at this fraction of contextLimit
    compactRetainCount: z.number().default(10),  // keep last N messages after compaction
    compactMode: z.enum(['summary', 'truncate', 'rolling']).default('summary'),  // compaction strategy
    rollingChunkSize: z.number().default(20),    // for 'rolling' mode: how many oldest messages to compact per pass
    reserveTokens: z.number().default(20000),    // reserve tokens for response generation
    autoResetHour: z.number().default(-1),       // -1 = disabled, 0-23 = hour to reset daily
    // Per-model context windows: model name pattern -> context window size
    // Patterns support * wildcard (e.g., "gpt-4*" matches "gpt-4", "gpt-4-turbo", etc.)
    modelContextWindows: z.record(z.string(), z.number()).default({
      'gpt-4o*': 128000,
      'gpt-4-turbo*': 128000,
      'gpt-4-32k*': 32000,
      'gpt-4*': 8000,
      'gpt-3.5-turbo-16k*': 16000,
      'gpt-3.5*': 4000,
      'claude-3-opus*': 200000,
      'claude-3-sonnet*': 200000,
      'claude-3-haiku*': 200000,
      'claude-3.5*': 200000,
      'claude-2*': 100000,
      'gemini-1.5-pro*': 1000000,
      'gemini-1.5-flash*': 1000000,
      'gemini-pro*': 32000,
      'mistral-large*': 128000,
      'mistral-medium*': 32000,
      'mistral-small*': 32000,
      'llama-3.1-405b*': 128000,
      'llama-3.1-70b*': 128000,
      'llama-3.1-8b*': 128000,
      'llama-3-70b*': 8000,
      'llama-3-8b*': 8000,
      'deepseek-coder*': 128000,
      'deepseek-chat*': 128000,
      'qwen-2.5*': 128000,
    }),
    // Context pruning: trim tool results before they consume too much context
    pruning: z.object({
      enabled: z.boolean().default(true),
      maxToolResults: z.number().default(100),            // maximum tool results before pruning starts
      maxToolResultChars: z.number().default(30000),      // auto-trim any single tool result above this size
      keepLastAssistants: z.number().default(3),          // protect last N assistant turns
      softTrimRatio: z.number().default(0.3),             // start trimming at this % of context
      hardClearRatio: z.number().default(0.5),            // clear tool results at this %
      minPrunableChars: z.number().default(50000),        // only prune if >50K chars prunable
      softTrim: z.object({
        maxChars: z.number().default(4000),               // max chars to keep per tool result
        headChars: z.number().default(1500),              // keep first N chars
        tailChars: z.number().default(1500),              // keep last N chars
      }).default({}),
      hardClear: z.object({
        enabled: z.boolean().default(true),
        placeholder: z.string().default('[Old tool result content cleared]'),
      }).default({}),
    }).default({}),
  }).default({}),
  canvas: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
  plugins: z.object({
    enabled: z.boolean().default(true),
    directory: z.string().default('~/.automate/plugins'),
    // Session for plugin notifications (separate from main/heartbeat)
    notificationSession: z.string().optional(), // e.g. "webchat:plugin-notifications"
  }).default({}),
  heartbeat: z.object({
    enabled: z.boolean().default(false),
    intervalMinutes: z.number().default(60),
    jitterMinutes: z.number().default(1),
    separateSession: z.boolean().default(true),
    sessionId: z.string().optional(),
    // Autonomy features (synced to goals.json on startup)
    adaptiveInterval: z.boolean().default(false),
    dailyReport: z.object({
      enabled: z.boolean().default(false),
      timeHour: z.number().min(0).max(23).default(9),
    }).default({}),
    autoProcessGoals: z.boolean().default(true),
    maxInProgressGoals: z.number().default(3),
    escalation: z.boolean().default(true),
    autoApproveMinutes: z.number().default(30),  // auto-approve suggested goals after N minutes (0=instant, -1=never)
    maxRetries: z.number().default(3),
    termuxScheduler: z.boolean().default(false),  // Register heartbeat with termux-job-scheduler for Android sleep support
  }).default({}),
  tts: TTSConfigSchema,
  // User timezone (IANA format, e.g. "Asia/Jerusalem", "America/New_York")
  // Used for daily reports, cron display, and time-aware features
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
});

export type Config = z.infer<typeof ConfigSchema>;
