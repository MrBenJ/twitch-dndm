# twitch-dndm — Milestone 1: Core Game Design

**Date:** 2026-10-08
**Status:** Ready for owner review (revision 7)

> **Superseded in part (2026-10-11).** The game rules (§4) and game commands (§5.1) are replaced by `2026-10-11-engine-and-packs-design.md` (Project 1). The rest of this document is the starting point for Project 2 (server and live play) and will be revised to match the modular engine.

## 1. Purpose

twitch-dndm is a from-scratch rebuild and evolution of the author's earlier hand-coded Twitch dungeon game. The whole audience works together as a party to fight monsters the streamer spawns at their own pace. The streamer uses it to run a live adventure and tell a story; viewers take part through a Twitch Extension rather than typing in chat.

The original project (`../twitch-emitter`) is a reference for game feel only. No code is copied from it and it is never modified.

### 1.1 What we keep from the original

- Everyone in the audience cooperates against one monster at a time.
- The streamer controls pacing: no fight starts until they spawn a monster.
- A streamer control panel that lives in an OBS dock.
- Persistent state in a database behind an API.

### 1.2 What changes

- **No chat spam.** Viewers play through a Twitch Extension, which works on desktop and in the Twitch mobile app. There is no chat bot in this milestone.
- **Monsters fight back.** They damage players, can make them drowsy (longer cooldowns), and can knock them out.
- **Classes, HP and gear.** A player's equipped weapon decides their class. HP carries over between fights.
- **Multi-channel from day one.** Any streamer can sign up; every channel is its own world.
- **Deeply configurable.** Every number, base stat, class, action, item and monster is data in a per-channel **Ruleset** (§4), along with the on/off switches listed in §4.9. The rest of the behavior described in §4, and the **game vocabulary** (§4.1: effect types, target types, statuses and item slots), is fixed in this milestone; new switches are added when a real need appears, and extending the vocabulary belongs to the Programmability milestone. Server protections such as the request rate limit (§12) are not game rules. The game ships with a default ruleset (three classes, starter gear, starter monsters) as an example; a streamer can change or replace any part of it. Later, content packs are bundles of ruleset pieces.
- **Every action taken while running or configuring the game is a named command** (§5), so later Stream Deck buttons and scripts can trigger it. Two account actions are exceptions because they need the streamer to log in to Twitch in a browser: signing up (§8) and connecting chat bans (§8).

### 1.3 Success criteria

1. dj_teknal can run a full adventure live: start, several fights, end. Viewers join and play from desktop and mobile through the extension, with nothing typed in chat.
2. A second streamer can sign up, install the extension, and run their own adventure with separate players, ruleset and monsters.
3. A streamer can change any number, stat, class, action, item, monster or §4.9 switch without a code change.
4. A server restart in the middle of a fight resumes that fight from its last saved state.
5. The overlay and extension look finished without any illustrated art.

## 2. Scope

### 2.1 In scope (Milestone 1)

- `packages/engine`: pure game rules driven by a Ruleset.
- `apps/server`: HTTP API, per-channel game Rooms, persistence, real-time fan-out, command API.
- `apps/web`: streamer sign-up page, control dock, stream overlay, dev-only simulator.
- `apps/extension`: Twitch Extension viewer UI (video overlay type, mobile view).
- The default ruleset.
- In the dock: form editors for rules, base stats, level growth and monsters (with optional image upload); a JSON editor with import/export for the whole ruleset (classes and items included).

### 2.2 Out of scope (later milestones)

| Later milestone | Contents |
|---|---|
| Events & shops | Timed shops and secret shops as event encounters, Chaos Mode (timed free class-swapping mid-fight) |
| Content packs | Packaging, sharing and selling ruleset bundles; form editors for classes and items |
| Programmability | New action behaviors beyond the built-in effect types; streamer triggers that play sounds or run scripts; Stream Deck buttons. All call the existing command API |
| Companion web page | Play via QR code or link outside Twitch |
| Rhythm mode | Beat/BPM detection on the streamer's machine, sending beat events to the server |
| Monetization | Paid content, Bits, seasons, support pass |
| Chat | Optional quiet chat bot via one shared bot account |
| Extras | Global player profiles, moderator roles, seasons/resets |

## 3. Architecture

