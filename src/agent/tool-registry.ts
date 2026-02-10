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

/** Stats for dashboard / monitoring. */
export interface ToolRegistryStats {
  coreToolCount: number;
  coreTools: string[];
  deferredToolCount: number;
  deferredTools: { name: string; summary: string; actions?: string[] }[];
  sessionCount: number;
  sessions: { sessionId: string; promotedTools: string[] }[];
  totalPromotions: number;
  totalDemotions: number;
}

/**
 * Per-session view of the tool registry.
 * Each session gets its own promoted/deferred sets so that loading a tool
 * in one conversation doesn't affect another.
 */
export class SessionToolView {
  /** Tools promoted for THIS session (beyond core). */
  private promoted: Map<string, Tool> = new Map();
  /** Tools demoted (unloaded) for THIS session that are globally active. */
  private demoted: Set<string> = new Set();

  constructor(
    private registry: ToolRegistry,
    readonly sessionId: string,
  ) {}

  /** Inject a tool directly into this session (not from deferred pool, not visible globally). */
  injectTool(tool: Tool): void {
    this.promoted.set(tool.name, tool);
  }

  /** Promote a deferred tool for this session. */
  promote(name: string): { promoted: boolean; description?: string; error?: string } {
    // Already promoted in this session?
    if (this.promoted.has(name)) {
      return { promoted: false, error: `Tool "${name}" is already loaded in this session.` };
    }
    // Already a core (always-active) tool?
    if (this.registry.isCoreActive(name) && !this.demoted.has(name)) {
      return { promoted: false, error: `Tool "${name}" is already loaded.` };
    }
    // Was it demoted in this session? Re-promote it.
    if (this.demoted.has(name) && this.registry.isCoreActive(name)) {
      this.demoted.delete(name);
      this.registry.recordPromotion();
      return { promoted: true, description: `Re-loaded core tool "${name}".` };
    }
    // Find in global deferred pool
    const entry = this.registry.getDeferredEntry(name);
    if (!entry) {
      return { promoted: false, error: `Tool "${name}" not found. Use list_tools to see available tools.` };
    }
    this.promoted.set(name, entry.tool);
    this.registry.recordPromotion();
    return { promoted: true, description: entry.summary };
  }

  /** Demote (unload) a tool for this session. Returns it to the deferred catalog. */
  demote(name: string): { demoted: boolean; error?: string } {
    // Check if it's session-promoted
    if (this.promoted.has(name)) {
      this.promoted.delete(name);
      this.registry.recordDemotion();
      return { demoted: true };
    }
    // Check if it's a core tool (can be hidden per-session)
    if (this.registry.isCoreActive(name)) {
      // Don't allow unloading meta-tools
      if (['list_tools', 'load_tool', 'unload_tool'].includes(name)) {
        return { demoted: false, error: `Cannot unload meta-tool "${name}".` };
      }
      this.demoted.add(name);
      this.registry.recordDemotion();
      return { demoted: true };
    }
    // Not loaded at all
    if (this.registry.isDeferredGlobal(name)) {
      return { demoted: false, error: `Tool "${name}" is not loaded. Cannot unload.` };
    }
    return { demoted: false, error: `Tool "${name}" not found.` };
  }

  /** Get all active tools for this session (core - demoted + session-promoted). */
  getActiveTools(): Tool[] {
    const result: Tool[] = [];
    // Core tools minus demoted ones
    for (const tool of this.registry.getCoreTools()) {
      if (!this.demoted.has(tool.name)) {
        result.push(tool);
      }
    }
    // Session-promoted tools
    for (const tool of this.promoted.values()) {
      result.push(tool);
    }
    return result;
  }

  /** Get deferred catalog for this session (global deferred minus session-promoted, plus demoted core tools). */
  getDeferredCatalog(): DeferredToolEntry[] {
    const result: DeferredToolEntry[] = [];
    // Global deferred minus promoted
    for (const entry of this.registry.getGlobalDeferredCatalog()) {
      if (!this.promoted.has(entry.tool.name)) {
        result.push(entry);
      }
    }
    // Add demoted core tools (so they appear in the catalog)
    for (const name of this.demoted) {
      const tool = this.registry.getCoreToolByName(name);
      if (tool) {
        result.push({
          tool,
          summary: tool.description.slice(0, 120),
        });
      }
    }
    return result;
  }

