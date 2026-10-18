# twitch-dndm — Project 2b: Twitch Layer

**Date:** 2026-10-17
**Status:** Draft for owner review (revision 1)
**Roadmap:** `docs/roadmap.md`, Project 2 (2a is done; this is 2b)
**Builds on:** `2026-10-11-server-core-design.md` (2a, rev 7) and `2026-10-11-engine-and-packs-design.md` (Project 1). Carries over `2026-10-08-core-game-design.md` (rev 7) §7.2, §7.3 and §8, revised for the modular engine and for decisions made in the 2b brainstorm (§1.3).

## 1. Purpose

2a put the engine behind an always-on server, with a dev-only login standing in for Twitch. 2b connects that server to Twitch and puts it on the internet:

- viewers are identified by Twitch's extension JWT;
- every viewer gets a compact shared snapshot through Twitch Extension PubSub, and fetches their own state over HTTP when it changed;
- streamers sign up with Twitch login, if they are on an allowlist;
- the server runs on Fly.io against a Neon Postgres database.

2b has no screens beyond two bare server-rendered pages (sign-up and setup). The extension, dock and overlay screens are Project 3, which is also where a real viewer first receives a PubSub message.

### 1.1 Success criteria

1. A test viewer holding a JWT signed with the test extension secret can read their view, join, fight and see their state change, entirely through `/ext` routes and snapshots sent to a fake Twitch.
2. Project 1's golden scripts, with viewer lines replayed through `/ext` as Twitch viewers (streamer lines through the dock routes) with signed JWTs and a fake clock, give the same events as `dndm run` with the same seed, apart from character ID prefixes (`twitch:` here). This is 2a's criterion 2, carried to the real viewer path.
3. No snapshot ever contains an event, an encounter panel or an overlay scene, so the content of a restricted encounter (a secret shop's goods, prices and purchases) can't leak through the broadcast. A snapshot may still show that an encounter is running (`ph`) and which viewers' own state changed (`ch`); this is accepted (§5.1).
4. A streamer on the allowlist can sign in with Twitch, gets a channel, and sees the dock and overlay URLs. A streamer not on the allowlist is turned away.
5. The live check (§10) passes on the deployed server.
6. Without any Twitch settings, the server behaves exactly as in 2a, and every 2a test still passes.

### 1.2 Out of scope

- **Media uploads** (monster images, story-beat images and video) move to Project 3, next to the forms that upload them.
- **The chat bot and chat bans** become their own small project after Project 3.
- **Paid packs and the meaning of "official" for them** wait until a paid pack exists. §11.2 records the direction decided here.
- **Screens.** The extension, dock and overlay are Project 3.
- **Channel deletion**, admin commands from the sign-up page (rev 7 §8), and a waitlist for sign-up.

### 1.3 Decisions from the brainstorm

- **Distribution: a hosted service.** The project's owner runs the one official server, and every channel that installs the extension uses it. The code stays open source. Self-hosting is possible for developers (they register their own extension, pass Twitch review and restrict installs to their channel) but isn't supported or documented in 2b.
- **Hosting:** Fly.io for the server, Neon for Postgres.
- **Sign-up is invite-only** at first, through an allowlist the owner manages from the CLI. Opening it is a config switch.
- **Viewer updates use Extension PubSub**, as rev 7 planned, from a new part (the Broadcaster) wrapped around the Room. The extension doesn't open its own WebSocket to our server.

## 2. Architecture

```
 Twitch extension (Project 3)     dock / overlay        dndm connect (dev only)
   │ HTTP + extension JWT           │ HTTP + WebSocket     │ HTTP + WebSocket
   ▼                                ▼                      ▼
 ┌─────────────────────────── apps/server ───────────────────────────┐
 │ Auth: extension JWT │ dock/overlay tokens │ dev login (DNDM_DEV)  │
 │ Sign-up and setup pages (Twitch OAuth, allowlist, session cookie) │
 │            RoomManager → Room (2a rules, §5.2 additions)          │
 │   Hub (dock, overlay, dev viewers)    Broadcaster (per Room)      │
 │                                          │ ≤ 1 snapshot / s        │
 │ Twitch client: app token, Get Users, ────┘ Send Extension PubSub  │
 └──────────────────────────────┬────────────────────────────────────┘
                                ▼
                     Neon Postgres (direct connection)
```

### 2.1 Technology

As in 2a. JWTs (HS256) and the session cookie are signed and checked with `node:crypto`, with no JWT library. Twitch's API is called with Node's built-in `fetch`. Small Fastify plugins (cookies, form bodies, CORS) may be added, pinned to exact versions at least two weeks old, as for every dependency.

### 2.2 Parts

All new parts live in `apps/server/src/`:

- **`twitch/jwt.ts`**: checks extension JWTs (§4.1) and signs the server's own JWT for PubSub sends (§6.3).
- **`twitch/api.ts`**: the Twitch client (§6), behind an interface so tests use a fake Twitch.
- **`broadcaster.ts`**: one per loaded Room of a Twitch channel (§5.3). It builds and sends snapshots.
- **`ext.ts`**: the `/ext` routes (§5.6).
- **`signup.ts`**: the sign-up and setup pages (§4.3, §4.4).
- **`session.ts`**: the signed session cookie and the `state` cookie (§4.3).
- **CLI**: `dndm server allow`, `disallow` and `allowlist` (§4.5).

The Room, RoomManager and Hub keep their 2a jobs. The Room gains the two small additions in §5.2. The 2a dev path (dev login, viewer WebSockets, `dndm connect` as a viewer) stays, behind `DNDM_DEV=1`.

**What this changes in 2a's spec.** The owner accepted these changes during the 2b design:

- 2a said 2b would add the Twitch layer "without changing the Room". 2b makes the two additive Room changes in §5.2, and one additive change to `engine.view` (§5.2).
- 2a's viewer role row (§4.3) said the extension JWT would be used in 2b. The JWT is used only on the `/ext` routes (§4.1). On the 2a `/channels/:channel/*` routes, the viewer role stays dev login only.
- 2a left 2b to decide what "watched" means. **Twitch viewers are never watched.** A Twitch viewer's character stays loaded through 2a's other rules (party membership, timers, and "part of an input or a view read in the last 10 minutes"). Dev viewers are watched while their WebSocket is open, as in 2a.

## 3. Data

One migration:

- **`channels.twitch_id`** already exists (nullable, unique among set values). 2b fills it in at sign-up: one Twitch account has at most one channel.
- **`allowlist`** (new):
  - `twitch_id` (primary key)
  - `login`: the login it was resolved from at `allow` time. It's shown by `allowlist` and used as a fallback match by `disallow` (§4.5)
  - `added_at`

Twitch characters are `twitch:<user_id>`, following 2a's rule that character IDs say where they came from. Sessions aren't stored (§4.3).

## 4. Auth and identity

### 4.1 Viewers: the extension JWT

- The extension calls the `/ext` routes (§5.6) with `Authorization: Bearer <jwt>`. Dock, overlay and dev tokens keep their 2a routes. The `/ext` routes accept only JWTs, and the 2a routes never accept JWTs.
- **Checking a JWT:**
  - The algorithm must be HS256. The key is the base64-decoded extension secret (`TWITCH_EXTENSION_SECRET`). If `TWITCH_EXTENSION_SECRET_PREVIOUS` is set, a JWT signed with it is also accepted, so the secret can be rotated in Twitch's developer console without downtime.
  - `exp` is checked against the server's clock, with 60 seconds of leeway.
  - Any failure answers `unauthorized` (401).
- **The channel** is found by matching the JWT's `channel_id` to `channels.twitch_id`. No match answers `unknown-channel` (404) with the message "This streamer hasn't set up the game yet." (rev 7 §8).
- **With identity shared** (the JWT has `user_id`), the sender is the viewer `twitch:<user_id>`. They may read their own view and send viewer commands as themselves only, under the same rule as 2a's viewer role.
- **Without identity shared** (only `opaque_user_id`), reads return the public view, and every command answers `identity-required` (403), a new error code, so the extension knows to ask the viewer to share their identity.
- **Rate limits** use 2a's viewer budget (5 per second). The key is the character ID, or the `opaque_user_id` when there's no `user_id`.
- **The JWT's role.** A `broadcaster` or `moderator` role is treated like any other viewer. Streamer control stays with the dock token in 2b.
- **CORS.** The `/ext` routes allow the extension's origin, `https://<TWITCH_CLIENT_ID>.ext-twitch.tv`, with the `Authorization` and `Content-Type` headers. Other origins get no CORS headers.

### 4.2 Display names

- On every `join` through `/ext/commands`, the server looks the viewer up with Get Users (§6.2) and puts their display name in the engine command's existing `name` field. A `name` sent by the client is ignored.
- If Get Users fails, a character that already exists joins with their stored name. A character that doesn't exist yet gets `twitch-unavailable` (503), and can retry.
- Names aren't refreshed at any other time, as in rev 7 §8.

### 4.3 Streamer sign-up

Sign-up is only available when Twitch is configured (§7.2).

1. **`GET /signup`** shows a "Sign in with Twitch" button.
2. The button starts Twitch's OAuth authorization code flow with **no scopes**. A random `state` value goes in the URL and in a signed, `HttpOnly` cookie that lasts 10 minutes.
3. **`GET /signup/callback`**:
   - Checks that `state` matches the cookie.
   - Exchanges the code for a user token.
   - Reads the user's ID, login and display name with Get Users.
   - Revokes the user token (best effort) and keeps nothing from it.
4. **The allowlist.** If `DNDM_SIGNUP` is `allowlist` (the default) and the user's Twitch ID isn't on the allowlist, they see "The game isn't open for sign-ups yet." `DNDM_SIGNUP=open` skips this check.
5. **The channel.** If no channel has this `twitch_id`, one is created through 2a's `createChannel`, with the default config and the display name as its `name`. Otherwise the existing channel is used.
6. **The session.** The server sets a `dndm_session` cookie and redirects to `/setup`.
   - The cookie is signed with a key derived from `DNDM_SECRET`, under its own label.
   - It holds the channel ID, the Twitch ID and an expiry 7 days away.
   - It is `HttpOnly`, `Secure` and `SameSite=Lax`.
   - Sessions aren't stored, so a session can't be revoked early. Signing out clears the cookie.

Taking someone off the allowlist stops new sign-ins only. Their channel, sessions and URLs keep working; regenerating the URLs cuts off the dock and overlay.

### 4.4 The setup page

`GET /setup` needs a valid session, and otherwise redirects to `/signup`. It shows:

- **the dock URL** `<DNDM_PUBLIC_URL>/dock#<dock token>` and **the overlay URL** `<DNDM_PUBLIC_URL>/overlay#<overlay token>`. The token sits in the URL fragment, so it never reaches server logs. Project 3 builds these screens; until then those two paths answer a short "coming in Project 3" page;
- the `dndm connect` line for the dock, so the channel can be driven from the CLI now;
- a link to install the extension;
- **Regenerate** buttons for each URL, and **Sign out**.

The buttons are POST forms carrying a CSRF token tied to the session. A regenerate runs as the Room's existing `regenerateDockUrl` or `regenerateOverlayUrl` server command, sent as the dock. It behaves exactly as in 2a: the old token stops working and its open WebSockets close.

### 4.5 Allowlist commands

These commands need `DATABASE_URL` and the Twitch client settings. Run against production, they manage production's allowlist.

- `dndm server allow <login>` resolves the login to a Twitch ID with Get Users, and adds it. An unknown login is an error.
- `dndm server disallow <login>` resolves the login with Get Users and removes the entry with that ID. If the login no longer resolves, or resolves to an ID that isn't on the list, it removes the entry whose stored login matches. If neither matches, it's an error.
- `dndm server allowlist` prints the entries.

## 5. Viewer updates

### 5.1 The snapshot

One JSON message per send, to the channel's `broadcast` topic, at most 5 KB. Short field names keep it small:

```json
{ "v": 1, "t": 1792287427123,
  "ph": "fight", "adv": { "id": "starter:crypt", "lined": null },
  "f": { "n": "Goblin King", "img": null, "hp": 140, "mx": 200, "st": ["starter:stunned"],
         "sub": "f", "held": false, "nt": 1792287431000 },
  "p": [["12345", "starter:fighter", 80, 0], ["67890", "starter:healer", 0, 1]],
  "rv": 7, "ch": ["12345"], "rw": 1000 }
```

| Field | Meaning |
|---|---|
| `v` | Format version, 1. |
| `t` | Server time (ms) when the snapshot was built. Clients use it to correct their clock for countdowns, and drop a snapshot whose `t` is lower than one they already have (PubSub doesn't guarantee order). |
| `ph` | The phase from the public view: `closed`, `resting`, `fight` or `encounter`. |
| `adv` | The public view's `adventure`, or null. |
| `f` | The public view's `fight`, or null: monster name `n`, image `img`, `hp`, max HP `mx`, status IDs `st`, `sub` (`f` fighting, `w` waiting), `held`, next turn time `nt`. |
| `p` | Party entries in join order: `[key, class, hpPercent, flags]`. `hpPercent` is `round(100 × hp / maxHp)`. `flags` bit 1 = knocked out. |
| `pt` | Present only when `p` was trimmed (§5.4): the full party size. |
| `rv` | Roster version (§5.3). |
| `ch` | The changed list (§5.3), as keys. |
| `rf` | `true` in place of `ch` when every viewer should fetch their own state. |
| `rw` | Refresh window in ms (§5.5). |

- **A key** is the character ID without its `twitch:` prefix, used only inside snapshots to save bytes. A character with any other prefix (a `dev:` character, only on a dev server) is sent with its full ID. Every HTTP route, commands included, uses full character IDs; the extension turns a key back into an ID by adding `twitch:`.
- **Party statuses aren't in the snapshot.** Statuses come from packs, so they can't be fixed flag bits. A party member's statuses come from `/ext/party` (§5.6). This replaces rev 7's `statusFlags`.
- **Never in a snapshot:** events, encounter panels (per-viewer widgets such as a shop) and overlay scenes. Viewers see encounter content through their own state (§5.6).
- **Accepted: what a snapshot does reveal during a restricted encounter.** `ph` shows that an encounter is running. `ch` lists the keys (opaque Twitch user IDs) of viewers whose own state changed, without saying what changed. Neither shows the encounter's content.

### 5.2 Room additions

These are the only changes to the Room. 2a said 2b wouldn't change the Room; both are additive and leave its queue, saving and memory rules as they are.

1. **`room.broadcastState()`**, a read that runs through the Room's queue. It returns:
   - `publicView`;
   - `changed`: the IDs of every loaded character whose own view (`engine.view(game, id, now)`) differs from the one recorded at the previous `broadcastState()`, in or out of the party. A character with no recorded view (newly loaded) counts as changed.

   It then records the current views. It doesn't count as activity, so it never keeps a Room loaded or delays an unload. It also returns `inputs`, a counter the Room raises by one for every input that saved state (a command, a timer, a config change), so the Broadcaster can tell whether anything happened.
2. **Dropping waits for the broadcast, in Rooms with a Broadcaster only.** In such a Room, the memory sweep (2a §6.2) doesn't drop a character who has a recorded view that differs from their current view. They'll be in the next changed list, and can be dropped at a later sweep. A character with no recorded view is treated as unchanged by the sweep. A newly loaded character was part of an input or a view read when they loaded, so 2a's 10-minute rule keeps them loaded well past the next broadcast. In a Room without a Broadcaster, the sweep is exactly 2a's.

Party entries in the engine's view gain `level` and `statuses` (the same shape as `character.statuses`), an additive change to `engine.view` used by the roster and `/ext/party`.

### 5.3 The Broadcaster

The RoomManager starts a Broadcaster for every loaded Room whose channel has a `twitch_id`, when Twitch is configured. It doesn't subscribe to the Room's output, so it doesn't count as a listener and never keeps a Room loaded.

- **The tick.** Every second on the server clock, it calls `broadcastState()` if this is its first tick, if the Room's `inputs` counter moved since the last tick, or if there are carried keys.
- **What it sends.** A snapshot is sent when its content (everything but `t` and `rw`) differs from the last one sent, or its changed list isn't empty. Otherwise nothing is sent.
- **Keys are kept until delivered.** The changed list is every key from `broadcastState()` since the last successful send. A failed send keeps its keys for the next one.
- **The roster version.** The Broadcaster keeps the roster it last computed: each party member's ID, name, class and level, in join order, taken from the public view's party entries. `rv` goes up by one whenever the newly computed roster differs from it. It starts at 1 when a Broadcaster starts. Clients refetch the roster when `rv` is *different* from what they hold, not just higher, so a reset after a reload still works.
- **The first snapshot** a Broadcaster sends has `rf: true`, which covers anything missed across a restart or an unload.
- **Unloading.** Before its Room unloads, the RoomManager runs one last tick, so carried keys are sent before the Broadcaster stops.

### 5.4 Size

The snapshot is serialized and measured in bytes. Over 5 KB, in this order:

1. Trim `p` to the first members by join order that fit, and add `pt`.
2. If it still doesn't fit with `p` empty, replace `ch` with `rf: true`.
3. If it still doesn't fit (for example, a very long monster name), send only `{ "v": 1, "t": …, "rf": true, "rw": … }` and log it.

### 5.5 The refresh window

`rw` tells clients how long to spread their own-state fetches. Each viewer picks a random delay in `[0, rw]`.

- With a changed list, `rw` is the number of keys × 10 ms, at least 1,000 ms and at most 30,000 ms.
- With `rf`, `rw` is the number of loaded characters × 10 ms, at least 2,000 ms and at most 30,000 ms. Loaded characters (the party plus anyone recently active) are the server's best estimate of how many viewers will fetch.

The server sets it, so it can be tuned without an extension update.

**A known load risk.** An encounter panel can make every party member's view change at once, for example with a vote tally. In a big party that gives a long changed list, or `rf`, on most ticks. The **target** is about 100 own-state requests per second per channel (fetching viewers ÷ window). It's met while the fetching viewers number up to about 3,000. Beyond that, the 30 s cap wins and the rate rises above the target; this is a known limit, not a guarantee. Viewers outside the loaded set who still fetch on `rf` aren't counted in the estimate. The constants live in one place, so they can be tuned.

### 5.6 `/ext` routes

Any valid JWT is enough for these routes, unless the table says otherwise. The channel comes from the JWT.

| Route | Answer |
|---|---|
| `GET /ext/view` | With identity: the caller's own view, loading their character as a 2a view read does. Without: the public view. |
| `POST /ext/commands` | Body `{ id, command }`, as 2a §4.1, for viewer commands only (identity required). The answer adds `view`, the caller's own view after the command (rev 7 §7.3), on success and on engine rejections. |
| `GET /ext/describe` | The channel's content catalog, as 2a's `describe`. |
| `GET /ext/roster` | `{ rv, members: [[id, name, class, level]] }` for the party, in join order. |
| `GET /ext/party` | `{ members: [{ id, name, class, level, hp, maxHp, knockedOut, statuses }] }`, the whole party, for the target picker (rev 7 §9). |

`events` in a `/ext/commands` answer are filtered by 2a's audience rule, as for any viewer.

## 6. The Twitch client

### 6.1 App access token

Comes from the client credentials grant (`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`). It's kept in memory, refreshed when less than 10 minutes remain, and refreshed once more on any 401 from Twitch before the call is retried.

### 6.2 Get Users

Looks up users by ID (for display names) or by login (for the allowlist), using the app token.

### 6.3 Send Extension PubSub Message

- **The JWT.** For each send, the server signs a JWT with the extension secret:
  - `exp`: now + 60 s;
  - `user_id`: `TWITCH_OWNER_ID`;
  - `role`: `external`;
  - `channel_id`: the channel's Twitch ID;
  - `pubsub_perms`: `{ send: ["broadcast"] }`.
- **The request** carries `Client-Id: TWITCH_CLIENT_ID`, with the body `{ target: ["broadcast"], broadcaster_id, message }`.
- **Rate limits.** We send at most once a second per channel. A 429 waits until Twitch's rate-limit reset header before that channel's next send.

### 6.4 OAuth

Used only by sign-up (§4.3):

- the authorize URL, with no scopes;
- the code exchange;
- token revocation.

## 7. Deploy and config

### 7.1 The image

- A two-stage `Dockerfile` on `node:24-slim`:
  - `pnpm install --frozen-lockfile`;
  - it runs as a non-root user;
  - it starts with `dndm server start --host 0.0.0.0 --port 8080`, through `tsx`, as locally.
- Official packs are the repository's `packs/` folder copied into the image.
- CI builds the image on every push.

### 7.2 Config

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Neon's **direct** connection string, with `sslmode=require`. Not the pooled string: the advisory lock (2a §6.6) needs one session that stays put. |
| `DNDM_SECRET` | yes | As in 2a. |
| `DNDM_PUBLIC_URL` | with Twitch | The server's public origin, for example `https://dndm-7f3k.fly.dev`. Used for the OAuth redirect and the dock and overlay URLs. |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | with Twitch | The extension's API client. |
| `TWITCH_EXTENSION_SECRET` | with Twitch | Checking JWTs and signing PubSub sends. |
| `TWITCH_EXTENSION_SECRET_PREVIOUS` | no | Accepted during a secret rotation (§4.1). |
| `TWITCH_OWNER_ID` | with Twitch | The extension owner's Twitch user ID, for PubSub JWTs. |
| `DNDM_SIGNUP` | no | `allowlist` (default) or `open`. |
| `DNDM_DEV` | no | As in 2a. |

- **"Twitch is configured"** means `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_EXTENSION_SECRET`, `TWITCH_OWNER_ID` and `DNDM_PUBLIC_URL` are all set. `TWITCH_EXTENSION_SECRET_PREVIOUS` is optional and isn't part of this check. With some but not all of them set, the server refuses to start and names what's missing. With none set, there are no `/ext`, `/signup` or `/setup` routes and no Broadcasters, exactly as in 2a.
- With Twitch configured and `DNDM_DEV=1`, the server starts and logs a warning on every boot.

### 7.3 `GET /health`

Returns 200 `{ ok: true }` once the server holds the advisory lock and has finished boot loading (2a §6.4). Before that, it returns 503.

### 7.4 Clean shutdown

On SIGTERM, the server:

1. stops accepting requests;
2. waits for every Room's queue to finish (`manager.idle()`, which fixes 2a's deferred minor);
3. runs each Broadcaster's last tick;
4. closes the Store, which releases the lock.

Fly's `kill_timeout` is 30 s.

### 7.5 Fly.io

`fly.toml` in the repository:

- **One machine**, never auto-stopped: `auto_stop_machines = "off"` and `min_machines_running = 1`. Game timers live in memory.
- **`release_command`** runs `dndm server migrate` on a temporary machine before each deploy.
- **`strategy = "rolling"`.** With one machine, it stops the old one before starting the new one, so two servers never fight over the lock. `bluegreen` and `canary` must not be used. The plan confirms this behavior against Fly's documentation. If two machines ever do overlap, the new server refuses to start while the old one holds the lock (2a §6.6), and Fly starts it again.
- **The health check** is `GET /health`.
- **The app name** has a random suffix (Twitch policy 2.13 wants hosted domains to carry a unique identifier). A custom domain can come later.

A deploy means a few seconds of downtime for every channel. Clients reconnect and get the full picture again (2a §5); the extension catches up from `/ext/view` and the next snapshot.

### 7.6 Neon

- One project and one database.
- Backups and point-in-time restore are Neon's, and how far back depends on the plan.
- A Neon branch can test a risky migration against a copy of production. This is optional, and described in the runbook.

### 7.7 Runbook

`docs/deploy.md` covers, step by step:

- **The Twitch developer console** (done by the owner):
  - register the extension;
  - set the OAuth redirect URL to `<DNDM_PUBLIC_URL>/signup/callback`;
  - add the public domain to the URL fetching allowlist;
  - copy the client ID, API client secret, extension secret and the owner's user ID.
- **Neon:** create the project and copy the direct connection string.
- **Fly:** `fly launch --no-deploy` with the repository's `fly.toml`, `fly secrets set …`, then `fly deploy`.
- **First use:** `dndm server allow <login>` against production, then sign up in a browser.
- **Rotating** the extension secret and `DNDM_SECRET`. Rotating `DNDM_SECRET` changes the token encryption key, so its procedure includes regenerating every channel's URLs.

## 8. Errors

- **The Room never waits on Twitch.** A PubSub send runs outside the Room's queue. The Get Users lookup for a `join` (§4.2) also runs before the command enters the queue, so other inputs are never held up. The joining viewer does wait for it, and while Twitch is down, a brand-new viewer can't join (`twitch-unavailable`). A failure is logged, and its keys carry to the next send (§5.3). Repeated failures back off (1 s, doubling, at most 30 s) for that channel.
- **New error codes:** `identity-required` (403) and `twitch-unavailable` (503), added to `packages/protocol`.
- **Sign-up failures** each get a plain page with a link back to `/signup`:
  - the user cancelled at Twitch;
  - a missing or mismatched `state` (400);
  - Twitch didn't answer;
  - not on the allowlist.
- Unexpected errors follow 2a §6.7.

## 9. Testing

- **The fake Twitch** is a local Fastify app that plays the OAuth, token, Get Users and PubSub endpoints. It records every request and can be told to fail, time out or answer 429. The Twitch client takes its base URLs from config, and tests point them at the fake.
- **JWT:**
  - valid;
  - expired, and within leeway;
  - wrong secret;
  - the previous secret;
  - `alg` other than HS256;
  - no `user_id`;
  - a `channel_id` that hasn't signed up.
- **`/ext` routes:**
  - each route's answer;
  - `identity-required`;
  - acting only as yourself;
  - the rate limit;
  - CORS for the extension origin and not for others;
  - `view` in command answers;
  - a client `name` ignored on `join`;
  - Get Users failure on `join`, for a new and an existing character.
- **Room additions:**
  - `changed` includes a loaded character with no open connection whose state changed, and excludes an unchanged one;
  - `broadcastState()` doesn't keep a Room loaded;
  - the sweep doesn't drop a character with an unbroadcast change.
- **Broadcaster**, with the FakeClock and the fake Twitch:
  - at most one send per second;
  - no send when nothing changed;
  - failed sends and 429s keep their keys;
  - the first snapshot has `rf`;
  - `rv` bumps on roster changes only;
  - trimming and the `rf` fallbacks at 5 KB (§5.4);
  - the `rw` values;
  - the last tick on unload;
  - **a secret shop's content never appears in any snapshot.**
- **Sign-up:**
  - an account not on the allowlist is turned away, and `open` mode lets it in;
  - the first sign-in creates a channel, and a second reaches the same one;
  - a bad `state` is refused;
  - `/setup` without a session redirects;
  - CSRF is required on regenerate;
  - regenerate closes open dock WebSockets.
- **Config:** partial Twitch settings refuse to start; no Twitch settings gives 2a behavior.
- **The extension golden test** (criterion 2).
- **Shutdown:** a SIGTERM during an input still saves it, and `/health` is 503 before boot finishes.
- **CI** runs everything above and builds the Docker image.

## 10. Live check

Done on the deployed server once the tests pass. It confirms what only real Twitch can:

1. `GET /health` returns 200.
2. `dndm server allow <owner-login>` resolves the owner's account through the real Get Users.
3. The owner signs up through real Twitch login and sees the dock and overlay URLs on `/setup`.
4. A dock command through `dndm connect` (for example `openSession`) produces a logged PubSub send that Twitch answered with 204.

A real extension receiving the snapshot is checked in Project 3.

## 11. Known limits and future direction

### 11.1 One server

2a allows one server per database (the advisory lock). On a hosted service, that one process serves every channel. Growing past it means splitting channels across several servers, each owning a share of the channels. Nothing in 2b blocks that, and nothing in 2b builds it.

### 11.2 Paid packs (direction, not built)

- **Where they live.** Paid packs live in a private repository and are copied into the official server's image at build time.
- **What "official" means for them.** They are official because they're in the build. No signing is needed while packs only come from the build; signing matters only if packs are someday loaded from outside it.
- **Unlocking them.** A later project adds a record of which channels have unlocked which paid packs.
- **Twitch policy.** Charging broadcasters for features or plugins is allowed (Twitch extension policy 5.1). Purchase links never appear in the viewer extension (policy 4.6.3), so buying happens on a website or in the dock.

### 11.3 Open decisions carried from 2a

- **Reaction events inside restricted encounters stay public** (2a README decision 3). In 2b, snapshots carry no events. Viewers get events only in their own `/ext/commands` answers, filtered by 2a's audience rule. This decision therefore affects the overlay's event feed, and the events in a viewer's own command answers.
- **The 5-minute `replayRevoked` window** for regenerated tokens (2a §4.1) is unchanged.
