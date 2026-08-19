import crypto from "node:crypto";
import { ErrorCode } from "../protocol/constants.ts";
import { ProtocolError } from "../protocol/errors.ts";

export interface Session {
  readonly id: string;
  expectedSeq: number;
  readonly createdAt: number;
  lastSeen: number;
}

export interface SessionStoreOptions {
  /** Idle time after which a session is considered expired. Default 30s. */
  ttlMs?: number;
  /** How often to sweep for expired sessions in the background. Default 5s. */
  sweepIntervalMs?: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_SWEEP_INTERVAL_MS = 5_000;

/**
 * In-memory session table with sequence-number tracking and idle expiry.
 *
 * This is intentionally the same shape as things you'll meet in real
 * distributed systems: a DynamoDB table with a TTL attribute, an
 * ElastiCache/Redis key with an EXPIRE, or a load balancer's sticky-session
 * cookie — a short-lived record keyed by an opaque token, cleaned up by a
 * background sweep so a client that vanishes without saying goodbye can't
 * leak memory forever.
 */
export class SessionStore {
  #sessions = new Map<string, Session>();
  #ttlMs: number;
  #sweepTimer: NodeJS.Timeout;

  constructor(options: SessionStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;

    this.#sweepTimer = setInterval(() => this.#sweepExpired(), sweepIntervalMs);
    // Don't let this background timer alone keep the process (or a test)
    // alive — it should never be the reason `node` refuses to exit.
    this.#sweepTimer.unref();
  }

  create(): Session {
    const id = crypto.randomBytes(16).toString("hex");
    const now = Date.now();
    const session: Session = { id, expectedSeq: 0, createdAt: now, lastSeen: now };
    this.#sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  /**
   * Validates an incoming sequence number against a session and, if valid,
   * advances the session's expected-sequence counter and refreshes its
   * idle timer. Throws `ProtocolError` for an unknown id, an expired
   * session, or a sequence number that isn't exactly "last + 1" (out of
   * order / replayed / skipped).
   */
  touch(id: string, seq: number): Session {
    const session = this.#sessions.get(id);
    if (!session) {
      throw new ProtocolError(ErrorCode.UNKNOWN_SESSION, `No such session: ${id}`);
    }

    if (Date.now() - session.lastSeen > this.#ttlMs) {
      this.#sessions.delete(id);
      throw new ProtocolError(ErrorCode.SESSION_EXPIRED, `Session expired: ${id}`);
    }

    if (!Number.isInteger(seq) || seq !== session.expectedSeq + 1) {
      throw new ProtocolError(
        ErrorCode.BAD_SEQUENCE,
        `Expected seq ${session.expectedSeq + 1} for session ${id}, got ${seq}`,
      );
    }

    session.expectedSeq = seq;
    session.lastSeen = Date.now();
    return session;
  }

  delete(id: string): void {
    this.#sessions.delete(id);
  }

  get size(): number {
    return this.#sessions.size;
  }

  #sweepExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (now - session.lastSeen > this.#ttlMs) {
        this.#sessions.delete(id);
      }
    }
  }

  /** Stops the background sweep. Always call this when done with a store (server shutdown, end of a test) to avoid leaking the timer. */
  close(): void {
    clearInterval(this.#sweepTimer);
  }
}
