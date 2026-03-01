import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Config } from '../config/schema.js';
import type { LLMMessage, ContentPart } from '../agent/llm-client.js';
import type { LLMClient } from '../agent/llm-client.js';
import type { MemoryManager } from '../memory/manager.js';
import { pruneContextMessages, type PruningSettings, type PruneStats, DEFAULT_PRUNING_SETTINGS } from './context-pruner.js';

/** Helper to check if content is a string (vs multimodal ContentPart[]) */
function isStringContent(content: string | ContentPart[] | null): content is string {
  return typeof content === 'string';
}

/** Helper to get text from content (handles both string and ContentPart[]) */
function getTextFromContent(content: string | ContentPart[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  // ContentPart[] - extract text parts
  return content
    .filter(part => part.type === 'text' && part.text)
    .map(part => part.text)
    .join(' ');
}

/** System prompt for conversation summarization */
const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. Create an EXTREMELY CONCISE summary that captures ONLY what's needed to continue the conversation.

TARGET: Under 2000 words. Be ruthless about brevity.

Format:
## Status
One sentence: what's happening RIGHT NOW.

## Key Facts
Only include facts that will be needed going forward. Skip anything already completed or no longer relevant.
- File paths currently being worked on
- Important decisions made
- User preferences that affect ongoing work

## Do NOT Include
- Completed tasks (unless needed for context)
- Failed attempts that were resolved
- Conversational back-and-forth
- Explanations of why things were done
- Code snippets unless actively being modified

## Current Task
**What is done:**
- [List completed steps/achievements in this session]

**What must be done:**
- [List remaining steps to complete the current goal]
- [Include specific next actions, file paths, commands if relevant]

Be terse. Use fragments. Skip articles. The goal is MINIMUM tokens while preserving ability to continue work.`;

export interface Session {
  id: string;
  channel: string;
  userId: string;
  messages: LLMMessage[];
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private config: Config;
  private dir: string;
  private resetTimer: NodeJS.Timeout | null = null;
  private llm: LLMClient | null = null;
  private compactingSessions: Set<string> = new Set(); // prevent concurrent compactions
  private mainSessionId: string | null = null;
  private mainSessionFile: string;
  private sessionRoles: { chat: string | null; work: string | null } = { chat: null, work: null };
  private sessionRolesFile: string;
  private dndEnabled: boolean = false;
  private dndFile: string;
  private writeLocks: Map<string, Promise<void>> = new Map(); // prevent concurrent writes
  private memoryManager: MemoryManager | null = null; // for transcript indexing
  private transcriptIndexQueue: Set<string> = new Set(); // sessions pending index
  private transcriptIndexTimer: NodeJS.Timeout | null = null;
  private defaultCompactInstructions: string | null = null; // default instructions for all compactions
  private overheadEstimator: ((sessionId: string) => number) | null = null; // callback to get system prompt + tool defs overhead
  private sessionTokens: Map<string, { prompt: number; completion: number; total: number; msgCountAtSnapshot: number }> = new Map(); // actual API-reported token counts per session
  private sessionTokenTotals: Map<string, { prompt: number; completion: number; total: number }> = new Map(); // cumulative token usage per session
  private toolCallsSinceMemory: Map<string, number> = new Map(); // track tool calls since last memory tool use
  private memoryReminderSent: Map<string, boolean> = new Map(); // prevent duplicate reminders
  private currentModel: string | null = null; // current model name for context window lookup
  private onAutoCompactContinuation: ((sessionId: string, continuationMessage: string) => void) | null = null; // callback when auto-compact adds continuation

  constructor(config: Config) {
    this.config = config;
    this.dir = config.sessions.directory;
    mkdirSync(this.dir, { recursive: true });
    this.mainSessionFile = join(this.dir, '.main-session');
    this.sessionRolesFile = join(this.dir, '.session-roles');
    this.dndFile = join(this.dir, '.dnd');
    this.loadAll();
    this.loadMainSession();
    this.loadSessionRoles();
    this.loadDnd();
    this.startAutoReset();
  }

  /** Set memory manager for transcript indexing */
  setMemoryManager(mm: MemoryManager): void {
    this.memoryManager = mm;
  }

  /** Set the current model name (for context window lookup) */
  setCurrentModel(modelName: string): void {
    this.currentModel = modelName;
  }

  /**
   * Get the context limit for the current model.
   * Priority: provider.contextWindow > modelContextWindows match > sessions.contextLimit
   */
  getContextLimit(providerContextWindow?: number): number {
    // 1. Provider-specific contextWindow takes highest priority
    if (providerContextWindow) {
      return providerContextWindow;
    }

    // 2. Check modelContextWindows patterns
    if (this.currentModel) {
      const modelWindows = (this.config.sessions as any).modelContextWindows as Record<string, number> | undefined;
      if (modelWindows) {
        // Check for exact match first
        if (modelWindows[this.currentModel]) {
          return modelWindows[this.currentModel];
        }
        // Check patterns (support * wildcard)
        for (const [pattern, contextWindow] of Object.entries(modelWindows)) {
          if (pattern.includes('*')) {
            const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
            if (regex.test(this.currentModel)) {
              return contextWindow;
            }
          }
        }
      }
    }

    // 3. Fall back to default contextLimit
    return this.config.sessions.contextLimit;
  }

  private startAutoReset(): void {
    const hour = (this.config.sessions as any).autoResetHour;
    if (hour === undefined || hour < 0 || hour > 23) return;

    // Check every 60 seconds if it's time to reset
    this.resetTimer = setInterval(() => {
      const now = new Date();
      if (now.getHours() === hour && now.getMinutes() === 0) {
        console.log(`[session] Auto-reset triggered at ${now.toISOString()}`);
        for (const [id] of this.sessions) {
          this.resetSession(id);
        }
      }
    }, 60000);
  }

  private sessionPath(id: string): string {
    if (!id) throw new Error('sessionPath called with undefined/null id');
    // Sanitize session ID for filesystem (replace colons with underscores)
    const safeName = id.replace(/[:/\\?*"<>|]/g, '_');
    return join(this.dir, `${safeName}.json`);
  }

  private loadAll(): void {
    if (!existsSync(this.dir)) return;
    const files = readdirSync(this.dir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    for (const file of files) {
      try {
        const raw = readFileSync(join(this.dir, file), 'utf-8');
        const data = JSON.parse(raw) as Session;
        // Skip sessions with missing/invalid id
        if (!data.id) {
          console.warn(`[session] Skipping session file ${file} - missing id`);
          continue;
        }
        // Repair any corrupted session data
        this.repairSession(data);
        this.sessions.set(data.id, data);
      } catch (err) {
        // Try to repair corrupt session files
        console.warn(`[session] Corrupt session file ${file}, attempting repair...`);
        this.repairSessionFile(join(this.dir, file));
      }
    }
  }

  /** Repair a corrupt session file */
  private repairSessionFile(path: string): void {
    try {
      const raw = readFileSync(path, 'utf-8');
      // Try to salvage JSON by finding the last valid closing brace
      let repaired = raw;
      
      // Common corruption: truncated JSON
      const lastBrace = raw.lastIndexOf('}');
      if (lastBrace > 0) {
        // Count braces to find valid JSON boundary
        let depth = 0;
        let validEnd = -1;
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] === '{') depth++;
          else if (raw[i] === '}') {
            depth--;
            if (depth === 0) validEnd = i + 1;
          }
        }
        if (validEnd > 0 && validEnd < raw.length) {
          repaired = raw.slice(0, validEnd);
        }
      }

      const data = JSON.parse(repaired) as Session;
      this.repairSession(data);
      this.sessions.set(data.id, data);
      // Save repaired session
      writeFileSync(path, JSON.stringify(data, null, 2));
      console.log(`[session] Repaired session: ${data.id}`);
    } catch {
      console.error(`[session] Could not repair ${path}, skipping`);
    }
  }

  /** Repair session data structure (fix orphaned tool calls, etc.) */
  private repairSession(session: Session): void {
    if (!session.messages) session.messages = [];
    if (!session.messageCount) session.messageCount = session.messages.length;
    if (!session.createdAt) session.createdAt = new Date().toISOString();
    if (!session.updatedAt) session.updatedAt = new Date().toISOString();
    if (!session.metadata) session.metadata = {};

    // Remove blank/empty messages that can break the API
    session.messages = session.messages.filter(m => {
      // Keep assistant messages with tool_calls even if content is null/empty
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) return true;
      // Keep tool messages (they have tool_call_id)
      if (m.role === 'tool') return true;
      // For user/system messages, require non-empty content
      const text = getTextFromContent(m.content);
      return text && text.trim().length > 0;
    });

    // Sanitize tool pairs
    // Sanitize malformed tool_call arguments (prevent "Invalid JSON format" errors on replay)
    for (const m of session.messages) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              // Attempt repair
              let repaired = tc.function.arguments;
              const opens = (repaired.match(/[{[]/g) || []).length;
              const closes = (repaired.match(/[}\]]/g) || []).length;
              if (opens > closes) {
                for (let i = 0; i < opens - closes; i++) repaired += '}';
                try { JSON.parse(repaired); tc.function.arguments = repaired; continue; } catch {}
              }
              tc.function.arguments = '{}';
            }
          }
        }
      }
    }
    this.sanitizeToolPairs(session);
  }

  /** Load main session ID from disk */
  private loadMainSession(): void {
    try {
      if (existsSync(this.mainSessionFile)) {
        this.mainSessionId = readFileSync(this.mainSessionFile, 'utf-8').trim() || null;
      }
    } catch {
      this.mainSessionId = null;
    }
  }

  /** Get the main session ID (or null if not set) */
  getMainSessionId(): string | null {
    return this.mainSessionId;
  }

  /** Set a session as the main session. Pass null to clear. */
  setMainSession(sessionId: string | null): void {
    this.mainSessionId = sessionId;
    try {
      if (sessionId) {
        writeFileSync(this.mainSessionFile, sessionId);
      } else if (existsSync(this.mainSessionFile)) {
        unlinkSync(this.mainSessionFile);
      }
    } catch (err) {
      console.error(`[session] Failed to persist main session: ${err}`);
    }
  }

  // ── Session Roles (chat / work) ──────────────────────────────────────

  /** Load session roles from disk */
  private loadSessionRoles(): void {
    try {
      if (existsSync(this.sessionRolesFile)) {
        const data = JSON.parse(readFileSync(this.sessionRolesFile, 'utf-8'));
        this.sessionRoles = {
          chat: data.chat || null,
          work: data.work || null,
        };
      }
    } catch {
      this.sessionRoles = { chat: null, work: null };
    }
  }

  /** Persist session roles to disk */
  private saveSessionRoles(): void {
    try {
      writeFileSync(this.sessionRolesFile, JSON.stringify(this.sessionRoles));
    } catch (err) {
      console.error(`[session] Failed to persist session roles: ${err}`);
    }
  }

  /** Get all session roles */
  getSessionRoles(): { chat: string | null; work: string | null } {
    return { ...this.sessionRoles };
  }

  /** Get which role a session has, or null */
  getSessionRole(sessionId: string): 'chat' | 'work' | null {
    if (this.sessionRoles.chat === sessionId) return 'chat';
    if (this.sessionRoles.work === sessionId) return 'work';
    return null;
  }

  /** Get the session ID assigned to a role */
  getSessionByRole(role: 'chat' | 'work'): string | null {
    return this.sessionRoles[role];
  }

  /** Assign a role to a session. Pass null to clear. */
  setSessionRole(role: 'chat' | 'work', sessionId: string | null): void {
    // If this sessionId was in the other role, clear it
    if (sessionId) {
      const otherRole = role === 'chat' ? 'work' : 'chat';
      if (this.sessionRoles[otherRole] === sessionId) {
        this.sessionRoles[otherRole] = null;
      }
    }
    this.sessionRoles[role] = sessionId;
    this.saveSessionRoles();
  }

  // ── Do Not Disturb ────────────────────────────────────────────────────

  private loadDnd(): void {
    try {
      if (existsSync(this.dndFile)) {
        this.dndEnabled = readFileSync(this.dndFile, 'utf-8').trim() === 'true';
      }
    } catch {
      this.dndEnabled = false;
    }
  }

  isDnd(): boolean {
    return this.dndEnabled;
  }

  setDnd(enabled: boolean): void {
    this.dndEnabled = enabled;
    try {
      writeFileSync(this.dndFile, enabled ? 'true' : 'false');
    } catch (err) {
      console.error(`[session] Failed to persist DND state: ${err}`);
    }
  }

  /** Get the session to route automated messages to (work session when DND, otherwise original) */
  getAutomatedSessionTarget(originalSessionId: string): string {
    if (this.dndEnabled && this.sessionRoles.work) {
      return this.sessionRoles.work;
    }
    return originalSessionId;
  }

  getOrCreate(channel: string, userId: string): Session {
    const key = `${channel}:${userId}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        id: key,
        channel,
        userId,
        messages: [],
        messageCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values()).map(s => ({
      ...s,
      messages: [], // don't send full history in list
    }));
  }

  // Callback for pre-compaction memory flush
  private onBeforeCompact: ((sessionId: string, messages: LLMMessage[]) => Promise<void>) | null = null;

  /** Register a callback that runs before compaction to save memories */
  setBeforeCompactHook(fn: (sessionId: string, messages: LLMMessage[]) => Promise<void>): void {
    this.onBeforeCompact = fn;
  }

  /** Register a callback that fires when auto-compact adds a continuation message.
   *  This allows the agent/gateway to trigger processing of the continuation. */
  setAutoCompactContinuationCallback(fn: (sessionId: string, continuationMessage: string) => void): void {
    this.onAutoCompactContinuation = fn;
  }

  /** Set the LLM client for summary-based compaction */
  setLLMClient(llm: LLMClient): void {
    this.llm = llm;
  }

  /** Set default instructions injected into every compaction (manual and auto) */
  setDefaultCompactInstructions(instructions: string): void {
    this.defaultCompactInstructions = instructions;
  }

  /** Set a callback that returns the estimated token overhead (system prompt + tool defs) for a session.
   *  This is added to message-content estimates so context % and auto-compact reflect true usage. */
  setOverheadEstimator(fn: (sessionId: string) => number): void {
    this.overheadEstimator = fn;
  }

  /** Store actual API-reported token usage for a session.
   *  Called after each LLM API call with the usage data from the response.
   *  prompt_tokens includes the full context (system prompt + tools + messages).
   *  Also triggers auto-compact check since we now have accurate token counts. */
  setSessionTokens(sessionId: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number }, providerContextWindow?: number): void {
    const session = this.sessions.get(sessionId);
    this.sessionTokens.set(sessionId, {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
      total: usage.totalTokens,
      msgCountAtSnapshot: session ? session.messages.length : 0,
    });
    const totals = this.sessionTokenTotals.get(sessionId) || { prompt: 0, completion: 0, total: 0 };
    this.sessionTokenTotals.set(sessionId, {
      prompt: totals.prompt + usage.promptTokens,
      completion: totals.completion + usage.completionTokens,
      total: totals.total + usage.totalTokens,
    });

    // Auto-compact check using ACTUAL API-reported tokens
    if (session && !this.compactingSessions.has(sessionId)) {
      const tokenLimit = this.getContextLimit(providerContextWindow);
      const reserveTokens = (this.config.sessions as any).reserveTokens || 20000;
      const compactAtRatio = this.config.sessions.compactAt;
      const threshold = Math.max(0, Math.floor((tokenLimit - reserveTokens) * compactAtRatio));
      const currentTokens = usage.promptTokens; // Use actual API value
      const percent = Math.round((currentTokens / tokenLimit) * 100);

      console.log(`[session] Token check: ${currentTokens} tokens, threshold=${threshold}, limit=${tokenLimit}, percent=${percent}%`);

      if (currentTokens > threshold) {
        console.log(`[session] Auto-compact triggered for ${sessionId}: ${currentTokens} > ${threshold} (${percent}%)`);
        // compactWithSummary handles the lock internally
        this.compactWithSummary(sessionId, this.llm || undefined, this.defaultCompactInstructions || undefined, true)
          .catch(err => console.error(`[session] Auto-compact failed for ${sessionId}:`, err));
      }
    }
  }

  /** Get cumulative token totals for a session since last reset. */
  getSessionTokenTotals(sessionId: string): { prompt: number; completion: number; total: number } {
    return this.sessionTokenTotals.get(sessionId) || { prompt: 0, completion: 0, total: 0 };
  }

  addMessage(sessionId: string, message: LLMMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.push(message);
    session.messageCount++;
    session.updatedAt = new Date().toISOString();

    // Queue session for transcript indexing (debounced)
    this.queueTranscriptIndex(sessionId);
  }

  /** Update an existing message in a session */
  updateMessage(sessionId: string, index: number, message: LLMMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session || index < 0 || index >= session.messages.length) return;
    session.messages[index] = message;
    session.updatedAt = new Date().toISOString();
  }

  /**
   * Track a tool call for memory reminder purposes.
   * Call this after each tool execution.
   * Returns true if a memory reminder should be injected.
   */
  trackToolCall(sessionId: string, toolName: string): { shouldRemind: boolean } {
    const memoryTools = ['memory', 'memory_read', 'memory_write', 'memory_search', 'memory_list'];
    const isMemoryTool = memoryTools.some(mt => toolName.toLowerCase().includes(mt.toLowerCase()));

    if (isMemoryTool) {
      // Reset counter when memory tool is used
      this.toolCallsSinceMemory.set(sessionId, 0);
      this.memoryReminderSent.set(sessionId, false);
      return { shouldRemind: false };
    }

    const count = (this.toolCallsSinceMemory.get(sessionId) || 0) + 1;
    this.toolCallsSinceMemory.set(sessionId, count);

    // After 100 tool calls without memory, remind once
    if (count >= 100 && !this.memoryReminderSent.get(sessionId)) {
      this.memoryReminderSent.set(sessionId, true);
      return { shouldRemind: true };
    }

    return { shouldRemind: false };
  }

  /**
   * Prune old tool outputs - keep only the N most recent, replace others with placeholder.
   * This runs before sending messages to the LLM.
   */
  pruneOldToolOutputs(messages: LLMMessage[], keepRecent: number = 50): LLMMessage[] {
    // Find all tool result indices
    const toolIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') {
        toolIndices.push(i);
      }
    }

    // If we have more than keepRecent tool results, prune the older ones
    if (toolIndices.length <= keepRecent) {
      return messages;
    }

    const indicesToPrune = new Set(toolIndices.slice(0, toolIndices.length - keepRecent));

    return messages.map((m, i) => {
      if (indicesToPrune.has(i) && m.role === 'tool') {
        return { ...m, content: '[OUTPUT REMOVED]' };
      }
      return m;
    });
  }

  /** Queue a session for transcript indexing (debounced to avoid excessive indexing) */
  private queueTranscriptIndex(sessionId: string): void {
    if (!this.memoryManager) return;
    this.transcriptIndexQueue.add(sessionId);

    // Debounce: index after 30 seconds of inactivity
    if (this.transcriptIndexTimer) clearTimeout(this.transcriptIndexTimer);
    this.transcriptIndexTimer = setTimeout(() => {
      this.indexQueuedTranscripts();
    }, 30000);
  }

  /** Index all queued session transcripts into memory */
  private async indexQueuedTranscripts(): Promise<void> {
    if (!this.memoryManager || this.transcriptIndexQueue.size === 0) return;

    const sessions = [...this.transcriptIndexQueue];
    this.transcriptIndexQueue.clear();

    for (const sessionId of sessions) {
      try {
        await this.indexSessionTranscript(sessionId);
      } catch (err) {
        console.error(`[session] Failed to index transcript for ${sessionId}:`, err);
      }
    }
  }

  /** Index a single session's transcript into memory for semantic search */
  async indexSessionTranscript(sessionId: string): Promise<void> {
    if (!this.memoryManager) return;

    const session = this.sessions.get(sessionId);
    if (!session || session.messages.length < 3) return;

    // Build transcript text
    const transcript = session.messages
      .filter(m => m.role !== 'system' && m.content)
      .map(m => {
        const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : 'Tool';
        return `[${role}] ${m.content}`;
      })
      .join('\n\n');

    if (transcript.length < 100) return;

    // Save transcript and index immediately for text search
    this.memoryManager.saveTranscript(sessionId, transcript);
  }

  /** Save session with write lock to prevent concurrent writes */
  async saveSessionLocked(sessionId: string): Promise<void> {
    // Wait for any existing write to complete
    const existingLock = this.writeLocks.get(sessionId);
    if (existingLock) {
      await existingLock;
    }

    // Create new lock
    const lockPromise = this._doSaveSession(sessionId);
    this.writeLocks.set(sessionId, lockPromise);

    try {
      await lockPromise;
    } finally {
      this.writeLocks.delete(sessionId);
    }
  }

  private async _doSaveSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    writeFileSync(this.sessionPath(sessionId), JSON.stringify(session, null, 2));
  }

  saveSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    writeFileSync(this.sessionPath(sessionId), JSON.stringify(session, null, 2));
  }

  resetSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages = [];
    session.messageCount = 0;
    session.updatedAt = new Date().toISOString();
    this.sessionTokens.delete(sessionId); // clear stale API token data
    this.sessionTokenTotals.delete(sessionId); // clear cumulative token totals
    this.saveSession(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionTokens.delete(sessionId);
    this.sessionTokenTotals.delete(sessionId);
    const path = this.sessionPath(sessionId);
    if (existsSync(path)) unlinkSync(path);
  }

  /** Duplicate a session with a new ID. Returns the new session or null if source not found. */
  duplicateSession(sourceId: string, newId?: string): Session | null {
    const source = this.sessions.get(sourceId);
    if (!source) return null;

    const id = newId || `${sourceId}:copy-${nanoid(6)}`;
    const now = new Date().toISOString();
    const duplicate: Session = {
      id,
      channel: source.channel,
      userId: source.userId,
      messages: JSON.parse(JSON.stringify(source.messages)), // deep copy
      messageCount: source.messageCount,
      createdAt: now,
      updatedAt: now,
      metadata: { ...source.metadata, duplicatedFrom: sourceId },
    };

    this.sessions.set(id, duplicate);
    this.saveSession(id);
    return duplicate;
  }

  /**
   * Emergency truncation when LLM is unavailable: keep system messages
   * and only the last 4 non-system messages, then sanitize tool pairs.
   */
  private emergencyTruncate(session: Session): void {
    const systemMsgs = session.messages.filter(m => m.role === 'system');
    const nonSystem = session.messages.filter(m => m.role !== 'system');
    const kept = nonSystem.slice(-4);
    const removedCount = nonSystem.length - kept.length;
    session.messages = [
      ...systemMsgs,
      ...(removedCount > 0
        ? [{ role: 'system' as const, content: `[Emergency compaction: ${removedCount} messages truncated without summary]` }]
        : []),
      ...kept,
    ];
    this.sanitizeToolPairs(session);
    session.updatedAt = new Date().toISOString();
  }

  /**
   * Remove orphaned tool_call / tool_result messages after compaction.
   * The API requires that each tool_result IMMEDIATELY follows an assistant message
   * containing the matching tool_use. This method enforces that strict ordering.
   * IMPORTANT: ALL tool_calls in an assistant message must have matching results.
   */
  private sanitizeToolPairs(session: Session): void {
    const messages = session.messages;
    const result: LLMMessage[] = [];
    let lastAssistantToolCallIds = new Set<string>();

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];

      if (m.role === 'assistant') {
        // Check if this assistant message has tool_calls
        if (m.tool_calls && m.tool_calls.length > 0) {
          // Look ahead to see if ALL tool_calls have matching tool results
          const toolCallIds = new Set(m.tool_calls.map(tc => tc.id));
          const foundResultIds = new Set<string>();

          for (let j = i + 1; j < messages.length; j++) {
            const next = messages[j];
            if (next.role === 'tool' && next.tool_call_id && toolCallIds.has(next.tool_call_id)) {
              foundResultIds.add(next.tool_call_id);
            }
            // Stop looking if we hit another non-tool message
            if (next.role !== 'tool') break;
          }

          // ALL tool_calls must have matching results, not just one
          const allHaveResults = toolCallIds.size === foundResultIds.size;

          if (allHaveResults) {
            result.push(m);
            lastAssistantToolCallIds = toolCallIds;
          } else {
            // Skip this assistant message - missing tool results
            const missing = [...toolCallIds].filter(id => !foundResultIds.has(id));
            const missingNames = m.tool_calls
              .filter(tc => missing.includes(tc.id))
              .map(tc => tc.function?.name || tc.id);
            console.log(`[session] Removed assistant with incomplete tool results. Missing: ${missingNames.join(', ')}`);
          }
        } else {
          // Regular assistant message without tool_calls
          result.push(m);
          lastAssistantToolCallIds = new Set();
        }
      } else if (m.role === 'tool') {
        // Only keep tool results that match the immediately preceding assistant's tool_calls
        if (m.tool_call_id && lastAssistantToolCallIds.has(m.tool_call_id)) {
          result.push(m);
        } else {
          console.log(`[session] Removed orphaned tool result: ${m.tool_call_id}`);
        }
      } else {
        // User or system message - reset tool tracking
        result.push(m);
        lastAssistantToolCallIds = new Set();
      }
    }

    session.messages = result;
  }

  /**
   * Repair broken tool pairs in a session (public method for manual repair).
   * Also replaces empty assistant messages with "[content deleted]".
   * Returns number of messages fixed.
   */
  repairToolPairs(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;
    const before = session.messages.length;
    this.sanitizeToolPairs(session);
    const removed = before - session.messages.length;

    // Also fix empty assistant messages
    let fixed = 0;
    for (const m of session.messages) {
      const text = getTextFromContent(m.content);
      if (m.role === 'assistant' && (!text || text.trim() === '') && (!m.tool_calls || m.tool_calls.length === 0)) {
        m.content = '[content deleted]';
        fixed++;
      }
    }

    if (removed > 0 || fixed > 0) {
      this.saveSession(sessionId);
    }
    return removed + fixed;
  }

  /**
   * Compact with AI summary using multi-stage summarization for large conversations.
   * Tracks tool failures and file operations for better context preservation.
   * Returns a status string for user feedback.
   * @param isAutoCompaction If true, adds a continuation prompt after compaction
   */
  async compactWithSummary(sessionId: string, llm?: LLMClient, instructions?: string, isAutoCompaction?: boolean): Promise<string> {
    // Prevent concurrent compactions on the same session
    if (this.compactingSessions.has(sessionId)) {
      return 'Compaction already in progress for this session.';
    }

    this.compactingSessions.add(sessionId);
    try {
      return await this._doCompactWithSummary(sessionId, llm, instructions, isAutoCompaction);
    } finally {
      this.compactingSessions.delete(sessionId);
    }
  }

  /** Internal implementation of compactWithSummary */
  private async _doCompactWithSummary(sessionId: string, llm?: LLMClient, instructions?: string, isAutoCompaction?: boolean): Promise<string> {
    const client = llm || this.llm;
    const session = this.sessions.get(sessionId);
    if (!session) return 'No active session.';
    if (!client) {
      // No LLM available — emergency truncation: keep only last 4 non-system messages
      this.emergencyTruncate(session);
      this.saveSession(sessionId);
      return 'Compacted (no LLM available for summary — emergency truncation applied).';
    }

    const beforeCount = session.messages.length;
    const beforeTokens = this.estimateTokensForMessages(session.messages);

    // Fire pre-compaction flush hook (saves to daily log)
    if (this.onBeforeCompact) {
      const msgs = [...session.messages];
      await this.onBeforeCompact(sessionId, msgs).catch(() => {});
    }

    // Index transcript before compaction so it's searchable
    await this.indexSessionTranscript(sessionId).catch(() => {});

    // Extract tool failures and file operations for context
    const toolFailures = this.extractToolFailures(session.messages);
    const fileOps = this.extractFileOperations(session.messages);

    // Build conversation text for summarization (skip system messages)
    const nonSystem = session.messages.filter(m => m.role !== 'system');
    
    // Determine if we need multi-stage summarization
    const contextTokens = this.config.sessions.contextLimit;
    const conversationTokens = this.estimateTokensForMessages(nonSystem);
    const needsMultiStage = conversationTokens > contextTokens * 0.4; // >40% of context

    let summary = '';
    try {
      if (needsMultiStage) {
        summary = await this.multiStageSummarize(client, nonSystem, instructions, contextTokens);
      } else {
        summary = await this.singleStageSummarize(client, nonSystem, instructions);
      }
    } catch (err) {
      console.error(`[session] Summary generation failed: ${err}`);
      this.emergencyTruncate(session);
      this.saveSession(sessionId);
      return `Summary generation failed, applied emergency truncation.`;
    }

    if (!summary || summary.length < 20) {
      this.emergencyTruncate(session);
      this.saveSession(sessionId);
      return `Summary was too short, applied emergency truncation.`;
    }

    // Append tool failures and file operations to summary
    if (toolFailures.length > 0) {
      summary += '\n\n## Tool Failures\n' + toolFailures.slice(0, 10).map(f => 
        `- ${f.tool}: ${f.error.slice(0, 200)}`
      ).join('\n');
    }
    if (fileOps.read.length > 0 || fileOps.modified.length > 0) {
      summary += '\n\n## File Operations\n';
      if (fileOps.read.length > 0) {
        summary += `<read-files>${[...new Set(fileOps.read)].slice(0, 20).join(', ')}</read-files>\n`;
      }
      if (fileOps.modified.length > 0) {
        summary += `<modified-files>${[...new Set(fileOps.modified)].slice(0, 20).join(', ')}</modified-files>\n`;
      }
    }

    // Keep only system messages with actual content, delete everything else, insert summary
    const systemMsgs = session.messages.filter(m => m.role === 'system' && getTextFromContent(m.content).trim().length > 0);
    session.messages = [
      ...systemMsgs,
      {
        role: 'system',
        content: `[Conversation Summary — ${beforeCount} messages compacted at ${new Date().toISOString()}]\n\n${summary}`,
      },
    ];

    // For auto-compaction, notify callback to trigger continuation processing
    // The callback (agent) will add the message via processMessage
    if (isAutoCompaction && this.onAutoCompactContinuation) {
      const continuationMessage = 'Continue the task u were doing';
      // Use setImmediate to ensure the current call stack completes first
      setImmediate(() => {
        try {
          this.onAutoCompactContinuation!(sessionId, continuationMessage);
        } catch (err) {
          console.error(`[session] Auto-compact continuation callback failed:`, err);
        }
      });
    }

    session.updatedAt = new Date().toISOString();
    this.sessionTokens.delete(sessionId); // clear stale API token data after compaction
    this.saveSession(sessionId);

    const afterTokens = this.estimateTokensForMessages(session.messages);
    return `Compacted with AI summary: ${beforeCount} → ${session.messages.length} messages (~${beforeTokens} → ~${afterTokens} tokens).`;
  }

  /**
   * Single-stage summarization for smaller conversations.
   */
  private async singleStageSummarize(
    client: LLMClient,
    messages: LLMMessage[],
    instructions?: string,
  ): Promise<string> {
    // Only include user and assistant messages, skip tool results (they're verbose)
    const conversationText = messages
      .filter(m => m.content && (m.role === 'user' || m.role === 'assistant'))
      .map(m => {
        const role = m.role === 'assistant' ? 'A' : 'U';
        return `[${role}] ${(m.content || '').slice(0, 200)}`;
      })
      .join('\n');

    const summaryPrompt: LLMMessage[] = [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Summarize this conversation in UNDER 2000 WORDS:\n\n${conversationText}${instructions ? `\n\nFocus on: ${instructions}` : ''}`,
      },
    ];

    const response = await client.chat(summaryPrompt);
    const content = response.choices[0]?.message?.content;
    return getTextFromContent(content).trim() || '';
  }

  /**
   * Multi-stage summarization for large conversations.
   * Splits into chunks, summarizes each, then merges.
   */
  private async multiStageSummarize(
    client: LLMClient,
    messages: LLMMessage[],
    instructions?: string,
    contextTokens: number = 120000,
  ): Promise<string> {
    // Split messages into 2-3 parts by token count
    const parts = this.splitMessagesByTokens(messages, contextTokens * 0.3);

    if (parts.length <= 1) {
      return this.singleStageSummarize(client, messages, instructions);
    }

    console.log(`[session] Multi-stage summarization: ${parts.length} parts`);

    // Summarize each part - only user/assistant, skip tool results
    const partialSummaries: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const partText = part
        .filter(m => m.content && (m.role === 'user' || m.role === 'assistant'))
        .map(m => {
          const role = m.role === 'assistant' ? 'A' : 'U';
          return `[${role}] ${(m.content || '').slice(0, 150)}`;
        })
        .join('\n');

      const prompt: LLMMessage[] = [
        {
          role: 'system',
          content: `Summarize part ${i + 1}/${parts.length} in MAX 500 words. Only include: current task, key decisions, next steps. Be terse.`,
        },
        { role: 'user', content: partText },
      ];

      try {
        const response = await client.chat(prompt);
        const content = response.choices[0]?.message?.content;
        const partSummary = getTextFromContent(content).trim();
        if (partSummary) {
          partialSummaries.push(partSummary);
        }
      } catch (err) {
        console.warn(`[session] Failed to summarize part ${i + 1}: ${err}`);
      }
    }

    if (partialSummaries.length === 0) {
      throw new Error('All partial summaries failed');
    }

    // Merge summaries - keep it concise
    const mergePrompt: LLMMessage[] = [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Merge into ONE summary under 2000 words. Remove duplicates, keep only current/active items:\n\n${partialSummaries.join('\n---\n')}${instructions ? `\n\nFocus: ${instructions}` : ''}`,
      },
    ];

    const mergeResponse = await client.chat(mergePrompt);
    const mergeContent = mergeResponse.choices[0]?.message?.content;
    return getTextFromContent(mergeContent).trim() || partialSummaries.join('\n');
  }

  /**
   * Split messages into parts by approximate token count.
   */
  private splitMessagesByTokens(messages: LLMMessage[], maxTokensPerPart: number): LLMMessage[][] {
    const parts: LLMMessage[][] = [];
    let currentPart: LLMMessage[] = [];
    let currentTokens = 0;

    for (const m of messages) {
      const msgTokens = this.estimateTokensForMessages([m]);
      
      if (currentTokens + msgTokens > maxTokensPerPart && currentPart.length > 0) {
        parts.push(currentPart);
        currentPart = [];
        currentTokens = 0;
      }
      
      currentPart.push(m);
      currentTokens += msgTokens;
    }

    if (currentPart.length > 0) {
      parts.push(currentPart);
    }

    return parts;
  }

  /**
   * Extract tool failures from messages for inclusion in summary.
   */
  private extractToolFailures(messages: LLMMessage[]): { tool: string; error: string }[] {
    const failures: { tool: string; error: string }[] = [];

    for (const m of messages) {
      if (m.role === 'tool' && m.content) {
        const text = getTextFromContent(m.content);
        const content = text.toLowerCase();
        // Look for common error patterns
        if (content.includes('error') || content.includes('failed') ||
            content.includes('exception') || content.includes('not found')) {
          failures.push({
            tool: (m as any).name || 'unknown',
            error: text.slice(0, 300),
          });
        }
      }
    }

    return failures;
  }

  /**
   * Extract file read/write operations from messages.
   */
  private extractFileOperations(messages: LLMMessage[]): { read: string[]; modified: string[] } {
    const read: string[] = [];
    const modified: string[] = [];

    for (const m of messages) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name || '';
          const args = tc.function?.arguments || '';
          
          try {
            const parsed = JSON.parse(args);
            const path = parsed.path || parsed.file || parsed.filePath || '';
            
            if (path && typeof path === 'string') {
              if (name === 'read_file' || name === 'list_directory' || name === 'search_files') {
                read.push(path);
              } else if (name === 'write_file' || name === 'edit_file' || name === 'hashline_edit') {
                modified.push(path);
              } else if (name === 'shell' || name === 'execute_command') {
                // Try to extract files from shell commands
                const cmd = parsed.command || '';
                if (cmd.includes('cat ') || cmd.includes('less ') || cmd.includes('head ') || cmd.includes('tail ')) {
                  const match = cmd.match(/(?:cat|less|head|tail)\s+([^\s|>]+)/);
                  if (match) read.push(match[1]);
                }
                if (cmd.includes(' > ') || cmd.includes('>>') || cmd.includes('tee ')) {
                  const match = cmd.match(/(?:>|>>|tee)\s*([^\s]+)/);
                  if (match) modified.push(match[1]);
                }
              }
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }

    return { read, modified };
  }

  /** Estimate tokens for an arbitrary array of messages (content only, no overhead).
   *  Uses a conservative 3.2 chars/token ratio (more accurate than 4 chars/token). */
  private estimateTokensForMessages(messages: LLMMessage[]): number {
    let chars = 0;
    for (const m of messages) {
      if (m.content) chars += m.content.length;
      if (m.tool_calls) {
        // Tool calls have significant overhead in API format
        chars += JSON.stringify(m.tool_calls).length;
        // Add extra for tool call metadata (function framing, etc.)
        chars += m.tool_calls.length * 50;
      }
      // Per-message overhead: role, name, tool_call_id framing ≈ 8 tokens each
      chars += 32;
    }
    // Use 3.2 chars per token (more conservative than 4, accounts for special tokens)
    return Math.ceil(chars / 3.2);
  }

  /** Get token count for a session.
   *  Uses actual API-reported prompt_tokens when available.
   *  Falls back to character-based estimate + overhead when no API data exists. */
  estimateTokens(sessionId: string): number {
    const snapshot = this.sessionTokens.get(sessionId);
    if (snapshot && snapshot.prompt > 0) {
      // Use actual API-reported prompt_tokens directly
      // This is the most accurate value - it's what the API actually counted
      return snapshot.prompt;
    }
    // Fallback: character-based estimate + overhead (only for sessions without API calls yet)
    const messages = this.getMessages(sessionId);
    const msgTokens = this.estimateTokensForMessages(messages);
    const overhead = this.overheadEstimator ? this.overheadEstimator(sessionId) : 0;
    return msgTokens + overhead;
  }

  getMessages(sessionId: string): LLMMessage[] {
    return this.sessions.get(sessionId)?.messages || [];
  }

  /**
   * Get messages with context pruning applied for LLM calls.
   * Returns a copy with large/old tool results trimmed or cleared.
   */
  getMessagesForLLM(sessionId: string): { messages: LLMMessage[]; pruned: boolean; stats: PruneStats } {
    const messages = this.getMessages(sessionId);
    const contextLimit = this.config.sessions.contextLimit;
    
    // Get pruning settings from config or use defaults
    const pruningConfig = (this.config.sessions as any).pruning || {};
    const settings: PruningSettings = {
      ...DEFAULT_PRUNING_SETTINGS,
      ...pruningConfig,
      softTrim: { ...DEFAULT_PRUNING_SETTINGS.softTrim, ...(pruningConfig.softTrim || {}) },
      hardClear: { ...DEFAULT_PRUNING_SETTINGS.hardClear, ...(pruningConfig.hardClear || {}) },
    };

    return pruneContextMessages(messages, contextLimit, settings);
  }

  /**
   * Delete a message at the given index and all following messages until (but not including)
   * the next assistant message. Used for deleting a user message and its response.
   * Returns the deleted messages.
   */
  deleteMessageAt(sessionId: string, index: number): LLMMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session || index < 0 || index >= session.messages.length) return [];

    const messages = session.messages;
    const targetMsg = messages[index];
    
    // Find where to stop deleting:
    // - If deleting a user message, delete until (but not including) the next user message or end
    // - If deleting an assistant message, just delete that message and any tool messages following it
    let endIndex = index + 1;
    
    if (targetMsg.role === 'user') {
      // Delete user message + following assistant/tool messages until next user message
      while (endIndex < messages.length) {
        const nextMsg = messages[endIndex];
        if (nextMsg.role === 'user') break;
        endIndex++;
      }
    } else if (targetMsg.role === 'assistant') {
      // Delete assistant message + following tool result messages
      while (endIndex < messages.length) {
        const nextMsg = messages[endIndex];
        if (nextMsg.role !== 'tool') break;
        endIndex++;
      }
    }
    
    const deleted = messages.splice(index, endIndex - index);
    session.messageCount = messages.length;
    session.updatedAt = new Date().toISOString();
    this.saveSession(sessionId);
    
    return deleted;
  }

  /**
   * Edit the content of a message at the given index.
   */
  editMessageAt(sessionId: string, index: number, newContent: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || index < 0 || index >= session.messages.length) return false;

    session.messages[index].content = newContent;
    session.updatedAt = new Date().toISOString();
    this.saveSession(sessionId);
    return true;
  }

  /**
   * Get messages up to (but not including) the given index.
   * Used for retry: get context before a message to regenerate it.
   */
  getMessagesUpTo(sessionId: string, index: number): LLMMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session || index < 0) return [];
    return session.messages.slice(0, index);
  }

  /**
   * Replace messages starting at index with new messages.
   * Used for retry: replace old response with new one.
   */
  replaceMessagesAt(sessionId: string, startIndex: number, endIndex: number, newMessages: LLMMessage[]): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || startIndex < 0 || startIndex > session.messages.length) return false;

    // Remove messages from startIndex to endIndex, insert new ones
    session.messages.splice(startIndex, endIndex - startIndex, ...newMessages);
    session.messageCount = session.messages.length;
    session.updatedAt = new Date().toISOString();
    this.saveSession(sessionId);
    return true;
  }

  saveAll(): void {
    for (const [id] of this.sessions) {
      if (!id) continue; // skip any corrupted entries with undefined id
      this.saveSession(id);
    }
    // Final transcript index flush
    if (this.transcriptIndexTimer) {
      clearTimeout(this.transcriptIndexTimer);
      this.indexQueuedTranscripts();
    }
  }

  /** Shutdown cleanup */
  shutdown(): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    if (this.transcriptIndexTimer) clearTimeout(this.transcriptIndexTimer);
    // Flush any pending transcript indexing before saving
    this.flushTranscriptQueue();
    this.saveAll();
  }

  /** Immediately save all queued transcripts (called on shutdown) */
  private flushTranscriptQueue(): void {
    if (this.transcriptIndexQueue.size === 0 || !this.memoryManager) return;

    for (const sessionId of this.transcriptIndexQueue) {
      try {
        const session = this.sessions.get(sessionId);
        if (!session || session.messages.length < 3) continue;

        const transcript = session.messages
          .filter(m => m.role !== 'system' && m.content)
          .map(m => {
            const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : 'Tool';
            return `[${role}] ${m.content}`;
          })
          .join('\n\n');

        if (transcript.length >= 100) {
          this.memoryManager.saveTranscript(sessionId, transcript);
        }
      } catch (err) {
        console.error(`[session] Failed to flush transcript for ${sessionId}:`, err);
      }
    }
    this.transcriptIndexQueue.clear();
  }
}
