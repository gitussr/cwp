import net from "net";

const server = net.createServer(socket => {
    console.log("Client connected!");

    let buffer = "";  // Buffer to hold incoming data
    let expectedLength = null; // Expected length of the next message

    // ---------------------------------------------------- 

    // CHAPTER 6 — THE FRAMING BOX
    socket.on("data", chunk =>{
        buffer += chunk.toString();
        // keep processing as long as we have enough data
        processBuffer(socket, buffer, expectedLength);
    });

    // Socket end and close handlers
    socket.on("end", () =>{
        console.log("Client disconnected (end)");
    });

    socket.on("close", () => {
        console.log("Socket closed");
    });

    // Prevent server-level crashes too
    socket.on("error", (err) => {
        console.log("Socket error:", err.message);
    });
})

// ----------------------------------------------------
function processBuffer(socket, buffer, expectedLength) {
    while (true) {
        // STEP 1. If we don't yet know expected length, try to read it
        if(expectedLength === null) {
            const newlineIndex = buffer.indexOf("\n");
            if(newlineIndex === -1) {
                // Not enough data yet to read length
                return;
            }

            // Extract length line and parse it
            const lengthStr = buffer.slice(0, newlineIndex); // e.g. "123"
            expectedLength = Number(lengthStr); // Convert to number
            buffer = buffer.slice(newlineIndex + 1); // Remove length line from buffer. 
        }

        // STEP 2: Check if we have nough body data
        if(buffer.length < expectedLength){
            return; // Wait for more data
        }

        // STEP 3: Extract exact message of expected length
        const message = buffer.slice(0, expectedLength);
        buffer = buffer.slice(expectedLength); // Remove processed message from buffer
        expectedLength = null; // Reset for next message

        // STEP 4: Process the complete message
        handleMessage(socket, message);
    }
}

// ----------------------------------------------------

// YOUR PROTOCOL-SPECIFIC MESSAGE HANDLER

// ----------------------------------------------------
function handleMessage(socket, message) {
    console.log("Received complete message:\n", message);
    // Here you would parse and respond to the message as per your protocol

    // Simple commands for demonstration
    if(message === "PING") {
        sendFrame(socket, "PONG");
    }else{
        sendFrame(socket, "UNKNOWN COMMAND");
    }
}

// ----------------------------------------------------
// FRAME BUILDER    
// ----------------------------------------------------

function sendFrame(socket, payload){
    const length = payload.length;
    const frame = `${length}\n${payload}`;
    socket.write(frame);
}


// ----------------------------------------------------
server.listen(4000, () => {
    console.log("CWP server (Chapter 6) running on port 4000");
});

