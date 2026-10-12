# twitch-dndm — Project 2a: Server Core

**Date:** 2026-10-11
**Status:** Draft for owner review (revision 5)
**Roadmap:** `docs/roadmap.md`, Project 2 (split into 2a, this spec, and 2b, the Twitch layer)
**Builds on:** `2026-10-11-engine-and-packs-design.md` (Project 1). Carries over the parts of `2026-10-08-core-game-design.md` (rev 7) §3, §6, §7, §8 and §12 that don't need Twitch, revised for the modular engine.

## 1. Purpose

Project 1 built the game as a pure engine plus a CLI. Project 2a puts that engine behind an always-on server, so a channel's game keeps running between commands, survives restarts and can be played by many clients at once.

2a has no screens and no Twitch connection. A new CLI mode, `dndm connect`, drives a local server as the streamer and as any number of viewers. A dev-only login stands in for Twitch. Project 2b adds the Twitch layer on top without changing the Room.

### 1.1 Success criteria

1. A person or an agent can create a channel (`dndm server`), then open a session, run fights and an adventure, and change content through `dndm connect`, all against a local server.
2. A scripted game played through the server produces the same events as the same script played through `dndm run`, with the same seed, apart from the `dev:` prefix on character IDs (§9).
3. Killing the server in the middle of a fight and starting it again resumes that fight. Nothing a client was told about is lost (§6.4).
4. Two channels on one server are fully separate: their own config, characters and game.
5. A streamer can change packs, the channel pack, overrides or settings at any time, including mid-fight. A change that would break the running encounter or the lined-up adventure is refused with a reason (§6.5).

### 1.2 Out of scope (Project 2b)

Twitch login and sign-up, the extension JWT, Extension PubSub, the optional chat bot, media uploads, hosting and deploy, and redefining "official pack" for paid packs. Screens are Project 3.

## 2. Architecture

```
 dndm connect (streamer)   dndm connect (viewers)   test harness
        │  HTTP commands + WebSocket  │
        ▼                             ▼
 ┌──────────────── apps/server ─────────────────────────────┐
 │ HTTP API (Fastify) ── Auth (dock token / dev viewer login) │
 │        │                                                   │
 │   RoomManager ──► Room (one per channel)                   │
 │                    ├─ engine (built from channel config)   │
 │                    ├─ input queue (one at a time)          │
 │                    ├─ one timer at nextWakeTime            │
 │                    └─ character cache (characters in play) │
 │   Store (Drizzle/Postgres)      Hub (WebSocket fan-out)    │
 └───────────────────────────────────────────────────────────┘
```

### 2.1 Technology

TypeScript, pnpm workspaces, Node ≥ 24, Vitest and Zod, as in Project 1. New: Fastify (HTTP), `ws` (WebSockets), Drizzle ORM and `drizzle-kit` (Postgres and migrations), Postgres in Docker Compose for local development and tests, and a Postgres service container in CI.

### 2.2 Parts

- **`apps/server`** (new): the only server process.
  - **Room**: one live game per channel (§6).
  - **RoomManager**: loads and unloads Rooms (§6.6).
  - **Store**: the only code that touches Postgres (§3).
  - **Hub**: WebSocket connections per channel, grouped by role (§5).
  - **HTTP API**: commands and reads (§4).
- **`packages/protocol`** (new): Zod schemas and types for every HTTP and WebSocket message, shared by the server, the CLI and, later, the screens.
- **`packages/engine`**: three changes: partial character state, event audiences and per-character catch-up (§7). The server also uses `engine.view(game, characterId | null, now)`, which Project 1 already added (Project 1 plan README, decision 1).
- **`apps/cli`**: two additions, `dndm connect` and `dndm server` (§8).
- **Packs**: official packs stay as folders in `packs/`, loaded once at boot by `pack-loader`. A channel's config says which ones it uses.

## 3. Data

Three tables, defined with Drizzle and migrated with `drizzle-kit`. Migrations are committed.

- **`channels`**
  - `id` (uuid), `name`
  - `twitch_id`: unique, empty in 2a (2b fills it in at sign-up)
  - `config` (jsonb): the channel config document, the same shape as `channels/*.yaml` (packs, `channel-pack`, overrides, settings)
  - `config_version` (integer, starts at 1, +1 on every change)
  - `dock_token_hash`, `dock_token_enc`, `overlay_token_hash`, `overlay_token_enc` (§4.2)
  - `created_at`, `updated_at`