```
 Viewers (extension, desktop + mobile)              Streamer
        │ HTTPS actions (Twitch extension JWT)       │ commands
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
- Server: Fastify for HTTP, the `ws` library for WebSockets, Drizzle ORM with PostgreSQL. Ruleset validation with a schema library (Zod).
- Frontends (`apps/web`, `apps/extension`): React + Vite. The extension builds to a static zip, as Twitch requires.
- Tests: Vitest.
- Hosting: one always-on server process (Fly.io or Railway) and managed Postgres. Monster images go to S3-compatible object storage; local development stores them on disk.

### 3.2 Components

**`packages/engine`** — pure game logic. No I/O, no clock, no `Math.random`.

- `applyAction(state, ruleset, action, now, rng) → { state, events }` (viewer actions)
- `applyGameCommand(state, ruleset, command, now, rng) → { state, events }` (streamer game commands, §5.1)
- `tick(state, ruleset, now, rng) → { state, events }` (advances timers: monster attacks, effect expiry)
- `nextWakeTime(state, ruleset) → time | null`
- `validateRuleset(ruleset) → ok | errors`
- Events are a typed union, e.g. `PlayerAttacked`, `MonsterStruck`, `PlayerKnockedOut`, `EncounterWon`, `PlayerRemoved`. They drive the overlay feed and animations, and tell the server which player rows changed (§6.2).
- All randomness comes from an injected seeded RNG so tests are deterministic.

**`Room`** (in `apps/server`) — one live game per channel.

- Holds the channel's live state, its ruleset, and one timer for `nextWakeTime`.
- Processes all inputs (actions, game commands, ticks, ruleset changes) one at a time through a queue.
- After each input: saves (§6.2), then hands events and state to the Broadcaster.

**`RoomManager`** — creates Rooms on demand, loads them from Postgres, and unloads a Room after 30 minutes with no adventure running.

**`Broadcaster`** — fans out to three audiences (§7).

**Command API** — one endpoint receives every streamer command (§5) by name with arguments. Game commands go to the Room; admin commands are handled by the server (and forwarded to the Room when they change its ruleset).

## 4. Game rules and the Ruleset

### 4.1 The Ruleset

Each channel has one Ruleset: a single JSON object, validated on every change. Every number, stat, class, action, item, monster and switch in §4 is defined in it; those values as written in this section are the **default ruleset**. Behavior described in prose and not listed in §4.9 is fixed. Sections:

- **rules**: all numeric and on/off rules (listed in §4.9).
- **baseStats**: stats every player has before class and gear: max HP, damage, heal power, crit chance, crit multiplier, damage reduction %.
- **levelGrowth**: stat gains per level, and the XP curve.
- **classes**: each class has an ID, name, icon, stat modifiers (added to base stats) and a list of actions.
- **items**: each item has an ID, name, slot (weapon or armor), class ID (weapons only; equipping it sets that class), and stat bonuses.
- **starterItems**: item IDs every player owns automatically for as long as the item is listed here. An item listed in `starterItems` can't be deleted from `items`; it must first be removed from `starterItems`.
- **monsters**: monster templates (§4.6).

**Actions** are built from a fixed set of effect types, so a class can combine them freely:

| Effect type | Parameters |
|---|---|
| `damage` | multiplier of the player's damage |
| `heal` | amount as a multiple of the player's heal power |
| `revive` | HP restored, % of the target's max HP |
| `cure` | which status to remove (`drowsy`) |
| `guard` | duration, damage reduction %; makes the user a priority monster target when `rules.guardTakesPriority` is on |

Each action has: ID, name, cooldown, target type (`monster`, `self`, `ally`, `knockedOutAlly`), and one or more effects.

**Game vocabulary** — fixed in code in this milestone; adding to it belongs to the Programmability milestone:

- effect types: `damage`, `heal`, `revive`, `cure`, `guard`
- target types: `monster`, `self`, `ally`, `knockedOutAlly`
- statuses: `drowsy`, `knockedOut`, `guarding`
- item slots: `weapon`, `armor`

Everything built from the vocabulary (classes, actions, items, numbers) is ruleset data.

**Changing the ruleset:**

- `rules`, `baseStats`, `levelGrowth` and `monsters` can change at any time. Changes apply to the next calculation that uses them; cooldowns already running and a monster already spawned keep their values.
- `classes`, `items` and `starterItems` can change only when no adventure is running. `replaceRuleset` and `resetRuleset` change these sections too, so they are also rejected while an adventure is running.
- If a player's equipped weapon no longer exists, they are re-equipped with the first starter weapon. If their equipped armor no longer exists, the armor slot becomes empty. Inventory entries for items that no longer exist are kept but hidden and unusable (they reappear if the item is restored).
- A ruleset must contain at least one class and at least one starter weapon; otherwise it is rejected.

### 4.2 Lifecycle

- **Adventure**: the streamer starts one; the party is open to join. Ending it disbands the party (all members leave). Player progress persists across adventures.
- **Encounter** (a "round"): one unit within an adventure. In this milestone the only encounter type is **combat**: it runs from `spawnMonster` until the monster is defeated, the party flees, or the streamer ends it. Later milestones add **event** encounters (shops), which never cause removal.
- Only one encounter runs at a time. Between encounters the party is **resting**.
- A combat encounter is in one of two sub-states:
  - **fighting**: at least one party member is active.
  - **waiting**: no party member is active (the party is empty, or every member is knocked out — a **wipe**). The monster has no one to attack.
  - It moves from waiting to fighting the moment any member becomes active (a knockout ends, the streamer revives someone, or a player who isn't knocked out joins). If the monster isn't held: with `rules.fullIntervalAfterWaiting` on (default), the monster's next attack is scheduled a full interval later; otherwise the original schedule continues. If the monster is held, nothing is scheduled; the release rule below decides.
- Separately, the streamer can **hold** the monster (`holdMonster`, §5.1). While held, the monster's attack timer doesn't run, in either sub-state, until `releaseMonster`; the only attack possible is a streamer's `monsterStrikeNow`, which strikes once without releasing the hold or changing the timer. On release, if the encounter is fighting: with `rules.fullIntervalAfterRelease` on (default), the next attack is scheduled a full interval later; with it off, the remaining time from when it was held continues if an attack timer was running at that moment, and otherwise the next attack is a full interval later. If the encounter is waiting at release, nothing is scheduled until it becomes fighting (then the waiting rule above applies).
- **The monster attacks on its timer only while the encounter is fighting and the monster is not held.**
- Everything that applies "during combat" applies in both sub-states and while held.

### 4.3 Players

- A player record is per (channel, Twitch user). A viewer has an independent character in every channel.
- Joining requires the viewer to share their Twitch identity with the extension (once).
- Who can join when:

| Situation | While resting | During combat |
|---|---|---|
| New player, or removed for being idle | yes | yes, if `rules.allowJoinMidFight` (default on) |
| Removed by the streamer (`removePlayer`) | yes | only if `rules.allowJoinMidFight` is on **and** `rules.streamerRemovalWaitsForRest` is off (default: must wait until no combat encounter is running) |
| Banned (`banPlayer`) | no | no |

- **Weapon on joining**: a player who has never equipped a weapon picks one when they join, at any time. A player who already has an equipped weapon joins with it; they can change it only when gear changes are allowed (§4.4).

- Party size cap: `rules.partyCap`, default none (unlimited), so the whole audience can play. A streamer can set a cap; when the party is full, further joins are rejected with "The party is full".
- **Active** = in the party and not knocked out.

**Default stats:**

| | Max HP | Damage | Heal power | Crit chance | Crit multiplier | Damage reduction |
|---|---|---|---|---|---|---|
| baseStats | 100 | 5 | 10 | 5% | 2× | 0% |
| Fighter modifier | +0 | +5 | +0 | +0 | +0 | +0% |
| Tank modifier | +60 | +0 | +0 | +0 | +0 | +10% |
| Healer modifier | −10 | −1 | +20 | +0 | +0 | +0% |

(So Fighter 100 HP / 10 dmg, Tank 160 / 5, Healer 90 / 4 with heal power 30.)

- levelGrowth: +5 max HP and +1 damage per level.
- Each player hit deals `damage × random(rules.damageVarianceMin, rules.damageVarianceMax)` (default 1.0–1.2), rounded; on a crit, also × crit multiplier.

### 4.4 Gear

- Two slots: **weapon** (sets class) and **armor**.
- Default starter items: Sword (Fighter), Shield (Tank), Staff (Healer). Other items come from monster drops or streamer gifts.
- Gear can be changed while resting or when no adventure is running. During combat it is locked if `rules.gearLockDuringCombat` is on (default). Banned players can't change gear.
- If a gear change lowers max HP, current HP is capped at the new max. Raising max HP doesn't raise current HP.

### 4.5 Actions and cooldowns

**Default classes' actions:**

| Class | Action | Target | Effects | Cooldown |
|---|---|---|---|---|
| All | Attack | monster | damage ×1 | 10 s |
| Fighter | Special Attack | monster | damage ×2.5 | 45 s |
| Tank | Guard | self | guard 8 s, 50% reduction | 30 s |
| Healer | Heal | ally (incl. self) | heal ×1 | 15 s |
| Healer | Revive | knockedOutAlly | revive 30% | 60 s |
| Healer | Cure | ally (incl. self) | cure drowsy | 20 s |

- Each action has its own cooldown. Actions are accepted only during combat, only from active party members.
- **Drowsy**: any cooldown started while drowsy is multiplied by `rules.drowsyMultiplier` (default 1.5). Drowsiness lasts `rules.drowsyDuration` (default 30 s). It doesn't change cooldowns already running.

### 4.6 Monsters

A monster template has: name, optional image, max HP, damage per hit, attack interval (default 20 s), targets per attack (blank = automatic), drowsy chance, knockout chance, XP reward, gold reward, drop table (`item`, `chance`).

**Monster attack** (every attack interval while fighting):

1. Number of targets: the template's value, or automatic = `ceil(activeMembers / rules.membersPerTarget)` (default 5), minimum 1.
2. Choose targets: if `rules.guardTakesPriority` is on (default), guarding members first (random order among them); then random other active members, until the count is reached or no one is left.
3. Each target takes the monster's damage (flat: no variance or crits), reduced by their damage reduction and any guard. Then, independently: roll drowsy chance → drowsy; roll knockout chance → knocked out.
4. A player whose HP reaches 0 is knocked out.
5. The overlay and extension show a countdown to the next attack.

**Knocked out**: lasts `rules.knockoutDuration` (default 60 s) or until revived. When it ends without a revive, the player returns with `rules.knockoutReturnHpPercent` (default 25%) of max HP. A knocked-out player is still in the party. A knockout lasts until its stored end time (`knockout-until`) whatever the player is doing — in or out of the party, with or without an adventure. For players in a loaded Room, the Room's timer ends it, writes the return HP and announces it (§7.2). For anyone else, an expired knockout is applied (return HP written) the next time the player is loaded or their state is fetched.

### 4.7 Encounter end and removal

When a combat encounter ends:

- **Won** (monster HP reaches 0, or streamer `endEncounter(withRewards: true)`): rewards go to eligible members.
- **Fled / ended without rewards**: no rewards.

Rewards are decided and paid **before** idle removal runs.

**Eligible** = in the party when the encounter ended and, if `rules.rewardsRequireAction` is on (default), performed at least one action during it.

**Idle removal** (`rules.autoRemoveIdle`, default on): at the end of every combat encounter, members who performed no action during it are removed from the party. Exemption (if `rules.knockedOutExemptFromIdle` is on, default): a member who was knocked out for the whole time they were in the encounter stays in the party (but isn't eligible when `rewardsRequireAction` is on). A member who joined mid-fight is judged from when they joined. Removed players keep all progress.

### 4.8 Rewards and progression

- Each eligible member receives the monster's full XP and gold, multiplied by `rules.xpMultiplier` and `rules.goldMultiplier` (default 1.0).
- Each eligible member rolls each drop-table entry independently. Duplicate items stack.
- **Levels**: per levelGrowth's XP curve. Default: level 2 needs 80 XP; each later level needs 50 XP more than the previous step (80, 130, 180, …).
- **HP carries over** between encounters (`rules.healBetweenFights`, default off).

### 4.9 Default `rules` values

| Key | Default |
|---|---|
| `partyCap` | none (unlimited) |
| `allowJoinMidFight` | on |
| `autoRemoveIdle` | on |
| `healBetweenFights` | off |
| `membersPerTarget` | 5 |
| `drowsyMultiplier` / `drowsyDuration` | 1.5 / 30 s |
| `knockoutDuration` / `knockoutReturnHpPercent` | 60 s / 25% |
| `damageVarianceMin` / `damageVarianceMax` | 1.0 / 1.2 |
| `xpMultiplier` / `goldMultiplier` | 1.0 / 1.0 |
| `gearLockDuringCombat` | on |
| `streamerRemovalWaitsForRest` | on |
| `guardTakesPriority` | on |
| `fullIntervalAfterWaiting` | on |
| `fullIntervalAfterRelease` | on |
| `fullIntervalAfterRestart` | on |
| `rewardsRequireAction` | on |
| `knockedOutExemptFromIdle` | on |

## 5. Streamer commands

Every action taken while running or configuring the game is a named command sent to the command API (exceptions: signing up and connecting chat bans, §1.2). The dock and sign-up page use it now; Stream Deck and scripts use the same API later.

### 5.1 Game commands (game-state changes handled by the engine)

| Area | Commands |
|---|---|
| Adventure | `startAdventure`, `endAdventure`, `removePlayer(player)`, `banPlayer(player, alsoBanFromChat: bool)`, `unbanPlayer(player)` |
| Encounter | `spawnMonster(monsterId)`, `endEncounter(withRewards: bool)`, `flee` |
| Healing | `healPlayer(player, amount \| full)`, `healParty`, `revivePlayer(player)`, `reviveAll` |
| Effects | `applyDrowsy(player)`, `knockOut(player)`, `cure(player)` |
| Monster | `monsterStrikeNow`, `holdMonster`, `releaseMonster`, `setMonsterHp(value)` |
| Rewards | `giveXp(target, amount)`, `giveGold(target, amount)`, `giveItem(target, itemId)` (target = player or party) |
| Feed | `postMessage(text)` |

- Each emits an event shown on the overlay feed.
- `monsterStrikeNow` works while fighting, including while held (§4.2). While waiting (no member active) it is rejected with "No one to strike" and emits no event.
- `spawnMonster` works only while resting during an adventure. `flee` and `endEncounter` end the current combat encounter and apply §4.7.
- `holdMonster` / `releaseMonster`: see §4.2.
- `banPlayer` removes the player from the party and blocks them from joining this channel's game; the engine applies this, and it is saved and shown on the feed like any command. With `alsoBanFromChat`, the server then calls the Twitch Ban User API with the streamer's token. The command always succeeds once the game ban is applied; if the chat ban couldn't be done (not connected, or the Twitch call failed), the response includes a warning saying so.

### 5.2 Admin commands (handled by the server)

| Area | Commands |
|---|---|
| Ruleset | `updateRules(patch)`, `updateBaseStats(patch)`, `updateLevelGrowth(patch)`, `resetRules`, `resetBaseStats`, `resetLevelGrowth`, `replaceRuleset(ruleset)` (JSON import), `resetRuleset` (whole ruleset back to default), `exportRuleset` (returns the ruleset JSON) |
| Monsters | `createMonster(template)`, `updateMonster(id, patch)`, `deleteMonster(id)`, `uploadMonsterImage(id, file)` (PNG, GIF or WebP, ≤ 2 MB), `removeMonsterImage(id)` |
| Access | `regenerateDockUrl`, `regenerateOverlayUrl`, `disconnectChatBans` |

Signing up and connecting chat bans are not commands: both need the streamer to log in to Twitch in a browser (§8).

- Every ruleset change is validated (§4.1). Invalid changes are rejected with the list of errors.
- `uploadMonsterImage` is sent to the command API as a multipart request; every other command is JSON.
- Stored image files are immutable: every upload gets a new URL, and a replaced, removed or deleted image's file is kept while any saved snapshot's spawned copy still references it, then cleaned up.

### 5.3 Control dock

A web page added as an OBS custom browser dock. Tabs:

- **Live**: adventure state, current monster (HP, next-attack countdown, fighting/waiting, held), party list (HP, status, class) with per-player command buttons, and buttons for every game command.
- **Monsters**: form editor for monster templates and images. New channels start with the default ruleset's 3 starter monsters (no images).
- **Rules**: form editors for `rules`, `baseStats` and `levelGrowth`, each with its own reset (`resetRules`, `resetBaseStats`, `resetLevelGrowth`).
- **Ruleset JSON**: view, edit, import and export the whole ruleset, including classes and items.
- **Setup**: overlay URL and dock URL (each with regenerate), chat-ban connection (connect/disconnect), and a link to install the extension.

## 6. Data

### 6.1 Persistent tables (Postgres)

- **channels**: Twitch broadcaster ID, display name, ruleset (JSON), dock token and overlay token (each stored encrypted, plus a hash for lookup), streamer's Twitch refresh token for chat bans (encrypted; present only while chat bans are connected), created/updated times.
- **players**: channel ID, Twitch user ID, display name, level, XP, gold, current HP, equipped weapon ID, equipped armor ID, knockout-until time, banned flag, removed-by-streamer-until-resting flag. Unique on (channel, Twitch user).
- **inventory**: player ID, item ID, quantity.
- **room_snapshots**: channel ID, serialized live state (JSON), saved time, engine state version.
- **encounter_log**: channel ID, monster ID, start/end, outcome, participants. For history; not read by the game.

### 6.2 What is saved when

**Player rows are the source of truth for player progress.** Every change to any field in `players` or `inventory` (XP, gold, level, HP, gear, inventory, knockout-until, flags) is written in the same Room input that caused it, before events are broadcast. This includes streamer commands such as `giveGold` and `healParty`.

**The room snapshot holds only live, non-progress state**: adventure and encounter state, held flag (and remaining time when held), party membership and join times, a copy of the spawned monster's template, including name and image (so later edits or deletion of the template don't affect the fight or its display), monster HP and next attack time, cooldowns, drowsy and guard effects, who has acted this encounter, and for each member whether they have been active at any point since joining the encounter (for the §4.7 exemption). It is written:

- immediately after adventure start/end, encounter start/end, join/leave, any streamer command, a member's first action in an encounter, and a member's first moment of being active in an encounter (so the records used at encounter end are never lost);
- otherwise at most every 10 s while something changed.

**Restart**: on load, the Room reads its snapshot and the player rows. Timestamps are absolute, so effects, knockouts and cooldowns that expired during the downtime are treated as expired. Expired knockouts are applied first, which may turn a waiting encounter into fighting. Then, if the encounter is fighting and the monster isn't held, `rules.fullIntervalAfterRestart` alone decides the next attack (the waiting rule in §4.2 doesn't apply at load): on (default), a full interval from the moment of load; off, the saved next attack time if there is one (an attack due during the downtime happens at load), otherwise a full interval from load. Up to ~10 s of snapshot-only state (monster HP, cooldowns, drowsy/guard) can be lost; player progress and the encounter-end records are never lost.

## 7. Real-time updates

### 7.1 Overlay and dock (WebSocket)

- On connect: full state.
- Then: every engine event immediately, plus a full state after each input.
- Clients reconnect automatically with backoff and receive full state again.

### 7.2 Shared snapshot to all viewers (Twitch Extension PubSub)

- Twitch limits: 5 KB per message; about 1 message per second per channel.
- The server sends a compact snapshot to the channel's broadcast topic at most once per second, only when state changed.
- Contents: adventure/encounter state (incl. fighting/waiting and held), monster (name, image URL and stats from the spawned copy, HP, max HP, next attack time, last strike time), party entries as `[playerKey, classId, hpPercent, statusFlags]`, a `rosterVersion` number, and a **changed list**: the keys of every player (in the party or not) whose own state (§7.3) changed since the previous snapshot, for any reason — their actions, allies' actions, monster attacks, streamer commands, or timers expiring. If the changed list doesn't fit in the size limit, it is replaced by a `refreshAll` flag.
- A change to any player's own state counts as a state change, so it always produces a snapshot (within the 1-per-second limit).
- Names and gear are not in the snapshot. When `rosterVersion` changes, the extension fetches the roster (player keys → names, classes, levels) over HTTP.
- **Trimming**: if a snapshot would exceed 5 KB (only with a very large party), the changed list is kept (or replaced by `refreshAll`) and party entries are trimmed to the first members by join order plus a `partyTotal` count. Party entries are used only for showing the party; no viewer relies on them for their own state (§7.3) or for choosing ally targets (§9).

### 7.3 A viewer's own state

Every viewer who has shared identity fetches their own state (HP, status, cooldown end times, gear, inventory) over HTTP:

- on load, after joining, and after each gear change (party members and non-members alike);
- in the response to each of their own actions.

- when their key is in a snapshot's changed list, or the snapshot has `refreshAll` (with a random 0–1 s delay to spread requests, longer for `refreshAll`).

There is no timed polling. Cooldown countdowns are computed in the browser from end times sent by the server.

## 8. Auth and identity

- **Viewers**: the extension sends Twitch's extension JWT with each request. The server verifies it with the extension secret and reads `channel_id` and `user_id`. Joining requires `user_id` (identity shared). Viewers who haven't shared identity, and logged-out viewers, can watch but can't join.
- **Streamer sign-up**: a web page with Twitch login (OAuth, no extra scopes). Signing in creates the channel; this page and the dock's Setup tab show the dock and overlay URLs at any time. Admin commands can be sent from this page (logged-in session) or the dock.
- **Chat bans** are opt-in: the first time the streamer connects them (Setup tab), a second Twitch login asks for the `moderator:manage:banned_users` scope and the refresh token is stored. `disconnectChatBans` deletes the stored token.
- **Dock URL** carries the dock token: can send every game and admin command. **Overlay URL** carries the overlay token: read-only.
- Tokens are random 32-byte values, stored encrypted (so URLs can be shown again) with a hash used for lookup. Regenerating a URL invalidates the old one.
- If a viewer opens the extension on a channel that hasn't signed up, it shows "This streamer hasn't set up the game yet."
- Display names come from Twitch's Get Users API (app access token) and are refreshed on join.

## 9. Viewer extension

- Type: video overlay, with a collapsible side panel. On mobile, the same panel fills the chat-area view.
- **Not joined**: "Join the party" → identity share (first time) → weapon pick, only for a player with no equipped weapon (from the player's weapons; class names and icons come from the ruleset). Players who already have a weapon join with it.
- **In party, during combat**: own HP bar, status icons, level, gold; action buttons for the current class with countdowns (greyed out on cooldown or while knocked out); party list (from the snapshot); **target picker** for ally actions: when opened, the extension fetches the full party's HP and status over HTTP, listing knocked-out and most-hurt members first, so every member can be targeted even when the snapshot is trimmed; monster name, HP, next-attack countdown, and "waiting" / "held" states.
- **In party, resting**: gear and inventory.
- **Removed, banned, or no adventure**: a short message, and a Rejoin button when §4.3 allows it.
- **Gear screen**: change weapon (class) or armor. Available in every state where §4.4 allows a gear change for this player, including no adventure, removed, and combat with `gearLockDuringCombat` off. Not shown to banned players.
- Failed actions show a short message: "On cooldown (4s)", "You're knocked out", "Not in the party".
- Monster images load from the server's image host, which is added to the extension's allowed domains.

## 10. Stream overlay

- One OBS browser source, transparent, 1920×1080, read-only.
- Shows: monster card (image if uploaded, otherwise a styled name card), HP bar, next-attack countdown, hit and crit flashes; party strip (name, class icon, HP, status); event feed; big callouts for encounter start, win, wipe and monster strikes.

## 11. Art policy

- No AI-generated art ships in the product. Final art comes from a hired illustrator.
- Milestone 1 visuals are built from type, shape, color and motion and must look finished without illustrations.
- Allowed now: simple vector class icons (sword, shield, staff) for the default ruleset.
- Monster images are optional uploads by the streamer.
- Inspiration sketches, if ever made, live outside the app's source tree and are never shipped.

## 12. Reliability and errors

- The server is authoritative: cooldowns, damage and eligibility are always computed server-side.
- Per-player rate limit (server protection, not a game rule): 5 action requests per second; extra requests are rejected. A repeated request ID is ignored (idempotency key).
- All inputs to a Room are processed one at a time (§3.2).
- Errors return a stable error code and a human-readable message. Server errors are logged with channel and player IDs.

## 13. Testing

- **Engine** (test-first, seeded RNG): every effect type; damage and crits; cooldowns and drowsy; targeting with and without guard; knockout from HP and from chance; knockout expiry and revive; fighting/waiting transitions (wipe, empty party, join while waiting); hold and release in both sub-states; strike-now while held; every on/off rule in both positions; weapon on joining; eligibility and idle removal (incl. the knocked-out exemption and mid-fight joins); the join table in §4.3; rewards and drops; levels; every game command; ruleset validation; ruleset changes (allowed timing, missing equipped items, hidden inventory); a custom ruleset with non-default classes.
- **Room** (fake clock): timer scheduling, full fight start to finish, input ordering, player-row writes on every progress change, snapshot save triggers, restart and resume.
- **Server**: JWT verification, dock/overlay token checks and encrypted storage, every admin command, chat-ban connect/disconnect, action endpoints, chat-ban call, PubSub snapshot size, trimming and the changed list / `refreshAll` fallback, own-state endpoint, full-party endpoint for the target picker.
- **Simulator** (dev only, in `apps/web`): spawns fake viewers who join and act at random, to test large parties locally.
- **Manual**: Twitch local test mode for the real extension on desktop and mobile.
