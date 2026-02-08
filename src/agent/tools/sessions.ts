import type { Tool } from '../tool-registry.js';

// Will be injected by the session manager at runtime
let sessionManagerRef: any = null;

export function setSessionManager(sm: any) {
  sessionManagerRef = sm;
}

export const sessionsListTool: Tool = {
  name: 'sessions_list',
  description: 'List all active sessions with their IDs and metadata.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    if (!sessionManagerRef) return { output: 'Session manager not available' };
    const sessions = sessionManagerRef.listSessions();
    if (sessions.length === 0) return { output: 'No active sessions' };
    const lines = sessions.map((s: any) =>
      `${s.id} | channel=${s.channel} | messages=${s.messageCount} | created=${s.createdAt}`
    );
    return { output: lines.join('\n') };
  },
};

export const sessionsHistoryTool: Tool = {
  name: 'sessions_history',
  description: 'Get the message history of a session by ID.',
  parameters: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Session ID to get history for' },
      limit: { type: 'number', description: 'Max messages to return (default 20)' },
    },
    required: ['session_id'],
  },
  async execute(params) {
    if (!sessionManagerRef) return { output: 'Session manager not available' };
    const session = sessionManagerRef.getSession(params.session_id as string);
    if (!session) return { output: '', error: `Session not found: ${params.session_id}` };
    const limit = (params.limit as number) || 20;
    const messages = session.messages.slice(-limit);
    const lines = messages.map((m: any) => `[${m.role}]: ${(m.content || '').slice(0, 500)}`);
    return { output: lines.join('\n\n') };
  },
};

export const sessionsSendTool: Tool = {
  name: 'sessions_send',
  description: 'Send a message to another session.',
  parameters: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Target session ID' },
      message: { type: 'string', description: 'Message to send' },
    },
    required: ['session_id', 'message'],
  },
  async execute(params) {
    if (!sessionManagerRef) return { output: 'Session manager not available' };
    const session = sessionManagerRef.getSession(params.session_id as string);
    if (!session) return { output: '', error: `Session not found: ${params.session_id}` };
    // Queue message for processing
    session.messages.push({ role: 'user', content: params.message as string });
    sessionManagerRef.saveSession(params.session_id as string);
    return { output: `Message sent to session ${params.session_id}` };
  },
};

export const sessionTools = [sessionsListTool, sessionsHistoryTool, sessionsSendTool];
