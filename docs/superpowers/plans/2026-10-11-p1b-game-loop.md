# Project 1, Plan B: Game Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the engine playable: game state, the plugin `ctx`, modifier and reaction hooks, every engine operation, sessions and joining, gear, abilities, fights, knockouts, rewards, time, encounter kinds, adventures, streamer commands, and the `apply` / `advance` / `nextWakeTime` / `resume` / `adopt` / `view` API.

**Architecture:** Every call clones the game state into a `Runtime` (the "draft"), runs on it, and returns the draft. A rejected command or a plugin error returns the caller's state unchanged (they keep their old object). Plugins only touch state through `ctx`, which calls the operations in `ops.ts`; every operation runs its modifier point and queues reactions. `settle()` drains reactions (chain limit 8), ends encounters that should end, and updates the fight's fighting/waiting sub-state. Time is processed as a sorted list of due items (knockout ends, status expiry and ticks, monster turns, encounter-kind wakes).

**Tech Stack:** As Plan A (TypeScript 5.9.3, Vitest 5.0.3, pnpm workspaces).

**Spec:** `docs/superpowers/specs/2026-10-11-engine-and-packs-design.md` (rev 6), mainly §5.2–§5.4, §6, §7.4, §11. Flagged decisions: `docs/superpowers/plans/2026-10-11-project-1-README.md` (items 1–4, 6, 7). This plan adds one more: **a plugin error during a time step** rolls back just that step, emits `core:plugin-error`, and moves that timer on (the monster skips a turn, a tick is skipped, a broken encounter is force-ended) so a live stream never gets stuck on the same failing timer.

**Prerequisite:** Plan A complete (all its tests green).

## Global Constraints

- Everything from Plan A's Global Constraints still holds (no I/O, no `Math.random`/`Date.now`/`new Date()`, no starter-pack IDs anywhere in `packages/engine` including tests, kebab-case data keys, made-up test IDs). Plan C adds a test that fails if any engine string literal equals a starter-pack ID, so never write `'attack'`, `'guard'`, `'heal'`, `'damage'`, `'crit-chance'`, `'self'`, `'enemy'`, `'ally'`, `'weapon'`, `'armor'`, `'drowsy'`, `'story'`, `'vote'`, `'treasure'`, `'trap'`, `'shop'` or similar as literals.
- The engine only changes state through a cloned draft; callers' objects are never mutated.
- Plugins change the game only through `ctx` operations; every operation emits an event.
- Chain limit: reactions deeper than 8 don't run; `core:reaction-limit` is emitted once per command or time step.
- Damage and healing are rounded to whole numbers after all modifiers, minimum 0.
- Error codes are stable strings (listed in Task 3); messages are short and viewer-facing.

## Review Focus

1. **A command sent with an earlier `now` than the game's clock** (a lagging client): a person expects it to run at the game's current time, not to rewind time. Test in Task 3 (`clock never goes backwards`).
2. **A character the engine has never seen used in a viewer or streamer command** (`use` from someone who never joined, `healPlayer('ghost')`): a person expects a clean `unknown-character` or `not-in-party` rejection, not a crash. Test in Task 3.
3. **Two things due at exactly the same time** (a knockout ending on the same millisecond as a monster turn): a person expects the knocked-out player back first, so they can be hit. Test in Task 5.
4. **A pack whose encounter kind throws every time it wakes**: a person expects the stream to go on (the encounter is force-ended with an event), not an engine that throws on every `advance`. Test in Task 5.
5. **Healing or giving a negative amount from the streamer's dock** (`healPlayer(-50)`, `giveGold(-10)`): a person expects a rejection, not a silent HP or gold drop. Test in Task 7.

---

## File map (this plan)

```
packages/engine/src/
  state.ts       GameState, Character, MonsterState, FightState, KindEncounterState, StatusInstance, newGameState, newCharacter
  events.ts      GameEvent
  runtime.ts     Runtime: the draft, clock, RNG, events, reaction queue
  entities.ts    refs, names, owned/effective items, class, abilities, stats, max HP, HP, holders
  hooks.ts       callPlugin, modify, react, drainReactions (chain limit)
  ctx.ts         resolveFor, evalFormula, makeCtx, runtimeNormalizeCtx
  ops.ts         damage, heal, revive, knockouts, statuses, abilities, steps, rewards, gold, items, stores
  fight.ts       fight start, sub-states, monster turns, hold/release/act-now, end of fight
  encounters.ts  start/respond/wake/end of any encounter, adventure progress
  settle.ts      settle(): drain reactions, end encounters, refresh fight
  session.ts     open/close session, join, leave, remove, ban, unban
  gear.ts        equip, unequip, HP capping
  use.ts         a character using an ability (checks, cooldowns, consumables)
  adventure.ts   startAdventure, go, skipTo, stopAdventure
  streamer.ts    heal/revive/status/knockout/monster/reward/message commands
  commands.ts    Command union and runCommand dispatch
  time.ts        due items, advanceTo, nextWakeTime, resumeAt, runGuarded
  view.ts        View type and view()
  engine.ts      (modify) Engine gains newGame/apply/advance/nextWakeTime/resume/adopt/view
  index.ts       (modify) new exports
packages/engine/test/
  helpers/harness.ts
  entities.test.ts, ops.test.ts, session.test.ts, gear.test.ts, fight.test.ts,
  time.test.ts, encounters.test.ts, adventure.test.ts, streamer.test.ts,
  resume-adopt.test.ts, dormant-runtime.test.ts, view.test.ts, determinism.test.ts
```

---

### Task 1: State, events, runtime and entity helpers

**Files:**
- Create: `packages/engine/src/state.ts`, `events.ts`, `runtime.ts`, `entities.ts`
- Create (stubs for now, filled in Task 2): `packages/engine/src/hooks.ts`
- Test: `packages/engine/test/entities.test.ts`

**Interfaces:**
- Consumes: `Registry`, `CORE_HP`, `CORE_FIGHT` (Plan A Task 9); `nextRandom`, `seedState` (A2); `Rejection` (A3); content Defs and `EntityRef`, `Hooks` (A6).
- Produces:
  - `state.ts`:
    ```ts
    interface StatusInstance { status: string; until: number | null; params: unknown; source: EntityRef | null; appliedAt: number; nextTick: number | null; seq: number }
    interface Character { id: string; name: string; level: number; xp: number; gold: number; hp: number; inventory: Record<string, number>; equipped: Record<string, string>; statuses: StatusInstance[]; cooldowns: Record<string, number>; usesLeft: Record<string, number>; knockedOutUntil: number | null; banned: boolean; removedByStreamer: boolean; stores: Record<string, unknown> }
    interface MonsterState { id: string; def: MonsterDef; hp: number; knockedOut: boolean; statuses: StatusInstance[]; stores: Record<string, unknown> }
    interface Origin { adventure: string; node: string }
    interface FightState { kind: 'core:fight'; startedAt: number; origin: Origin | null; monsters: MonsterState[]; sub: 'fighting' | 'waiting'; held: boolean; heldRemaining: number | null; nextTurnAt: number | null; pausedTurnAt: number | null; acted: string[]; wasActive: string[]; joinedAt: Record<string, number> }
    interface KindEncounterState { kind: string; startedAt: number; origin: Origin | null; params: unknown; state: unknown }
    type EncounterState = FightState | KindEncounterState
    interface SessionState { party: string[]; encounter: EncounterState | null; adventure: { id: string; lined: string | null } | null }
    interface GameState { version: 1; clock: number; rng: number; seq: number; session: SessionState | null; characters: Record<string, Character> }
    isFight(e: EncounterState): e is FightState
    newGameState(seed: number): GameState
    newCharacter(id: string, name: string): Character
    ```
  - `events.ts`: `interface GameEvent { type: string; at: number; text: string; data: Record<string, unknown> }`
  - `runtime.ts`: `class Runtime` (fields and methods below)
  - `entities.ts`: `charRef`, `monsterRef`, `sameRef`, `entityExists`, `entityName`, `entityTags`, `statusList`, `liveStatuses`, `storesOf`, `isKnockedOut`, `owns`, `ownedItems`, `effectiveEquipped`, `classOf`, `abilitiesOf`, `statRaw`, `stat`, `maxHp`, `hp`, `level`, `holders`, `partyRefs`, `currentFight`, `enemiesOf`, `alliesOf`, `xpToReach` (signatures in the code below)

- [ ] **Step 1: Write the failing test**

`packages/engine/test/entities.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src';
import {
  abilitiesOf, charRef, classOf, effectiveEquipped, maxHp, stat, xpToReach,
} from '../src/entities';
import { Runtime } from '../src/runtime';
import { newCharacter, newGameState } from '../src/state';
import { tpBundle, tpChannel } from './helpers/tp-pack';

function rtWith(channel = tpChannel(), extra: unknown[] = []) {
  const engine = createEngine({ packs: [tpBundle(extra)], channel });
  const game = newGameState(1);
  const rt = new Runtime(engine.registry, game);
  return { rt, game };
}

describe('entities', () => {
  it('computes stats from default, level, class and gear', () => {
    const { rt, game } = rtWith();
    const ch = newCharacter('al', 'Al');
    ch.equipped['tp:hand'] = 'tp:mallet';
    ch.inventory['tp:mallet'] = 1;
    game.characters.al = ch;
    expect(classOf(rt, ch)?.id).toBe('tp:brute');
    expect(stat(rt, charRef('al'), 'tp:power')).toBe(5 + 5 + 2);
    ch.level = 3;
    expect(stat(rt, charRef('al'), 'tp:power')).toBe(5 + 2 + 5 + 2);
  });

  it('computes max HP from settings, level, class and gear', () => {
    const { rt, game } = rtWith();
    const ch = newCharacter('mo', 'Mo');
    ch.equipped['tp:hand'] = 'tp:rod';
    ch.equipped['tp:body'] = 'tp:vest';
    ch.inventory['tp:vest'] = 1;
    game.characters.mo = ch;
    expect(maxHp(rt, charRef('mo'))).toBe(100 - 10 + 20);
    ch.level = 2;
    expect(maxHp(rt, charRef('mo'))).toBe(100 + 5 - 10 + 20);
  });

  it('only counts owned, resolvable gear', () => {
    const { rt, game } = rtWith();
    const ch = newCharacter('al', 'Al');
    ch.equipped['tp:body'] = 'tp:vest';
    game.characters.al = ch;
    expect(effectiveEquipped(rt, ch)).toEqual([]);
    ch.inventory['tp:vest'] = 1;
    expect(effectiveEquipped(rt, ch).map(([s, i]) => [s, i.id])).toEqual([['tp:body', 'tp:vest']]);
  });

  it('falls back to the first starting item when the class item is dormant', () => {
    const { rt, game } = rtWith();
    const ch = newCharacter('al', 'Al');
    ch.equipped['tp:hand'] = 'gone:wand';
    ch.inventory['gone:wand'] = 1;
    game.characters.al = ch;
    expect(effectiveEquipped(rt, ch).map(([s, i]) => [s, i.id])).toEqual([['tp:hand', 'tp:club']]);
    expect(classOf(rt, ch)?.id).toBe('tp:brute');
  });

  it('a character with no class item has no class', () => {
    const { rt, game } = rtWith();
    game.characters.al = newCharacter('al', 'Al');
    expect(classOf(rt, game.characters.al)).toBeNull();
    expect(abilitiesOf(rt, game.characters.al)).toEqual([]);
  });

  it('lists abilities from class, gear and consumables, skipping duplicates', () => {
    const { rt, game } = rtWith();
    const ch = newCharacter('mo', 'Mo');
    ch.equipped['tp:hand'] = 'tp:rod';
    ch.inventory['tp:biscuit'] = 2;
    game.characters.mo = ch;
    expect(abilitiesOf(rt, ch)).toEqual([
      { ability: 'tp:whack', from: 'class' },
      { ability: 'tp:mend', from: 'class' },
      { ability: 'tp:wake', from: 'class' },
      { ability: 'tp:snack', from: 'item', item: 'tp:biscuit' },
    ]);
  });

  it('xpToReach follows the curve', () => {
    const { rt } = rtWith();
    expect([1, 2, 3, 4].map((l) => xpToReach(rt, l))).toEqual([0, 80, 210, 390]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/engine/test/entities.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `state.ts` and `events.ts`**

`packages/engine/src/state.ts`:
```ts
import type { MonsterDef } from './content';
import type { EntityRef } from './pack';
import { seedState } from './rng';

export interface StatusInstance {
  status: string;
  until: number | null;
  params: unknown;
  source: EntityRef | null;
  appliedAt: number;
  nextTick: number | null;
  seq: number;
}

export interface Character {
  id: string;
  name: string;
  level: number;
  xp: number;
  gold: number;
  hp: number;
  inventory: Record<string, number>;
  equipped: Record<string, string>;
  statuses: StatusInstance[];
  cooldowns: Record<string, number>;
  usesLeft: Record<string, number>;
  knockedOutUntil: number | null;
  banned: boolean;
  removedByStreamer: boolean;
  stores: Record<string, unknown>;
}

export interface MonsterState {
  id: string;
  def: MonsterDef;
  hp: number;
  knockedOut: boolean;
  statuses: StatusInstance[];
  stores: Record<string, unknown>;
}

export interface Origin { adventure: string; node: string }

export interface FightState {
  kind: 'core:fight';
  startedAt: number;
  origin: Origin | null;
  monsters: MonsterState[];
  sub: 'fighting' | 'waiting';
  held: boolean;
  heldRemaining: number | null;
  nextTurnAt: number | null;
  pausedTurnAt: number | null;
  acted: string[];
  wasActive: string[];
  joinedAt: Record<string, number>;
}

export interface KindEncounterState {
  kind: string;
  startedAt: number;
  origin: Origin | null;
  params: unknown;
  state: unknown;
}

export type EncounterState = FightState | KindEncounterState;

export interface SessionState {
  party: string[];
  encounter: EncounterState | null;
  adventure: { id: string; lined: string | null } | null;
}

export interface GameState {
  version: 1;
  clock: number;
  rng: number;
  seq: number;
  session: SessionState | null;
  characters: Record<string, Character>;
}

export function isFight(e: EncounterState): e is FightState {
  return e.kind === 'core:fight';
}

export function newGameState(seed: number): GameState {
  return { version: 1, clock: 0, rng: seedState(seed), seq: 0, session: null, characters: {} };
}

export function newCharacter(id: string, name: string): Character {
  return {
    id, name, level: 1, xp: 0, gold: 0, hp: 0, inventory: {}, equipped: {}, statuses: [], cooldowns: {},
    usesLeft: {}, knockedOutUntil: null, banned: false, removedByStreamer: false, stores: {},
  };
}
```

`packages/engine/src/events.ts`:
```ts
export interface GameEvent {
  type: string;
  at: number;
  text: string;
  data: Record<string, unknown>;
}
```

- [ ] **Step 4: Implement `runtime.ts`**

`packages/engine/src/runtime.ts`:
```ts
import type { Settings } from './channel';
import { Rejection } from './errors';
import type { GameEvent } from './events';
import type { FormulaNode } from './formula';
import type { ReactionJob } from './hooks';
import type { Registry } from './registry';
import { nextRandom } from './rng';
import type { Character, GameState } from './state';

/** One command or time step's working copy of the game. */
export class Runtime {
  events: GameEvent[] = [];
  queue: ReactionJob[] = [];
  depth = 0;
  limitHit = false;
  pendingEnd: string | null = null;
  inStatModifier = 0;
  readonly formulaCache = new Map<string, FormulaNode>();
  now: number;

  constructor(readonly reg: Registry, public game: GameState) {
    this.now = game.clock;
  }

  get settings(): Settings {
    return this.reg.settings;
  }

  emit(type: string, text: string, data: Record<string, unknown> = {}): void {
    this.events.push({ type, at: this.now, text, data });
  }

  random(): number {
    const [value, next] = nextRandom(this.game.rng);
    this.game.rng = next;
    return value;
  }

