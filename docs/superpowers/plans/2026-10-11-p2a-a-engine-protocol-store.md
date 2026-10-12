# Project 2a, Plan A: Engine Changes, Protocol and Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the engine ready to be run by a server (event audiences, per-character timers, partial character state), add the shared `packages/protocol`, and build `apps/server`'s database layer: schema, migrations, crypto and the `Store`.

**Architecture:** The engine stays pure. It gains an optional `audience` on events, an encounter-kind `audience` hook, `engine.characterWake` and `commandCharacters`. A test proves that playing with only the needed characters loaded gives the same events as playing with all of them. `packages/protocol` holds the Zod schemas every client and the server share. `apps/server/src/store.ts` is the only code that talks to Postgres, through Drizzle on postgres.js.

**Tech Stack:** As in Project 1, plus `drizzle-orm@0.45.3`, `drizzle-kit@0.31.11`, `postgres@3.4.9`. Postgres 17 in Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-11-server-core-design.md` (rev 7), mainly §3, §6.2, §6.4, §7. Flagged decisions: `docs/superpowers/plans/2026-10-11-project-2a-README.md`.

**Prerequisite:** Project 1 merged (`main`). Docker running for Tasks 4–6.

## Global Constraints

- The engine stays pure: no I/O, no clock, no `Math.random` (`pnpm lint` checks `packages/engine/src` and `packs`).
- Dependency versions are exact and at least two weeks old: `drizzle-orm@0.45.3`, `drizzle-kit@0.31.11`, `postgres@3.4.9`, `zod@4.6.6`.
- Game data columns use `json`, not `jsonb` (README decision 1).
- Content is never stored in its own tables. A channel's config lives in `channels.config`, in the same shape as `channels/*.yaml` (spec §3).
- Character IDs say where they came from: `dev:<name>` in 2a (spec §3).
- `pnpm typecheck`, `pnpm lint` and `pnpm test` stay green after every task.

## Review Focus

1. **A secret shop's purchase**: a person expects every event it causes (gold spent, item given, the purchase, the shop opening and closing) to carry the members as its audience, and a public shop's events to carry none. Test in Task 1.
2. **A knocked-out character who leaves the party mid-fight**: a person expects them to stay loaded until the knockout ends, and the knockout to end on time. Test in Task 2.
3. **A character the streamer removed mid-fight, then a rest**: a person expects the flag to clear at the rest even though they're out of the party. Test in Task 2.
4. **Saving a character whose inventory keys were added in an unusual order**: a person expects the reloaded character to iterate in the same order. Test in Task 6.
5. **A tampered or foreign viewer token**: a person expects it to be refused, not to log someone in as another viewer. Test in Task 5.

---

## File map (this plan)

```
packages/engine/src/
  events.ts           + audience
  runtime.ts          emit(type, text, data, audience?)
  pack.ts             EncounterKindDef.audience, Ctx.emit opts
  ctx.ts              emit passes the audience
  encounters.ts       stampAudience at start / respond / advance / end
  time.ts             characterWakeAt
  commands.ts         commandCharacters
  engine.ts           engine.characterWake
  index.ts            exports
packages/engine/test/audience.test.ts
packages/engine/test/character-wake.test.ts
packs/starter/src/kinds.ts            shop.audience
packs/starter/test/secret-shop.test.ts
packs/starter/test/partial-state.test.ts
packages/protocol/
  package.json
  src/index.ts
  test/protocol.test.ts
apps/server/
  package.json
  drizzle.config.ts
  drizzle/             generated migrations
  src/db/schema.ts
  src/db/connect.ts
  src/crypto.ts
  src/store.ts
  src/index.ts
  test/helpers/db.ts
  test/crypto.test.ts
  test/store.test.ts
docker-compose.yml
```

---

### Task 1: Event audiences

**Files:**
- Modify: `packages/engine/src/events.ts`, `runtime.ts`, `pack.ts`, `ctx.ts`, `encounters.ts`
- Modify: `packs/starter/src/kinds.ts` (shop)
- Test: `packages/engine/test/audience.test.ts`, `packs/starter/test/secret-shop.test.ts`

**Interfaces:**
- Produces: `GameEvent.audience?: string[]` (character IDs; absent = public). `EncounterKindDef.audience?(state, params): string[] | null`. `Ctx.emit(type, data, text, opts?: { audience?: EntityRef[] })`.

- [ ] **Step 1: Write the failing engine test**

`packages/engine/test/audience.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { PackApi } from '../src/pack';
import { harness } from './helpers/harness';

const kinds = (api: PackApi) => {
  api.encounterKind<{ members: string[] }>('hush', {
    name: 'Hush',
    outcomes: () => ['done'],
    start: (ctx) => {
      ctx.emit('tp:whisper', {}, 'psst');
      return { members: ctx.party().map((e) => e.id) };
    },
    respond: (ctx, s, ch) => { ctx.heal(null, ch, 1); return s; },
    wakeAt: () => null,
    advance: (_ctx, s) => s,
    endEarly: () => 'done',
    panel: () => ({ type: 'none' }),
    overlay: () => null,
    audience: (s) => s.members,
  });
  api.encounterKind<null>('tell', {
    name: 'Tell',
    outcomes: () => ['done'],
    start: () => null,
    respond: (ctx, s, ch) => { ctx.emit('tp:told', {}, 'just you', { audience: [ch] }); return s; },
    wakeAt: () => null,
    advance: (_ctx, s) => s,
    endEarly: () => 'done',
    panel: () => ({ type: 'none' }),
    overlay: () => null,
  });
};

describe('event audiences (spec 2a §7.2)', () => {
  it('stamps every event while handling an encounter that declares an audience', () => {
    const h = harness({ plugins: kinds });
    h.open(); h.join('al'); h.join('bo');
    const started = h.do({ type: 'startEncounter', encounter: { 'tp:hush': {} } });
    expect(started.map((e) => [e.type, e.audience])).toEqual([
      ['tp:whisper', ['al', 'bo']],
      ['core:encounter-started', ['al', 'bo']],
    ]);
    h.do({ type: 'leave', character: 'bo' });
    const healed = h.do({ type: 'respond', character: 'al', input: {} });
    expect(healed.every((e) => JSON.stringify(e.audience) === '["al","bo"]')).toBe(true);
    expect(healed.some((e) => e.type === 'core:healed')).toBe(true);
    const ended = h.do({ type: 'endEncounter' });
    expect(ended.find((e) => e.type === 'core:encounter-ended')!.audience).toEqual(['al', 'bo']);
  });

  it('events outside such an encounter stay public', () => {
    const h = harness({ plugins: kinds });
    h.open();
    const [joined] = h.join('al');
    expect(joined!.audience).toBeUndefined();
  });

  it('a plugin can address one emit to some characters', () => {
    const h = harness({ plugins: kinds });
    h.open(); h.join('al'); h.join('bo');
    h.do({ type: 'startEncounter', encounter: { 'tp:tell': {} } });
    const out = h.do({ type: 'respond', character: 'bo', input: {} });
    expect(out.map((e) => [e.type, e.audience])).toEqual([['tp:told', ['bo']]]);
  });

  it('an audience hook that returns something other than a list of IDs is a plugin error', () => {
    const h = harness({
      plugins: (api) => api.encounterKind('bad', {
        name: 'Bad', outcomes: () => ['done'], start: () => null, respond: (_c, s) => s, wakeAt: () => null,
        advance: (_c, s) => s, endEarly: () => 'done', panel: () => ({ type: 'none' }), overlay: () => null,
        audience: () => 'everyone' as unknown as string[],
      }),
    });
    h.open();
    expect(h.fail({ type: 'startEncounter', encounter: { 'tp:bad': {} } }).code).toBe('plugin-error');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/engine/test/audience.test.ts`
Expected: FAIL. TypeScript errors are ignored by Vitest, so the first test fails on `audience` being `undefined`.

- [ ] **Step 3: Implement**

`packages/engine/src/events.ts`:

```ts
export interface GameEvent {
  type: string;
  at: number;
  text: string;
  data: Record<string, unknown>;
  /** Character IDs who may see this event. Absent means public (spec 2a §7.2). */
  audience?: string[];
}
```

`packages/engine/src/runtime.ts`, replace `emit`:

```ts
  emit(type: string, text: string, data: Record<string, unknown> = {}, audience?: string[]): void {
    this.events.push({ type, at: this.now, text, data, ...(audience ? { audience } : {}) });
  }
