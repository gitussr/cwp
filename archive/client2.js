import net from 'node:net';

const client = new net.Socket();

client.connect(5000, "127.0.0.1", () => {
    console.log("Connected to server");

    sendPacket("CMD", "HELLO", {
        Device: "PC",
        Auth: "None"
    });

});

client.on("data", (data) => {
    console.log("Server replied:", data.toString());
});

// --- NEW: Helper Function to Build & Send Packets ---
function sendPacket(type, payload, headers = {}) {
    const length = payload.length;

    let headerLines = "";
    for (const [k, v] of Object.entries(headers)) {
        headerLines += `${k}:${v}\n`;
    }

    const packet =
`CWP1|02|${type}|${length}
${headerLines}
${payload};`;

    client.write(packet);
}
