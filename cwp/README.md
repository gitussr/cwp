# CWP — Codeworm Wire Protocol

A small, real TCP application protocol, implemented properly: binary length-prefixed
framing, session handshakes with replay-proof sequence numbers, CRC-32 integrity
checking, a promise-based client, graceful shutdown, and a test suite that actually
tries to break it.

This isn't a toy that "looks like" a protocol — it's a working one you can run two
copies of right now and watch talk to each other over a real socket. It exists to be
read, run, and picked apart.

> The `../archive/` folder next to this one holds the earlier prototypes this was
> built from — a dozen small `server*.js`/`client*.js` chapters that each explored one
> idea (delimiter framing, headers, length-prefixing, handshakes, checksums) but had
> real bugs and no tests. This folder is what happens when you take every one of those
> ideas and build them correctly, together, as one thing.

## Quick start

```bash
npm install         # only dev dependencies: typescript, @types/node
npm test             # runs the full test suite (Node's built-in test runner)
npm run typecheck    # tsc --noEmit

# in one terminal
npm run server
# in another
npm run client
```

Nothing here needs a build step to run — `node --experimental-strip-types` (built into
Node 22.6+) executes the `.ts` source directly. `npm run build` / `npm run
start:server` / `npm run start:client` exist if you want a compiled `dist/` you could
actually deploy.

## What's actually happening here

TCP gives you a stream of bytes with no concept of "messages" — if you write `HELLO`
then `WORLD` to a socket, the other end might see `HELLOWORLD` in one read, `HE` then
`LLOWORLD` in two, or `HELLO` and `WORLD` separately. Every one of the old prototype
chapters in `../archive/` exists to answer one question: **how do you turn that raw
byte stream back into the discrete messages the sender meant to send?** This project
answers it once, correctly, and then builds a small but real application protocol on
top of the answer.

### The wire format

Every CWP frame looks like this on the wire (all integers big-endian):

```
┌─────────────┬───────┬─────────┬──────┬────────────┬──────────┬─────────┬──────┬───────┐
│ outerLength │ magic │ version │ type │ headerLen  │ bodyLen  │ headers │ body │ crc32 │
│   4 bytes   │ 1byte │  1 byte │1 byte│  4 bytes   │ 4 bytes  │ N bytes │M bytes│4 bytes│
└─────────────┴───────┴─────────┴──────┴────────────┴──────────┴─────────┴──────┴───────┘
                ▲                                     ▲          ▲
                │                                      │          └─ UTF-8 JSON, e.g. {"session":"..","seq":"3"}
                │                                      └─ length of the headers block, in bytes
                └─ sanity byte (0xC5); catches "this isn't even CWP" instantly
```

`outerLength` is the whole point: the receiver reads 4 bytes, now knows *exactly* how
many more bytes make up this frame, and can wait for precisely that many before
touching anything else. That one field is what turns "an arbitrary stream of bytes"
back into "a sequence of discrete frames" — see [`src/protocol/frame.ts`](src/protocol/frame.ts)
(encode/decode a single frame) and [`src/protocol/framer.ts`](src/protocol/framer.ts)
(the stateful buffer that handles a frame arriving split across many reads, or several
frames arriving in one read — both happen constantly on a real network).

On top of that framing, CWP defines a tiny application protocol:

1. **Handshake** — client sends `HSK`, server creates a session and replies `HSK_ACK`
   with a `session` id in the headers.
2. **Commands** — client sends `CMD` with `session`, `seq` (must be exactly
   "last seq + 1"), and `command` headers, plus a body. Server replies `RES` (success)
   or `ERR` (with an error `code` header — `UNKNOWN_COMMAND`, `BAD_SEQUENCE`,
   `SESSION_EXPIRED`, etc).
3. **Ping** — either side can send `PING` and expects `PONG` back, independent of any
   session — a bare liveness check, the same idea as a TCP keepalive or a WebSocket
   ping frame.

### Where the project structure comes from

```
src/protocol/   the wire format itself — framing, checksums, errors. No sockets here.
src/server/     CwpServer (accepts connections, routes commands), SessionStore, router
src/client/     CwpClient — promise-based wrapper around one socket
test/           unit tests per layer + one integration suite over a real loopback socket
examples/       a runnable server and client using the public API
```

