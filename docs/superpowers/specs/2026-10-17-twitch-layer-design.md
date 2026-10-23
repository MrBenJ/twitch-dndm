# twitch-dndm — Project 2b: Twitch Layer

**Date:** 2026-10-17
**Status:** Draft for owner review (revision 13)
**Roadmap:** `docs/roadmap.md`, Project 2 (2a is done; this is 2b)
**Builds on:** `2026-10-11-server-core-design.md` (2a, rev 7) and `2026-10-11-engine-and-packs-design.md` (Project 1). Carries over `2026-10-08-core-game-design.md` (rev 7) §7.2, §7.3 and §8, revised for the modular engine and for decisions made in the 2b brainstorm (§1.3).

## 1. Purpose

2a put the engine behind an always-on server, with a dev-only login standing in for Twitch. 2b connects that server to Twitch and puts it on the internet:

- viewers are identified by Twitch's extension JWT;
- every viewer gets a compact shared snapshot through Twitch Extension PubSub, and fetches their own state over HTTP when it changed;
- streamers sign up with Twitch login, if they are on an allowlist;
- the server runs on Fly.io against a Neon Postgres database.

2b has no screens, only bare server-rendered pages: sign-up and setup, the sign-up failure pages (§8), and the `/dock` and `/overlay` placeholders (§4.4). The extension, dock and overlay screens are Project 3, which is also where a real viewer first receives a PubSub message.

### 1.1 Success criteria

1. A test viewer holding a JWT signed with the test extension secret can read their view, join, fight and see their state change, entirely through `/ext` routes and snapshots sent to a fake Twitch.
2. Project 1's golden scripts, with viewer lines replayed through `/ext` as Twitch viewers (streamer lines through the dock routes) with signed JWTs and a fake clock, give the same events as `dndm run` with the same seed, apart from character ID prefixes (`twitch:` here). The test's fake Twitch answers Get Users for each script viewer with the name the script uses for them, so display names match too. This is 2a's criterion 2, carried to the real viewer path.
3. No snapshot ever contains an event, an encounter panel or an overlay scene, so the content of any restricted encounter (its events and panels; for a secret shop, its goods, its prices and what was bought) can't leak through the broadcast. The encounter's own events, and reactions to them (§5.7), don't reach the overlay's event feed either. This protects the content only, not party state or that a member did something in the encounter. Party state is public like any other party state, even while the encounter is still running (§5.1): HP, knockouts and statuses the encounter itself changes, and using what was bought, with its visible effects (a party member's class or HP in `p`, the roster and `/ext/party`) and its events (equipping or using the item, which name it on the overlay's event feed). A snapshot may still show that an encounter is running (`ph`) and which viewers' own state changed (`ch`). For a party member, whose key the roster maps to their identity, `ch` during a secret shop shows that they did something there, usually a purchase, but not what. This is accepted (§5.1).
4. A streamer on the allowlist can sign in with Twitch, gets a channel, and sees the dock and overlay URLs. A streamer not on the allowlist is turned away.
5. The live check (§10) passes on the deployed server.
6. Without any Twitch settings, every 2a route and rule behaves as in 2a, and every 2a test still passes, except that a 2a test pinning the old behaviour of one of the four changes below is updated to the new behaviour. No other 2a test changes. Four changes apply whatever the config: party entries in views gain `level` and `statuses` (§5.2), reactions inside a restricted encounter take its audience (§5.7), `GET /health` exists (§7.3), and shutdown waits for in-flight inputs (§7.4).

### 1.2 Out of scope

- **Media uploads** (monster images, story-beat images and video) move to Project 3, next to the forms that upload them.
- **The chat bot and chat bans** become their own small project after Project 3.
- **Paid packs and the meaning of "official" for them** wait until a paid pack exists. §11.2 records the direction decided here.
- **Screens.** The extension, dock and overlay are Project 3.
- **Channel deletion**, admin commands from the sign-up page other than regenerating the dock and overlay URLs (rev 7 §8; regenerate is in scope, §4.4), and a waitlist for sign-up.

### 1.3 Decisions from the brainstorm

