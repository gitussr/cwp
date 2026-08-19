import assert from "node:assert/strict";
import { test } from "node:test";
import { ErrorCode } from "../src/protocol/constants.ts";
import { ProtocolError } from "../src/protocol/errors.ts";
import { SessionStore } from "../src/server/SessionStore.ts";

test("create() returns a fresh session with expectedSeq 0", () => {
  const store = new SessionStore();
  try {
    const session = store.create();
    assert.equal(session.expectedSeq, 0);
    assert.equal(store.size, 1);
    assert.equal(store.get(session.id)?.id, session.id);
  } finally {
    store.close();
  }
});

test("two sessions never collide on id", () => {
  const store = new SessionStore();
  try {
    const ids = new Set(Array.from({ length: 50 }, () => store.create().id));
    assert.equal(ids.size, 50);
  } finally {
    store.close();
  }
});

test("touch() accepts seq === expectedSeq + 1 and advances it", () => {
  const store = new SessionStore();
  try {
    const session = store.create();
    store.touch(session.id, 1);
    assert.equal(store.get(session.id)?.expectedSeq, 1);
    store.touch(session.id, 2);
    assert.equal(store.get(session.id)?.expectedSeq, 2);
  } finally {
    store.close();
  }
});

test("touch() rejects an unknown session id", () => {
  const store = new SessionStore();
  try {
    assert.throws(() => store.touch("does-not-exist", 1), (err: unknown) => {
      assert.ok(err instanceof ProtocolError);
      assert.equal(err.code, ErrorCode.UNKNOWN_SESSION);
      return true;
    });
  } finally {
    store.close();
  }
});

test("touch() rejects a skipped sequence number", () => {
  const store = new SessionStore();
  try {
    const session = store.create();
    assert.throws(() => store.touch(session.id, 2), (err: unknown) => {
      assert.ok(err instanceof ProtocolError);
      assert.equal(err.code, ErrorCode.BAD_SEQUENCE);
      return true;
    });
  } finally {
    store.close();
  }
});

test("touch() rejects a replayed (repeated) sequence number", () => {
  const store = new SessionStore();
  try {
    const session = store.create();
    store.touch(session.id, 1);
    assert.throws(() => store.touch(session.id, 1), (err: unknown) => {
      assert.ok(err instanceof ProtocolError);
      assert.equal(err.code, ErrorCode.BAD_SEQUENCE);
      return true;
    });
  } finally {
    store.close();
  }
});

test("touch() expires a session that has been idle past the TTL", async () => {
  const store = new SessionStore({ ttlMs: 20, sweepIntervalMs: 1_000_000 });
  try {
    const session = store.create();
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.throws(() => store.touch(session.id, 1), (err: unknown) => {
      assert.ok(err instanceof ProtocolError);
      assert.equal(err.code, ErrorCode.SESSION_EXPIRED);
      return true;
    });
    // Expiry also evicts the record entirely.
    assert.equal(store.get(session.id), undefined);
  } finally {
    store.close();
  }
});

test("background sweep evicts idle sessions even without a touch() call", async () => {
  const store = new SessionStore({ ttlMs: 10, sweepIntervalMs: 15 });
  try {
    const session = store.create();
    assert.equal(store.size, 1);

    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(store.size, 0);
    assert.equal(store.get(session.id), undefined);
  } finally {
    store.close();
  }
});

test("delete() removes a session", () => {
  const store = new SessionStore();
  try {
    const session = store.create();
    store.delete(session.id);
    assert.equal(store.get(session.id), undefined);
  } finally {
    store.close();
  }
});

test("close() stops the sweep timer (no dangling handle keeping the process alive)", () => {
  const store = new SessionStore({ sweepIntervalMs: 5 });
  // If close() didn't clearInterval, node's --test runner would hang or
  // warn about an open handle after this test file finishes.
  store.close();
});
