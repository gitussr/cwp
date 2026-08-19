import net, { type Socket } from "node:net";
import { ErrorCode, MessageType } from "../protocol/constants.ts";
import { ProtocolError } from "../protocol/errors.ts";
import { type DecodedFrame, encodeFrame } from "../protocol/frame.ts";
import { FrameDecoder } from "../protocol/framer.ts";
import { type CommandHandler, CommandRouter } from "./router.ts";
import { type Session, SessionStore } from "./SessionStore.ts";

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface CwpServerOptions {
  /** Idle time after which a session expires. Default 30s. */
  sessionTtlMs?: number;
  logger?: Logger;
}

/**
 * A CWP/1 server: accepts TCP connections, frames incoming bytes, runs the
 * handshake/session/sequence protocol, and dispatches CMD frames to
 * registered command handlers.
 */
export class CwpServer {
  #server: net.Server;
  #sessions: SessionStore;
  #router = new CommandRouter();
  #logger: Logger;
  #sockets = new Set<Socket>();

  constructor(options: CwpServerOptions = {}) {
    const sessionOptions = options.sessionTtlMs === undefined ? {} : { ttlMs: options.sessionTtlMs };
    this.#sessions = new SessionStore(sessionOptions);
    this.#logger = options.logger ?? console;

    this.#router.register("HELLO", () => "WELCOME");
    this.#router.register("ECHO", (payload) => payload);
    this.#router.register("TIME", () => new Date().toISOString());

    this.#server = net.createServer((socket) => this.#handleConnection(socket));
    this.#server.on("error", (err) => this.#logger.error("[cwp] server error:", err));
  }

  /** Registers a custom command handler, in addition to the built-ins (HELLO, ECHO, TIME). */
  command(name: string, handler: CommandHandler): this {
    this.#router.register(name, handler);
    return this;
  }

  listen(port: number, host = "0.0.0.0"): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.#server.once("error", onError);
      this.#server.listen(port, host, () => {
        this.#server.removeListener("error", onError);
        resolve();
      });
    });
  }

  get address(): net.AddressInfo | string | null {
    return this.#server.address();
  }

  /** Stops accepting new connections, closes existing ones, and stops the session sweep timer. */
  close(): Promise<void> {
    this.#sessions.close();
    const closed = new Promise<void>((resolve, reject) => {
      this.#server.close((err) => (err ? reject(err) : resolve()));
    });
    // `server.close()` alone only stops accepting *new* connections and
    // waits for existing sockets to end on their own — it does not close
    // them for you. Without this, one client that never disconnects would
    // make close() (and any test using it) hang forever.
    for (const socket of this.#sockets) socket.end();
    return closed;
  }

  #handleConnection(socket: Socket): void {
    const decoder = new FrameDecoder();
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    let sessionId: string | undefined;

    this.#sockets.add(socket);
    this.#logger.info(`[cwp] client connected: ${remote}`);

    socket.on("data", (chunk: Buffer) => {
      let frames: DecodedFrame[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this.#failConnection(socket, err);
        return;
      }

      for (const frame of frames) {
        this.#handleFrame(socket, frame, (id) => {
          sessionId = id;
        }).catch((err) => {
          this.#logger.error(`[cwp] unhandled error handling frame from ${remote}:`, err);
          this.#writeError(socket, undefined, undefined, ErrorCode.INTERNAL_ERROR, "Internal server error");
        });
      }
    });

    socket.on("error", (err) => this.#logger.warn(`[cwp] socket error (${remote}):`, err.message));
    socket.on("close", () => {
      this.#sockets.delete(socket);
      if (sessionId) this.#sessions.delete(sessionId);
      this.#logger.info(`[cwp] client disconnected: ${remote}`);
    });
  }

  async #handleFrame(socket: Socket, frame: DecodedFrame, onSession: (id: string) => void): Promise<void> {
    switch (frame.type) {
      case MessageType.HSK: {
        const session = this.#sessions.create();
        onSession(session.id);
        this.#write(socket, MessageType.HSK_ACK, { session: session.id }, "");
        return;
      }

      case MessageType.PING: {
        this.#write(socket, MessageType.PONG, {}, "");
        return;
      }

      case MessageType.CMD: {
        await this.#handleCommand(socket, frame);
        return;
      }

      default:
        this.#writeError(
          socket,
          undefined,
          undefined,
          ErrorCode.MALFORMED_HEADER,
          `Unsupported frame type from client: ${frame.type}`,
        );
    }
  }

  async #handleCommand(socket: Socket, frame: DecodedFrame): Promise<void> {
    const { session: sessionId, seq, command } = frame.headers;
    if (!sessionId || !seq || !command) {
      this.#writeError(
        socket,
        sessionId,
        seq,
        ErrorCode.MALFORMED_HEADER,
        "CMD frames require session, seq, and command headers",
      );
      return;
    }

    let session: Session;
    try {
      session = this.#sessions.touch(sessionId, Number(seq));
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.#writeError(socket, sessionId, seq, err.code, err.message);
        return;
      }
      throw err;
    }

    try {
      const result = await this.#router.dispatch(command, frame.body.toString("utf8"), { session });
      this.#write(socket, MessageType.RES, { session: session.id, seq }, result);
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.#writeError(socket, session.id, seq, err.code, err.message);
        return;
      }
      throw err;
    }
  }

  #write(socket: Socket, type: MessageType, headers: Record<string, string>, body: string): void {
    if (socket.destroyed) return;
    const wroteWithoutBackpressure = socket.write(encodeFrame(type, headers, body));
    if (!wroteWithoutBackpressure) {
      // The kernel send buffer is full — Node has queued the write in
      // memory and will flush it once the socket drains. A server with an
      // upstream source (e.g. streaming a file) should pause that source
      // here and resume on the 'drain' event; CWP has nothing upstream to
      // pause, so we just note it happened.
      this.#logger.warn(`[cwp] socket write buffer full for ${socket.remoteAddress}:${socket.remotePort}`);
    }
  }

  #writeError(
    socket: Socket,
    sessionId: string | undefined,
    seq: string | undefined,
    code: string,
    message: string,
  ): void {
    const headers: Record<string, string> = { code };
    if (sessionId) headers.session = sessionId;
    if (seq) headers.seq = seq;
    this.#write(socket, MessageType.ERR, headers, message);
  }

  #failConnection(socket: Socket, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof ProtocolError ? err.code : ErrorCode.INTERNAL_ERROR;
    this.#logger.warn(`[cwp] fatal protocol error, closing connection: ${message}`);
    this.#write(socket, MessageType.ERR, { code }, message);
    socket.end();
  }
}