```

`packages/engine/src/pack.ts`: add to `EncounterKindDef<S>` after `overlay`:

```ts
  /** Who may see this encounter's events (spec 2a §7.2). null or absent: everyone. */
  audience?(state: S, params: any): string[] | null;
```

and change `Ctx.emit`:

```ts
  emit(type: string, data: Record<string, unknown>, text: string, opts?: { audience?: EntityRef[] }): void;
```

`packages/engine/src/ctx.ts`, replace the `emit` entry in `makeCtx`:

```ts
    emit: (type, data, text, opts) => {
      if (!type.startsWith(`${pack}:`)) throw new Error(`Custom event types must start with '${pack}:'`);
      const audience = opts?.audience?.filter((e) => e.kind === 'character').map((e) => e.id);
      rt.emit(type, text, data, audience);
    },
```

`packages/engine/src/encounters.ts`: add the helper below the imports (import `PluginError` from `./errors` alongside `Rejection`):

```ts
/** Spec 2a §7.2: events produced while handling a kind encounter get its audience, if it declares one. */
function stampAudience(rt: Runtime, enc: KindEncounterState, from: number): void {
  const kind = rt.reg.kinds.get(enc.kind);
  if (!kind?.def.audience) return;
  const audience = callPlugin(kind.pack, `${kind.id} audience`, () => {
    const a = kind.def.audience!(enc.state, enc.params);
    if (a !== null && (!Array.isArray(a) || a.some((x) => typeof x !== 'string'))) throw new Error('audience must return a list of character IDs or null');
    return a;
  });
  if (!audience) return;
  for (let i = from; i < rt.events.length; i++) {
    const e = rt.events[i]!;
    if (!e.audience) e.audience = [...audience];
  }
}
```

In `startEncounter`, replace the lines from `const enc: KindEncounterState = …` to the `react(...)` call with:

```ts
  const enc: KindEncounterState = { kind: spec.kind, startedAt: rt.now, origin, params: spec.params, state: null };
  const from = rt.events.length;
  s.encounter = enc;
  enc.state = callPlugin(kind.pack, `${kind.id} start`, () => kind.def.start(makeCtx(rt, kind.pack), spec.params));
  rt.emit('core:encounter-started', `${kind.def.name} begins`, { kind: spec.kind });
  stampAudience(rt, enc, from);
  react(rt, { type: 'encounterStarted', kind: spec.kind }, present(rt));
```

In `finishEncounter`, replace the block from `if (isFight(enc)) endFight(...)` to the `rt.emit('core:encounter-ended', …)` line with:

```ts
  const from = rt.events.length;
  if (isFight(enc)) endFight(rt, enc, outcome);
  else {
    const kind = rt.reg.kinds.get(enc.kind)!;
    if (kind.def.onEnd) callPlugin(kind.pack, `${kind.id} onEnd`, () => kind.def.onEnd!(makeCtx(rt, kind.pack), enc.state, outcome, enc.params));
  }
  const who = present(rt);
  s.encounter = null;
  rt.emit('core:encounter-ended', `The encounter ends (${outcome})`, { kind: enc.kind, outcome });
  if (!isFight(enc)) stampAudience(rt, enc, from);
```

In `respond`, replace the last statement with:

```ts
  const from = rt.events.length;
  enc.state = callPlugin(kind.pack, `${kind.id} respond`, () =>
    kind.def.respond(makeCtx(rt, kind.pack), enc.state, charRef(id), value, enc.params));
  stampAudience(rt, enc, from);
```

In `kindWake`, replace the last statement with:

```ts
  const from = rt.events.length;
  enc.state = callPlugin(kind.pack, `${kind.id} advance`, () => kind.def.advance(makeCtx(rt, kind.pack), enc.state, enc.params));
  stampAudience(rt, enc, from);
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/engine/test/audience.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing starter test for the secret shop**

`packs/starter/test/secret-shop.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { starterHarness } from './helpers';

const shop = (secret: boolean) => ({
  type: 'startEncounter' as const,
  encounter: { 'starter:shop': { stock: [{ item: 'starter:health-potion', price: 5 }], secret } },
});

describe('secret shop audience (engine spec §9.6, spec 2a §7.2)', () => {
  it('every event of a secret shop goes only to its members', async () => {
    const h = await starterHarness();
    h.open(); h.join('al'); h.join('bo');
    h.do({ type: 'giveGold', target: 'al', amount: 10 });
    const opened = h.do(shop(true));
    h.join('cy');
    const bought = h.do({ type: 'respond', character: 'al', input: { buy: 'starter:health-potion' } });
    const closed = h.do({ type: 'endEncounter' });
    const all = [...opened, ...bought, ...closed];
    expect(bought.map((e) => e.type)).toContain('starter:purchased');
    expect(all.every((e) => JSON.stringify(e.audience) === '["al","bo"]')).toBe(true);
  });

  it("a public shop's events have no audience", async () => {
    const h = await starterHarness();
    h.open(); h.join('al');
    h.do({ type: 'giveGold', target: 'al', amount: 10 });
    const events = [...h.do(shop(false)), ...h.do({ type: 'respond', character: 'al', input: { buy: 'starter:health-potion' } })];
    expect(events.every((e) => e.audience === undefined)).toBe(true);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run packs/starter/test/secret-shop.test.ts`
Expected: FAIL in the first test (`audience` undefined); the second passes.

- [ ] **Step 7: Add the audience to the shop**

In `packs/starter/src/kinds.ts`, in the `shop` kind, add after `overlay: …`:

```ts
    audience: (s, params) => (params.secret ? s.members : null),
```

- [ ] **Step 8: Run the starter and engine suites**

Run: `pnpm vitest run packs/starter packages/engine && pnpm typecheck && pnpm lint`
Expected: all PASS. The golden tests in `apps/cli` also still pass (`pnpm test`): no golden script uses a secret shop, and absent audiences don't change the output.

- [ ] **Step 9: Commit**

```bash
git add packages/engine packs/starter
git commit -m "feat(engine): event audiences; secret shop events go to its members"
```

---

### Task 2: Per-character timers, command characters and the partial-state proof

**Files:**
- Modify: `packages/engine/src/time.ts`, `commands.ts`, `engine.ts`, `index.ts`
- Test: `packages/engine/test/character-wake.test.ts`, `packs/starter/test/partial-state.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `engine.characterWake(game: GameState, characterId: string): number | null`: the earliest of the character's knockout end, status end times and status next ticks. Cooldowns are not included.
  - `commandCharacters(raw: unknown): string[]` (exported from `@dndm/engine`): the character IDs an engine command names. Returns `[]` for anything that isn't a valid command.
  - `VIEWER_COMMANDS` exported from `@dndm/engine`.

- [ ] **Step 1: Write the failing unit tests**

`packages/engine/test/character-wake.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { commandCharacters } from '../src';
import { harness } from './helpers/harness';

