import assert from "node:assert/strict";
import net from "node:net";
import { describe, test } from "node:test";
import { MessageType } from "../src/protocol/constants.ts";
import { type DecodedFrame, encodeFrame } from "../src/protocol/frame.ts";
import { FrameDecoder } from "../src/protocol/framer.ts";
import { CwpClient } from "../src/client/CwpClient.ts";
import { CwpServer, type CwpServerOptions } from "../src/server/CwpServer.ts";

const silentLogger = { info() {}, warn() {}, error() {} };

async function startServer(options: CwpServerOptions = {}) {
  const server = new CwpServer({ ...options, logger: silentLogger });
  await server.listen(0, "127.0.0.1");
  const address = server.address;
  if (!address || typeof address === "string") throw new Error("expected an AddressInfo");
  return { server, port: address.port };
}

/** Sends raw bytes to the server and returns the first decoded response frame — for exercising protocol-violation paths a well-behaved CwpClient would never produce. */
function rawRoundTrip(port: number, bytes: Buffer): Promise<DecodedFrame> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(bytes));
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      const frames = decoder.push(chunk);
      if (frames.length > 0) {
        socket.end();
        resolve(frames[0]!);
      }
    });
    socket.on("error", reject);
  });
}

describe("CwpServer + CwpClient integration", () => {
  test("full round trip: connect, handshake, built-in commands, close", async () => {
    const { server, port } = await startServer();
    const client = new CwpClient({ host: "127.0.0.1", port });
    try {
      await client.connect();
      const sessionId = await client.handshake();
      assert.match(sessionId, /^[0-9a-f]{32}$/);

      assert.equal(await client.sendCommand("HELLO"), "WELCOME");
      assert.equal(await client.sendCommand("ECHO", "hi there"), "hi there");
      assert.match(await client.sendCommand("TIME"), /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("PING/PONG works before and independent of any handshake", async () => {
    const { server, port } = await startServer();
    const client = new CwpClient({ host: "127.0.0.1", port });
    try {
      await client.connect();
      await assert.doesNotReject(client.ping());
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("sendCommand() before handshake() rejects locally, without touching the network", async () => {
    const { server, port } = await startServer();
    const client = new CwpClient({ host: "127.0.0.1", port });
    try {
      await client.connect();
      await assert.rejects(client.sendCommand("HELLO"), /handshake/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("unknown command yields a rejected promise carrying the server's error", async () => {
    const { server, port } = await startServer();
    const client = new CwpClient({ host: "127.0.0.1", port });
    try {
      await client.connect();
      await client.handshake();
      await assert.rejects(client.sendCommand("DOES_NOT_EXIST"), /UNKNOWN_COMMAND/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("a custom command registered via server.command() is dispatched correctly", async () => {
    const { server, port } = await startServer();
    server.command("REVERSE", (payload) => payload.split("").reverse().join(""));
    const client = new CwpClient({ host: "127.0.0.1", port });
    try {
      await client.connect();
      await client.handshake();
      assert.equal(await client.sendCommand("REVERSE", "codeworm"), "mrowedoc");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("concurrent clients get independent, non-colliding sessions", async () => {
    const { server, port } = await startServer();
    const clientA = new CwpClient({ host: "127.0.0.1", port });
    const clientB = new CwpClient({ host: "127.0.0.1", port });
    try {
      await Promise.all([clientA.connect(), clientB.connect()]);
      const [sessionA, sessionB] = await Promise.all([clientA.handshake(), clientB.handshake()]);
      assert.notEqual(sessionA, sessionB);

      const [resA, resB] = await Promise.all([
        clientA.sendCommand("ECHO", "from-a"),
        clientB.sendCommand("ECHO", "from-b"),
      ]);
      assert.equal(resA, "from-a");
      assert.equal(resB, "from-b");
    } finally {
      await Promise.all([clientA.close(), clientB.close()]);
      await server.close();
    }
  });

  test("pipelined commands on one session resolve to their own responses, not each other's", async () => {
    const { server, port } = await startServer();
    const client = new CwpClient({ host: "127.0.0.1", port });
    try {
      await client.connect();
      await client.handshake();

      const results = await Promise.all([
        client.sendCommand("ECHO", "one"),
        client.sendCommand("ECHO", "two"),
        client.sendCommand("ECHO", "three"),
      ]);
      assert.deepEqual(results, ["one", "two", "three"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("a CMD with an out-of-order sequence number is rejected with BAD_SEQUENCE", async () => {
    const { server, port } = await startServer();
    try {
      const ack = await rawRoundTrip(port, encodeFrame(MessageType.HSK, {}, ""));
      const sessionId = ack.headers.session!;

      // Skip straight to seq "5" instead of the required "1".
      const response = await rawRoundTrip(
        port,
        encodeFrame(MessageType.CMD, { session: sessionId, seq: "5", command: "HELLO" }, ""),
      );
      assert.equal(response.type, MessageType.ERR);
      assert.equal(response.headers.code, "BAD_SEQUENCE");
    } finally {
      await server.close();
    }
  });

  test("a CMD referencing an unknown session is rejected with UNKNOWN_SESSION", async () => {
    const { server, port } = await startServer();
    try {
      const response = await rawRoundTrip(
        port,
        encodeFrame(MessageType.CMD, { session: "0".repeat(32), seq: "1", command: "HELLO" }, ""),
      );
      assert.equal(response.type, MessageType.ERR);
      assert.equal(response.headers.code, "UNKNOWN_SESSION");
    } finally {
      await server.close();
    }
  });

  test("a structurally corrupt frame gets an ERR reply and the connection is closed, without crashing the server", async () => {
    const { server, port } = await startServer();
    try {
      // A well-formed outer length + fixed header, but with the magic byte
      // zeroed out.
      const inner = Buffer.alloc(15);
      const outer = Buffer.alloc(4);
      outer.writeUInt32BE(inner.length, 0);
      const garbage = Buffer.concat([outer, inner]);

      const response = await rawRoundTrip(port, garbage);
      assert.equal(response.type, MessageType.ERR);
      assert.equal(response.headers.code, "BAD_MAGIC");

      // The server itself must still be alive and answering other clients.
      const client = new CwpClient({ host: "127.0.0.1", port });
      await client.connect();
      await client.handshake();
      assert.equal(await client.sendCommand("HELLO"), "WELCOME");
      await client.close();
    } finally {
      await server.close();
    }
  });

  test("server.close() resolves even with a client still connected (no hang)", async () => {
    const { server, port } = await startServer();
    const client = new CwpClient({ host: "127.0.0.1", port });
    await client.connect();
    await client.handshake();

    // Deliberately not closing the client first — server.close() must not
    // wait forever for a socket it has to close itself.
    await server.close();
  });

  test("disconnecting invalidates the session — reusing its id afterwards fails", async () => {
    const { server, port } = await startServer();
    try {
      const client = new CwpClient({ host: "127.0.0.1", port });
      await client.connect();
      const sessionId = await client.handshake();
      await client.close();

      // Give the server a moment to process the 'close' event.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const response = await rawRoundTrip(
        port,
        encodeFrame(MessageType.CMD, { session: sessionId, seq: "1", command: "HELLO" }, ""),
      );
      assert.equal(response.type, MessageType.ERR);
      assert.equal(response.headers.code, "UNKNOWN_SESSION");
    } finally {
      await server.close();
    }
  });
});
