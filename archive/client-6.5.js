import net from "node:net";

const client = new net.Socket();

client.on("error", (err) => console.log("Client error:", err.message));
client.on("close", () => console.log("Client closed"));

client.connect(4000, "127.0.0.1", () => {
    console.log("Connected to server");

    send("PING");
    send("HELLO");
    send("TIME");
    send("ECHO:Hello there!");
});

client.on("data", data => {
    console.log("Server replied:\n", data.toString());
});

function send(payload){
    const length = payload.length;
    const frame = `CPW1|03|CMD|${length}|${payload};`;
    client.write(frame);
}