`src/protocol` doesn't import `node:net` at all — framing is pure buffer-in,
buffer/frames-out logic, independent of sockets. That's deliberate: it means the
hardest-to-get-right part (byte-exact parsing, partial-chunk handling, checksum
verification) is unit-testable in microseconds with no real network involved, and the
server/client layers can't accidentally couple "how do I parse a frame" to "how do I
manage a socket."

## What you can learn from this, as a fullstack developer

You spend most of your time at the HTTP layer, where framing, connection reuse, and
message boundaries are all handled for you by the browser, `fetch`, and your web
framework. This project is what's underneath that abstraction:

- **HTTP has this exact problem, solved the same way.** `Content-Length` (or chunked
  transfer encoding) is HTTP's version of `bodyLen` here — it's how a browser knows a
  response is complete rather than just "the server paused for a bit." Once you've
  written `tryDecodeFrame`, HTTP parsing stops looking like magic.
- **The `data` event is not "one message."** `socket.on("data", chunk => ...)` hands
  you whatever bytes the kernel happened to have ready — not what the sender wrote in
  one call. `FrameDecoder` exists because of this; see `test/framer.test.ts` for the
  fragmentation/coalescing cases it has to handle. This is the single most common bug
  in hand-rolled TCP/WebSocket code, including in production JS services.
- **Backpressure is real and `socket.write()` tells you about it.** `write()` returns
  `false` when the kernel's send buffer is full (`CwpServer#write`) — the same signal
  Node streams use everywhere (`res.write()` in Express, file streams, etc). Ignoring
  it is how you build a service that slowly eats memory under load.
- **A Promise-based client over an event-based transport needs correlation IDs.**
  `CwpClient` turns `data` events into resolved/rejected Promises by matching each
  response's `seq` header back to the request that sent it (`#pendingRequests`, a
  `Map<seq, {resolve, reject}>`). This is the exact pattern behind `fetch`, database
  drivers, and RPC clients (gRPC, JSON-RPC) — a request goes out, an ID goes with it,
  a response comes back on the same connection out of order relative to other
  in-flight requests, and something has to match them back up. `test/…integration…ts`
  has a pipelining test that specifically proves three concurrent requests resolve to
  their own responses, not each other's.
- **Never trust a length field from the network.** `MAX_FRAME_SIZE` caps how big a
  frame we'll ever agree to buffer, checked the instant we've read just the 4-byte
  length prefix — before waiting for the rest. Without this, a buggy or hostile peer
  can send a length of `0xFFFFFFFF` and get you to try to allocate 4GB. Same idea as
  a file upload size limit or an API Gateway payload cap.
- **Typed errors that cross a boundary need a stable shape.** `ProtocolError` +
  `ErrorCode` is a small version of what a real API's error envelope does — a stable
  machine-readable `code` plus a human `message`, instead of throwing raw strings.

## What you can learn from this, as a junior AWS engineer

Everything AWS runs on top of is TCP (or UDP) underneath — a Network Load Balancer, a
security group, an ECS task, RDS's wire protocol — this project is a hands-on version
of the layer those services all sit on:

- **`server.listen(port, "0.0.0.0")` is exactly what a security group's inbound rule
  is gating.** Binding to `0.0.0.0` means "accept on any interface" — in EC2/ECS terms,
  that's the port your security group needs to open, and the load balancer's health
  check target. Try changing the host to `127.0.0.1` and you'll see connections from
  anywhere else refused — that's the same failure mode as a misconfigured security
  group or a container listening on the wrong interface.
- **`SessionStore` is in-memory — and that's a real, important limitation to
  recognize.** It works great for one process. The moment you run two copies of this
  server behind a load balancer, a client's session lives on whichever instance
  handled the handshake, and a request routed to the *other* instance gets
  `UNKNOWN_SESSION`. This is precisely why real systems put session state in
  **DynamoDB** or **ElastiCache (Redis)** instead of a process-local `Map` — and why
  ALB has "sticky sessions" as a workaround (with its own trade-offs) for services
  that haven't externalized state yet. Recognizing "this state lives in one process"
  as a scaling problem — before it becomes an incident — is a core skill.
- **The idle-session sweep is the same idea as DynamoDB TTL / a Redis `EXPIRE`.**
  `SessionStore`'s background `setInterval` that evicts sessions idle past `ttlMs` is
  a hand-rolled version of what those managed services give you for free. Building it
  once by hand makes it obvious why "just set a TTL attribute" in DynamoDB is such a
  useful primitive — you're not writing this sweep loop yourself anymore.
