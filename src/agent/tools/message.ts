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
    description: [
      'Send messages to other sessions or channels.',
      'Actions: send, broadcast.',
      'send — send a message to a specific session (triggers agent processing in that session).',
      'broadcast — send a message to all connected webchat clients (does not trigger agent).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: send|broadcast',
        },
        sessionId: { type: 'string', description: 'Target session ID (for send)' },
        content: { type: 'string', description: 'Message content' },
        replyBack: { type: 'boolean', description: 'Whether to wait for and return the response (for send, default false)' },
        timeout: { type: 'number', description: 'Timeout in ms for replyBack (default 60000)' },
      },
      required: ['action', 'content'],
    },
    async execute(params, ctx) {
      const action = params.action as string;
      const content = params.content as string;

      if (!content) return { output: '', error: 'content is required' };
      if (!agentRef) return { output: '', error: 'Agent not available' };

      switch (action) {
        case 'send': {
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

        default:
          return { output: `Error: Unknown action "${action}". Valid: send, broadcast` };
      }
    },
  },
];
