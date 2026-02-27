import type { Config, Provider, LoadBalancingConfig, RateLimitConfig } from '../config/schema.js';
import puter from '@heyputer/puter.js';

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Optional metadata - not sent to LLM, used for UI filtering (e.g., hidden power steering messages) */
  _meta?: {
    hidden?: boolean;
    isPowerSteering?: boolean;
    askUserQuestion?: {
      id: string;
      options?: string[];
      allowCustomInput?: boolean;
      multiSelect?: boolean;
    };
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  }
  }

export interface LLMResponse {
  id: string;
  choices: {
    index: number;
    message: LLMMessage;
    finish_reason: string | null;
    delta?: Partial<LLMMessage>;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamChunk {
  id: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;  // Extended thinking/reasoning (Claude, DeepSeek, etc.)
      tool_calls?: {
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }[];
    };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ProviderEntry {
  name: string;
  apiBase: string;
  apiKey?: string;
  apiType: 'chat' | 'responses' | 'puter';
  model: string;
  maxTokens: number;
  temperature: number;
  priority: number;
  failCount: number;
  lastFail: number;
  contextWindow?: number;  // Model's context window size
  thinkingLevel?: string;  // Reasoning level: off, minimal, low, medium, high
}

export class LLMClient {
  private providers: ProviderEntry[];
  private currentIndex: number = 0;
  private requestCount: number = 0;  // For load balancing
  private loadBalancing: LoadBalancingConfig;
  private rateLimit: RateLimitConfig;
  private lastRequestTime: number = 0;  // For rate limiting

  constructor(config: Config) {
    // Build provider list: primary config + failover providers
    this.providers = [];

    // Primary provider from agent config
    this.providers.push({
      name: 'primary',
      apiBase: config.agent.apiBase,
      apiKey: config.agent.apiKey,
      apiType: (config.agent as any).apiType || 'chat',
      model: config.agent.model,
      maxTokens: config.agent.maxTokens,
      temperature: config.agent.temperature,
      priority: 0,
      failCount: 0,
      lastFail: 0,
      contextWindow: (config.agent as any).contextWindow,
      thinkingLevel: (config.agent as any).thinkingLevel || 'off',
    });

    // Additional failover providers
    if (config.agent.providers && config.agent.providers.length > 0) {
      for (const p of config.agent.providers) {
        this.providers.push({
          name: p.name || p.apiBase,
          apiBase: p.apiBase,
          apiKey: p.apiKey,
          apiType: (p as any).apiType || 'chat',
          model: p.model,
          maxTokens: p.maxTokens || config.agent.maxTokens,
          temperature: p.temperature ?? config.agent.temperature,
          priority: p.priority,
          failCount: 0,
          lastFail: 0,
          contextWindow: (p as any).contextWindow,
          thinkingLevel: (p as any).thinkingLevel || 'off',
        });
      }
    }

    // Sort by priority (lower = higher priority)
    this.providers.sort((a, b) => a.priority - b.priority);
    
    // Load balancing config
    this.loadBalancing = (config.agent as any).loadBalancing || { enabled: false };
    
    // Rate limiting config
    this.rateLimit = (config.agent as any).rateLimit || { enabled: false };
  }

  /** Create a client for a specific model (used by subagents) */
  static forModel(config: Config, modelName: string, apiKey?: string): LLMClient {
    const client = new LLMClient(config);
    
    // Find the model in providers
    const providerIndex = client.providers.findIndex(p => 
      p.model === modelName || p.name === modelName
    );
    
    if (providerIndex >= 0) {
      client.currentIndex = providerIndex;
      // Override API key if provided
      if (apiKey) {
        client.providers[providerIndex].apiKey = apiKey;
      }
    } else {
      // Model not found - set the primary provider to use this model
      client.providers[0].model = modelName;
      if (apiKey) {
        client.providers[0].apiKey = apiKey;
      }
    }
    
    return client;
  }

  /** Update settings at runtime (for live config reload) */
  updateSettings(settings: { temperature?: number; maxTokens?: number; thinkingLevel?: string }): void {
    // Update all providers with new settings
    for (const p of this.providers) {
      if (settings.temperature !== undefined) p.temperature = settings.temperature;
      if (settings.maxTokens !== undefined) p.maxTokens = settings.maxTokens;
      if (settings.thinkingLevel !== undefined) p.thinkingLevel = settings.thinkingLevel;
    }
  }

  /** Update load balancing config */
  updateLoadBalancing(config: LoadBalancingConfig): void {
    this.loadBalancing = config;
  }

  /** Update rate limiting config */
  updateRateLimit(config: RateLimitConfig): void {
    this.rateLimit = config;
  }

  /** Reload providers from config (called when models are added/removed/updated) */
  reloadProviders(config: Config): void {
    // Preserve current model name to try to restore selection
    const currentModel = this.providers[this.currentIndex]?.model;

    // Rebuild provider list
    this.providers = [];

    // Primary provider from agent config
    this.providers.push({
      name: 'primary',
      apiBase: config.agent.apiBase,
      apiKey: config.agent.apiKey,
      apiType: (config.agent as any).apiType || 'chat',
      model: config.agent.model,
      maxTokens: config.agent.maxTokens,
      temperature: config.agent.temperature,
      priority: 0,
      failCount: 0,
      lastFail: 0,
      contextWindow: (config.agent as any).contextWindow,
      thinkingLevel: (config.agent as any).thinkingLevel || 'off',
    });

    // Additional failover providers
    if (config.agent.providers && config.agent.providers.length > 0) {
      for (const p of config.agent.providers) {
        this.providers.push({
          name: p.name || p.apiBase,
          apiBase: p.apiBase,
          apiKey: p.apiKey,
          apiType: (p as any).apiType || 'chat',
          model: p.model,
          maxTokens: p.maxTokens || config.agent.maxTokens,
          temperature: p.temperature ?? config.agent.temperature,
          priority: p.priority,
          failCount: 0,
          lastFail: 0,
          contextWindow: (p as any).contextWindow,
          thinkingLevel: (p as any).thinkingLevel || 'off',
        });
      }
    }

    // Sort by priority (lower = higher priority)
    this.providers.sort((a, b) => a.priority - b.priority);

    // Try to restore previous selection
    const newIndex = this.providers.findIndex(p => p.model === currentModel);
    this.currentIndex = newIndex >= 0 ? newIndex : 0;
    
    // Update load balancing and rate limiting
    this.loadBalancing = (config.agent as any).loadBalancing || { enabled: false };
    this.rateLimit = (config.agent as any).rateLimit || { enabled: false };
  }

  /** Get the current active provider info */
  getCurrentProvider(): { name: string; model: string; apiBase: string; apiType: string; contextWindow?: number } {
    const p = this.providers[this.currentIndex];
    return { name: p.name, model: p.model, apiBase: p.apiBase, apiType: p.apiType, contextWindow: p.contextWindow };
  }

  /** List all available providers */
  listProviders(): { name: string; model: string; apiBase: string; apiType: string; active: boolean }[] {
    return this.providers.map((p, i) => ({
      name: p.name,
      model: p.model,
      apiBase: p.apiBase,
      apiType: p.apiType,
      active: i === this.currentIndex,
    }));
  }

  /** Switch to a specific provider/model by name or index */
  switchModel(nameOrIndex: string): { success: boolean; provider: string; model: string; error?: string } {
    // Try by index
    const idx = parseInt(nameOrIndex);
    if (!isNaN(idx) && idx >= 0 && idx < this.providers.length) {
      this.currentIndex = idx;
      const p = this.providers[idx];
      return { success: true, provider: p.name, model: p.model };
    }

    // Try by provider name
    const byName = this.providers.findIndex(p => p.name.toLowerCase() === nameOrIndex.toLowerCase());
    if (byName >= 0) {
      this.currentIndex = byName;
      const p = this.providers[byName];
      return { success: true, provider: p.name, model: p.model };
    }

    // Try by model name
    const byModel = this.providers.findIndex(p => p.model.toLowerCase() === nameOrIndex.toLowerCase());
    if (byModel >= 0) {
      this.currentIndex = byModel;
      const p = this.providers[byModel];
      return { success: true, provider: p.name, model: p.model };
    }

    const available = this.providers.map((p, i) => `  ${i}: ${p.name} (${p.model})`).join('\n');
    return { success: false, provider: '', model: '', error: `Unknown provider/model "${nameOrIndex}". Available:\n${available}` };
  }

  /** Apply load balancing - switch model if configured */
  private applyLoadBalancing(): void {
    if (!this.loadBalancing.enabled || this.loadBalancing.switchEvery <= 0) {
      return;
    }
    
    this.requestCount++;
    
    // Check if we should switch
    if (this.requestCount >= this.loadBalancing.switchEvery) {
      this.requestCount = 0;
      
      if (this.loadBalancing.strategy === 'random') {
        // Random selection
        this.currentIndex = Math.floor(Math.random() * this.providers.length);
      } else {
        // Round-robin (default)
        this.currentIndex = (this.currentIndex + 1) % this.providers.length;
      }
      
      console.log(`[load-balancing] Switched to provider ${this.providers[this.currentIndex].name} (${this.providers[this.currentIndex].model})`);
    }
  }

  /** Apply rate limiting - delay before request if configured */
  private async applyRateLimit(): Promise<void> {
    if (!this.rateLimit.enabled) {
      return;
    }
    
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    
    let delay = 0;
    
    // Calculate delay based on min/max delay config
    if (this.rateLimit.minDelayMs > 0 || this.rateLimit.maxDelayMs > 0) {
      const minDelay = this.rateLimit.minDelayMs || 0;
      const maxDelay = this.rateLimit.maxDelayMs || minDelay;
      
      if (maxDelay > minDelay) {
        delay = minDelay + Math.random() * (maxDelay - minDelay);
      } else {
        delay = minDelay;
      }
    }
    
    // If we haven't waited long enough since last request, wait more
    if (elapsed < delay) {
      const waitTime = delay - elapsed;
      console.log(`[rate-limit] Waiting ${waitTime}ms before request`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  private getHeaders(provider: ProviderEntry): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }
    return headers;
  }

  /** Sleep for specified milliseconds */
  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Try each provider in order until one succeeds */
  async chat(messages: LLMMessage[], tools?: ToolDef[], toolChoice?: 'auto' | 'required' | 'none', signal?: AbortSignal): Promise<LLMResponse> {
    // Apply rate limiting
    await this.applyRateLimit();

    // Apply load balancing
    this.applyLoadBalancing();

    const errors: string[] = [];
    let tried = 0;
    const maxRetries = 5;
    const retryDelayMs = 5000;

    for (let i = 0; i < this.providers.length; i++) {
      const idx = (this.currentIndex + i) % this.providers.length;
      const provider = this.providers[idx];

      // Skip providers that failed recently (backoff: 30s per fail, max 5min)
      const backoff = Math.min(provider.failCount * 30000, 300000);
      if (provider.failCount > 0 && Date.now() - provider.lastFail < backoff) {
        continue;
      }

      tried++;

      // Try up to maxRetries times with same provider
      for (let retry = 0; retry < maxRetries; retry++) {
        // Check for abort before each attempt
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }

        try {
          const result = await this._chatWithProvider(provider, messages, tools, toolChoice, signal);
          // Success - reset fail count
          provider.failCount = 0;
          // Only update currentIndex if we switched to a different provider
          if (idx !== this.currentIndex) {
            console.log(`[llm-client] Switched from ${this.providers[this.currentIndex].name} to ${provider.name} due to failover`);
            this.currentIndex = idx;
          }
          return result;
        } catch (err: any) {
          // Don't retry on abort
          if (signal?.aborted || err?.name === 'AbortError') {
            throw new Error('Request aborted');
          }

          const errorMsg = `${provider.name}${retry > 0 ? ` (retry ${retry + 1}/${maxRetries})` : ''}: ${err}`;

          if (retry < maxRetries - 1) {
            // Wait before retrying (but check abort first)
            console.log(`[llm-client] ${errorMsg} - retrying in ${retryDelayMs / 1000}s...`);
            await this._sleep(retryDelayMs);
            if (signal?.aborted) {
              throw new Error('Request aborted');
            }
          } else {
            // All retries exhausted for this provider
            provider.failCount++;
            provider.lastFail = Date.now();
            errors.push(errorMsg);
          }
        }
      }
    }

    // If all providers were skipped due to backoff, force-retry the current one
    if (tried === 0) {
      const provider = this.providers[this.currentIndex];

      for (let retry = 0; retry < maxRetries; retry++) {
        // Check for abort before each attempt
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }

        try {
          const result = await this._chatWithProvider(provider, messages, tools, toolChoice, signal);
          provider.failCount = 0;
          return result;
        } catch (err: any) {
          // Don't retry on abort
          if (signal?.aborted || err?.name === 'AbortError') {
            throw new Error('Request aborted');
          }

          if (retry < maxRetries - 1) {
            console.log(`[llm-client] ${provider.name} (retry ${retry + 1}/${maxRetries}): ${err} - retrying in ${retryDelayMs / 1000}s...`);
            await this._sleep(retryDelayMs);
            if (signal?.aborted) {
              throw new Error('Request aborted');
            }
          } else {
            provider.failCount++;
            provider.lastFail = Date.now();
            throw new Error(`Provider ${provider.name} failed after ${maxRetries} retries: ${err}`);
          }
        }
      }
    }

    throw new Error(errors.length === 1 ? errors[0] : `All ${errors.length} providers failed:\n${errors.join('\n')}`);
  }

/** Puter.js API call - uses @heyputer/puter.js SDK */
private async _puterApiCall(provider: ProviderEntry, messages: LLMMessage[], tools?: ToolDef[], signal?: AbortSignal): Promise<LLMResponse> {
  const token = provider.apiKey || process.env.puterAuthToken;
  if (!token) {
    throw new Error('Puter.js auth token not provided. Set provider apiKey or puterAuthToken environment variable.');
  }
   puter.setAuthToken(token);

  // Build conversation string from messages
  let conversation = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      conversation += `[System]\n${msg.content}\n\n`;
    } else if (msg.role === 'user') {
      conversation += `[User]\n${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      conversation += `[Assistant]\n${msg.content}\n\n`;
    } else if (msg.role === 'tool') {
      conversation += `[Tool Result]\n${msg.content}\n\n`;
    }
  }

  try {
    const response = await puter.ai.chat(conversation, {
      model: provider.model,
      stream: false,
    });

    return {
      id: `puter_${Date.now()}`,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: response.text || '',
        },
        finish_reason: 'stop',
      }],
      usage: response.usage ? {
        prompt_tokens: response.usage.input_tokens || 0,
        completion_tokens: response.usage.output_tokens || 0,
        total_tokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0),
      } : undefined,
    };
  } catch (err: any) {
    throw new Error(`Puter API error: ${err.message}`);
  }
}

/** Puter.js streaming API call */
private async *_puterApiStream(provider: ProviderEntry, messages: LLMMessage[], tools?: ToolDef[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
  const token = provider.apiKey || process.env.puterAuthToken;
  if (!token) {
    throw new Error('Puter.js auth token not provided. Set provider apiKey or puterAuthToken environment variable.');
  }
  
  // Check abort before starting
  if (signal?.aborted) {
    throw new Error('Request aborted');
  }
  
  puter.setAuthToken(token);

  // Build conversation string
  let conversation = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      conversation += `[System]\n${msg.content}\n\n`;
    } else if (msg.role === 'user') {
      conversation += `[User]\n${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      conversation += `[Assistant]\n${msg.content}\n\n`;
    } else if (msg.role === 'tool') {
      conversation += `[Tool Result]\n${msg.content}\n\n`;
    }
  }

  // Check abort before API call
  if (signal?.aborted) {
    throw new Error('Request aborted');
  }

  const response = await puter.ai.chat(conversation, {
    model: provider.model,
    stream: true,
  });

  const responseId = `puter_${Date.now()}`;

  try {
    for await (const part of response) {
      if (signal?.aborted) {
        throw new Error('Request aborted');
      }
      if (part?.text) {
        yield {
          id: responseId,
          choices: [{
            index: 0,
            delta: { content: part.text },
            finish_reason: null,
          }],
        };
      }
    }
    yield {
      id: responseId,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    };
  } catch (err: any) {
    if (signal?.aborted || err?.message === 'Request aborted') {
      throw new Error('Request aborted');
    }
    throw new Error(`Puter API streaming error: ${err.message}`);
  }
}
  private async _chatWithProvider(provider: ProviderEntry, messages: LLMMessage[], tools?: ToolDef[], toolChoice?: 'auto' | 'required' | 'none', signal?: AbortSignal): Promise<LLMResponse> {
    if (provider.apiType === 'puter') {
      return this._puterApiCall(provider, messages, tools, signal);
    }
    if (provider.apiType === 'responses') {
      return this._responsesApiCall(provider, messages, tools, toolChoice, signal);
    }

    // Chat Completions API (default)
    const body: Record<string, unknown> = {
      model: provider.model,
      messages,
      max_tokens: provider.maxTokens,
      temperature: provider.temperature,
      stream: false,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = toolChoice || 'auto';
    }

    const res = await fetch(`${provider.apiBase}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(provider),
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<LLMResponse>;
  }

  /** Responses API call - converts to/from chat completions format */
  private async _responsesApiCall(provider: ProviderEntry, messages: LLMMessage[], tools?: ToolDef[], toolChoice?: 'auto' | 'required' | 'none', signal?: AbortSignal): Promise<LLMResponse> {
    // Convert messages to Responses API format
    // System message becomes 'instructions', rest are 'input'
    let instructions = '';
    const input: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        instructions += (instructions ? '\n\n' : '') + msg.content;
      } else if (msg.role === 'user') {
        input.push({ role: 'user', content: msg.content || '' });
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Assistant message with tool calls - need structured content
          const content: any[] = [];
          if (msg.content) {
            content.push({ type: 'output_text', text: msg.content });
          }
          for (const tc of msg.tool_calls) {
            content.push({
              type: 'function_call',
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            });
          }
          input.push({ role: 'assistant', content });
        } else {
          input.push({ role: 'assistant', content: msg.content || '' });
        }
      } else if (msg.role === 'tool') {
        // Tool result - function_call_output format
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: msg.content || '',
        });
      }
    }

    // Build Responses API request body
    const body: Record<string, unknown> = {
      model: provider.model,
      instructions: instructions || undefined,
      input,
      max_output_tokens: provider.maxTokens,
      temperature: provider.temperature,
    };

    // Convert tools to Responses API format
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
      if (toolChoice === 'required') {
        body.tool_choice = 'required';
      } else if (toolChoice === 'none') {
        body.tool_choice = 'none';
      }
    }

    const res = await fetch(`${provider.apiBase}/responses`, {
      method: 'POST',
      headers: this.getHeaders(provider),
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }

    const data = await res.json();

    // Convert Responses API response to Chat Completions format
    return this._convertResponsesApiResponse(data);
  }

  /** Convert Responses API response to Chat Completions format */
  private _convertResponsesApiResponse(data: any): LLMResponse {
    const output = data.output || [];
    let textContent = '';
    const toolCalls: ToolCall[] = [];

    for (const item of output) {
      if (item.type === 'message' && item.role === 'assistant') {
        // Handle content array or string
        if (typeof item.content === 'string') {
          textContent += item.content;
        } else if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === 'output_text' || c.type === 'text') {
              textContent += c.text || '';
            } else if (c.type === 'function_call') {
              toolCalls.push({
                id: c.id || `call_${Date.now()}_${toolCalls.length}`,
                type: 'function',
                function: {
                  name: c.name,
                  arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments || {}),
                },
              });
            }
          }
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.id || `call_${Date.now()}_${toolCalls.length}`,
          type: 'function',
          function: {
            name: item.name,
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
          },
        });
      }
    }

    return {
      id: data.id || `resp_${Date.now()}`,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: data.stop_reason || 'stop',
      }],
      usage: data.usage ? {
        prompt_tokens: data.usage.input_tokens || 0,
        completion_tokens: data.usage.output_tokens || 0,
        total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
      } : undefined,
    };
  }

  /** Stream with failover and retry */
  async *chatStream(messages: LLMMessage[], tools?: ToolDef[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    // Apply rate limiting
    await this.applyRateLimit();

    // Apply load balancing
    this.applyLoadBalancing();

    const errors: string[] = [];
    let tried = 0;
    const maxRetries = 5;
    const retryDelayMs = 5000;

    for (let i = 0; i < this.providers.length; i++) {
      const idx = (this.currentIndex + i) % this.providers.length;
      const provider = this.providers[idx];

      const backoff = Math.min(provider.failCount * 30000, 300000);
      if (provider.failCount > 0 && Date.now() - provider.lastFail < backoff) {
        continue;
      }

      tried++;

      // Try up to maxRetries times with same provider
      for (let retry = 0; retry < maxRetries; retry++) {
        // Check for abort before each attempt
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }

        try {
          yield* this._chatStreamWithProvider(provider, messages, tools, signal);
          provider.failCount = 0;
          // Only update currentIndex if we switched to a different provider
          if (idx !== this.currentIndex) {
            console.log(`[llm-client] Switched from ${this.providers[this.currentIndex].name} to ${provider.name} due to failover`);
            this.currentIndex = idx;
          }
          return;
        } catch (err: any) {
          // Don't retry on abort
          if (signal?.aborted || err?.name === 'AbortError') {
            throw new Error('Request aborted');
          }

          const errorMsg = `${provider.name}${retry > 0 ? ` (retry ${retry + 1}/${maxRetries})` : ''}: ${err}`;

          if (retry < maxRetries - 1) {
            // Wait before retrying (but check abort first)
            console.log(`[llm-client] ${errorMsg} - retrying in ${retryDelayMs / 1000}s...`);
            await this._sleep(retryDelayMs);
            if (signal?.aborted) {
              throw new Error('Request aborted');
            }
          } else {
            // All retries exhausted for this provider
            provider.failCount++;
            provider.lastFail = Date.now();
            errors.push(errorMsg);
          }
        }
      }
    }

    // If all providers were skipped due to backoff, force-retry the current one
    if (tried === 0) {
      const provider = this.providers[this.currentIndex];

      for (let retry = 0; retry < maxRetries; retry++) {
        // Check for abort before each attempt
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }

        try {
          yield* this._chatStreamWithProvider(provider, messages, tools, signal);
          provider.failCount = 0;
          return;
        } catch (err: any) {
          // Don't retry on abort
          if (signal?.aborted || err?.name === 'AbortError') {
            throw new Error('Request aborted');
          }

          if (retry < maxRetries - 1) {
            console.log(`[llm-client] ${provider.name} (retry ${retry + 1}/${maxRetries}): ${err} - retrying in ${retryDelayMs / 1000}s...`);
            await this._sleep(retryDelayMs);
            if (signal?.aborted) {
              throw new Error('Request aborted');
            }
          } else {
            provider.failCount++;
            provider.lastFail = Date.now();
            throw new Error(`Provider ${provider.name} failed after ${maxRetries} retries: ${err}`);
          }
        }
      }
    }

    throw new Error(errors.length === 1 ? errors[0] : `All ${errors.length} providers failed:\n${errors.join('\n')}`);
  }

  private async *_chatStreamWithProvider(provider: ProviderEntry, messages: LLMMessage[], tools?: ToolDef[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    if (provider.apiType === 'puter') {
      yield* this._puterApiStream(provider, messages, tools, signal);
      return;
    }
    if (provider.apiType === 'responses') {
      yield* this._responsesApiStream(provider, messages, tools, signal);
      return;
    }

    // Chat Completions streaming (default)
    const body: Record<string, unknown> = {
      model: provider.model,
      messages,
      max_tokens: provider.maxTokens,
      temperature: provider.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    // Add thinking/reasoning level for models that support it
    if (provider.thinkingLevel && provider.thinkingLevel !== 'off') {
      // Some APIs use reasoning_effort, others use thinking_budget or similar
      // Pass both and let the API ignore what it doesn't support
      body.reasoning_effort = provider.thinkingLevel;
    }

    console.log(`[DEBUG] _chatStreamWithProvider: POST ${provider.apiBase}/chat/completions model=${provider.model} hasApiKey=${!!provider.apiKey}`);

    const res = await fetch(`${provider.apiBase}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(provider),
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.log(`[DEBUG] _chatStreamWithProvider: API error ${res.status}: ${text.slice(0, 500)}`);
      throw new Error(`API error ${res.status}: ${text}`);
    }

    console.log(`[DEBUG] _chatStreamWithProvider: got response, status=${res.status}`);

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let totalBytes = 0;

    // Set up abort listener to cancel reader immediately when signal fires
    let aborted = false;
    const abortHandler = () => {
      aborted = true;
      reader.cancel().catch(() => {});
    };
    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      while (true) {
        // Check for abort before each read
        if (aborted || signal?.aborted) {
          throw new Error('Request aborted');
        }

        const { done, value } = await reader.read();
        if (done) {
          console.log(`[DEBUG] _chatStreamWithProvider: stream done, totalBytes=${totalBytes}, buffer remaining="${buffer.slice(0, 200)}"`);
          break;
        }

        totalBytes += value?.length || 0;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        let chunksYielded = 0;

        for (const line of lines) {
          // Check for abort while processing lines
          if (aborted || signal?.aborted) {
            throw new Error('Request aborted');
          }

          const trimmed = line.trim();
          if (!trimmed) continue;
          
          // Log raw lines for debugging
          if (chunksYielded === 0 && totalBytes < 500) {
            console.log(`[DEBUG] _chatStreamWithProvider: raw line: "${trimmed.slice(0, 150)}"`);
          }
          
          // Handle both 'data: {...}' and 'data:{...}' formats (some APIs omit the space)
          let data: string;
          if (trimmed.startsWith('data: ')) {
            data = trimmed.slice(6);
          } else if (trimmed.startsWith('data:')) {
            data = trimmed.slice(5);
          } else {
            continue;
          }
          if (data === '[DONE]') {
            console.log(`[DEBUG] _chatStreamWithProvider: got [DONE], yielded ${chunksYielded} chunks total`);
            return;
          }
          try {
            yield JSON.parse(data) as StreamChunk;
            chunksYielded++;
          } catch (e) {
            console.log(`[DEBUG] _chatStreamWithProvider: failed to parse chunk: "${data.slice(0, 100)}"`);
          }
        }
      }
    } finally {
      // Clean up abort listener and ensure reader is released
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
      if (!aborted) {
        reader.cancel().catch(() => {});
      }
    }
  }

  /** Responses API streaming - converts events to Chat Completions StreamChunk format */
  private async *_responsesApiStream(provider: ProviderEntry, messages: LLMMessage[], tools?: ToolDef[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    // Convert messages to Responses API format (same as non-streaming)
    let instructions = '';
    const input: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        instructions += (instructions ? '\n\n' : '') + msg.content;
      } else if (msg.role === 'user') {
        input.push({ role: 'user', content: msg.content || '' });
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const content: any[] = [];
          if (msg.content) {
            content.push({ type: 'output_text', text: msg.content });
          }
          for (const tc of msg.tool_calls) {
            content.push({
              type: 'function_call',
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            });
          }
          input.push({ role: 'assistant', content });
        } else {
          input.push({ role: 'assistant', content: msg.content || '' });
        }
      } else if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: msg.content || '',
        });
      }
    }

    const body: Record<string, unknown> = {
      model: provider.model,
      instructions: instructions || undefined,
      input,
      max_output_tokens: provider.maxTokens,
      temperature: provider.temperature,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
    }

    const res = await fetch(`${provider.apiBase}/responses`, {
      method: 'POST',
      headers: this.getHeaders(provider),
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    // Track tool calls being built
    const toolCallsInProgress: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let responseId = `resp_${Date.now()}`;

    // Set up abort listener to cancel reader immediately when signal fires
    let aborted = false;
    const abortHandler = () => {
      aborted = true;
      reader.cancel().catch(() => {});
    };
    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      while (true) {
        if (aborted || signal?.aborted) {
          throw new Error('Request aborted');
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (aborted || signal?.aborted) {
            throw new Error('Request aborted');
          }

          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') return;

          try {
            const event = JSON.parse(dataStr);

            // Convert Responses API events to Chat Completions StreamChunk format
            if (event.type === 'response.created') {
              responseId = event.response?.id || responseId;
            } else if (event.type === 'response.output_text.delta' || event.type === 'content_block_delta') {
              // Text content delta
              const textDelta = event.delta?.text || event.delta || '';
              yield {
                id: responseId,
                choices: [{
                  index: 0,
                  delta: { content: textDelta },
                  finish_reason: null,
                }],
              };
            } else if (event.type === 'response.output_item.added') {
              // New output item (could be function call)
              if (event.item?.type === 'function_call') {
                const idx = event.output_index || 0;
                toolCallsInProgress.set(idx, {
                  id: event.item.id || `call_${Date.now()}_${idx}`,
                  name: event.item.name || '',
                  arguments: '',
                });
                // Emit tool call start
                yield {
                  id: responseId,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: idx,
                        id: event.item.id,
                        type: 'function',
                        function: { name: event.item.name, arguments: '' },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
              }
            } else if (event.type === 'response.function_call_arguments.delta') {
              // Tool call arguments delta
              const idx = event.output_index || 0;
              const tc = toolCallsInProgress.get(idx);
              if (tc) {
                tc.arguments += event.delta || '';
                yield {
                  id: responseId,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: idx,
                        function: { arguments: event.delta || '' },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
              }
            } else if (event.type === 'response.completed' || event.type === 'response.done') {
              // Final event with usage
              const usage = event.response?.usage || event.usage;
              if (usage) {
                yield {
                  id: responseId,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop',
                  }],
                  usage: {
                    prompt_tokens: usage.input_tokens || 0,
                    completion_tokens: usage.output_tokens || 0,
                    total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
                  },
                };
              }
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } finally {
      // Clean up abort listener and ensure reader is released
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
      if (!aborted) {
        reader.cancel().catch(() => {});
      }
    }
  }

  /** Build and return the request body that would be sent to the API (for copying/debugging) */
  buildRequestBody(messages: LLMMessage[], tools?: ToolDef[], toolChoice?: 'auto' | 'required' | 'none'): { endpoint: string; body: Record<string, unknown>; headers: Record<string, string> } {
    const provider = this.providers[this.currentIndex];
    
    if (provider.apiType === 'puter') {
      // Build conversation string for Puter
      let conversation = '';
      for (const msg of messages) {
        if (msg.role === 'system') {
          conversation += `[System]\n${msg.content}\n\n`;
        } else if (msg.role === 'user') {
          conversation += `[User]\n${msg.content}\n\n`;
        } else if (msg.role === 'assistant') {
          conversation += `[Assistant]\n${msg.content}\n\n`;
        } else if (msg.role === 'tool') {
          conversation += `[Tool Result]\n${msg.content}\n\n`;
        }
      }
      return {
        endpoint: 'puter.ai.chat (SDK)',
        body: {
          model: provider.model,
          conversation,
          stream: false,
        },
        headers: { 'Authorization': 'Bearer [token]' },
      };
    }

    if (provider.apiType === 'responses') {
      // Responses API format
      let instructions = '';
      const input: any[] = [];

      for (const msg of messages) {
        if (msg.role === 'system') {
          instructions += (instructions ? '\n\n' : '') + msg.content;
        } else if (msg.role === 'user') {
          input.push({ role: 'user', content: msg.content || '' });
        } else if (msg.role === 'assistant') {
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            const content: any[] = [];
            if (msg.content) {
              content.push({ type: 'output_text', text: msg.content });
            }
            for (const tc of msg.tool_calls) {
              content.push({
                type: 'function_call',
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              });
            }
            input.push({ role: 'assistant', content });
          } else {
            input.push({ role: 'assistant', content: msg.content || '' });
          }
        } else if (msg.role === 'tool') {
          input.push({
            type: 'function_call_output',
            call_id: msg.tool_call_id,
            output: msg.content || '',
          });
        }
      }

      const body: Record<string, unknown> = {
        model: provider.model,
        instructions: instructions || undefined,
        input,
        max_output_tokens: provider.maxTokens,
        temperature: provider.temperature,
      };

      if (tools && tools.length > 0) {
        body.tools = tools.map(t => ({
          type: 'function',
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        }));
        if (toolChoice === 'required') {
          body.tool_choice = 'required';
        } else if (toolChoice === 'none') {
          body.tool_choice = 'none';
        }
      }

      return {
        endpoint: `${provider.apiBase}/responses`,
        body,
        headers: this.getHeaders(provider),
      };
    }

    // Chat Completions API (default)
    const body: Record<string, unknown> = {
      model: provider.model,
      messages,
      max_tokens: provider.maxTokens,
      temperature: provider.temperature,
      stream: false,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = toolChoice || 'auto';
    }
    if (provider.thinkingLevel && provider.thinkingLevel !== 'off') {
      body.reasoning_effort = provider.thinkingLevel;
    }

    return {
      endpoint: `${provider.apiBase}/chat/completions`,
      body,
      headers: this.getHeaders(provider),
    };
  }
}