  /** Get names of tools promoted in this session. */
  getPromotedNames(): string[] {
    return Array.from(this.promoted.keys());
  }

  /** Check if a tool is active in this session. */
  isActive(name: string): boolean {
    if (this.promoted.has(name)) return true;
    if (this.demoted.has(name)) return false;
    return this.registry.isCoreActive(name);
  }

  /** Check if a tool is deferred (not loaded) in this session. */
  isDeferred(name: string): boolean {
    if (this.promoted.has(name)) return false;
    if (this.demoted.has(name)) return true;
    return this.registry.isDeferredGlobal(name);
  }

  /** Get tool defs for LLM (filtered by policy). */
  getToolDefs(): ToolDef[] {
    return this.getActiveTools()
      .filter(t => this.registry.isAllowedByPolicy(t.name))
      .map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
  }

  /** Get tool defs filtered to a specific allowlist. */
  getToolDefsFiltered(allowedTools: string[]): ToolDef[] {
    if (allowedTools.length === 0) return [];
    return this.getActiveTools()
      .filter(t => {
        if (!allowedTools.includes(t.name) && !allowedTools.includes('*')) return false;
        return this.registry.isAllowedByPolicy(t.name);
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

  /** Execute a tool within this session's context. */
  async execute(name: string, params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!this.registry.isAllowedByPolicy(name)) {
      return { output: '', error: `Tool '${name}' is denied by policy` };
    }
    // Find the tool in session's active set
    const tool = this.promoted.get(name) || (!this.demoted.has(name) ? this.registry.getCoreToolByName(name) : undefined);
    if (!tool) {
      // Helpful hint if it's deferred
      if (this.isDeferred(name)) {
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

export class ToolRegistry {
  /** Core active tools — always loaded (unless demoted per-session). */
  private coreTools: Map<string, Tool> = new Map();
  /** Global deferred tools — discoverable via catalog, loadable per-session. */
  private deferred: Map<string, DeferredToolEntry> = new Map();
  /** Per-session views. */
  private sessionViews: Map<string, SessionToolView> = new Map();
  private allowList: string[] = [];
  private denyList: string[] = [];
  /** Stats counters. */
  private promotionCount = 0;
  private demotionCount = 0;

  setPolicy(allow: string[], deny: string[]): void {
    this.allowList = allow;
    this.denyList = deny;
  }

  /** Register a core tool (always active across all sessions). */
  register(tool: Tool): void {
    this.coreTools.set(tool.name, tool);
  }

  /** Unregister a core tool. */
  unregister(name: string): void {
    this.coreTools.delete(name);
  }

  /** Register a tool as deferred (global pool, promoted per-session). */
  registerDeferred(entry: DeferredToolEntry): void {
    this.deferred.set(entry.tool.name, entry);
  }

  /** Register a dynamically-created tool as deferred (e.g. from plugins). */
  registerDynamic(tool: Tool, summary: string, actions?: string[]): void {
    // If already registered (core or deferred), skip
    if (this.coreTools.has(tool.name) || this.deferred.has(tool.name)) return;
    this.deferred.set(tool.name, { tool, summary, actions });
  }

  /** Remove a dynamic/deferred tool entirely (e.g. when plugin unloads). */
  removeDynamic(name: string): void {
    this.deferred.delete(name);
    // Also remove from any session views that have it promoted
    for (const view of this.sessionViews.values()) {
      view.demote(name);
    }
  }

  // ── Session management ──────────────────────────────────────────────────

  /** Get or create a per-session tool view. */
  getSessionView(sessionId: string): SessionToolView {
    let view = this.sessionViews.get(sessionId);
    if (!view) {
      view = new SessionToolView(this, sessionId);
      this.sessionViews.set(sessionId, view);
    }
    return view;
  }

  /** Clean up session view when session is reset/deleted. */
  clearSessionView(sessionId: string): void {
    this.sessionViews.delete(sessionId);
  }

  /** Get all session view entries (for stats). */
  getSessionViewEntries(): Map<string, SessionToolView> {
    return this.sessionViews;
  }

  // ── Accessors used by SessionToolView ───────────────────────────────────

  /** Check if a tool is in the core active set. */
  isCoreActive(name: string): boolean {
    return this.coreTools.has(name);
  }

  /** Check if a tool is in the global deferred pool. */
  isDeferredGlobal(name: string): boolean {
    return this.deferred.has(name);
  }

  /** Get a deferred entry by name. */
  getDeferredEntry(name: string): DeferredToolEntry | undefined {
    return this.deferred.get(name);
  }

  /** Get all core tools. */
  getCoreTools(): Tool[] {
    return Array.from(this.coreTools.values());
  }

  /** Get a core tool by name. */
  getCoreToolByName(name: string): Tool | undefined {
    return this.coreTools.get(name);
  }

  /** Get the global deferred catalog. */
  getGlobalDeferredCatalog(): DeferredToolEntry[] {
    return Array.from(this.deferred.values());
  }

  /** Check if a tool is allowed by allow/deny policy. */
  isAllowedByPolicy(name: string): boolean {
    if (this.denyList.includes(name)) return false;
    if (this.allowList.length > 0 && !this.allowList.includes(name)) return false;
    return true;
  }

  /** Check if a tool is in a filtered allowlist. */
  isToolAllowed(name: string, allowedTools: string[]): boolean {
    if (allowedTools.includes('*')) return !this.denyList.includes(name);
    return allowedTools.includes(name) && !this.denyList.includes(name);
  }

  /** Record a promotion (for stats). */
  recordPromotion(): void { this.promotionCount++; }
  /** Record a demotion (for stats). */
  recordDemotion(): void { this.demotionCount++; }

  // ── Backward-compatible methods (operate on core tools, no session) ─────

  get(name: string): Tool | undefined {
    return this.coreTools.get(name) || this.deferred.get(name)?.tool;
  }

  getAll(): Tool[] {
    return Array.from(this.coreTools.values());
  }

  /** Standard tool defs (core tools filtered by allow/deny policy) */
  getToolDefs(): ToolDef[] {
    return this.getAll()
      .filter(t => this.isAllowedByPolicy(t.name))
      .map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
  }

  /** Elevated tool defs - same as standard */
  getToolDefsElevated(): ToolDef[] {
    return this.getToolDefs();
  }

  /** Get tool defs filtered to a specific allowlist */
  getToolDefsFiltered(allowedTools: string[]): ToolDef[] {
    if (allowedTools.length === 0) return [];
    return this.getAll()
      .filter(t => {
        if (!allowedTools.includes(t.name) && !allowedTools.includes('*')) return false;
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

  /** Legacy global promote (still works, promotes into core). */
  promote(name: string): { promoted: boolean; description?: string; error?: string } {
    const entry = this.deferred.get(name);
    if (!entry) {
      if (this.coreTools.has(name)) {
        return { promoted: false, error: `Tool "${name}" is already loaded.` };
      }
      return { promoted: false, error: `Tool "${name}" not found. Use list_tools to see available tools.` };
    }
    this.coreTools.set(name, entry.tool);
    this.deferred.delete(name);
    return { promoted: true, description: entry.summary };
  }

  /** Legacy global catalog. */
  getDeferredCatalog(): DeferredToolEntry[] {
    return this.getGlobalDeferredCatalog();
  }

  getDeferredNames(): string[] {
    return Array.from(this.deferred.keys());
  }

  isDeferred(name: string): boolean {
    return this.deferred.has(name);
  }

  /** Legacy global execute. */
  async execute(name: string, params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (this.denyList.includes(name)) {
      return { output: '', error: `Tool '${name}' is denied by policy` };
    }
    if (this.allowList.length > 0 && !this.allowList.includes(name)) {
      return { output: '', error: `Tool '${name}' is not in the allow list` };
    }
    const tool = this.coreTools.get(name);
    if (!tool) {
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

  // ── Stats / Dashboard ───────────────────────────────────────────────────

  getStats(): ToolRegistryStats {
    const sessions: { sessionId: string; promotedTools: string[] }[] = [];
    for (const [id, view] of this.sessionViews) {
      const promoted = view.getPromotedNames();
      if (promoted.length > 0) {
        sessions.push({ sessionId: id, promotedTools: promoted });
      }
    }

    return {
      coreToolCount: this.coreTools.size,
      coreTools: Array.from(this.coreTools.keys()),
      deferredToolCount: this.deferred.size,
      deferredTools: Array.from(this.deferred.values()).map(e => ({
        name: e.tool.name,
        summary: e.summary,
        actions: e.actions,
      })),
      sessionCount: this.sessionViews.size,
      sessions,
      totalPromotions: this.promotionCount,
      totalDemotions: this.demotionCount,
    };
  }
}
