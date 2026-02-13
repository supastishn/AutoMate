import { z } from 'zod';

export const ProviderSchema = z.object({
  name: z.string().optional(),
  model: z.string(),
  apiBase: z.string(),
  apiKey: z.string().optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  priority: z.number().default(0),  // lower = tried first
  cooldownMs: z.number().optional(), // cooldown after error before retry
  lastError: z.number().optional(),  // timestamp of last error (runtime only)
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
    intervalMinutes: z.number().default(30),
  }).optional(),
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

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
    systemPrompt: z.string().default('You are AutoMate, a fast and capable personal AI assistant. You have access to tools for running shell commands, reading/writing files, browsing the web, and more. Be concise and effective.'),
    maxTokens: z.number().default(8192),
    temperature: z.number().default(0.3),
    // Thinking/reasoning level: off, minimal, low, medium, high
    thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high']).default('off'),
    // Failover providers: if the primary fails, try these in order
    providers: z.array(ProviderSchema).default([]),
    // Model aliases for quick switching
    aliases: z.array(ModelAliasSchema).default([]),
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
    headless: z.boolean().default(true),
    profileDir: z.string().default('~/.automate/chrome-profile'),  // persistent Chrome profile (cookies, logins, etc.)
  }).default({}),
  skills: z.object({
    directory: z.string().default('~/.automate/skills'),
    extraDirs: z.array(z.string()).optional(),   // additional skill dirs (lower precedence)
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
  }).default({}),
  webhooks: z.object({
    enabled: z.boolean().default(false),
    token: z.string().optional(),           // auth token for incoming webhooks
  }).default({}),
  sessions: z.object({
    directory: z.string().default('~/.automate/sessions'),
    contextLimit: z.number().default(120000),    // max tokens before auto-compact
    compactAt: z.number().default(0.8),          // trigger at this fraction of contextLimit
    autoResetHour: z.number().default(-1),       // -1 = disabled, 0-23 = hour to reset daily
  }).default({}),
  canvas: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
  plugins: z.object({
    enabled: z.boolean().default(true),
    directory: z.string().default('~/.automate/plugins'),
  }).default({}),
  heartbeat: z.object({
    enabled: z.boolean().default(false),
    intervalMinutes: z.number().default(30),   // how often to check in
  }).default({}),
  tts: TTSConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;
