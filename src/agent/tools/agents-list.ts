/**
 * Agents list tool — discover configured agents
 */

import type { Tool } from '../tool-registry.js';
import type { AgentRouter } from '../../agents/router.js';

let routerRef: AgentRouter | null = null;

export function setAgentsRouter(router: AgentRouter | null): void {
  routerRef = router;
}

export const agentsListTools: Tool[] = [
  {
    name: 'agents_list',
    description: 'List all configured agents in multi-agent mode. Shows agent names, their channel assignments, and session counts.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute() {
      if (!routerRef) {
        return { output: 'Multi-agent mode not active. Only the default agent is running.' };
      }

      const agents = routerRef.getAllAgents();
      if (agents.length === 0) {
        return { output: 'No agents configured.' };
      }

      const defaultAgent = routerRef.getDefaultAgent();
      const lines = agents.map(m => {
        const isDefault = defaultAgent?.name === m.name;
        const sessions = m.sessionManager.listSessions().length;
        return `  ${isDefault ? '>' : ' '} ${m.name}` +
          `\n    Channels: ${m.channels.join(', ')}` +
          `\n    Allow from: ${m.allowFrom.join(', ')}` +
          `\n    Sessions: ${sessions}`;
      });

      return {
        output: `Configured agents (${agents.length}):\n${lines.join('\n\n')}\n\nDefault: ${defaultAgent?.name || 'none'}`,
      };
    },
  },
];
