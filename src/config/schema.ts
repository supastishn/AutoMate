import { z } from 'zod';

export const ConfigSchema = z.object({
  agent: z.object({
    model: z.string().default('claude-opus-4.6'),
    apiBase: z.string().default('http://localhost:4141/v1'),
    systemPrompt: z.string().default('You are AutoMate, a fast and capable personal AI assistant. You have access to tools for running shell commands, reading/writing files, browsing the web, and more. Be concise and effective.'),
    maxTokens: z.number().default(8192),
    temperature: z.number().default(0.3),
  }).default({}),
  gateway: z.object({
    port: z.number().default(18789),
    host: z.string().default('127.0.0.1'),
    auth: z.object({
      mode: z.enum(['none', 'token', 'password']).default('none'),
      token: z.string().optional(),
      password: z.string().optional(),
    }).default({}),
  }).default({}),
  channels: z.object({
    discord: z.object({
      enabled: z.boolean().default(false),
      token: z.string().optional(),
      allowFrom: z.array(z.string()).default(['*']),
    }).default({}),
  }).default({}),
  browser: z.object({
    enabled: z.boolean().default(true),
    headless: z.boolean().default(true),
  }).default({}),
  skills: z.object({
    directory: z.string().default('~/.automate/skills'),
  }).default({}),
  sessions: z.object({
    directory: z.string().default('~/.automate/sessions'),
    maxHistory: z.number().default(200),
    compactThreshold: z.number().default(150),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
