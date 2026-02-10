import type { Tool } from '../tool-registry.js';

let sessionManagerRef: any = null;
let agentRef: any = null;

export function setSessionManager(sm: any) {
  sessionManagerRef = sm;
}

export function setAgent(a: any): void {
  agentRef = a;
}

export const sessionTools: Tool[] = [
  {
    name: 'session',
    description: [
      'Manage chat sessions.',
      'Actions: list, history, send, spawn.',
      'list — list all active sessions.',
      'history — get message history of a session.',
      'send — send a message to another session.',
      'spawn — spawn a new background sub-session with a task.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: list|history|send|spawn',
        },
        session_id: { type: 'string', description: 'Session ID (for history, send)' },
        message: { type: 'string', description: 'Message to send (for send action)' },
        prompt: { type: 'string', description: 'Task/prompt for spawned session (for spawn action)' },
        session_name: { type: 'string', description: 'Optional name for spawned session (for spawn action)' },
        limit: { type: 'number', description: 'Max messages to return (for history, default 20)' },
      },
      required: ['action'],
    },
    async execute(params) {
      const action = params.action as string;

      switch (action) {
        case 'list': {
          if (!sessionManagerRef) return { output: 'Session manager not available' };
          const sessions = sessionManagerRef.listSessions();
          if (sessions.length === 0) return { output: 'No active sessions' };
          const lines = sessions.map((s: any) =>
            `${s.id} | channel=${s.channel} | messages=${s.messageCount} | created=${s.createdAt}`
          );
          return { output: lines.join('\n') };
        }

        case 'history': {
          if (!sessionManagerRef) return { output: 'Session manager not available' };
          const session = sessionManagerRef.getSession(params.session_id as string);
          if (!session) return { output: '', error: `Session not found: ${params.session_id}` };
          const limit = (params.limit as number) || 20;
          const messages = session.messages.slice(-limit);
          const lines = messages.map((m: any) => `[${m.role}]: ${(m.content || '').slice(0, 500)}`);
          return { output: lines.join('\n\n') };
        }

        case 'send': {
          if (!sessionManagerRef) return { output: 'Session manager not available' };
          const session = sessionManagerRef.getSession(params.session_id as string);
          if (!session) return { output: '', error: `Session not found: ${params.session_id}` };
          session.messages.push({ role: 'user', content: params.message as string });
          sessionManagerRef.saveSession(params.session_id as string);
          return { output: `Message sent to session ${params.session_id}` };
        }

        case 'spawn': {
          if (!sessionManagerRef || !agentRef) return { output: '', error: 'Not available' };
          const name = (params.session_name as string) || `spawn:${Date.now()}`;
          const sessionId = `spawn:${name}`;
          agentRef.processMessage(sessionId, params.prompt as string).catch(() => {});
          return { output: `Spawned sub-session '${sessionId}' with task. Use session history to check progress.` };
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: list, history, send, spawn` };
      }
    },
  },
];
