# twitch-dndm — Project 1: Engine and Packs

**Date:** 2026-10-11
**Status:** Draft for owner review (revision 1)
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
4. **Plugins never edit game state directly.** They call engine operations (§5.2), so every change passes through modifiers and produces an event.
5. **Determinism.** The engine and all pack code use only the engine's seeded RNG and the `now` passed in. The same packs, channel config, seed and command list always produce the same events.
6. **Only official packs contain code.** Content made by a streamer (the channel pack, §7.2) is data only.

### 1.2 Success criteria

1. With the starter pack, `dndm play` can run a whole session: open it, have players of all three classes join, play the sample adventure to its end (a story beat, a vote that picks a branch, a fight that's won, a shop purchase, a trap and a treasure), then close it.
2. A test pack that defines its own stats and classes runs fights correctly with the starter pack **not loaded**.
3. A second test pack adds a new stat, status, effect, passive and class alongside the starter pack, with no engine change.
4. The same seed and script produce identical event output on every run.
5. Turning a pack off and on again restores every character's items and equipment exactly (§7.4).
6. The engine package contains no starter-pack IDs (enforced test, §11).

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
- Inside a pack's own files, an unprefixed ID means that pack's own item of that type; if the pack has none, it means the core's (`fight` → `core:fight`). Anything from another pack must be prefixed. An unresolved reference is a validation error.
- In the channel pack (§7.2), unprefixed IDs mean the channel's own content; everything else is prefixed.
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

### 5.2 Registering plugins

`register(api)` may call:

| Call | Registers |
|---|---|
| `api.stat(id, def)` | A stat: `name`, `icon`, `default`, `per-level` |
| `api.slot(id, def)` | An equipment slot: `name` |
| `api.effect(id, def)` | An effect: `params` schema, `apply(ctx, { source, target, params })` |
| `api.status(id, def)` | A status: `name`, `icon`, `params`, `stacking`, `modify`, `react`, optional `tick` |
| `api.passive(id, def)` | A passive: `name`, `params`, `modify`, `react` |
| `api.targeting(id, def)` | A targeting rule: `params`, `select(ctx, { user, ability, params, chosen, hints })` |
| `api.behavior(id, def)` | A monster behavior: `params`, `act(ctx, { monster, params })` |
| `api.encounterKind(id, def)` | An encounter kind (§6.7) |

Content documents in `content/` are registered automatically by the loader.

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
| `endEncounter(outcome)` | Ends the current encounter (encounter kinds only) |
| `emit(type, data, text)` | Emits a custom event. `type` is pack-prefixed; `text` is a feed line |

**Read-only helpers on `ctx`:** `now`, `random()`, `randomInt(a, b)`, `stat(entity, statId)`, `hp(entity)`, `maxHp(entity)`, `statuses(entity)`, `party()`, `active()` (party members not knocked out), `enemiesOf(entity)`, `alliesOf(entity)`, `byPriority(user, ability, candidates)` (§5.3), `formula(text, { source, target })`, and `store(entity)`, a JSON object private to the calling pack and saved with the entity (for pack resources such as mana).

If plugin code throws, the whole command or time step is discarded (the game state is unchanged), and the result is an error naming the pack and plugin.

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

Damage and healing amounts are rounded to the nearest whole number after all modifiers, minimum 0.

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
- Stat names: a bare name is the source's stat; `target.<stat>` is the target's. Stats from other packs are prefixed (`mage:mana`, `target.mage:mana`).
- `hp`, `hp.max`, `level`, and the same with `target.`.
- Functions: `min`, `max`, `floor`, `ceil`, `round`, `random(a, b)` (a decimal between a and b, from the engine RNG).
- No other names, no assignment, no loops. The engine parses formulas itself and never evaluates code.
- Every formula is parsed when content is validated. Unknown names and syntax errors are validation errors.
- A formula used where there is no source (trap penalties, §9.6) may only use numbers, `target.` names and functions.

## 6. The fixed loop

### 6.1 Sessions

- The streamer **opens** a session (`openSession`) and **closes** it (`closeSession`). The party exists only while a session is open. Closing ends any encounter (as `ended`, §6.5), stops any adventure, and empties the party.
- While a session is open and no encounter is running, the party is **resting**.
- Only one encounter runs at a time. The user's word "round" means one encounter.

### 6.2 Characters

A character is per (channel, viewer) and keeps: name, level, XP, gold, current HP, inventory (full item ID → count), equipped items (slot → full item ID), statuses, cooldowns (ability → end time), knockout end time, banned flag, "removed by streamer" flag, and pack stores (§5.2).

- **Starting items** (`settings.startingItems`) are owned by every character for as long as they are listed. They aren't stored in the inventory.
- **Class:** a character's class is the class granted by the item equipped in the **class slot** (`settings.classSlot`), if any. A character with nothing there has no class: they keep any abilities from gear and consumables. The engine works with zero classes defined.
- **Abilities available** to a character: their class's abilities, then abilities on equipped items, then the use ability of each consumable they own.
- **Stats:** a stat's value is its `default + per-level × (level − 1)`, plus class and equipped-gear bonuses, then the `stat` modifier.
- Whenever a character's max HP drops below their current HP, current HP is lowered to the new max. A rise in max HP (gear, level) doesn't raise current HP.

### 6.3 Joining and leaving

| Situation | Resting or non-fight encounter | During a fight |
|---|---|---|
| New, left, or removed for being idle | yes | yes, if `allowJoinMidFight` |
| Removed by the streamer | yes | only if `allowJoinMidFight` is on **and** `streamerRemovalWaitsForRest` is off |
| Banned | no | no |

- No one can join while no session is open. The party is full when it has `partyCap` members (default: no cap).
- **Class on joining:** a character whose class slot is empty, and who owns at least one item for that slot, must pick one with the join command. One who already has an item there joins with it.
- `leave` removes a character from the party. It counts as "left" in the table.
- "Removed by the streamer" clears when the party is next resting, if `streamerRemovalWaitsForRest` is on.

### 6.4 Gear

- `equip(item)` requires an owned, resolvable item (§7.4) whose slot exists. `unequip(slot)` empties a slot; the class slot can't be emptied, only swapped.
- During a fight, characters in the party can't change gear if `gearLockDuringCombat` is on. Banned characters can't change gear. Characters not in a session can change gear.

### 6.5 Fights (`core:fight`)

Started by `spawnMonster(monsterId)` or as an adventure node. The monster is copied from its content when the fight starts, so later content changes don't affect a running fight.

**Sub-states:**

- **fighting:** at least one party member is active (in the party and not knocked out).
- **waiting:** no member is active (the party is empty, or everyone is knocked out, a **wipe**). The monster has no one to act against.
- It moves to fighting the moment a member becomes active. If the monster isn't held: with `fullIntervalAfterWaiting` on, its next turn is a full interval later; off, the original schedule continues. If held, the release rule decides.
- **Hold:** `holdMonster` stops the monster's turn timer in both sub-states until `releaseMonster`. While held, only `monsterActNow` makes it act, once, without releasing or changing the timer. On release while fighting: with `fullIntervalAfterRelease` on, the next turn is a full interval later; off, the time remaining when it was held continues (or a full interval if no timer was running). On release while waiting, nothing is scheduled until fighting.
- `monsterActNow` while waiting is rejected with "No one to act against".

**Monster turns:** every `interval` (from the monster's content, default `settings.monsterInterval`) while fighting and not held, the monster's behavior plugin runs `act`, which uses one or more of the monster's abilities through `ctx.useAbility`.

**Character turns:** characters use abilities with `use(ability, chosen?)`. Rejected unless the character is in the party and not knocked out, the ability is available to them, it's off cooldown, `canUse` allows it, and the ability's `when` allows it now (§8.2). A consumable's use ability removes one of that item.

**How a fight ends:**

| Outcome | Caused by | Rewards |
|---|---|---|
| `won` | monster HP reaches 0, or `endEncounter(won)` | yes |
| `fled` | `flee` | no |
| `ended` | `endEncounter(ended)` or `closeSession` | no |

When a fight ends, in this order:

1. **Rewards** go to each **eligible** member: in the party when the fight ended and, if `rewardsRequireAction` is on, having used at least one ability during the fight. Each gets the monster's XP and gold (times the multipliers) and rolls each drop independently. Duplicate items stack.
2. **Idle removal** (if `autoRemoveIdle` is on): members who used no ability during the fight are removed. If `knockedOutExemptFromIdle` is on, a member who was knocked out for the whole time they were in the fight stays (but isn't eligible when `rewardsRequireAction` is on). Members who joined mid-fight are judged from when they joined.
3. If `healBetweenFights` is on, every party member is healed to full.

### 6.6 Knockouts (`core:knocked-out`)

- A character or monster at 0 HP is knocked out. Effects can also knock out directly (`ctx.knockOut`).
- A character's knockout lasts `knockoutDuration` or until revived, whether or not they're in a party or a session. When it ends without a revive, they return with `knockoutReturnHp` of max HP.
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
- The streamer can end any encounter with `endEncounter(outcome?)`. The outcome must be one of the kind's outcomes; if none is given, `endEarly` decides.
- Non-fight encounters never remove anyone for being idle and never pay fight rewards. Kinds pay their own rewards through `ctx.giveRewards`.
- Joining during a non-fight encounter is always allowed (subject to the ban and removal rules in §6.3).

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
- `engine.resume(game, now)` is called after loading a saved game. Expired timers are processed first (knockouts before anything else, which may turn waiting into fighting). Then, for a fight that's fighting and not held, `fullIntervalAfterRestart` alone decides the next monster turn: on, a full interval from now; off, the saved time (a turn due during the downtime happens now).

## 7. Channels

### 7.1 Channel config

```yaml
packs: [starter]              # enabled packs, in load order
channel-pack: { ... }         # §7.2
overrides: { ... }            # §7.3
settings: { ... }             # §7.5
```

`createEngine({ packs: bundles, channel })` builds the channel's game: registers each enabled pack (dependencies first), loads the channel pack, applies overrides, then validates everything (§10). Any error stops it with the full list.

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
- An override for content that doesn't resolve (its pack is off) is kept and ignored.

### 7.4 Dormant content

Content is **dormant** when it can't be resolved: its pack is off, or it was deleted from the channel pack.

- Saved state is never rewritten because of dormancy. Characters keep dormant items in their inventory and in their equipped slots.
- Dormant inventory items are shown as unavailable and can't be used, equipped or given.
- A dormant equipped item counts as empty. If it was in the class slot, the character's effective class item is the first resolvable starting item for that slot, if any.
- Statuses and cooldowns that refer to dormant content are ignored while dormant.
- When the content resolves again, everything returns as it was. The one exception: if max HP was lower while dormant, the HP lost to that cap stays lost (§6.2).
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
| `classSlot` | none (the starter channel default sets `starter:weapon`) |
| `startingItems` | none (the starter channel default sets sword, shield, staff) |

(Written in kebab-case in files: `party-cap`, `allow-join-mid-fight`, and so on.)

The CLI's default channel config enables `starter` and sets `classSlot: starter:weapon` and `startingItems: [starter:sword, starter:shield, starter:staff]`. These values live in the starter pack's `default-channel.yaml`, not in the engine.

## 8. Content types

Every content document starts with its type key and ID. The examples use the starter pack.

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
use: drink-potion               # makes it a consumable; one is used up per use
price: 15
```

An item can be gear, a consumable, or both. Validation: an item with `grants-class` must be in the channel's class slot.

### 8.4 Monster

```yaml
monster: goblin-king
name: Goblin King
image: null                     # streamers upload their own art (Project 2)
tags: [goblin]
hp: 400
stats: { attack: 12, defense: 10 }
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
  goblin-fight: { fight: goblin-king, next: { won: treasure, default: rest } }
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

Slots: `weapon` (the default class slot) and `armor`.

### 9.2 Plugins

| Type | ID | Does |
|---|---|---|
| Effect | `damage` | `power` formula; crit roll on the source's crit stats; × (1 − target defense%); `ctx.dealDamage` |
| Effect | `heal` | `amount` formula; `ctx.heal` |
| Effect | `revive` | `hp` as % of the target's max; only on knocked-out targets |
| Effect | `apply-status` | `status`, `duration`, status params |
| Effect | `remove-status` | `status` |
| Effect | `knock-out` | `chance`; knocks out on a successful roll |
| Status | `drowsy` | `cooldown` modifier: × `multiplier` (1.5). Stacking: refresh |
| Status | `guarding` | `damageTaken` × (1 − `reduction`%); `targetPriority` +1. Stacking: refresh |
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
| Guard | `self` | apply `guarding` 8s, reduction 50 | 30s |
| Heal | `ally` | heal `healing` | 15s |
| Revive | `knocked-out-ally` | revive 30% | 60s |
| Cure | `ally` | remove `drowsy` | 20s |
| Drink Potion (`when: anytime`) | `self` | heal 40 | 5s |
| Smelling Salts (`when: anytime`) | `self` | remove `drowsy` | 5s |

### 9.5 Items and monsters

**Items:** Sword, Shield, Staff (weapons, starting items); Leather Armor (armor, defense +5, 40 gold); Health Potion (Drink Potion, 15 gold); Smelling Salts (10 gold).

**Monster abilities:** Club Swing (`random-enemies`, damage `attack`), Yawn (`random-enemies`, apply `drowsy` 30s), Crushing Blow (`random-enemies`, damage `1.5 * attack`, then `knock-out` chance 0.1).

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

- A secret shop shows no overlay scene, and only members who were in the party when it opened can see it or buy.
- Buying costs gold and adds the item to the inventory. Starting items can't be bought.
- The streamer's `endEncounter` on a vote uses the current leader (`endEarly`); on a trap it counts as `disarmed`.

### 9.7 Sample adventure

`the-cave` (§8.6) uses every starter kind and each fight outcome branch, and is the adventure in success criterion 1.

## 10. Validation

Run by `createEngine` and `dndm validate`. Each error names the pack, file, document and field.

- Every pack's manifest is valid, its ID is unique, and its dependencies are present in matching versions with no cycles.
- No two items of the same type share an ID within a pack.
- Every content document matches its type's schema, and every plugin's params match the plugin's `params` schema.
- Every reference resolves: stats, slots, classes, abilities, items, monsters, effects, statuses, passives, targeting rules, behaviors, encounter kinds, encounters, adventure nodes.
- Every formula parses and names only known stats (and follows the no-source rule where it applies).
- Items with `grants-class` are in the class slot. Starting items resolve.
- Every adventure node is reachable from `start`, and every `next` map key other than `default` is an outcome of that node's kind.
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
| Encounters | `spawnMonster(monster)`, `startEncounter(encounter \| inline)`, `endEncounter(outcome?)`, `flee` |
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

Every event has `type`, `at` and `text` (a one-line feed message). Core event types cover: sessions, joins and leaves, removals and bans, encounter start and end (with outcome), fight sub-state changes, hold and release, ability use, damage, healing, knockouts and revives, statuses applied and ended, rewards, level-ups, item purchases, adventure progress (lined up, started, finished, stopped), `core:reaction-limit`, and each streamer command. Packs add their own with `ctx.emit`.

## 12. Art

- No AI-generated art ships. Final art comes from a hired illustrator.
- Allowed now: simple vector sword, shield and staff icons in `packs/starter/art/icons/`.
- Monster images and story media are `null` in the starter pack; streamers supply their own (Project 2). Screens must look finished without them.

## 13. The CLI (`dndm`)

Time in the CLI is **stepped**: it moves only on `wait <duration>` or `next` (jump to `nextWakeTime`).

| Command | Does |
|---|---|
| `dndm validate <pack dirs…> [--channel file]` | Validates packs (and a channel config) and lists every error |
| `dndm play [--packs dirs] [--channel file] [--seed n] [--save file]` | Interactive: type viewer and streamer commands, `wait`, `next`, `state`, `help`; shows events, widgets and scenes as text |
| `dndm run <script.jsonl> [--packs …] [--channel …] [--seed n]` | Runs a script and prints every event |
| `dndm sim --party <classes> --vs <monster> [--runs n] [--seed n]` | Runs many fights with bot players; reports win rate, fight length, knockouts and damage and healing by ability |

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
- **No special treatment:** a test collects every starter-pack ID and fails if any appears as a string literal in `packages/engine/src`.
- **CI:** `dndm validate packs/*` on every change.