- **`rooms`**: one row per channel.
  - `channel_id` (primary key)
  - `state_version` (the `GameState` version)
  - `clock`, `rng`, `seq`
  - `session` (jsonb, null when no session is open)
  - `recent_requests` (jsonb): request IDs from the last 5 minutes with their answers (§4.1)
  - `saved_at`
- **`characters`**: one row per (channel, character).
  - `channel_id`, `id` (primary key together)
  - `data` (jsonb): the engine's `Character`
  - `wake_at`: the character's earliest timer (§6.4), or null
  - `removed` (boolean): a copy of the character's "removed by the streamer" flag, so a Room can find those characters when it loads (§6.2)
  - `updated_at`

Rules:

- A Room's in-memory `GameState` is its `rooms` row plus the characters it has loaded (§6.2).
- A saved game whose `state_version` the server doesn't support is refused with a clear error. The server never guesses.
- Character IDs say where they came from: `dev:<name>` in 2a. 2b adds Twitch user IDs with their own prefix.
- Content (classes, monsters, items and the rest) is never stored in its own tables. Official packs are files; a channel's own content and overrides live inside `channels.config`. This keeps one content format for files, the CLI and the server, and lets `dndm validate` check what's in the database.
- There is no history table in 2a.

## 4. HTTP API

### 4.1 Commands

`POST /channels/:channel/commands`, body `{ id, command }`.

- `id`: a client-made request ID (1–64 characters). A repeated ID from the same sender within 5 minutes returns the first answer instead of running the command again, including after a server restart (rev 7 §12). The IDs of accepted commands are saved in `rooms.recent_requests`, in the same transaction as the input (§6.1). A rejected command changes nothing and saves nothing, so repeating it runs the checks again.
- `command` is one of:
  - an **engine command**, with exactly the shapes `dndm run` uses (`join`, `use`, `spawn`, `heal`, …);
  - a **server command**:
    - `getConfig` → the config document and its `config_version`
    - `validateConfig(config)` → the validation errors, or none; changes nothing
    - `updateConfig(config, basedOn)` → applies a new config (§6.5); `basedOn` is the `config_version` the edit started from
    - `regenerateDockUrl`, `regenerateOverlayUrl` → a new token; the old one stops working at once, and open WebSocket connections that used it are closed
- Answer: `{ ok: true, events, result? }` or `{ ok: false, error: { code, message } }`. `events` are filtered for the sender by the same audience rule as the Hub (§5).
- Error codes: the engine's own rejection codes, plus `unauthorized`, `forbidden`, `streamer-only`, `bad-command`, `rate-limited`, `stale-config`, `invalid-config`, `content-in-use`, `save-failed`, `unknown-channel`, `internal`.

### 4.2 Reads

- `GET /channels/:channel/view`: the caller's view, the same `engine.view()` output the CLI shows. A viewer gets their own; the dock and overlay get the public view (`engine.view(game, null, now)`).
- `GET /channels/:channel/describe`: the channel's content catalog (`engine.describe()`).

### 4.3 Roles and auth

