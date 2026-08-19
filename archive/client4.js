// client.js — Codeworm Protocol client (framing)
import net from "node:net";

const PORT = 5000;
const HOST = "127.0.0.1";

const client = new net.Socket();

client.on("error", err => console.log("Client error:", err.message));
client.on("close", () => console.log("Client closed"));

client.connect(PORT, HOST, () => {
  console.log("Connected to server (framed client)");

  // Example: send a short HELLO command
  sendFramedPayload(client, buildPayload("CMD", "HELLO", { "Client": "nodejs" }));

  // Example: send a longer body (simulates fragmentation)
  const longBody = "This is a longer message to test fragmentation and reassembly.".repeat(10);
  sendFramedPayload(client, buildPayload("CMD", longBody, { "Client": "nodejs", "Test": "long" }));

  // Example: you can send many messages quickly; server will reassemble them correctly
  setTimeout(() => {
    for (let i = 0; i < 5; i++) {
      sendFramedPayload(client, buildPayload("CMD", `msg-${i}`, { "seq": String(i) }));
    }
  }, 200);
});

client.on("data", data => {
  // Data from server is framed too; we must parse frames on client side as well.
  // For demo simplicity, assume server sends small single-frame responses and print raw.
  // In production you should implement the exact same framing read loop on the client.
  // We'll implement a minimal read loop here to correctly print framed responses:
  if (!client._recvBuffer) client._recvBuffer = Buffer.alloc(0);
  client._recvBuffer = Buffer.concat([client._recvBuffer, data]);

  while (true) {
    if (client._recvBuffer.length < 4) break;
    const msgLen = client._recvBuffer.readUInt32BE(0);
    if (client._recvBuffer.length < 4 + msgLen) break;
    const payloadBuf = client._recvBuffer.slice(4, 4 + msgLen);
    client._recvBuffer = client._recvBuffer.slice(4 + msgLen);

    const payloadStr = payloadBuf.toString("utf8");
    console.log("Server replied (framed payload):\n", payloadStr);
  }
});

/* ---------- helpers (same as server buildPayload) ---------- */
function buildPayload(type, bodyText, headerObj = {}) {
  const length = bodyText.length;
  const meta = `CWP1|02|${type}|${length}`;
  const headers = Object.entries(headerObj).map(([k, v]) => `${k}: ${v}`).join("\n");
  const headerSection = headers.length ? `${meta}\n${headers}` : `${meta}`;
  return `${headerSection}\n\n${bodyText}`;
}

function sendFramedPayload(socket, payloadStr) {
  if (socket.destroyed) return;
  const payloadBuf = Buffer.from(payloadStr, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payloadBuf.length, 0);
  const frame = Buffer.concat([lenBuf, payloadBuf]);
  socket.write(frame);
}
