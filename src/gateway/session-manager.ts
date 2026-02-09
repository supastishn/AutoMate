import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Config } from '../config/schema.js';
import type { LLMMessage } from '../agent/llm-client.js';

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

  constructor(config: Config) {
    this.config = config;
    this.dir = config.sessions.directory;
    this.loadAll();
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

  addMessage(sessionId: string, message: LLMMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.push(message);
    session.messageCount++;
    session.updatedAt = new Date().toISOString();

    // Auto-compact if over threshold
    if (session.messages.length > this.config.sessions.maxHistory) {
      // Fire pre-compaction flush (async, don't block)
      if (this.onBeforeCompact) {
        const msgs = [...session.messages];
        this.onBeforeCompact(sessionId, msgs).catch(() => {});
      }
      this.compact(sessionId);
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

  compact(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.messages.length < 10) return;

    // Keep system messages + last N messages
    const keepCount = Math.floor(this.config.sessions.maxHistory / 2);
    const systemMsgs = session.messages.filter(m => m.role === 'system');
    const recentMsgs = session.messages.filter(m => m.role !== 'system').slice(-keepCount);
    
    // Add a summary marker
    const compactedCount = session.messages.length - systemMsgs.length - recentMsgs.length;
    if (compactedCount > 0) {
      recentMsgs.unshift({
        role: 'system',
        content: `[Context compacted: ${compactedCount} earlier messages were removed to save context space]`,
      });
    }
    
    session.messages = [...systemMsgs, ...recentMsgs];
    session.updatedAt = new Date().toISOString();
  }

  /** Compact with custom instructions about what to keep */
  compactWithInstructions(sessionId: string, instructions: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return 'No active session.';
    if (session.messages.length < 5) return 'Session too short to compact.';

    const beforeCount = session.messages.length;
    const systemMsgs = session.messages.filter(m => m.role === 'system');
    const keepCount = Math.floor(this.config.sessions.maxHistory / 3); // keep fewer when manual
    const recentMsgs = session.messages.filter(m => m.role !== 'system').slice(-keepCount);
    const compactedCount = session.messages.length - systemMsgs.length - recentMsgs.length;

    if (compactedCount > 0) {
      recentMsgs.unshift({
        role: 'system',
        content: `[Context compacted: ${compactedCount} earlier messages removed. User instructions: ${instructions}]`,
      });
    }

    session.messages = [...systemMsgs, ...recentMsgs];
    session.updatedAt = new Date().toISOString();
    this.saveSession(sessionId);

    return `Compacted: ${beforeCount} → ${session.messages.length} messages (removed ${compactedCount}). Instructions noted: "${instructions}"`;
  }

  /** Get approximate token count of all messages in a session */
  estimateTokens(sessionId: string): number {
    const messages = this.getMessages(sessionId);
    // Rough estimate: 1 token ≈ 4 chars
    let chars = 0;
    for (const m of messages) {
      if (m.content) chars += m.content.length;
      if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    }
    return Math.ceil(chars / 4);
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
