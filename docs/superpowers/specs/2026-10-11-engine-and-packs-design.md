# twitch-dndm — Project 1: Engine and Packs

**Date:** 2026-10-11
**Status:** Draft for owner review (revision 6)
**Roadmap:** `docs/roadmap.md`, Project 1
**Replaces:** the game rules in `2026-10-08-core-game-design.md` (rev 7) §4 and §5.1. The rest of rev 7 is the starting point for Project 2 (server and live play).

## 1. Purpose

twitch-dndm is a co-op Twitch game: the whole audience fights monsters together while the streamer runs the story. This project builds the game itself as a small, moddable engine, with no server and no screens yet.

- **The engine** runs a fixed game loop and knows no classes, monsters, items or statuses beyond the few the loop needs (§4.1).
- **Packs** supply everything else: stats, classes, abilities, items, monsters, statuses, effects, targeting rules, encounter kinds and adventures.
- **The starter pack** (Fighter, Tank, Healer, starter monsters, a shop, four event kinds, a sample adventure) is free, open source and built only through the public pack API, exactly as a paid pack would be.
- **The CLI** (`dndm`) lets a person or an agent validate packs, play in the terminal, run scripts and simulate fights.

The original hand-coded game (`../twitch-emitter`) is a reference for game feel only. No code is copied from it and it is never modified.

### 1.1 Ground rules

1. **The starter pack gets no special treatment.** The engine source never names a starter-pack ID. This is enforced by a test (§14).
2. **The loop is fixed.** Packs add things that happen inside the loop. They can't change what a session, encounter, fight or knockout is.
3. **HP is the only core stat.** Packs register every other stat.
4. **Plugins never edit game state directly.** They call engine operations (§5.2), so every change produces an event and passes through its modifier point if it has one (§5.4). One stated exception: an encounter kind's own state (vote tallies, claims, §6.7), which only that kind reads and writes.
5. **Determinism.** The engine and all pack code use only the engine's seeded RNG and the `now` passed in. The same packs, channel config, seed and command list always produce the same events.
6. **Only official packs contain code**, because there is no sandbox for other people's code yet. Official packs are defined in §5.1: packs made and shipped by this project, which the pack loader accepts code from only in this repository's `packs/`; callers of the engine (tests, and later the server) are trusted. Content made by a streamer (the channel pack, §7.2) is data only.

### 1.2 Success criteria

