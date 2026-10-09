# twitch-dndm — Milestone 1: Core Game Design

**Date:** 2026-10-08
**Status:** Draft for review

## 1. Purpose

twitch-dndm is a from-scratch rebuild and evolution of the author's earlier hand-coded Twitch dungeon game. The whole audience works together as a party to fight monsters the streamer spawns at their own pace. The streamer uses it to run a live adventure and tell a story; viewers take part through a Twitch Extension rather than typing in chat.

The original project (`../twitch-emitter`) is a reference for game feel only. No code is copied from it and it is never modified.

### 1.1 What we keep from the original

- Everyone in the audience cooperates against one monster at a time.
- The streamer controls pacing: nothing happens until they spawn it.
- A streamer control panel that lives in an OBS dock.
- Persistent state in a database behind an API.

### 1.2 What changes

- **No chat spam.** Viewers play through a Twitch Extension, which works on desktop and in the Twitch mobile app. There is no chat bot in this milestone.
- **Monsters fight back.** They damage players, can make them drowsy (longer cooldowns), and can knock them out.
- **Classes.** Fighter, Tank and Healer, chosen by equipped weapon.
- **Players have HP and gear.** HP carries over between fights.
- **Multi-channel from day one.** Any streamer can sign up; every channel is its own world.
- **Heavily customizable by the streamer.** Every rule has a per-channel setting, and every streamer action is a named command.

### 1.3 Success criteria

1. dj_teknal can run a full adventure live: start, several fights, end. Viewers join and play from desktop and mobile through the extension, with nothing typed in chat.
2. A second streamer can sign up, install the extension, and run their own adventure with separate players, monsters and settings.
3. A server restart in the middle of a fight resumes that fight from its last saved state.
4. The overlay and extension look finished without any illustrated art.

## 2. Scope

### 2.1 In scope (Milestone 1)

- `packages/engine`: pure game rules.
- `apps/server`: HTTP API, per-channel game Rooms, persistence, real-time fan-out.
- `apps/web`: streamer sign-up page, control dock, stream overlay, dev-only simulator.
- `apps/extension`: Twitch Extension viewer UI (video overlay type, mobile view).
- Streamer monster editor with optional image upload.
- Built-in starter items (sword, shield, staff) and a small set of built-in drop items and starter monsters (stats only, no art).

### 2.2 Out of scope (later milestones)

| Later milestone | Contents |
|---|---|
| Events & shops | Timed shops and secret shops as encounters, item editor, Chaos Mode (timed free class-swapping mid-fight) |
| Programmability | Streamer triggers that play sounds or run scripts; Stream Deck buttons; both call the existing command API |
| Companion web page | Play via QR code or link outside Twitch |
| Rhythm mode | Beat/BPM detection running on the streamer's machine, sending beat events to the server |
| Monetization | Paid content expansions, Bits, seasons, support pass |
| Chat | Optional quiet chat bot via one shared bot account |
| Extras | More classes, global player profiles, moderator roles, seasons/resets |

## 3. Architecture

```
 Viewers (extension, desktop + mobile)              Streamer
        │ HTTPS actions (Twitch extension JWT)       │
        ▼                                            ▼
 ┌──────────────── apps/server (Node, TypeScript) ────────────────┐
 │  HTTP API ──► RoomManager ──► Room (one per channel)            │
 │                                 └─ uses packages/engine         │
 │  Persistence (Postgres)        Broadcaster (fan-out)            │
 └──────┬────────────────────────────┬───────────────┬────────────┘
        │                            │               │
  Twitch Extension PubSub       WebSocket        WebSocket
  (state snapshot, ≤1/sec)       overlay        control dock
        ▼                            ▼               ▼
  viewers' extensions        OBS browser source   OBS custom dock
```

### 3.1 Technology

- TypeScript throughout; pnpm workspaces monorepo; Node.js 24.
- Server: Fastify for HTTP, the `ws` library for WebSockets, Drizzle ORM with PostgreSQL.
- Frontends (`apps/web`, `apps/extension`): React + Vite. The extension builds to a static zip, as Twitch requires.
- Tests: Vitest.
- Hosting: one always-on server process (Fly.io or Railway) and managed Postgres. Monster images go to S3-compatible object storage; local development stores them on disk.

### 3.2 Components

**`packages/engine`** — pure game logic. No I/O, no clock, no `Math.random`.

- `applyAction(state, action, now, rng) → { state, events }`
- `applyCommand(state, command, now, rng) → { state, events }` (streamer commands)
- `tick(state, now, rng) → { state, events }` (advances timers: monster attacks, effect expiry)
- `nextWakeTime(state) → time | null` (when `tick` next needs to run)
- Events are a typed union, e.g. `PlayerAttacked`, `MonsterStruck`, `PlayerKnockedOut`, `EncounterWon`, `PlayerRemoved`. They drive the overlay feed and animations.
- All randomness comes from an injected seeded RNG so tests are deterministic.

