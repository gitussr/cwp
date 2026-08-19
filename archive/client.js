import net from 'node:net';

const client = new net.Socket();

client.connect(5000, "127.0.0.1", () => {
    console.log("Connected to server");

    // NOW: You can just send the message. The function calculates the length.
    sendPacket("CMD", "HELLO"); 
    
    // Example: Sending a longer message dynamically
   sendPacket("CMD", "This is a much longer message which implies dynamic length");
    
    // Example: Sending a message with pipes (works with our previous fix)
    //sendPacket("CMD", "User|Admin|Guest");
});

client.on("data", (data) => {
    console.log("Server replied:", data.toString());
});

// --- NEW: Helper Function to Build & Send Packets ---
function sendPacket(type, payload) {
    // 1. Calculate length automatically
    const length = payload.length;

    // 2. Optional: Pad with zeros if you want strictly 2 digits (e.g., "05")
    // But your server accepts "5" just fine, so raw length is okay too.
    // const lengthStr = length.toString().padStart(2, '0'); 
    
    // 3. Construct the string using Template Literals
    const packet = `CWP1|01|${type}|${length}|${payload};`;

    // 4. Send it
    client.write(packet);
}