1. With the starter pack, `dndm play` can run a whole session: open it, have players of all three classes join, play the sample adventure to its end once down each branch of its vote (between them: a story beat, a vote that picks a branch, a fight that's won, a shop purchase, a trap and a treasure), then close it.
2. A test pack that defines its own stats and classes runs fights correctly with the starter pack **not loaded**.
3. A second test pack adds a new stat, status, effect, passive and class alongside the starter pack, with no engine change.
4. The same seed and script produce identical event output on every run.
5. Turning a pack off and on again restores every character's items exactly, and their equipment unless they changed it while the pack was off (§7.4).
6. The engine package contains no starter-pack IDs (enforced test, §14).

## 2. Scope

**In scope:**

- `packages/engine`: the core loop, plugin registries, hooks, content schemas, the formula language, channel layering, validation, save and resume.
- `packages/pack-loader`: reads pack folders from disk (manifest, code entry point, YAML content) into the form the engine takes.
- `packs/starter`: the starter pack.
- `apps/cli`: the `dndm` command.

**Out of scope (later projects, see the roadmap):**

| Later | Contents |
|---|---|
| Project 2 | Server, Rooms, database, real-time updates, Twitch auth, chat bot, media uploads, deciding when a streamer may change packs or content during a session |
| Project 3 | Dock, overlay, extension panel, forms for building content |
| Project 4 | Visual adventure editor |
| Later ideas | Several monsters in one fight, Chaos Mode, rhythm mode, programmable triggers, third-party pack code in a sandbox, paid packs, Bits |

## 3. Layout and technology

```
packages/
  engine/        pure TypeScript: no I/O, no timers, no Math.random, no Date.now
  pack-loader/   Node: reads pack folders and channel files from disk
packs/
  starter/       pack.json, src/index.ts, content/**/*.yaml, art/
apps/
  cli/           dndm
```

- TypeScript, pnpm workspaces, Node.js 24, Vitest, Zod for schemas, the `yaml` package for YAML.
- A lint rule bans `Math.random`, `Date.now` and `new Date()` in `packages/engine` and `packs/*`.

## 4. Core concepts

### 4.1 What the core owns

Everything the fixed loop needs, and nothing else:

- **Sessions, the party, encounters and adventures** (§6).
- **HP**: current HP and max HP for characters and monsters. Max HP for characters is `settings.baseHp + settings.hpPerLevel × (level − 1)` plus class and gear bonuses to `hp`, then the `stat` modifier (§5.4).
- **One status, `core:knocked-out`** (§6.6), because fights depend on it.
- **One encounter kind, `core:fight`** (§6.5).
- **Progression**: XP, gold, levels, item drops, and the inventory.
- **Hooks**: the fixed lists of modifier and reaction points (§5.4).
- **The formula language** (§5.5).
- **The fixed panel widget set and overlay scene shape** (§6.8), which later screens draw.

### 4.2 Identity and naming

- Every pack has an ID (`starter`). Every item of content or plugin has an ID that is unique **within its type** in its pack. (`starter` may have both a stat `attack` and an ability `attack`; fields always say which type they refer to.)
- A full ID is `pack:id`, e.g. `starter:sword`. Core IDs use the pack ID `core`.
- Inside a pack's own files, an unprefixed ID means that pack's own item of that type; if the pack has none, it means the core's (`fight` → `core:fight`). Anything from another pack must be prefixed, and a pack may only refer to packs it lists in `depends`. An unresolved reference is a validation error, except the dormant cases in §7.4.
- The channel pack (§7.2) follows the same rule: an unprefixed ID means the channel's own content, then the core's; anything from another pack is prefixed.
- Data keys are kebab-case everywhere: YAML, JSON, saved state (`grants-class`, `show-for`). This spec writes setting names in camelCase (`partyCap`); in files they are kebab-case (`party-cap`).
- Durations are written as `500ms`, `8s`, `2m` or `1h`. Inside the engine all times are integer milliseconds.

### 4.3 Entities and sides

- **Characters** are viewers' characters. **Monsters** are spawned in fights.
- A fight has two **sides**: the party and the monster side. Targeting rules (§5.3) speak in terms of the user's side ("enemy", "ally"), so the same rule works for a character and for a monster.
- In this project a fight has exactly one monster. The state stores the monster side as a list so a later project can add more without changing saved data.

## 5. The pack API

### 5.1 Shape of a pack

```
packs/starter/
  pack.json          { "id": "starter", "version": "1.0.0", "name": "Starter Pack",
                       "license": "...", "depends": {} }
  src/index.ts       default export: definePack({ register(api) { ... } })
  content/**/*.yaml  content documents (§8); a file may hold several, separated by ---
  art/               icons and images referenced by content
```

- `depends` maps pack IDs to semver ranges, e.g. `{ "starter": "^1.0.0" }`.
- The pack loader reads the folder and hands the engine a **pack bundle**: manifest, `register` function and parsed content documents. The engine never touches the disk.
- A data-only pack has no `src/`.
- **Official packs:** the pack loader is the only way packs come in from outside the code base, and it treats only the folders in this repository's `packs/` as official. Official means made and shipped by this project: `packs/` holds only code reviewed and merged into this repository. Other people's code doesn't go there until there is a sandbox. The loader marks each bundle `official` or not, and `createEngine` refuses a non-official bundle that has a `register` function. Non-official packs may be data-only.
- `createEngine` trusts its caller. Code that calls it directly (the engine's own tests, and later the Project 2 server, which loads packs through the loader) may build official bundles in code; this is how test packs (§14) are made. Signed paid packs come later.

### 5.2 Registering plugins

`register(api)` may call:

| Call | Registers |
|---|---|
| `api.effect(id, def)` | An effect: `params` schema, `apply(ctx, { source, target, params })`. `source` is null when there is none (trap penalties, §9.6) |
| `api.status(id, def)` | A status: `name`, `icon`, `params`, `stacking`, `modify`, `react`, optional `tick` |
| `api.passive(id, def)` | A passive: `name`, `params`, `modify`, `react` |
| `api.targeting(id, def)` | A targeting rule: `params`, `select(ctx, { user, ability, params, chosen, hints })` |
| `api.behavior(id, def)` | A monster behavior: `params`, `act(ctx, { monster, params })` |
| `api.encounterKind(id, def)` | An encounter kind (§6.7) |

Content documents (§8), including stats and slots, are part of the bundle. The loader only reads them from `content/`; `createEngine` registers them, whether the bundle came from the loader or was built in code. Plugin params may have defaults in code, but every number the starter pack uses is written in its content, so overrides (§7.3) reach all of them.

**Operations on `ctx`** (the only way a plugin changes the game):

| Operation | Does |
|---|---|
| `dealDamage(source, target, amount, { tags })` | Runs damage modifiers, lowers HP, knocks out at 0 |
| `heal(source, target, amount)` | Runs healing modifiers, raises HP up to max. Has no effect on a knocked-out target |
| `revive(target, hp)` | Ends a knockout, sets HP |
| `knockOut(target, duration?)` | Knocks out (default `settings.knockoutDuration`) |
| `applyStatus(target, statusId, { duration, params, source })` | Applies a status by its stacking rule |
| `removeStatus(target, statusId)` | Removes a status |
| `useAbility(user, abilityId, { chosen, hints })` | Uses an ability (for behaviors and reactions) |
| `giveRewards(character, { xp, gold, items })` | Pays rewards, applying the XP and gold multipliers |
| `spendGold(character, amount)` | Lowers gold by exactly `amount`; rejects the command ("Not enough gold") if they can't afford it |
| `giveItem(character, item, count?)` | Adds items to the inventory, with no multipliers |
| `endEncounter(outcome)` | Ends the current encounter (encounter kinds only) |
| `emit(type, data, text)` | Emits a custom event. `type` is pack-prefixed; `text` is a feed line |
| `setStore(entity, data)` | Replaces the calling pack's store on an entity (for pack resources such as mana); emits `core:store-changed` |

**Read-only helpers on `ctx`:** `now`, `random()`, `randomInt(a, b)`, `stat(entity, statId)`, `hp(entity)`, `maxHp(entity)`, `statuses(entity)`, `party()`, `active()` (party members not knocked out), `enemiesOf(entity)`, `alliesOf(entity)`, `byPriority(user, ability, candidates)` (§5.3), `formula(text, { source, target })`, and `store(entity)`, which returns the calling pack's store on that entity: a JSON object private to that pack and saved with the entity (empty until `setStore`).

- **Rejections:** plugin code may throw a `Rejection` with a short, viewer-facing message ("You've already claimed this"). The command is rejected with that message and the game state is unchanged.
- **Plugin errors:** any other throw discards the whole command or time step (the game state is unchanged), and the result is an error naming the pack and plugin.

### 5.3 Targeting

- A targeting rule's `select` returns the targets for one use of an ability. `chosen` is the target a viewer picked (when the rule needs one). `hints` carries extra input from a behavior, such as `count`.
- If the rule needs a choice and `chosen` isn't a valid candidate, the use is rejected.
- `ctx.byPriority(user, ability, candidates)` orders candidates by **target priority**, highest first and random within equal priority. Each candidate starts at priority 0 and is adjusted by the `targetPriority` modifier on that candidate. Rules that want "hit the guard first" use it; rules that don't, don't.

### 5.4 Hooks

**Modifiers** change a value as it passes. Each runs on the **holder**: every passive (class, then equipped gear in slot registration order, then monster passives) and every status (in the order applied) on that entity.

| Modifier | Holder | Value |
|---|---|---|
| `damageDealt` | source | damage amount |
| `damageTaken` | target | damage amount |
| `healingGiven` | source | healing amount |
| `healingReceived` | target | healing amount |
| `cooldown` | user | cooldown length in ms, applied when the cooldown starts |
| `targetPriority` | candidate | priority number |
| `stat` | entity | a stat's value. Inside this modifier, `ctx.stat` returns unmodified values |
| `canUse` | user | `true`, or a short reason string that rejects an ability use |
| `rewardsReceived` | character | `{ xp, gold }` paid by `giveRewards`, after the channel multipliers |

Damage and healing amounts are rounded to the nearest whole number after all modifiers, minimum 0.

When an operation has no source, source-side modifiers (`damageDealt`, `healingGiven`) and reactions sent to the source are skipped.

**Reactions** run after something happened. A reaction gets the event and its holder's role in it (`source`, `target` or `present`).

| Reaction | Sent to |
|---|---|
| `abilityUsed` | the user and every target |
| `damaged`, `healed` | the source and the target |
| `knockedOut`, `revived` | the entity, and the source if any |
| `statusApplied`, `statusEnded` | the holder |
| `encounterStarted`, `encounterEnded` | everyone in the party and on the monster side (`present`) |

- Reactions run after the operation that caused them finishes, in a queue. Reactions caused by reactions are one level deeper.
- **Chain limit:** at depth 8, further reactions don't run and a `core:reaction-limit` event is emitted. This stops loops such as two thorns passives hitting each other forever.

### 5.5 Formulas

Numbers in content can be formulas, written as text: `power: 1.5 * attack + 2`.

- Numbers, `+ - * /`, parentheses.
- Stat names may contain hyphens (`crit-chance`). Subtraction needs a space on both sides (`attack - 2`); a hyphen without spaces is part of a name, so `attack-2` is an unknown stat (a validation error).
- Stat names: a bare name is the source's stat; `target.<stat>` is the target's. Stats from other packs are prefixed (`mage:mana`, `target.mage:mana`).
- `hp`, `hp.max`, `level`, and the same with `target.`.
- Functions: `min`, `max`, `floor`, `ceil`, `round`, `random(a, b)` (a decimal between a and b, from the engine RNG).
- No other names, no assignment, no loops. The engine parses formulas itself and never evaluates code.
- Every formula is parsed when content is validated. Syntax errors are validation errors. Stat names in formulas are references: an unknown name is a validation error unless it's a dormant case (§7.4).
- A formula used where there is no source (trap penalties, §9.6) may only use numbers, `target.` names and functions.

## 6. The fixed loop

### 6.1 Sessions

- The streamer **opens** a session (`openSession`) and **closes** it (`closeSession`). The party exists only while a session is open. Closing stops any adventure, ends any encounter with the outcome `ended` (§6.7), and empties the party.
- While a session is open and no encounter is running, the party is **resting**.
- Only one encounter runs at a time. The user's word "round" means one encounter.

### 6.2 Characters

A character is per (channel, viewer) and keeps: name, level, XP, gold, current HP, inventory (full item ID → count), equipped items (slot → full item ID), statuses, cooldowns (ability → end time), remaining uses of consumables in use (§8.3), knockout end time, banned flag, "removed by streamer" flag, and pack stores (§5.2).

- An equipped item is one of the items the character owns: equipping doesn't take it out of the inventory, and replacing it in a slot leaves it in the inventory.
- **Starting items** (`settings.startingItems`) are owned by every character for as long as they are listed. They aren't stored in the inventory.
- **Class:** a character's class is the class granted by their effective item in the **class slot** (`settings.classSlot`): the equipped item, or the fallback in §7.4 if it's dormant. A character with no effective item there has no class: they keep any abilities from gear and consumables. The engine works with zero classes defined.
- **Abilities available** to a character: their class's abilities, then abilities on equipped items, then the use ability of each consumable they own.
- **Stats:** a stat's value is its `default + per-level × (level − 1)`, plus class and equipped-gear bonuses, then the `stat` modifier.
- **HP and max HP:** the HP the game uses is the lower of the saved current HP and max HP. When the character changes their own gear and max HP drops below their current HP, the saved current HP is lowered to the new max (as it is with any dormancy in effect at that moment). A rise in max HP doesn't raise current HP. Dormancy by itself never writes HP (§7.4).

### 6.3 Joining and leaving

| Situation | Resting | During a non-fight encounter | During a fight |
|---|---|---|---|
| New, left, or removed for being idle | yes | yes | yes, if `allowJoinMidFight` |
| Removed by the streamer | yes | only if `streamerRemovalWaitsForRest` is off | only if `allowJoinMidFight` is on **and** `streamerRemovalWaitsForRest` is off |
| Banned | no | no | no |

- No one can join while no session is open. The party is full when it has `partyCap` members (default: no cap).
- **Class on joining:** a character whose **effective** class item (§7.4) is empty, and who owns at least one usable item for that slot, must pick one with the join command. One with an effective class item joins with it. (A character whose stored item is dormant gets the first resolvable starting item as their effective item, so they're asked to pick only when there's no such starting item.)
- `leave` removes a character from the party. It counts as "left" in the table.
- "Removed by the streamer" clears when the party is next resting, if `streamerRemovalWaitsForRest` is on.

### 6.4 Gear

- `equip(item)` requires an owned, resolvable item (§7.4) whose slot exists. `unequip(slot)` empties a slot; the class slot can't be emptied, only swapped.
- During a fight, characters in the party can't change gear if `gearLockDuringCombat` is on. Banned characters can't change gear, at any time. Other characters not in a session can change gear.

### 6.5 Fights (`core:fight`)

Started by `startEncounter` with a fight (an encounter document or inline `fight: <monster>`), by its shorthand `spawnMonster(monsterId)`, or as an adventure node. The monster is copied from its content when the fight starts, so later content changes don't affect a running fight.

**Sub-states:**

- **fighting:** at least one party member is active (in the party and not knocked out).
- **waiting:** no member is active (the party is empty, or everyone is knocked out, a **wipe**). The monster has no one to act against.
- It moves to fighting the moment a member becomes active. If the monster isn't held: with `fullIntervalAfterWaiting` on, its next turn is a full interval later; off, the original schedule continues. If held, the release rule decides.
- **Hold:** `holdMonster` stops the monster's turn timer in both sub-states until `releaseMonster`. While held, only `monsterActNow` makes it act, once, without releasing or changing the timer. On release while fighting: with `fullIntervalAfterRelease` on, the next turn is a full interval later; off, the time remaining when it was held continues (or a full interval if no timer was running). On release while waiting, nothing is scheduled until fighting.
- `monsterActNow` while waiting is rejected with "No one to act against".

**Monster turns:** every `interval` (from the monster's content, default `settings.monsterInterval`) while fighting and not held, the monster's behavior plugin runs `act`, which uses one or more of the monster's abilities through `ctx.useAbility`.

**Character turns:** characters use abilities with `use(ability, chosen?)`. Rejected unless the character is in the party and not knocked out, the ability is available to them, it's off cooldown, `canUse` allows it, and the ability's `when` allows it now (§8.2). A consumable's use ability spends one use of that item (§8.3).

**How a fight ends:**

| Outcome | Caused by | Rewards |
|---|---|---|
| `won` | the monster is knocked out (HP reaches 0, or an effect knocks it out, §6.6), or `endEncounter(won)` | yes |
| `ended` | `endEncounter(ended)` or `closeSession` | no |

When a fight ends, in this order:

1. **Rewards** go to each **eligible** member: in the party when the fight ended and, if `rewardsRequireAction` is on, having used at least one ability during the fight. Each gets the monster's XP and gold (times the multipliers) and rolls each drop independently. Duplicate items stack.
2. **Idle removal** (if `autoRemoveIdle` is on): members who used no ability during the fight are removed. If `knockedOutExemptFromIdle` is on, a member who was knocked out for the whole time they were in the fight stays (but isn't eligible when `rewardsRequireAction` is on). Members who joined mid-fight are judged from when they joined.
3. If `healBetweenFights` is on, every party member who isn't knocked out is healed to full.

### 6.6 Knockouts (`core:knocked-out`)

- A character or monster at 0 HP is knocked out. Effects can also knock out directly (`ctx.knockOut`).
- A character's knockout lasts the duration it was given (`settings.knockoutDuration` unless an effect gave another) or until revived, whether or not they're in a party or a session. When it ends without a revive, they return with `knockoutReturnHp` of max HP.
- A knocked-out character is still in the party, can't use abilities, can't be healed, and can still respond in non-fight encounters.
- A knocked-out monster is defeated: the fight ends `won`.

### 6.7 Encounter kinds

Every encounter other than a fight comes from an encounter-kind plugin:

```ts
api.encounterKind('vote', {
  params,                       // schema for the encounter's content
  input,                        // schema for a viewer's response
  outcomes(params): string[],   // every outcome it can end with (for adventure checks)
  start(ctx, params): State,
  respond(ctx, state, character, input): State,  // or throw a Rejection with a short message
  wakeAt(state): number | null, // when it next needs time to pass
  advance(ctx, state): State,   // called at wakeAt
  endEarly(state): string,      // outcome when the streamer ends it with no outcome given
  panel(state, character): Widget,
  overlay(state): Scene,
})
```

- Viewers send `respond(input)`. Only party members can respond.
- **`ended`** is a core outcome every encounter has, in addition to its kind's outcomes. It's used by `closeSession` and by `endEncounter(ended)`.
- The streamer can end any encounter with `endEncounter(outcome?)`. The outcome must be `ended` or one of the kind's outcomes; if none is given, `endEarly` decides (for a fight, `ended`).
- Non-fight encounters never remove anyone for being idle and never pay fight rewards. Kinds pay their own rewards through `ctx.giveRewards`.
- Joining during a non-fight encounter follows §6.3.

### 6.8 Panel widgets and overlay scenes

Pack code never runs in a viewer's panel or the overlay. Kinds describe what to show using a fixed set:

**Panel widgets:**

| Widget | Fields |
|---|---|
| `story-card` | `title?`, `text` |
| `choices` | `prompt`, `options: [{ key, label }]`, `selected?`, `closes-at?` |
| `shop-list` | `entries: [{ item, price, affordable }]`, `gold`, `closes-at?` |
| `tap-button` | `label`, `tapped`, `closes-at?` |
| `none` | |

The fight panel (abilities, targets, HP) is built into the screens and isn't a widget.

**Overlay scene:** `{ title?, text?, media?: [{ type: image | video, src }], closes-at?, tallies?: [{ label, count }], list?: [string] }`.

The CLI renders both as text. Adding a widget is an engine change plus a screen change.

### 6.9 Adventures

- `startAdventure(id)` during a session lines up the adventure's start node. Only one adventure runs at a time.
- **The streamer always starts the next encounter** with `go`, which starts the lined-up node while resting.
- When an adventure's encounter ends, its node's `next` decides what's lined up: a node ID, or a map from outcome to node ID (with an optional `default`). If there's no `next`, or the outcome has no entry and there's no `default`, the adventure finishes.
- `skipTo(node)` lines up any node. `stopAdventure` stops it.
- The streamer can start any encounter by hand while an adventure runs. A hand-started encounter doesn't change what's lined up.

### 6.10 Time

- `engine.advance(game, now)` processes everything due up to `now` in time order: status expiry and ticks, knockout ends, monster turns, encounter-kind wakes.
- `engine.nextWakeTime(game)` returns the earliest due time, or null.
- `engine.resume(game, now)` is called after loading a saved game. Timers are absolute times and keep running while the game isn't running, but nothing acts during the downtime.
  - Things that end, end: expired knockouts first (which may turn waiting into fighting), then expired statuses and cooldowns.
  - Encounter-kind wakes that fell due run once (a vote whose time ran out closes now).
  - Monster turns and status ticks that fell due are not replayed.
  - Then, for a fight that's fighting and not held, `fullIntervalAfterRestart` alone decides the next monster turn: on, a full interval from now; off, the saved time; if that time passed during the downtime, exactly one monster turn happens now and any other missed turns are skipped.

## 7. Channels

### 7.1 Channel config

```yaml
packs: [starter]              # enabled packs
channel-pack: { ... }         # §7.2
overrides: { ... }            # §7.3
settings: { ... }             # §7.5
```

`createEngine({ packs: bundles, channel })` builds the channel's game: registers each enabled pack (every pack after the packs it depends on; otherwise in list order), loads the channel pack, applies overrides, then validates everything (§10). Any error stops it with the full list; warnings (dormant references, §7.4) don't.

### 7.2 The channel pack

Each channel has one data-only pack with the ID `channel`, holding the streamer's own monsters, abilities, classes, items, encounters and adventures in the same format as any pack. It's stored as JSON (YAML in CLI files).

### 7.3 Overrides

A map from full content ID to a partial document, merged onto that content: objects merge key by key, and lists and plain values are replaced.

```yaml
overrides:
  starter:power-strike: { cooldown: 6s }
  starter:goblin-king:  { hp: 600 }
```

- The merged content is validated like any other.
- An override for dormant content (§7.4) is kept and ignored.

### 7.4 Dormant content

Content is **dormant** when its pack is off, when it was deleted from the channel pack, or when it refers to dormant content (this spreads through every chain of references). The channel pack keeps a list of the IDs deleted from it, so a deletion can be told apart from a typo.

- **Dormant references are warnings, not errors.** These go dormant instead of failing validation:
  - channel-pack content that refers to a pack that isn't enabled, or to channel content that is dormant or on the deleted list (the referring content becomes dormant too);
  - settings that refer to them: a dormant `classSlot` counts as unset, and dormant `startingItems` entries are skipped;
  - overrides for them (§7.3).
- An override for content that doesn't resolve is kept and ignored only in these dormant cases; otherwise it's an error.
- Every other unresolved reference is an error (§10), in any pack, the channel pack, settings or overrides. A typo such as `starter:swrod` while `starter` is enabled fails loudly.

- Saved state is never rewritten because of dormancy. Characters keep dormant items in their inventory and in their equipped slots. A character's own action can still change a slot: equipping, or picking on join (§6.3), replaces the dormant item in that slot, and the dormant item stays in the inventory.
- Dormant inventory items are shown as unavailable and can't be used, equipped or given.
- A dormant equipped item counts as empty. If it was in the class slot, the character's effective class item is the first resolvable starting item for that slot, if any.
- Statuses and cooldowns that refer to dormant content are ignored while dormant.
- When the content resolves again, everything returns as it was, apart from slots the character changed. While max HP is lower because of dormancy, the HP used is capped (§6.2). Dormancy by itself never writes HP, but every HP change does: damage, healing, revives, returning from a knockout and the character's own gear changes all save the resulting (capped) value. So HP is an exception to "everything returns as it was": HP changed while content was dormant stays as it was saved.
- **Changing a running game:** `engine.adopt(game)` re-checks a saved game against the engine's current channel config. It's rejected with `content-in-use` if the running encounter or a lined-up adventure uses content that no longer resolves. When a streamer may change packs or content mid-session is decided in Project 2.

### 7.5 Settings

| Key | Default |
|---|---|
| `partyCap` | none |
| `allowJoinMidFight` | on |
| `autoRemoveIdle` | on |
| `rewardsRequireAction` | on |
| `knockedOutExemptFromIdle` | on |
| `healBetweenFights` | off |
| `gearLockDuringCombat` | on |
| `streamerRemovalWaitsForRest` | on |
| `fullIntervalAfterWaiting` | on |
| `fullIntervalAfterRelease` | on |
| `fullIntervalAfterRestart` | on |
| `knockoutDuration` | 60s |
| `knockoutReturnHp` | 25% |
| `baseHp` / `hpPerLevel` | 100 / 5 |
| `xpCurve` | level 2 at 80 XP, each later step 50 more (80, 130, 180, …) |
| `xpMultiplier` / `goldMultiplier` | 1.0 / 1.0 |
| `monsterInterval` | 20s |
| `classSlot` | none (`channels/default.yaml` sets `starter:weapon`) |
| `startingItems` | none (`channels/default.yaml` sets sword, shield, staff) |

(Written in kebab-case in files: `party-cap`, `allow-join-mid-fight`, and so on.)

The CLI's default channel config is the file `channels/default.yaml` in this repository. It enables `starter` and sets `classSlot: starter:weapon` and `startingItems: [starter:sword, starter:shield, starter:staff]`. The CLI refers to that file path, never to a pack ID.

## 8. Content types

Every content document starts with its type key and ID. The examples use the starter pack.

### 8.0 Stat and slot

```yaml
stat: attack
name: Attack
icon: null
default: 5
per-level: 1
---
slot: weapon
name: Weapon
```

`hp` is the core's stat and can't be defined by a pack.

### 8.1 Class

```yaml
class: fighter
name: Fighter
description: Hits hard, hits twice.
icon: art/icons/sword.svg
tags: []
stats: { attack: +5 }
abilities: [attack, power-strike]
passives: []
```

`stats` may include `hp`. `passives` entries are an ID, or `{ id: { params } }`.

### 8.2 Ability

```yaml
ability: power-strike
name: Power Strike
description: Strike, then strike again harder.
icon: null
cooldown: 45s
when: fight                     # fight (default) or anytime (while in the party)
target: enemy                   # a targeting rule ID, or { rule: { params } }
steps:
  - damage: { power: attack * random(1.0, 1.2) }
  - damage: { power: 1.5 * attack * random(1.0, 1.2) }
```

Every step is an effect ID with its params, run in order against the same targets.

### 8.3 Item

```yaml
item: sword
name: Sword
slot: weapon                    # gear only
grants-class: fighter           # only for items in the class slot
stats: {}
passives: []
abilities: []                   # extra abilities while equipped
price: 0
---
item: health-potion
name: Health Potion
use: drink-potion               # makes it a consumable
uses: 1                         # optional, default 1: uses per item before it is used up
price: 15
```

An item can be gear, a consumable, or both. For an item with more than one use, the character's state tracks the remaining uses of the one in use; when it runs out, one item is removed. An item with `grants-class` grants that class only when it's in the channel's class slot; otherwise `grants-class` is ignored with a warning.

### 8.4 Monster

```yaml
monster: goblin-king
name: Goblin King
image: null                     # streamers upload their own art (Project 2)
tags: [goblin]
hp: 400
stats: { attack: 12, defense: 10, crit-chance: 0 }
abilities: [club-swing, yawn]
passives: []
behavior: { weighted: { abilities: { club-swing: 3, yawn: 1 }, targets-per: 5 } }
interval: 20s
rewards: { xp: 60, gold: 25 }
drops: [{ item: health-potion, chance: 0.2 }]
```

Stats a monster doesn't list use the stat's default. Monsters have no level; `level` in a formula is 1 for a monster.

### 8.5 Encounter

A reusable encounter: an ID plus one encounter-kind key with its params.

```yaml
encounter: wandering-merchant
shop: { stock: [{ item: health-potion, price: 15 }, { item: leather-armor, price: 40 }], time: 2m }
```

### 8.6 Adventure

```yaml
adventure: the-cave
name: The Cave
start: entrance
nodes:
  entrance:
    story: { text: "A cold wind blows from the cave mouth…", show-for: 10s }
    next: fork
  fork:
    vote: { prompt: "Which tunnel?", choices: { left: Left tunnel, right: Right tunnel }, time: 30s }
    next: { left: goblin-fight, right: merchant }
  goblin-fight: { fight: goblin-king, next: { won: trap, default: rest } }
  merchant:     { use: wandering-merchant, next: trap }
  trap:         { trap: { ... }, next: treasure }
  treasure:     { treasure: { gold: 25, heal: 50%, time: 30s } }
  rest:         { story: { text: "You limp back to camp." } }
```

A node is an inline encounter (one kind key) or `use: <encounter ID>`, plus optional `next`.

## 9. The starter pack

All numbers below are the starter pack's content, so a streamer can override any of them.

### 9.1 Stats and slots

| Stat | Default | Per level | Meaning |
|---|---|---|---|
| `attack` | 5 | +1 | Used in damage formulas |
| `defense` | 0 | 0 | % of incoming damage removed by the `damage` effect |
| `healing` | 10 | 0 | Used in heal formulas |
| `crit-chance` | 5 | 0 | % chance the `damage` effect crits |
| `crit-multiplier` | 2 | 0 | Damage multiplier on a crit |

Slots: `weapon` (the class slot in `channels/default.yaml`) and `armor`. Stats and slots are content documents (§8.0).

### 9.2 Plugins

| Type | ID | Does |
|---|---|---|
| Effect | `damage` | `power` formula; crit roll on the source's crit stats (no crit without a source); × (1 − target defense%); `ctx.dealDamage` |
| Effect | `heal` | `amount` formula; `ctx.heal` |
| Effect | `revive` | `hp` as % of the target's max; only on knocked-out targets |
| Effect | `apply-status` | `status`, `duration`, status params |
| Effect | `remove-status` | `status` |
| Effect | `knock-out` | `chance`; knocks out on a successful roll |
| Status | `drowsy` | `cooldown` modifier: × `multiplier` (Yawn passes 1.5). Stacking: refresh |
| Status | `guarding` | `damageTaken` × (1 − `reduction`%); `targetPriority` + `priority` (Guard passes 1; 0 turns guard-first targeting off). Stacking: refresh |
| Targeting | `self`, `enemy`, `ally`, `knocked-out-ally` | `enemy` picks the chosen enemy, or a random one; `ally` includes self |
| Targeting | `random-enemies` | `count` (or `hints.count`) enemies via `ctx.byPriority` |
| Behavior | `weighted` | Picks an ability by weight. Targets per turn = `ceil(active members / targets-per)`, minimum 1, passed as `hints.count` |
| Encounter kinds | `story`, `vote`, `treasure`, `trap`, `shop` | §9.6 |

### 9.3 Classes

| Class | Weapon | Stats | Abilities |
|---|---|---|---|
| Fighter | Sword | attack +5 | Attack, Power Strike |
| Tank | Shield | hp +60, defense +10 | Attack, Guard |
| Healer | Staff | hp −10, attack −1, healing +20 | Attack, Heal, Revive, Cure |

Weapons give no stat bonuses. Icons: simple vector sword, shield and staff (§12).

### 9.4 Abilities

| Ability | Target | Steps | Cooldown |
|---|---|---|---|
| Attack | `enemy` | damage `attack * random(1.0, 1.2)` | 10s |
| Power Strike | `enemy` | damage `attack * random(1.0, 1.2)`, then damage `1.5 * attack * random(1.0, 1.2)` | 45s |
| Guard | `self` | apply `guarding` 8s, reduction 50, priority 1 | 30s |
| Heal | `ally` | heal `healing` | 15s |
| Revive | `knocked-out-ally` | revive 30% | 60s |
| Cure | `ally` | remove `drowsy` | 20s |
| Drink Potion (`when: anytime`) | `self` | heal 40 | 5s |
| Smelling Salts (`when: anytime`) | `self` | remove `drowsy` | 5s |

### 9.5 Items and monsters

**Items:** Sword, Shield, Staff (weapons, starting items); Leather Armor (armor, defense +5, 40 gold); Health Potion (Drink Potion, 15 gold); Smelling Salts (10 gold).

**Monster abilities:** Club Swing (`random-enemies`, damage `attack`), Yawn (`random-enemies`, apply `drowsy` 30s, multiplier 1.5), Crushing Blow (`random-enemies`, damage `1.5 * attack`, then `knock-out` chance 0.1).

| Monster | HP | Attack | Defense | Interval | Abilities (weight) | XP / gold | Drops |
|---|---|---|---|---|---|---|---|
| Slime | 80 | 6 | 0 | 15s | Club Swing (1) | 20 / 5 | Health Potion 10% |
| Goblin King | 400 | 12 | 10 | 20s | Club Swing (3), Yawn (1) | 60 / 25 | Health Potion 20% |
| Dozing Ogre | 600 | 18 | 5 | 25s | Club Swing (2), Yawn (2), Crushing Blow (1) | 120 / 50 | Leather Armor 15% |

All three use `targets-per: 5` and set `crit-chance: 0` (monster hits don't crit).

### 9.6 Encounter kinds

| Kind | Params | Viewers | Ends | Outcomes |
|---|---|---|---|---|
| `story` | `text`, `title?`, `media?`, `show-for?` | `story-card` | after `show-for`, or when the streamer ends it | `done` |
| `vote` | `prompt`, `choices` (key → label), `time`, `tie-break` (`random` or `first`, default `random`) | `choices`; a member can change their vote until it closes | at `time`; the most votes wins, ties by `tie-break`; no votes counts as a tie among all choices | each choice key |
| `treasure` | `gold?`, `xp?`, `items?`, `heal?` (number or % of max HP), `time` | `tap-button` "Claim" | at `time`; each member who claimed gets the rewards (knocked-out members get no heal) | `done` |
| `trap` | `prompt`, `time`, either `taps: N%` or `answer` + `choices`, `penalty: { target: all \| non-responders, steps }` | `tap-button`, or `choices` | at `time`. Disarmed if at least N% of party members tapped, or if the most-voted choice is `answer`. Otherwise the penalty steps run on the chosen targets (no source; §5.5) | `disarmed`, `triggered` |
| `shop` | `stock: [{ item, price }]`, `time?`, `secret?` | `shop-list`; `respond: { buy: item }` | at `time`, or when the streamer ends it | `closed` |

- A secret shop shows no overlay scene, and only members who were in the party when it opened can see it or buy. The streamer's dock sees everything, secret shops included (Project 2a spec §5).
- Buying calls `ctx.spendGold` then `ctx.giveItem`, and emits `starter:purchased`. Starting items can't be bought.
- The streamer's `endEncounter` on a vote uses the current leader (`endEarly`); on a trap it counts as `disarmed`.

### 9.7 Sample adventure

`the-cave` (§8.6) is the adventure in success criterion 1. Its main path is story → vote → (fight or shop) → trap → treasure; the streamer ending the fight without a win goes to `rest`. Between its two vote branches it uses every starter kind.

## 10. Validation

Run by `createEngine` and `dndm validate`. Each error names the pack, file, document and field.

- Every pack's manifest is valid, its ID is unique, and its dependencies are present in matching versions with no cycles.
- No two items of the same type share an ID within a pack.
- Every content document matches its type's schema, and every plugin's params match the plugin's `params` schema.
- Every reference resolves (stats, slots, classes, abilities, items, monsters, effects, statuses, passives, targeting rules, behaviors, encounter kinds, encounters, adventure nodes), in every pack, the channel pack, settings and overrides. The only exceptions are the dormant cases in §7.4, which are warnings.
- A pack refers only to itself, the core, and packs in its `depends`.
- Every formula parses and names only known stats, apart from dormant cases (§7.4), and follows the no-source rule where it applies.
- Every adventure node is reachable from `start`, and every `next` map key other than `default` is `ended` or an outcome of that node's kind.
- Non-official packs have no code (§5.1).
- Settings are in range (durations positive, percentages 0–100%, multipliers ≥ 0).

## 11. Commands, events and the engine API

### 11.1 Engine API

```ts
const engine = createEngine({ packs, channel })        // throws ValidationError with every problem
let game = engine.newGame({ seed })
const r = engine.apply(game, command, now)            // { ok: true, game, events } | { ok: false, error }
const t = engine.advance(game, now)                   // { game, events }
engine.nextWakeTime(game)                             // number | null
engine.resume(game, now)                              // after loading a save (§6.10)
engine.adopt(game)                                    // after the channel config changed (§7.4)
engine.describe()                                     // everything registered, for screens and the CLI
```

- The game state is plain JSON with a `version` number. Saving is storing it; loading is reading it and calling `resume`.
- In this project the game state holds every character the channel has seen. Project 2 may store characters separately.
- Errors have a stable `code` and a short `message` ("On cooldown (4s)", "You're knocked out", "Not in the party").

### 11.2 Commands

**Viewer commands** (carry `character`): `join(name, pick?)`, `leave`, `use(ability, chosen?)`, `equip(item)`, `unequip(slot)`, `respond(input)`.

**Streamer commands:**

| Area | Commands |
|---|---|
| Session | `openSession`, `closeSession`, `removePlayer(character)`, `banPlayer(character)`, `unbanPlayer(character)` |
| Encounters | `spawnMonster(monster)`, `startEncounter(encounter \| inline)`, `endEncounter(outcome?)` |
| Adventures | `startAdventure(adventure)`, `go`, `skipTo(node)`, `stopAdventure` |
| Healing | `healPlayer(character, amount \| full)`, `healParty`, `revivePlayer(character)`, `reviveAll` |
| Statuses | `applyStatus(target, status, duration?, params?)`, `removeStatus(target, status)`, `knockOut(character)` |
| Monster | `monsterActNow`, `holdMonster`, `releaseMonster`, `setMonsterHp(value)` |
| Rewards | `giveXp(target, amount)`, `giveGold(target, amount)`, `giveItem(target, item)` (target = a character or the party) |
| Feed | `postMessage(text)` |

- `spawnMonster`, `startEncounter` and `go` work only while resting in a session.
- `banPlayer` removes the character from the party and blocks joining. (Chat bans are a server feature, Project 2.)
- The engine doesn't check who sent a command. The server (Project 2) and the CLI do.

### 11.3 Events

Every event has `type`, `at` and `text` (a one-line feed message). Core event types cover: sessions, joins and leaves, removals and bans, encounter start and end (with outcome), fight sub-state changes, hold and release, ability use, damage, healing, knockouts and revives, statuses applied and ended, rewards, level-ups, gold spent, items given, pack store changes (`core:store-changed`), adventure progress (lined up, started, finished, stopped), `core:reaction-limit`, and each streamer command. Packs add their own with `ctx.emit`.

## 12. Art

- No AI-generated art ships. Final art comes from a hired illustrator.
- Allowed now: simple vector sword, shield and staff icons in `packs/starter/art/icons/`.
- Monster images and story media are `null` in the starter pack; streamers supply their own (Project 2). Screens must look finished without them.

## 13. The CLI (`dndm`)

Time in the CLI is **stepped**: it moves only on `wait <duration>` or `next` (jump to `nextWakeTime`).

| Command | Does |
|---|---|
| `dndm validate [--packs dirs] [--channel file]` | Validates packs (and a channel config) and lists every error |
| `dndm play [--packs dirs] [--channel file] [--seed n] [--save file]` | Interactive: type viewer and streamer commands, `wait`, `next`, `state`, `help`; shows events, widgets and scenes as text |
| `dndm run <script.jsonl> [--packs dirs] [--channel file] [--seed n]` | Runs a script and prints every event |
| `dndm sim --party <classes> --vs <monster> [--packs dirs] [--channel file] [--runs n] [--seed n]` | Runs many fights with bot players; reports win rate, fight length, knockouts and damage and healing by ability |

- `--packs` takes folders; a folder outside this repository's `packs/` is loaded as non-official (data only). Without `--packs`, every folder in `packs/` is loaded. Without `--channel`, `channels/default.yaml` is used.
- Every command takes `--json`, which prints machine-readable output (one JSON object per line).
- A script line is `{ "wait": "3s" }`, `{ "next": true }`, or `{ "as": "streamer" | "<character>", "command": { … } }`.
- `dndm play --save` writes the game state and a script of everything typed, so any session can be replayed.
- **Bot players** in `sim` use a random available ability that has a valid target as soon as one is ready. For abilities that need a chosen ally, they pick the knocked-out or lowest-HP-% ally first. `--reaction 1s-3s` adds a random delay. The bots read only `engine.describe()` and the game state, so they work with any pack.

## 14. Testing

- **Engine, test-first, seeded RNG, using small test packs written inside the tests** (no starter pack):
  - sessions and joining (every row of §6.3), class on joining, gear rules
  - fights: sub-states, wipe, hold and release in both sub-states, `monsterActNow`, every setting in both positions
  - ending: outcomes, eligibility, idle removal with the knocked-out exemption and mid-fight joins, rewards and drops, levels
  - knockouts, revives, timers out of the party
  - every `ctx` operation, every modifier and reaction, ordering, the chain limit, plugin errors rolling back
  - formulas: parsing, every function, errors
  - encounter kinds through a test kind, adventures (lining up, outcome maps, `default`, skip, stop, hand-started encounters)
  - channel layering, overrides, dormancy and restoring (success criterion 5), `adopt`, `resume`
  - validation: one test per rule in §10
- **Second-pack test** (success criterion 3): a test pack adds `mana` (stat plus `ctx.store`), a `burning` status with `tick`, a `fireball` effect, a `thorns` passive and a Mage class, all alongside the starter pack.
- **Starter pack:** each class, ability, plugin and encounter kind behaves as §9 says. The sample adventure runs to its end on each branch.
- **Golden replays:** recorded `dndm run` scripts with their expected event output. A behavior change shows up as a diff.
- **Determinism:** each golden replay run twice gives identical output.
- **No special treatment:** a test collects every starter-pack ID and fails if any appears as a string literal anywhere in `packages/engine`, tests included. Engine test packs use their own made-up IDs.
- **CI:** `dndm validate --packs packs/*` on every change.