- **Distribution: a hosted service.** The project's owner runs the one official server, and every channel that installs the extension uses it. The code stays open source. Self-hosting is possible for developers (they register their own extension, pass Twitch review and restrict installs to their channel) but isn't supported or documented in 2b.
- **Hosting:** Fly.io for the server, Neon for Postgres.
- **Sign-up is invite-only** at first, through an allowlist the owner manages from the CLI. Opening it is a config switch.
- **Viewer updates use Extension PubSub**, as rev 7 planned, from a new part (the Broadcaster) wrapped around the Room. The extension doesn't open its own WebSocket to our server.
- **Own-state fetch delay.** Rev 7 §7.3's random 0–1 s delay for changed-list fetches becomes the server-set window `rw` (§5.5). It is 1 s for up to 100 changed keys and grows with the list, so big changes are spread out instead of all landing in one second.

## 2. Architecture

```
 Twitch extension (Project 3)     dock / overlay        dndm connect (dock; viewers dev only)
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

- 2a said 2b would add the Twitch layer "without changing the Room". 2b makes the two additive Room changes in §5.2, one additive change to `engine.view` (§5.2), and one engine fix (§5.7).
- 2a README decision 3 left reaction events inside a restricted encounter public, which 2a spec §7.2 didn't allow. 2b fixes the engine to match §7.2 (§5.7), and decision 3 no longer applies.
- Rev 7 §7.2 sends a snapshot "only when state changed". The first Broadcaster for a channel since the process started always sends an `rf`, even when nothing changed, because changes may have been lost across a restart (§5.3).
- On 2a's viewer path, a config change sends a `config-changed` message, and clients refetch after a random 0–1 s delay. On the Twitch path, a config change becomes an `rf` snapshot with `rw` = 30 s (§5.3, §5.5). The 2a `config-changed` message stays for dev viewers, the dock and the overlay.
- 2a's viewer role row (§4.3) said the extension JWT would be used in 2b. The JWT is used only on the `/ext` routes (§4.1). On the 2a `/channels/:channel/*` routes, the viewer role stays dev login only.
- Rev 7 §1.2 said "Any streamer can sign up". 2b's default is invite-only through the allowlist (§4.3), and `DNDM_SIGNUP=open` restores open sign-up.
- 2a §1.2 and the engine spec put media uploads, the optional chat bot and the paid-pack "official" redefinition in Project 2. Media uploads move to Project 3, the chat bot (with chat bans) becomes its own project after Project 3, and the paid-pack redefinition waits for the first paid pack (§1.2, §11.2). Until media uploads exist, monster images stay as pack content provides them (or none).
- Rev 7 §7.2 said every own-state change "always produces a snapshot". 2b accepts one exception (§5.3, "a known gap"). A change that was pending when a Room unloaded, at shutdown, or at a crash, and whose send never succeeded, reaches viewers only when that channel's Room next loads (its first send is an `rf`, §5.3). Until then, those viewers catch up when they reopen the extension.
- The engine spec (§5.1) said "Signed paid packs come later". 2b's direction (§11.2) is that no signing is needed while packs only come from the official build.
- 2a left 2b to decide what "watched" means. **Twitch viewers are never watched.** A Twitch viewer's character stays loaded through every other rule in 2a §6.2's "Staying loaded" list: party membership, a running timer, being marked "removed by the streamer" while a session is open with `streamerRemovalWaitsForRest` on, and being "part of an input or a view read in the last 10 minutes". Dev viewers are watched while their WebSocket is open, as in 2a.

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
   - Reads the user's ID, login and display name with Get Users, called with the user token and no ID or login, which returns the token's owner (§6.2).
   - Revokes the user token (best effort) and keeps nothing from it.
4. **The allowlist.** If `DNDM_SIGNUP` is `allowlist` (the default) and the user's Twitch ID isn't on the allowlist, they see "The game isn't open for sign-ups yet." `DNDM_SIGNUP=open` skips this check.
5. **The channel.** If no channel has this `twitch_id`, one is created through 2a's `createChannel`, with the default config and the display name as its `name`. Otherwise the existing channel is used.
6. **The sign-in session.** The server sets a `dndm_session` cookie and redirects to `/setup`. (A *sign-in session* is this login cookie; it's unrelated to the game session in 2a's `rooms.session`.)
   - The cookie is signed with a key derived from `DNDM_SECRET`, under its own label.
   - It holds the channel ID, the Twitch ID and an expiry 7 days away.
   - It is `HttpOnly`, `Secure` and `SameSite=Lax`.
   - Sign-in sessions aren't stored, so one can't be revoked early. Signing out clears the cookie.

Taking someone off the allowlist stops new sign-ins only. Their channel, sessions and URLs keep working, and a regenerate from their own `/setup` or dock only gives them new URLs. Cutting a channel off (ending its URLs and sessions) is out of scope, like channel deletion (§1.2).

### 4.4 The setup page

`GET /setup` needs a valid sign-in session, and otherwise redirects to `/signup`. It shows:

- **the dock URL** `<DNDM_PUBLIC_URL>/dock#<dock token>` and **the overlay URL** `<DNDM_PUBLIC_URL>/overlay#<overlay token>`. The token sits in the URL fragment, so it never reaches server logs. Project 3 builds these screens; until then those two paths answer a short "coming in Project 3" page;
- the `dndm connect` line for the dock, so the channel can be driven from the CLI now;
- a link to install the extension;
- **Regenerate** buttons for each URL, and **Sign out**.

The buttons are POST forms carrying a CSRF token tied to the sign-in session. A regenerate runs as the Room's existing `regenerateDockUrl` or `regenerateOverlayUrl` server command, sent as the dock. It behaves exactly as in 2a: the old token stops working and its open WebSockets close.

### 4.5 Allowlist commands

These commands need `DATABASE_URL` and the Twitch client settings. Run against production, they manage production's allowlist.

- `dndm server allow <login>` resolves the login to a Twitch ID with Get Users, and adds it. An unknown login is an error.
- `dndm server disallow <login>` resolves the login with Get Users and removes the entry with that ID. If the login no longer resolves, or resolves to an ID that isn't on the list, it removes the entry whose stored login matches. If neither matches, it's an error.
- `dndm server allowlist` prints the entries.

## 5. Viewer updates

### 5.1 The snapshot

One JSON message per send, to the channel's `broadcast` topic, at most 5 KB. Short field names keep it small:

```json
{ "v": 1, "e": "q7Lw2k", "t": 1792287427123,
  "ph": "fight", "adv": { "id": "starter:the-cave", "lined": null },
  "f": { "n": "Goblin King", "img": null, "hp": 140, "mx": 200, "st": ["starter:drowsy"],
         "sub": "f", "held": false, "nt": 1792287431000 },
  "p": [["k3Fq9xTz0a", "starter:fighter", 80, 0], ["Wm2bLp7cQe", "starter:healer", 0, 1]],
  "rv": 7, "ch": ["k3Fq9xTz0a"], "rw": 1000, "cv": 3 }
```

| Field | Meaning |
|---|---|
| `v` | Format version, 1. |
| `e` | Epoch: 6 random base64url characters, chosen when the Broadcaster starts. When it differs from the one a client holds, the client refetches the roster, whatever `rv` says, after a random delay in `[0, rw]`. |
| `t` | Server time (ms) when the snapshot was built. Clients use it to correct their clock for countdowns, and drop a snapshot whose `t` is lower than one they already have (PubSub doesn't guarantee order). |
| `ph` | The phase from the public view: `closed`, `resting`, `fight` or `encounter`. |
| `adv` | The public view's `adventure`, or null. |
| `f` | The public view's `fight`, or null (rev 7's "last strike time" is dropped: the snapshot carries no events, and hit effects belong to the overlay): monster name `n`, image `img`, `hp`, max HP `mx`, status IDs `st`, `sub` (`f` fighting, `w` waiting), `held`, next turn time `nt`. |
| `p` | Party entries in join order: `[key, class, hpPercent, flags]`. `hpPercent` is `round(100 × hp / maxHp)`. `flags` is a number; the value 1 (its lowest bit) means knocked out. |
| `pt` | Present only when `p` was trimmed (§5.4): the full party size. |
| `rv` | Roster version (§5.3). |
| `ch` | The changed list (§5.3), as keys. |
| `rf` | `true` in place of `ch` when every viewer should fetch their own state. |
| `rw` | Refresh window in ms (§5.5). |
| `cv` | The channel's `config_version`. When it differs from the one a client holds, the client refetches `/ext/describe`, after a random delay in `[0, rw]`. |

- **A key** is an opaque name for a character, used only inside snapshots: the first 10 characters of base64url(HMAC-SHA256(k, channel ID + ":" + character ID)), where k is derived from `DNDM_SECRET` under its own label. Keys are short, the same length for every character (`dev:` ones included), and keep the Twitch user IDs of viewers who have never been in the party out of the broadcast. A key is stable for a channel while `DNDM_SECRET` stays the same.
- **A viewer learns their own key** from the `key` field in `/ext/view` and `/ext/commands` answers. Other party members' keys map to IDs and names through `/ext/roster` (§5.6). Every HTTP route, commands included, uses full character IDs.
- **Party statuses aren't in the snapshot.** Statuses come from packs, so they can't be fixed flag bits. A party member's statuses come from `/ext/party` (§5.6). This replaces rev 7's `statusFlags`.
- **Never in a snapshot:** events, encounter panels (per-viewer widgets such as a shop) and overlay scenes. Viewers see encounter content through their own state (§5.6).
- **Accepted: what a snapshot does reveal.** `ph` shows that an encounter is running, even a restricted one. `ch` lists the keys of viewers whose own state changed, without saying what changed.
- **Accepted: party state is public**, inside a restricted encounter too. HP, knockouts and statuses that the encounter's own handling changes show in `p`, the party's `statuses` and `/ext/party`, though the events that caused them are restricted. Whether this happens depends on the pack: the starter secret shop only spends gold and gives items. A member who equips or uses something bought in a secret shop changes their `p` entry (class, `hpPercent`), the roster (`rv`) and `/ext/party`, like any other party state. The events of equipping or using it aren't part of handling the encounter, so they stay public and name the item on the overlay's event feed. Criterion 3 protects the encounter's content (its events and panels; for a shop, goods, prices and what was bought), not party state or the events of using what was bought afterwards.
- **Accepted: party members' identities are public.** The party is public anyway (the overlay shows names, and a Twitch name resolves to a user ID). So `/ext/roster` and `/ext/party` give any JWT holder each party member's character ID (`twitch:<user_id>`) and key. Keys protect only viewers who have never been in the party. Once someone has been in the party, their key stays linkable to them for as long as it's stable. Neither shows an encounter's content.

### 5.2 Room additions

These are the only changes to the Room. 2a said 2b wouldn't change the Room (accepted, §2.2). Item 1 adds a read to the queue, and item 2 changes the memory sweep in Rooms that have a Broadcaster. Saving is untouched. Rooms without a Broadcaster are untouched apart from the view change below and the engine fix in §5.7, which apply to every Room.

1. **`room.broadcastState()`**, a read that runs through the Room's queue. It returns:
   - `publicView`;
   - `changed`: the IDs of every loaded character whose **comparison view** differs from the one recorded for them, in or out of the party.

   It then records the current comparison views.

   - **The comparison view** keeps only the per-character parts of `engine.view(game, id, now)`, matching rev 7 §7.3's "own state": `character` (which holds `stats`, statuses, gear and inventory), `panel`, and `abilities`, with each ability's `targets` removed and its `ready` and `reason` normalised as if its cooldown had ended (below). The view has no other top-level fields.
     - The public parts (`phase`, `fight`, `party`, `adventure`, `overlay`) are left out. Each either reaches viewers through the snapshot (`ph`, `f`, `p`, `adv`), or isn't needed live by the extension. The overlay scene is shown on the stream itself. Party detail is fetched when the extension needs it: names, classes and levels from `/ext/roster` when `rv` or `e` changes, and exact HP and statuses from `/ext/party` only when the target picker opens (rev 7 §9). A `/ext/party` fetch is one viewer's action, limited by the viewer rate limit (§4.1). With the starter pack, a public change such as a vote tally on the overlay or a monster's HP therefore puts nobody in `changed`. This isn't true for every pack: a pack whose `canUse` or stat modifiers read shared state (a monster's HP, the party's size) makes a public change alter members' own state, and they land in `changed` (§5.5).
     - `targets` is left out because it follows the party, which is public. Clients pick ally targets from `/ext/party` (rev 7 §9).
     - An ability's `ready` and `reason` are compared **as if its cooldown had ended**: a cooldown running out changes nothing in the comparison, and clients work cooldowns out from `readyAt` (rev 7 §7.3: "Cooldown countdowns are computed in the browser from end times"). Every other cause of readiness still counts: party membership, a knockout, a fight starting or ending (an ability's `when`), and `canUse`. A fight starting therefore puts every party member whose readiness flips into `changed`.
     - Every remaining field changes only through an input, a timer, or a load.
   - **When views are recorded.** In a Room with a Broadcaster, the Room records a character's comparison view at the moment it loads them, both when the Room itself loads and when it loads one character, before any command runs. So loading a character never makes them "changed" on its own, but a command that loads and changes a character does. It doesn't count as activity, so it never keeps a Room loaded or delays an unload. It also returns `inputs`, a counter the Room raises by one for every input that saved state (a command, a timer, a config change), and also exposes as a plain property (§5.3), so the Broadcaster can tell whether anything happened without queueing a read.
2. **Dropping waits for the broadcast, in Rooms with a Broadcaster only.** In such a Room, the memory sweep (2a §6.2) doesn't drop a character whose current comparison view differs from their recorded one. They'll be in the next changed list, and can be dropped at a later sweep. A dropped character's recorded view is discarded with them. In a Room without a Broadcaster, nothing is recorded, and the sweep is exactly 2a's.

Party entries in the engine's view gain `level` and `statuses` (the same shape as `character.statuses`), an additive change to `engine.view` used by the roster and `/ext/party`.

### 5.3 The Broadcaster

The RoomManager starts a Broadcaster for every loaded Room whose channel has a `twitch_id`, when Twitch is configured. It starts it as part of loading the Room, before the Room takes any input. The Broadcaster's first act is a `broadcastState()`, the first entry in the Room's queue. It records that result as "last sent" without sending, so every later change is measured against the state as loaded. The Broadcaster doesn't subscribe to the Room's output, so it doesn't count as a listener and never keeps a Room loaded.

- **The tick.** Every second on the server clock, it calls `broadcastState()` if the Room's `inputs` counter moved since the last call, if there are carried keys, or if an `rf` is due (below). The Room exposes `inputs` as a plain property the Broadcaster reads directly, outside the queue. `broadcastState()` returns it too, so each result carries the counter it matches.
- **Pacing is per channel.** The spacing (at most one send a second), a 429 wait and the failure backoff (§8) live in the Twitch client, keyed by the channel's Twitch ID. They outlive any one Broadcaster, so a Room that unloads and reloads quickly still keeps to them. Every send waits on this gate, including a first tick and a last tick.
- **What it sends.** A snapshot is sent when its content (everything but `t` and `rw`) differs from the last one sent, or its changed list isn't empty. Otherwise nothing is sent.
- **Config changes.** The snapshot carries `cv`, the channel's `config_version`. A config change moves it, so the next tick sends a snapshot. This stands in for 2a's `config-changed` message on the viewer path.
- **Keys are kept until delivered.** The changed list is every key from `broadcastState()` since the last successful send. A failed send keeps its keys for the next one.
- **The roster version.** The Broadcaster keeps the roster it last computed: each party member's ID, name, class and level, in join order, taken from the public view's party entries. `rv` goes up by one whenever the newly computed roster differs from it. It starts at 1 when a Broadcaster starts. Clients refetch the roster when `rv` or `e` is different from what they hold, after a random delay in `[0, rw]`. Because `e` is new with every Broadcaster, a lost update before a restart can't leave a client holding a roster with a matching `rv`.
- **Shared reads are cached.** `/ext/roster`, `/ext/describe` and the public view that `/ext/view` gives viewers without identity are the same for every viewer of a channel. The server builds each one once, per (`e`, `rv`), per `cv`, or per Room `inputs` value, and serves that copy to every viewer. These audience-wide fetches are spread by `rw`, but they aren't counted in §5.5's own-state target, because each costs a cache lookup, not a Room read.
- **When a send is an `rf`.** A Broadcaster's next send is an `rf` whenever one of these is due:
  - **It's the first Broadcaster for this channel since the process started**, whether at boot or on a later on-demand load. Changes may have been lost across a restart or a crash. This send goes out on its first tick.
  - **The channel's pacing gate has recorded dropped keys.** That can happen before this Broadcaster started, or later, while it runs: an earlier Broadcaster's last send can fail within its 30 s retry. If no Broadcaster is running for the channel, the next one to start makes the `rf`.
  - **The config changed** (`cv` moved, §5.1). A config change can alter every character's own state, loaded or not, so every viewer refetches.

  Otherwise, a Broadcaster's first send is an ordinary one, made once something changes after the load (rev 7 §7.2's "only when state changed"). A command that loaded the Room and changed state is such a change, because the baseline was recorded before it ran. Clients see the new `e` with that first send.
- **Unloading.** When its Room unloads, the RoomManager first runs the Broadcaster's last `broadcastState()` through the Room's queue, as the Room's final read. Then it closes the Room as in 2a, and sends that last snapshot (with any carried keys) in the background. The unload doesn't wait for the send. Inputs for the channel go to a freshly loaded Room, as 2a's retry on a closed Room already does. The last send keeps trying, through the pacing gate, for up to 30 s, and a new Broadcaster's sends queue behind it on the same gate. If it still fails, the gate records that keys were dropped, and the dropped-keys `rf` rule above applies.
- **Accepted: a known gap.** Until the channel's Room loads again, nothing sends that `rf`. The affected viewers keep their last state until they reopen the extension, which fetches `/ext/view`. Rooms unload only with no game session open and no running timers, so the gap covers one missed change to a state that isn't changing. When the Room next loads (in this process, or after a restart or crash), its `rf` closes the gap.

### 5.4 Size

The snapshot is serialized and measured in bytes. Over 5 KB, in this order:

1. Trim `p` to the first members by join order that fit, and add `pt`.
2. If it still doesn't fit with `p` empty, replace `ch` with `rf: true`.
3. If it still doesn't fit (for example, a very long monster name), send only `{ "v": 1, "e": …, "t": …, "rf": true, "rw": 30000, "cv": … }` and log it.

In that bare form, `ph`, `adv`, `f`, `p` and `rv` are missing. A client that gets it keeps its current roster, unless `e` changed, in which case the `e` rule applies (it refetches the roster). It takes the public state (phase, fight, party, adventure) from a `/ext/view` fetch, made after a random delay in `[0, rw]`: its own view with identity, or the cached public view (§5.3) without. Every field other than `v`, `e`, `t`, `rw` and `cv` is optional in the format, and absence means "not in this snapshot", never null.

### 5.5 The refresh window

`rw` tells clients how long to spread their own-state fetches. Each viewer picks a random delay in `[0, rw]`.

- With a changed list, `rw` is the number of keys × 10 ms, at least 1,000 ms and at most 30,000 ms.
- With `rf`, `rw` is always 30,000 ms. `rf` is rare: a channel's first Broadcaster after a restart, dropped keys, a config change, or a changed list that doesn't fit (§5.4). Every viewer with identity fetches, and the server can't count them, so it uses the longest window.

The server sets it, so it can be tuned without an extension update.

**A known load risk.** A long changed list or `rf` comes from changes that touch many viewers' own state at once: an encounter starting or ending (every member's panel changes), a fight starting or ending (abilities' readiness flips), a fight's rewards, a config change (`rf`), a pack whose panel shows shared state, or a pack whose `canUse` or stat modifiers read shared state. Otherwise the comparison view (§5.2) keeps public changes, such as an overlay tally or monster HP, out of `changed`. The **target** is about 100 own-state requests per second per channel for the fetches one send triggers (fetching viewers ÷ window). It holds for one send while the fetching viewers number up to about 3,000. Two known limits, not guarantees:

- **Beyond about 3,000 fetching viewers**, the 30 s cap wins and the rate rises above the target.
- **Windows overlap.** Each send sizes `rw` from its own keys only, and sends can go out every second. In a long fight where more than 100 keys change every second, the rate follows the number of changed keys per second instead (roughly 300 a second with 3,000 active members, from Attack's 10 s cooldown and monster turns hitting many targets). An `rf` that lands inside another `rf`'s 30 s window doubles the `rf` rate while they overlap.

An acting viewer's own key stays in `ch` even though their `/ext/commands` answer carried their view, because a timer can change their state again before the next send. The constants live in one place, so they can be tuned.

### 5.6 `/ext` routes

Any valid JWT is enough for these routes, unless the table says otherwise. The channel comes from the JWT.

| Route | Answer |
|---|---|
| `GET /ext/view` | With identity: the caller's own view, loading their character as a 2a view read does, plus their `key` (§5.1). Without: the public view. |
| `POST /ext/commands` | Body `{ id, command }`, as 2a §4.1, for viewer commands only (identity required). The answer adds `view`, the caller's own view after the command (rev 7 §7.3), and `key`, on success and on engine rejections. On a repeated request ID for an accepted command that changed state (the only kind 2a §4.1 stores), `ok`, `events` and `result` are replayed from storage, but `view` and `key` are computed fresh, so they're current after a restart. Other requests simply run again, as in 2a. |
| `GET /ext/describe` | The channel's content catalog, as 2a's `describe`. |
| `GET /ext/roster` | `{ rv, members: [[key, id, name, class, level]] }` for the party, in join order. |
| `GET /ext/party` | `{ members: [{ key, id, name, class, level, hp, maxHp, knockedOut, statuses }] }`, the whole party, for the target picker (rev 7 §9). |

`events` in a `/ext/commands` answer are filtered by 2a's audience rule, as for any viewer.

### 5.7 Reaction audiences (engine fix)

2a spec §7.2 says every event produced while handling a restricted encounter gets its audience. As built (2a README decision 3), only events from the encounter's start, `respond`, wake-ups and end are stamped. Reactions run later, in `settle`, so their events stay public and reach the overlay's event feed. A reaction to a purchase in a secret shop would show what was bought on the overlay's event feed. Equipping or using a bought item afterwards is ordinary public play (§5.1), and this fix doesn't change it.

2b fixes this in `packages/engine`:

- A reaction queued while handling a restricted encounter (at one of those four points) carries the encounter's audience, worked out when it is queued.
- Every event emitted while that reaction runs gets that audience, core events from `ctx` operations included, unless the emit sets its own audience.
- Reactions it queues in turn carry the same audience, to any depth. The `core:reaction-limit` event for such a chain gets it too.
- Reactions queued outside a restricted encounter stay public, as in 2a.

The rule applies whatever the config (§1.1 criterion 6), because it lives in the engine.

## 6. The Twitch client

### 6.1 App access token

Comes from the client credentials grant (`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`). It's kept in memory, refreshed when less than 10 minutes remain, and refreshed once more on any 401 from Twitch before the call is retried.

### 6.2 Get Users

Two modes:

- **With the app token**, it looks up users by ID (for display names) or by login (for the allowlist).
- **With a user token** and no ID or login, it returns that token's owner. Only sign-up uses this mode (§4.3, §6.4).

### 6.3 Send Extension PubSub Message

- **The JWT.** For each send, the server signs a JWT with the extension secret:
  - `exp`: now + 60 s;
  - `user_id`: `TWITCH_OWNER_ID`;
  - `role`: `external`;
  - `channel_id`: the channel's Twitch ID;
  - `pubsub_perms`: `{ send: ["broadcast"] }`.
- **The request** carries `Client-Id: TWITCH_CLIENT_ID`, with the body `{ target: ["broadcast"], broadcaster_id, message }`.
- **Rate limits.** We send at most once a second per channel. A 429 waits until Twitch's rate-limit reset header before that channel's next send. Both are enforced by the per-channel pacing gate (§5.3).

### 6.4 OAuth

Used only by sign-up (§4.3):

- the authorize URL, with no scopes;
- the code exchange;
- Get Users with the user token, to identify who signed in (§6.2);
- token revocation.

## 7. Deploy and config

### 7.1 The image

- A two-stage `Dockerfile` on `node:24-slim`:
  - `pnpm install --frozen-lockfile`;
  - it runs as a non-root user;
  - it starts with `dndm server start --host 0.0.0.0 --port 8080` (`--host` already exists in the 2a CLI, though 2a §8.1 doesn't list it), through `tsx`, as locally.
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

- **"Twitch is configured"** means `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_EXTENSION_SECRET`, `TWITCH_OWNER_ID` and `DNDM_PUBLIC_URL` are all set. `TWITCH_EXTENSION_SECRET_PREVIOUS` is optional and isn't part of this check. With some but not all of them set, the server refuses to start and names what's missing. With none set, there are no `/ext`, `/signup`, `/setup`, `/dock` or `/overlay` routes and no Broadcasters, as in 2a (apart from the four changes in §1.1 criterion 6).
- With Twitch configured and `DNDM_DEV=1`, the server starts and logs a warning on every boot.

### 7.3 `GET /health`

Returns 200 `{ ok: true }` once the server holds the advisory lock and has finished boot loading (2a §6.4). Before that, it returns 503.

### 7.4 Clean shutdown

On SIGTERM, the server:

1. stops accepting requests;
2. waits up to 15 s for every Room's queue to finish (`manager.idle()`, which fixes 2a's deferred minor);
3. runs each Broadcaster's last tick through the pacing gate, waiting up to 10 s more. Sends still waiting then are abandoned. After the restart, each channel's first Broadcaster sends an `rf` (§5.3), which closes the gap whenever the Room loads. Shutdown is not an unload, so §5.3's 30 s background retry doesn't apply. Steps 2 and 3 together fit inside Fly's 30 s `kill_timeout`;
4. closes the Store, which releases the lock.

Fly's `kill_timeout` is 30 s.

### 7.5 Fly.io

`fly.toml` in the repository:

- **One machine**, never auto-stopped: `auto_stop_machines = "off"` and `min_machines_running = 1`. Game timers live in memory.
- **`release_command`** runs `dndm server migrate` on a temporary machine before each deploy.
- **`strategy = "rolling"`.** With one machine, it stops the old one before starting the new one, so two servers never fight over the lock. `bluegreen` and `canary` must not be used. The plan confirms this behavior against Fly's documentation. If two machines ever do overlap, the new server refuses to start while the old one holds the lock (2a §6.6), and Fly starts it again.
- **The health check** is `GET /health`.
- **The app name** has a random suffix (Twitch policy 2.13: "Public hosted domains should have a unique identifier or the url must be on a private domain"). A custom domain can come later, and it must meet the same rule: it is a domain this project owns (a private domain), or it carries a unique identifier.

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

- **The fake Twitch** is a local Fastify app that plays the OAuth, token, Get Users (by ID, by login, and a user token's owner) and PubSub endpoints. It records every request and can be told to fail, time out or answer 429. The Twitch client takes its base URLs from config, and tests point them at the fake.
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
  - loading a character (a view read) doesn't put them in `changed`, and a cooldown running out alone doesn't either;
  - a viewer's `key` from `/ext/view` matches their entry in `p`, `ch` and `/ext/roster`;
  - the sweep doesn't drop a character with an unbroadcast change.
- **Broadcaster**, with the FakeClock and the fake Twitch:
  - at most one send per second;
  - no send when nothing changed;
  - failed sends and 429s keep their keys;
  - a first send has `rf` at boot and after dropped keys, including keys dropped while a newer Broadcaster already runs; on an ordinary load nothing is sent until something changes, and a `join` that loaded the Room is sent; `e` is new with every Broadcaster;
  - the bare fallback omits `ph`, `adv`, `f`, `p` and `rv`, and `/ext/roster` and `/ext/describe` are served from a cache;
  - a replayed `/ext/commands` request gets a fresh `view` and `key`;
  - with the starter pack, a public change (monster HP, an overlay tally) puts nobody in `changed`; with a test pack whose `canUse` reads monster HP, a monster HP change puts the affected members in `changed`;
  - `rv` bumps on roster changes only;
  - a config change moves `cv` and sends an `rf`;
  - a fight starting puts members whose readiness flips in `changed`, and a cooldown ending alone doesn't;
  - the first Broadcaster for a channel after a restart sends `rf`, at boot or on a later load;
  - the unload's last `broadcastState()` runs before the Room closes;
  - trimming and the `rf` fallbacks at 5 KB (§5.4);
  - the `rw` values;
  - the last tick on unload;
  - **a secret shop's content never appears in any snapshot**, while a member who equips a bought item mid-shop changes their `p` entry and `rv` (criterion 3);
  - with a test pack whose restricted encounter heals a member in `respond`, the encounter's events stay restricted while the member's `p` entry and `/ext/party` show the new HP (§5.1);
  - the first send after a restart is an `rf` even when nothing changed.
- **Reaction audiences (engine, §5.7):**
  - a reaction queued by a restricted encounter's `respond` gets its audience, and so does a reaction it queues;
  - reactions queued by the encounter's start, a wake-up and its end get it too;
  - an emit inside such a reaction that sets its own audience keeps it;
  - a reaction queued outside a restricted encounter stays public;
  - equipping an item bought in a secret shop while the shop is still open gives public events (§5.1);
  - the Hub doesn't send such a reaction's events to the overlay, and `/ext/commands` answers show them only to the audience.
- **Sign-up:**
  - an account not on the allowlist is turned away, and `open` mode lets it in;
  - the callback identifies the user with Get Users on the user token, then revokes it;
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
- **What "official" means for them.** The definition in the engine spec (§5.1, "folders in this repository's `packs/`", "reviewed and merged into this repository") will change, when paid packs are built, to **"in the official server's build"**. Paid packs are reviewed and merged in their private repository under the same rules as this one. No signing is needed while packs only come from the build; signing matters only if packs are someday loaded from outside it. Until that project, the engine spec's definition stands, and nothing in 2b loads a pack from outside `packs/`.
- **Unlocking them.** A later project adds a record of which channels have unlocked which paid packs.
- **Twitch policy.** Charging broadcasters for features or plugins is allowed (Twitch extension policy 5.1). Purchase links never appear in the viewer extension (policy 4.6.3), so buying happens on a website or in the dock.

### 11.3 Open decisions carried from 2a

- **Reaction events inside restricted encounters** were public under 2a README decision 3. 2b resolves this by fixing the engine (§5.7).
- **The 5-minute `replayRevoked` window** for regenerated tokens (2a §4.1) is unchanged.
