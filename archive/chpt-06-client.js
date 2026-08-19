import net from "node:net";

const client = new net.Socket();

let buffer = "";
let expectedLength = null;

client.connect(4000, "127.0.0.1", () => {
    console.log("Connected to server");

    // Send a framed message
    sendFrame("PING");
    sendFrame("This is a long body");
});

client.on("data", chunk => {
    buffer += chunk.toString();

    processBuffer();
});

client.on("error", err => {
    console.log("Client error:", err.message);
});

// ----------------------------------------------------
// PROCESS INCOMING FRAMED DATA
// ----------------------------------------------------

function processBuffer(){
    while(true){
        // STEP 1: If we don't yet know expected length, try to read it
        if(expectedLength === null){
            const newLine = buffer.indexOf("\n");
            if (newLine === -1) return; // Not enough data yet

            expectedLength = Number(buffer.slice(0, newLine));
            buffer = buffer.slice(newLine + 1);
        }

        if(buffer.length < expectedLength) return; // Wait for more data

        // STEP 3: Extract exact message of expected length
        const message = buffer.slice(0, expectedLength);
        buffer = buffer.slice(expectedLength); // Remove processed message from buffer
        expectedLength = null; // Reset for next message

        console.log("Server replied (framed):\n", message);
    }
}

// ----------------------------------------------------
// SEND FRAMED MESSAGE
// ----------------------------------------------------
 function sendFrame(body){
    const length = Buffer.byteLength(body, "utf8");
    const frame = `${length}\n${body}`;
    client.write(frame);
 }