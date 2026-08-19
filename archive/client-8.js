import net from "node:net";

const client = new net.Socket();

function checksum(str) {
    return str.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
}

client.connect(4000, "127.0.0.1", () => {
    console.log("Connected to server");

    send("CMD", "PING");
    send("CMD", "HELLO"); // will return UNKNOWN
    send("CMD", "PING");
});

client.on("data", data => console.log("Server replied:", data.toString()));
client.on("error", err => console.log("Client error:", err.message));

function send(type, payload) {
    const len = payload.length;
    const cs = checksum(payload);
    const packet = `CWP1|04|${type}|${len}|${cs}|${payload};`;
    client.write(packet);
}
