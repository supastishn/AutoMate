import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Config } from '../config/schema.js';
import type { LLMMessage } from '../agent/llm-client.js';
import type { LLMClient } from '../agent/llm-client.js';

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

  constructor(config: Config) {
    this.config = config;
    this.dir = config.sessions.directory;
    this.mainSessionFile = join(this.dir, '.main-session');
    this.loadAll();
    this.loadMainSession();
    this.startAutoReset();
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
    return join(this.dir, `${id}.json`);
  }

  private loadAll(): void {
    if (!existsSync(this.dir)) return;
    const files = readdirSync(this.dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(this.dir, file), 'utf-8'));
        this.sessions.set(data.id, data);
      } catch {
        // skip corrupt session files
      }
    }
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

  saveSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    writeFileSync(this.sessionPath(sessionId), JSON.stringify(session));
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
   * Compact with AI summary: call the LLM to summarize the entire conversation,
   * then delete ALL non-system messages and insert the summary as a system message.
   * Returns a status string for user feedback.
   */
  async compactWithSummary(sessionId: string, llm?: LLMClient, instructions?: string): Promise<string> {
    const client = llm || this.llm;
    const session = this.sessions.get(sessionId);
    if (!session) return 'No active session.';
    if (session.messages.length < 5) return 'Session too short to compact.';
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
          content: 'You are a conversation summarizer. Produce a concise, structured summary of the conversation below. Focus on:\n- Key decisions and outcomes\n- Important context and facts established\n- Current state of any ongoing tasks\n- User preferences or instructions learned\n\nBe thorough but concise. Use bullet points. This summary will replace the entire conversation history, so include everything needed to continue the conversation seamlessly.',
        },
        {
          role: 'user',
          content: `Summarize this conversation:\n\n${conversationText.slice(0, 16000)}${instructions ? `\n\nAdditional instructions: ${instructions}` : ''}`,
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

  saveAll(): void {
    for (const [id] of this.sessions) {
      this.saveSession(id);
    }
  }
}
