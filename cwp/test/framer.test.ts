import assert from "node:assert/strict";
import { test } from "node:test";
import { ErrorCode, MessageType } from "../src/protocol/constants.ts";
import { ProtocolError } from "../src/protocol/errors.ts";
import { encodeFrame } from "../src/protocol/frame.ts";
import { FrameDecoder } from "../src/protocol/framer.ts";

test("decodes a single frame delivered in one chunk", () => {
  const decoder = new FrameDecoder();
  const encoded = encodeFrame(MessageType.CMD, { seq: "1" }, "PING");

  const frames = decoder.push(encoded);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.body.toString("utf8"), "PING");
  assert.equal(decoder.pendingBytes, 0);
});

test("decodes multiple frames that arrive coalesced in a single TCP read", () => {
  const decoder = new FrameDecoder();
  const a = encodeFrame(MessageType.CMD, { seq: "1" }, "one");
  const b = encodeFrame(MessageType.CMD, { seq: "2" }, "two");
  const c = encodeFrame(MessageType.CMD, { seq: "3" }, "three");

  const frames = decoder.push(Buffer.concat([a, b, c]));
  assert.deepEqual(
    frames.map((f) => f.body.toString("utf8")),
    ["one", "two", "three"],
  );
  assert.equal(decoder.pendingBytes, 0);
});

test("reassembles a single frame split across many small chunks", () => {
  const decoder = new FrameDecoder();
  const encoded = encodeFrame(MessageType.RES, { session: "abc" }, "a somewhat longer payload body for good measure");

  const collected: Buffer[] = [];
  for (let i = 0; i < encoded.length; i += 3) {
    const chunk = encoded.subarray(i, Math.min(i + 3, encoded.length));
    const frames = decoder.push(chunk);
    collected.push(...frames.map((f) => f.body));
  }

  assert.equal(collected.length, 1);
  assert.equal(collected[0]!.toString("utf8"), "a somewhat longer payload body for good measure");
});

test("handles a frame boundary that falls exactly on a chunk boundary", () => {
  const decoder = new FrameDecoder();
  const a = encodeFrame(MessageType.CMD, { seq: "1" }, "first");
  const b = encodeFrame(MessageType.CMD, { seq: "2" }, "second");

  const frames1 = decoder.push(a);
  assert.equal(frames1.length, 1);
  assert.equal(frames1[0]!.body.toString("utf8"), "first");

  const frames2 = decoder.push(b);
  assert.equal(frames2.length, 1);
  assert.equal(frames2[0]!.body.toString("utf8"), "second");
});

test("handles a chunk containing a complete frame plus a partial next frame", () => {
  const decoder = new FrameDecoder();
  const a = encodeFrame(MessageType.CMD, { seq: "1" }, "complete");
  const b = encodeFrame(MessageType.CMD, { seq: "2" }, "split-across-two-pushes");

  const firstChunk = Buffer.concat([a, b.subarray(0, 5)]);
  const frames1 = decoder.push(firstChunk);
  assert.equal(frames1.length, 1);
  assert.equal(frames1[0]!.body.toString("utf8"), "complete");
  assert.ok(decoder.pendingBytes > 0);

  const frames2 = decoder.push(b.subarray(5));
  assert.equal(frames2.length, 1);
  assert.equal(frames2[0]!.body.toString("utf8"), "split-across-two-pushes");
  assert.equal(decoder.pendingBytes, 0);
});

test("throws and stops on corrupted framing data instead of hanging forever", () => {
  const decoder = new FrameDecoder();

  // A minimal-but-complete frame (fixed header + checksum, no header/body
  // bytes) with a zeroed-out magic byte instead of the real 0xC5.
  const inner = Buffer.alloc(15); // FIXED_HEADER_SIZE (11) + CRC_SIZE (4)
  const outer = Buffer.alloc(4);
  outer.writeUInt32BE(inner.length, 0);
  const garbage = Buffer.concat([outer, inner]);

  assert.throws(() => decoder.push(garbage), (err: unknown) => {
    assert.ok(err instanceof ProtocolError);
    assert.equal(err.code, ErrorCode.BAD_MAGIC);
    return true;
  });
});
