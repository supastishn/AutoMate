import type { Config } from '../config/schema.js';
import { LLMClient, type LLMMessage, type StreamChunk } from './llm-client.js';
import { ToolRegistry, type ToolContext } from './tool-registry.js';
import { bashTool } from './tools/bash.js';
import { readFileTool, writeFileTool, editFileTool } from './tools/files.js';
import { browserTools } from './tools/browser.js';
import { sessionTools, setSessionManager } from './tools/sessions.js';
import type { SessionManager } from '../gateway/session-manager.js';

export interface AgentResponse {
  content: string;
  toolCalls: { name: string; result: string }[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export type StreamCallback = (chunk: string) => void;

export class Agent {
  private llm: LLMClient;
  private tools: ToolRegistry;
  private config: Config;
  private sessionManager: SessionManager;

  constructor(config: Config, sessionManager: SessionManager) {
    this.config = config;
    this.llm = new LLMClient(config);
    this.tools = new ToolRegistry();
    this.sessionManager = sessionManager;

    // Register built-in tools
    this.tools.register(bashTool);
    this.tools.register(readFileTool);
    this.tools.register(writeFileTool);
    this.tools.register(editFileTool);

    // Browser tools
    if (config.browser.enabled) {
      for (const tool of browserTools) {
        this.tools.register(tool);
      }
    }

    // Session tools
    setSessionManager(sessionManager);
    for (const tool of sessionTools) {
      this.tools.register(tool);
    }
  }

  registerTool(tool: any): void {
    this.tools.register(tool);
  }

  async processMessage(
    sessionId: string,
    userMessage: string,
    onStream?: StreamCallback,
  ): Promise<AgentResponse> {
    const session = this.sessionManager.getOrCreate(
      sessionId.split(':')[0] || 'direct',
      sessionId.split(':').slice(1).join(':') || sessionId,
    );

    // Add user message
    this.sessionManager.addMessage(sessionId, { role: 'user', content: userMessage });

    // Build messages array
    const systemMessage: LLMMessage = {
      role: 'system',
      content: this.config.agent.systemPrompt,
    };

    const toolCallResults: { name: string; result: string }[] = [];
    const toolDefs = this.tools.getToolDefs();
    const ctx: ToolContext = { sessionId, workdir: process.cwd() };

    let iterations = 0;
    const maxIterations = 50; // safety limit

    while (iterations < maxIterations) {
      iterations++;

      const messages: LLMMessage[] = [systemMessage, ...this.sessionManager.getMessages(sessionId)];

      if (onStream) {
        // Streaming mode
        const { content, toolCalls, usage } = await this.streamCompletion(messages, toolDefs, onStream);

        if (toolCalls.length > 0) {
          // Process tool calls
          this.sessionManager.addMessage(sessionId, {
            role: 'assistant',
            content: content || null,
            tool_calls: toolCalls,
          });

          // Execute tools in parallel for speed
          const results = await Promise.all(
            toolCalls.map(async (tc) => {
              let args: Record<string, unknown>;
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {
                args = {};
              }
              const result = await this.tools.execute(tc.function.name, args, ctx);
              toolCallResults.push({ name: tc.function.name, result: result.output || result.error || '' });
              return { id: tc.id, result };
            })
          );

          // Add tool results
          for (const { id, result } of results) {
            this.sessionManager.addMessage(sessionId, {
              role: 'tool',
              content: result.error ? `Error: ${result.error}\n${result.output}` : result.output,
              tool_call_id: id,
            });
          }

          // Continue the loop for the next LLM call
          continue;
        }

        // Final response (no tool calls)
        if (content) {
          this.sessionManager.addMessage(sessionId, { role: 'assistant', content });
          this.sessionManager.saveSession(sessionId);
        }

        return { content: content || '', toolCalls: toolCallResults, usage };
      } else {
        // Non-streaming mode
        const response = await this.llm.chat(messages, toolDefs);
        const choice = response.choices[0];
        const msg = choice.message;

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          this.sessionManager.addMessage(sessionId, {
            role: 'assistant',
            content: msg.content,
            tool_calls: msg.tool_calls,
          });

          const results = await Promise.all(
            msg.tool_calls.map(async (tc) => {
              let args: Record<string, unknown>;
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {
                args = {};
              }
              const result = await this.tools.execute(tc.function.name, args, ctx);
              toolCallResults.push({ name: tc.function.name, result: result.output || result.error || '' });
              return { id: tc.id, result };
            })
          );

          for (const { id, result } of results) {
            this.sessionManager.addMessage(sessionId, {
              role: 'tool',
              content: result.error ? `Error: ${result.error}\n${result.output}` : result.output,
              tool_call_id: id,
            });
          }

          continue;
        }

        const content = msg.content || '';
        if (content) {
          this.sessionManager.addMessage(sessionId, { role: 'assistant', content });
          this.sessionManager.saveSession(sessionId);
        }

        return {
          content,
          toolCalls: toolCallResults,
          usage: response.usage ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          } : undefined,
        };
      }
    }

    return { content: '(max tool iterations reached)', toolCalls: toolCallResults };
  }

  private async streamCompletion(
    messages: LLMMessage[],
    toolDefs: any[],
    onStream: StreamCallback,
  ): Promise<{ content: string; toolCalls: any[]; usage?: any }> {
    let content = '';
    const toolCalls: Map<number, { id: string; type: string; function: { name: string; arguments: string } }> = new Map();

    for await (const chunk of this.llm.chatStream(messages, toolDefs)) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        onStream(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCalls.has(tc.index)) {
            toolCalls.set(tc.index, {
              id: tc.id || '',
              type: tc.type || 'function',
              function: { name: tc.function?.name || '', arguments: '' },
            });
          }
          const existing = toolCalls.get(tc.index)!;
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.function.name = tc.function.name;
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
        }
      }
    }

    return {
      content,
      toolCalls: Array.from(toolCalls.values()),
    };
  }

  // Handle chat commands
  handleCommand(sessionId: string, command: string): string | null {
    const cmd = command.trim().toLowerCase();
    
    if (cmd === '/new' || cmd === '/reset') {
      this.sessionManager.resetSession(sessionId);
      return 'Session reset.';
    }
    
    if (cmd === '/status') {
      const session = this.sessionManager.getSession(sessionId);
      if (!session) return 'No active session.';
      return `Session: ${session.id}\nMessages: ${session.messageCount}\nModel: ${this.config.agent.model}\nCreated: ${session.createdAt}`;
    }
    
    if (cmd === '/compact') {
      this.sessionManager.compact(sessionId);
      this.sessionManager.saveSession(sessionId);
      return 'Session compacted.';
    }

    return null; // not a command
  }
}