describe('engine.characterWake (spec 2a §6.4)', () => {
  it('is null for a character with no timers, and ignores cooldowns', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    h.use('al', 'tp:whack');
    expect(Object.keys(h.char('al').cooldowns).length).toBeGreaterThan(0);
    expect(h.engine.characterWake(h.game, 'al')).toBeNull();
  });

  it('is the knockout end, or the earliest status end or tick', () => {
    const h = harness();
    h.open(); h.join('al'); h.join('bo');
    h.at(1000).do({ type: 'knockOut', character: 'al' });
    expect(h.engine.characterWake(h.game, 'al')).toBe(h.char('al').knockedOutUntil);
    h.do({ type: 'applyStatus', target: { kind: 'character', id: 'bo' }, status: 'tp:snooze', duration: '10s', params: { factor: 2 } });
    expect(h.engine.characterWake(h.game, 'bo')).toBe(11000);
  });

  it('is null for a character who is not in the state', () => {
    const h = harness();
    expect(h.engine.characterWake(h.game, 'nobody')).toBeNull();
  });
});

describe('commandCharacters (spec 2a §6.2)', () => {
  it('lists every character a command names', () => {
    expect(commandCharacters({ type: 'join', character: 'al' })).toEqual(['al']);
    expect(commandCharacters({ type: 'use', character: 'al', ability: 'x', chosen: { kind: 'character', id: 'bo' } })).toEqual(['al', 'bo']);
    expect(commandCharacters({ type: 'applyStatus', target: { kind: 'character', id: 'cy' }, status: 's' })).toEqual(['cy']);
    expect(commandCharacters({ type: 'applyStatus', target: { kind: 'monster', id: 'm1' }, status: 's' })).toEqual([]);
    expect(commandCharacters({ type: 'giveGold', target: 'al', amount: 1 })).toEqual(['al']);
    expect(commandCharacters({ type: 'giveGold', target: 'party', amount: 1 })).toEqual([]);
    expect(commandCharacters({ type: 'healParty' })).toEqual([]);
  });

  it('returns nothing for something that is not a command', () => {
    expect(commandCharacters({ type: 'nope', character: 'al' })).toEqual([]);
    expect(commandCharacters('join')).toEqual([]);
  });
});
```

The `tp` test pack's ability `tp:whack` has a 10 s cooldown; its status `tp:snooze` takes a `factor` param.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/test/character-wake.test.ts`
Expected: FAIL (`characterWake is not a function`, `commandCharacters` not exported).

- [ ] **Step 3: Implement**

`packages/engine/src/time.ts`, add at the end:

```ts
/** One character's earliest timer: knockout end, status end or status tick (spec 2a §6.4). Cooldowns don't count. */
export function characterWakeAt(rt: Runtime, id: string): number | null {
  const prefix = `character:${id}:`;
  const mine = dueItems(rt).filter((d) => (d.order === 0 && d.key === id) || ((d.order === 1 || d.order === 2) && d.key.startsWith(prefix)));
  return mine.length ? Math.min(...mine.map((d) => d.at)) : null;
}
```

`packages/engine/src/commands.ts`, add at the end:

```ts
/** The character IDs a command names (spec 2a §6.2). The server loads them before applying it. */
export function commandCharacters(raw: unknown): string[] {
  let cmd: Command;
  try { cmd = checkCommand(raw); } catch { return []; }
  const out = new Set<string>();
  if ('character' in cmd && typeof cmd.character === 'string') out.add(cmd.character);
  if (cmd.type === 'use' && cmd.chosen?.kind === 'character') out.add(cmd.chosen.id);
  if ((cmd.type === 'applyStatus' || cmd.type === 'removeStatus') && cmd.target.kind === 'character') out.add(cmd.target.id);
  if ((cmd.type === 'giveXp' || cmd.type === 'giveGold' || cmd.type === 'giveItem') && cmd.target !== 'party') out.add(cmd.target);
  return [...out];
}
```

`packages/engine/src/engine.ts`: import `characterWakeAt` from `./time`, add to the `Engine` interface:

```ts
  /** The character's earliest timer, or null (spec 2a §6.4). Reads only; doesn't copy the game. */
  characterWake(game: GameState, characterId: string): number | null;
```

and to the returned object:

```ts
    characterWake: (game, characterId) => (game.characters[characterId] ? characterWakeAt(new Runtime(registry, game), characterId) : null),
```

`packages/engine/src/index.ts`, add:

```ts
export { commandCharacters, VIEWER_COMMANDS } from './commands';
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run packages/engine/test/character-wake.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the partial-state proof**

This test plays one script twice: once with every character in the state, and once the way the server will (spec §6.2): characters are dropped as soon as no rule keeps them, and loaded from a store before any command that names them. Opening a session loads the removed characters. Both runs must produce the same events and the same saved characters.

`packs/starter/test/partial-state.test.ts`:

```ts
import { type Character, type Command, commandCharacters, type Engine, type GameState } from '@dndm/engine';
import { describe, expect, it } from 'vitest';
import { starterHarness } from './helpers';

type Step = Command | number;

const ko = (id: string): Command => ({ type: 'knockOut', character: id });
const join = (id: string, pick = 'starter:sword'): Command => ({ type: 'join', character: id, name: id, pick });

const SCRIPT: Step[] = [
  { type: 'openSession' }, join('al'), join('bo', 'starter:shield'), join('cy', 'starter:staff'),
  { type: 'spawnMonster', monster: 'starter:slime' },
  { type: 'use', character: 'al', ability: 'starter:attack' },
  ko('bo'), { type: 'leave', character: 'bo' },                       // knocked out and gone: must stay loaded
  { type: 'applyStatus', target: { kind: 'character', id: 'cy' }, status: 'starter:drowsy', duration: '40s', params: { multiplier: 2 } },
  { type: 'removePlayer', character: 'cy' },                          // removed mid-fight: flag must clear at rest
  20_000,
  { type: 'giveGold', target: 'dd', amount: 5 },                     // never seen: rejected the same way in both runs
  join('dd'), { type: 'giveGold', target: 'dd', amount: 5 }, { type: 'leave', character: 'dd' },
  70_000,
  { type: 'endEncounter', outcome: 'won' },
  join('cy', 'starter:staff'), join('bo', 'starter:shield'),
  { type: 'giveGold', target: 'dd', amount: 3 },                     // dd was dropped: loaded again from the store
  { type: 'spawnMonster', monster: 'starter:slime' },
  30_000,
  { type: 'closeSession' }, { type: 'openSession' }, join('al'),
];

interface Run { events: unknown[]; characters: Record<string, Character> }

function full(engine: Engine): Run {
  let game: GameState = engine.newGame({ seed: 7 });
  let now = 0;
  const events: unknown[] = [];
  for (const step of SCRIPT) {
    if (typeof step === 'number') {
      now += step;
      const r = engine.advance(game, now);
      game = r.game; events.push(...r.events);
      continue;
    }
    const r = engine.apply(game, step, now);
    if (r.ok) { game = r.game; events.push(...r.events); } else events.push({ rejected: r.error.code });
  }
  return { events, characters: game.characters };
}

