/**
 * Presence Manager — tracks agent and user presence/typing state
 * and broadcasts it to connected WebSocket clients.
 */

export type PresenceStatus = 'online' | 'idle' | 'busy' | 'offline';

export interface PresenceState {
  agentId: string;
  status: PresenceStatus;
  typing: boolean;
  lastActivity: number;     // timestamp
  currentSession?: string;  // session being processed
}

export interface PresenceEvent {
  type: 'presence';
  agentId: string;
  status: PresenceStatus;
  typing: boolean;
  timestamp: number;
}

export interface TypingEvent {
  type: 'typing';
  active: boolean;
  sessionId: string;
  agentId?: string;
  timestamp: number;
}

type BroadcastFn = (event: PresenceEvent | TypingEvent) => void;

export class PresenceManager {
  private state: PresenceState;
  private broadcast: BroadcastFn | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimeoutMs: number;

  constructor(agentId: string = 'automate', idleTimeoutMs: number = 300_000) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.state = {
      agentId,
      status: 'online',
      typing: false,
      lastActivity: Date.now(),
    };
  }

  setBroadcaster(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  /** Mark agent as actively processing a session */
  startProcessing(sessionId: string): void {
    this.state.status = 'busy';
    this.state.typing = true;
    this.state.currentSession = sessionId;
    this.state.lastActivity = Date.now();
    this.resetIdleTimer();

    this.emit({
      type: 'typing',
      active: true,
      sessionId,
      agentId: this.state.agentId,
      timestamp: Date.now(),
    });

    this.emit({
      type: 'presence',
      agentId: this.state.agentId,
      status: 'busy',
      typing: true,
      timestamp: Date.now(),
    });

    // Auto-refresh typing indicator every 8 seconds (matches Discord)
    this.clearTypingTimer();
    this.typingTimer = setInterval(() => {
      if (this.state.typing && sessionId) {
        this.emit({
          type: 'typing',
          active: true,
          sessionId,
          agentId: this.state.agentId,
          timestamp: Date.now(),
        });
      }
    }, 8000);
  }

  /** Mark agent as done processing */
  stopProcessing(sessionId: string): void {
    this.state.typing = false;
    this.state.status = 'online';
    this.state.currentSession = undefined;
    this.state.lastActivity = Date.now();
    this.clearTypingTimer();
    this.resetIdleTimer();

    this.emit({
      type: 'typing',
      active: false,
      sessionId,
      agentId: this.state.agentId,
      timestamp: Date.now(),
    });

    this.emit({
      type: 'presence',
      agentId: this.state.agentId,
      status: 'online',
      typing: false,
      timestamp: Date.now(),
    });
  }

  /** Get current state snapshot */
  getState(): PresenceState {
    return { ...this.state };
  }

  /** Manually set status */
  setStatus(status: PresenceStatus): void {
    this.state.status = status;
    this.state.lastActivity = Date.now();

    this.emit({
      type: 'presence',
      agentId: this.state.agentId,
      status,
      typing: this.state.typing,
      timestamp: Date.now(),
    });
  }

  /** Called on any activity to reset idle timer */
  touch(): void {
    this.state.lastActivity = Date.now();
    if (this.state.status === 'idle') {
      this.state.status = 'online';
      this.emit({
        type: 'presence',
        agentId: this.state.agentId,
        status: 'online',
        typing: false,
        timestamp: Date.now(),
      });
    }
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.state.status === 'online') {
        this.state.status = 'idle';
        this.emit({
          type: 'presence',
          agentId: this.state.agentId,
          status: 'idle',
          typing: false,
          timestamp: Date.now(),
        });
      }
    }, this.idleTimeoutMs);
  }

  private clearTypingTimer(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  private emit(event: PresenceEvent | TypingEvent): void {
    if (this.broadcast) {
      this.broadcast(event);
    }
  }

  shutdown(): void {
    this.clearTypingTimer();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.state.status = 'offline';
    this.emit({
      type: 'presence',
      agentId: this.state.agentId,
      status: 'offline',
      typing: false,
      timestamp: Date.now(),
    });
  }
}