  randomInt(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  requireChar(id: string): Character {
    const ch = this.game.characters[id];
    if (!ch) throw new Rejection('Unknown character', 'unknown-character');
    return ch;
  }
}
```

- [ ] **Step 5: Stub `hooks.ts` so entities compile**

`packages/engine/src/hooks.ts`:
```ts
import type { EntityRef, Modifiers, ReactionEvent, ReactionRole } from './pack';
import type { Runtime } from './runtime';

export interface ReactionJob { event: ReactionEvent; ref: EntityRef; role: ReactionRole; depth: number }

/** Replaced in Task 2. */
export function modify<K extends keyof Modifiers>(
  _rt: Runtime, _holder: EntityRef, _point: K, value: Parameters<Modifiers[K]>[0], _extra: Record<string, unknown>,
): Parameters<Modifiers[K]>[0] {
  return value;
}
```

- [ ] **Step 6: Implement `entities.ts`**

`packages/engine/src/entities.ts`:
```ts
import type { ClassDef, ItemDef } from './content';
import { modify } from './hooks';
import type { EntityRef, Hooks, StatusView } from './pack';
import { CORE_HP, CORE_KO } from './registry';
import type { Runtime } from './runtime';
import { type Character, type FightState, isFight, type MonsterState, type StatusInstance } from './state';

export const charRef = (id: string): EntityRef => ({ kind: 'character', id });
export const monsterRef = (id: string): EntityRef => ({ kind: 'monster', id });
export const sameRef = (a: EntityRef, b: EntityRef): boolean => a.kind === b.kind && a.id === b.id;

export function currentFight(rt: Runtime): FightState | null {
  const e = rt.game.session?.encounter;
  return e && isFight(e) ? e : null;
}

function monsterOf(rt: Runtime, id: string): MonsterState | undefined {
  return currentFight(rt)?.monsters.find((m) => m.id === id);
}

export function entityExists(rt: Runtime, e: EntityRef): boolean {
  return e.kind === 'character' ? !!rt.game.characters[e.id] : !!monsterOf(rt, e.id);
}

function charOf(rt: Runtime, e: EntityRef): Character {
  const ch = rt.game.characters[e.id];
  if (!ch) throw new Error(`No character ${e.id}`);
  return ch;
}

function monOf(rt: Runtime, e: EntityRef): MonsterState {
  const m = monsterOf(rt, e.id);
  if (!m) throw new Error(`No monster ${e.id}`);
  return m;
}

export function entityName(rt: Runtime, e: EntityRef | null): string {
  if (!e) return 'Something';
  if (e.kind === 'character') return rt.game.characters[e.id]?.name ?? e.id;
  return monsterOf(rt, e.id)?.def.name ?? e.id;
}

export function entityTags(rt: Runtime, e: EntityRef): string[] {
  if (e.kind === 'monster') return [...monOf(rt, e).def.tags];
  return [...(classOf(rt, charOf(rt, e))?.tags ?? [])];
}

/** The raw, mutable status array. */
export function statusList(rt: Runtime, e: EntityRef): StatusInstance[] {
  return e.kind === 'character' ? charOf(rt, e).statuses : monOf(rt, e).statuses;
}

/** Statuses whose definition resolves (dormant ones are ignored while dormant). */
export function liveStatuses(rt: Runtime, e: EntityRef): StatusInstance[] {
  return statusList(rt, e).filter((s) => rt.reg.statuses.has(s.status));
}

export function statusViews(rt: Runtime, e: EntityRef): StatusView[] {
  const out: StatusView[] = [];
  if (e.kind === 'character' && charOf(rt, e).knockedOutUntil !== null) {
    out.push({ status: CORE_KO, until: charOf(rt, e).knockedOutUntil, params: {}, source: null });
  }
  if (e.kind === 'monster' && monOf(rt, e).knockedOut) out.push({ status: CORE_KO, until: null, params: {}, source: null });
  for (const s of liveStatuses(rt, e)) out.push({ status: s.status, until: s.until, params: s.params, source: s.source });
  return out;
}

export function storesOf(rt: Runtime, e: EntityRef): Record<string, unknown> {
  return e.kind === 'character' ? charOf(rt, e).stores : monOf(rt, e).stores;
}

export function isKnockedOut(rt: Runtime, e: EntityRef): boolean {
  return e.kind === 'character' ? charOf(rt, e).knockedOutUntil !== null : monOf(rt, e).knockedOut;
}

export function owns(rt: Runtime, ch: Character, item: string): boolean {
  return (ch.inventory[item] ?? 0) > 0 || rt.settings.startingItems.includes(item);
}

/** Resolvable items the character owns: inventory first (in insertion order), then starting items. */
export function ownedItems(rt: Runtime, ch: Character): ItemDef[] {
  const ids = [...Object.keys(ch.inventory).filter((i) => (ch.inventory[i] ?? 0) > 0), ...rt.settings.startingItems];
  return [...new Set(ids)].map((i) => rt.reg.items.get(i)).filter((i): i is ItemDef => !!i);
}

/** Equipped items that count, in slot order. A dormant class item falls back to the first starting item for that slot. */
export function effectiveEquipped(rt: Runtime, ch: Character): [string, ItemDef][] {
  const out: [string, ItemDef][] = [];
  for (const slot of rt.reg.slots.keys()) {
    const stored = ch.equipped[slot];
    if (!stored) continue;
    const item = rt.reg.items.get(stored);
    if (item && item.slot === slot && owns(rt, ch, stored)) { out.push([slot, item]); continue; }
    if (!item && slot === rt.settings.classSlot) {
      const fallback = rt.settings.startingItems.map((i) => rt.reg.items.get(i)).find((i) => i && i.slot === slot);
      if (fallback) out.push([slot, fallback]);
    }
  }
  return out;
}

export function classOf(rt: Runtime, ch: Character): ClassDef | null {
  const slot = rt.settings.classSlot;
  if (!slot) return null;
  const item = effectiveEquipped(rt, ch).find(([s]) => s === slot)?.[1];
  return item?.grantsClass ? rt.reg.classes.get(item.grantsClass) ?? null : null;
}

export interface AbilitySource { ability: string; from: 'class' | 'gear' | 'item'; item?: string }

export function abilitiesOf(rt: Runtime, ch: Character): AbilitySource[] {
  const out: AbilitySource[] = [];
  const seen = new Set<string>();
  const add = (ability: string, from: AbilitySource['from'], item?: string) => {
    if (!rt.reg.abilities.has(ability) || seen.has(ability)) return;
    seen.add(ability);
    out.push(item ? { ability, from, item } : { ability, from });
  };
  for (const a of classOf(rt, ch)?.abilities ?? []) add(a, 'class');
  for (const [, item] of effectiveEquipped(rt, ch)) for (const a of item.abilities) add(a, 'gear', item.id);
  for (const item of ownedItems(rt, ch)) if (item.use) add(item.use, 'item', item.id);
  return out;
}

function bonuses(rt: Runtime, ch: Character, statId: string): number {
  let total = classOf(rt, ch)?.stats[statId] ?? 0;
  for (const [, item] of effectiveEquipped(rt, ch)) total += item.stats[statId] ?? 0;
  return total;
}

export function level(rt: Runtime, e: EntityRef): number {
  return e.kind === 'character' ? charOf(rt, e).level : 1;
}

export function statRaw(rt: Runtime, e: EntityRef, statId: string): number {
  const def = rt.reg.stats.get(statId);
  if (!def) return 0;
  if (e.kind === 'monster') return monOf(rt, e).def.stats[statId] ?? def.default;
  const ch = charOf(rt, e);
  return def.default + def.perLevel * (ch.level - 1) + bonuses(rt, ch, statId);
}

function modified(rt: Runtime, e: EntityRef, statId: string, raw: number): number {
  if (rt.inStatModifier > 0) return raw;
  rt.inStatModifier++;
  try {
    return modify(rt, e, 'stat', raw, { stat: statId });
  } finally {
    rt.inStatModifier--;
  }
}

export function stat(rt: Runtime, e: EntityRef, statId: string): number {
  return modified(rt, e, statId, statRaw(rt, e, statId));
}

export function maxHp(rt: Runtime, e: EntityRef): number {
  let raw: number;
  if (e.kind === 'monster') raw = monOf(rt, e).def.hp;
  else {
    const ch = charOf(rt, e);
    raw = rt.settings.baseHp + rt.settings.hpPerLevel * (ch.level - 1) + bonuses(rt, ch, CORE_HP);
  }
  return Math.max(1, Math.round(modified(rt, e, CORE_HP, raw)));
}

/** The HP the game uses: 0 while knocked out, otherwise saved HP capped at max HP. */
export function hp(rt: Runtime, e: EntityRef): number {
  if (e.kind === 'monster') return monOf(rt, e).hp;
  const ch = charOf(rt, e);
  if (ch.knockedOutUntil !== null) return 0;
  return Math.min(ch.hp, maxHp(rt, e));
}

export interface Holder { pack: string; label: string; hooks: Hooks; params: unknown }

/** Passives (class, gear in slot order, monster), then statuses in the order applied. */
export function holders(rt: Runtime, e: EntityRef): Holder[] {
  const out: Holder[] = [];
  const addPassive = (passive: string, params: unknown) => {
    const p = rt.reg.passives.get(passive);
    if (p) out.push({ pack: p.pack, label: p.id, hooks: p.def, params });
  };
  if (e.kind === 'character') {
    const ch = charOf(rt, e);
    for (const u of classOf(rt, ch)?.passives ?? []) addPassive(u.passive, u.params);
    for (const [, item] of effectiveEquipped(rt, ch)) for (const u of item.passives) addPassive(u.passive, u.params);
  } else {
    for (const u of monOf(rt, e).def.passives) addPassive(u.passive, u.params);
  }
  for (const s of liveStatuses(rt, e)) {
    const st = rt.reg.statuses.get(s.status)!;
    out.push({ pack: st.pack, label: st.id, hooks: st.def, params: s.params });
  }
  return out;
}

export function partyRefs(rt: Runtime): EntityRef[] {
  return (rt.game.session?.party ?? []).filter((id) => rt.game.characters[id]).map(charRef);
}

export function enemiesOf(rt: Runtime, e: EntityRef): EntityRef[] {
  if (e.kind === 'monster') return partyRefs(rt);
  return (currentFight(rt)?.monsters ?? []).map((m) => monsterRef(m.id));
}

export function alliesOf(rt: Runtime, e: EntityRef): EntityRef[] {
  if (e.kind === 'character') return partyRefs(rt);
  return (currentFight(rt)?.monsters ?? []).map((m) => monsterRef(m.id));
}

/** Total XP needed to reach `lvl`: level 2 at `first`, each later step `step` more. */
export function xpToReach(rt: Runtime, lvl: number): number {
  const { first, step } = rt.settings.xpCurve;
  let total = 0;
  for (let l = 2; l <= lvl; l++) total += first + step * (l - 2);
  return total;
}
```

Also add `newGame` to the engine so the test's `createEngine` import still works (it only needs `registry`, which Plan A already exposes).

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm vitest run packages/engine/test/entities.test.ts && pnpm typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): game state, runtime and entity helpers"
```

---

### Task 2: Hooks, `ctx` and operations

**Files:**
- Modify: `packages/engine/src/hooks.ts` (replace the stub)
- Create: `packages/engine/src/ctx.ts`, `packages/engine/src/ops.ts`
- Create: `packages/engine/src/fight.ts` (only `markActed` and `markActive` in this task; Task 4 adds the rest)
- Test: `packages/engine/test/ops.test.ts`

**Interfaces:**
- Consumes: Task 1; `parseFormula`, `evaluateFormula` (A4); `normalizeParams`, `NormalizeCtx`, `p` (A5); `PluginError`, `Rejection`, `EngineError` (A3); `parseDuration` (A2).
- Produces:
  - `hooks.ts`: `MAX_DEPTH = 8`; `callPlugin<T>(pack: string, label: string, fn: () => T): T`; `modify(rt, holder, point, value, extra)`; `react(rt, event: ReactionEvent, recipients: { ref: EntityRef; role: ReactionRole }[]): void`; `drainReactions(rt): void`
  - `ctx.ts`: `resolveFor(rt, pack, type: RefType, id: string): string`; `evalFormula(rt, pack, text, sides): number`; `makeCtx(rt, pack): Ctx`; `runtimeNormalizeCtx(rt, pack): NormalizeCtx & { issues: string[] }`
  - `ops.ts`: `dealDamage(rt, source, target, amount, tags): number`; `heal(rt, source, target, amount): number`; `revive(rt, target, hp, source): void`; `knockOut(rt, target, duration: number | undefined, source): void`; `endKnockout(rt, characterId): void`; `applyStatus(rt, target, statusId, duration: number | null, params, source): void`; `removeStatus(rt, target, statusId, reason: 'expired' | 'removed', seq?: number): void`; `useAbility(rt, user, abilityId, chosen: EntityRef | null, hints, command: boolean): boolean`; `runSteps(rt, steps, source, targets): void`; `giveRewards(rt, character, r): void`; `addXp(rt, ch, n): void`; `addGold(rt, ch, n): void`; `spendGold(rt, character, n): void`; `giveItem(rt, character, item, count): void`; `setStore(rt, pack, e, data): void`
  - `fight.ts` (partial): `markActed(rt, user: EntityRef): void`, `markActive(rt, characterId: string): void`

These operations are exercised through a small fixture: a `Runtime` with an open session, two characters and a running fight, built by hand in the test.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/ops.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src';
import { makeCtx } from '../src/ctx';
import { charRef, hp, monsterRef } from '../src/entities';
import { drainReactions } from '../src/hooks';
import {
  applyStatus, dealDamage, giveRewards, heal, knockOut, removeStatus, revive, spendGold, useAbility,
} from '../src/ops';
import type { PackApi } from '../src/pack';
import { Runtime } from '../src/runtime';
import { newCharacter, newGameState } from '../src/state';
import { withPlugins } from './helpers/harness';
import { tpBundle, tpChannel } from './helpers/tp-pack';

const EXTRA = (api: PackApi) => {
  api.passive('spiky', {
    name: 'Spiky',
    react: { damaged: ({ ctx, holder, role, event }) => { if (role === 'target' && event.source) ctx.dealDamage(holder, event.source, 1); } },
  });
  api.passive('ward', { name: 'Ward', modify: { damageTaken: (v) => v / 2 } });
  api.passive('lucky', { name: 'Lucky', modify: { rewardsReceived: (r) => ({ ...r, gold: r.gold + 10 }) } });
  api.status('mute', { name: 'Mute', modify: { canUse: () => 'You are muted' } });
};
const CONTENT = [
  { class: 'spiker', name: 'Spiker', abilities: ['whack'], passives: ['spiky'] },
  { item: 'thorn', name: 'Thorn', slot: 'hand', 'grants-class': 'spiker' },
  { item: 'charm', name: 'Charm', slot: 'body', passives: ['lucky'] },
  {
    monster: 'urchin', name: 'Urchin', hp: 500, abilities: ['slam'], passives: ['spiky'],
    behavior: { pile: { abilities: { slam: 1 }, 'targets-per': 5 } },
  },
  {
    monster: 'turtle', name: 'Turtle', hp: 100, abilities: ['slam'], passives: ['ward'],
    behavior: { pile: { abilities: { slam: 1 }, 'targets-per': 5 } },
  },
];

function fixture(monster = 'tp:blob') {
  const engine = createEngine({ packs: [withPlugins(tpBundle(CONTENT), EXTRA)], channel: tpChannel() });
  const game = newGameState(1);
  const rt = new Runtime(engine.registry, game);
  for (const [id, item] of [['al', 'tp:club'], ['mo', 'tp:rod']] as const) {
    const ch = newCharacter(id, id.toUpperCase());
    ch.equipped['tp:hand'] = item;
    ch.hp = 100;
    game.characters[id] = ch;
  }
  game.characters.mo!.hp = 90;
  const def = engine.registry.monsters.get(monster)!;
  game.session = {
    party: ['al', 'mo'], adventure: null,
    encounter: {
      kind: 'core:fight', startedAt: 0, origin: null, sub: 'fighting', held: false, heldRemaining: null,
      nextTurnAt: 15000, pausedTurnAt: null, acted: [], wasActive: ['al', 'mo'], joinedAt: { al: 0, mo: 0 },
      monsters: [{ id: 'm1', def, hp: def.hp, knockedOut: false, statuses: [], stores: {} }],
    },
  };
  return { rt, game, engine };
}
const al = charRef('al');
const mo = charRef('mo');
const m1 = monsterRef('m1');

describe('damage and healing', () => {
  it('deals rounded damage, emits an event, and knocks out at 0', () => {
    const { rt } = fixture();
    expect(dealDamage(rt, al, mo, 10.4, [])).toBe(10);
    expect(hp(rt, mo)).toBe(80);
    expect(rt.events.at(-1)).toMatchObject({ type: 'core:damaged', text: 'AL hits MO for 10', data: { amount: 10 } });
    dealDamage(rt, al, mo, 500, []);
    expect(rt.game.characters.mo!.knockedOutUntil).toBe(60000);
    expect(rt.events.map((e) => e.type)).toContain('core:knocked-out');
    expect(dealDamage(rt, al, mo, 5, [])).toBe(0);
  });

  it('runs damageTaken modifiers', () => {
    const { rt } = fixture('tp:turtle');
    expect(dealDamage(rt, al, m1, 10, [])).toBe(5);
  });

  it('heals up to max HP and not while knocked out', () => {
    const { rt } = fixture();
    rt.game.characters.al!.hp = 50;
    expect(heal(rt, mo, al, 30)).toBe(30);
    expect(heal(rt, mo, al, 999)).toBe(20);
    knockOut(rt, al, undefined, null);
    expect(heal(rt, mo, al, 10)).toBe(0);
  });

  it('revives and ends knockouts', () => {
    const { rt } = fixture();
    knockOut(rt, al, 5000, null);
    expect(rt.game.characters.al!.knockedOutUntil).toBe(5000);
    revive(rt, al, 30, null);
    expect(rt.game.characters.al!.knockedOutUntil).toBeNull();
    expect(hp(rt, al)).toBe(30);
  });

  it('skips source modifiers when there is no source', () => {
    const { rt } = fixture();
    expect(dealDamage(rt, null, mo, 7, [])).toBe(7);
    expect(rt.events.at(-1)!.text).toBe('MO takes 7 damage');
  });
});

describe('statuses', () => {
  it('applies with refresh stacking, ticks are scheduled, and removal emits', () => {
    const { rt } = fixture();
    rt.now = 1000;
    applyStatus(rt, al, 'tp:snooze', 30000, { factor: 1.5 }, null);
    applyStatus(rt, al, 'tp:snooze', 10000, { factor: 2 }, null);
    expect(rt.game.characters.al!.statuses).toEqual([
      expect.objectContaining({ status: 'tp:snooze', until: 11000, params: { factor: 2 } }),
    ]);
    removeStatus(rt, al, 'tp:snooze', 'removed');
    expect(rt.game.characters.al!.statuses).toEqual([]);
    expect(rt.events.map((e) => e.type)).toEqual(['core:status-applied', 'core:status-applied', 'core:status-ended']);
  });

  it('treats core:knocked-out as a knockout', () => {
    const { rt } = fixture();
    applyStatus(rt, al, 'core:knocked-out', 2000, {}, null);
    expect(rt.game.characters.al!.knockedOutUntil).toBe(2000);
  });
});

describe('abilities', () => {
  it('uses an ability: cooldown with modifiers, steps in order, acted', () => {
    const { rt } = fixture();
    applyStatus(rt, al, 'tp:snooze', null, { factor: 1.5 }, null);
    expect(useAbility(rt, al, 'tp:zap', null, {}, true)).toBe(true);
    expect(rt.game.characters.al!.cooldowns['tp:zap']).toBe(45000);
    expect(hp(rt, m1)).toBe(50 - 10 - 20);
    expect((rt.game.session!.encounter as { acted: string[] }).acted).toEqual(['al']);
  });

  it('requires a valid choice for needsChoice rules', () => {
    const { rt } = fixture();
    expect(() => useAbility(rt, mo, 'tp:mend', null, {}, true)).toThrow('Pick a target');
    expect(() => useAbility(rt, mo, 'tp:mend', m1, {}, true)).toThrow("That target isn't valid");
    rt.game.characters.al!.hp = 50;
    useAbility(rt, mo, 'tp:mend', al, {}, true);
    expect(hp(rt, al)).toBe(70);
  });

  it('a monster ability with hints targets that many enemies', () => {
    const { rt } = fixture();
    useAbility(rt, m1, 'tp:slam', null, { count: 2 }, false);
    expect(hp(rt, al)).toBe(94);
    expect(hp(rt, mo)).toBe(84);
  });
});

describe('reactions', () => {
  it('runs reactions after the operation and stops chains at depth 8', () => {
    const { rt } = fixture('tp:urchin');
    rt.game.characters.al!.equipped['tp:hand'] = 'tp:thorn';
    rt.game.characters.al!.inventory['tp:thorn'] = 1;
    useAbility(rt, al, 'tp:whack', null, {}, true);
    drainReactions(rt);
    const damaged = rt.events.filter((e) => e.type === 'core:damaged');
    expect(damaged).toHaveLength(9);
    expect(rt.events.filter((e) => e.type === 'core:reaction-limit')).toHaveLength(1);
  });
});

describe('rewards, gold and plugin ctx', () => {
  it('applies multipliers then rewardsReceived', () => {
    const engine = createEngine({ packs: [withPlugins(tpBundle(CONTENT), EXTRA)], channel: tpChannel({ settings: { 'gold-multiplier': 2 } }) });
    const rt = new Runtime(engine.registry, newGameState(1));
    const ch = newCharacter('al', 'AL');
    ch.equipped['tp:body'] = 'tp:charm';
    ch.inventory['tp:charm'] = 1;
    rt.game.characters.al = ch;
    giveRewards(rt, al, { xp: 90, gold: 5, items: ['tp:biscuit'] });
    expect(ch).toMatchObject({ xp: 90, gold: 20, level: 2, inventory: { 'tp:charm': 1, 'tp:biscuit': 1 } });
    expect(rt.events.map((e) => e.type)).toEqual(['core:rewarded', 'core:level-up', 'core:item-given']);
  });

  it('spendGold rejects when short', () => {
    const { rt } = fixture();
    rt.game.characters.al!.gold = 5;
    expect(() => spendGold(rt, al, 10)).toThrow('Not enough gold');
    spendGold(rt, al, 5);
    expect(rt.game.characters.al!.gold).toBe(0);
  });

  it('ctx resolves short IDs against its pack and guards custom events and stores', () => {
    const { rt } = fixture();
    const ctx = makeCtx(rt, 'tp');
    expect(ctx.stat(al, 'power')).toBe(10);
    expect(ctx.formula('power + target.power', { source: al, target: m1 })).toBe(16);
    expect(() => ctx.formula('power', { source: null, target: m1 })).toThrow(/uses the source/);
    expect(() => ctx.emit('other:x', {}, 'x')).toThrow(/must start with 'tp:'/);
    ctx.emit('tp:cheer', { n: 1 }, 'Cheer!');
    ctx.setStore(al, { mana: 3 });
    expect(ctx.store(al)).toEqual({ mana: 3 });
    expect(makeCtx(rt, 'other').store(al)).toEqual({});
    expect(rt.events.map((e) => e.type)).toEqual(['tp:cheer', 'core:store-changed']);
  });

  it('byPriority puts higher priority first', () => {
    const { rt } = fixture();
    applyStatus(rt, mo, 'tp:shielded', null, { cut: 0, priority: 1 }, null);
    const ctx = makeCtx(rt, 'tp');
    expect(ctx.byPriority(m1, 'tp:slam', [al, mo])).toEqual([mo, al]);
  });
});
```

The test imports `withPlugins` from `./helpers/harness`; create that helper in Step 3.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/engine/test/ops.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Create the harness helper (used by this and later tasks)**

`packages/engine/test/helpers/harness.ts`:
```ts
import { createEngine } from '../../src';
import type { Command } from '../../src/commands';
import type { GameEvent } from '../../src/events';
import type { PackApi, PackBundle } from '../../src/pack';
import type { FightState, GameState } from '../../src/state';
import { tpBundle, tpChannel } from './tp-pack';

export function withPlugins(bundle: PackBundle, extra: (api: PackApi) => void): PackBundle {
  const inner = bundle.register!;
  return { ...bundle, register: (api) => { inner(api); extra(api); } };
}

export interface HarnessOpts {
  settings?: Record<string, unknown>;
  content?: unknown[];
  plugins?: (api: PackApi) => void;
  seed?: number;
  channel?: Record<string, unknown>;
}

export function harness(opts: HarnessOpts = {}) {
  let bundle = tpBundle(opts.content ?? []);
  if (opts.plugins) bundle = withPlugins(bundle, opts.plugins);
  const engine = createEngine({ packs: [bundle], channel: tpChannel({ ...(opts.channel ?? {}), settings: opts.settings ?? {} }) });
  let game: GameState = engine.newGame({ seed: opts.seed ?? 1 });
  let now = 0;
  const log: GameEvent[] = [];
  const h = {
    engine,
    bundle,
    get game() { return game; },
    set game(g: GameState) { game = g; },
    get now() { return now; },
    at(t: number) { now = t; return h; },
    do(cmd: Command): GameEvent[] {
      const r = engine.apply(game, cmd, now);
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      game = r.game;
      log.push(...r.events);
      return r.events;
    },
    fail(cmd: Command): { code: string; message: string } {
      const r = engine.apply(game, cmd, now);
      if (r.ok) throw new Error(`expected ${cmd.type} to be rejected`);
      return r.error;
    },
    wait(ms: number): GameEvent[] {
      now += ms;
      const r = engine.advance(game, now);
      game = r.game;
      log.push(...r.events);
      return r.events;
    },
    char(id: string) { return game.characters[id]!; },
    fight() { return game.session!.encounter as FightState; },
    monster() { return (game.session!.encounter as FightState).monsters[0]!; },
    log,
    types(events: GameEvent[] = log) { return events.map((e) => e.type); },
    open() { return h.do({ type: 'openSession' }); },
    join(id: string, pick: string | null = 'tp:club') {
      return h.do({ type: 'join', character: id, name: id[0]!.toUpperCase() + id.slice(1), ...(pick ? { pick } : {}) });
    },
    spawn(monster = 'tp:blob') { return h.do({ type: 'spawnMonster', monster }); },
    use(id: string, ability: string, chosen?: string) {
      return h.do({ type: 'use', character: id, ability, ...(chosen ? { chosen: { kind: 'character' as const, id: chosen } } : {}) });
    },
  };
  return h;
}
```

This file references `Command`, `engine.newGame` and `engine.apply`, which don't exist until Task 3. `ops.test.ts` only imports `withPlugins`; Vitest transpiles without type-checking, so it runs. `pnpm typecheck` will fail on this file until Task 3; that's expected. Don't run `pnpm typecheck` until Task 3, Step 7.

- [ ] **Step 4: Implement `hooks.ts`**

`packages/engine/src/hooks.ts`:
```ts
import { makeCtx } from './ctx';
import { entityExists, holders } from './entities';
import { EngineError, PluginError, Rejection } from './errors';
import type { EntityRef, Modifiers, ReactionEvent, ReactionRole } from './pack';
import type { Runtime } from './runtime';

export const MAX_DEPTH = 8;

export interface ReactionJob { event: ReactionEvent; ref: EntityRef; role: ReactionRole; depth: number }

/** Run pack code; tag unexpected throws with the pack and plugin. */
export function callPlugin<T>(pack: string, label: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Rejection || e instanceof PluginError || e instanceof EngineError) throw e;
    throw new PluginError(pack, label, e);
  }
}