**`Room`** (in `apps/server`) — one live game per channel.

- Holds the channel's live state, settings, and timer.
- Serializes all inputs (actions, commands, ticks) through one queue so they never interleave.
- Schedules a single timer for `nextWakeTime`.
- After each input: persists if needed (§6.2), hands events and state to the Broadcaster.

**`RoomManager`** — creates Rooms on demand (first request for a channel), loads them from Postgres, and unloads a Room after 30 minutes with no adventure running.

**`Broadcaster`** — fans out to three audiences (§7).

**Auth** — three credential types (§8).

## 4. Game rules

All numbers below are defaults, kept in one tuning file in `packages/engine`. Every one marked ⚙ can be overridden per channel (§5.3).

### 4.1 Lifecycle

- **Adventure**: the streamer starts one; the party is open to join. Ending it disbands the party. Player progress (level, XP, gold, gear, current HP) is persistent.
- **Encounter** ("round"): one unit within an adventure. In this milestone the only encounter type is **combat** (spawn → win, flee, end early, or streamer ends after a wipe). Later milestones add **event** encounters (shops); event encounters never cause removal.
- Only one encounter runs at a time. Between encounters the party is "resting".

### 4.2 Players

- A player record is per (channel, Twitch user). A viewer has an independent character in every channel.
- Joining requires the viewer to share their Twitch identity with the extension (once).
- A player joins by choosing a weapon. Joining is allowed while resting; joining mid-fight is allowed when ⚙ `allowJoinMidFight` is on (default on).
- Party size cap ⚙ `partyCap`, default 50.

**Stats** (base values by class, before gear and level):

| Class (weapon) | Max HP | Damage | Notes |
|---|---|---|---|
| Fighter (sword) | 100 | 10 | |
| Tank (shield) | 160 | 5 | |
| Healer (staff) | 90 | 4 | Heal power 30 |

- Each level adds +5 max HP and +1 damage.
- Base crit chance 5%; crits deal double damage.
- Each hit deals `damage × (1.0 to 1.2, random)`, rounded.

### 4.3 Gear

- Two slots: **weapon** (sets class) and **armor**.
- Item stats can add: damage, max HP, heal power, crit chance, damage reduction %.
- Every player owns the three starter weapons permanently and can't lose them. Other items come from drops (§4.7) or streamer gifts.
- Gear can be changed only while resting, never during an encounter.
- If a gear change lowers max HP, current HP is capped at the new max. Raising max HP doesn't raise current HP.

### 4.4 Actions and cooldowns

| Class | Action | Effect | Cooldown ⚙ |
|---|---|---|---|
| All | Attack | Deal damage to the monster | 10 s |
| Fighter | Special Attack | Deal 2.5× damage | 45 s |
| Tank | Guard | For 8 s, monster attacks target guarding tanks first; guarding tanks take 50% less damage | 30 s |
| Healer | Heal (target) | Restore heal power HP to a party member (not above max) | 15 s |
| Healer | Revive (target) | Bring a knocked-out member back at 30% max HP | 60 s |
| Healer | Cure (target) | Remove drowsiness from a member | 20 s |

