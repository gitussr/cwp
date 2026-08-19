import type { ErrorCode } from "./constants.ts";

/**
 * A protocol-level failure: bad framing, an unknown session, a rejected
 * command, etc. Anything that should be reported to the *other side* as a
 * CWP ERR frame (rather than crash the process) should throw this.
 */
export class ProtocolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ProtocolError";
    this.code = code;
  }
}