export function modify<K extends keyof Modifiers>(
  rt: Runtime, holder: EntityRef, point: K, value: Parameters<Modifiers[K]>[0], extra: Record<string, unknown>,
): Parameters<Modifiers[K]>[0] {
  let v = value;
  for (const h of holders(rt, holder)) {
    const fn = h.hooks.modify?.[point] as ((value: unknown, info: unknown) => unknown) | undefined;
    if (!fn) continue;
    v = callPlugin(h.pack, `${h.label} modify.${point}`, () =>
      fn(v, { ctx: makeCtx(rt, h.pack), holder, params: h.params, ...extra })) as typeof v;
  }
  return v;
}

export function react(rt: Runtime, event: ReactionEvent, recipients: { ref: EntityRef; role: ReactionRole }[]): void {
  for (const r of recipients) rt.queue.push({ event, ref: r.ref, role: r.role, depth: rt.depth + 1 });
}

export function drainReactions(rt: Runtime): void {
  while (rt.queue.length) {
    const job = rt.queue.shift()!;
    if (job.depth > MAX_DEPTH) {
      if (!rt.limitHit) {
        rt.limitHit = true;
        rt.emit('core:reaction-limit', 'A chain of reactions was stopped', {});
      }
      continue;
    }
    if (!entityExists(rt, job.ref)) continue;
    const prev = rt.depth;
    rt.depth = job.depth;
    try {
      for (const h of holders(rt, job.ref)) {
        const fn = h.hooks.react?.[job.event.type] as ((info: unknown) => void) | undefined;
        if (!fn) continue;
        callPlugin(h.pack, `${h.label} react.${job.event.type}`, () =>
          fn({ ctx: makeCtx(rt, h.pack), holder: job.ref, params: h.params, role: job.role, event: job.event }));
      }
    } finally {
      rt.depth = prev;
    }
  }
}
```

- [ ] **Step 5: Implement `ctx.ts`**

`packages/engine/src/ctx.ts`:
```ts
import {
  alliesOf, enemiesOf, entityName, entityTags, hp, isKnockedOut, level, maxHp, partyRefs, stat, statusViews, storesOf,
} from './entities';
import { evaluateFormula, FormulaError, mapFormulaStats, parseFormula, printFormula } from './formula';
import { modify } from './hooks';
import { CORE, type RefType } from './ids';
import {
  applyStatus, dealDamage, giveItem, giveRewards, heal, knockOut, removeStatus, revive, runSteps, setStore, spendGold, useAbility,
} from './ops';
import type { Ctx, EntityRef } from './pack';
import { type NormalizeCtx, normalizeParams, p, type Step } from './params';
import type { Registry } from './registry';
import type { Runtime } from './runtime';

const MAPS: Record<RefType, keyof Registry> = {
  stat: 'stats', slot: 'slots', class: 'classes', ability: 'abilities', item: 'items', monster: 'monsters',
  encounter: 'encounters', adventure: 'adventures', effect: 'effects', status: 'statuses', passive: 'passives',
  targeting: 'targeting', behavior: 'behaviors', encounterKind: 'kinds',
};

/** A short ID means the calling pack's, then the core's. Prefixed IDs pass through. */
export function resolveFor(rt: Runtime, pack: string, type: RefType, id: string): string {
  if (id.includes(':')) return id;
  const map = rt.reg[MAPS[type]] as Map<string, unknown>;
  const own = `${pack}:${id}`;
  if (map.has(own)) return own;
  const core = `${CORE}:${id}`;
  return map.has(core) ? core : own;
}

export function evalFormula(rt: Runtime, pack: string, text: string, sides: { source: EntityRef | null; target: EntityRef | null }): number {
  let node = rt.formulaCache.get(text);
  if (!node) {
    node = parseFormula(text);
    rt.formulaCache.set(text, node);
  }
  return evaluateFormula(node, {
    value(v) {
      const e = v.side === 'source' ? sides.source : sides.target;
      if (!e) throw new Error(`This formula uses the ${v.side}, but there is none`);
      if (v.what === 'hp') return hp(rt, e);
      if (v.what === 'hp.max') return maxHp(rt, e);
      if (v.what === 'level') return level(rt, e);
      return stat(rt, e, resolveFor(rt, pack, 'stat', v.stat!));
    },
    random: (a, b) => a + (b - a) * rt.random(),
  });
}

export function byPriority(rt: Runtime, user: EntityRef, ability: string, candidates: EntityRef[]): EntityRef[] {
  return candidates
    .map((c) => ({ c, pr: modify(rt, c, 'targetPriority', 0, { user, ability }), r: rt.random() }))
    .sort((a, b) => b.pr - a.pr || a.r - b.r)
    .map((x) => x.c);
}

export function makeCtx(rt: Runtime, pack: string): Ctx {
  const R = (type: RefType, id: string) => resolveFor(rt, pack, type, id);
  return {
    get now() { return rt.now; },
    random: () => rt.random(),
    randomInt: (a, b) => rt.randomInt(a, b),
    name: (e) => entityName(rt, e),
    tags: (e) => entityTags(rt, e),
    stat: (e, id) => stat(rt, e, R('stat', id)),
    hp: (e) => hp(rt, e),
    maxHp: (e) => maxHp(rt, e),
    level: (e) => level(rt, e),
    gold: (c) => rt.requireChar(c.id).gold,
    isKnockedOut: (e) => isKnockedOut(rt, e),
    statuses: (e) => statusViews(rt, e),
    party: () => partyRefs(rt),
    active: () => partyRefs(rt).filter((e) => !isKnockedOut(rt, e)),
    enemiesOf: (e) => enemiesOf(rt, e),
    alliesOf: (e) => alliesOf(rt, e),
    byPriority: (user, ability, candidates) => byPriority(rt, user, R('ability', ability), candidates),
    formula: (text, sides) => evalFormula(rt, pack, text, sides),
    store: (e) => structuredClone(storesOf(rt, e)[pack] ?? {}),
    startingItems: () => [...rt.settings.startingItems],
    dealDamage: (s, t, a, o) => dealDamage(rt, s, t, a, o?.tags ?? []),
    heal: (s, t, a) => heal(rt, s, t, a),
    revive: (t, h) => revive(rt, t, h, null),
    knockOut: (t, d) => knockOut(rt, t, d, null),
    applyStatus: (t, id, o) => applyStatus(rt, t, R('status', id), o?.duration ?? null, o?.params ?? {}, o?.source ?? null),
    removeStatus: (t, id) => removeStatus(rt, t, R('status', id), 'removed'),
    useAbility: (u, id, o) => { useAbility(rt, u, R('ability', id), o?.chosen ?? null, o?.hints ?? {}, false); },
    runSteps: (steps: Step[], a) => runSteps(rt, steps, a.source, a.targets),
    giveRewards: (c, r) => giveRewards(rt, c, r),
    spendGold: (c, n) => spendGold(rt, c, n),
    giveItem: (c, i, n) => giveItem(rt, c, R('item', i), n ?? 1),
    endEncounter: (outcome) => { rt.pendingEnd = outcome; },
    emit: (type, data, text) => {
      if (!type.startsWith(`${pack}:`)) throw new Error(`Custom event types must start with '${pack}:'`);
      rt.emit(type, text, data);
    },
    setStore: (e, data) => setStore(rt, pack, e, data),
  };
}

/** Normalizes runtime input (viewer responses, streamer status params) against the registry. */
export function runtimeNormalizeCtx(rt: Runtime, pack: string): NormalizeCtx & { issues: string[] } {
  const ctx = {
    issues: [] as string[],
    issue(path: string, message: string) { ctx.issues.push(path ? `${path}: ${message}` : message); },
    ref(type: RefType, raw: string, path: string): string | null {
      const id = resolveFor(rt, pack, type, raw);
      if ((rt.reg[MAPS[type]] as Map<string, unknown>).has(id)) return id;
      ctx.issue(path, `Unknown ${type} '${raw}'`);
      return null;
    },
    formula(text: string, path: string): string | null {
      try {
        const node = mapFormulaStats(parseFormula(text), (s) => resolveFor(rt, pack, 'stat', s));
        return printFormula(node);
      } catch (e) {
        if (e instanceof FormulaError) { ctx.issue(path, e.message); return null; }
        throw e;
      }
    },
    steps(value: unknown, path: string): Step[] | null {
      if (!Array.isArray(value)) { ctx.issue(path, 'must be a list of steps'); return null; }
      return value.flatMap((step, i) => {
        const [key, params] = Object.entries(step as object)[0] ?? ['', {}];
        const effect = ctx.ref('effect', key, `${path}[${i}]`);
        if (!effect) return [];
        const def = rt.reg.effects.get(effect)!.def;
        return [{ effect, params: normalizeParams(def.params ?? p.object({}), params, ctx, `${path}[${i}].${key}`) }];
      });
    },
    statusApplication(): null {
      ctx.issue('', 'status applications are not accepted here');
      return null;
    },
  };
  return ctx;
}
```

- [ ] **Step 6: Implement `ops.ts` and the start of `fight.ts`**

`packages/engine/src/fight.ts` (partial; Task 4 extends this file):
```ts
import { currentFight, isKnockedOut, charRef } from './entities';
import type { EntityRef } from './pack';
import type { Runtime } from './runtime';

export function markActed(rt: Runtime, user: EntityRef): void {
  const f = currentFight(rt);
  if (!f || user.kind !== 'character' || !rt.game.session!.party.includes(user.id)) return;
  if (!f.acted.includes(user.id)) f.acted.push(user.id);
}

export function markActive(rt: Runtime, id: string): void {
  const f = currentFight(rt);
  if (!f || !rt.game.session!.party.includes(id) || isKnockedOut(rt, charRef(id))) return;
  if (!f.wasActive.includes(id)) f.wasActive.push(id);
}
```

`packages/engine/src/ops.ts`:
```ts
import { makeCtx } from './ctx';
import { charRef, currentFight, entityExists, entityName, hp, isKnockedOut, maxHp, sameRef, statusList, storesOf, xpToReach } from './entities';
import { Rejection } from './errors';
import { markActed, markActive } from './fight';
import { callPlugin, modify, react } from './hooks';
import type { EntityRef, ReactionRole } from './pack';
import type { Step } from './params';
import { CORE_KO } from './registry';
import type { Runtime } from './runtime';
import type { Character } from './state';
import { parseDuration } from './units';

function setHp(rt: Runtime, e: EntityRef, value: number): void {
  if (e.kind === 'character') {
    rt.game.characters[e.id]!.hp = value;
    return;
  }
  const f = currentFight(rt);
  const m = f?.monsters.find((x) => x.id === e.id);
  if (m) m.hp = value;
}

function pair(source: EntityRef | null, target: EntityRef): { ref: EntityRef; role: ReactionRole }[] {
  return source ? [{ ref: source, role: 'source' }, { ref: target, role: 'target' }] : [{ ref: target, role: 'target' }];
}

export function dealDamage(rt: Runtime, source: EntityRef | null, target: EntityRef, amount: number, tags: string[]): number {
  if (!entityExists(rt, target) || isKnockedOut(rt, target)) return 0;
  let v = amount;
  if (source && entityExists(rt, source)) v = modify(rt, source, 'damageDealt', v, { source, target, tags });
  v = modify(rt, target, 'damageTaken', v, { source, target, tags });
  const dmg = Math.max(0, Math.round(v));
  const after = Math.max(0, hp(rt, target) - dmg);
  setHp(rt, target, after);
  const text = source ? `${entityName(rt, source)} hits ${entityName(rt, target)} for ${dmg}` : `${entityName(rt, target)} takes ${dmg} damage`;
  rt.emit('core:damaged', text, { source, target, amount: dmg, tags });
  react(rt, { type: 'damaged', source, target, amount: dmg }, pair(source, target));
  if (after === 0) knockOut(rt, target, undefined, source);
  return dmg;
}

export function heal(rt: Runtime, source: EntityRef | null, target: EntityRef, amount: number): number {
  if (!entityExists(rt, target) || isKnockedOut(rt, target)) return 0;
  let v = amount;
  if (source && entityExists(rt, source)) v = modify(rt, source, 'healingGiven', v, { source, target });
  v = modify(rt, target, 'healingReceived', v, { source, target });
  const before = hp(rt, target);
  const after = Math.min(maxHp(rt, target), before + Math.max(0, Math.round(v)));
  setHp(rt, target, after);
  const healed = after - before;
  const text = source ? `${entityName(rt, source)} heals ${entityName(rt, target)} for ${healed}` : `${entityName(rt, target)} heals ${healed}`;
  rt.emit('core:healed', text, { source, target, amount: healed });
  react(rt, { type: 'healed', source, target, amount: healed }, pair(source, target));
  return healed;
}

export function knockOut(rt: Runtime, target: EntityRef, duration: number | undefined, source: EntityRef | null): void {
  if (!entityExists(rt, target) || isKnockedOut(rt, target)) return;
  if (target.kind === 'character') {
    const ch = rt.game.characters[target.id]!;
    ch.knockedOutUntil = rt.now + (duration ?? rt.settings.knockoutDuration);
    ch.hp = 0;
  } else {
    const m = currentFight(rt)!.monsters.find((x) => x.id === target.id)!;
    m.knockedOut = true;
    m.hp = 0;
  }
  rt.emit('core:knocked-out', `${entityName(rt, target)} is knocked out`, { entity: target, source });
  react(rt, { type: 'knockedOut', entity: target, source }, source ? [{ ref: target, role: 'target' }, { ref: source, role: 'source' }] : [{ ref: target, role: 'target' }]);
}

/** A character's knockout timer ran out. */
export function endKnockout(rt: Runtime, id: string): void {
  const ch = rt.game.characters[id]!;
  ch.knockedOutUntil = null;
  ch.hp = Math.max(1, Math.round((maxHp(rt, charRef(id)) * rt.settings.knockoutReturnHp) / 100));
  rt.emit('core:knockout-ended', `${ch.name} is back on their feet`, { character: id, hp: ch.hp });
  markActive(rt, id);
}

export function revive(rt: Runtime, target: EntityRef, hpValue: number, source: EntityRef | null): void {
  if (!entityExists(rt, target) || !isKnockedOut(rt, target)) return;
  const value = Math.min(maxHp(rt, target), Math.max(1, Math.round(hpValue)));
  if (target.kind === 'character') rt.game.characters[target.id]!.knockedOutUntil = null;
  else currentFight(rt)!.monsters.find((m) => m.id === target.id)!.knockedOut = false;
  setHp(rt, target, value);
  rt.emit('core:revived', `${entityName(rt, target)} is revived`, { entity: target, source, hp: value });
  react(rt, { type: 'revived', entity: target, source }, source ? [{ ref: target, role: 'target' }, { ref: source, role: 'source' }] : [{ ref: target, role: 'target' }]);
  if (target.kind === 'character') markActive(rt, target.id);
}

export function applyStatus(rt: Runtime, target: EntityRef, statusId: string, duration: number | null, params: unknown, source: EntityRef | null): void {
  if (statusId === CORE_KO) { knockOut(rt, target, duration ?? undefined, source); return; }
  const reg = rt.reg.statuses.get(statusId);
  if (!reg) throw new Error(`Unknown status '${statusId}'`);
  if (!entityExists(rt, target)) return;
  const list = statusList(rt, target);
  const stacking = reg.def.stacking ?? 'refresh';
  const existing = list.filter((s) => s.status === statusId);
  if (stacking === 'keep' && existing.length) return;
  if (stacking === 'refresh') for (const s of existing) list.splice(list.indexOf(s), 1);
  const every = reg.def.tick ? parseDuration(reg.def.tick.every) : null;
  list.push({
    status: statusId, until: duration === null ? null : rt.now + duration, params: params ?? {}, source,
    appliedAt: rt.now, nextTick: every ? rt.now + every : null, seq: rt.game.seq++,
  });
  rt.emit('core:status-applied', `${entityName(rt, target)} is ${reg.def.name}`, { holder: target, status: statusId, until: duration === null ? null : rt.now + duration });
  react(rt, { type: 'statusApplied', holder: target, status: statusId }, [{ ref: target, role: 'target' }]);
}

/** Removes every instance of a status (or one instance, by seq). */
export function removeStatus(rt: Runtime, target: EntityRef, statusId: string, reason: 'expired' | 'removed', seq?: number): void {
  if (!entityExists(rt, target)) return;
  const list = statusList(rt, target);
  const gone = list.filter((s) => s.status === statusId && (seq === undefined || s.seq === seq));
  if (!gone.length) return;
  for (const s of gone) list.splice(list.indexOf(s), 1);
  const name = rt.reg.statuses.get(statusId)?.def.name ?? statusId;
  rt.emit('core:status-ended', `${entityName(rt, target)} is no longer ${name}`, { holder: target, status: statusId, reason });
  react(rt, { type: 'statusEnded', holder: target, status: statusId, reason }, [{ ref: target, role: 'target' }]);
}

export function runSteps(rt: Runtime, steps: Step[], source: EntityRef | null, targets: EntityRef[]): void {
  for (const step of steps) {
    const eff = rt.reg.effects.get(step.effect);
    if (!eff) continue;
    for (const target of targets) {
      if (!entityExists(rt, target)) continue;
      callPlugin(eff.pack, eff.id, () => eff.def.apply(makeCtx(rt, eff.pack), { source, target, params: step.params }));
    }
  }
}

/** Returns false when there was nothing to target (only possible when command is false). */
export function useAbility(
  rt: Runtime, user: EntityRef, abilityId: string, chosen: EntityRef | null, hints: Record<string, unknown>, command: boolean,
): boolean {
  const ab = rt.reg.abilities.get(abilityId);
  if (!ab) throw new Rejection("That ability isn't available", 'no-ability');
  const rule = rt.reg.targeting.get(ab.target.rule);
  if (!rule) throw new Rejection("That ability isn't available", 'no-ability');
  const tctx = makeCtx(rt, rule.pack);
  if (chosen) {
    const candidates = callPlugin(rule.pack, `${rule.id} candidates`, () => rule.def.candidates(tctx, { user, params: ab.target.params }));
    if (!candidates.some((c) => sameRef(c, chosen))) throw new Rejection("That target isn't valid", 'invalid-target');
  } else if (rule.def.needsChoice) {
    throw new Rejection('Pick a target', 'target-required');
  }
  const targets = callPlugin(rule.pack, `${rule.id} select`, () =>
    rule.def.select(tctx, { user, ability: abilityId, params: ab.target.params, chosen, hints }));
  if (targets.length === 0) {
    if (command) throw new Rejection('No valid target', 'no-target');
    return false;
  }
  if (user.kind === 'character') {
    const cd = modify(rt, user, 'cooldown', ab.cooldown, { ability: abilityId });
    rt.game.characters[user.id]!.cooldowns[abilityId] = rt.now + Math.max(0, Math.round(cd));
  }
  rt.emit('core:ability-used', `${entityName(rt, user)} uses ${ab.name}`, { user, ability: abilityId, targets });
  runSteps(rt, ab.steps, user, targets);
  react(rt, { type: 'abilityUsed', user, ability: abilityId, targets }, [
    { ref: user, role: 'source' }, ...targets.map((t) => ({ ref: t, role: 'target' as const })),
  ]);
  markActed(rt, user);
  return true;
}

export function addXp(rt: Runtime, ch: Character, n: number): void {
  ch.xp += n;
  while (ch.xp >= xpToReach(rt, ch.level + 1)) {
    ch.level++;
    rt.emit('core:level-up', `${ch.name} reached level ${ch.level}`, { character: ch.id, level: ch.level });
  }
}

export function addGold(_rt: Runtime, ch: Character, n: number): void {
  ch.gold += n;
}

export function giveRewards(rt: Runtime, character: EntityRef, r: { xp?: number; gold?: number; items?: string[] }): void {
  const ch = rt.requireChar(character.id);
  const base = {
    xp: Math.round((r.xp ?? 0) * rt.settings.xpMultiplier),
    gold: Math.round((r.gold ?? 0) * rt.settings.goldMultiplier),
  };
  const got = modify(rt, character, 'rewardsReceived', base, {});
  const xp = Math.max(0, Math.round(got.xp));
  const gold = Math.max(0, Math.round(got.gold));
  ch.gold += gold;
  rt.emit('core:rewarded', `${ch.name} gets ${xp} XP and ${gold} gold`, { character: ch.id, xp, gold });
  addXp(rt, ch, xp);
  for (const item of r.items ?? []) giveItem(rt, character, item, 1);
}

export function spendGold(rt: Runtime, character: EntityRef, n: number): void {
  const ch = rt.requireChar(character.id);
  if (ch.gold < n) throw new Rejection('Not enough gold', 'not-enough-gold');
  ch.gold -= n;
  rt.emit('core:gold-spent', `${ch.name} spends ${n} gold`, { character: ch.id, amount: n });
}

export function giveItem(rt: Runtime, character: EntityRef, item: string, count: number): void {
  const def = rt.reg.items.get(item);
  if (!def) throw new Error(`Unknown item '${item}'`);
  const ch = rt.requireChar(character.id);
  ch.inventory[item] = (ch.inventory[item] ?? 0) + count;
  rt.emit('core:item-given', `${ch.name} gets ${count > 1 ? `${count}× ` : ''}${def.name}`, { character: ch.id, item, count });
}

