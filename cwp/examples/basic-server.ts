import { CwpServer } from "../src/index.ts";

const PORT = Number(process.env.PORT ?? 5000);

const server = new CwpServer({ sessionTtlMs: 30_000 });

// Register a custom command on top of the built-ins (HELLO, ECHO, TIME).
server.command("REVERSE", (payload) => payload.split("").reverse().join(""));

await server.listen(PORT);
console.log(`CWP server listening on port ${PORT} (Ctrl+C to stop)`);

// Graceful shutdown — the same pattern you'd want behind an AWS ALB/NLB or
// in an ECS task: stop accepting new work, let in-flight work settle, exit.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  });
}
