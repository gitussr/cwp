import {
  CRC_SIZE,
  ErrorCode,
  FIXED_HEADER_SIZE,
  LENGTH_PREFIX_SIZE,
  MAGIC,
  MAX_FRAME_SIZE,
  MessageType,
  PROTOCOL_VERSION,
} from "./constants.ts";
import { crc32 } from "./crc32.ts";
import { ProtocolError } from "./errors.ts";

export interface DecodedFrame {
  version: number;
  type: MessageType;
  headers: Record<string, string>;
  body: Buffer;
}

export interface FrameParseResult {
  frame: DecodedFrame;
  /** Number of bytes consumed from the front of the input buffer. */
  bytesConsumed: number;
}

/**
 * Encodes a single CWP frame — including its outer length prefix — ready
 * to write directly to a socket.
 */
export function encodeFrame(
  type: MessageType,
  headers: Record<string, string> = {},
  body: Buffer | string = Buffer.alloc(0),
): Buffer {
  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const headerBuf = Buffer.from(JSON.stringify(headers), "utf8");

  const innerLength = FIXED_HEADER_SIZE + headerBuf.length + bodyBuf.length + CRC_SIZE;
  const totalLength = LENGTH_PREFIX_SIZE + innerLength;
  if (totalLength > MAX_FRAME_SIZE) {
    throw new ProtocolError(
      ErrorCode.FRAME_TOO_LARGE,
      `Encoded frame would be ${totalLength} bytes, exceeding MAX_FRAME_SIZE (${MAX_FRAME_SIZE})`,
    );
  }

  const out = Buffer.alloc(totalLength);
  let offset = 0;

  out.writeUInt32BE(innerLength, offset);
  offset += LENGTH_PREFIX_SIZE;

  out.writeUInt8(MAGIC, offset);
  offset += 1;
  out.writeUInt8(PROTOCOL_VERSION, offset);
  offset += 1;
  out.writeUInt8(type, offset);
  offset += 1;
  out.writeUInt32BE(headerBuf.length, offset);
  offset += 4;
  out.writeUInt32BE(bodyBuf.length, offset);
  offset += 4;

  headerBuf.copy(out, offset);
  offset += headerBuf.length;
  bodyBuf.copy(out, offset);
  offset += bodyBuf.length;

  const checksum = crc32(out.subarray(LENGTH_PREFIX_SIZE, offset));
  out.writeUInt32BE(checksum, offset);

  return out;
}

/**
 * Attempts to parse one complete frame from the front of `buf`.
 *
 * Returns `null` when `buf` doesn't yet contain a full frame — the caller
 * should keep buffering and try again once more bytes arrive. This is the
 * normal, expected case for every TCP read except the last one in a frame.
 *
 * Throws `ProtocolError` when the bytes we *do* have are structurally
 * invalid (bad magic/version, a length field that would exceed
 * MAX_FRAME_SIZE, or a checksum mismatch). This is not a "wait for more
 * data" situation — the stream is desynchronized and the connection should
 * be torn down.
 */
export function tryDecodeFrame(buf: Buffer): FrameParseResult | null {
  if (buf.length < LENGTH_PREFIX_SIZE) return null;

  const innerLength = buf.readUInt32BE(0);
  const totalLength = LENGTH_PREFIX_SIZE + innerLength;

  if (totalLength > MAX_FRAME_SIZE) {
    throw new ProtocolError(
      ErrorCode.FRAME_TOO_LARGE,
      `Peer announced a ${totalLength}-byte frame, exceeding MAX_FRAME_SIZE (${MAX_FRAME_SIZE})`,
    );
  }
  if (buf.length < totalLength) return null;

  const inner = buf.subarray(LENGTH_PREFIX_SIZE, totalLength);
  if (inner.length < FIXED_HEADER_SIZE + CRC_SIZE) {
    throw new ProtocolError(ErrorCode.MALFORMED_HEADER, "Frame is shorter than the fixed header + checksum");
  }

  let offset = 0;
  const magic = inner.readUInt8(offset);
  offset += 1;
  const version = inner.readUInt8(offset);
  offset += 1;
  const type = inner.readUInt8(offset) as MessageType;
  offset += 1;
  const headerLen = inner.readUInt32BE(offset);
  offset += 4;
  const bodyLen = inner.readUInt32BE(offset);
  offset += 4;

  if (magic !== MAGIC) {
    throw new ProtocolError(
      ErrorCode.BAD_MAGIC,
      `Expected magic byte 0x${MAGIC.toString(16)}, got 0x${magic.toString(16)}`,
    );
  }
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolError(ErrorCode.BAD_VERSION, `Unsupported protocol version: ${version}`);
  }

  const expectedTail = headerLen + bodyLen + CRC_SIZE;
  if (offset + expectedTail !== inner.length) {
    throw new ProtocolError(
      ErrorCode.MALFORMED_HEADER,
      "headerLength/bodyLength headers do not add up to the frame's announced size",
    );
  }

  const headerBuf = inner.subarray(offset, offset + headerLen);
  offset += headerLen;
  const bodyBuf = inner.subarray(offset, offset + bodyLen);
  offset += bodyLen;
  const checksumField = inner.readUInt32BE(offset);

  const actualChecksum = crc32(inner.subarray(0, offset));
  if (actualChecksum !== checksumField) {
    throw new ProtocolError(
      ErrorCode.CHECKSUM_MISMATCH,
      `CRC32 mismatch: frame claims ${checksumField}, computed ${actualChecksum}`,
    );
  }

  let headers: Record<string, string> = {};
  if (headerBuf.length > 0) {
    try {
      headers = JSON.parse(headerBuf.toString("utf8"));
    } catch {
      throw new ProtocolError(ErrorCode.MALFORMED_HEADER, "Header block is not valid JSON");
    }
  }

  return {
    frame: {
      version,
      type,
      headers,
      // Copy out of the (possibly shared/reused) input buffer so callers
      // can hold onto `body` after the decoder's internal buffer moves on.
      body: Buffer.from(bodyBuf),
    },
    bytesConsumed: totalLength,
  };
}