export function setStore(rt: Runtime, pack: string, e: EntityRef, data: unknown): void {
  storesOf(rt, e)[pack] = structuredClone(data);
  rt.emit('core:store-changed', `${pack} data changed for ${entityName(rt, e)}`, { entity: e, pack });
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm vitest run packages/engine/test/ops.test.ts packages/engine/test/entities.test.ts`
Expected: PASS.

If `createEngine` complains in `ops.test.ts` about `newGame` missing: the fixture doesn't call it; only `harness()` does (Task 3).

- [ ] **Step 8: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): hooks, plugin ctx and operations"
```

---

### Task 3: Commands, the engine API, sessions and joining

**Files:**
- Create: `packages/engine/src/commands.ts`, `session.ts`, `settle.ts`, `encounters.ts` (start/finish only), `time.ts` (`advanceTo` only, extended in Task 5)
- Modify: `packages/engine/src/engine.ts`, `packages/engine/src/index.ts`
- Test: `packages/engine/test/session.test.ts`

**Interfaces:**
- Produces:
  - `commands.ts`: the `Command` union (complete, below) and `runCommand(rt: Runtime, cmd: Command): void`
  - `session.ts`: `openSession(rt)`, `closeSession(rt)`, `join(rt, id, name, pick?)`, `leave(rt, id)`, `removePlayer(rt, id)`, `banPlayer(rt, id)`, `unbanPlayer(rt, id)`
  - `settle.ts`: `settle(rt): void`
  - `encounters.ts`: `startEncounter(rt, spec: EncounterSpec, origin: Origin | null): void`, `finishEncounter(rt, outcome: string): void`, `requireResting(rt): SessionState`
  - `time.ts`: `advanceTo(rt, target: number): void`
  - `engine.ts`: `Engine` gains `newGame(opts: { seed: number }): GameState`, `apply(game, cmd, now): ApplyResult`, `advance(game, now): { game: GameState; events: GameEvent[] }`
  - `type ApplyResult = { ok: true; game: GameState; events: GameEvent[] } | { ok: false; error: { code: string; message: string } }`
- Error codes introduced: `no-session`, `session-open`, `banned`, `in-party`, `party-full`, `mid-fight`, `removed`, `pick-required`, `bad-pick`, `not-in-party`, `unknown-character`, `busy`, `plugin-error`.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/session.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('sessions', () => {
  it('opens and closes, and refuses double opens', () => {
    const h = harness();
    expect(h.fail({ type: 'closeSession' }).code).toBe('no-session');
    h.open();
    expect(h.fail({ type: 'openSession' }).code).toBe('session-open');
    h.join('al');
    h.do({ type: 'closeSession' });
    expect(h.game.session).toBeNull();
    expect(h.types()).toEqual(['core:session-opened', 'core:joined', 'core:session-closed']);
  });

  it('closing during a fight ends it as ended with no rewards', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    h.use('al', 'tp:whack');
    h.do({ type: 'closeSession' });
    expect(h.log.find((e) => e.type === 'core:encounter-ended')?.data).toMatchObject({ outcome: 'ended' });
    expect(h.char('al').xp).toBe(0);
  });
});

describe('joining', () => {
  it('needs an open session', () => {
    const h = harness();
    expect(h.fail({ type: 'join', character: 'al', name: 'Al', pick: 'tp:club' }).code).toBe('no-session');
    expect(h.game.characters).toEqual({});
  });

  it('creates a character at full HP with the picked class item', () => {
    const h = harness();
    h.open();
    expect(h.fail({ type: 'join', character: 'al', name: 'Al' })).toEqual({ code: 'pick-required', message: 'Pick your class item: tp:club, tp:rod' });
    expect(h.fail({ type: 'join', character: 'al', name: 'Al', pick: 'tp:vest' }).code).toBe('bad-pick');
    h.join('al', 'tp:rod');
    expect(h.char('al')).toMatchObject({ name: 'Al', hp: 90, equipped: { 'tp:hand': 'tp:rod' } });
    expect(h.game.session!.party).toEqual(['al']);
    expect(h.fail({ type: 'join', character: 'al', name: 'Al' }).code).toBe('in-party');
  });

  it('a returning character joins with their item, no pick needed', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'leave', character: 'al' });
    h.do({ type: 'join', character: 'al', name: 'Al' });
    expect(h.game.session!.party).toEqual(['al']);
  });

  it('respects the party cap', () => {
    const h = harness({ settings: { 'party-cap': 1 } });
    h.open(); h.join('al');
    expect(h.fail({ type: 'join', character: 'bo', name: 'Bo', pick: 'tp:club' }).code).toBe('party-full');
  });

  it('follows the join table for normal, removed and banned characters', () => {
    // During a fight, allowJoinMidFight on (default)
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    h.join('bo');
    expect(h.game.session!.party).toEqual(['al', 'bo']);
    // Removed by streamer during a fight: must wait (waits-for-rest on)
    h.do({ type: 'removePlayer', character: 'bo' });
    expect(h.fail({ type: 'join', character: 'bo', name: 'Bo' }).code).toBe('removed');
    // Banned: never
    h.do({ type: 'banPlayer', character: 'al' });
    expect(h.game.session!.party).toEqual([]);
    expect(h.fail({ type: 'join', character: 'al', name: 'Al' }).code).toBe('banned');
    h.do({ type: 'endEncounter', outcome: 'ended' });
    // Resting: removed flag cleared, can rejoin
    h.do({ type: 'join', character: 'bo', name: 'Bo' });
    h.do({ type: 'unbanPlayer', character: 'al' });
    h.do({ type: 'join', character: 'al', name: 'Al' });
  });

  it('allowJoinMidFight off blocks joining fights', () => {
    const h = harness({ settings: { 'allow-join-mid-fight': false } });
    h.open(); h.join('al'); h.spawn();
    expect(h.fail({ type: 'join', character: 'bo', name: 'Bo', pick: 'tp:club' }).code).toBe('mid-fight');
  });

  it('removed players may rejoin a fight when waits-for-rest is off', () => {
    const h = harness({ settings: { 'streamer-removal-waits-for-rest': false } });
    h.open(); h.join('al'); h.spawn();
    h.do({ type: 'removePlayer', character: 'al' });
    h.do({ type: 'join', character: 'al', name: 'Al' });
  });

  it('removed players wait during non-fight encounters too', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'startEncounter', encounter: 'tp:chat' });
    h.do({ type: 'removePlayer', character: 'al' });
    expect(h.fail({ type: 'join', character: 'al', name: 'Al' }).code).toBe('removed');
  });
});

