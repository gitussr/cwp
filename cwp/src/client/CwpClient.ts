import net from "node:net";
import { MessageType } from "../protocol/constants.ts";
import { type DecodedFrame, encodeFrame } from "../protocol/frame.ts";
import { FrameDecoder } from "../protocol/framer.ts";

export interface CwpClientOptions {
  host: string;
  port: number;
  /** How long to wait for a response before a request/ping/handshake rejects. Default 5000ms. */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (body: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A CWP/1 client: manages one TCP connection, the handshake/session
 * lifecycle, and request/response correlation so callers get a plain
 * Promise-based API instead of raw `data` events.
 */
export class CwpClient {
  readonly #options: CwpClientOptions;
  #socket = new net.Socket();
  #decoder = new FrameDecoder();
  #requestTimeoutMs: number;

  #sessionId: string | null = null;
  #seq = 0;

  #pendingRequests = new Map<string, PendingRequest>();
  #handshakeWaiters: Waiter<string>[] = [];
  #pingWaiters: Waiter<void>[] = [];

  constructor(options: CwpClientOptions) {
    this.#options = options;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5000;

    this.#socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    this.#socket.on("error", (err) => this.#failEverything(err));
    this.#socket.on("close", () => this.#failEverything(new Error("Connection closed")));
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.#socket.once("error", onError);
      this.#socket.connect(this.#options.port, this.#options.host, () => {
        this.#socket.removeListener("error", onError);
        resolve();
      });
    });
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** Opens a session. Must be called (and awaited) before sendCommand(). */
  handshake(): Promise<string> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter<string> = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#removeWaiter(this.#handshakeWaiters, waiter);
          reject(new Error("Handshake timed out"));
        }, this.#requestTimeoutMs),
      };
      waiter.timer.unref();
      this.#handshakeWaiters.push(waiter);
      this.#socket.write(encodeFrame(MessageType.HSK, {}, ""));
    });
  }

  /** Sends a transport-level liveness check, independent of any session. */
  ping(): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter<void> = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#removeWaiter(this.#pingWaiters, waiter);
          reject(new Error("PING timed out"));
        }, this.#requestTimeoutMs),
      };
      waiter.timer.unref();
      this.#pingWaiters.push(waiter);
      this.#socket.write(encodeFrame(MessageType.PING, {}, ""));
    });
  }

  /** Invokes a command on the server within the current session. */
  sendCommand(command: string, payload = ""): Promise<string> {
    if (!this.#sessionId) {
      return Promise.reject(new Error("Not connected to a session — call handshake() first"));
    }
    const sessionId = this.#sessionId;
    const seq = String(++this.#seq);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(seq);
        reject(new Error(`Request timed out waiting for response to seq=${seq} (command=${command})`));
      }, this.#requestTimeoutMs);
      timer.unref();

      this.#pendingRequests.set(seq, { resolve, reject, timer });
      this.#socket.write(encodeFrame(MessageType.CMD, { session: sessionId, seq, command }, payload));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#socket.end(() => resolve());
    });
  }

  #onData(chunk: Buffer): void {
    let frames: DecodedFrame[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (err) {
      this.#failEverything(err instanceof Error ? err : new Error(String(err)));
      this.#socket.destroy();
      return;
    }
    for (const frame of frames) this.#handleFrame(frame);
  }

  #handleFrame(frame: DecodedFrame): void {
    switch (frame.type) {
      case MessageType.HSK_ACK: {
        const waiter = this.#handshakeWaiters.shift();
        const sessionId = frame.headers.session;
        if (!waiter) return;
        clearTimeout(waiter.timer);
        if (!sessionId) {
          waiter.reject(new Error("HSK_ACK is missing the session header"));
          return;
        }
        this.#sessionId = sessionId;
        waiter.resolve(sessionId);
        return;
      }

      case MessageType.PONG: {
        const waiter = this.#pingWaiters.shift();
        if (!waiter) return;
        clearTimeout(waiter.timer);
        waiter.resolve();
        return;
      }

      case MessageType.RES: {
        const seq = frame.headers.seq;
        const pending = seq ? this.#pendingRequests.get(seq) : undefined;
        if (!pending || !seq) return; // Stray or already-timed-out response; nothing to do.
        clearTimeout(pending.timer);
        this.#pendingRequests.delete(seq);
        pending.resolve(frame.body.toString("utf8"));
        return;
      }

      case MessageType.ERR: {
        const message = `${frame.headers.code ?? "ERROR"}: ${frame.body.toString("utf8")}`;
        const seq = frame.headers.seq;
        const pending = seq ? this.#pendingRequests.get(seq) : undefined;
        if (pending && seq) {
          clearTimeout(pending.timer);
          this.#pendingRequests.delete(seq);
          pending.reject(new Error(message));
          return;
        }
        // No seq means this ERR is about the handshake (or the connection
        // as a whole) rather than a specific command.
        const waiter = this.#handshakeWaiters.shift();
        if (!waiter) return;
        clearTimeout(waiter.timer);
        waiter.reject(new Error(message));
        return;
      }
    }
  }

  #removeWaiter<T>(list: Waiter<T>[], waiter: Waiter<T>): void {
    const idx = list.indexOf(waiter);
    if (idx !== -1) list.splice(idx, 1);
  }

  #failEverything(err: Error): void {
    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pendingRequests.clear();

    for (const waiter of this.#handshakeWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    for (const waiter of this.#pingWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }
}
