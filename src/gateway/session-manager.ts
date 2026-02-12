import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Config } from '../config/schema.js';
import type { LLMMessage } from '../agent/llm-client.js';
import type { LLMClient } from '../agent/llm-client.js';
import type { MemoryManager } from '../memory/manager.js';

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
  private writeLocks: Map<string, Promise<void>> = new Map(); // prevent concurrent writes
  private memoryManager: MemoryManager | null = null; // for transcript indexing
  private transcriptIndexQueue: Set<string> = new Set(); // sessions pending index
  private transcriptIndexTimer: NodeJS.Timeout | null = null;

  constructor(config: Config) {
    this.config = config;
    this.dir = config.sessions.directory;
    mkdirSync(this.dir, { recursive: true });
    this.mainSessionFile = join(this.dir, '.main-session');
    this.loadAll();
    this.loadMainSession();
    this.startAutoReset();
  }

  /** Set memory manager for transcript indexing */
  setMemoryManager(mm: MemoryManager): void {
    this.memoryManager = mm;
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

    // Sanitize tool pairs
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

  /** Set the LLM client for summary-based compaction */
  setLLMClient(llm: LLMClient): void {
    this.llm = llm;
  }

  addMessage(sessionId: string, message: LLMMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.push(message);
    session.messageCount++;
    session.updatedAt = new Date().toISOString();

    // Queue session for transcript indexing (debounced)
    this.queueTranscriptIndex(sessionId);

    // Auto-compact if estimated tokens exceed compactAt threshold
    const tokenLimit = this.config.sessions.contextLimit;
    const threshold = Math.floor(tokenLimit * this.config.sessions.compactAt);
    const currentTokens = this.estimateTokensForMessages(session.messages);
    if (currentTokens > threshold && !this.compactingSessions.has(sessionId)) {
      this.compactingSessions.add(sessionId);
      this.compactWithSummary(sessionId, this.llm || undefined)
        .catch(err => console.error(`[session] Auto-compact failed for ${sessionId}:`, err))
        .finally(() => this.compactingSessions.delete(sessionId));
    }
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

    // Save to transcripts directory for indexing
    const transcriptsDir = join(this.memoryManager.getDirectory(), 'transcripts');
    mkdirSync(transcriptsDir, { recursive: true });

    const safeName = sessionId.replace(/[:/\\?*"<>|]/g, '_');
    const filename = `transcript-${safeName}.md`;
    const filepath = join(transcriptsDir, filename);

    const content = `# Session Transcript: ${sessionId}\n\nLast updated: ${session.updatedAt}\n\n${transcript}`;
    writeFileSync(filepath, content);

    // Queue for vector indexing (the memory manager will pick it up)
    // Note: This relies on memory manager's indexAll() or watching
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
    this.saveSession(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
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
   * - Remove any `tool` role message whose `tool_call_id` doesn't match
   *   a `tool_calls[].id` in a preceding `assistant` message.
   * - Remove any `assistant` message with `tool_calls` that has NO
   *   corresponding `tool` result following it.
   */
  private sanitizeToolPairs(session: Session): void {
    const messages = session.messages;

    // Pass 1: collect all tool_call IDs from assistant messages
    const assistantToolCallIds = new Set<string>();
    for (const m of messages) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) {
          assistantToolCallIds.add(tc.id);
        }
      }
    }

    // Pass 2: collect all tool_call_ids from tool result messages
    const toolResultIds = new Set<string>();
    for (const m of messages) {
      if (m.role === 'tool' && m.tool_call_id) {
        toolResultIds.add(m.tool_call_id);
      }
    }

    // Filter: remove orphaned tool results and orphaned assistant tool_calls
    session.messages = messages.filter(m => {
      // Remove tool results with no matching assistant tool_call
      if (m.role === 'tool' && m.tool_call_id) {
        if (!assistantToolCallIds.has(m.tool_call_id)) return false;
      }
      // Remove assistant messages with tool_calls but no matching tool results
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const hasAnyResult = m.tool_calls.some(tc => toolResultIds.has(tc.id));
        if (!hasAnyResult) return false;
      }
      return true;
    });
  }

  /**
   * Repair broken tool pairs in a session (public method for manual repair).
   * Returns number of messages removed.
   */
  repairToolPairs(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;
    const before = session.messages.length;
    this.sanitizeToolPairs(session);
    const removed = before - session.messages.length;
    if (removed > 0) {
      this.saveSession(sessionId);
    }
    return removed;
  }

  /**
   * Compact with AI summary: call the LLM to summarize the entire conversation,
   * then delete ALL non-system messages and insert the summary as a system message.
   * Returns a status string for user feedback.
   */
  async compactWithSummary(sessionId: string, llm?: LLMClient, instructions?: string): Promise<string> {
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

    // Build conversation text for summarization (skip system messages)
    const nonSystem = session.messages.filter(m => m.role !== 'system');
    const conversationText = nonSystem
      .filter(m => m.content)
      .map(m => {
        const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : 'Tool';
        return `[${role}] ${(m.content || '').slice(0, 500)}`;
      })
      .join('\n');

    // Generate summary via LLM
    let summary = '';
    try {
      const summaryPrompt: LLMMessage[] = [
        {
          role: 'system',
          content: `You are a conversation summarizer creating a detailed context document. This summary will REPLACE the entire conversation history, so you must preserve all information needed to continue seamlessly.

Create a comprehensive summary with these sections:

## Session Overview
Brief description of what the user is working on and the current status.

## Key Context & Facts
- Important technical details, file paths, variable names, configurations
- Domain-specific information established during the conversation
- Any constraints, requirements, or specifications mentioned

## Decisions Made
- Choices the user made and their reasoning
- Approaches selected or rejected
- Trade-offs discussed

## Current Task State
- What was being worked on when this summary was created
- Any in-progress work or pending items
- Next steps that were planned or discussed

## User Preferences & Instructions
- Communication style preferences
- Workflow preferences
- Standing instructions or recurring requests
- Things the user asked to remember

## Important Code/Data
If any specific code snippets, commands, or data structures were central to the conversation, include them verbatim.

Be thorough and detailed. Include specific names, paths, and technical details. The assistant reading this summary should be able to continue the conversation as if they had full context.`,
        },
        {
          role: 'user',
          content: `Create a detailed summary of this conversation:\n\n${conversationText}${instructions ? `\n\nAdditional context: ${instructions}` : ''}`,
        },
      ];

      const response = await client.chat(summaryPrompt);
      summary = response.choices[0]?.message?.content?.trim() || '';
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

    // Keep only system messages, delete everything else, insert summary
    const systemMsgs = session.messages.filter(m => m.role === 'system');
    session.messages = [
      ...systemMsgs,
      {
        role: 'system',
        content: `[Conversation Summary — ${beforeCount} messages compacted at ${new Date().toISOString()}]\n\n${summary}`,
      },
    ];
    session.updatedAt = new Date().toISOString();
    this.saveSession(sessionId);

    const afterTokens = this.estimateTokensForMessages(session.messages);
    return `Compacted with AI summary: ${beforeCount} → ${session.messages.length} messages (~${beforeTokens} → ~${afterTokens} tokens).`;
  }

  /** Estimate tokens for an arbitrary array of messages */
  private estimateTokensForMessages(messages: LLMMessage[]): number {
    let chars = 0;
    for (const m of messages) {
      if (m.content) chars += m.content.length;
      if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    }
    return Math.ceil(chars / 4);
  }

  /** Get approximate token count of all messages in a session */
  estimateTokens(sessionId: string): number {
    const messages = this.getMessages(sessionId);
    return this.estimateTokensForMessages(messages);
  }

  getMessages(sessionId: string): LLMMessage[] {
    return this.sessions.get(sessionId)?.messages || [];
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
    this.saveAll();
  }
}