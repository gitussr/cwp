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
    // 1. Split by all pipes first
    const allParts = packet.split("|");

    // 2. Check if we have at least enough parts for the header
    // We need at least 5 parts (Start, Ver, Type, Len, Payload-Start)
    if (allParts.length < 5) {
        safeWrite(socket, "CWP1|01|ERR|13|BAD_PACKET;");
        return;
    }

    // 3. Extract headers manually
    const start = allParts[0];
    const version = allParts[1];
    const type = allParts[2];
    const length = allParts[3];

    // 4. RECONSTRUCT THE PAYLOAD
    // Take everything from index 4 onwards, and join them back with "|"
    const payload = allParts.slice(4).join("|");

    // --- The rest of your logic remains the same ---

    if (start !== "CWP1") {
        safeWrite(socket, "CWP1|01|ERR|12|BAD_START;");
        return;
    }

    // Now valid even if payload has a pipe!
    if (payload.length !== Number(length)) {
        // Debugging tip: log this if it fails to see what happened
        console.log(`Len mismatch: Got ${payload.length}, expected ${length}`);
        safeWrite(socket, "CWP1|01|ERR|13|BAD_LENGTH;");
        return;
    }

    if (type === "CMD") {
        if (payload === "HELLO") {
            safeWrite(socket, "CWP1|01|RES|07|WELCOME;");
        } else {
            safeWrite(socket, "CWP1|01|ERR|15|UNKNOWN;");
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
