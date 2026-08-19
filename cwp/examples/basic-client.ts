import { CwpClient } from "../src/index.ts";

const PORT = Number(process.env.PORT ?? 5000);

const client = new CwpClient({ host: "127.0.0.1", port: PORT });

await client.connect();
console.log("Connected to server");

const sessionId = await client.handshake();
console.log("Handshake complete, session:", sessionId);

await client.ping();
console.log("PING -> PONG ok");

console.log("HELLO   ->", await client.sendCommand("HELLO"));
console.log("ECHO    ->", await client.sendCommand("ECHO", "hello from the client"));
console.log("TIME    ->", await client.sendCommand("TIME"));
console.log("REVERSE ->", await client.sendCommand("REVERSE", "codeworm"));

try {
  await client.sendCommand("NOPE");
} catch (err) {
  console.log("Expected error for an unknown command:", (err as Error).message);
}

await client.close();
console.log("Done.");
