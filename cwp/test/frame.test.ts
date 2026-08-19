import assert from "node:assert/strict";
import { test } from "node:test";
import { ErrorCode, MAX_FRAME_SIZE, MessageType } from "../src/protocol/constants.ts";
import { crc32 } from "../src/protocol/crc32.ts";
import { ProtocolError } from "../src/protocol/errors.ts";
import { encodeFrame, tryDecodeFrame } from "../src/protocol/frame.ts";

test("round-trips type, headers, and a string body", () => {
  const encoded = encodeFrame(MessageType.CMD, { session: "abc123", seq: "1" }, "PING payload");
  const result = tryDecodeFrame(encoded);

  assert.ok(result);
  assert.equal(result.bytesConsumed, encoded.length);
  assert.equal(result.frame.type, MessageType.CMD);
  assert.deepEqual(result.frame.headers, { session: "abc123", seq: "1" });
  assert.equal(result.frame.body.toString("utf8"), "PING payload");
});

test("round-trips an empty body and empty headers", () => {
  const encoded = encodeFrame(MessageType.PING);
  const result = tryDecodeFrame(encoded);

  assert.ok(result);
  assert.deepEqual(result.frame.headers, {});
  assert.equal(result.frame.body.length, 0);
});

test("round-trips a body containing bytes that would break naive delimiter framing", () => {
  // The original prototype split on ";" and "|" — a payload containing
  // those characters (or embedded NUL bytes) corrupted the stream. Binary
  // length-prefixed framing must not care what's inside the body at all.
  const tricky = Buffer.from("a;b|c\n\nd\x00e");
  const encoded = encodeFrame(MessageType.RES, {}, tricky);
  const result = tryDecodeFrame(encoded);

  assert.ok(result);
  assert.ok(result.frame.body.equals(tricky));
});

test("tryDecodeFrame returns null on an empty buffer (need more data)", () => {
  assert.equal(tryDecodeFrame(Buffer.alloc(0)), null);
});

test("tryDecodeFrame returns null when only the length prefix has arrived", () => {
  const encoded = encodeFrame(MessageType.CMD, { command: "HELLO" }, "");
  const partial = encoded.subarray(0, 4);
  assert.equal(tryDecodeFrame(partial), null);
});

test("tryDecodeFrame returns null when the frame body hasn't fully arrived", () => {
  const encoded = encodeFrame(MessageType.RES, {}, "a longer body than the truncation point");
  const partial = encoded.subarray(0, encoded.length - 5);
  assert.equal(tryDecodeFrame(partial), null);
});

test("decodes exactly one frame and leaves the rest for the next call", () => {
  const first = encodeFrame(MessageType.CMD, { seq: "1" }, "one");
  const second = encodeFrame(MessageType.CMD, { seq: "2" }, "two");
  const combined = Buffer.concat([first, second]);

  const result = tryDecodeFrame(combined);
  assert.ok(result);
  assert.equal(result.bytesConsumed, first.length);
  assert.equal(result.frame.body.toString("utf8"), "one");

  const remainder = combined.subarray(result.bytesConsumed);
  const result2 = tryDecodeFrame(remainder);
  assert.ok(result2);
  assert.equal(result2.frame.body.toString("utf8"), "two");
});

test("rejects a bad magic byte", () => {
  const encoded = encodeFrame(MessageType.PING);
  const corrupted = Buffer.from(encoded);
  corrupted[4] = 0x00; // magic byte lives right after the 4-byte length prefix

  assert.throws(() => tryDecodeFrame(corrupted), (err: unknown) => {
    assert.ok(err instanceof ProtocolError);
    assert.equal(err.code, ErrorCode.BAD_MAGIC);
    return true;
  });
});

test("rejects an unsupported version byte", () => {
  const encoded = encodeFrame(MessageType.PING);
  const corrupted = Buffer.from(encoded);
  corrupted[5] = 99;

  assert.throws(() => tryDecodeFrame(corrupted), (err: unknown) => {
    assert.ok(err instanceof ProtocolError);
    assert.equal(err.code, ErrorCode.BAD_VERSION);
    return true;
  });
});

