import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32 } from "../src/protocol/crc32.ts";

test("crc32 of an empty buffer is 0", () => {
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("crc32 matches the well-known test vector", () => {
  // Standard CRC-32 (IEEE 802.3 / zlib) test vector.
  const buf = Buffer.from("The quick brown fox jumps over the lazy dog");
  assert.equal(crc32(buf), 0x414fa339);
});

test("crc32 is deterministic", () => {
  const buf = Buffer.from("hello world");
  assert.equal(crc32(buf), crc32(Buffer.from("hello world")));
});

test("crc32 is sensitive to single-byte changes", () => {
  const a = Buffer.from("hello world");
  const b = Buffer.from("hello worlD");
  assert.notEqual(crc32(a), crc32(b));
});

test("crc32 always returns an unsigned 32-bit integer", () => {
  const value = crc32(Buffer.from("x".repeat(10_000)));
  assert.ok(Number.isInteger(value));
  assert.ok(value >= 0 && value <= 0xffffffff);
});
