/**
 * Message tool — cross-session messaging
 */

import type { Tool, ToolContext } from '../tool-registry.js';
import type { Agent } from '../agent.js';

let agentRef: Agent | null = null;

export function setMessageAgent(agent: Agent): void {
  agentRef = agent;
}

export const messageTools: Tool[] = [
  {
    name: 'message',
    description: 'Send messages. Actions: send (to session, triggers agent), broadcast (all clients), ask_user_question (interactive prompt with choices).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: send|broadcast|ask_user_question',
        },
        sessionId: { type: 'string', description: 'Target session ID (for send)' },
        content: { type: 'string', description: 'Message content' },
        replyBack: { type: 'boolean', description: 'Whether to wait for and return the response (for send, default false)' },
        timeout: { type: 'number', description: 'Timeout in ms for replyBack (default 60000)' },
        question: { type: 'string', description: 'Question text (for ask_user_question)' },
        options: { type: 'array', items: { type: 'string' }, description: 'Quick-select options (for ask_user_question)' },
        allowCustomInput: { type: 'boolean', description: 'Allow freeform answer input (default true)' },
        multiSelect: { type: 'boolean', description: 'Allow selecting multiple options (UI hint)' },
        questions: {
          type: 'array',
          description: 'Multiple questions to ask in one call',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
              allowCustomInput: { type: 'boolean' },
              multiSelect: { type: 'boolean' },
            },
            required: ['question'],
          },
        },
      },
      required: ['action'],
    },
    async execute(params, ctx) {
      const action = params.action as string;
      if (!agentRef) return { output: '', error: 'Agent not available' };

      const content = params.content as string;

      switch (action) {
        case 'send': {
          if (!content) return { output: '', error: 'content is required' };
          const targetSession = params.sessionId as string;
          if (!targetSession) return { output: '', error: 'sessionId is required for send' };

          const replyBack = params.replyBack as boolean || false;
          const timeout = (params.timeout as number) || 60000;

          if (!replyBack) {
            // Fire and forget
            agentRef.processMessage(targetSession, content).catch(err => {
              console.error(`[message] Send to ${targetSession} failed: ${err}`);
            });
            return { output: `Message sent to session: ${targetSession}` };
          }

          // Wait for response
          try {
            const result = await Promise.race([
              agentRef.processMessage(targetSession, content),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), timeout)
              ),
            ]);
            return {
              output: `Response from ${targetSession}:\n${result.content}`,
            };
          } catch (err) {
            if ((err as Error).message === 'timeout') {
              return { output: '', error: `Timed out waiting for response from ${targetSession}` };
            }
            return { output: '', error: `Send failed: ${(err as Error).message}` };
          }
        }

        case 'broadcast': {
          // This would need a broadcaster reference — for now just note it
          return { output: '', error: 'Broadcast requires gateway broadcaster (not available in this context). Use the gateway WebSocket API instead.' };
        }

        case 'ask_user_question': {
          const targetSession = (params.sessionId as string) || ctx?.sessionId;
          if (!targetSession) return { output: '', error: 'sessionId is required for ask_user_question' };

          const queue: Array<{ question: string; options?: string[]; allowCustomInput: boolean; multiSelect: boolean }> = [];
          const providedQuestions = Array.isArray(params.questions) ? (params.questions as Record<string, unknown>[]) : [];

          if (providedQuestions.length > 0) {
            for (const entry of providedQuestions) {
              const question = typeof entry.question === 'string' ? entry.question.trim() : '';
              if (!question) continue;
              const options = Array.isArray(entry.options)
                ? entry.options.map(v => String(v).trim()).filter(Boolean)
                : undefined;
              queue.push({
                question,
                options: options && options.length > 0 ? options : undefined,
                allowCustomInput: entry.allowCustomInput !== false,
                multiSelect: !!entry.multiSelect,
              });
            }
          } else {
            const question = typeof params.question === 'string' ? params.question.trim() : '';
            if (!question) return { output: '', error: 'question is required for ask_user_question' };
            const options = Array.isArray(params.options)
              ? (params.options as unknown[]).map(v => String(v).trim()).filter(Boolean)
              : undefined;
            queue.push({
              question,
              options: options && options.length > 0 ? options : undefined,
              allowCustomInput: params.allowCustomInput !== false,
              multiSelect: !!params.multiSelect,
            });
          }

          if (queue.length === 0) return { output: '', error: 'No valid questions provided' };

          for (let i = 0; i < queue.length; i++) {
            const q = queue[i];
            const questionPayload = {
              questionId: `ask_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
              question: q.question,
              options: q.options,
              allowCustomInput: q.allowCustomInput,
              multiSelect: q.multiSelect,
            };
            const ok = agentRef.sendEventToSession(targetSession, {
              type: 'ask_user_question',
              ...questionPayload,
              source: 'tool',
              timestamp: Date.now(),
            });
            if (!ok) return { output: '', error: 'Unable to deliver question event to session' };
            if (typeof (agentRef as any).recordAskUserQuestion === 'function') {
              (agentRef as any).recordAskUserQuestion(targetSession, questionPayload);
            }
          }

          return {
            output: `Asked ${queue.length} question(s) in session: ${targetSession}`,
          };
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: send, broadcast, ask_user_question` };
      }
    },
  },
];
