import type { Config, Provider } from '../config/schema.js';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
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
  model: string;
  maxTokens: number;
  temperature: number;
  priority: number;
  failCount: number;
  lastFail: number;
}

export class LLMClient {
  private providers: ProviderEntry[];
  private currentIndex: number = 0;

  constructor(config: Config) {
    // Build provider list: primary config + failover providers
    this.providers = [];

    // Primary provider from agent config
    this.providers.push({
      name: 'primary',
      apiBase: config.agent.apiBase,
      apiKey: config.agent.apiKey,
      model: config.agent.model,
      maxTokens: config.agent.maxTokens,
      temperature: config.agent.temperature,
      priority: 0,
      failCount: 0,
      lastFail: 0,
    });

    // Additional failover providers
    if (config.agent.providers && config.agent.providers.length > 0) {
      for (const p of config.agent.providers) {
        this.providers.push({
          name: p.name || p.apiBase,
          apiBase: p.apiBase,
          apiKey: p.apiKey,
          model: p.model,
          maxTokens: p.maxTokens || config.agent.maxTokens,
          temperature: p.temperature ?? config.agent.temperature,
          priority: p.priority,
          failCount: 0,
          lastFail: 0,
        });
      }
    }

    // Sort by priority (lower = higher priority)
    this.providers.sort((a, b) => a.priority - b.priority);
  }

  /** Get the current active provider info */
  getCurrentProvider(): { name: string; model: string; apiBase: string } {
    const p = this.providers[this.currentIndex];
    return { name: p.name, model: p.model, apiBase: p.apiBase };
  }

  /** List all available providers */
  listProviders(): { name: string; model: string; apiBase: string; active: boolean }[] {
    return this.providers.map((p, i) => ({
      name: p.name,
      model: p.model,
      apiBase: p.apiBase,
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

  private getHeaders(provider: ProviderEntry): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }
    return headers;
  }

  /** Try each provider in order until one succeeds */
  async chat(messages: LLMMessage[], tools?: ToolDef[], toolChoice?: 'auto' | 'required' | 'none'): Promise<LLMResponse> {
    const errors: string[] = [];

    for (let i = 0; i < this.providers.length; i++) {
      const idx = (this.currentIndex + i) % this.providers.length;
      const provider = this.providers[idx];

      // Skip providers that failed recently (backoff: 30s per fail, max 5min)
      const backoff = Math.min(provider.failCount * 30000, 300000);
      if (provider.failCount > 0 && Date.now() - provider.lastFail < backoff) {
        continue;
      }

      try {
        const result = await this._chatWithProvider(provider, messages, tools, toolChoice);
        // Success - reset fail count and set as current
        provider.failCount = 0;
        this.currentIndex = idx;
        return result;
      } catch (err) {
        provider.failCount++;
        provider.lastFail = Date.now();
        errors.push(`${provider.name}: ${err}`);
        // Try next provider
      }
    }

    throw new Error(`All providers failed:\n${errors.join('\n')}`);
  }

  private async _chatWithProvider(provider: ProviderEntry, messages: LLMMessage[], tools?: ToolDef[], toolChoice?: 'auto' | 'required' | 'none'): Promise<LLMResponse> {
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
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<LLMResponse>;
  }

  /** Stream with failover */
  async *chatStream(messages: LLMMessage[], tools?: ToolDef[]): AsyncGenerator<StreamChunk> {
    const errors: string[] = [];

    for (let i = 0; i < this.providers.length; i++) {
      const idx = (this.currentIndex + i) % this.providers.length;
      const provider = this.providers[idx];

      const backoff = Math.min(provider.failCount * 30000, 300000);
      if (provider.failCount > 0 && Date.now() - provider.lastFail < backoff) {
        continue;
      }

      try {
        yield* this._chatStreamWithProvider(provider, messages, tools);
        provider.failCount = 0;
        this.currentIndex = idx;
        return;
      } catch (err) {
        provider.failCount++;
        provider.lastFail = Date.now();
        errors.push(`${provider.name}: ${err}`);
      }
    }

    throw new Error(`All providers failed:\n${errors.join('\n')}`);
  }

  private async *_chatStreamWithProvider(provider: ProviderEntry, messages: LLMMessage[], tools?: ToolDef[]): AsyncGenerator<StreamChunk> {
    const body: Record<string, unknown> = {
      model: provider.model,
      messages,
      max_tokens: provider.maxTokens,
      temperature: provider.temperature,
      stream: true,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const res = await fetch(`${provider.apiBase}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(provider),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data) as StreamChunk;
        } catch {
          // skip malformed chunks
        }
      }
    }
  }
}