function partial(engine: Engine): Run {
  let game: GameState = engine.newGame({ seed: 7 });
  let now = 0;
  const events: unknown[] = [];
  const store = new Map<string, Character>();
  const waits = engine.registry.settings.streamerRemovalWaitsForRest;
  const load = (ids: string[]) => {
    for (const id of ids) if (!game.characters[id] && store.has(id)) game.characters[id] = structuredClone(store.get(id)!);
  };
  const saveAndDrop = () => {
    for (const [id, ch] of Object.entries(game.characters)) store.set(id, structuredClone(ch));
    const s = game.session;
    for (const [id, ch] of Object.entries(game.characters)) {
      const keep = !!s?.party.includes(id) || engine.characterWake(game, id) !== null || (!!s && waits && ch.removedByStreamer);
      if (!keep) delete game.characters[id];
    }
  };
  for (const step of SCRIPT) {
    if (typeof step === 'number') {
      now += step;
      const r = engine.advance(game, now);
      game = r.game; events.push(...r.events);
    } else {
      load(commandCharacters(step));
      if (step.type === 'openSession' && waits) load([...store.values()].filter((c) => c.removedByStreamer).map((c) => c.id));
      const r = engine.apply(game, step, now);
      if (r.ok) { game = r.game; events.push(...r.events); } else events.push({ rejected: r.error.code });
    }
    saveAndDrop();
  }
  return { events, characters: Object.fromEntries(store) };
}

describe('partial character state (spec 2a §7.1)', () => {
  it('gives the same events and characters as keeping everyone loaded', async () => {
    const { engine } = await starterHarness();
    const a = full(engine);
    const b = partial(engine);
    expect(b.events).toEqual(a.events);
    expect(b.characters).toEqual(a.characters);
    // The script really exercised the rules it's meant to.
    expect(a.events).toContainEqual(expect.objectContaining({ type: 'core:knockout-ended' }));
    expect(a.characters.cy!.removedByStreamer).toBe(false);
  });
});
```



- [ ] **Step 6: Run it**

Run: `pnpm vitest run packs/starter/test/partial-state.test.ts`
Expected: PASS. If it fails, the engine reaches for a character the rules dropped: find the place with `grep -n "Object.values(rt.game.characters)" packages/engine/src` and make it depend only on characters the §6.2 rules keep loaded. Don't change the test's rules to fit the engine.

- [ ] **Step 7: Run everything and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS.

```bash
git add packages/engine packs/starter
git commit -m "feat(engine): characterWake, commandCharacters; prove partial character state"
```

---

### Task 3: `packages/protocol`

**Files:**
- Create: `packages/protocol/package.json`, `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/protocol.test.ts`

**Interfaces:**
- Consumes: `GameEvent`, `View` types from `@dndm/engine`.
- Produces (all exported from `@dndm/protocol`):
  - `Role = 'dock' | 'overlay' | 'viewer'`
  - `commandRequestSchema` → `{ id: string; command: { type: string; … } }`
  - `serverCommandSchema`, `type ServerCommand`, `SERVER_COMMANDS`, `READ_ONLY_COMMANDS`, `isServerCommand(type: string): boolean`
  - `type Answer = { ok: true; events: GameEvent[]; result?: unknown } | { ok: false; error: ErrorBody }`, `type ErrorBody = { code: string; message: string }`
  - `httpStatus(code: string): number`
  - `clientMessageSchema` (`{ type: 'hello'; token }`), `type ServerMessage`
  - `devLoginSchema` (`{ channel: uuid; viewer: /^[a-z0-9_]{1,25}$/i }`)
  - `WS_CLOSE = { unauthorized: 4401, revoked: 4403, rateLimited: 4429 }`
  - `type ConfigDoc = Record<string, unknown>`

- [ ] **Step 1: Create the package**

`packages/protocol/package.json`:

```json
{
  "name": "@dndm/protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@dndm/engine": "workspace:*",
    "zod": "4.6.6"
  }
}
```

Run: `pnpm install`
Expected: the lockfile gains `@dndm/protocol`.

- [ ] **Step 2: Write the failing test**

`packages/protocol/test/protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  clientMessageSchema, commandRequestSchema, devLoginSchema, httpStatus, isServerCommand, serverCommandSchema,
} from '../src';

