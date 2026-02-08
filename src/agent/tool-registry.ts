import type { ToolDef } from './llm-client.js';

export interface ToolContext {
  sessionId: string;
  workdir: string;
}

export interface ToolResult {
  output: string;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getToolDefs(): ToolDef[] {
    return this.getAll().map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async execute(name: string, params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { output: '', error: `Unknown tool: ${name}` };
    }
    try {
      return await tool.execute(params, ctx);
    } catch (err) {
      return { output: '', error: `Tool ${name} failed: ${err}` };
    }
  }
}
