import net from "node:net";

const server = net.createServer(socket => {
    console.log("Client connected!");

    let buffer = "";

    socket.on("data", chunk => {
        buffer += chunk.toString();
console.log(buffer);
        let end;
        while ((end = buffer.indexOf(";")) !== -1) {
            const packet = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            
            processPacket(packet, socket);
        }
    });

    // --- NEW: client gracefully closes connection ---
    socket.on("end", () => {
        console.log("Client disconnected (end)");
    });

    // --- NEW: socket fully destroyed ---
    socket.on("close", () => {
        console.log("Socket closed");
    });

    // --- NEW: prevent crash from ECONNRESET or write on closed socket ---
    socket.on("error", (err) => {
        console.log("Socket error:", err.message);
        // DO NOT throw new Error(...) — otherwise server crashes
    });
});

// Prevent server-level crashes too
server.on("error", (err) => {
    console.log("Server error:", err.message);
});

function processPacket(packet, socket) {
    // Split into header+payload sections
    const [headerSection, payloadSection] = packet.split("\n\n");

    if (!payloadSection) {
        safeWrite(socket, "CWP1|02|ERR|14|NO_PAYLOAD;");
        return;
    }

    // FIRST line = protocol header
    const firstLineEnd = headerSection.indexOf("\n");
    const metaLine = headerSection.slice(0, firstLineEnd);
    const headersRaw = headerSection.slice(firstLineEnd + 1);

    // Parse meta line: CWP1|02|CMD|05
    const [start, version, type, length] = metaLine.split("|");

    if (start !== "CWP1") {
        safeWrite(socket, "CWP1|02|ERR|12|BAD_START;");
        return;
    }

    // Parse headers
    const headers = {};
    if (headersRaw.trim().length > 0) {
        const headerLines = headersRaw.split("\n");
        for (let line of headerLines) {
            const [key, value] = line.split(":");
            if (key && value) headers[key.trim()] = value.trim();
        }
    }

    // Extract payload (before ;)
    const payload = payloadSection.replace(";", "");

    // Length check
    if (payload.length !== Number(length)) {
        safeWrite(socket, "CWP1|02|ERR|13|BAD_LENGTH;");
        return;
    }

    // COMMAND HANDLING
    if (type === "CMD") {
        if (payload === "HELLO") {
            safeWrite(socket, "CWP1|02|RES|07\nServer:OK\n\nWELCOME;");
        } else {
            safeWrite(socket, "CWP1|02|ERR|15\nReason:Unknown\n\nUNKNOWN;");
        }
    }
}


// --- NEW: Safe write wrapper to avoid "write after end" crash ---
function safeWrite(socket, msg) {
    if (!socket.destroyed) {
        socket.write(msg);
    }
}

server.listen(5000, "0.0.0.0", () => {
    console.log("CWP server running on 5000");
});
