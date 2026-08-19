import net from "node:net";

const server = net.createServer(socket => {
    console.log("Client connected!");

    let buffer = "";

    socket.on("data", chunk => {
        buffer += chunk.toString();

        let end;
        while ((end = buffer.indexOf(";")) !== -1) {
            const fullPacket = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);

            processPacket(fullPacket, socket);
        }
    });

    socket.on("end", () => console.log("Client ended connection"));
    socket.on("close", () => console.log("Socket fully closed"));
    socket.on("error", err => console.log("Socket error:", err.message));
});

server.on("error", err => console.log("Server error:", err.message));


// ----------------------------------------------------
// PACKET PROCESSING
// ----------------------------------------------------
function processPacket(packet, socket) {
    // Split into header section and payload
    const [headerSection, payload] = packet.split("\n\n");

    if (!payload) {
        safeWrite(socket, "CWP1|02|ERR|14\nReason:NoPayload\n\n;");
        return;
    }

    // First line of headerSection = meta line
    const firstLineEnd = headerSection.indexOf("\n");
    const metaLine = headerSection.slice(0, firstLineEnd);
    const headersRaw = headerSection.slice(firstLineEnd + 1);

    const [start, version, type, lengthStr] = metaLine.split("|");

    if (start !== "CWP1") {
        safeWrite(socket, "CWP1|02|ERR|12\nReason:BadStart\n\n;");
        return;
    }

    const expectedLength = Number(lengthStr);

    if (payload.length !== expectedLength) {
        safeWrite(socket, "CWP1|02|ERR|13\nReason:BadLength\n\n;");
        return;
    }

    // Parse headers (optional)
    const headers = {};
    if (headersRaw.trim().length > 0) {
        for (let line of headersRaw.split("\n")) {
            let [key, value] = line.split(":");
            if (key && value) headers[key.trim()] = value.trim();
        }
    }

    // ----------------------------------------------------
    // COMMAND HANDLING
    // ----------------------------------------------------
    if (type === "CMD") {
        if (payload === "HELLO") {
            const body = "WELCOME";
            const reply = 
`CWP1|02|RES|${body.length}
Server: OK

${body};`;

            safeWrite(socket, reply);
        } else {
            const body = "UNKNOWN";
            const reply =
`CWP1|02|ERR|${body.length}
Reason: NotSupported

${body};`;

            safeWrite(socket, reply);
        }
    }
}


// Safe write wrapper
function safeWrite(socket, msg) {
    if (!socket.destroyed) socket.write(msg);
}

server.listen(5000, "0.0.0.0", () => {
    console.log("CWP1 Protocol v2 Server running on port 5000");
});