test("rejects a flipped body byte via checksum mismatch", () => {
  const encoded = encodeFrame(MessageType.RES, {}, "WELCOME");
  const corrupted = Buffer.from(encoded);
  const lastByteIdx = corrupted.length - 5; // last body byte, just before the CRC field
  corrupted[lastByteIdx] = (corrupted[lastByteIdx]! + 1) % 256;

  assert.throws(() => tryDecodeFrame(corrupted), (err: unknown) => {
    assert.ok(err instanceof ProtocolError);
    assert.equal(err.code, ErrorCode.CHECKSUM_MISMATCH);
    return true;
  });
});

test("rejects headerLength/bodyLength that don't match the announced frame size", () => {
  const encoded = encodeFrame(MessageType.RES, {}, "hello");
  const corrupted = Buffer.from(encoded);
  // Header length field starts right after magic+version+type (offset 4+3=7).
  corrupted.writeUInt32BE(9999, 7);

  assert.throws(() => tryDecodeFrame(corrupted), (err: unknown) => {
    assert.ok(err instanceof ProtocolError);
    assert.equal(err.code, ErrorCode.MALFORMED_HEADER);
    return true;
  });
});

test("rejects a header block that isn't valid JSON", () => {
  // Hand-build a frame with a header block that fails JSON.parse, since
  // encodeFrame always produces valid JSON.
  const badHeaderBytes = Buffer.from("not json");
  const body = Buffer.from("body");
  const fixedHeaderSize = 11;
  const crcSize = 4;
  const innerLength = fixedHeaderSize + badHeaderBytes.length + body.length + crcSize;

  const inner = Buffer.alloc(innerLength);
  let offset = 0;
  inner.writeUInt8(0xc5, offset); // MAGIC
  offset += 1;
  inner.writeUInt8(1, offset); // PROTOCOL_VERSION
  offset += 1;
  inner.writeUInt8(MessageType.RES, offset);
  offset += 1;
  inner.writeUInt32BE(badHeaderBytes.length, offset);
  offset += 4;
  inner.writeUInt32BE(body.length, offset);
  offset += 4;
  badHeaderBytes.copy(inner, offset);
  offset += badHeaderBytes.length;
  body.copy(inner, offset);
  offset += body.length;

  inner.writeUInt32BE(crc32(inner.subarray(0, offset)), offset);

  const full = Buffer.alloc(4 + inner.length);
  full.writeUInt32BE(inner.length, 0);
  inner.copy(full, 4);

  assert.throws(() => tryDecodeFrame(full), (err: unknown) => {
    assert.ok(err instanceof ProtocolError);
    assert.equal(err.code, ErrorCode.MALFORMED_HEADER);
    return true;
  });
});

test("encodeFrame refuses to build a frame larger than MAX_FRAME_SIZE", () => {
  const hugeBody = Buffer.alloc(MAX_FRAME_SIZE);
  assert.throws(() => encodeFrame(MessageType.CMD, {}, hugeBody), (err: unknown) => {
    assert.ok(err instanceof ProtocolError);
    assert.equal(err.code, ErrorCode.FRAME_TOO_LARGE);
    return true;
  });
});

test("tryDecodeFrame rejects an announced length exceeding MAX_FRAME_SIZE without buffering it", () => {
  // Simulate a malicious/buggy peer announcing a frame far larger than we
  // will ever accept. This must throw immediately from just the 4-byte
  // length prefix — it must NOT wait around trying to buffer gigabytes.
  const evil = Buffer.alloc(4);
  evil.writeUInt32BE(0xffffffff, 0);

  assert.throws(() => tryDecodeFrame(evil), (err: unknown) => {
    assert.ok(err instanceof ProtocolError);
    assert.equal(err.code, ErrorCode.FRAME_TOO_LARGE);
    return true;
  });
});