- **CRC-32 here is the same category of thing as S3's checksum features.** We use
  CRC-32 (via Node's built-in `zlib.crc32`) to detect corrupted frames. S3 and
  DynamoDB offer/require checksums on objects and records for the same reason:
  detecting bit-level corruption in transit or at rest, before it becomes a customer
  problem. (AWS's own services default to **CRC32C**, a different polynomial — noted
  here so you recognize the name; swapping the algorithm wouldn't change anything else
  about this design.)
- **`CwpServer#close()` closing every open socket, not just refusing new ones, is
  connection draining.** `server.close()` alone only stops *accepting new*
  connections; it does nothing about sockets already open. That's exactly the
  distinction between an ALB/NLB deregistering a target (stop sending it new traffic)
  and actually terminating in-flight connections — and it's why ECS/Fargate gives a
  task a grace period on `SIGTERM` before `SIGKILL`. `examples/basic-server.ts` wires
  `SIGINT`/`SIGTERM` to `server.close()` for exactly this reason — it's the same
  handler shape your Dockerfile'd Node service needs to shut down cleanly in ECS.
- **There's no TLS here, on purpose — notice what that costs you.** Every frame,
  including the session id, is plaintext on the wire. In AWS terms, this is the
  "before" picture: normally an ALB/NLB terminates TLS (via an ACM certificate) or you
  run mutual TLS between services in a mesh. Reading this protocol without TLS makes
  it obvious *why* that termination step exists — trace through what a
  packet-capturing attacker on the same network would see.
- **The sequence-number check (`BAD_SEQUENCE`) is a minimal replay guard.** Real AWS
  APIs (SigV4-signed requests) use timestamps + nonces for the same purpose: reject a
  captured, replayed request. Seeing the simplest possible version of that check
  (`seq !== expectedSeq + 1`) makes the "why" behind SigV4's more elaborate scheme
  much less abstract.

## Design decisions worth noticing

- **CRC-32 via `node:zlib`, not hand-rolled.** Node has shipped a native `crc32()` in
  `zlib` since v21.7 — using it instead of a hand-written lookup-table implementation
  removes an entire, easy-to-get-subtly-wrong chunk of bit-twiddling code from this
  project for free. See `src/protocol/crc32.ts`.
- **Frames are self-contained; connection/session lifecycle is layered on top, not
  baked into framing.** `frame.ts`/`framer.ts` know nothing about sessions, commands,
  or sockets — only "bytes in, validated frame out." `CwpServer` and `CwpClient` are
  the only places that know what a session or a command *means*. This is the same
  separation HTTP has between "parse the request line and headers" and "route to a
  handler" — keeping them apart is what makes each side unit-testable in isolation.
- **`as const` objects instead of TypeScript `enum`.** Node's native TypeScript
  support (`--experimental-strip-types`) only erases type syntax — it can't compile
  TS-only runtime constructs like `enum`. Using `as const` objects + a derived type
  (see `src/protocol/constants.ts`) works both under `tsc` and running the `.ts`
  source directly with zero build step, which is why this project needs no bundler or
  compiler to develop against.

## Testing approach

`npm test` runs Node's built-in test runner (`node:test` + `node:assert/strict`) —
zero extra dependencies to install just to run tests. Four layers, cheapest/most
isolated first:

- `test/crc32.test.ts` — checksum correctness against a known test vector.
- `test/frame.test.ts` — single-frame encode/decode round-trips, and every way a
  frame can be corrupt (bad magic, bad version, flipped bytes, malformed JSON
  headers, an announced size that's too large).
- `test/framer.test.ts` — the streaming/buffering behavior: a frame split across many
  small chunks, several frames coalesced into one chunk, a chunk boundary landing
  exactly on a frame boundary, corrupted data.
- `test/session-store.test.ts` — sequence validation, replay/skip rejection, TTL
  expiry (both on-touch and via the background sweep), and that `close()` actually
  stops the sweep timer (otherwise a long-running test suite accumulates dangling
  timer handles).
- `test/server-client.integration.test.ts` — a real `CwpServer` bound to an ephemeral
  port (`listen(0, ...)`), talked to with a real `CwpClient` over real loopback TCP:
  the full handshake→command→response flow, concurrent independent sessions,
  pipelined requests, and — using raw sockets to bypass the well-behaved client on
  purpose — what happens when a peer sends an out-of-order sequence number, an unknown
  session, or a structurally corrupt frame. That last case is the important one: it
  proves one bad connection can't take the server down for anyone else.
