// server.js — Codeworm Protocol (Chapter 6: Length-prefixed framing)
import net from "node:net";

const PORT = 5000;
const HOST = "0.0.0.0";

const server = net.createServer(socket => {
  console.log("Client connected:", socket.remoteAddress, socket.remotePort);

  // Buffer that holds raw bytes received but not yet processed
  let recvBuffer = Buffer.alloc(0);

  socket.on("data", chunk => {
    // Append new chunk
    recvBuffer = Buffer.concat([recvBuffer, chunk]);

    // Try to extract as many full messages as present in the buffer
    while (true) {
      // Need at least 4 bytes for length header
      if (recvBuffer.length < 4) break;

      // Read 4-byte big-endian length
      const msgLen = recvBuffer.readUInt32BE(0);

      // If full payload not yet received, wait for more data
      if (recvBuffer.length < 4 + msgLen) break;

      // Extract the payload bytes
      const payloadBuf = recvBuffer.slice(4, 4 + msgLen);

      // Remove the processed message from the buffer
      recvBuffer = recvBuffer.slice(4 + msgLen);

      // Now process the payload (as UTF-8 string or binary as your protocol expects)
      try {
        const payloadStr = payloadBuf.toString("utf8");
        processPayload(payloadStr, socket);
      } catch (e) {
        safeWrite(socket, buildErrorPacket("BAD_ENCODING"));
      }
    }
  });

  socket.on("end", () => console.log("Client disconnected (end)"));
  socket.on("close", () => console.log("Socket closed"));
  socket.on("error", err => console.log("Socket error:", err.message));
});

server.on("error", err => console.log("Server error:", err.message));

server.listen(PORT, HOST, () => {
  console.log(`CWP (framed) server running on ${HOST}:${PORT}`);
});

/* ---------- Protocol-specific payload parser ----------
   We assume the payload content uses your CWP textual format
   already (meta line + headers + blank line + payload body).
   The framing layer already removed ambiguity about boundaries.
---------------------------------------------------------*/
function processPayload(payload, socket) {
  // For debugging:
  // console.log("Received payload:\n", payload);

  // Expecting payload format like:
  // metaLine\nHeaderA: value\nHeaderB: value\n\n<actual-body-text-or-b64-or-binary-decoded-elsewhere>
  // Meta line example: CWP1|02|CMD|5

  // Split header section and body by the double newline marker
  const splitIdx = payload.indexOf("\n\n");
  if (splitIdx === -1) {
    safeWrite(socket, buildErrorPacket("NO_PAYLOAD_SECTION"));
    return;
  }

  const headerSection = payload.slice(0, splitIdx);
  const bodySection = payload.slice(splitIdx + 2); // after \n\n

  // First line of headerSection is metaLine
  const firstNewline = headerSection.indexOf("\n");
  const metaLine = firstNewline === -1 ? headerSection : headerSection.slice(0, firstNewline);
  const headersRaw = firstNewline === -1 ? "" : headerSection.slice(firstNewline + 1);

  const metaParts = metaLine.split("|");
  if (metaParts.length < 4) {
    safeWrite(socket, buildErrorPacket("BAD_META"));
    return;
  }

  const [start, version, type, lengthStr] = metaParts;
  if (start !== "CWP1") {
    safeWrite(socket, buildErrorPacket("BAD_START"));
    return;
  }

  const expectedLen = Number(lengthStr);
  if (Number.isNaN(expectedLen)) {
    safeWrite(socket, buildErrorPacket("BAD_LENGTH_FIELD"));
    return;
  }

  // Validate body length (in characters). Because framing worked at byte level,
  // this check is about your textual protocol expectations.
  if (bodySection.length !== expectedLen) {
    console.log(`Len mismatch: got ${bodySection.length} expected ${expectedLen}`);
    safeWrite(socket, buildErrorPacket("BAD_LENGTH"));
    return;
  }

  // Parse headers into object (optional)
  const headers = {};
  if (headersRaw.trim().length > 0) {
    headersRaw.split("\n").forEach(line => {
      const idx = line.indexOf(":");
      if (idx !== -1) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        headers[k] = v;
      }
    });
  }

  // Now handle the command types
  if (type === "CMD") {
    // Example command handling
    if (bodySection === "HELLO") {
      // Build a response payload (we must frame it before writing)
      const respBody = "WELCOME";
      const respPayload = buildPayload("RES", respBody, { "Server": "CWP" });
      safeWriteFramed(socket, respPayload);
    } else {
      const respBody = "UNKNOWN";
      const respPayload = buildPayload("ERR", respBody, { "Reason": "UnknownCommand" });
      safeWriteFramed(socket, respPayload);
    }
  } else {
    safeWrite(socket, buildErrorPacket("UNKNOWN_TYPE"));
  }
}

/* ---------- Helpers ---------- */

// Build the textual payload using meta/header/body format used earlier
function buildPayload(type, bodyText, headerObj = {}) {
  // bodyText is a plain string. length is character length (you can adjust to bytes if needed)
  const length = bodyText.length;
  const meta = `CWP1|02|${type}|${length}`;
  // build headers lines
  const headers = Object.entries(headerObj).map(([k, v]) => `${k}: ${v}`).join("\n");
  const headerSection = headers.length ? `${meta}\n${headers}` : `${meta}`;
  return `${headerSection}\n\n${bodyText}`;
}

// Write already-constructed payload (string) as length-prefixed frame
function safeWriteFramed(socket, payloadStr) {
  if (socket.destroyed) return;
  const payloadBuf = Buffer.from(payloadStr, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payloadBuf.length, 0);
  const frame = Buffer.concat([lenBuf, payloadBuf]);
  socket.write(frame);
}

// Convenience for sending an error as a non-framed (fallback) short message
function buildErrorPacket(code) {
  // This returns payload string (unframed) for legacy safeWrite use
  const body = code;
  return `CWP1|02|ERR|${body.length}\n\n${body}`;
}

// Safe write (non-framed) — prefer framed writes for normal responses
function safeWrite(socket, msg) {
  if (!socket.destroyed) socket.write(msg);
}
