# Project 2a implementation plans: index

Project 2a (server core) is split into three plans. Run them in order: each depends on the ones before it, and each ends with working, tested software.

| Plan | File | Delivers |
|---|---|---|
| A | `2026-10-11-p2a-a-engine-protocol-store.md` | Engine changes (event audiences, `characterWake`, `commandCharacters`, partial-state proof), `packages/protocol`, `apps/server` skeleton, Postgres schema and migrations, crypto, the `Store` |
| B | `2026-10-11-p2a-b-room-and-server.md` | Clock, `Room`, `RoomManager`, `Hub`, auth, rate limits, the Fastify app (HTTP and WebSocket), boot and the advisory lock, restart test, end-to-end golden test |
| C | `2026-10-11-p2a-c-cli.md` | `dndm server start / create-channel / migrate`, the client library, `dndm connect` (script and interactive), CI with Postgres |

**Spec:** `docs/superpowers/specs/2026-10-11-server-core-design.md` (rev 7). It builds on `2026-10-11-engine-and-packs-design.md` (rev 6).

## Running Postgres for tests

```bash
docker compose up -d postgres        # Postgres 17 on localhost:5455, user/password/db: dndm
export DATABASE_URL=postgres://dndm:dndm@localhost:5455/dndm
pnpm test
```

Tests that need Postgres create a fresh database per test file (`dndm_t_<random>`), run the migrations and drop it afterwards. Without a reachable Postgres they fail with a message that says to run the command above.

## Decisions the plans make that the spec leaves open

These are implementation choices, flagged so the owner can overrule them:

1. **`json`, not `jsonb`, for game data.** Postgres `jsonb` reorders object keys. The engine iterates some objects (inventory, equipped, cooldowns, the channel pack's content), so a reordered save could change event order after a reload and break the end-to-end golden test (spec §1.1 criterion 2). `characters.data`, `rooms.session`, `rooms.recent_requests` and `channels.config` use `json`, which keeps the text as written. Spec §3 says jsonb; nothing queries inside these columns.
2. **Libraries:** `postgres` (postgres.js) as the Postgres driver for Drizzle, and `@fastify/websocket` (built on `ws`) for WebSockets. The CLI client uses `ws` directly.
3. **Encounter audiences are stamped at four points**: an encounter kind's `start`, `respond`, `advance` (wake-up) and its end (`onEnd` plus the `core:encounter-ended` event). Events from reactions that run later, in `settle`, are not stamped and stay public. Spec §7.2 says "every event produced while handling that encounter … core events from `ctx` operations included": ctx operations run synchronously inside those four points, so they are covered.
4. **Two small engine helpers:** `engine.characterWake(game, id)` (the character's earliest timer, used for `wake_at` and the stay-loaded rule) and `commandCharacters(cmd)` (the character IDs a command names, used by the Room's load step).
5. **Tokens.** Dock and overlay tokens are 32 random bytes, base64url. They're encrypted with AES-256-GCM using `SHA-256(DNDM_SECRET)` as the key, and looked up by `SHA-256(token)` in hex. Viewer tokens (dev login) are `v1.<base64url(JSON)>.<base64url(HMAC-SHA256)>`, signed with a key derived from `DNDM_SECRET`.
6. **HTTP status codes** for error answers: `bad-command` 400, `unauthorized` 401, `forbidden` and `streamer-only` 403, `unknown-channel` 404, `stale-config` and `content-in-use` 409, `invalid-config` 422, `rate-limited` 429, `internal` 500, `save-failed` 503. Engine rejections are 200 with `ok: false`, because they are normal game answers.
7. **WebSocket hello.** A client must send `{ "type": "hello", "token": "…" }` within 5 seconds of connecting, or the server closes the socket with code 4401.
8. **The channel URL segment is the channel's UUID.**
9. **The public view is sent to the dock and overlay after every input**, changed or not (spec §5 "the dock and overlay get the new public view"). Viewers get theirs only when it changed.
10. **The memory sweep** (dropping characters and unloading idle Rooms) runs once a minute on the Room's clock.
11. **Request-ID keys** are `dock:<id>`, `overlay:<id>` or `viewer:<characterId>:<id>`, so "the same sender" is the role and the character, not a particular token. That lets a regenerate retry with the old token match its first answer (spec §4.1).
12. **`dndm connect` doesn't reconnect on its own.** Spec §5 says clients reconnect with backoff and get a full picture again. The server side of that (a full picture on every connect) is built and tested; automatic reconnecting belongs to the long-lived screens in Project 3. A dropped `dndm connect` session ends with an error, and you run it again.
