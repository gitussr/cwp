// ----------------------------------------------------
// SIMPLE TCP SERVER WITH CUSTOM PROTOCOL HANDLING
// ----------------------------------------------------

import net from "node:net";

const PORT = 4000;

const server = net.createServer(socket => {
    console.log("Client connected!");
    let buffer = "";  // Buffer to hold incoming data

    socket.on("data", chunk => {
        buffer += chunk.toString();

        // Framing loop
        let end;
        while((end = buffer.indexOf(";")) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 1); // Remove processed frame from buffer
            
            handleFrame(frame, socket);
        }   
    });

    socket.on("end", () => console.log("Client disconnected (end)"));

    socket.on("close", () => console.log("Socket closed")); 

    socket.on("error", err => {
        console.log("Socket error:", err.message);
    });
});




// ----------------------------------------------------
// HANDLE A COMPLETE FRAME
// ----------------------------------------------------

function handleFrame(frame, socket) {
    console.log("Received frame:", frame);  
    // Expect -> CWP1|03|TYPE|LEN|PAYLOAD
    const parts = frame.split("|");
    if(parts.length < 5) return reply(socket, "ERR", "BAD_PACKET");

    const [start, version, type, lengthStr, payload] = parts;
    if(start !== "CPW1") return reply(socket, "ERR", "BAD_START");

    if(version !== "03") return reply(socket, "ERR", "BAD_VERSION");

    if(payload.length !== Number(lengthStr)) return reply(socket, "ERR", "BAD_LENGTH");

    if(type !== "CMD") return reply(socket, "ERR", "UNSUPPORTED_TYPE");

    // Routing Here
    routeCommand(payload, socket);

}

// ----------------------------------------------------
// ROUTE COMMAND
// ----------------------------------------------------

function routeCommand(cmd, socket) {

    if(cmd === "PING") return reply(socket, "RES", "PONG");
    if(cmd === "HELLO") return reply(socket, "RES", "WORLD");

    if(cmd === "TIME"){
        const now = new Date().toISOString();
        return reply(socket, "RES", now);
    }

    // ECHO:Something
    if(cmd.startsWith("ECHO:")){
        const msg = cmd.slice(5);
        return reply(socket, "RES", msg);
    }

    return reply(socket, "ERR", "UNKNOWN_COMMAND");

}

// ----------------------------------------------------
// SEND REPLY
// ----------------------------------------------------

function reply(socket, type, payload) {
    const length = payload.length;
    const frame = `CPW1|03|${type}|${length}|${payload};`;
    socket.write(frame);
}

// ----------------------------------------------------
// START SERVER
// ----------------------------------------------------

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});