| Role | Proves itself with | May send |
|---|---|---|
| Dock | dock token (`Authorization: Bearer`) | every engine command (streamer and viewer shapes) and every server command |
| Overlay | overlay token | nothing (reads and WebSocket only) |
| Viewer | a viewer token from dev login (§8.3) in 2a; the extension JWT in 2b | viewer commands only, as themselves only (the same rule as the CLI's `streamer-only`) |

- Dock and overlay tokens are random 32-byte values. Each is stored encrypted (so its URL can be shown again) with a SHA-256 hash for lookup. The encryption key comes from the `DNDM_SECRET` environment variable.
- A token only works for its own channel.

### 4.4 Rate limit

5 requests per second per viewer, 5 per overlay token and 20 per dock token; more are rejected with `rate-limited`. Commands, view and `describe` reads, and WebSocket connects all count. The limiter measures time with the server's injected clock. This is server protection, not a game rule. The end-to-end test (§9) runs with rate limits turned off, as a test setting.

## 5. Live updates (WebSocket)

`GET /channels/:channel/live`, upgraded to a WebSocket. The client sends its token in the first message.

- **On connect**, a full picture:
  - the dock and overlay get the public view;
  - a viewer gets their own view.
- **After each input** that produced events or changed state:
  - events go to their audience (§7.2): public events to everyone; events with an audience only to the dock and to those characters' viewer connections, never to the overlay. The dock sees every event (engine spec §9.6);
  - the dock and overlay get the new public view;
  - each connected viewer gets their new view, only if it changed.
- **After a config change**, everyone gets a `config-changed` message and fetches `describe` again after a random 0–1 s delay.
- Clients reconnect on their own with backoff and get a full picture again.
- The Hub tells the Room which characters are **watched** (`room.watch(id)`, `room.unwatch(id)`). In 2a a viewer is watched while their WebSocket is open. Watched characters stay loaded (§6.2) and get their new view after an input only if it changed.
- In 2a, viewer connections stand in for Extension PubSub. 2b replaces that path, and decides what "watched" means, without changing the Room.

## 6. The Room

### 6.1 The input loop

Each Room has one queue. Inputs are commands, a timer firing, config changes and loads (a view read or a WebSocket connect that needs a character loaded, §6.2), handled one at a time:

1. Load the characters the input needs (§6.2).
2. Call the engine with `now` from an injected clock (tests use a fake clock).
3. Save, in one transaction: the `rooms` row and every loaded character whose data differs from its last saved copy.
4. Broadcast the events and new views (§5).
5. Re-arm the single timer for `engine.nextWakeTime`.

Nothing is broadcast or answered before the save commits.

### 6.2 Characters in memory

- **Loading.** Before calling the engine, the Room loads the sender's character and any character named in the command, if they aren't loaded already. A character that doesn't exist yet is created by the engine as today (on `join`). A view read (§4.2) or a viewer's WebSocket connection (§5) loads that viewer's character the same way.
- **Loading a Room** (at boot or on demand) is the only definition used anywhere: it loads its `rooms` row, every party member, every character with a `wake_at` (§6.4) and, if a session is open, every character marked "removed by the streamer". Then it runs `engine.resume(game, now)` once, as the engine requires after loading a saved game.
- **Opening a session** loads every character marked "removed by the streamer" first, so the flag can clear at the session's first rest.
- **Loading one character into a running Room** never calls `resume`, which would reset the monster's turn (engine §6.10). It calls `engine.catchUp(game, characterId, now)` instead (§7.3), which handles only that character's knockout and statuses that ended or came due while they were unloaded. The catch-up is part of the input that needed the character: it runs in that input's engine pass, and is saved with it or thrown away with it. If a command is rejected, its catch-up isn't saved; it is simply done again the next time the character loads, with the same result, because timers are absolute times. A view read or a connect that needs a character loaded is a load input of its own.
- **Staying loaded.** A character stays loaded while any of these is true:
  - they're in the party;
  - they have a running timer: a knockout, or a status with an end time or a next tick (cooldowns don't count: nothing happens when one ends);
  - a session is open, `streamerRemovalWaitsForRest` is on, and they're marked "removed by the streamer" (the flag clears at the next rest, engine spec §6.3);
  - they're watched (§5);
  - they were part of an input or a view read in the last 10 minutes.
- Anyone else is dropped from memory. They're already saved, so nothing is lost.

### 6.3 A failed save

The Room keeps the state from before the input and drops the new one. A command answers `save-failed` and nothing is broadcast. A timer input retries with backoff (1 s, doubling, at most 30 s). The game never runs ahead of the database.

### 6.4 Restart

- At boot, the server loads (§6.2) every Room that has a session open or a character with a `wake_at`. Loading runs `engine.resume(game, now)`, which applies the restart rules (including `fullIntervalAfterRestart`).
- `wake_at` is the earliest of the character's knockout end, status end times and status next ticks, or null. Cooldowns are not included. It is written with the character, so the server finds these Rooms without reading every character.
- Because every input is saved before anyone hears about it, a crash loses only inputs nobody was told about.

### 6.5 Config changes

`updateConfig(config, basedOn)` runs as a Room input:

1. If `basedOn` isn't the current `config_version`: `stale-config`.
2. Parse and validate the config, and build a new engine from it: errors give `invalid-config` with the list.
3. Run `adopt` on the live game: a refusal gives `content-in-use` with the engine's message.
4. Save the config (with `config_version + 1`) and the room in one transaction.
5. Swap in the new engine and send `config-changed` (§5).

If any step fails, nothing changes. Changes are allowed at any time, including mid-fight.

### 6.6 Loading and unloading

- Any other Room is loaded on its first request (with `resume`, §6.2). A Room is unloaded after 30 minutes with no session open, no input, no watched character and no loaded character with a running timer.
- At boot the server takes a Postgres advisory lock. A second server against the same database refuses to start, so there is never a second copy of a Room.

### 6.7 Errors

Every error answer has a stable code and a readable message. Plugin errors inside the engine are already contained by the engine (`core:plugin-error`). Unexpected server errors are logged with the channel and character IDs, and the client gets `internal`.

## 7. Engine changes

### 7.1 Partial character state

The engine must work when `GameState.characters` holds only some of a channel's characters.

- Every engine operation that reaches for "all characters" must only need the loaded ones. Commands name the characters they touch; party-wide operations use the party, which is always loaded.
- `nextWakeTime` and `advance` look only at loaded characters. The stay-loaded rule (§6.2) guarantees that every character with a running timer is loaded.
- The engine stays pure: it never asks for a missing character. A command naming a character that isn't in the state is handled as today (rejected, or created on `join`), so the server must load first.
- Tests pin this down before any server work: the same script played with every character loaded and with only the needed ones loaded (by the §6.2 rules) gives the same events.

### 7.2 Event audiences

- A `GameEvent` gains an optional `audience`: a list of character IDs. No audience means public.
- Plugins set it when they emit (for example, a secret shop's events go to the members who can see it, engine spec §9.6).
- The engine only carries the field; the Hub (§5) and command answers (§4.1) decide who receives the event. `dndm run` and `dndm play` show every event, as today.

### 7.3 Per-character catch-up

- `engine.catchUp(game, characterId, now)` applies to one character the same rules `resume` applies to characters after a load: knockouts and statuses that ended during the downtime end, and missed ticks are handled as `resume` handles them.
- It never touches the session, the encounter or monster timers.
- Tests: loading a character mid-fight with `catchUp` doesn't move the monster's next turn, and a character caught up this way ends in the same state as after a full `resume`.

## 8. CLI additions

### 8.1 `dndm server`

```
dndm server start [--port 8787]
dndm server create-channel <name> [--config channels/default.yaml] [--seed <n>]
dndm server migrate
```

- `create-channel` validates the config, creates the channel and its room (seeded with `--seed`, else a random seed), and prints the dock and overlay URLs with their tokens.
- `migrate` applies the committed migrations.
- Connection settings come from `DATABASE_URL`, `DNDM_SECRET` and `DNDM_DEV`.

### 8.2 `dndm connect`

```
dndm connect <server-url> --channel <id> --dock <token>        # as the streamer
dndm connect <server-url> --channel <id> --viewer alice        # as a viewer (dev only)
dndm connect <server-url> --channel <id> --dock <token> --script game.jsonl
```

- The interactive mode works like `dndm play`: commands in, events and views out, now arriving live.
- Scripts use the same `{as, command}` lines as `dndm run`. `as` is `streamer` (the dock token) or a viewer name (logged in through dev login). Waits are real time (`{wait: "5s"}`) or `{wait: "events"}` (until the next events arrive). `{next}` (jump to the next timer) needs control of the clock, so `dndm connect` rejects it; the end-to-end test (§9) gets it from a fake clock instead.
- `--json` prints every message as JSON, for agents.

### 8.3 Dev login

Only when the server runs with `DNDM_DEV=1`; the route isn't registered otherwise.

- `POST /dev/login { channel, viewer }` returns a viewer token for `dev:<viewer>` on that channel.

## 9. Testing

| Level | What | How |
|---|---|---|
| Engine | partial character state (§7.1), the stay-loaded rule, event audiences (§7.2), `catchUp` (§7.3) | Vitest, as today |
| Room | input order; loading and dropping characters; save before broadcast; a failed save keeps the old state; timer retry; config changes, `stale-config`, `invalid-config` and `content-in-use`; restart and resume mid-fight | Vitest, real Postgres, fake clock |
| Server | auth per role; viewers acting only as themselves; repeated request IDs; rate limit; WebSocket full picture on connect and reconnect; `config-changed`; dev login absent without `DNDM_DEV=1`; the advisory lock; two channels kept separate | Vitest against a running Fastify app and real Postgres |
| End to end | the Project 1 golden scripts played through the server with a fake clock give the same events as `dndm run`, after mapping `dev:<name>` back to `<name>` | golden test |
| CLI | `dndm connect` scripts, `dndm server create-channel` | Vitest |

CI adds a Postgres service container for the Room, Server and end-to-end tests.
