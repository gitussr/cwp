// client.js — Codeworm Protocol CH7 example client
import net from "node:net";

const HOST = "127.0.0.1";
const PORT = 5000;

const client = new net.Socket();
let buffer = "";
let sessionId = null;
let seq = 0;

client.on("error", (err) => console.log("Client error:", err.message));
client.on("close", () => console.log("Client closed"));

client.connect(PORT, HOST, () => {
  console.log("Connected to server — initiating handshake (HSK)");
  sendHandshake();
});

client.on("data", (chunk) => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf(";")) !== -1) {
    const packet = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    handlePacket(packet);
  }
});

function sendHandshake() {
  // Type HSK with zero-length payload
  const pkt = `CWP1|04|HSK|0\n\n;`;
  client.write(pkt);
}

function sendCommand(cmd) {
  if (!sessionId) {
    console.log("No session — cannot send CMD");
    return;
  }
  seq += 1;
  const payload = String(cmd);
  const length = payload.length;
  const meta = `CWP1|04|CMD|${length}\nSession: ${sessionId}\nSeq: ${seq}\n\n${payload};`;
  client.write(meta);
}

function handlePacket(packet) {
  // Parse like server
  const parts = packet.split("\n\n");
  const headerSection = parts[0] || "";
  const payload = parts[1] !== undefined ? parts[1] : "";

  const firstLineEnd = headerSection.indexOf("\n");
  const metaLine = firstLineEnd === -1 ? headerSection.trim() : headerSection.slice(0, firstLineEnd).trim();
  const headersRaw = firstLineEnd === -1 ? "" : headerSection.slice(firstLineEnd + 1);
  const metaParts = metaLine.split("|");
  const [start, version, type, lengthStr] = metaParts;

  // parse headers
  const headers = {};
  if (headersRaw.trim().length > 0) {
    const headerLines = headersRaw.split("\n");
    for (let line of headerLines) {
      const idx = line.indexOf(":");
      if (idx !== -1) {
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
  }

  // handle types
  if (type === "HSK-ACK") {
    sessionId = headers["Session"];
    const serverSeq = Number(headers["Seq"] || "0");
    console.log("Handshake accepted. Session:", sessionId, "Server Seq:", serverSeq);

    // Now send a PING command
    sendCommand("PING");

    // Also demonstrate another ping after a short delay
    setTimeout(() => sendCommand("PING"), 500);
  } else if (type === "RES") {
    console.log("Server replied (framed):", payload);
  } else if (type === "ERR") {
    console.log("Server error (framed):", payload);
  } else {
    console.log("Unknown packet type:", type, "payload:", payload);
  }
}
