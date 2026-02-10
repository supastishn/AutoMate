import type { ToolDef } from './llm-client.js';

export interface ToolContext {
  sessionId: string;
  workdir: string;
  elevated?: boolean;
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

/** Metadata for a deferred tool (shown in catalog, not yet loaded into tool defs). */
export interface DeferredToolEntry {
  tool: Tool;
  /** Short one-line description for the system prompt catalog. */
  summary: string;
  /** List of actions (for action-based tools). */
  actions?: string[];
  /** Whether this tool requires a config gate (e.g. browser.enabled). */
  conditional?: string;
}

export class ToolRegistry {
  /** Active tools — included in LLM tool defs, callable. */
  private tools: Map<string, Tool> = new Map();
  /** Deferred tools — discoverable via catalog, loadable on demand. */
  private deferred: Map<string, DeferredToolEntry> = new Map();
  private allowList: string[] = [];
  private denyList: string[] = [];

  setPolicy(allow: string[], deny: string[]): void {
    this.allowList = allow;
    this.denyList = deny;
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  /** Register a tool as deferred (not in LLM tool defs until promoted). */
  registerDeferred(entry: DeferredToolEntry): void {
    this.deferred.set(entry.tool.name, entry);
  }

  /** Promote a deferred tool into the active set. Returns true if found and promoted. */
  promote(name: string): { promoted: boolean; description?: string; error?: string } {
    const entry = this.deferred.get(name);
    if (!entry) {
      // Already active?
      if (this.tools.has(name)) {
        return { promoted: false, error: `Tool "${name}" is already loaded.` };
      }
      return { promoted: false, error: `Tool "${name}" not found. Use list_tools to see available tools.` };
    }
    this.tools.set(name, entry.tool);
    this.deferred.delete(name);
    return { promoted: true, description: entry.summary };
  }

  /** Get the catalog of deferred tools for system prompt injection. */
  getDeferredCatalog(): DeferredToolEntry[] {
    return Array.from(this.deferred.values());
  }

  /** Get names of all deferred tools. */
  getDeferredNames(): string[] {
    return Array.from(this.deferred.keys());
  }

  /** Check if a tool is deferred (not yet loaded). */
  isDeferred(name: string): boolean {
    return this.deferred.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Standard tool defs (filtered by allow/deny policy) */
  getToolDefs(): ToolDef[] {
    return this.getAll()
      .filter(t => {
        if (this.denyList.includes(t.name)) return false;
        if (this.allowList.length > 0 && !this.allowList.includes(t.name)) return false;
        return true;
      })
      .map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
  }

  /** Elevated tool defs - same as standard (elevated is handled per-tool now) */
  getToolDefsElevated(): ToolDef[] {
    return this.getToolDefs();
  }

  /** Get tool defs filtered to a specific allowlist (for public/restricted users) */
  getToolDefsFiltered(allowedTools: string[]): ToolDef[] {
    if (allowedTools.length === 0) return []; // No tools for chat-only
    
    return this.getAll()
      .filter(t => {
        // Must be in the filtered allow list
        if (!allowedTools.includes(t.name) && !allowedTools.includes('*')) return false;
        // Still respect global deny list
        if (this.denyList.includes(t.name)) return false;
        return true;
      })
      .map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
  }

  /** Check if a tool is in a filtered allowlist */
  isToolAllowed(name: string, allowedTools: string[]): boolean {
    if (allowedTools.includes('*')) return !this.denyList.includes(name);
    return allowedTools.includes(name) && !this.denyList.includes(name);
  }

  async execute(name: string, params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (this.denyList.includes(name)) {
      return { output: '', error: `Tool '${name}' is denied by policy` };
    }
    if (this.allowList.length > 0 && !this.allowList.includes(name)) {
      return { output: '', error: `Tool '${name}' is not in the allow list` };
    }
    const tool = this.tools.get(name);
    if (!tool) {
      // Helpful hint if it's deferred
      if (this.deferred.has(name)) {
        return { output: '', error: `Tool '${name}' is available but not loaded. Call load_tool with name="${name}" first.` };
      }
      return { output: '', error: `Unknown tool: ${name}` };
    }
    try {
      return await tool.execute(params, ctx);
    } catch (err) {
      return { output: '', error: `Tool ${name} failed: ${err}` };
    }
  }
}
