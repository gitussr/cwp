/**
 * CWP/1 wire constants.
 *
 * Frame layout (all multi-byte integers are big-endian, network byte order):
 *
 *   [0..3]   outerLength   uint32  byte length of everything after this field
 *   [4]      magic         uint8   always MAGIC (0xC5) — quick sanity check
 *   [5]      version       uint8   PROTOCOL_VERSION
 *   [6]      type          uint8   MessageType
 *   [7..10]  headerLength  uint32  byte length of the header JSON block
 *   [11..14] bodyLength    uint32  byte length of the body
 *   [..]     header        bytes   UTF-8 JSON object, e.g. {"session":"..","seq":"3"}
 *   [..]     body          bytes   raw payload bytes
 *   [..+4]   crc32         uint32  CRC-32 of (header bytes + body bytes)
 */

export const MAGIC = 0xc5;
export const PROTOCOL_VERSION = 1;

// Plain `as const` objects rather than TypeScript's `enum` keyword: Node's
// native TS support (`--experimental-strip-types`) only *erases* type
// syntax, it doesn't compile TS-only runtime constructs like `enum` — so
// this is both a broadly-preferred modern-TS pattern and a hard
// requirement for running this source directly under Node.
export const MessageType = {
  /** Client -> server: open a new session. */
  HSK: 0x01,
  /** Server -> client: session accepted; `session` header carries the id. */
  HSK_ACK: 0x02,
  /** Client -> server: invoke `command` header against `body` payload. */
  CMD: 0x03,
  /** Server -> client: successful CMD result. */
  RES: 0x04,
  /** Server -> client: CMD (or connection-level) failure. */
  ERR: 0x05,
  /** Either direction: liveness check, no session required. */
  PING: 0x06,
  /** Either direction: reply to PING. */
  PONG: 0x07,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const ErrorCode = {
  BAD_MAGIC: "BAD_MAGIC",
  BAD_VERSION: "BAD_VERSION",
  FRAME_TOO_LARGE: "FRAME_TOO_LARGE",
  MALFORMED_HEADER: "MALFORMED_HEADER",
  CHECKSUM_MISMATCH: "CHECKSUM_MISMATCH",
  UNKNOWN_SESSION: "UNKNOWN_SESSION",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  BAD_SEQUENCE: "BAD_SEQUENCE",
  UNKNOWN_COMMAND: "UNKNOWN_COMMAND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Hard ceiling on a single frame's total wire size (outer length prefix
 * included). Without this, a length prefix read straight off the network
 * (attacker-controlled or just a buggy peer) could tell us to buffer
 * gigabytes before we ever see the rest of the frame — an easy way to OOM
 * a naive TCP server. Real protocols (HTTP, gRPC, S3 multipart, ...) all
 * cap frame/message size for exactly this reason.
 */
export const MAX_FRAME_SIZE = 1024 * 1024; // 1 MiB

export const LENGTH_PREFIX_SIZE = 4;
export const FIXED_HEADER_SIZE = 1 /* magic */ + 1 /* version */ + 1 /* type */ + 4 /* headerLen */ + 4; /* bodyLen */
export const CRC_SIZE = 4;
