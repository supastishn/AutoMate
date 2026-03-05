import type { Tool } from '../tool-registry.js';

let sessionManagerRef: any = null;
let agentRef: any = null;

export function setSessionManager(sm: any) {
  sessionManagerRef = sm;
}

export function setAgent(a: any): void {
  agentRef = a;
}

/**
 * Send a notification to the chat session from any context (heartbeat, work session, etc.)
 * Appears as a system notification in the user's chat. Does NOT trigger agent processing.
 */
export function notifyChatSession(message: string, source: string = 'system'): boolean {
  if (!sessionManagerRef || !agentRef) return false;
  const roles = sessionManagerRef.getSessionRoles();
  const chatId = roles?.chat;
  if (!chatId) return false;

  // Push notification to WebSocket so user sees it in real-time
  agentRef.sendEventToSession(chatId, {
    type: 'cross_session_notification',
    content: message,
    source,
    timestamp: Date.now(),
  });

  // Also add as a system message in the chat session history
  const session = sessionManagerRef.getSession(chatId);
  if (session) {
    session.messages.push({
      role: 'assistant',
      content: `🔔 **${source}**: ${message}`,
    });
    sessionManagerRef.saveSession(chatId);
  }
  return true;
}

/**
 * Get the last N actions/messages from a session (for cross-session context).
 */
export function getRecentSessionActivity(sessionId: string, count: number = 3): string[] {
  if (!sessionManagerRef) return [];
  const session = sessionManagerRef.getSession(sessionId);
  if (!session) return [];
  const msgs = session.messages.slice(-count * 2); // get more, then filter
  const activities: string[] = [];
  for (const m of msgs) {
    if (m.role === 'assistant' && m.content) {
      const text = typeof m.content === 'string' ? m.content : '';
      if (text && !text.startsWith('🔔')) {
        activities.push(text.slice(0, 150));
      }
    } else if (m.role === 'user' && m.content) {
      const text = typeof m.content === 'string' ? m.content : '';
      if (text && !text.startsWith('[SCHEDULED') && !text.startsWith('[AUTONOMOUS')) {
        activities.push(`[user]: ${text.slice(0, 150)}`);
      }
    }
    if (activities.length >= count) break;
  }
  return activities;
}

