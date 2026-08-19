# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

- `cwp/` — the real, current implementation: **CWP/1 (Codeworm Wire Protocol)**, a TypeScript TCP protocol library with binary length-prefixed framing, session handshakes, sequence-number replay protection, CRC-32 integrity checks, and a full test suite. This is where new work happens. See `cwp/README.md` for the wire format, architecture, and a guided tour of what it teaches (aimed at fullstack devs and junior AWS engineers).
- `archive/` — the original chapter-by-chapter JS prototypes this was built from (naive delimiter framing → headers → length-prefixed framing → handshake/sessions → checksums). Kept for history only; not maintained, not imported by anything in `cwp/`. Don't edit these unless the user is specifically asking about the history/evolution of the protocol design.

## Working in `cwp/`

```
cd cwp
npm install           # dev-only deps: typescript, @types/node
npm test               # node:test — runs the full suite (unit + real-socket integration)
npm run typecheck      # tsc --noEmit
npm run server          # runs examples/basic-server.ts directly (no build step)
npm run client           # runs examples/basic-client.ts directly
npm run build            # tsc -> dist/ (only needed if you want compiled output to deploy)
```

Source runs directly via `node --experimental-strip-types` (Node 22.6+) — no bundler, no compile step for day-to-day dev. `tsc --noEmit` is the type-checker; `tsc` (the `build` script) is only for producing a deployable `dist/`.

**To run a single test file directly:** `node --experimental-strip-types --test test/frame.test.ts` from inside `cwp/`. Node's `--test` flag needs either zero path arguments (recursive auto-discovery — what `npm test` uses) or literal file paths; a bare directory argument (`--test test/`) does **not** reliably discover files on this Node version — don't use that form.

**TypeScript constraint that matters here:** Node's native TS support only *erases* type syntax; it does not compile TS-only runtime constructs. Real `enum` is not supported (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) — this codebase uses `as const` objects + a derived type instead (see `src/protocol/constants.ts`). Don't reintroduce `enum`, parameter-property constructor shorthand, or namespaces with runtime code — keep new TS "erasable-syntax-only."

## Architecture (`cwp/src/`)

- `protocol/` — the wire format itself (`frame.ts` encode/decode, `framer.ts` stateful stream buffering, `crc32.ts`, `constants.ts`, `errors.ts`). Deliberately has **no** dependency on `node:net` — pure buffer-in/frame-out logic, unit-testable without a real socket.
- `server/` — `CwpServer` (accepts connections, runs the handshake/command protocol), `SessionStore` (in-memory sessions with TTL + background sweep), `router.ts` (command name → handler registry).
- `client/` — `CwpClient`, a promise-based wrapper around one socket that correlates responses back to requests via the `seq` header.

Keep that separation when extending the protocol: wire-format changes belong in `protocol/`; anything that knows what a session or command *means* belongs in `server/`/`client/`. Every new frame field or message type needs both `frame.ts` (encode) and the corresponding decode path updated together, plus a `frame.test.ts`/`framer.test.ts` case for how it behaves when split across chunks or corrupted.