describe('protocol', () => {
  it('accepts a command request with a short request ID', () => {
    expect(commandRequestSchema.safeParse({ id: 'r1', command: { type: 'openSession' } }).success).toBe(true);
    expect(commandRequestSchema.safeParse({ id: '', command: { type: 'openSession' } }).success).toBe(false);
    expect(commandRequestSchema.safeParse({ id: 'x'.repeat(65), command: { type: 'openSession' } }).success).toBe(false);
    expect(commandRequestSchema.safeParse({ id: 'r1', command: {} }).success).toBe(false);
    expect(commandRequestSchema.safeParse({ id: 'r1', command: { type: 'go' }, extra: 1 }).success).toBe(false);
  });

  it('knows the server commands and their shapes', () => {
    expect(isServerCommand('updateConfig')).toBe(true);
    expect(isServerCommand('openSession')).toBe(false);
    expect(serverCommandSchema.safeParse({ type: 'updateConfig', config: { packs: [] }, basedOn: 1 }).success).toBe(true);
    expect(serverCommandSchema.safeParse({ type: 'updateConfig', config: { packs: [] } }).success).toBe(false);
    expect(serverCommandSchema.safeParse({ type: 'getConfig', extra: true }).success).toBe(false);
  });

  it('maps error codes to HTTP statuses (README decision 6)', () => {
    expect(httpStatus('bad-command')).toBe(400);
    expect(httpStatus('stale-config')).toBe(409);
    expect(httpStatus('rate-limited')).toBe(429);
    expect(httpStatus('save-failed')).toBe(503);
    expect(httpStatus('not-in-party')).toBe(200);
  });

  it('checks the WebSocket hello and dev login', () => {
    expect(clientMessageSchema.safeParse({ type: 'hello', token: 't' }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: 'hello' }).success).toBe(false);
    const channel = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
    expect(devLoginSchema.safeParse({ channel, viewer: 'alice_2' }).success).toBe(true);
    expect(devLoginSchema.safeParse({ channel, viewer: 'al ice' }).success).toBe(false);
    expect(devLoginSchema.safeParse({ channel: 'nope', viewer: 'alice' }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run packages/protocol`
Expected: FAIL (cannot find `../src`).

- [ ] **Step 4: Implement**

`packages/protocol/src/index.ts`:

```ts
import type { GameEvent, View } from '@dndm/engine';
import { z } from 'zod';

export type Role = 'dock' | 'overlay' | 'viewer';
export type ConfigDoc = Record<string, unknown>;
export interface ErrorBody { code: string; message: string }
export type Answer = { ok: true; events: GameEvent[]; result?: unknown } | { ok: false; error: ErrorBody };

/** Spec 2a §4.1. Engine rejections are normal answers (200); these codes are the server's own. */
const STATUS: Record<string, number> = {
  'bad-command': 400,
  unauthorized: 401,
  forbidden: 403,
  'streamer-only': 403,
  'unknown-channel': 404,
  'stale-config': 409,
  'content-in-use': 409,
  'invalid-config': 422,
  'rate-limited': 429,
  internal: 500,
  'save-failed': 503,
};
export function httpStatus(code: string): number {
  return STATUS[code] ?? 200;
}

export const requestIdSchema = z.string().min(1).max(64);

export const commandRequestSchema = z.object({
  id: requestIdSchema,
  command: z.looseObject({ type: z.string().min(1) }),
}).strict();
export type CommandRequest = z.infer<typeof commandRequestSchema>;

const configDoc = z.record(z.string(), z.unknown());
export const serverCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('getConfig') }).strict(),
  z.object({ type: z.literal('validateConfig'), config: configDoc }).strict(),
  z.object({ type: z.literal('updateConfig'), config: configDoc, basedOn: z.number().int().min(1) }).strict(),
  z.object({ type: z.literal('regenerateDockUrl') }).strict(),
  z.object({ type: z.literal('regenerateOverlayUrl') }).strict(),
]);
export type ServerCommand = z.infer<typeof serverCommandSchema>;
export const SERVER_COMMANDS = ['getConfig', 'validateConfig', 'updateConfig', 'regenerateDockUrl', 'regenerateOverlayUrl'] as const;
export const READ_ONLY_COMMANDS = ['getConfig', 'validateConfig'] as const;
export const isServerCommand = (type: string): boolean => (SERVER_COMMANDS as readonly string[]).includes(type);
export const isReadOnlyCommand = (type: string): boolean => (READ_ONLY_COMMANDS as readonly string[]).includes(type);

export const clientMessageSchema = z.object({ type: z.literal('hello'), token: z.string().min(1) }).strict();
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | { type: 'welcome'; role: Role; character: string | null; view: View }
  | { type: 'events'; events: GameEvent[] }
  | { type: 'view'; view: View }
  | { type: 'config-changed'; configVersion: number }
  | { type: 'error'; code: string; message: string };

export const WS_CLOSE = { unauthorized: 4401, revoked: 4403, rateLimited: 4429 } as const;

export const devLoginSchema = z.object({
  channel: z.uuid(),
  viewer: z.string().regex(/^[a-z0-9_]{1,25}$/i),
}).strict();
export type DevLogin = z.infer<typeof devLoginSchema>;
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm vitest run packages/protocol && pnpm typecheck`
Expected: PASS (4 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol pnpm-lock.yaml
git commit -m "feat(protocol): shared request, answer and WebSocket schemas"
```

---

### Task 4: `apps/server` skeleton, Postgres, schema and migrations

**Files:**
- Create: `docker-compose.yml`, `apps/server/package.json`, `apps/server/drizzle.config.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/db/connect.ts`, `apps/server/src/index.ts`, `apps/server/test/helpers/db.ts`, `apps/server/test/schema.test.ts`
- Generated: `apps/server/drizzle/*`

**Interfaces:**
- Produces:
  - `connect(url: string): { db: Db; sql: Sql }` and `type Db` (`apps/server/src/db/connect.ts`)
  - `migrate(url: string): Promise<void>` (applies `apps/server/drizzle`)
  - tables `channels`, `rooms`, `characters`, and `type RecentRequest = { key: string; at: number; answer: unknown; replacedHash?: string }`
  - test helper `freshDb(): Promise<{ url: string; db: Db; sql: Sql; drop(): Promise<void> }>`

- [ ] **Step 1: Docker Compose and the package**

`docker-compose.yml` (repo root):

```yaml
# Local Postgres for the server and its tests (Project 2a plans README).
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: dndm
      POSTGRES_PASSWORD: dndm
      POSTGRES_DB: dndm
    ports:
      - "5455:5432"
```

`apps/server/package.json`:

```json
{
  "name": "@dndm/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@dndm/engine": "workspace:*",
    "@dndm/pack-loader": "workspace:*",
    "@dndm/protocol": "workspace:*",
    "drizzle-orm": "0.45.3",
    "postgres": "3.4.9",
    "zod": "4.6.6"
  },
  "devDependencies": {
    "drizzle-kit": "0.31.11"
  }
}
```

`apps/server/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://dndm:dndm@localhost:5455/dndm' },
});
```

Run: `pnpm install && docker compose up -d postgres`
Expected: install succeeds; the container is running (`docker compose ps`).

- [ ] **Step 2: Write the schema**

`apps/server/src/db/schema.ts`:

```ts
import type { Character, SessionState } from '@dndm/engine';
import { bigint, boolean, index, integer, json, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** A repeated request ID's first answer (spec 2a §4.1). `replacedHash`: the token a regenerate replaced. */
export interface RecentRequest { key: string; at: number; answer: unknown; replacedHash?: string }

// json, not jsonb: jsonb reorders object keys, and the engine iterates some objects (README decision 1).
export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  twitchId: text('twitch_id').unique(),
  config: json('config').$type<Record<string, unknown>>().notNull(),
  configVersion: integer('config_version').notNull().default(1),
  dockTokenHash: text('dock_token_hash').notNull().unique(),
  dockTokenEnc: text('dock_token_enc').notNull(),
  overlayTokenHash: text('overlay_token_hash').notNull().unique(),
  overlayTokenEnc: text('overlay_token_enc').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rooms = pgTable('rooms', {
  channelId: uuid('channel_id').primaryKey().references(() => channels.id, { onDelete: 'cascade' }),
  stateVersion: integer('state_version').notNull(),
  clock: bigint('clock', { mode: 'number' }).notNull(),
  rng: bigint('rng', { mode: 'number' }).notNull(),
  seq: integer('seq').notNull(),
  session: json('session').$type<SessionState>(),
  recentRequests: json('recent_requests').$type<RecentRequest[]>().notNull().default([]),
  savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
});

export const characters = pgTable('characters', {
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  id: text('id').notNull(),
  data: json('data').$type<Character>().notNull(),
  wakeAt: bigint('wake_at', { mode: 'number' }),
  removed: boolean('removed').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.channelId, t.id] }),
  index('characters_wake_at').on(t.wakeAt),
  index('characters_removed').on(t.channelId, t.removed),
]);
```

`apps/server/src/db/connect.ts`:

```ts
import { join } from 'node:path';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate as runMigrations } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;
export type Sql = postgres.Sql;

export const MIGRATIONS = join(import.meta.dirname, '..', '..', 'drizzle');

export function connect(url: string, opts: { max?: number } = {}): { db: Db; sql: Sql } {
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  return { db: drizzle(sql, { schema }), sql };
}

export async function migrate(url: string): Promise<void> {
  const { db, sql } = connect(url, { max: 1 });
  try {
    await runMigrations(db, { migrationsFolder: MIGRATIONS });
  } finally {
    await sql.end();
  }
}
```

`apps/server/src/index.ts`:

```ts
export { connect, migrate, type Db, type Sql } from './db/connect';
```

- [ ] **Step 3: Generate the first migration**

Run: `cd apps/server && pnpm exec drizzle-kit generate --name init && cd ../..`
Expected: `apps/server/drizzle/0000_init.sql` plus `meta/`. Open the SQL and check it has the three tables, `json` (not `jsonb`) columns, the unique constraints and both indexes.

- [ ] **Step 4: Write the test helper and a failing schema test**

`apps/server/test/helpers/db.ts`:

```ts
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { connect, type Db, migrate, type Sql } from '../../src/db/connect';

export const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://dndm:dndm@localhost:5455/dndm';

/** A brand-new, migrated database for one test file. */
export async function freshDb(): Promise<{ url: string; db: Db; sql: Sql; drop(): Promise<void> }> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  const name = `dndm_t_${randomBytes(6).toString('hex')}`;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } catch (e) {
    await admin.end();
    throw new Error(`Postgres isn't reachable at ${ADMIN_URL}. Run: docker compose up -d postgres (${(e as Error).message})`);
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  await migrate(url.toString());
  const { db, sql } = connect(url.toString(), { max: 5 });
  return {
    url: url.toString(), db, sql,
    async drop() {
      await sql.end();
      await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
```

`apps/server/test/schema.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from './helpers/db';

let t: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => { t = await freshDb(); });
afterAll(async () => { await t.drop(); });

describe('migrations (spec 2a §3)', () => {
  it('create the three tables with json game data', async () => {
    const cols = await t.sql<{ table_name: string; column_name: string; data_type: string }[]>`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name in ('channels', 'rooms', 'characters')`;
    const type = (table: string, col: string) => cols.find((c) => c.table_name === table && c.column_name === col)?.data_type;
    expect(type('channels', 'config')).toBe('json');
    expect(type('rooms', 'session')).toBe('json');
    expect(type('characters', 'data')).toBe('json');
    expect(type('characters', 'wake_at')).toBe('bigint');
  });

  it('lets several channels have no Twitch ID', async () => {
    const row = (n: number) => ({ name: `c${n}`, config: '{}', dock: `d${n}`, overlay: `o${n}` });
    for (const r of [row(1), row(2)]) {
      await t.sql`insert into channels (name, config, dock_token_hash, dock_token_enc, overlay_token_hash, overlay_token_enc)
        values (${r.name}, ${r.config}::json, ${r.dock}, ${r.dock}, ${r.overlay}, ${r.overlay})`;
    }
    const [{ count }] = await t.sql<{ count: string }[]>`select count(*) from channels where twitch_id is null`;
    expect(Number(count)).toBe(2);
  });
});
```

- [ ] **Step 5: Run it**

Run: `pnpm vitest run apps/server/test/schema.test.ts`
Expected: PASS (2 tests). If the run says Postgres isn't reachable, start it with `docker compose up -d postgres`.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml apps/server pnpm-lock.yaml
git commit -m "feat(server): package, Postgres schema and first migration"
```

---

### Task 5: Crypto: tokens, encryption and viewer tokens

**Files:**
- Create: `apps/server/src/crypto.ts`
- Test: `apps/server/test/crypto.test.ts`

**Interfaces:**
- Produces:
  - `newToken(): string` (32 random bytes, base64url)
  - `hashToken(token: string): string` (SHA-256, hex)
  - `class Secrets { constructor(secret: string); encrypt(text: string): string; decrypt(box: string): string; signViewer(v: ViewerClaim): string; verifyViewer(token: string): ViewerClaim | null }`
  - `type ViewerClaim = { channel: string; character: string }`
  - `isViewerToken(token: string): boolean` (starts with `v1.`)

- [ ] **Step 1: Write the failing test**

`apps/server/test/crypto.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hashToken, isViewerToken, newToken, Secrets } from '../src/crypto';

const s = new Secrets('a-long-enough-test-secret');

describe('tokens and secrets (spec 2a §4.3)', () => {
  it('makes 32-byte tokens and stable hashes', () => {
    const t = newToken();
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    expect(newToken()).not.toBe(t);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('encrypts so a token can be shown again', () => {
    const box = s.encrypt('hello');
    expect(box).not.toContain('hello');
    expect(s.decrypt(box)).toBe('hello');
    expect(s.encrypt('hello')).not.toBe(box);
  });

  it('refuses to decrypt with another secret or a changed box', () => {
    const box = s.encrypt('hello');
    expect(() => new Secrets('another-long-enough-secret').decrypt(box)).toThrow();
    const [iv, tag, ct] = box.split('.');
    expect(() => s.decrypt([iv, tag, `${ct}A`].join('.'))).toThrow();
  });

  it('signs and checks viewer tokens', () => {
    const t = s.signViewer({ channel: 'c1', character: 'dev:alice' });
    expect(isViewerToken(t)).toBe(true);
    expect(isViewerToken(newToken())).toBe(false);
    expect(s.verifyViewer(t)).toEqual({ channel: 'c1', character: 'dev:alice' });
  });

  it('refuses tampered or foreign viewer tokens', () => {
    const t = s.signViewer({ channel: 'c1', character: 'dev:alice' });
    const [v, body, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ channel: 'c1', character: 'dev:bob' })).toString('base64url');
    expect(s.verifyViewer([v, forged, mac].join('.'))).toBeNull();
    expect(new Secrets('another-long-enough-secret').verifyViewer(t)).toBeNull();
    expect(s.verifyViewer('v1.nope')).toBeNull();
    expect(s.verifyViewer(`v1.${body}.`)).toBeNull();
  });

  it('needs a secret of at least 16 characters', () => {
    expect(() => new Secrets('short')).toThrow(/DNDM_SECRET/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/server/test/crypto.test.ts`
Expected: FAIL (cannot find `../src/crypto`).

- [ ] **Step 3: Implement**

`apps/server/src/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface ViewerClaim { channel: string; character: string }

export const newToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const isViewerToken = (token: string): boolean => token.startsWith('v1.');

const derive = (label: string, secret: string) => createHash('sha256').update(`${label}:${secret}`).digest();

/** Encryption for stored tokens and signing for viewer tokens, both keyed by DNDM_SECRET (README decision 5). */
export class Secrets {
  private readonly key: Buffer;
  private readonly mac: Buffer;

  constructor(secret: string) {
    if (secret.length < 16) throw new Error('DNDM_SECRET must be at least 16 characters');
    this.key = derive('encrypt', secret);
    this.mac = derive('viewer', secret);
  }

  encrypt(text: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
  }

  decrypt(box: string): string {
    const [iv, tag, ct] = box.split('.').map((p) => Buffer.from(p, 'base64url'));
    if (!iv || !tag || !ct) throw new Error('Not an encrypted value');
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }

  signViewer(claim: ViewerClaim): string {
    const body = Buffer.from(JSON.stringify({ channel: claim.channel, character: claim.character })).toString('base64url');
    return `v1.${body}.${this.sign(body)}`;
  }

  verifyViewer(token: string): ViewerClaim | null {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return null;
    const want = Buffer.from(this.sign(parts[1]), 'base64url');
    const got = Buffer.from(parts[2], 'base64url');
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const v = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Partial<ViewerClaim>;
      return typeof v.channel === 'string' && typeof v.character === 'string' ? { channel: v.channel, character: v.character } : null;
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.mac).update(body).digest('base64url');
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run apps/server/test/crypto.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/crypto.ts apps/server/test/crypto.test.ts
git commit -m "feat(server): token hashing, encryption and signed viewer tokens"
```

---

### Task 6: The `Store`

**Files:**
- Create: `apps/server/src/store.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/store.test.ts`

**Interfaces:**
- Consumes: Task 4 (`connect`, schema), Task 5 (`Secrets`, `newToken`, `hashToken`), `newGameState` semantics through `engine.newGame` (the Store takes the initial room values as an argument, so it doesn't need an engine).
- Produces (`apps/server/src/store.ts`):

```ts
export interface ChannelRow { id: string; name: string; config: Record<string, unknown>; configVersion: number; dockTokenHash: string; dockTokenEnc: string; overlayTokenHash: string; overlayTokenEnc: string }
export interface RoomRow { stateVersion: number; clock: number; rng: number; seq: number; session: SessionState | null; recentRequests: RecentRequest[] }
export interface CharacterSave { data: Character; wakeAt: number | null; removed: boolean }
export class Store {
  constructor(db: Db, sql: Sql);
  static open(url: string): Store;
  createChannel(c: { name: string; config: Record<string, unknown>; room: RoomRow; dock: { hash: string; enc: string }; overlay: { hash: string; enc: string } }): Promise<string>;
  channel(id: string): Promise<ChannelRow | null>;
  channelByTokenHash(hash: string): Promise<{ channel: ChannelRow; role: 'dock' | 'overlay' } | null>;
  room(channelId: string): Promise<RoomRow | null>;
  characters(channelId: string, ids: string[]): Promise<Character[]>;
  roomCharacters(channelId: string, party: string[], withRemoved: boolean): Promise<Character[]>;
  removedCharacters(channelId: string): Promise<Character[]>;
  saveInput(channelId: string, room: RoomRow, chars: CharacterSave[]): Promise<void>;
  saveConfig(channelId: string, config: Record<string, unknown>, version: number, room: RoomRow, chars: CharacterSave[]): Promise<void>;
  saveToken(channelId: string, role: 'dock' | 'overlay', token: { hash: string; enc: string }, room: RoomRow): Promise<void>;
  roomsToBoot(): Promise<string[]>;
  tryLock(): Promise<boolean>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write the failing test**

`apps/server/test/store.test.ts`:

```ts
import { type Character, createEngine } from '@dndm/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RoomRow } from '../src/store';
import { freshDb } from './helpers/db';

let t: Awaited<ReturnType<typeof freshDb>>;
let store: Store;
beforeAll(async () => { t = await freshDb(); store = new Store(t.db, t.sql); });
afterAll(async () => { await store.close(); await t.drop(); });

const room = (over: Partial<RoomRow> = {}): RoomRow => ({ stateVersion: 1, clock: 0, rng: 7, seq: 0, session: null, recentRequests: [], ...over });
const tok = (s: string) => ({ hash: `h-${s}`, enc: `e-${s}` });
const ch = (id: string, over: Partial<Character> = {}): Character => ({
  id, name: id, level: 1, xp: 0, gold: 0, hp: 10, inventory: {}, equipped: {}, statuses: [], cooldowns: {}, usesLeft: {},
  knockedOutUntil: null, banned: false, removedByStreamer: false, stores: {}, ...over,
});
let n = 0;
const newChannel = () => {
  n += 1;
  return store.createChannel({ name: `c${n}`, config: { packs: ['starter'] }, room: room(), dock: tok(`d${n}`), overlay: tok(`o${n}`) });
};

describe('Store (spec 2a §3, §6)', () => {
  it('creates a channel with its room and finds it by token hash', async () => {
    const id = await newChannel();
    expect((await store.channel(id))!.configVersion).toBe(1);
    expect(await store.room(id)).toEqual(room());
    const found = await store.channelByTokenHash(`h-o${n}`);
    expect(found).toMatchObject({ role: 'overlay', channel: { id } });
    expect(await store.channelByTokenHash('nope')).toBeNull();
    expect(await store.channel('6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b')).toBeNull();
  });

  it('saves the room and changed characters in one go, keeping key order', async () => {
    const id = await newChannel();
    const al = ch('dev:al', { inventory: { 'starter:z': 1, 'starter:a': 2 } });
    await store.saveInput(id, room({ clock: 500, seq: 3, session: { party: ['dev:al'], encounter: null, adventure: null } }), [
      { data: al, wakeAt: null, removed: false },
    ]);
    expect((await store.room(id))!.clock).toBe(500);
    const [loaded] = await store.characters(id, ['dev:al', 'dev:nobody']);
    expect(Object.keys(loaded!.inventory)).toEqual(['starter:z', 'starter:a']);
    await store.saveInput(id, room({ clock: 600 }), [{ data: { ...al, gold: 9 }, wakeAt: null, removed: false }]);
    expect((await store.characters(id, ['dev:al']))[0]!.gold).toBe(9);
  });

  it('a failed save changes nothing', async () => {
    const id = await newChannel();
    const bad = { data: ch('dev:x'), wakeAt: Number.NaN, removed: false };
    await expect(store.saveInput(id, room({ clock: 999 }), [bad])).rejects.toThrow();
    expect((await store.room(id))!.clock).toBe(0);
    expect(await store.characters(id, ['dev:x'])).toEqual([]);
  });

  it("loads a room's characters: party, timers, and removed ones only when asked", async () => {
    const id = await newChannel();
    await store.saveInput(id, room(), [
      { data: ch('dev:p'), wakeAt: null, removed: false },
      { data: ch('dev:t'), wakeAt: 5000, removed: false },
      { data: ch('dev:r', { removedByStreamer: true }), wakeAt: null, removed: true },
      { data: ch('dev:idle'), wakeAt: null, removed: false },
    ]);
    const ids = (cs: Character[]) => cs.map((c) => c.id).sort();
    expect(ids(await store.roomCharacters(id, ['dev:p'], false))).toEqual(['dev:p', 'dev:t']);
    expect(ids(await store.roomCharacters(id, ['dev:p'], true))).toEqual(['dev:p', 'dev:r', 'dev:t']);
    expect(ids(await store.removedCharacters(id))).toEqual(['dev:r']);
  });

  it('finds rooms to load at boot: a session open, or a character timer', async () => {
    const quiet = await newChannel();
    const open = await newChannel();
    const timer = await newChannel();
    await store.saveInput(open, room({ session: { party: [], encounter: null, adventure: null } }), []);
    await store.saveInput(timer, room(), [{ data: ch('dev:k'), wakeAt: 1, removed: false }]);
    const closed = await newChannel();
    await store.saveInput(closed, room({ session: { party: [], encounter: null, adventure: null } }), []);
    await store.saveInput(closed, room({ session: null }), []);   // a closed session is SQL NULL, not JSON null
    const boot = await store.roomsToBoot();
    expect(boot).toEqual(expect.arrayContaining([open, timer]));
    expect(boot).not.toContain(quiet);
    expect(boot).not.toContain(closed);
  });

  it('saves a config with its new version, and a new token', async () => {
    const id = await newChannel();
    await store.saveConfig(id, { packs: [] }, 2, room({ seq: 1 }), []);
    expect(await store.channel(id)).toMatchObject({ config: { packs: [] }, configVersion: 2 });
    await store.saveToken(id, 'dock', tok('new'), room({ seq: 2 }));
    expect((await store.channelByTokenHash('h-new'))!.role).toBe('dock');
    expect((await store.room(id))!.seq).toBe(2);
  });

  it('takes the advisory lock once per database', async () => {
    expect(await store.tryLock()).toBe(true);
    const other = Store.open(t.url);
    expect(await other.tryLock()).toBe(false);
    await other.close();
  });

  it('round-trips a real new game room', async () => {
    const engine = createEngine({ packs: [], channel: { packs: [] } });
    const g = engine.newGame({ seed: 42 });
    const id = await store.createChannel({
      name: 'real', config: { packs: [] }, dock: tok('rd'), overlay: tok('ro'),
      room: { stateVersion: g.version, clock: g.clock, rng: g.rng, seq: g.seq, session: g.session, recentRequests: [] },
    });
    expect((await store.room(id))!.rng).toBe(g.rng);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/server/test/store.test.ts`
Expected: FAIL (cannot find `../src/store`).

- [ ] **Step 3: Implement**

`apps/server/src/store.ts`:

```ts
import type { Character, SessionState } from '@dndm/engine';
import { and, eq, inArray, isNotNull, or, sql as dsql } from 'drizzle-orm';
import { connect, type Db, type Sql } from './db/connect';
import { channels, characters, type RecentRequest, rooms } from './db/schema';

export interface ChannelRow {
  id: string; name: string; config: Record<string, unknown>; configVersion: number;
  dockTokenHash: string; dockTokenEnc: string; overlayTokenHash: string; overlayTokenEnc: string;
}
export interface RoomRow {
  stateVersion: number; clock: number; rng: number; seq: number; session: SessionState | null; recentRequests: RecentRequest[];
}
export interface CharacterSave { data: Character; wakeAt: number | null; removed: boolean }

const LOCK_KEY = 727_274_001;

/** The only code that talks to Postgres (spec 2a §2.2). */
export class Store {
  private lockConn: Awaited<ReturnType<Sql['reserve']>> | null = null;

  constructor(readonly db: Db, readonly sql: Sql) {}

  static open(url: string): Store {
    const { db, sql } = connect(url);
    return new Store(db, sql);
  }

  async createChannel(c: {
    name: string; config: Record<string, unknown>; room: RoomRow;
    dock: { hash: string; enc: string }; overlay: { hash: string; enc: string };
  }): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(channels).values({
        name: c.name, config: c.config,
        dockTokenHash: c.dock.hash, dockTokenEnc: c.dock.enc, overlayTokenHash: c.overlay.hash, overlayTokenEnc: c.overlay.enc,
      }).returning({ id: channels.id });
      await tx.insert(rooms).values({ channelId: row!.id, ...roomValues(c.room) });
      return row!.id;
    });
  }

  async channel(id: string): Promise<ChannelRow | null> {
    if (!UUID.test(id)) return null;
    const [row] = await this.db.select().from(channels).where(eq(channels.id, id));
    return row ? toChannel(row) : null;
  }

  async channelByTokenHash(hash: string): Promise<{ channel: ChannelRow; role: 'dock' | 'overlay' } | null> {
    const [row] = await this.db.select().from(channels)
      .where(or(eq(channels.dockTokenHash, hash), eq(channels.overlayTokenHash, hash)));
    if (!row) return null;
    return { channel: toChannel(row), role: row.dockTokenHash === hash ? 'dock' : 'overlay' };
  }

  async room(channelId: string): Promise<RoomRow | null> {
    const [row] = await this.db.select().from(rooms).where(eq(rooms.channelId, channelId));
    if (!row) return null;
    return {
      stateVersion: row.stateVersion, clock: row.clock, rng: row.rng, seq: row.seq,
      session: row.session ?? null, recentRequests: row.recentRequests,
    };
  }

  async characters(channelId: string, ids: string[]): Promise<Character[]> {
    if (!ids.length) return [];
    const rows = await this.db.select({ data: characters.data }).from(characters)
      .where(and(eq(characters.channelId, channelId), inArray(characters.id, ids)));
    return rows.map((r) => r.data);
  }

  /** Spec 2a §6.2 "Loading a Room": the party, every character with a timer, and removed ones when asked. */
  async roomCharacters(channelId: string, party: string[], withRemoved: boolean): Promise<Character[]> {
    const conds = [isNotNull(characters.wakeAt)];
    if (party.length) conds.push(inArray(characters.id, party));
    if (withRemoved) conds.push(eq(characters.removed, true));
    const rows = await this.db.select({ data: characters.data }).from(characters)
      .where(and(eq(characters.channelId, channelId), or(...conds)));
    return rows.map((r) => r.data);
  }

  async removedCharacters(channelId: string): Promise<Character[]> {
    const rows = await this.db.select({ data: characters.data }).from(characters)
      .where(and(eq(characters.channelId, channelId), eq(characters.removed, true)));
    return rows.map((r) => r.data);
  }

  /** Spec 2a §6.1 step 3: the room row and every changed character, in one transaction. */
  async saveInput(channelId: string, room: RoomRow, chars: CharacterSave[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(rooms).set({ ...roomValues(room), savedAt: new Date() }).where(eq(rooms.channelId, channelId));
      for (const c of chars) {
        if (c.wakeAt !== null && !Number.isFinite(c.wakeAt)) throw new Error(`Bad wake_at for ${c.data.id}`);
        const values = { channelId, id: c.data.id, data: c.data, wakeAt: c.wakeAt, removed: c.removed, updatedAt: new Date() };
        await tx.insert(characters).values(values).onConflictDoUpdate({
          target: [characters.channelId, characters.id],
          set: { data: values.data, wakeAt: values.wakeAt, removed: values.removed, updatedAt: values.updatedAt },
        });
      }
    });
  }

  async saveConfig(channelId: string, config: Record<string, unknown>, version: number, room: RoomRow, chars: CharacterSave[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(channels).set({ config, configVersion: version, updatedAt: new Date() }).where(eq(channels.id, channelId));
      await tx.update(rooms).set({ ...roomValues(room), savedAt: new Date() }).where(eq(rooms.channelId, channelId));
      for (const c of chars) {
        await tx.insert(characters).values({ channelId, id: c.data.id, data: c.data, wakeAt: c.wakeAt, removed: c.removed })
          .onConflictDoUpdate({ target: [characters.channelId, characters.id], set: { data: c.data, wakeAt: c.wakeAt, removed: c.removed, updatedAt: new Date() } });
      }
    });
  }

  async saveToken(channelId: string, role: 'dock' | 'overlay', token: { hash: string; enc: string }, room: RoomRow): Promise<void> {
    await this.db.transaction(async (tx) => {
      const set = role === 'dock' ? { dockTokenHash: token.hash, dockTokenEnc: token.enc } : { overlayTokenHash: token.hash, overlayTokenEnc: token.enc };
      await tx.update(channels).set({ ...set, updatedAt: new Date() }).where(eq(channels.id, channelId));
      await tx.update(rooms).set({ ...roomValues(room), savedAt: new Date() }).where(eq(rooms.channelId, channelId));
    });
  }

  /** Spec 2a §6.4: rooms with a session open or any character with a timer. */
  async roomsToBoot(): Promise<string[]> {
    const rows = await this.db.execute<{ channel_id: string }>(dsql`
      select channel_id from rooms where session is not null
      union
      select distinct channel_id from characters where wake_at is not null`);
    return [...rows].map((r) => r.channel_id);
  }

  /** Spec 2a §6.6: one server per database. Held on a dedicated connection until close(). */
  async tryLock(): Promise<boolean> {
    if (!this.lockConn) this.lockConn = await this.sql.reserve();
    const [row] = await this.lockConn<{ ok: boolean }[]>`select pg_try_advisory_lock(${LOCK_KEY}) as ok`;
    return !!row?.ok;
  }

  async close(): Promise<void> {
    this.lockConn?.release();
    this.lockConn = null;
    await this.sql.end();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function roomValues(r: RoomRow) {
  return { stateVersion: r.stateVersion, clock: r.clock, rng: r.rng, seq: r.seq, session: r.session, recentRequests: r.recentRequests };
}

function toChannel(row: typeof channels.$inferSelect): ChannelRow {
  return {
    id: row.id, name: row.name, config: row.config, configVersion: row.configVersion,
    dockTokenHash: row.dockTokenHash, dockTokenEnc: row.dockTokenEnc, overlayTokenHash: row.overlayTokenHash, overlayTokenEnc: row.overlayTokenEnc,
  };
}
```

`apps/server/src/index.ts`, add:

```ts
export { Store, type ChannelRow, type RoomRow, type CharacterSave } from './store';
export { hashToken, newToken, Secrets } from './crypto';
```

Note on `tryLock`: the lock belongs to the reserved connection. Releasing that connection back to the pool would leave the lock held by a pooled connection, so `close()` releases it and then ends the pool, which drops the session and with it the lock.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run apps/server/test/store.test.ts`
Expected: PASS (8 tests). If `the advisory lock` test passes the second `tryLock` too, check that `other` really is a separate pool (`Store.open`) and not `store`.

- [ ] **Step 5: Run everything and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS.

```bash
git add apps/server
git commit -m "feat(server): Store with one-transaction saves, boot query and advisory lock"
```