describe('the API', () => {
  it('never mutates the caller and rejects unknown characters', () => {
    const h = harness();
    h.open();
    const before = structuredClone(h.game);
    const r = h.engine.apply(h.game, { type: 'use', character: 'ghost', ability: 'tp:whack' }, 0);
    expect(r).toEqual({ ok: false, error: { code: 'unknown-character', message: 'Unknown character' } });
    expect(h.game).toEqual(before);
    expect(h.fail({ type: 'healPlayer', character: 'ghost', amount: 'full' }).code).toBe('unknown-character');
  });

  it('clock never goes backwards', () => {
    const h = harness();
    h.at(5000).open();
    expect(h.game.clock).toBe(5000);
    h.at(1000).join('al');
    expect(h.game.clock).toBe(5000);
    expect(h.log.at(-1)!.at).toBe(5000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/engine/test/session.test.ts`
Expected: FAIL (`newGame` and `apply` missing).

- [ ] **Step 3: Implement `commands.ts`**

`packages/engine/src/commands.ts`:
```ts
import { go, skipTo, startAdventure, stopAdventure } from './adventure';
import { endEncounterCommand, respond, startEncounterCommand } from './encounters';
import { holdMonster, monsterActNow, releaseMonster, setMonsterHp, spawnMonster } from './fight';
import { equip, unequip } from './gear';
import type { EntityRef } from './pack';
import type { Runtime } from './runtime';
import { banPlayer, closeSession, join, leave, openSession, removePlayer, unbanPlayer } from './session';
import {
  applyStatusCommand, giveGoldCommand, giveItemCommand, giveXpCommand, healParty, healPlayer, knockOutCommand,
  postMessage, removeStatusCommand, reviveAll, revivePlayer,
} from './streamer';
import { useCommand } from './use';

export type Command =
  // viewer commands
  | { type: 'join'; character: string; name?: string; pick?: string }
  | { type: 'leave'; character: string }
  | { type: 'use'; character: string; ability: string; chosen?: EntityRef | null }
  | { type: 'equip'; character: string; item: string }
  | { type: 'unequip'; character: string; slot: string }
  | { type: 'respond'; character: string; input: unknown }
  // streamer: session
  | { type: 'openSession' }
  | { type: 'closeSession' }
  | { type: 'removePlayer'; character: string }
  | { type: 'banPlayer'; character: string }
  | { type: 'unbanPlayer'; character: string }
  // streamer: encounters
  | { type: 'spawnMonster'; monster: string }
  | { type: 'startEncounter'; encounter: string | Record<string, unknown> }
  | { type: 'endEncounter'; outcome?: string }
  // streamer: adventures
  | { type: 'startAdventure'; adventure: string }
  | { type: 'go' }
  | { type: 'skipTo'; node: string }
  | { type: 'stopAdventure' }
  // streamer: healing
  | { type: 'healPlayer'; character: string; amount: number | 'full' }
  | { type: 'healParty' }
  | { type: 'revivePlayer'; character: string }
  | { type: 'reviveAll' }
  // streamer: statuses
  | { type: 'applyStatus'; target: EntityRef; status: string; duration?: string | number | null; params?: unknown }
  | { type: 'removeStatus'; target: EntityRef; status: string }
  | { type: 'knockOut'; character: string }
  // streamer: monster
  | { type: 'monsterActNow' }
  | { type: 'holdMonster' }
  | { type: 'releaseMonster' }
  | { type: 'setMonsterHp'; value: number }
  // streamer: rewards and feed
  | { type: 'giveXp'; target: string; amount: number }
  | { type: 'giveGold'; target: string; amount: number }
  | { type: 'giveItem'; target: string; item: string }
  | { type: 'postMessage'; text: string };

export const VIEWER_COMMANDS = ['join', 'leave', 'use', 'equip', 'unequip', 'respond'] as const;

export function runCommand(rt: Runtime, cmd: Command): void {
  switch (cmd.type) {
    case 'join': return join(rt, cmd.character, cmd.name, cmd.pick);
    case 'leave': return leave(rt, cmd.character);
    case 'use': return useCommand(rt, cmd.character, cmd.ability, cmd.chosen ?? null);
    case 'equip': return equip(rt, cmd.character, cmd.item);
    case 'unequip': return unequip(rt, cmd.character, cmd.slot);
    case 'respond': return respond(rt, cmd.character, cmd.input);
    case 'openSession': return openSession(rt);
    case 'closeSession': return closeSession(rt);
    case 'removePlayer': return removePlayer(rt, cmd.character);
    case 'banPlayer': return banPlayer(rt, cmd.character);
    case 'unbanPlayer': return unbanPlayer(rt, cmd.character);
    case 'spawnMonster': return spawnMonster(rt, cmd.monster);
    case 'startEncounter': return startEncounterCommand(rt, cmd.encounter);
    case 'endEncounter': return endEncounterCommand(rt, cmd.outcome);
    case 'startAdventure': return startAdventure(rt, cmd.adventure);
    case 'go': return go(rt);
    case 'skipTo': return skipTo(rt, cmd.node);
    case 'stopAdventure': return stopAdventure(rt);
    case 'healPlayer': return healPlayer(rt, cmd.character, cmd.amount);
    case 'healParty': return healParty(rt);
    case 'revivePlayer': return revivePlayer(rt, cmd.character);
    case 'reviveAll': return reviveAll(rt);
    case 'applyStatus': return applyStatusCommand(rt, cmd.target, cmd.status, cmd.duration ?? null, cmd.params);
    case 'removeStatus': return removeStatusCommand(rt, cmd.target, cmd.status);
    case 'knockOut': return knockOutCommand(rt, cmd.character);
    case 'monsterActNow': return monsterActNow(rt);
    case 'holdMonster': return holdMonster(rt);
    case 'releaseMonster': return releaseMonster(rt);
    case 'setMonsterHp': return setMonsterHp(rt, cmd.value);
    case 'giveXp': return giveXpCommand(rt, cmd.target, cmd.amount);
    case 'giveGold': return giveGoldCommand(rt, cmd.target, cmd.amount);
    case 'giveItem': return giveItemCommand(rt, cmd.target, cmd.item);
    case 'postMessage': return postMessage(rt, cmd.text);
  }
}
```

`runCommand` imports modules that Tasks 4–7 complete. To keep everything compiling now, create these files with the functions this task needs fully implemented and the rest throwing `new Rejection('Not implemented yet', 'not-implemented')`. Each later task replaces its stubs. The stub list:
- `adventure.ts`: `startAdventure`, `go`, `skipTo`, `stopAdventure` (Task 6)
- `gear.ts`: `equip`, `unequip`, `capHp` (Task 4: `capHp(rt, ch)` is a no-op stub until then)
- `use.ts`: `useCommand` (Task 4)
- `streamer.ts`: all eleven functions (Task 7)
- `fight.ts`: `spawnMonster`, `holdMonster`, `releaseMonster`, `monsterActNow`, `setMonsterHp`, `startFight`, `endFight`, `refreshFight`, `monsterTurn`, `fightInterval` (Task 4)
- `encounters.ts`: `respond`, `kindWake` (Task 6). `startEncounterCommand` and `endEncounterCommand` are implemented now (below) because the session tests use them.

Because `useCommand`, `spawnMonster` and `endFight` are used by this task's tests, implement **Task 4 Steps 3–5 before running this task's tests** if you're executing in order and the session tests involving fights fail with `not-implemented`. Alternatively run only the tests that don't touch fights first:
`pnpm vitest run packages/engine/test/session.test.ts -t "opens and closes|needs an open|creates a character|returning|party cap|never mutates|clock"`.

- [ ] **Step 4: Implement `session.ts`**

`packages/engine/src/session.ts`:
```ts
import { charRef, effectiveEquipped, maxHp, ownedItems } from './entities';
import { Rejection } from './errors';
import { markActive } from './fight';
import { finishEncounter } from './encounters';
import type { Runtime } from './runtime';
import { settle } from './settle';
import { isFight, newCharacter, type SessionState } from './state';

export function requireSession(rt: Runtime): SessionState {
  const s = rt.game.session;
  if (!s) throw new Rejection('No session is open', 'no-session');
  return s;
}

function clearRemovals(rt: Runtime): void {
  if (!rt.settings.streamerRemovalWaitsForRest) return;
  for (const ch of Object.values(rt.game.characters)) ch.removedByStreamer = false;
}

export function openSession(rt: Runtime): void {
  if (rt.game.session) throw new Rejection('A session is already open', 'session-open');
  rt.game.session = { party: [], encounter: null, adventure: null };
  clearRemovals(rt);
  rt.emit('core:session-opened', 'A new session begins', {});
}

export function closeSession(rt: Runtime): void {
  const s = requireSession(rt);
  if (s.adventure) {
    s.adventure = null;
    rt.emit('core:adventure-stopped', 'The adventure stops', {});
  }
  if (s.encounter) finishEncounter(rt, 'ended');
  settle(rt);
  rt.game.session = null;
  rt.emit('core:session-closed', 'The session is over', {});
}

export function join(rt: Runtime, id: string, name: string | undefined, pick: string | undefined): void {
  const s = requireSession(rt);
  let ch = rt.game.characters[id];
  const created = !ch;
  if (!ch) {
    ch = newCharacter(id, name ?? id);
    rt.game.characters[id] = ch;
  } else if (name) {
    ch.name = name;
  }
  if (ch.banned) throw new Rejection("You're banned from this game", 'banned');
  if (s.party.includes(id)) throw new Rejection("You're already in the party", 'in-party');
  if (rt.settings.partyCap !== null && s.party.length >= rt.settings.partyCap) throw new Rejection('The party is full', 'party-full');

  const enc = s.encounter;
  const inFight = !!enc && isFight(enc);
  const inOther = !!enc && !inFight;
  if (ch.removedByStreamer && enc) {
    const waits = rt.settings.streamerRemovalWaitsForRest;
    const ok = (inOther && !waits) || (inFight && rt.settings.allowJoinMidFight && !waits);
    if (!ok) throw new Rejection('You were removed by the streamer. You can rejoin when the party rests', 'removed');
  } else if (inFight && !rt.settings.allowJoinMidFight) {
    throw new Rejection("You can't join in the middle of a fight", 'mid-fight');
  }

  const slot = rt.settings.classSlot;
  if (slot && !effectiveEquipped(rt, ch).some(([sl]) => sl === slot)) {
    const options = ownedItems(rt, ch).filter((i) => i.slot === slot);
    if (options.length) {
      if (!pick) throw new Rejection(`Pick your class item: ${options.map((o) => o.id).join(', ')}`, 'pick-required');
      if (!options.some((o) => o.id === pick)) throw new Rejection("You can't pick that", 'bad-pick');
      ch.equipped[slot] = pick;
    }
  }
  if (created) ch.hp = maxHp(rt, charRef(id));
  ch.removedByStreamer = false;
  s.party.push(id);
  if (enc && isFight(enc)) {
    enc.joinedAt[id] = rt.now;
    markActive(rt, id);
  }
  rt.emit('core:joined', `${ch.name} joins the party`, { character: id });
}

function removeFromParty(rt: Runtime, id: string): boolean {
  const s = requireSession(rt);
  if (!s.party.includes(id)) return false;
  s.party = s.party.filter((x) => x !== id);
  return true;
}

export function leave(rt: Runtime, id: string): void {
  const ch = rt.requireChar(id);
  if (!removeFromParty(rt, id)) throw new Rejection('Not in the party', 'not-in-party');
  rt.emit('core:left', `${ch.name} leaves the party`, { character: id });
}

export function removePlayer(rt: Runtime, id: string): void {
  const ch = rt.requireChar(id);
  if (!removeFromParty(rt, id)) throw new Rejection('Not in the party', 'not-in-party');
  if (rt.game.session!.encounter) ch.removedByStreamer = true;
  rt.emit('core:removed', `${ch.name} was removed from the party`, { character: id });
}

export function banPlayer(rt: Runtime, id: string): void {
  const ch = rt.requireChar(id);
  ch.banned = true;
  if (rt.game.session) removeFromParty(rt, id);
  rt.emit('core:banned', `${ch.name} was banned from the game`, { character: id });
}

export function unbanPlayer(rt: Runtime, id: string): void {
  const ch = rt.requireChar(id);
  ch.banned = false;
  rt.emit('core:unbanned', `${ch.name} was unbanned`, { character: id });
}

export { clearRemovals };
```

- [ ] **Step 5: Implement `settle.ts`, `encounters.ts` (start/finish/end) and `time.ts` (`advanceTo`)**

`packages/engine/src/settle.ts`:
```ts
import { currentFight } from './entities';
import { finishEncounter } from './encounters';
import { refreshFight } from './fight';
import { drainReactions } from './hooks';
import type { Runtime } from './runtime';

/** Run queued reactions, end encounters that should end, and update the fight's sub-state, until nothing changes. */
export function settle(rt: Runtime): void {
  for (let i = 0; i < 100; i++) {
    drainReactions(rt);
    const enc = rt.game.session?.encounter ?? null;
    if (rt.pendingEnd !== null) {
      const outcome = rt.pendingEnd;
      rt.pendingEnd = null;
      if (enc) { finishEncounter(rt, outcome); continue; }
    }
    const f = currentFight(rt);
    if (f && f.monsters.every((m) => m.knockedOut)) { finishEncounter(rt, 'won'); continue; }
    if (f) refreshFight(rt, f);
    if (!rt.queue.length && rt.pendingEnd === null) return;
  }
  throw new Error('settle() did not converge');
}
```

`packages/engine/src/encounters.ts`:
```ts
import type { EncounterSpec } from './content';
import { makeCtx, resolveFor, runtimeNormalizeCtx } from './ctx';
import { charRef, currentFight, partyRefs } from './entities';
import { Rejection } from './errors';
import { endFight, startFight } from './fight';
import { callPlugin, react } from './hooks';
import { CHANNEL } from './ids';
import type { EntityRef } from './pack';
import { normalizeParams, p } from './params';
import { CORE_FIGHT } from './registry';
import type { Runtime } from './runtime';
import { clearRemovals } from './session';
import { isFight, type KindEncounterState, type Origin, type SessionState } from './state';

export function requireResting(rt: Runtime): SessionState {
  const s = rt.game.session;
  if (!s) throw new Rejection('No session is open', 'no-session');
  if (s.encounter) throw new Rejection('An encounter is already running', 'busy');
  return s;
}

function present(rt: Runtime): { ref: EntityRef; role: 'present' }[] {
  const monsters = (currentFight(rt)?.monsters ?? []).map((m) => ({ ref: { kind: 'monster' as const, id: m.id }, role: 'present' as const }));
  return [...partyRefs(rt).map((ref) => ({ ref, role: 'present' as const })), ...monsters];
}

export function startEncounter(rt: Runtime, spec: EncounterSpec, origin: Origin | null): void {
  const s = requireResting(rt);
  if (spec.kind === CORE_FIGHT) { startFight(rt, spec.params as string, origin); return; }
  const kind = rt.reg.kinds.get(spec.kind);
  if (!kind) throw new Rejection('Unknown encounter kind', 'unknown-content');
  const enc: KindEncounterState = { kind: spec.kind, startedAt: rt.now, origin, params: spec.params, state: null };
  s.encounter = enc;
  enc.state = callPlugin(kind.pack, `${kind.id} start`, () => kind.def.start(makeCtx(rt, kind.pack), spec.params));
  rt.emit('core:encounter-started', `${kind.def.name} begins`, { kind: spec.kind });
  react(rt, { type: 'encounterStarted', kind: spec.kind }, present(rt));
}

/** Command form: an encounter ID, or an inline `{ <kind>: params }`. */
export function startEncounterCommand(rt: Runtime, encounter: string | Record<string, unknown>): void {
  if (typeof encounter === 'string') {
    const def = rt.reg.encounters.get(encounter);
    if (!def) throw new Rejection(`Unknown encounter '${encounter}'`, 'unknown-content');
    return startEncounter(rt, def.spec, null);
  }
  const entries = Object.entries(encounter);
  if (entries.length !== 1) throw new Rejection('Give exactly one encounter kind', 'invalid-input');
  const [key, raw] = entries[0]!;
  const kindId = resolveFor(rt, CHANNEL, 'encounterKind', key);
  const kind = rt.reg.kinds.get(kindId);
  if (!kind) throw new Rejection(`Unknown encounter kind '${key}'`, 'unknown-content');
  const nctx = runtimeNormalizeCtx(rt, CHANNEL);
  const params = normalizeParams(kind.def.params ?? p.object({}), raw ?? {}, nctx, key);
  if (nctx.issues.length) throw new Rejection(nctx.issues[0]!, 'invalid-input');
  if (!kind.builtin && kind.def.validate) {
    const problems = callPlugin(kind.pack, `${kind.id} validate`, () => kind.def.validate!(params));
    if (problems.length) throw new Rejection(problems[0]!, 'invalid-input');
  }
  return startEncounter(rt, { kind: kindId, params }, null);
}

function allowedOutcomes(rt: Runtime): string[] {
  const enc = rt.game.session!.encounter!;
  if (isFight(enc)) return ['won', 'ended'];
  const kind = rt.reg.kinds.get(enc.kind)!;
  return [...callPlugin(kind.pack, `${kind.id} outcomes`, () => kind.def.outcomes(enc.params)), 'ended'];
}

export function endEncounterCommand(rt: Runtime, outcome: string | undefined): void {
  const enc = rt.game.session?.encounter;
  if (!enc) throw new Rejection('No encounter is running', 'no-encounter');
  let o = outcome;
  if (o !== undefined) {
    if (!allowedOutcomes(rt).includes(o)) throw new Rejection(`That encounter can't end with '${o}'`, 'bad-outcome');
  } else if (isFight(enc)) {
    o = 'ended';
  } else {
    const kind = rt.reg.kinds.get(enc.kind)!;
    o = callPlugin(kind.pack, `${kind.id} endEarly`, () => kind.def.endEarly(enc.state, enc.params));
  }
  finishEncounter(rt, o);
}

export function finishEncounter(rt: Runtime, outcome: string): void {
  const s = rt.game.session!;
  const enc = s.encounter!;
  if (!allowedOutcomes(rt).includes(outcome)) {
    throw new Error(`Encounter ${enc.kind} can't end with '${outcome}'`);
  }
  if (isFight(enc)) endFight(rt, enc, outcome);
  else {
    const kind = rt.reg.kinds.get(enc.kind)!;
    if (kind.def.onEnd) callPlugin(kind.pack, `${kind.id} onEnd`, () => kind.def.onEnd!(makeCtx(rt, kind.pack), enc.state, outcome, enc.params));
  }
  const who = present(rt);
  s.encounter = null;
  rt.emit('core:encounter-ended', `The encounter ends (${outcome})`, { kind: enc.kind, outcome });
  react(rt, { type: 'encounterEnded', kind: enc.kind, outcome }, who);
  clearRemovals(rt);
  if (enc.origin && s.adventure && s.adventure.id === enc.origin.adventure) {
    const adv = rt.reg.adventures.get(enc.origin.adventure);
    const next = adv?.nodes[enc.origin.node]?.next ?? null;
    const target = typeof next === 'string' ? next : next ? next[outcome] ?? next.default ?? null : null;
    if (!target) {
      s.adventure = null;
      rt.emit('core:adventure-finished', `${adv?.name ?? 'The adventure'} is complete`, { adventure: enc.origin.adventure });
    } else {
      s.adventure.lined = target;
      rt.emit('core:adventure-lined-up', `Next up: ${target}`, { adventure: enc.origin.adventure, node: target });
    }
  }
}

/** Filled in by Task 6. */
export function respond(_rt: Runtime, _id: string, _input: unknown): void {
  throw new Rejection('Not implemented yet', 'not-implemented');
}

/** Filled in by Task 5. */
export function kindWake(_rt: Runtime): void {
  throw new Rejection('Not implemented yet', 'not-implemented');
}
```

Never add top-level statements that touch imported `const` bindings (such as `charRef`) in engine modules: the modules import each other in a cycle, and a top-level read can hit the temporal dead zone. Only use imports inside functions. (`charRef` is imported here for `respond`, which Task 6 fills in.)

`packages/engine/src/time.ts` (first version; Task 5 replaces it with the full version):
```ts
import type { Runtime } from './runtime';

/** Task 5 processes due timers here. For now time only moves forward. */
export function advanceTo(rt: Runtime, target: number): void {
  rt.now = Math.max(rt.now, target);
}
```

- [ ] **Step 6: Extend `engine.ts` and `index.ts`**

`packages/engine/src/engine.ts`:
```ts
import { type Command, runCommand } from './commands';
import { type Description, describe } from './describe';
import { EngineError, type Issue, PluginError, Rejection } from './errors';
import type { GameEvent } from './events';
import type { PackBundle } from './pack';
import { buildRegistry, type Registry } from './registry';
import { Runtime } from './runtime';
import { settle } from './settle';
import { type GameState, newGameState } from './state';
import { advanceTo } from './time';

export type ApplyResult =
  | { ok: true; game: GameState; events: GameEvent[] }
  | { ok: false; error: { code: string; message: string } };

export interface Engine {
  registry: Registry;
  warnings: Issue[];
  describe(): Description;
  newGame(opts: { seed: number }): GameState;
  apply(game: GameState, cmd: Command, now: number): ApplyResult;
  advance(game: GameState, now: number): { game: GameState; events: GameEvent[] };
}

export function toError(e: unknown): { code: string; message: string } | null {
  if (e instanceof Rejection) return { code: e.code, message: e.message };
  if (e instanceof EngineError) return { code: e.code, message: e.message };
  if (e instanceof PluginError) return { code: 'plugin-error', message: e.message };
  return null;
}

export function createEngine(opts: { packs: PackBundle[]; channel: unknown }): Engine {
  const registry = buildRegistry(opts.packs, opts.channel);
  return {
    registry,
    warnings: registry.warnings,
    describe: () => describe(registry),
    newGame: ({ seed }) => newGameState(seed),
    apply(game, cmd, now) {
      const rt = new Runtime(registry, structuredClone(game));
      const t = Math.max(now, game.clock);
      try {
        advanceTo(rt, t);
        rt.depth = 0;
        rt.limitHit = false;
        runCommand(rt, cmd);
        settle(rt);
        rt.game.clock = t;
        return { ok: true, game: rt.game, events: rt.events };
      } catch (e) {
        const error = toError(e);
        if (error) return { ok: false, error };
        throw e;
      }
    },
    advance(game, now) {
      const rt = new Runtime(registry, structuredClone(game));
      advanceTo(rt, Math.max(now, game.clock));
      rt.game.clock = rt.now;
      return { game: rt.game, events: rt.events };
    },
  };
}
```

`packages/engine/src/index.ts` (add):
```ts
export type { Command } from './commands';
export type { ApplyResult } from './engine';
export type { GameEvent } from './events';
export type { GameState, Character, FightState, KindEncounterState, MonsterState, SessionState, StatusInstance } from './state';
```

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm vitest run packages/engine/test/session.test.ts -t "opens and closes|needs an open|creates a character|returning|party cap|never mutates|clock" && pnpm typecheck`
Expected: those tests PASS; typecheck clean. The remaining session tests use fights and pass after Task 4.

- [ ] **Step 8: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): commands, apply/advance, sessions and joining"
```

---

### Task 4: Fights, abilities and gear

**Files:**
- Modify: `packages/engine/src/fight.ts` (complete it), `packages/engine/src/use.ts`, `packages/engine/src/gear.ts` (replace stubs)
- Test: `packages/engine/test/fight.test.ts`, `packages/engine/test/gear.test.ts`; the rest of `session.test.ts` now passes

**Interfaces:**
- Produces:
  - `fight.ts`: `fightInterval(rt, f): number`, `startFight(rt, monsterId, origin)`, `spawnMonster(rt, monsterId)`, `refreshFight(rt, f)`, `monsterTurn(rt, f)`, `monsterAct(rt, f)`, `holdMonster(rt)`, `releaseMonster(rt)`, `monsterActNow(rt)`, `setMonsterHp(rt, value)`, `endFight(rt, f, outcome)` plus the existing `markActed`, `markActive`
  - `use.ts`: `useCommand(rt, characterId, abilityId, chosen)`
  - `gear.ts`: `capHp(rt, ch)`, `gearLocked(rt, id)`, `equip(rt, id, item)`, `unequip(rt, id, slot)`
- Error codes introduced: `not-a-fight`, `no-one`, `already-held`, `not-held`, `knocked-out`, `no-ability`, `fight-only`, `on-cooldown`, `cannot-use`, `gear-locked`, `not-owned`, `not-gear`, `class-slot`, `empty-slot`, `unknown-content`.

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/fight.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('starting a fight', () => {
  it('copies the monster and schedules its first turn', () => {
    const h = harness();
    h.open(); h.join('al');
    expect(h.fail({ type: 'spawnMonster', monster: 'tp:nobody' }).code).toBe('unknown-content');
    h.spawn();
    expect(h.fight()).toMatchObject({ sub: 'fighting', nextTurnAt: 15000, held: false, wasActive: ['al'] });
    expect(h.monster()).toMatchObject({ hp: 50, def: { name: 'Blob' } });
    expect(h.fail({ type: 'spawnMonster', monster: 'tp:blob' }).code).toBe('busy');
  });

  it('with an empty party it starts waiting', () => {
    const h = harness();
    h.open(); h.spawn();
    expect(h.fight()).toMatchObject({ sub: 'waiting', nextTurnAt: null });
    h.join('al');
    expect(h.fight()).toMatchObject({ sub: 'fighting', nextTurnAt: 15000 });
  });
});

describe('character abilities', () => {
  it('checks party, knockout, ownership, phase and cooldown', () => {
    const h = harness();
    h.open(); h.join('al');
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:whack' }).code).toBe('fight-only');
    h.spawn();
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:mend' }).code).toBe('no-ability');
    h.use('al', 'tp:whack');
    expect(h.monster().hp).toBe(40);
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:whack' })).toEqual({ code: 'on-cooldown', message: 'On cooldown (10s)' });
    h.at(4000);
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:whack' }).message).toBe('On cooldown (6s)');
    h.at(10000).use('al', 'tp:whack');
    h.do({ type: 'knockOut', character: 'al' });
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:zap' }).code).toBe('knocked-out');
    h.do({ type: 'leave', character: 'al' });
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:zap' }).code).toBe('not-in-party');
  });

  it('canUse modifiers can refuse', () => {
    const h = harness({ plugins: (api) => api.status('mute', { name: 'Mute', modify: { canUse: () => 'You are muted' } }) });
    h.open(); h.join('al'); h.spawn();
    h.do({ type: 'applyStatus', target: { kind: 'character', id: 'al' }, status: 'tp:mute' });
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:whack' })).toEqual({ code: 'cannot-use', message: 'You are muted' });
  });

  it('consumables spend uses, then the item', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'giveItem', target: 'al', item: 'tp:biscuit' });
    h.do({ type: 'healPlayer', character: 'al', amount: 0 });
    h.use('al', 'tp:snack');
    expect(h.char('al')).toMatchObject({ inventory: { 'tp:biscuit': 1 }, usesLeft: { 'tp:biscuit': 1 } });
    h.at(5000).use('al', 'tp:snack');
    expect(h.char('al').inventory).toEqual({});
    expect(h.char('al').usesLeft).toEqual({});
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:snack' }).code).toBe('no-ability');
  });
});

describe('monster turns and sub-states', () => {
  it('acts on its interval and hits ceil(active/5) members', () => {
    const h = harness();
    h.open();
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) h.join(id);
    h.spawn();
    h.wait(15000);
    const hit = Object.values(h.game.characters).filter((c) => c.hp === 94);
    expect(hit).toHaveLength(2);
    expect(h.fight().nextTurnAt).toBe(30000);
  });

  it('goes waiting on a wipe and fighting again, with a full interval by default', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    h.at(5000).do({ type: 'knockOut', character: 'al' });
    expect(h.fight()).toMatchObject({ sub: 'waiting', nextTurnAt: null, pausedTurnAt: 15000 });
    h.at(8000).do({ type: 'revivePlayer', character: 'al' });
    expect(h.fight()).toMatchObject({ sub: 'fighting', nextTurnAt: 23000 });
  });

  it('keeps the original schedule when fullIntervalAfterWaiting is off', () => {
    const h = harness({ settings: { 'full-interval-after-waiting': false } });
    h.open(); h.join('al'); h.spawn();
    h.at(5000).do({ type: 'knockOut', character: 'al' });
    h.at(8000).do({ type: 'revivePlayer', character: 'al' });
    expect(h.fight().nextTurnAt).toBe(15000);
  });

  it('hold stops the timer; act-now strikes once; release reschedules', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    h.at(5000).do({ type: 'holdMonster' });
    expect(h.fail({ type: 'holdMonster' }).code).toBe('already-held');
    h.wait(60000);
    expect(h.char('al').hp).toBe(100);
    h.do({ type: 'monsterActNow' });
    expect(h.char('al').hp).toBe(94);
    expect(h.fight()).toMatchObject({ held: true, nextTurnAt: null, heldRemaining: 10000 });
    h.do({ type: 'releaseMonster' });
    expect(h.fight().nextTurnAt).toBe(h.now + 15000);
    expect(h.fail({ type: 'releaseMonster' }).code).toBe('not-held');
  });

  it('release continues the remaining time when fullIntervalAfterRelease is off', () => {
    const h = harness({ settings: { 'full-interval-after-release': false } });
    h.open(); h.join('al'); h.spawn();
    h.at(5000).do({ type: 'holdMonster' });
    h.at(9000).do({ type: 'releaseMonster' });
    expect(h.fight().nextTurnAt).toBe(19000);
  });

  it('act-now while waiting is rejected', () => {
    const h = harness();
    h.open(); h.spawn();
    expect(h.fail({ type: 'monsterActNow' })).toEqual({ code: 'no-one', message: 'No one to act against' });
  });
});

describe('ending a fight', () => {
  const overrides = { 'tp:blob': { drops: [{ item: 'biscuit', chance: 1 }] } };

  it('pays eligible members, removes idle ones, keeps the knocked-out-whole-time', () => {
    const h = harness({ channel: { overrides } });
    h.open(); h.join('al'); h.join('bo'); h.join('cy');
    h.do({ type: 'knockOut', character: 'cy' });
    h.spawn();
    h.use('al', 'tp:zap');
    h.at(10000).use('al', 'tp:whack');
    h.at(20000).use('al', 'tp:whack');
    expect(h.game.session!.encounter).toBeNull();
    expect(h.char('al')).toMatchObject({ xp: 20, gold: 5, inventory: { 'tp:biscuit': 1 } });
    expect(h.char('bo').xp).toBe(0);
    expect(h.game.session!.party).toEqual(['al', 'cy']);
    expect(h.types()).toContain('core:removed-idle');
  });

  it('rewardsRequireAction off pays everyone; autoRemoveIdle off keeps everyone', () => {
    const h = harness({ settings: { 'rewards-require-action': false, 'auto-remove-idle': false }, channel: { overrides } });
    h.open(); h.join('al'); h.join('bo'); h.spawn();
    h.do({ type: 'setMonsterHp', value: 0 });
    expect(h.char('bo').xp).toBe(20);
    expect(h.game.session!.party).toEqual(['al', 'bo']);
  });

  it('knockedOutExemptFromIdle off removes knocked-out idlers', () => {
    const h = harness({ settings: { 'knocked-out-exempt-from-idle': false } });
    h.open(); h.join('al'); h.join('cy');
    h.do({ type: 'knockOut', character: 'cy' });
    h.spawn(); h.use('al', 'tp:zap');
    h.do({ type: 'endEncounter', outcome: 'won' });
    expect(h.game.session!.party).toEqual(['al']);
  });

  it('mid-fight joiners are judged from when they joined', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    h.at(5000).join('bo');
    h.use('bo', 'tp:whack');
    h.do({ type: 'endEncounter', outcome: 'won' });
    expect(h.game.session!.party).toEqual(['bo']);
  });

  it('healBetweenFights heals the party except knocked out members', () => {
    const h = harness({ settings: { 'heal-between-fights': true } });
    h.open(); h.join('al'); h.join('bo'); h.spawn();
    h.use('al', 'tp:whack'); h.use('bo', 'tp:whack');
    h.wait(15000);
    h.do({ type: 'knockOut', character: 'bo' });
    h.do({ type: 'endEncounter', outcome: 'won' });
    expect(h.char('al').hp).toBe(100);
    expect(h.char('bo').knockedOutUntil).not.toBeNull();
  });

  it('endEncounter with no outcome ends a fight as ended', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn(); h.use('al', 'tp:whack');
    h.do({ type: 'endEncounter' });
    expect(h.char('al').xp).toBe(0);
    expect(h.fail({ type: 'endEncounter' }).code).toBe('no-encounter');
  });
});
```

`packages/engine/test/gear.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('gear', () => {
  it('equips owned items, locks during fights, unlocks after', () => {
    const h = harness();
    h.open(); h.join('al');
    expect(h.fail({ type: 'equip', character: 'al', item: 'tp:vest' }).code).toBe('not-owned');
    h.do({ type: 'giveItem', target: 'al', item: 'tp:vest' });
    h.do({ type: 'equip', character: 'al', item: 'tp:vest' });
    expect(h.char('al').equipped['tp:body']).toBe('tp:vest');
    h.spawn();
    expect(h.fail({ type: 'equip', character: 'al', item: 'tp:rod' }).code).toBe('gear-locked');
    h.do({ type: 'endEncounter' });
    h.do({ type: 'equip', character: 'al', item: 'tp:rod' });
  });

  it('gearLockDuringCombat off allows swaps mid-fight; non-gear and class slot rules', () => {
    const h = harness({ settings: { 'gear-lock-during-combat': false } });
    h.open(); h.join('al'); h.spawn();
    h.do({ type: 'equip', character: 'al', item: 'tp:rod' });
    h.do({ type: 'giveItem', target: 'al', item: 'tp:biscuit' });
    expect(h.fail({ type: 'equip', character: 'al', item: 'tp:biscuit' }).code).toBe('not-gear');
    expect(h.fail({ type: 'unequip', character: 'al', slot: 'tp:hand' }).code).toBe('class-slot');
    expect(h.fail({ type: 'unequip', character: 'al', slot: 'tp:body' }).code).toBe('empty-slot');
  });

  it('a gear change that lowers max HP caps saved HP; a rise does not heal', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'giveItem', target: 'al', item: 'tp:vest' });
    h.do({ type: 'equip', character: 'al', item: 'tp:vest' });
    expect(h.char('al').hp).toBe(100);
    h.do({ type: 'healPlayer', character: 'al', amount: 'full' });
    expect(h.char('al').hp).toBe(120);
    h.do({ type: 'unequip', character: 'al', slot: 'tp:body' });
    expect(h.char('al').hp).toBe(100);
  });

  it('banned characters cannot change gear; characters outside a session can', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'giveItem', target: 'al', item: 'tp:vest' });
    h.do({ type: 'closeSession' });
    h.do({ type: 'equip', character: 'al', item: 'tp:vest' });
    h.do({ type: 'banPlayer', character: 'al' });
    expect(h.fail({ type: 'unequip', character: 'al', slot: 'tp:body' }).code).toBe('banned');
  });
});
```

These tests use `giveItem`, `healPlayer`, `knockOut`, `revivePlayer` and `applyStatus` (Task 7). Implement Task 7 Step 3 (`streamer.ts`) together with this task, or run these files after Task 7. The plan keeps them here because they test fight and gear behavior.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/engine/test/fight.test.ts packages/engine/test/gear.test.ts`
Expected: FAIL (`not-implemented`).

- [ ] **Step 3: Complete `fight.ts`**

`packages/engine/src/fight.ts` (full file):
```ts
import { makeCtx } from './ctx';
import { charRef, currentFight, entityName, isKnockedOut, maxHp, monsterRef } from './entities';
import { Rejection } from './errors';
import { callPlugin, react } from './hooks';
import { giveItem, giveRewards, knockOut } from './ops';
import type { EntityRef } from './pack';
import { CORE_FIGHT } from './registry';
import type { Runtime } from './runtime';
import type { FightState, MonsterState, Origin } from './state';
import { requireResting } from './encounters';

export function markActed(rt: Runtime, user: EntityRef): void {
  const f = currentFight(rt);
  if (!f || user.kind !== 'character' || !rt.game.session!.party.includes(user.id)) return;
  if (!f.acted.includes(user.id)) f.acted.push(user.id);
}

export function markActive(rt: Runtime, id: string): void {
  const f = currentFight(rt);
  if (!f || !rt.game.session!.party.includes(id) || isKnockedOut(rt, charRef(id))) return;
  if (!f.wasActive.includes(id)) f.wasActive.push(id);
}

export function fightInterval(rt: Runtime, f: FightState): number {
  return f.monsters[0]?.def.interval ?? rt.settings.monsterInterval;
}

function activeIds(rt: Runtime): string[] {
  return (rt.game.session?.party ?? []).filter((id) => !isKnockedOut(rt, charRef(id)));
}

function requireFight(rt: Runtime): FightState {
  const f = currentFight(rt);
  if (!f) throw new Rejection("There's no fight running", 'not-a-fight');
  return f;
}

export function startFight(rt: Runtime, monsterId: string, origin: Origin | null): void {
  const s = requireResting(rt);
  const def = rt.reg.monsters.get(monsterId);
  if (!def) throw new Rejection(`Unknown monster '${monsterId}'`, 'unknown-content');
  const m: MonsterState = { id: 'm1', def: structuredClone(def), hp: 0, knockedOut: false, statuses: [], stores: {} };
  const f: FightState = {
    kind: CORE_FIGHT, startedAt: rt.now, origin, monsters: [m], sub: 'waiting', held: false, heldRemaining: null,
    nextTurnAt: null, pausedTurnAt: null, acted: [], wasActive: [], joinedAt: Object.fromEntries(s.party.map((id) => [id, rt.now])),
  };
  s.encounter = f;
  m.hp = maxHp(rt, monsterRef(m.id));
  const active = activeIds(rt);
  if (active.length) {
    f.sub = 'fighting';
    f.nextTurnAt = rt.now + fightInterval(rt, f);
    f.wasActive = active;
  }
  rt.emit('core:encounter-started', `${def.name} appears!`, { kind: CORE_FIGHT, monster: monsterId });
  const present = [...s.party.map((id) => ({ ref: charRef(id), role: 'present' as const })), { ref: monsterRef(m.id), role: 'present' as const }];
  react(rt, { type: 'encounterStarted', kind: CORE_FIGHT }, present);
}

export function spawnMonster(rt: Runtime, monsterId: string): void {
  startFight(rt, monsterId, null);
}

/** Move between fighting and waiting as party members become active or not. */
export function refreshFight(rt: Runtime, f: FightState): void {
  const active = activeIds(rt);
  for (const id of active) if (!f.wasActive.includes(id)) f.wasActive.push(id);
  if (f.sub === 'fighting' && active.length === 0) {
    f.sub = 'waiting';
    f.pausedTurnAt = f.nextTurnAt;
    f.nextTurnAt = null;
    rt.emit('core:fight-waiting', `${f.monsters[0]!.def.name} waits. No one is standing.`, {});
  } else if (f.sub === 'waiting' && active.length > 0) {
    f.sub = 'fighting';
    if (!f.held) {
      const full = rt.settings.fullIntervalAfterWaiting || f.pausedTurnAt === null;
      f.nextTurnAt = full ? rt.now + fightInterval(rt, f) : f.pausedTurnAt;
    }
    f.pausedTurnAt = null;
    rt.emit('core:fight-fighting', 'The fight is on again', {});
  }
}

export function monsterAct(rt: Runtime, f: FightState): void {
  const m = f.monsters[0];
  if (!m || m.knockedOut) return;
  const beh = rt.reg.behaviors.get(m.def.behavior.behavior);
  if (!beh) return;
  callPlugin(beh.pack, `${beh.id} act`, () => beh.def.act(makeCtx(rt, beh.pack), { monster: monsterRef(m.id), params: m.def.behavior.params }));
}

export function monsterTurn(rt: Runtime, f: FightState): void {
  f.nextTurnAt = rt.now + fightInterval(rt, f);
  monsterAct(rt, f);
}

export function holdMonster(rt: Runtime): void {
  const f = requireFight(rt);
  if (f.held) throw new Rejection('The monster is already held', 'already-held');
  f.held = true;
  f.heldRemaining = f.nextTurnAt !== null ? Math.max(0, f.nextTurnAt - rt.now) : null;
  f.nextTurnAt = null;
  rt.emit('core:monster-held', `${f.monsters[0]!.def.name} is held`, {});
}

export function releaseMonster(rt: Runtime): void {
  const f = requireFight(rt);
  if (!f.held) throw new Rejection("The monster isn't held", 'not-held');
  f.held = false;
  if (f.sub === 'fighting') {
    const full = rt.settings.fullIntervalAfterRelease || f.heldRemaining === null;
    f.nextTurnAt = rt.now + (full ? fightInterval(rt, f) : f.heldRemaining!);
  } else {
    f.pausedTurnAt = null;
  }
  f.heldRemaining = null;
  rt.emit('core:monster-released', `${f.monsters[0]!.def.name} is released`, {});
}

export function monsterActNow(rt: Runtime): void {
  const f = requireFight(rt);
  if (f.sub === 'waiting') throw new Rejection('No one to act against', 'no-one');
  rt.emit('core:monster-forced', `The streamer makes ${f.monsters[0]!.def.name} act`, {});
  monsterAct(rt, f);
}

export function setMonsterHp(rt: Runtime, value: number): void {
  const f = requireFight(rt);
  const m = f.monsters[0]!;
  if (!Number.isFinite(value)) throw new Rejection('HP must be a number', 'bad-amount');
  m.hp = Math.min(maxHp(rt, monsterRef(m.id)), Math.max(0, Math.round(value)));
  rt.emit('core:monster-hp-set', `${m.def.name}'s HP is set to ${m.hp}`, { hp: m.hp });
  if (m.hp === 0) knockOut(rt, monsterRef(m.id), undefined, null);
}

export function endFight(rt: Runtime, f: FightState, outcome: string): void {
  const s = rt.game.session!;
  const party = [...s.party];
  if (outcome === 'won') {
    const m = f.monsters[0]!;
    for (const id of party) {
      if (rt.settings.rewardsRequireAction && !f.acted.includes(id)) continue;
      giveRewards(rt, charRef(id), { xp: m.def.rewards.xp, gold: m.def.rewards.gold });
      for (const d of m.def.drops) if (rt.reg.items.has(d.item) && rt.random() < d.chance) giveItem(rt, charRef(id), d.item, 1);
    }
  }
  if (rt.settings.autoRemoveIdle) {
    for (const id of party) {
      if (f.acted.includes(id)) continue;
      if (rt.settings.knockedOutExemptFromIdle && !f.wasActive.includes(id)) continue;
      s.party = s.party.filter((x) => x !== id);
      rt.emit('core:removed-idle', `${entityName(rt, charRef(id))} sat out the fight and left the party`, { character: id });
    }
  }
  if (rt.settings.healBetweenFights) {
    for (const id of s.party) {
      if (isKnockedOut(rt, charRef(id))) continue;
      const ch = rt.game.characters[id]!;
      ch.hp = maxHp(rt, charRef(id));
      rt.emit('core:healed', `${ch.name} rests and heals`, { source: null, target: charRef(id), amount: null });
    }
  }
}
```

- [ ] **Step 4: Implement `use.ts`**

`packages/engine/src/use.ts`:
```ts
import { abilitiesOf, charRef, currentFight, isKnockedOut } from './entities';
import { Rejection } from './errors';
import { modify } from './hooks';
import { useAbility } from './ops';
import type { EntityRef } from './pack';
import type { Runtime } from './runtime';
import type { Character } from './state';
import { formatDuration } from './units';

function spendUse(rt: Runtime, ch: Character, itemId: string): void {
  if (rt.settings.startingItems.includes(itemId) && !(ch.inventory[itemId] ?? 0)) return;
  const item = rt.reg.items.get(itemId)!;
  const left = (ch.usesLeft[itemId] ?? item.uses) - 1;
  if (left > 0) { ch.usesLeft[itemId] = left; return; }
  delete ch.usesLeft[itemId];
  const count = (ch.inventory[itemId] ?? 0) - 1;
  if (count > 0) ch.inventory[itemId] = count;
  else delete ch.inventory[itemId];
}

export function useCommand(rt: Runtime, id: string, abilityId: string, chosen: EntityRef | null): void {
  const ch = rt.requireChar(id);
  const s = rt.game.session;
  if (!s || !s.party.includes(id)) throw new Rejection('Not in the party', 'not-in-party');
  const me = charRef(id);
  if (isKnockedOut(rt, me)) throw new Rejection("You're knocked out", 'knocked-out');
  const src = abilitiesOf(rt, ch).find((a) => a.ability === abilityId);
  if (!src) throw new Rejection("You don't have that ability", 'no-ability');
  const ab = rt.reg.abilities.get(abilityId)!;
  if (ab.when === 'fight' && !currentFight(rt)) throw new Rejection('You can only use that during a fight', 'fight-only');
  const until = ch.cooldowns[abilityId];
  if (until !== undefined && until > rt.now) throw new Rejection(`On cooldown (${formatDuration(until - rt.now)})`, 'on-cooldown');
  const can = modify(rt, me, 'canUse', true as true | string, { ability: abilityId });
  if (can !== true) throw new Rejection(can, 'cannot-use');
  useAbility(rt, me, abilityId, chosen, {}, true);
  if (src.from === 'item' && src.item) spendUse(rt, ch, src.item);
}
```

- [ ] **Step 5: Implement `gear.ts`**

`packages/engine/src/gear.ts`:
```ts
import { charRef, currentFight, maxHp, owns } from './entities';
import { Rejection } from './errors';
import type { Runtime } from './runtime';
import type { Character } from './state';

/** After the character's own gear change: saved HP never exceeds max HP. */
export function capHp(rt: Runtime, ch: Character): void {
  const m = maxHp(rt, charRef(ch.id));
  if (ch.hp > m) ch.hp = m;
}

export function gearLocked(rt: Runtime, id: string): boolean {
  const s = rt.game.session;
  return !!s && s.party.includes(id) && !!currentFight(rt) && rt.settings.gearLockDuringCombat;
}

export function equip(rt: Runtime, id: string, itemId: string): void {
  const ch = rt.requireChar(id);
  if (ch.banned) throw new Rejection("Banned characters can't change gear", 'banned');
  const item = rt.reg.items.get(itemId);
  if (!item || !owns(rt, ch, itemId)) throw new Rejection("You don't have that item", 'not-owned');
  if (!item.slot || !rt.reg.slots.has(item.slot)) throw new Rejection("That item can't be equipped", 'not-gear');
  if (gearLocked(rt, id)) throw new Rejection('Gear is locked during fights', 'gear-locked');
  ch.equipped[item.slot] = itemId;
  capHp(rt, ch);
  rt.emit('core:equipped', `${ch.name} equips ${item.name}`, { character: id, item: itemId, slot: item.slot });
}

export function unequip(rt: Runtime, id: string, slot: string): void {
  const ch = rt.requireChar(id);
  if (ch.banned) throw new Rejection("Banned characters can't change gear", 'banned');
  if (slot === rt.settings.classSlot) throw new Rejection("You can't empty your class slot; swap it instead", 'class-slot');
  if (!ch.equipped[slot]) throw new Rejection('Nothing is equipped there', 'empty-slot');
  if (gearLocked(rt, id)) throw new Rejection('Gear is locked during fights', 'gear-locked');
  delete ch.equipped[slot];
  capHp(rt, ch);
  rt.emit('core:unequipped', `${ch.name} takes off their ${rt.reg.slots.get(slot)?.name ?? slot}`, { character: id, slot });
}
```

- [ ] **Step 6: Run the fight, gear and session tests**

Run: `pnpm vitest run packages/engine/test/fight.test.ts packages/engine/test/gear.test.ts packages/engine/test/session.test.ts`
Expected: PASS once Task 5 (`advanceTo` processes monster turns; needed by `wait()`-based tests) and Task 7 (streamer commands) are done. Tests that only use commands at fixed times pass now. If you're executing strictly in order, finish Tasks 5 and 7, then come back and confirm this whole step passes before committing Task 7.

- [ ] **Step 7: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): fights, abilities and gear"
```

---

### Task 5: Time

**Files:**
- Modify: `packages/engine/src/time.ts` (full version), `packages/engine/src/engine.ts` (add `nextWakeTime`)
- Test: `packages/engine/test/time.test.ts`

**Interfaces:**
- Produces:
  - `interface Due { at: number; order: number; key: string; run(rt: Runtime): void; skip(rt: Runtime): void }`
  - `dueItems(rt: Runtime): Due[]`
  - `runGuarded(rt: Runtime, run: () => void, skip: () => void): void`
  - `advanceTo(rt: Runtime, target: number): void`
  - `nextWake(rt: Runtime): number | null`
  - `Engine.nextWakeTime(game: GameState): number | null`
- Order at equal times: 0 knockout ends, 1 status expiry, 2 status ticks, 3 monster turn, 4 encounter-kind wake; then by key.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/time.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('time', () => {
  it('reports the next wake time', () => {
    const h = harness();
    expect(h.engine.nextWakeTime(h.game)).toBeNull();
    h.open(); h.join('al'); h.spawn();
    expect(h.engine.nextWakeTime(h.game)).toBe(15000);
  });

  it('processes monster turns at their own times during a long wait', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    const events = h.wait(46000);
    const hits = events.filter((e) => e.type === 'core:damaged');
    expect(hits.map((e) => e.at)).toEqual([15000, 30000, 45000]);
    expect(h.char('al').hp).toBe(82);
    expect(h.game.clock).toBe(46000);
  });

  it('ends knockouts with the return HP', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'knockOut', character: 'al' });
    h.wait(60000);
    expect(h.char('al')).toMatchObject({ knockedOutUntil: null, hp: 25 });
    expect(h.types()).toContain('core:knockout-ended');
  });

  it('knockouts keep running outside the party and the session', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'knockOut', character: 'al' });
    h.do({ type: 'closeSession' });
    h.wait(61000);
    expect(h.char('al').knockedOutUntil).toBeNull();
  });

  it('a knockout ending at the same time as a monster turn ends first', () => {
    const h = harness({ settings: { 'knockout-duration': '15s' } });
    h.open(); h.join('al'); h.join('bo'); h.spawn();
    h.do({ type: 'knockOut', character: 'al' });
    h.wait(15000);
    const order = h.log.filter((e) => e.at === 15000).map((e) => e.type);
    expect(order.indexOf('core:knockout-ended')).toBeLessThan(order.indexOf('core:ability-used'));
  });

  it('expires statuses and runs ticks', () => {
    const h = harness({
      plugins: (api) => api.status('bleed', {
        name: 'Bleed', tick: { every: '5s', run: (ctx, { holder }) => { ctx.dealDamage(null, holder, 2); } },
      }),
    });
    h.open(); h.join('al');
    h.do({ type: 'applyStatus', target: { kind: 'character', id: 'al' }, status: 'tp:bleed', duration: '12s' });
    h.wait(20000);
    expect(h.char('al').hp).toBe(96);
    expect(h.char('al').statuses).toEqual([]);
    expect(h.types().filter((t) => t === 'core:status-ended')).toHaveLength(1);
  });

  it('a plugin error in a time step skips that timer and keeps going', () => {
    const h = harness({
      plugins: (api) => api.behavior('broken', { act: () => { throw new Error('kaboom'); } }),
      content: [{ monster: 'glitch', name: 'Glitch', hp: 10, abilities: ['slam'], behavior: { broken: {} } }],
    });
    h.open(); h.join('al'); h.spawn('tp:glitch');
    const events = h.wait(31000);
    expect(events.filter((e) => e.type === 'core:plugin-error')).toHaveLength(2);
    expect(h.fight().nextTurnAt).toBe(45000);
  });

  it('an encounter kind that throws on every wake is force-ended', () => {
    const h = harness({
      plugins: (api) => api.encounterKind('sulk', {
        name: 'Sulk', outcomes: () => ['done'], start: (ctx) => ({ at: ctx.now + 1000 }), respond: (_c, s) => s,
        wakeAt: (s) => s.at, advance: () => { throw new Error('no'); }, endEarly: () => 'done',
        panel: () => ({ type: 'none' }), overlay: () => null,
      }),
    });
    h.open();
    h.do({ type: 'startEncounter', encounter: { 'tp:sulk': {} } });
    h.wait(2000);
    expect(h.game.session!.encounter).toBeNull();
    expect(h.types()).toEqual(expect.arrayContaining(['core:plugin-error', 'core:encounter-ended']));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/engine/test/time.test.ts`
Expected: FAIL (`nextWakeTime` missing; time doesn't process timers).

- [ ] **Step 3: Implement `time.ts`**

`packages/engine/src/time.ts`:
```ts
import { charRef, currentFight, monsterRef, statusList } from './entities';
import { kindWake } from './encounters';
import { PluginError, Rejection } from './errors';
import { fightInterval, monsterTurn } from './fight';
import { callPlugin, react } from './hooks';
import { endKnockout, removeStatus } from './ops';
import { makeCtx } from './ctx';
import type { EntityRef } from './pack';
import type { Runtime } from './runtime';
import { settle } from './settle';
import { isFight, type StatusInstance } from './state';
import { parseDuration } from './units';

export interface Due { at: number; order: number; key: string; run(rt: Runtime): void; skip(rt: Runtime): void }

function find(rt: Runtime, ref: EntityRef, seq: number): StatusInstance | undefined {
  try { return statusList(rt, ref).find((s) => s.seq === seq); } catch { return undefined; }
}

function statusDue(rt: Runtime, ref: EntityRef, list: StatusInstance[], out: Due[]): void {
  for (const s of list) {
    const reg = rt.reg.statuses.get(s.status);
    if (!reg) continue;
    const key = `${ref.kind}:${ref.id}:${s.seq}`;
    if (s.until !== null) {
      out.push({
        at: s.until, order: 1, key,
        run: (r) => removeStatus(r, ref, s.status, 'expired', s.seq),
        skip: (r) => { const list2 = statusList(r, ref); const i = list2.findIndex((x) => x.seq === s.seq); if (i >= 0) list2.splice(i, 1); },
      });
    }
    if (s.nextTick !== null && reg.def.tick && (s.until === null || s.nextTick < s.until)) {
      const every = parseDuration(reg.def.tick.every);
      out.push({
        at: s.nextTick, order: 2, key,
        run: (r) => {
          const inst = find(r, ref, s.seq)!;
          inst.nextTick = inst.nextTick! + every;
          callPlugin(reg.pack, `${reg.id} tick`, () => reg.def.tick!.run(makeCtx(r, reg.pack), { holder: ref, params: inst.params, source: inst.source }));
        },
        skip: (r) => { const inst = find(r, ref, s.seq); if (inst) inst.nextTick = inst.nextTick! + every; },
      });
    }
  }
}

export function dueItems(rt: Runtime): Due[] {
  const out: Due[] = [];
  for (const ch of Object.values(rt.game.characters)) {
    if (ch.knockedOutUntil !== null) {
      const id = ch.id;
      out.push({
        at: ch.knockedOutUntil, order: 0, key: id,
        run: (r) => endKnockout(r, id),
        skip: (r) => { const c = r.game.characters[id]!; c.knockedOutUntil = null; c.hp = Math.max(1, c.hp); },
      });
    }
    statusDue(rt, charRef(ch.id), ch.statuses, out);
  }
  const f = currentFight(rt);
  if (f) {
    for (const m of f.monsters) statusDue(rt, monsterRef(m.id), m.statuses, out);
    if (f.sub === 'fighting' && !f.held && f.nextTurnAt !== null) {
      out.push({
        at: f.nextTurnAt, order: 3, key: 'turn',
        run: (r) => monsterTurn(r, currentFight(r)!),
        skip: (r) => { const ff = currentFight(r)!; ff.nextTurnAt = r.now + fightInterval(r, ff); },
      });
    }
  }
  const enc = rt.game.session?.encounter;
  if (enc && !isFight(enc)) {
    const kind = rt.reg.kinds.get(enc.kind);
    if (kind) {
      const at = callPlugin(kind.pack, `${kind.id} wakeAt`, () => kind.def.wakeAt(enc.state));
      if (at !== null) out.push({ at, order: 4, key: 'wake', run: (r) => kindWake(r), skip: (r) => forceEnd(r) });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function forceEnd(rt: Runtime): void {
  const s = rt.game.session;
  if (!s?.encounter) return;
  const kind = s.encounter.kind;
  s.encounter = null;
  rt.emit('core:encounter-ended', 'The encounter was stopped after an error', { kind, outcome: 'ended' });
  react(rt, { type: 'encounterEnded', kind, outcome: 'ended' }, []);
}

/** Runs one time step; on a plugin error rolls it back, skips that timer and emits core:plugin-error. */
export function runGuarded(rt: Runtime, run: () => void, skip: () => void): void {
  const snapshot = structuredClone(rt.game);
  const count = rt.events.length;
  try {
    run();
  } catch (e) {
    if (!(e instanceof PluginError || e instanceof Rejection)) throw e;
    rt.game = snapshot;
    rt.events.length = count;
    rt.queue = [];
    rt.pendingEnd = null;
    rt.depth = 0;
    skip();
    rt.emit('core:plugin-error', e.message, {});
  }
}

export function advanceTo(rt: Runtime, target: number): void {
  for (let i = 0; ; i++) {
    if (i > 100_000) throw new Error('Too many timed events at once; a pack may be scheduling in a loop');
    const next = dueItems(rt)[0];
    if (!next || next.at > target) break;
    rt.now = Math.max(rt.now, next.at);
    rt.depth = 0;
    rt.limitHit = false;
    runGuarded(rt, () => { next.run(rt); settle(rt); }, () => next.skip(rt));
  }
  rt.now = Math.max(rt.now, target);
}

export function nextWake(rt: Runtime): number | null {
  return dueItems(rt)[0]?.at ?? null;
}
```

Add `nextWakeTime` to `engine.ts` (interface and object):
```ts
  nextWakeTime(game: GameState): number | null;
```
```ts
    nextWakeTime: (game) => nextWake(new Runtime(registry, structuredClone(game))),
```
and import `nextWake` from `./time`.

Make `kindWake` real now (Task 6 relies on it too). Replace the stub in `encounters.ts`:
```ts
export function kindWake(rt: Runtime): void {
  const enc = rt.game.session?.encounter;
  if (!enc || isFight(enc)) return;
  const kind = rt.reg.kinds.get(enc.kind)!;
  enc.state = callPlugin(kind.pack, `${kind.id} advance`, () => kind.def.advance(makeCtx(rt, kind.pack), enc.state, enc.params));
}
```

- [ ] **Step 4: Run time, fight, gear and session tests**

Run: `pnpm vitest run packages/engine/test/time.test.ts packages/engine/test/fight.test.ts packages/engine/test/session.test.ts`
Expected: time tests PASS. Fight/session tests that need streamer commands pass after Task 7.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): time, timers and guarded time steps"
```

---

### Task 6: Encounter kinds and adventures

**Files:**
- Modify: `packages/engine/src/encounters.ts` (`respond`), `packages/engine/src/adventure.ts` (replace stubs)
- Test: `packages/engine/test/encounters.test.ts`, `packages/engine/test/adventure.test.ts`

**Interfaces:**
- Produces: `respond(rt, id, input)`; `startAdventure(rt, id)`, `go(rt)`, `skipTo(rt, node)`, `stopAdventure(rt)`.
- Error codes introduced: `nothing-to-respond`, `invalid-input`, `bad-outcome`, `no-encounter`, `adventure-running`, `no-adventure`, `nothing-lined`, `unknown-node`.

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/encounters.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('encounter kinds', () => {
  it('starts by ID, ends on its own timer', () => {
    const h = harness();
    h.open();
    h.do({ type: 'startEncounter', encounter: 'tp:chat' });
    expect(h.game.session!.encounter).toMatchObject({ kind: 'tp:show', state: { endsAt: 10000 } });
    h.wait(10000);
    expect(h.game.session!.encounter).toBeNull();
    expect(h.log.at(-1)).toMatchObject({ type: 'core:encounter-ended', data: { outcome: 'done' } });
  });

  it('starts inline, with params checked', () => {
    const h = harness();
    h.open();
    expect(h.fail({ type: 'startEncounter', encounter: { 'tp:ballot': { choices: { a: 'A' } } } }))
      .toEqual({ code: 'invalid-input', message: 'tp:ballot.time: required' });
    h.do({ type: 'startEncounter', encounter: { 'tp:ballot': { choices: { a: 'A', b: 'B' }, time: '30s' } } });
    expect(h.fail({ type: 'startEncounter', encounter: 'tp:chat' }).code).toBe('busy');
  });

  it('only party members respond; input is checked; plugin errors roll back', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'startEncounter', encounter: { 'tp:ballot': { choices: { a: 'A', b: 'B' }, time: '30s' } } });
    expect(h.fail({ type: 'respond', character: 'bo', input: { choice: 'a' } }).code).toBe('unknown-character');
    h.join('bo');
    h.do({ type: 'leave', character: 'bo' });
    expect(h.fail({ type: 'respond', character: 'bo', input: { choice: 'a' } }).code).toBe('not-in-party');
    expect(h.fail({ type: 'respond', character: 'al', input: {} })).toEqual({ code: 'invalid-input', message: 'choice: required' });
    const err = h.fail({ type: 'respond', character: 'al', input: { choice: 'zzz' } });
    expect(err.code).toBe('plugin-error');
    expect(err.message).toContain('tp:ballot respond');
    h.do({ type: 'respond', character: 'al', input: { choice: 'b' } });
    h.wait(30000);
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'b' });
  });

  it('knocked-out members can still respond', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'knockOut', character: 'al' });
    h.do({ type: 'startEncounter', encounter: { 'tp:ballot': { choices: { a: 'A' }, time: '5s' } } });
    h.do({ type: 'respond', character: 'al', input: { choice: 'a' } });
  });

  it('the streamer ends early with endEarly, an allowed outcome, or ended', () => {
    const h = harness();
    h.open();
    h.do({ type: 'startEncounter', encounter: { 'tp:ballot': { choices: { a: 'A', b: 'B' }, time: '30s' } } });
    expect(h.fail({ type: 'endEncounter', outcome: 'won' })).toEqual({ code: 'bad-outcome', message: "That encounter can't end with 'won'" });
    h.do({ type: 'endEncounter' });
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'a' });
    h.do({ type: 'startEncounter', encounter: 'tp:chat' });
    h.do({ type: 'endEncounter', outcome: 'ended' });
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'ended' });
  });

  it('onEnd runs on every ending, including closeSession', () => {
    const ends: string[] = [];
    const h = harness({
      plugins: (api) => api.encounterKind('tally', {
        name: 'Tally', outcomes: () => ['done'], start: () => ({}), respond: (_c, s) => s, wakeAt: () => null,
        advance: (_c, s) => s, endEarly: () => 'done', onEnd: (_c, _s, outcome) => { ends.push(outcome); },
        panel: () => ({ type: 'none' }), overlay: () => null,
      }),
    });
    h.open();
    h.do({ type: 'startEncounter', encounter: { 'tp:tally': {} } });
    h.do({ type: 'endEncounter' });
    h.do({ type: 'startEncounter', encounter: { 'tp:tally': {} } });
    h.do({ type: 'closeSession' });
    expect(ends).toEqual(['done', 'ended']);
  });

  it('non-fight encounters never remove idle members', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'startEncounter', encounter: 'tp:chat' });
    h.wait(10000);
    expect(h.game.session!.party).toEqual(['al']);
  });
});
```

`packages/engine/test/adventure.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('adventures', () => {
  it('lines up nodes and waits for go; branches by outcome', () => {
    const h = harness();
    h.open(); h.join('al');
    expect(h.fail({ type: 'go' }).code).toBe('no-adventure');
    h.do({ type: 'startAdventure', adventure: 'tp:trip' });
    expect(h.game.session!.adventure).toEqual({ id: 'tp:trip', lined: 'intro' });
    expect(h.fail({ type: 'startAdventure', adventure: 'tp:trip' }).code).toBe('adventure-running');
    h.do({ type: 'go' });
    expect(h.fail({ type: 'go' }).code).toBe('busy');
    h.do({ type: 'endEncounter' });
    expect(h.game.session!.adventure!.lined).toBe('pick');
    h.do({ type: 'go' });
    h.do({ type: 'respond', character: 'al', input: { choice: 'b' } });
    h.wait(30000);
    expect(h.game.session!.adventure!.lined).toBe('talk');
    h.do({ type: 'go' });
    expect(h.game.session!.encounter).toMatchObject({ kind: 'tp:show', params: { text: 'Hello there' } });
    h.wait(10000);
    h.do({ type: 'go' });
    h.do({ type: 'endEncounter' });
    expect(h.game.session!.adventure).toBeNull();
    expect(h.types()).toContain('core:adventure-finished');
  });

  it('uses default when the outcome has no entry, and skipTo / stop work', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'startAdventure', adventure: 'tp:trip' });
    expect(h.fail({ type: 'skipTo', node: 'nope' }).code).toBe('unknown-node');
    h.do({ type: 'skipTo', node: 'fight' });
    h.do({ type: 'go' });
    h.do({ type: 'endEncounter', outcome: 'ended' });
    expect(h.game.session!.adventure!.lined).toBe('end');
    h.do({ type: 'stopAdventure' });
    expect(h.game.session!.adventure).toBeNull();
    expect(h.fail({ type: 'stopAdventure' }).code).toBe('no-adventure');
  });

  it('hand-started encounters do not move the adventure', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'startAdventure', adventure: 'tp:trip' });
    h.spawn();
    h.do({ type: 'endEncounter' });
    expect(h.game.session!.adventure!.lined).toBe('intro');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/engine/test/encounters.test.ts packages/engine/test/adventure.test.ts`
Expected: FAIL (`not-implemented`).

- [ ] **Step 3: Implement `respond` in `encounters.ts`**

Replace the `respond` stub:
```ts
export function respond(rt: Runtime, id: string, input: unknown): void {
  rt.requireChar(id);
  const s = rt.game.session;
  if (!s) throw new Rejection('No session is open', 'no-session');
  const enc = s.encounter;
  if (!enc || isFight(enc)) throw new Rejection("There's nothing to respond to", 'nothing-to-respond');
  if (!s.party.includes(id)) throw new Rejection('Not in the party', 'not-in-party');
  const kind = rt.reg.kinds.get(enc.kind)!;
  const nctx = runtimeNormalizeCtx(rt, kind.pack);
  const value = normalizeParams(kind.def.input ?? p.object({}), input ?? {}, nctx);
  if (nctx.issues.length) throw new Rejection(nctx.issues[0]!, 'invalid-input');
  enc.state = callPlugin(kind.pack, `${kind.id} respond`, () =>
    kind.def.respond(makeCtx(rt, kind.pack), enc.state, charRef(id), value, enc.params));
}
```

- [ ] **Step 4: Implement `adventure.ts`**

`packages/engine/src/adventure.ts`:
```ts
import type { EncounterSpec } from './content';
import { requireResting, startEncounter } from './encounters';
import { Rejection } from './errors';
import type { Runtime } from './runtime';
import type { SessionState } from './state';

