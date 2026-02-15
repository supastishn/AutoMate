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
  apiType: 'chat' | 'responses';
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
      apiType: (config.agent as any).apiType || 'chat',
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
          apiType: (p as any).apiType || 'chat',
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

  /** Update settings at runtime (for live config reload) */
  updateSettings(settings: { temperature?: number; maxTokens?: number }): void {
    // Update all providers with new settings
    for (const p of this.providers) {
      if (settings.temperature !== undefined) p.temperature = settings.temperature;
      if (settings.maxTokens !== undefined) p.maxTokens = settings.maxTokens;
    }
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
        });
      }
    }

    // Sort by priority (lower = higher priority)
    this.providers.sort((a, b) => a.priority - b.priority);

    // Try to restore previous selection
    const newIndex = this.providers.findIndex(p => p.model === currentModel);
    this.currentIndex = newIndex >= 0 ? newIndex : 0;
  }

  /** Get the current active provider info */
  getCurrentProvider(): { name: string; model: string; apiBase: string; apiType: string } {
    const p = this.providers[this.currentIndex];
    return { name: p.name, model: p.model, apiBase: p.apiBase, apiType: p.apiType };
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

  private getHeaders(provider: ProviderEntry): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }
    return headers;
  }

  /** Try each provider in order until one succeeds */
  async chat(messages: LLMMessage[], tools?: ToolDef[], toolChoice?: 'auto' | 'required' | 'none', signal?: AbortSignal): Promise<LLMResponse> {
    const errors: string[] = [];
    let tried = 0;

    for (let i = 0; i < this.providers.length; i++) {
      const idx = (this.currentIndex + i) % this.providers.length;
      const provider = this.providers[idx];

      // Skip providers that failed recently (backoff: 30s per fail, max 5min)
      const backoff = Math.min(provider.failCount * 30000, 300000);
      if (provider.failCount > 0 && Date.now() - provider.lastFail < backoff) {
        continue;
      }

      tried++;
      try {
        const result = await this._chatWithProvider(provider, messages, tools, toolChoice, signal);
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

    // If all providers were skipped due to backoff, force-retry the current one
    if (tried === 0) {
      const provider = this.providers[this.currentIndex];
      try {
        const result = await this._chatWithProvider(provider, messages, tools, toolChoice, signal);
        provider.failCount = 0;
        return result;
      } catch (err) {
        provider.failCount++;
        provider.lastFail = Date.now();
        throw new Error(`Provider ${provider.name} failed: ${err}`);
      }
    }

    throw new Error(errors.length === 1 ? errors[0] : `All ${errors.length} providers failed:\n${errors.join('\n')}`);
  }

  private async _chatWithProvider(provider: ProviderEntry, messages: LLMMessage[], tools?: ToolDef[], toolChoice?: 'auto' | 'required' | 'none', signal?: AbortSignal): Promise<LLMResponse> {
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

  /** Stream with failover */
  async *chatStream(messages: LLMMessage[], tools?: ToolDef[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const errors: string[] = [];
    let tried = 0;

    for (let i = 0; i < this.providers.length; i++) {
      const idx = (this.currentIndex + i) % this.providers.length;
      const provider = this.providers[idx];

      const backoff = Math.min(provider.failCount * 30000, 300000);
      if (provider.failCount > 0 && Date.now() - provider.lastFail < backoff) {
        continue;
      }

      tried++;
      try {
        yield* this._chatStreamWithProvider(provider, messages, tools, signal);
        provider.failCount = 0;
        this.currentIndex = idx;
        return;
      } catch (err) {
        provider.failCount++;
        provider.lastFail = Date.now();
        errors.push(`${provider.name}: ${err}`);
      }
    }

    // If all providers were skipped due to backoff, force-retry the current one
    if (tried === 0) {
      const provider = this.providers[this.currentIndex];
      try {
        yield* this._chatStreamWithProvider(provider, messages, tools, signal);
        provider.failCount = 0;
        return;
      } catch (err) {
        provider.failCount++;
        provider.lastFail = Date.now();
        throw new Error(`Provider ${provider.name} failed: ${err}`);
      }
    }

    throw new Error(errors.length === 1 ? errors[0] : `All ${errors.length} providers failed:\n${errors.join('\n')}`);
  }

  private async *_chatStreamWithProvider(provider: ProviderEntry, messages: LLMMessage[], tools?: ToolDef[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
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

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        // Check for abort before each read
        if (signal?.aborted) {
          reader.cancel();
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          // Check for abort while processing lines
          if (signal?.aborted) {
            reader.cancel();
            return;
          }

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
    } finally {
      // Ensure reader is released on abort or normal completion
      if (signal?.aborted) {
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

    try {
      while (true) {
        if (signal?.aborted) {
          reader.cancel();
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (signal?.aborted) {
            reader.cancel();
            return;
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
      if (signal?.aborted) {
        reader.cancel().catch(() => {});
      }
    }
  }
}