export const sessionTools: Tool[] = [
  {
    name: 'session',
    description: [
      'Manage chat sessions. Actions: list, history, send (triggers agent), notify (display only),',
      'delegate (background task), spawn (new sub-session), status, pull (import context).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: list|history|send|notify|delegate|spawn|status|pull',
        },
        session_id: { type: 'string', description: 'Session ID (for history, send)' },
        message: { type: 'string', description: 'Message to send/notify/delegate' },
        prompt: { type: 'string', description: 'Task/prompt for spawned session (for spawn action)' },
        session_name: { type: 'string', description: 'Optional name for spawned session (for spawn action)' },
        limit: { type: 'number', description: 'Max messages to return (for history/pull, default 20)' },
        notify_on_complete: { type: 'boolean', description: 'For delegate: notify chat session when done (default true)' },
      },
      required: ['action'],
    },
    async execute(params, ctx) {
      const action = params.action as string;

      switch (action) {
        case 'list': {
          if (!sessionManagerRef) return { output: 'Session manager not available' };
          const sessions = sessionManagerRef.listSessions();
          if (sessions.length === 0) return { output: 'No active sessions' };
          const roles = sessionManagerRef.getSessionRoles();
          const lines = sessions.map((s: any) => {
            let role = '';
            if (roles?.chat === s.id) role = ' [💬 chat]';
            else if (roles?.work === s.id) role = ' [🔧 work]';
            return `${s.id}${role} | channel=${s.channel} | messages=${s.messageCount} | created=${s.createdAt}`;
          });
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
          // Actually triggers agent processing in the target session
          if (!agentRef) return { output: '', error: 'Agent not available' };
          const targetId = params.session_id as string;
          if (!targetId) return { output: '', error: 'session_id required' };
          const message = params.message as string;
          if (!message) return { output: '', error: 'message required' };
          agentRef.injectMessage(targetId, message, { role: 'user', source: 'cross-session' });
          return { output: `Message sent to session ${targetId} (will be processed by the agent)` };
        }

        case 'notify': {
          // Send notification to chat session without triggering processing
          const message = params.message as string;
          if (!message) return { output: '', error: 'message required' };
          const sent = notifyChatSession(message, 'work session');
          if (!sent) return { output: 'No chat session available to notify' };
          return { output: 'Notification sent to chat session' };
        }

        case 'delegate': {
          // Delegate a task from chat to the work session
          if (!sessionManagerRef || !agentRef) return { output: '', error: 'Not available' };
          const roles = sessionManagerRef.getSessionRoles();
          const workId = roles?.work;
          if (!workId) return { output: '', error: 'No work session assigned. Set one first via the Sessions page.' };
          const message = params.message as string;
          if (!message) return { output: '', error: 'message required (the task to delegate)' };

          const notifyOnComplete = params.notify_on_complete !== false;
          const delegatePrompt = `[DELEGATED TASK from chat session]\n\n${message}${notifyOnComplete ? '\n\nWhen done, use `session action=notify message="<brief result summary>"` to notify the chat session.' : ''}`;

          agentRef.injectMessage(workId, delegatePrompt, { role: 'user', source: 'delegation' });

          return { output: `Task delegated to work session (${workId}). ${notifyOnComplete ? 'Chat will be notified on completion.' : ''}` };
        }

        case 'spawn': {
          if (!sessionManagerRef || !agentRef) return { output: '', error: 'Not available' };
          const name = (params.session_name as string) || `spawn:${Date.now()}`;
          const sessionId = `spawn:${name}`;
          agentRef.processMessage(sessionId, params.prompt as string).catch(() => {});
          return { output: `Spawned sub-session '${sessionId}' with task. Use session history to check progress.` };
        }

        case 'status': {
          // Quick status of the other session
          if (!sessionManagerRef) return { output: 'Session manager not available' };
          const roles = sessionManagerRef.getSessionRoles();
          const currentRole = ctx?.sessionId ? sessionManagerRef.getSessionRole(ctx.sessionId) : null;
          const otherRole = currentRole === 'chat' ? 'work' : 'chat';
          const otherId = roles?.[otherRole];
          if (!otherId) return { output: `No ${otherRole} session assigned.` };

          const otherSession = sessionManagerRef.getSession(otherId);
          if (!otherSession) return { output: `${otherRole} session (${otherId}) not found.` };

          const msgs = otherSession.messages;
          const totalMsgs = msgs.length;
          const lastMsg = msgs.filter((m: any) => m.role === 'assistant' && m.content).slice(-1)[0];
          const lastUser = msgs.filter((m: any) => m.role === 'user' && m.content).slice(-1)[0];
          // Count recent tool calls
          const recentTools = msgs.slice(-20)
            .filter((m: any) => m.role === 'assistant' && m.tool_calls?.length)
            .flatMap((m: any) => m.tool_calls.map((tc: any) => tc.function?.name))
            .filter(Boolean);
          const toolCounts: Record<string, number> = {};
          for (const t of recentTools) toolCounts[t] = (toolCounts[t] || 0) + 1;

          const lines = [
            `**${otherRole} session** (\`${otherId}\`)`,
            `Messages: ${totalMsgs}`,
            `Last activity: ${otherSession.updatedAt || 'unknown'}`,
          ];
          if (lastUser) {
            const text = typeof lastUser.content === 'string' ? lastUser.content : '';
            lines.push(`Last task: ${text.slice(0, 200)}`);
          }
          if (lastMsg) {
            const text = typeof lastMsg.content === 'string' ? lastMsg.content : '';
            lines.push(`Last response: ${text.slice(0, 300)}`);
          }
          if (Object.keys(toolCounts).length > 0) {
            const toolSummary = Object.entries(toolCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([n, c]) => `${n}(${c})`)
              .join(', ');
            lines.push(`Recent tools: ${toolSummary}`);
          }
          return { output: lines.join('\n') };
        }

        case 'pull': {
          // Pull recent context from the other session
          if (!sessionManagerRef) return { output: 'Session manager not available' };
          const roles = sessionManagerRef.getSessionRoles();
          const currentRole = ctx?.sessionId ? sessionManagerRef.getSessionRole(ctx.sessionId) : null;
          const targetRole = currentRole === 'chat' ? 'work' : 'chat';
          const targetId = params.session_id || roles?.[targetRole];
          if (!targetId) return { output: `No ${targetRole} session to pull from.` };

          const targetSession = sessionManagerRef.getSession(targetId);
          if (!targetSession) return { output: '', error: `Session ${targetId} not found` };

          const limit = (params.limit as number) || 20;
          const msgs = targetSession.messages.slice(-limit);
          const lines = msgs
            .filter((m: any) => m.content && m.role !== 'system')
            .map((m: any) => {
              const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : 'Tool';
              const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              return `[${role}] ${text.slice(0, 500)}`;
            });
          return { output: `--- Recent from ${targetRole} session (${targetId}) ---\n${lines.join('\n\n')}` };
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: list, history, send, notify, delegate, spawn` };
      }
    },
  },
];