function requireSession(rt: Runtime): SessionState {
  const s = rt.game.session;
  if (!s) throw new Rejection('No session is open', 'no-session');
  return s;
}

function requireAdventure(rt: Runtime) {
  const s = requireSession(rt);
  if (!s.adventure) throw new Rejection('No adventure is running', 'no-adventure');
  const def = rt.reg.adventures.get(s.adventure.id);
  if (!def) throw new Rejection('That adventure is not available', 'unknown-content');
  return { s, adv: s.adventure, def };
}

export function startAdventure(rt: Runtime, id: string): void {
  const s = requireSession(rt);
  if (s.adventure) throw new Rejection('An adventure is already running', 'adventure-running');
  const def = rt.reg.adventures.get(id);
  if (!def) throw new Rejection(`Unknown adventure '${id}'`, 'unknown-content');
  s.adventure = { id, lined: def.start };
  rt.emit('core:adventure-started', `${def.name} begins`, { adventure: id });
  rt.emit('core:adventure-lined-up', `Next up: ${def.start}`, { adventure: id, node: def.start });
}

export function go(rt: Runtime): void {
  const { adv, def } = requireAdventure(rt);
  requireResting(rt);
  if (!adv.lined) throw new Rejection('Nothing is lined up', 'nothing-lined');
  const name = adv.lined;
  const node = def.nodes[name]!;
  const spec: EncounterSpec | undefined = node.spec ?? (node.use ? rt.reg.encounters.get(node.use)?.spec : undefined);
  if (!spec) throw new Rejection('That node is not available', 'unknown-content');
  adv.lined = null;
  startEncounter(rt, spec, { adventure: adv.id, node: name });
}

