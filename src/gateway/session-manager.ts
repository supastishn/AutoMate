import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Config } from '../config/schema.js';
import type { LLMMessage } from '../agent/llm-client.js';
import type { LLMClient } from '../agent/llm-client.js';
import type { MemoryManager } from '../memory/manager.js';
import { pruneContextMessages, type PruningSettings, type PruneStats, DEFAULT_PRUNING_SETTINGS } from './context-pruner.js';

/** System prompt for conversation summarization */
const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer creating a detailed context document. This summary will REPLACE the entire conversation history, so you must preserve all information needed to continue seamlessly.

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

Be thorough and detailed. Include specific names, paths, and technical details. The assistant reading this summary should be able to continue the conversation as if they had full context.`;

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
  private defaultCompactInstructions: string | null = null; // default instructions for all compactions
  private overheadEstimator: ((sessionId: string) => number) | null = null; // callback to get system prompt + tool defs overhead

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

  /** Set default instructions injected into every compaction (manual and auto) */
  setDefaultCompactInstructions(instructions: string): void {
    this.defaultCompactInstructions = instructions;
  }

  /** Set a callback that returns the estimated token overhead (system prompt + tool defs) for a session.
   *  This is added to message-content estimates so context % and auto-compact reflect true usage. */
  setOverheadEstimator(fn: (sessionId: string) => number): void {
    this.overheadEstimator = fn;
  }

  addMessage(sessionId: string, message: LLMMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.push(message);
    session.messageCount++;
    session.updatedAt = new Date().toISOString();

    // Queue session for transcript indexing (debounced)
    this.queueTranscriptIndex(sessionId);

    // Auto-compact if estimated tokens exceed threshold (contextLimit - reserveTokens)
    const tokenLimit = this.config.sessions.contextLimit;
    const reserveTokens = (this.config.sessions as any).reserveTokens || 20000;
    const compactAtRatio = this.config.sessions.compactAt;
    const threshold = Math.floor((tokenLimit - reserveTokens) * compactAtRatio);
    const currentTokens = this.estimateTokensWithOverhead(sessionId, session.messages);
    if (currentTokens > threshold && !this.compactingSessions.has(sessionId)) {
      this.compactingSessions.add(sessionId);
      this.compactWithSummary(sessionId, this.llm || undefined, this.defaultCompactInstructions || undefined)
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
   * Compact with AI summary using multi-stage summarization for large conversations.
   * Tracks tool failures and file operations for better context preservation.
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

  /**
   * Single-stage summarization for smaller conversations.
   */
  private async singleStageSummarize(
    client: LLMClient,
    messages: LLMMessage[],
    instructions?: string,
  ): Promise<string> {
    const conversationText = messages
      .filter(m => m.content)
      .map(m => {
        const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : 'Tool';
        return `[${role}] ${(m.content || '').slice(0, 500)}`;
      })
      .join('\n');

    const summaryPrompt: LLMMessage[] = [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Create a detailed summary of this conversation:\n\n${conversationText}${instructions ? `\n\nAdditional context: ${instructions}` : ''}`,
      },
    ];

    const response = await client.chat(summaryPrompt);
    return response.choices[0]?.message?.content?.trim() || '';
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

    // Summarize each part
    const partialSummaries: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const partText = part
        .filter(m => m.content)
        .map(m => {
          const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : 'Tool';
          return `[${role}] ${(m.content || '').slice(0, 300)}`;
        })
        .join('\n');

      const prompt: LLMMessage[] = [
        {
          role: 'system',
          content: `You are summarizing part ${i + 1} of ${parts.length} of a conversation. Create a detailed summary preserving all important context, decisions, and technical details. This partial summary will be merged with others.`,
        },
        { role: 'user', content: partText },
      ];

      try {
        const response = await client.chat(prompt);
        const partSummary = response.choices[0]?.message?.content?.trim() || '';
        if (partSummary) {
          partialSummaries.push(`### Part ${i + 1}\n${partSummary}`);
        }
      } catch (err) {
        console.warn(`[session] Failed to summarize part ${i + 1}: ${err}`);
        // Continue with other parts
      }
    }

    if (partialSummaries.length === 0) {
      throw new Error('All partial summaries failed');
    }

    // Merge summaries into cohesive whole
    const mergePrompt: LLMMessage[] = [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Merge these partial summaries into a single cohesive summary. Preserve all decisions, TODOs, open questions, and technical details:\n\n${partialSummaries.join('\n\n')}${instructions ? `\n\nAdditional context: ${instructions}` : ''}`,
      },
    ];

    const mergeResponse = await client.chat(mergePrompt);
    return mergeResponse.choices[0]?.message?.content?.trim() || partialSummaries.join('\n\n');
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
        const content = m.content.toLowerCase();
        // Look for common error patterns
        if (content.includes('error') || content.includes('failed') || 
            content.includes('exception') || content.includes('not found')) {
          failures.push({
            tool: (m as any).name || 'unknown',
            error: m.content.slice(0, 300),
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

  /** Estimate tokens for an arbitrary array of messages (content only, no overhead) */
  private estimateTokensForMessages(messages: LLMMessage[]): number {
    let chars = 0;
    for (const m of messages) {
      if (m.content) chars += m.content.length;
      if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
      // Per-message overhead: role, name, tool_call_id framing ≈ 4 tokens each
      chars += 16;
    }
    return Math.ceil(chars / 4);
  }

  /** Estimate tokens for a session's messages INCLUDING system prompt + tool defs overhead */
  private estimateTokensWithOverhead(sessionId: string, messages: LLMMessage[]): number {
    const msgTokens = this.estimateTokensForMessages(messages);
    const overhead = this.overheadEstimator ? this.overheadEstimator(sessionId) : 0;
    return msgTokens + overhead;
  }

  /** Get approximate token count for a session (includes system prompt + tool definition overhead) */
  estimateTokens(sessionId: string): number {
    const messages = this.getMessages(sessionId);
    return this.estimateTokensWithOverhead(sessionId, messages);
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