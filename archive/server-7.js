// server.js — Codeworm Protocol CH7: Handshake + Sessions
import net from "node:net";
import crypto from "crypto";

const PORT = 5000;
const SESSION_TTL_MS = 30_000; // expire sessions after 30s of inactivity

// In-memory session store (sessionId -> { expectedSeq, lastSeen })
const sessions = new Map();

const server = net.createServer(socket => {
  console.log("Client connected:", socket.remoteAddress, socket.remotePort);

  let buffer = "";

  socket.on("data", chunk => {
    buffer += chunk.toString();

    let end;
    while ((end = buffer.indexOf(";")) !== -1) {
      const rawPacket = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      processPacket(rawPacket, socket);
    }
  });

  socket.on("end", () => console.log("Client disconnected (end)"));
  socket.on("close", () => console.log("Socket closed"));
  socket.on("error", (err) => console.log("Socket error:", err.message));
});

server.on("error", (err) => console.log("Server error:", err.message));

// Periodically clean expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.lastSeen > SESSION_TTL_MS) {
      console.log(`Session expired: ${id}`);
      sessions.delete(id);
    }
  }
}, 5000);

function processPacket(packet, socket) {
  // Packet format (chapter 6/7):
  // First line (meta): CWP1|04|<TYPE>|<LENGTH>
  // Headers (zero or more lines): Key: Value
  // Blank line
  // Payload (LENGTH chars)
  //
  // Example:
  // CWP1|04|CMD|05\nSession: abc\nSeq: 1\n\nPING;

  // Split header + payload by the first blank line
  const parts = packet.split("\n\n");
  const headerSection = parts[0] || "";
  const payloadSection = parts[1] !== undefined ? parts[1] : "";

  // Parse meta line and header lines
  const firstLineEnd = headerSection.indexOf("\n");
  const metaLine = firstLineEnd === -1 ? headerSection.trim() : headerSection.slice(0, firstLineEnd).trim();
  const headersRaw = firstLineEnd === -1 ? "" : headerSection.slice(firstLineEnd + 1);

  const metaParts = metaLine.split("|");
  if (metaParts.length < 4) {
    safeWrite(socket, "CWP1|04|ERR|11\n\nBAD_META;");
    return;
  }
  const [start, version, type, lengthStr] = metaParts;
  if (start !== "CWP1") {
    safeWrite(socket, "CWP1|04|ERR|12\n\nBAD_START;");
    return;
  }
  const expectedLen = Number(lengthStr);
  if (Number.isNaN(expectedLen)) {
    safeWrite(socket, "CWP1|04|ERR|13\n\nBAD_LENGTH_FIELD;");
    return;
  }

  // Parse headers into map
  const headers = {};
  if (headersRaw.trim().length > 0) {
    const headerLines = headersRaw.split("\n");
    for (let line of headerLines) {
      const idx = line.indexOf(":");
      if (idx !== -1) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        headers[key] = val;
      }
    }
  }

  const payload = payloadSection || "";

  if (payload.length !== expectedLen) {
    console.log(`Len mismatch: got ${payload.length} expected ${expectedLen}`);
    safeWrite(socket, "CWP1|04|ERR|14\n\nBAD_LENGTH;");
    return;
  }

  // ROUTE by type
  if (type === "HSK") {
    // Handshake: client asks to open a session
    // Generate session id and store state
    const sessionId = crypto.randomBytes(8).toString("hex");
    sessions.set(sessionId, { expectedSeq: 0, lastSeen: Date.now() });

    // Reply HSK-ACK with Session header
    const payloadResp = "OK";
    const packet = `CWP1|04|HSK-ACK|${payloadResp.length}\nSession: ${sessionId}\nSeq: 0\n\n${payloadResp};`;
    safeWrite(socket, packet);
    console.log("HSK: new session", sessionId);
    return;
  }

  if (type === "CMD") {
    // Commands must include Session and Seq headers
    const sId = headers["Session"];
    const seqStr = headers["Seq"];
    if (!sId || !seqStr) {
      safeWrite(socket, "CWP1|04|ERR|20\n\nNO_SESSION_OR_SEQ;");
      return;
    }
    const seq = Number(seqStr);
    const session = sessions.get(sId);
    if (!session) {
      safeWrite(socket, `CWP1|04|ERR|21\n\nBAD_SESSION;`);
      return;
    }
    // Basic sequence check: allow exactly expectedSeq + 1
    if (seq !== session.expectedSeq + 1) {
      safeWrite(socket, `CWP1|04|ERR|22\n\nBAD_SEQ;`);
      return;
    }

    // Advance sequence and update last seen
    session.expectedSeq = seq;
    session.lastSeen = Date.now();

    // Now handle command payload
    if (payload === "PING") {
      // Respond with PONG (include Session and Seq in response headers)
      const respPayload = "PONG";
      // response sequence = seq (server replies correspond to same seq)
      const resp = `CWP1|04|RES|${respPayload.length}\nSession: ${sId}\nSeq: ${seq}\n\n${respPayload};`;
      safeWrite(socket, resp);
      return;
    } else {
      // unknown command
      safeWrite(socket, `CWP1|04|ERR|23\nSession: ${sId}\nSeq: ${seq}\n\nUNKNOWN;`);
      return;
    }
  }

  // If unknown type
  safeWrite(socket, "CWP1|04|ERR|99\n\nUNKNOWN_TYPE;");
}

function safeWrite(socket, msg) {
  if (!socket.destroyed) socket.write(msg);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`CWP server (CH7) running on port ${PORT}`);
});