export function skipTo(rt: Runtime, node: string): void {
  const { adv, def } = requireAdventure(rt);
  if (!(node in def.nodes)) throw new Rejection(`No node called '${node}'`, 'unknown-node');
  adv.lined = node;
  rt.emit('core:adventure-lined-up', `Next up: ${node}`, { adventure: adv.id, node });
}

export function stopAdventure(rt: Runtime): void {
  const { s, def } = requireAdventure(rt);
  s.adventure = null;
  rt.emit('core:adventure-stopped', `${def.name} stops`, { adventure: def.id });
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm vitest run packages/engine/test/encounters.test.ts packages/engine/test/adventure.test.ts`
Expected: PASS (the `knockOut` command is from Task 7; if that one test fails with `not-implemented`, it passes after Task 7).

- [ ] **Step 6: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): encounter kinds and adventures"
```

---

### Task 7: Streamer commands

**Files:**
- Modify: `packages/engine/src/streamer.ts` (replace stubs)
- Test: `packages/engine/test/streamer.test.ts`; the earlier fight, gear and session tests now pass in full

**Interfaces:**
- Produces: `healPlayer(rt, id, amount)`, `healParty(rt)`, `revivePlayer(rt, id)`, `reviveAll(rt)`, `applyStatusCommand(rt, target, status, duration, params)`, `removeStatusCommand(rt, target, status)`, `knockOutCommand(rt, id)`, `giveXpCommand(rt, target, amount)`, `giveGoldCommand(rt, target, amount)`, `giveItemCommand(rt, target, item)`, `postMessage(rt, text)`.
- Error codes introduced: `bad-amount`, `not-knocked-out`, `unknown-status`, `use-revive`, `no-status`, `unknown-target`.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/streamer.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('streamer commands', () => {
  it('heals a player or the party, never a knocked-out one, never negative', () => {
    const h = harness();
    h.open(); h.join('al'); h.join('bo'); h.spawn();
    h.wait(15000);
    const hurt = ['al', 'bo'].find((id) => h.char(id).hp < 100)!;
    h.do({ type: 'healPlayer', character: hurt, amount: 3 });
    expect(h.char(hurt).hp).toBe(97);
    expect(h.fail({ type: 'healPlayer', character: hurt, amount: -50 }).code).toBe('bad-amount');
    h.do({ type: 'healParty' });
    expect(h.char(hurt).hp).toBe(100);
    h.do({ type: 'knockOut', character: 'al' });
    expect(h.fail({ type: 'healPlayer', character: 'al', amount: 'full' }).code).toBe('knocked-out');
  });

  it('revives to knockoutReturnHp; reviveAll revives every knocked-out member', () => {
    const h = harness();
    h.open(); h.join('al'); h.join('bo');
    expect(h.fail({ type: 'revivePlayer', character: 'al' }).code).toBe('not-knocked-out');
    h.do({ type: 'knockOut', character: 'al' });
    h.do({ type: 'knockOut', character: 'bo' });
    h.do({ type: 'revivePlayer', character: 'al' });
    expect(h.char('al')).toMatchObject({ knockedOutUntil: null, hp: 25 });
    h.do({ type: 'reviveAll' });
    expect(h.char('bo').knockedOutUntil).toBeNull();
  });

  it('applies and removes statuses with checked params', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    const al = { kind: 'character' as const, id: 'al' };
    expect(h.fail({ type: 'applyStatus', target: al, status: 'tp:nope' }).code).toBe('unknown-status');
    expect(h.fail({ type: 'applyStatus', target: al, status: 'tp:snooze', params: {} })).toEqual({ code: 'invalid-input', message: 'factor: required' });
    h.do({ type: 'applyStatus', target: al, status: 'tp:snooze', duration: '30s', params: { factor: 2 } });
    expect(h.char('al').statuses[0]).toMatchObject({ status: 'tp:snooze', until: 30000, params: { factor: 2 } });
    h.do({ type: 'applyStatus', target: { kind: 'monster', id: 'm1' }, status: 'tp:snooze', params: { factor: 2 } });
    expect(h.monster().statuses).toHaveLength(1);
    h.do({ type: 'removeStatus', target: al, status: 'tp:snooze' });
    expect(h.fail({ type: 'removeStatus', target: al, status: 'tp:snooze' }).code).toBe('no-status');
    expect(h.fail({ type: 'removeStatus', target: al, status: 'core:knocked-out' }).code).toBe('use-revive');
    expect(h.fail({ type: 'applyStatus', target: { kind: 'monster', id: 'm9' }, status: 'tp:snooze', params: { factor: 2 } }).code).toBe('unknown-target');
  });

  it('gives XP, gold and items to one character or the party', () => {
    const h = harness();
    h.open(); h.join('al'); h.join('bo');
    h.do({ type: 'giveXp', target: 'party', amount: 210 });
    expect(h.char('bo')).toMatchObject({ xp: 210, level: 3 });
    h.do({ type: 'giveGold', target: 'al', amount: 7 });
    expect(h.char('al').gold).toBe(7);
    expect(h.fail({ type: 'giveGold', target: 'al', amount: -10 }).code).toBe('bad-amount');
    h.do({ type: 'giveItem', target: 'party', item: 'tp:vest' });
    expect(h.char('bo').inventory).toEqual({ 'tp:vest': 1 });
    expect(h.fail({ type: 'giveItem', target: 'al', item: 'tp:nope' }).code).toBe('unknown-content');
    expect(h.fail({ type: 'giveXp', target: 'ghost', amount: 1 }).code).toBe('unknown-character');
  });

  it('posts a message to the feed', () => {
    const h = harness();
    expect(h.do({ type: 'postMessage', text: 'Hello chat' })).toEqual([{ type: 'core:message', at: 0, text: 'Hello chat', data: {} }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/engine/test/streamer.test.ts`
Expected: FAIL (`not-implemented`).

- [ ] **Step 3: Implement `streamer.ts`**

`packages/engine/src/streamer.ts`:
```ts
import { runtimeNormalizeCtx } from './ctx';
import { charRef, currentFight, entityExists, isKnockedOut, maxHp, partyRefs, statusList } from './entities';
import { Rejection } from './errors';
import { addGold, addXp, applyStatus, giveItem, heal, knockOut, removeStatus, revive } from './ops';
import type { EntityRef } from './pack';
import { normalizeParams, p } from './params';
import { CORE_KO } from './registry';
import type { Runtime } from './runtime';
import { parseDuration } from './units';

function amountOk(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Rejection('Amount must be 0 or more', 'bad-amount');
  return n;
}

function targets(rt: Runtime, target: string): string[] {
  if (target === 'party') return partyRefs(rt).map((r) => r.id);
  rt.requireChar(target);
  return [target];
}

export function healPlayer(rt: Runtime, id: string, amount: number | 'full'): void {
  rt.requireChar(id);
  const ref = charRef(id);
  if (amount !== 'full') amountOk(amount);
  if (isKnockedOut(rt, ref)) throw new Rejection("They're knocked out. Revive them instead", 'knocked-out');
  heal(rt, null, ref, amount === 'full' ? maxHp(rt, ref) : amount);
}

export function healParty(rt: Runtime): void {
  for (const ref of partyRefs(rt)) if (!isKnockedOut(rt, ref)) heal(rt, null, ref, maxHp(rt, ref));
}

function reviveOne(rt: Runtime, ref: EntityRef): void {
  revive(rt, ref, (maxHp(rt, ref) * rt.settings.knockoutReturnHp) / 100, null);
}

export function revivePlayer(rt: Runtime, id: string): void {
  rt.requireChar(id);
  if (!isKnockedOut(rt, charRef(id))) throw new Rejection("They aren't knocked out", 'not-knocked-out');
  reviveOne(rt, charRef(id));
}

export function reviveAll(rt: Runtime): void {
  for (const ref of partyRefs(rt)) if (isKnockedOut(rt, ref)) reviveOne(rt, ref);
}

function requireTarget(rt: Runtime, target: EntityRef): void {
  if (target.kind === 'character') rt.requireChar(target.id);
  else if (!currentFight(rt) || !entityExists(rt, target)) throw new Rejection('No such target', 'unknown-target');
}

export function applyStatusCommand(rt: Runtime, target: EntityRef, status: string, duration: string | number | null, params: unknown): void {
  requireTarget(rt, target);
  const ms = duration === null || duration === undefined ? null : (() => {
    try { return parseDuration(duration); } catch (e) { throw new Rejection((e as Error).message, 'invalid-input'); }
  })();
  if (status === CORE_KO) { knockOut(rt, target, ms ?? undefined, null); return; }
  const reg = rt.reg.statuses.get(status);
  if (!reg) throw new Rejection(`Unknown status '${status}'`, 'unknown-status');
  const nctx = runtimeNormalizeCtx(rt, reg.pack);
  const value = normalizeParams(reg.def.params ?? p.object({}), params ?? {}, nctx);
  if (nctx.issues.length) throw new Rejection(nctx.issues[0]!, 'invalid-input');
  applyStatus(rt, target, status, ms, value, null);
}

export function removeStatusCommand(rt: Runtime, target: EntityRef, status: string): void {
  requireTarget(rt, target);
  if (status === CORE_KO) throw new Rejection('Use revive for knockouts', 'use-revive');
  if (!statusList(rt, target).some((s) => s.status === status)) throw new Rejection("They don't have that status", 'no-status');
  removeStatus(rt, target, status, 'removed');
}

export function knockOutCommand(rt: Runtime, id: string): void {
  rt.requireChar(id);
  if (isKnockedOut(rt, charRef(id))) throw new Rejection("They're already knocked out", 'knocked-out');
  knockOut(rt, charRef(id), undefined, null);
}

export function giveXpCommand(rt: Runtime, target: string, amount: number): void {
  const n = Math.round(amountOk(amount));
  for (const id of targets(rt, target)) {
    const ch = rt.game.characters[id]!;
    rt.emit('core:xp-given', `${ch.name} gets ${n} XP`, { character: id, amount: n });
    addXp(rt, ch, n);
  }
}

export function giveGoldCommand(rt: Runtime, target: string, amount: number): void {
  const n = Math.round(amountOk(amount));
  for (const id of targets(rt, target)) {
    const ch = rt.game.characters[id]!;
    addGold(rt, ch, n);
    rt.emit('core:gold-given', `${ch.name} gets ${n} gold`, { character: id, amount: n });
  }
}

export function giveItemCommand(rt: Runtime, target: string, item: string): void {
  const ids = targets(rt, target);
  if (!rt.reg.items.has(item)) throw new Rejection(`Unknown item '${item}'`, 'unknown-content');
  for (const id of ids) giveItem(rt, charRef(id), item, 1);
}

export function postMessage(rt: Runtime, text: string): void {
  rt.emit('core:message', text, {});
}
```

- [ ] **Step 4: Run every engine test**

Run: `pnpm vitest run packages/engine`
Expected: PASS for every file so far (`entities`, `ops`, `session`, `gear`, `fight`, `time`, `encounters`, `adventure`, `streamer`, and Plan A's tests). Fix code until this is fully green before committing.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: clean.

```bash
git add packages/engine
git commit -m "feat(engine): streamer commands"
```

---

### Task 8: Resume, adopt, dormancy at runtime, and view

**Files:**
- Modify: `packages/engine/src/time.ts` (add `resumeAt`), `packages/engine/src/engine.ts` (add `resume`, `adopt`, `view`), `packages/engine/src/index.ts`
- Create: `packages/engine/src/view.ts`
- Test: `packages/engine/test/resume-adopt.test.ts`, `packages/engine/test/dormant-runtime.test.ts`, `packages/engine/test/view.test.ts`

**Interfaces:**
- Produces:
  - `time.ts`: `resumeAt(rt: Runtime, now: number): void`
  - `view.ts`: `interface View` (below), `view(rt: Runtime, characterId: string | null): View`
  - `Engine.resume(game, now): { game: GameState; events: GameEvent[] }`
  - `Engine.adopt(game): GameState` (throws `EngineError('content-in-use', …)`)
  - `Engine.view(game, characterId: string | null, now: number): View`

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/resume-adopt.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createEngine, EngineError } from '../src';
import { harness } from './helpers/harness';
import { tpBundle, tpChannel } from './helpers/tp-pack';

describe('resume', () => {
  it('ends expired knockouts and statuses, does not replay monster turns, full interval by default', () => {
    const h = harness();
    h.open(); h.join('al'); h.join('bo'); h.spawn();
    h.do({ type: 'knockOut', character: 'al' });
    h.do({ type: 'applyStatus', target: { kind: 'character', id: 'bo' }, status: 'tp:snooze', duration: '10s', params: { factor: 2 } });
    const saved = JSON.parse(JSON.stringify(h.game));
    const r = h.engine.resume(saved, 120000);
    expect(r.game.characters.al!.knockedOutUntil).toBeNull();
    expect(r.game.characters.bo!.statuses).toEqual([]);
    expect(r.events.filter((e) => e.type === 'core:damaged')).toEqual([]);
    expect((r.game.session!.encounter as { nextTurnAt: number }).nextTurnAt).toBe(135000);
  });

  it('with fullIntervalAfterRestart off, runs exactly one overdue turn', () => {
    const h = harness({ settings: { 'full-interval-after-restart': false } });
    h.open(); h.join('al'); h.spawn();
    const r = h.engine.resume(structuredClone(h.game), 100000);
    expect(r.events.filter((e) => e.type === 'core:ability-used')).toHaveLength(1);
    expect((r.game.session!.encounter as { nextTurnAt: number }).nextTurnAt).toBe(115000);
  });

  it('with fullIntervalAfterRestart off and the turn still ahead, keeps it', () => {
    const h = harness({ settings: { 'full-interval-after-restart': false } });
    h.open(); h.join('al'); h.spawn();
    const r = h.engine.resume(structuredClone(h.game), 5000);
    expect((r.game.session!.encounter as { nextTurnAt: number }).nextTurnAt).toBe(15000);
  });

  it('closes an encounter whose time ran out during the downtime', () => {
    const h = harness();
    h.open();
    h.do({ type: 'startEncounter', encounter: 'tp:chat' });
    const r = h.engine.resume(structuredClone(h.game), 60000);
    expect(r.game.session!.encounter).toBeNull();
  });
});

describe('adopt', () => {
  it('rejects when the running encounter or adventure uses missing content', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    const without = createEngine({ packs: [tpBundle()], channel: { packs: [] } });
    expect(() => without.adopt(h.game)).toThrow(EngineError);
    try { without.adopt(h.game); } catch (e) { expect((e as EngineError).code).toBe('content-in-use'); }
    h.do({ type: 'endEncounter' });
    h.do({ type: 'startAdventure', adventure: 'tp:trip' });
    expect(() => without.adopt(h.game)).toThrow(/adventure/);
    h.do({ type: 'stopAdventure' });
    expect(without.adopt(h.game)).toEqual(h.game);
  });

  it('accepts a game when the same content is still there', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    const same = createEngine({ packs: [tpBundle()], channel: tpChannel() });
    expect(same.adopt(h.game)).toEqual(h.game);
  });
});
```

`packages/engine/test/dormant-runtime.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src';
import type { PackBundle } from '../src/pack';
import { tpBundle, tpChannel } from './helpers/tp-pack';

const extra: PackBundle = {
  manifest: { id: 'ex', version: '1.0.0', name: 'Extra', depends: { tp: '^1.0.0' } },
  official: true,
  content: [
    { file: 'ex.yaml', index: 0, doc: { item: 'wand', name: 'Wand', slot: 'tp:hand', 'grants-class': 'tp:mender', stats: { 'tp:power': 3 } } },
    { file: 'ex.yaml', index: 1, doc: { item: 'cape', name: 'Cape', slot: 'tp:body', stats: { hp: 30 } } },
    { file: 'ex.yaml', index: 2, doc: { item: 'gem', name: 'Gem', price: 5 } },
  ],
};

describe('dormancy at runtime (success criterion 5)', () => {
  it('turning a pack off and on restores items and equipment exactly', () => {
    const on = createEngine({ packs: [tpBundle(), extra], channel: tpChannel({ packs: ['tp', 'ex'] }) });
    const off = createEngine({ packs: [tpBundle(), extra], channel: tpChannel({ packs: ['tp'] }) });
    let game = on.newGame({ seed: 1 });
    const run = (engine: typeof on, cmd: Parameters<typeof on.apply>[1]) => {
      const r = engine.apply(game, cmd, 0);
      if (!r.ok) throw new Error(r.error.message);
      game = r.game;
    };
    run(on, { type: 'openSession' });
    run(on, { type: 'join', character: 'al', name: 'Al', pick: 'tp:club' });
    for (const item of ['ex:wand', 'ex:cape', 'ex:gem']) run(on, { type: 'giveItem', target: 'al', item });
    run(on, { type: 'equip', character: 'al', item: 'ex:wand' });
    run(on, { type: 'equip', character: 'al', item: 'ex:cape' });
    const before = structuredClone(game.characters.al);

    game = off.adopt(game);
    const v = off.view(game, 'al', 0);
    expect(v.character!.class).toBe('tp:brute');
    expect(v.character!.inventory['ex:gem']).toEqual({ count: 1, dormant: true });
    expect(v.character!.maxHp).toBe(100);
    expect(off.apply(game, { type: 'equip', character: 'al', item: 'ex:cape' }, 0)).toMatchObject({ ok: false, error: { code: 'not-owned' } });

    game = on.adopt(game);
    expect(game.characters.al).toEqual(before);
    expect(on.view(game, 'al', 0).character!.class).toBe('tp:mender');
  });

  it('a character who swaps a dormant class item keeps it in the inventory', () => {
    const on = createEngine({ packs: [tpBundle(), extra], channel: tpChannel({ packs: ['tp', 'ex'] }) });
    const off = createEngine({ packs: [tpBundle(), extra], channel: tpChannel({ packs: ['tp'] }) });
    let game = on.newGame({ seed: 1 });
    for (const cmd of [
      { type: 'openSession' }, { type: 'join', character: 'al', name: 'Al', pick: 'tp:club' },
      { type: 'giveItem', target: 'al', item: 'ex:wand' }, { type: 'equip', character: 'al', item: 'ex:wand' },
    ] as const) game = (on.apply(game, cmd, 0) as { game: typeof game }).game;
    game = (off.apply(game, { type: 'equip', character: 'al', item: 'tp:rod' }, 0) as { game: typeof game }).game;
    game = on.adopt(game);
    expect(game.characters.al!.equipped['tp:hand']).toBe('tp:rod');
    expect(game.characters.al!.inventory['ex:wand']).toBe(1);
  });
});
```

`packages/engine/test/view.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('view', () => {
  it('shows a character, their abilities with readiness and targets, and the fight', () => {
    const h = harness();
    h.open(); h.join('al'); h.join('mo', 'tp:rod'); h.spawn();
    h.use('al', 'tp:whack');
    const v = h.engine.view(h.game, 'mo', 1000);
    expect(v.phase).toBe('fight');
    expect(v.character).toMatchObject({ id: 'mo', class: 'tp:mender', hp: 90, maxHp: 90, inParty: true, stats: { 'tp:power': 5, 'tp:grit': 0 } });
    const mend = v.abilities.find((a) => a.ability === 'tp:mend')!;
    expect(mend).toMatchObject({ ready: true, needsChoice: true, targets: [{ kind: 'character', id: 'al' }, { kind: 'character', id: 'mo' }] });
    const alView = h.engine.view(h.game, 'al', 1000);
    expect(alView.abilities.find((a) => a.ability === 'tp:whack')).toMatchObject({ ready: false, readyAt: 10000, reason: 'On cooldown (9s)' });
    expect(v.fight).toMatchObject({ monster: { name: 'Blob', hp: 40, maxHp: 50 }, sub: 'fighting', nextTurnAt: 15000 });
    expect(v.party.map((m) => m.id)).toEqual(['al', 'mo']);
  });

  it('shows the encounter panel and overlay', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'startEncounter', encounter: { 'tp:ballot': { choices: { a: 'A' }, time: '30s' } } });
    h.do({ type: 'respond', character: 'al', input: { choice: 'a' } });
    const v = h.engine.view(h.game, 'al', 0);
    expect(v.panel).toMatchObject({ type: 'choices', selected: 'a', 'closes-at': 30000 });
    expect(h.engine.view(h.game, null, 0).panel).toEqual({ type: 'none' });
  });

  it('view does not change the game', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    const before = structuredClone(h.game);
    h.engine.view(h.game, 'al', 0);
    expect(h.game).toEqual(before);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/engine/test/resume-adopt.test.ts packages/engine/test/dormant-runtime.test.ts packages/engine/test/view.test.ts`
Expected: FAIL (`resume`, `adopt`, `view` missing).

- [ ] **Step 3: Implement `resumeAt` in `time.ts`**

Append to `packages/engine/src/time.ts`:
```ts
/**
 * After loading a save. Timers are absolute and kept running during the downtime, but nothing acts:
 * expired knockouts, statuses and cooldowns end; due encounter wakes run once; monster turns and
 * ticks are not replayed. Then fullIntervalAfterRestart alone decides the next monster turn.
 */
export function resumeAt(rt: Runtime, now: number): void {
  const f0 = currentFight(rt);
  const savedTurn = f0 ? f0.nextTurnAt ?? f0.pausedTurnAt : null;
  rt.now = Math.max(rt.now, now);

  for (const ch of Object.values(rt.game.characters).sort((a, b) => (a.knockedOutUntil ?? 0) - (b.knockedOutUntil ?? 0))) {
    if (ch.knockedOutUntil !== null && ch.knockedOutUntil <= rt.now) {
      const id = ch.id;
      runGuarded(rt, () => { endKnockout(rt, id); settle(rt); }, () => { rt.game.characters[id]!.knockedOutUntil = null; });
    }
  }
  for (const item of dueItems(rt)) {
    if (item.order === 1 && item.at <= rt.now) runGuarded(rt, () => { item.run(rt); settle(rt); }, () => item.skip(rt));
  }
  for (let guard = 0; guard < 10_000; guard++) {
    const overdue = dueItems(rt).find((d) => d.order === 2 && d.at <= rt.now);
    if (!overdue) break;
    overdue.skip(rt);
  }
  const wake = dueItems(rt).find((d) => d.order === 4);
  if (wake && wake.at <= rt.now) runGuarded(rt, () => { wake.run(rt); settle(rt); }, () => wake.skip(rt));

  const f = currentFight(rt);
  if (f && f.sub === 'fighting' && !f.held) {
    if (rt.settings.fullIntervalAfterRestart || savedTurn === null) {
      f.nextTurnAt = rt.now + fightInterval(rt, f);
    } else if (savedTurn <= rt.now) {
      runGuarded(rt, () => { monsterTurn(rt, f); settle(rt); }, () => { f.nextTurnAt = rt.now + fightInterval(rt, f); });
    } else {
      f.nextTurnAt = savedTurn;
    }
  }
  settle(rt);
}
```

Overdue ticks are skipped one interval at a time until each status's next tick is in the future, so a long downtime never replays them.

- [ ] **Step 4: Implement `view.ts`**

`packages/engine/src/view.ts`:
```ts
import { makeCtx } from './ctx';
import { abilitiesOf, charRef, classOf, currentFight, hp, isKnockedOut, maxHp, monsterRef, partyRefs, stat, statusViews } from './entities';
import { modify } from './hooks';
import { CORE_HP } from './registry';
import type { EntityRef, Scene, Widget } from './pack';
import type { Runtime } from './runtime';
import { isFight } from './state';
import { formatDuration } from './units';

export interface AbilityOption {
  ability: string;
  name: string;
  from: 'class' | 'gear' | 'item';
  item: string | null;
  ready: boolean;
  readyAt: number | null;
  reason: string | null;
  needsChoice: boolean;
  targets: EntityRef[];
}

export interface View {
  phase: 'closed' | 'resting' | 'fight' | 'encounter';
  character: null | {
    id: string; name: string; level: number; xp: number; gold: number; hp: number; maxHp: number;
    knockedOut: boolean; knockedOutUntil: number | null; inParty: boolean; banned: boolean; class: string | null;
    stats: Record<string, number>;
    statuses: { status: string; until: number | null }[]; equipped: Record<string, string>;
    inventory: Record<string, { count: number; dormant: boolean }>;
  };
  abilities: AbilityOption[];
  panel: Widget;
  overlay: Scene | null;
  fight: null | {
    monster: { name: string; image: string | null; hp: number; maxHp: number; statuses: { status: string; until: number | null }[] };
    sub: 'fighting' | 'waiting'; held: boolean; nextTurnAt: number | null;
  };
  party: { id: string; name: string; hp: number; maxHp: number; knockedOut: boolean; class: string | null }[];
  adventure: null | { id: string; lined: string | null };
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export function view(rt: Runtime, characterId: string | null): View {
  const s = rt.game.session;
  const enc = s?.encounter ?? null;
  const phase: View['phase'] = !s ? 'closed' : !enc ? 'resting' : isFight(enc) ? 'fight' : 'encounter';
  const ch = characterId ? rt.game.characters[characterId] ?? null : null;
  const inParty = !!ch && !!s?.party.includes(ch.id);

  let character: View['character'] = null;
  let abilities: AbilityOption[] = [];
  if (ch) {
    const me = charRef(ch.id);
    const inventory: Record<string, { count: number; dormant: boolean }> = {};
    for (const [item, count] of Object.entries(ch.inventory)) inventory[item] = { count, dormant: !rt.reg.items.has(item) };
    character = {
      id: ch.id, name: ch.name, level: ch.level, xp: ch.xp, gold: ch.gold, hp: hp(rt, me), maxHp: maxHp(rt, me),
      knockedOut: isKnockedOut(rt, me), knockedOutUntil: ch.knockedOutUntil, inParty, banned: ch.banned,
      class: classOf(rt, ch)?.id ?? null,
      stats: Object.fromEntries([...rt.reg.stats.keys()].filter((id) => id !== CORE_HP).map((id) => [id, stat(rt, me, id)])),
      statuses: statusViews(rt, me).map((x) => ({ status: x.status, until: x.until })),
      equipped: { ...ch.equipped }, inventory,
    };
    abilities = abilitiesOf(rt, ch).map((src) => {
      const ab = rt.reg.abilities.get(src.ability)!;
      const rule = rt.reg.targeting.get(ab.target.rule);
      const until = ch.cooldowns[src.ability];
      let reason: string | null = null;
      if (!inParty) reason = 'Not in the party';
      else if (isKnockedOut(rt, me)) reason = "You're knocked out";
      else if (ab.when === 'fight' && !currentFight(rt)) reason = 'You can only use that during a fight';
      else if (until !== undefined && until > rt.now) reason = `On cooldown (${formatDuration(until - rt.now)})`;
      else {
        const can = safe(() => modify(rt, me, 'canUse', true as true | string, { ability: src.ability }), true as true | string);
        if (can !== true) reason = can;
      }
      const targets = rule ? safe(() => rule.def.candidates(makeCtx(rt, rule.pack), { user: me, params: ab.target.params }), []) : [];
      return {
        ability: src.ability, name: ab.name, from: src.from, item: src.item ?? null, ready: reason === null,
        readyAt: until !== undefined && until > rt.now ? until : null, reason, needsChoice: !!rule?.def.needsChoice, targets,
      };
    });
  }

  let panel: Widget = { type: 'none' };
  let overlay: Scene | null = null;
  if (enc && !isFight(enc)) {
    const kind = rt.reg.kinds.get(enc.kind);
    if (kind) {
      overlay = safe(() => kind.def.overlay(enc.state, enc.params), null);
      if (ch && inParty) {
        panel = safe(() => kind.def.panel(enc.state, { id: ch.id, inParty, gold: ch.gold, knockedOut: isKnockedOut(rt, charRef(ch.id)) }, enc.params), { type: 'none' } as Widget);
      }
    }
  }

  const f = currentFight(rt);
  const m = f?.monsters[0];
  return {
    phase, character, abilities, panel, overlay,
    fight: f && m ? {
      monster: {
        name: m.def.name, image: m.def.image, hp: m.hp, maxHp: maxHp(rt, monsterRef(m.id)),
        statuses: statusViews(rt, monsterRef(m.id)).map((x) => ({ status: x.status, until: x.until })),
      },
      sub: f.sub, held: f.held, nextTurnAt: f.nextTurnAt,
    } : null,
    party: partyRefs(rt).map((ref) => {
      const c = rt.game.characters[ref.id]!;
      return { id: c.id, name: c.name, hp: hp(rt, ref), maxHp: maxHp(rt, ref), knockedOut: isKnockedOut(rt, ref), class: classOf(rt, c)?.id ?? null };
    }),
    adventure: s?.adventure ? { ...s.adventure } : null,
  };
}
```

- [ ] **Step 5: Add `resume`, `adopt` and `view` to the engine**

In `packages/engine/src/engine.ts`, extend the `Engine` interface:
```ts
  resume(game: GameState, now: number): { game: GameState; events: GameEvent[] };
  adopt(game: GameState): GameState;
  view(game: GameState, characterId: string | null, now: number): View;
```
and the returned object:
```ts
    resume(game, now) {
      const rt = new Runtime(registry, structuredClone(game));
      resumeAt(rt, now);
      rt.game.clock = rt.now;
      return { game: rt.game, events: rt.events };
    },
    adopt(game) {
      const enc = game.session?.encounter;
      const missing = (what: string) => new EngineError('content-in-use', `The running ${what} uses content that is no longer available`);
      if (enc) {
        if (isFight(enc)) {
          const m = enc.monsters[0]!;
          const ok = registry.behaviors.has(m.def.behavior.behavior) && m.def.abilities.every((a) => registry.abilities.has(a));
          if (!ok) throw missing('fight');
        } else if (!registry.kinds.has(enc.kind)) {
          throw missing('encounter');
        }
      }
      const adv = game.session?.adventure;
      if (adv && !registry.adventures.has(adv.id)) throw missing('adventure');
      return game;
    },
    view(game, characterId, now) {
      const rt = new Runtime(registry, structuredClone(game));
      rt.now = Math.max(now, game.clock);
      return view(rt, characterId);
    },
```
with imports `resumeAt` from `./time`, `view, type View` from `./view`, `isFight` from `./state`.

Note `view` reads state at `now` without processing due timers; screens call `advance` on their own timer (Project 2). Read-only means the caller's game is never changed, which the view test checks.

In `index.ts` add:
```ts
export type { View, AbilityOption } from './view';
```

- [ ] **Step 6: Run to verify they pass**

Run: `pnpm vitest run packages/engine`
Expected: PASS (all engine tests).

- [ ] **Step 7: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): resume, adopt, runtime dormancy and view"
```

---

### Task 9: Criterion 2, determinism and a full-loop smoke test

**Files:**
- Test: `packages/engine/test/determinism.test.ts`

**Interfaces:**
- Consumes: the whole engine.

- [ ] **Step 1: Write the test**

`packages/engine/test/determinism.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Command } from '../src';
import { harness } from './helpers/harness';

const SCRIPT: [number, Command][] = [
  [0, { type: 'openSession' }],
  [0, { type: 'join', character: 'al', name: 'Al', pick: 'tp:club' }],
  [0, { type: 'join', character: 'mo', name: 'Mo', pick: 'tp:rod' }],
  [0, { type: 'join', character: 'cy', name: 'Cy', pick: 'tp:club' }],
  [0, { type: 'spawnMonster', monster: 'tp:ogre' }],
  [1000, { type: 'use', character: 'al', ability: 'tp:zap' }],
  [2000, { type: 'use', character: 'cy', ability: 'tp:whack' }],
  [16000, { type: 'use', character: 'mo', ability: 'tp:mend', chosen: { kind: 'character', id: 'al' } }],
  [31000, { type: 'use', character: 'al', ability: 'tp:whack' }],
  [41000, { type: 'use', character: 'cy', ability: 'tp:whack' }],
  [61000, { type: 'endEncounter', outcome: 'won' }],
  [62000, { type: 'closeSession' }],
];

function play(seed: number) {
  const h = harness({ seed });
  for (const [at, cmd] of SCRIPT) {
    h.at(at);
    const r = h.engine.apply(h.game, cmd, at);
    if (r.ok) { h.game = r.game; h.log.push(...r.events); }
    else h.log.push({ type: 'rejected', at, text: r.error.message, data: { code: r.error.code } });
  }
  return { events: h.log, game: h.game };
}

describe('determinism and the full loop (success criteria 2 and 4)', () => {
  it('the same seed and script give identical events and state', () => {
    const a = play(7);
    const b = play(7);
    expect(a.events).toEqual(b.events);
    expect(a.game).toEqual(b.game);
  });

  it('a different seed can change the outcome', () => {
    expect(JSON.stringify(play(7).events)).not.toEqual(JSON.stringify(play(8).events));
  });

  it('runs a whole fight with only the test pack loaded', () => {
    const { events, game } = play(7);
    const types = events.map((e) => e.type);
    expect(types).toContain('core:ability-used');
    expect(types).toContain('core:encounter-ended');
    expect(types).toContain('core:session-closed');
    expect(game.characters.al!.xp).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run, then run everything**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS. The "different seed" test relies on the ogre's random ability and target picks; if seeds 7 and 8 happen to produce identical logs, change the second seed to another value until they differ.

- [ ] **Step 3: Commit**

```bash
git add packages/engine
git commit -m "test(engine): determinism and full-loop smoke test"
```

---

## Plan B self-review notes

- Spec coverage: §5.2 operations and helpers (Task 2), §5.3 targeting (Task 2), §5.4 modifiers, reactions, chain limit (Task 2), §6.1 sessions (Task 3), §6.2 characters (Tasks 1, 4), §6.3 joining table (Task 3), §6.4 gear (Task 4), §6.5 fights (Task 4), §6.6 knockouts (Tasks 2, 5, 7), §6.7 encounter kinds (Task 6), §6.8 widgets and scenes via `view` (Task 8), §6.9 adventures (Task 6), §6.10 time and resume (Tasks 5, 8), §7.4 dormancy at runtime and `adopt` (Task 8), §11 API, commands and events (Tasks 3–8).
- Not here: the starter pack (Plan C), the loader (Plan C), the CLI and golden replays (Plan D).
