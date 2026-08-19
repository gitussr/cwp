import { type DecodedFrame, tryDecodeFrame } from "./frame.ts";

/**
 * Stateful stream decoder: feed it raw bytes as they arrive from a socket,
 * get back zero or more complete, validated frames.
 *
 * TCP is a byte stream, not a message stream — a single `data` event can
 * contain half a frame, exactly one frame, or several frames back to back.
 * `FrameDecoder` is the piece that turns "arbitrary chunks of bytes" back
 * into "the sequence of frames the sender actually wrote", by buffering
 * whatever's incomplete and re-trying on every push.
 */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  /**
   * Feed a chunk read from the socket. Returns every frame that became
   * complete as a result of this chunk (may be empty, may be more than one).
   *
   * Throws `ProtocolError` if the buffered bytes are structurally invalid.
   * Once that happens the stream is desynchronized and this decoder must
   * not be reused — the caller should close the connection.
   */
  push(chunk: Buffer): DecodedFrame[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    const frames: DecodedFrame[] = [];
    for (;;) {
      const result = tryDecodeFrame(this.#buffer);
      if (!result) break;
      frames.push(result.frame);
      this.#buffer = this.#buffer.subarray(result.bytesConsumed);
    }
    return frames;
  }

  /** Bytes currently buffered that don't yet form a complete frame. */
  get pendingBytes(): number {
    return this.#buffer.length;
  }
}
