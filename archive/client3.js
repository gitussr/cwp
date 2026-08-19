import net from "node:net";

const client = new net.Socket();

client.connect(5000, "127.0.0.1", () => {
    console.log("Connected to server");

    sendPacket("CMD", "HELLO", {
        "Client": "Codeworm",
        "Mode": "Test"
    });

    sendPacket("CMD", "This is a longer message for testing", {
        "Client": "Codeworm"
    });
});

client.on("data", data => {
    console.log("Server replied:\n" + data.toString());
});

client.on("error", err => {
    console.log("Client error:", err.message);
});


// ----------------------------------------------------
// PACKET BUILDER (Chapter 5 Style)
// ----------------------------------------------------
function sendPacket(type, payload, headers = {}) {
    const length = payload.length;

    let headerLines = "";
    for (let key in headers) {
        headerLines += `${key}: ${headers[key]}\n`;
    }

    const packet =
`CWP1|02|${type}|${length}
${headerLines}
${payload};`;

    client.write(packet);
}
