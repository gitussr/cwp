// CWP Server (Chapter 8) - Packet Framing with Delimiters
import net from "node:net";

const server = net.createServer(socket => {
    console.log("Client connected!");

    let buffer = "";

    socket.on("data", chunk => {
        buffer += chunk.toString();

        let end;
        while ((end = buffer.indexOf(";")) !== -1) {
            const packet = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            processPacket(packet, socket);
        }
    });

    socket.on("end", () => console.log("Client disconnected"));
    socket.on("error", err => console.log("Socket error:", err.message));
});

function checksum(str) {
    return str.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
}

function processPacket(packet, socket) {
    const parts = packet.split("|");
    if (parts.length < 6) {
        return socket.write("CWP1|04|ERR|11|0|BAD_PACKET;");
    }

    const [start, version, type, len, cs, ...rest] = parts;
    const payload = rest.join("|");

    if (start !== "CWP1") return socket.write("CWP1|04|ERR|12|0|BAD_START;");

    if (payload.length !== Number(len))
        return socket.write("CWP1|04|ERR|13|0|BAD_LENGTH;");

    const expectedChecksum = checksum(payload);
    if (expectedChecksum !== Number(cs))
        return socket.write("CWP1|04|ERR|14|0|BAD_CHECKSUM;");

    // command routing
    if (type === "CMD" && payload === "PING") {
        send(socket, "RES", "PONG");
    } else {
        send(socket, "ERR", "UNKNOWN");
    }
}

function send(socket, type, payload) {
    const len = payload.length;
    const cs = checksum(payload);
    socket.write(`CWP1|04|${type}|${len}|${cs}|${payload};`);
}

server.listen(4000, () => console.log("CWP server (Chapter 8) running on 4000"));