- Each action has its own cooldown.
- Knocked-out players can't act.
- **Drowsy**: any cooldown started while drowsy is multiplied by ⚙ `drowsyMultiplier` (default 1.5). Drowsiness lasts ⚙ 30 s. It doesn't change cooldowns already running.
- Actions are only accepted during a combat encounter, from party members.
- Healers may target themselves with Heal and Cure (not Revive, since a knocked-out player can't act).

### 4.5 Monsters

A monster template has: name, optional image, max HP, damage per hit, attack interval (default 20 s), targets per attack (blank = automatic), drowsy chance, knockout chance, XP reward, gold reward, drop table.

**Monster attack** (every attack interval, during combat, unless paused):

1. Number of targets: the template's value, or automatic = `ceil(activeMembers / ⚙ membersPerTarget)` with `membersPerTarget` default 5, minimum 1. "Active" = in the party and not knocked out.
2. Choose targets: guarding tanks first (random order among them), then random other active members, until the count is reached or no one is left.
3. Each target takes the monster's damage (minus damage reduction from gear and Guard). Then, independently: roll drowsy chance → drowsy; roll knockout chance → knocked out.
4. A player whose HP reaches 0 is knocked out.
5. The overlay shows a countdown to the next attack; the extension shows the same countdown.

**Knocked out**: lasts ⚙ 60 s or until revived. When it ends without a revive, the player returns at 25% max HP. A knocked-out player is still in the party.

**Party wipe**: if no party member is active, the encounter enters `wiped`: the monster's attack timer pauses and the overlay shows the wipe. Knockout timers keep running. Players who return from knockout during a wipe end it: the encounter goes back to combat and the attack timer resumes with a full interval. The streamer can also revive everyone, flee, or end the encounter (§5.1).

### 4.6 Encounter end and removal

When a combat encounter ends:

- **Won** (monster HP reaches 0, or streamer "end with rewards"): rewards go to *eligible* members.
- **Fled / ended without rewards**: no rewards.

**Eligible** = in the party when the encounter ended and performed at least one action during it.

**Removal rule** (⚙ `autoRemoveIdle`, default on): at the end of *any* combat encounter (won, fled, or ended), members who performed no action during it are removed from the party, with one exemption: a member who was knocked out for the entire time they were in the encounter stays in the party (but isn't eligible for rewards). A member who joined mid-fight is judged from the moment they joined.

Removed players keep all progress and can rejoin while resting.

### 4.7 Rewards and progression

- Each eligible member receives the monster's full XP and gold (multiplied by ⚙ `xpMultiplier` and `goldMultiplier`, default 1.0).
- Each eligible member rolls each drop-table entry independently (`item`, `chance`). Duplicate items stack in inventory.
- **Levels**: reaching level 2 needs 80 XP; each later level needs 50 XP more than the previous step (80, 130, 180, …), scaled by ⚙ `xpCurveMultiplier`.
- **HP carries over** between encounters (⚙ `healBetweenFights`, default off). Knockout timers keep running between encounters.

## 5. Streamer controls

### 5.1 Commands

Every streamer action is a named command handled by `applyCommand`. The dock calls them now; Stream Deck and scripts will call the same commands later.

| Area | Commands |
|---|---|
| Adventure | `startAdventure`, `endAdventure`, `removePlayer(player)` |
| Encounter | `spawnMonster(template)`, `endEncounter(withRewards: bool)`, `flee` |
| Healing | `healPlayer(player, amount \| full)`, `healParty`, `revivePlayer(player)`, `reviveAll` |
| Effects | `applyDrowsy(player)`, `knockOut(player)`, `cure(player)` |
| Monster | `monsterStrikeNow`, `pauseMonster`, `resumeMonster`, `setMonsterHp(value)` |
| Rewards | `giveXp(target, amount)`, `giveGold(target, amount)`, `giveItem(target, item)` (target = player or party) |
| Feed | `postMessage(text)` |

Each command emits an event shown on the overlay feed. `spawnMonster` only works while resting. `flee` and `endEncounter` end the current combat encounter and apply §4.6.

### 5.2 Control dock

A web page added as an OBS custom browser dock. Sections:

- **Live**: adventure state, current monster (HP, next-attack countdown), party list (HP, status, class) with per-player command buttons, and the command buttons from §5.1.
- **Monsters**: create, edit and delete monster templates; upload an image (PNG, GIF or WebP, ≤ 2 MB). New channels start with 3 built-in starter monsters (no images), which they can edit or delete.
- **Settings**: every ⚙ value in §4, grouped by topic, with "reset to default".
- **Setup**: overlay URL, dock URL, and a link to install the extension.

### 5.3 Settings

Stored per channel as a JSON object of overrides; anything absent uses the engine default. Settings changes apply immediately, but a changed cooldown doesn't affect cooldowns already running.

## 6. Data

### 6.1 Persistent tables (Postgres)

- **channels**: Twitch broadcaster ID, display name, settings overrides (JSON), dock token hash, overlay token hash, created/updated times.
- **players**: channel ID, Twitch user ID, display name, level, XP, gold, current HP, equipped weapon, equipped armor, knockout-until time. Unique on (channel, Twitch user).
- **inventory**: player ID, item ID, quantity.
- **item_templates**: built-in items (channel ID null) and, later, channel items. Slot, class (weapons), stat bonuses.
- **monster_templates**: channel ID and the fields in §4.5; image storage key.
- **room_snapshots**: channel ID, serialized live state (JSON), saved time, engine state version.
- **encounter_log**: channel ID, monster template, start/end, outcome, participants. For history; not read by the game.

### 6.2 Live state and saving

The Room's live state (party, encounter, monster HP, effects, cooldowns, timers) is written to `room_snapshots`:

- immediately after: adventure start/end, encounter start/end, knockout, revive, gear change, join/leave, any streamer command;
- otherwise at most every 10 s while something changed.

Player rows (XP, gold, level, inventory, current HP) are written at encounter end and on gear change, join and leave.

**Restart**: on load, the Room reads its snapshot and resumes. Timestamps are absolute, so effects, knockouts and cooldowns that expired during the downtime are treated as expired; the monster's next attack is rescheduled to a full interval from the moment of load (so a restart never causes an instant attack). Changes since the last snapshot (at most ~10 s of HP and cooldown changes) can be lost.

## 7. Real-time updates

### 7.1 Overlay and dock (WebSocket)

- On connect: full state.
- Then: every engine event, immediately, plus a full state after each input.
- Clients reconnect automatically with backoff and receive full state again.

### 7.2 Extension (Twitch Extension PubSub)

- Twitch limits: 5 KB per message; about 1 message per second per channel.
- The server sends a **compact snapshot** to the channel's broadcast topic at most once per second, only when state changed.
- Snapshot contents: adventure/encounter state, monster (template ID, HP, max HP, next attack time), and party entries as `[playerKey, class, hpPercent, statusFlags]`, plus a `rosterVersion` number.
- Names and gear are **not** in the snapshot. When `rosterVersion` changes, the extension fetches the roster (player keys → names, classes, levels) over HTTP.
- If a snapshot would exceed 5 KB, party entries are trimmed to the first members by join order and the snapshot carries a `partyTotal` count. At the default cap of 50 the snapshot fits.
- If a send fails or is rate-limited, it is dropped; the next snapshot contains the full state.

### 7.3 A viewer's own state

- Action responses return the viewer's updated state immediately (HP, effects, cooldown end times).
- The extension also fetches its own state over HTTP on load and whenever the snapshot shows its own entry changed.
- Cooldown countdowns are computed in the browser from end times the server sends.

## 8. Auth and identity

- **Viewers**: the extension sends Twitch's extension JWT with each request. The server verifies it with the extension secret and reads `channel_id` and `user_id`. Joining requires `user_id` (identity shared). Viewers who haven't shared identity can watch but must share to join. Logged-out viewers can only watch.
- **Streamer sign-up**: a web page with Twitch login (OAuth). Signing in creates the channel and shows the dock and overlay URLs. The streamer can regenerate either URL, which invalidates the old one.
- **Dock URL** carries the dock token: full control of that channel (commands, monsters, settings). **Overlay URL** carries the overlay token: read-only.
- Tokens are random 32-byte values; only hashes are stored.
- If a viewer opens the extension on a channel that hasn't signed up, it shows "This streamer hasn't set up the game yet."
- Display names come from Twitch's Get Users API (app access token) and are refreshed on join.

## 9. Viewer extension

- Type: video overlay, with a collapsible side panel. On mobile, the same panel fills the chat-area view.
- **Not joined**: "Join the party" → identity share (first time) → weapon pick (sword / shield / staff).
- **In party, in combat**: own HP bar, status icons, level, gold; class action buttons with countdowns (greyed out on cooldown or while knocked out); party list (healers tap a member to target Heal, Revive or Cure); monster name, HP and next-attack countdown.
- **In party, resting**: gear and inventory; change weapon (class) or armor.
- **Removed or no adventure**: short message and Rejoin button when available.
- Failed actions show a short message: "On cooldown (4s)", "You're knocked out", "Not in the party".
- Monster images load from the server's image host, which is added to the extension's allowed domains.

## 10. Stream overlay

- One OBS browser source, transparent, 1920×1080, read-only.
- Shows: monster card (image if uploaded, otherwise a styled name card), HP bar, next-attack countdown, hit and crit flashes; party strip (name, class icon, HP, status); event feed; big callouts for encounter start, win, wipe and monster strikes.

## 11. Art policy

- No AI-generated art ships in the product. Final art comes from a hired illustrator.
- Milestone 1 visuals are built from type, shape, color and motion and must look finished without illustrations.
- Allowed now: simple vector class icons (sword, shield, staff).
- Monster images are optional uploads by the streamer.
- Inspiration sketches, if ever made, live outside the app's source tree and are never shipped.

## 12. Reliability and errors

- The server is authoritative: cooldowns, damage and eligibility are always computed server-side.
- Per-player rate limit: 5 action requests per second; extra requests are rejected. A repeated identical request ID is ignored (idempotency key).
- All inputs to a Room are processed one at a time (§3.2).
- Errors return a stable error code and a human-readable message. Server errors are logged with channel and player IDs.

## 13. Testing

- **Engine** (test-first, seeded RNG): damage and crits, cooldowns and drowsy multiplier, targeting with and without Guard, knockout from HP and from chance, knockout expiry and revive, heal caps, wipe and recovery, eligibility and removal (including the knocked-out exemption and mid-fight joins), rewards and drops, levels, every streamer command, settings overrides.
- **Room** (fake clock): timer scheduling, full fight start to finish, input ordering, snapshot save triggers, restart and resume.
- **Server**: JWT verification, dock/overlay token checks, command and action endpoints, PubSub snapshot size and trimming.
- **Simulator** (dev only, in `apps/web`): spawns fake viewers who join and act at random, to test large parties locally.
- **Manual**: Twitch local test mode for the real extension on desktop and mobile.
