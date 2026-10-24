# Project 2b, Plan A: Engine and Room Additions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the changes 2b needs below the Twitch layer: reactions inside a restricted encounter take its audience, party entries gain `level` and `statuses`, the Room can report whose own state changed (`broadcastState()`), and the server gains `GET /health` and a clean shutdown. Nothing here talks to Twitch.

**Architecture:** Two engine changes (reaction audiences, the party view) and two Room changes (the comparison view behind `broadcastState()` and the sweep hold), both switched on per Room by a `RoomDeps.broadcast` predicate that Plan B supplies. The server builds and listens before boot so `/health` can answer 503, and `close()` drains every Room's queue before closing.

**Tech Stack:** As in 2a: TypeScript, Vitest, Fastify 5, Drizzle on Postgres 17. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-17-twitch-layer-design.md` (rev 16): §1.1 criterion 6, §5.2, §5.7, §7.3, §7.4 (steps 1, 2 and 4; step 3 is Plan B). Flagged decisions: `docs/superpowers/plans/2026-10-23-project-2b-README.md`.

**Prerequisite:** 2a complete (it is). Postgres running (`docker compose up -d postgres`).

## Global Constraints

- Four changes apply whatever the config: party entries gain `level` and `statuses`; reactions inside a restricted encounter take its audience; `GET /health` exists; shutdown waits for in-flight inputs (§1.1 c6). Every other 2a behaviour stays. A 2a test may be updated only where it pins the old behaviour of one of these four.
- Rooms without a Broadcaster (`RoomDeps.broadcast` absent or false) record nothing and sweep exactly as 2a (§5.2).
- `broadcastState()` runs through the Room's queue and never counts as activity: it never touches `lastActivity` and never keeps a Room loaded (§5.2).
- The comparison view keeps `character`, `panel` and `abilities`; drops each ability's `targets`; computes `ready` and `reason` as if the ability's cooldown had ended; replaces `readyAt` with the stored cooldown end time, which doesn't turn `null` when it passes (§5.2; README decision 1).
- `inputs` goes up by one for every input that saved state: a command, a timer, a config change (§5.2).
- Shutdown waits up to 15 s for every Room's queue (`manager.idle()`), then closes the Store (§7.4).

## Review Focus

1. **An encounter that ends inside `respond`, whose end triggers reactions**: a person expects those reactions to stay restricted too, not leak because the encounter is gone by the time `settle` runs them. Test in Task 1.
2. **A character whose only change is a cooldown running out mid-fight**: a person expects nobody to be told to refetch. Test in Task 3.
3. **A viewer whose view read loads them, followed by a `join` in the same second**: a person expects the join to count as a change and the read not to. Test in Task 3.
4. **A sweep that runs while a changed character hasn't been broadcast yet**: a person expects the character to stay until the next `broadcastState()`, then be droppable. Test in Task 4.
5. **SIGTERM while a command is waiting in a Room's queue**: a person expects the command to finish and be saved, not fail with "room closed". Test in Task 5.

---

## File map (this plan)

```
packages/engine/src/
  runtime.ts        + reactionAudience
  hooks.ts          ReactionJob.audience; react() and drainReactions() carry it
  encounters.ts     stampAudience also stamps jobs queued at the four points
  view.ts           party entries gain level, statuses
packages/engine/test/
  reaction-audience.test.ts
  view-party.test.ts
apps/server/src/
  comparison.ts     comparisonView()
  room.ts           RoomDeps.broadcast, broadcasting, inputs, broadcastState(), sweep hold
  app.ts            GET /health
  server.ts         listen before boot, ready flag, clean close()
apps/server/test/
  comparison.test.ts
  room-broadcast.test.ts
  health.test.ts
  shutdown.test.ts
```

---

### Task 1: Reaction audiences (engine)

**Files:**
- Modify: `packages/engine/src/runtime.ts`, `packages/engine/src/hooks.ts`, `packages/engine/src/encounters.ts`
- Test: `packages/engine/test/reaction-audience.test.ts`

**Interfaces:**
- Produces:
  - `interface ReactionJob { event: ReactionEvent; ref: EntityRef; role: ReactionRole; depth: number; audience?: string[] }`
  - `Runtime.reactionAudience: string[] | null` (the audience of the reaction now running; `null` outside one)
  - `Runtime.emit(type, text, data?, audience?)`: when `audience` is omitted and `reactionAudience` is set, the event gets a copy of `reactionAudience`.

The rule (§5.7): a reaction queued while handling a restricted encounter (its start, `respond`, a wake-up, its end) carries the encounter's audience. Every event emitted while it runs gets that audience, `ctx` core events included, unless the emit sets its own. Reactions it queues carry the same audience, to any depth. The `core:reaction-limit` event for such a chain gets it. Reactions queued anywhere else stay public.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/reaction-audience.test.ts`, using `harness` from `./helpers/harness` and the `hush` kind shape from `audience.test.ts` (copy it in: `audience: (s) => s.members`, `respond` heals `ch` by 1). Add:
- a kind `plain` identical to `hush` but with no `audience` hook;
- a passive `tp:echo` with `react.healed` that emits `tp:echo` and heals its holder by 1 (an endless chain, stopped by the depth limit);
- a passive `tp:back` with `react.healed` that emits `tp:back` with `{ audience: [holder] }`;
- give `al` the passive through a class item (`grants-class`), as `ops.test.ts` does.

```ts
describe('reaction audiences (spec 2b §5.7)', () => {
  it('a reaction to respond, and every reaction it queues, takes the encounter audience', () => {
    const h = setup('tp:echo'); // open, al (echo) and bo join, start tp:hush
    const evs = h.do({ type: 'respond', character: 'al', input: {} });
    const echoes = evs.filter((e) => e.type === 'tp:echo');
    expect(echoes.length).toBeGreaterThan(1);
    expect(echoes.every((e) => JSON.stringify(e.audience) === '["al","bo"]')).toBe(true);
    expect(evs.filter((e) => e.type === 'core:healed').every((e) => JSON.stringify(e.audience) === '["al","bo"]')).toBe(true);
    expect(evs.find((e) => e.type === 'core:reaction-limit')!.audience).toEqual(['al', 'bo']);
  });

  it('reactions queued by start, a wake-up and the end take it too', () => {
    // hush variant whose start, advance and endEarly each heal al by 1, and whose respond with input { end: true } heals al
    // and calls ctx.endEncounter('done'); drive start, a wake-up, endEncounter,
    // and a fresh encounter ended by that respond. For each, every tp:echo event has audience ['al','bo'].
  });

  it('an emit inside such a reaction that sets its own audience keeps it', () => {
    const h = setup('tp:back');
    const evs = h.do({ type: 'respond', character: 'al', input: {} });
    expect(evs.find((e) => e.type === 'tp:back')!.audience).toEqual(['al']);
  });

  it('a reaction queued outside a restricted encounter stays public', () => {
    const h = setup('tp:echo', 'tp:plain');
    const evs = h.do({ type: 'respond', character: 'al', input: {} });
    expect(evs.filter((e) => e.type === 'tp:echo').every((e) => e.audience === undefined)).toBe(true);
  });
});
```

Write the second test fully with the variant kind; its assertion is the one in its comment.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run packages/engine/test/reaction-audience.test.ts`
Expected: FAIL. The first `every(...)` is false because echo events have no audience.

- [ ] **Step 3: Implement**

- `encounters.ts`: `stampAudience(rt, enc, fromEvent, fromJob)` also sets `job.audience` (a copy) on every `rt.queue[i]` for `i >= fromJob` that has none. Each of the four call sites records `rt.queue.length` when it starts handling, next to the existing `from`. The jobs are still queued at that point because reactions drain only in `settle`.
- `hooks.ts`: `react()` copies `rt.reactionAudience` (when set) onto each job it pushes. `drainReactions()` sets `rt.reactionAudience = job.audience ?? null` while the job runs and restores the previous value in the `finally`. It emits `core:reaction-limit` with the skipped job's audience.
- `runtime.ts`: `reactionAudience: string[] | null = null`; `emit` applies it when no audience is passed.

- [ ] **Step 4: Run the engine tests**

Run: `pnpm vitest run packages/engine`
Expected: PASS, including `audience.test.ts` and `determinism.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/runtime.ts packages/engine/src/hooks.ts packages/engine/src/encounters.ts packages/engine/test/reaction-audience.test.ts
git commit -m "feat(engine): reactions inside a restricted encounter take its audience"
```

---

### Task 2: Party entries gain level and statuses (engine)

**Files:**
- Modify: `packages/engine/src/view.ts`
- Test: `packages/engine/test/view-party.test.ts`; update any engine, server or CLI test that pins the exact party entry shape (§1.1 c6 allows this one change)

**Interfaces:**
- Produces: `View['party'][number]` is `{ id: string; name: string; hp: number; maxHp: number; knockedOut: boolean; class: string | null; level: number; statuses: { status: string; until: number | null }[] }`. `statuses` has the same shape and order as `character.statuses`.

- [ ] **Step 1: Write the failing test**

```ts
it('party entries carry level and statuses (spec 2b §5.2)', () => {
  const h = harness({ plugins: (api) => api.status('dozy', { name: 'Dozy' }) });
  h.open(); h.join('al');
  // apply tp:dozy to al for 10 s through whatever the harness offers (a ctx op in a test kind, or applyStatus as ops.test.ts does)
  const v = h.view(null);
  expect(v.party[0]).toMatchObject({ id: 'al', level: 1, statuses: [{ status: 'tp:dozy', until: expect.any(Number) }] });
  expect(v.party[0]!.statuses).toEqual(h.view('al').character!.statuses);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run packages/engine/test/view-party.test.ts`
Expected: FAIL. `level` is missing.

- [ ] **Step 3: Implement**

In `view()`'s `party` map, add `level: c.level` and `statuses: statusViews(rt, ref).map((x) => ({ status: x.status, until: x.until }))`, the same expression `character.statuses` uses.

- [ ] **Step 4: Run every test and fix the pinned shapes**

Run: `pnpm test`
Expected: PASS after you update the tests that compare whole party entries. Change only those assertions, and list them in the commit message.

- [ ] **Step 5: Commit**

```bash
git add packages/engine apps
git commit -m "feat(engine): party entries in views gain level and statuses"
```

---

### Task 3: The comparison view and `broadcastState()` (Room)

**Files:**
- Create: `apps/server/src/comparison.ts`
- Modify: `apps/server/src/room.ts`
- Test: `apps/server/test/comparison.test.ts`, `apps/server/test/room-broadcast.test.ts`; `apps/server/test/helpers/room.ts` (add a `broadcast` option)

**Interfaces:**
- Consumes: Task 2's `View`.
- Produces:
  - `comparisonView(engine: Engine, game: GameState, id: string, now: number): string`
  - `RoomDeps.broadcast?: (channel: ChannelRow) => boolean`
  - `Room.broadcasting: boolean` (fixed at load from `deps.broadcast?.(channel) ?? false`)
  - `Room.inputs: number` (a plain property that Plan B's Broadcaster reads outside the queue)
  - `interface BroadcastState { publicView: View; changed: string[]; inputs: number }`
  - `Room.broadcastState(): Promise<BroadcastState>` (throws `Error('broadcastState needs a Room with a Broadcaster')` when `!broadcasting`)
  - `roomSetup({ broadcast: true, bundles?: PackBundle[] })` in the test helper (`bundles` replaces the official ones when given)

`comparisonView` returns `JSON.stringify({ character, panel, abilities })`, where `character` and `panel` come from `engine.view(game, id, now)`. Each ability keeps every field except `targets`. `ready` and `reason` come from a second view of a shallow copy of `game` in which this character's `cooldowns` is `{}`. `readyAt` is `game.characters[id].cooldowns[ability] ?? null`, the stored end time: the view's own `readyAt` turns `null` when the cooldown passes, which would make a cooldown ending count as a change. The engine never deletes cooldown entries (it only overwrites them in `ops.ts`), so this value changes only when the ability is used. Match abilities by index: both views list them in the same order.

Recording (§5.2 "When views are recorded"): in a broadcasting Room, `add()` records `comparisonView(...)` for each character it adds. That covers the Room's own load and a load for one character (`ensureLoaded`, removed characters at `openSession` and at a config change), always before the command runs. `broadcastState()` computes the current comparison view for every loaded character, returns as `changed` those that differ from the recorded one, records the current ones, and returns `inputs`. `inputs += 1` after each successful save in `engineCommand`, `tick` and `updateConfig`.

- [ ] **Step 1: Write the failing tests**

`comparison.test.ts` (engine only, with the starter pack as `room-time.test.ts` uses it):

```ts
it('ignores targets and a running cooldown, and keeps the cooldown end time', () => {
  // al in party with starter:sword, fight started, al attacks (cooldown running until cooldownEnd)
  const during = comparisonView(engine, game, 'al', t);
  const later = comparisonView(engine, game, 'al', cooldownEnd + 1);
  const a = JSON.parse(during).abilities[0];
  expect(a.targets).toBeUndefined();
  expect(a.ready).toBe(true);
  expect(a.readyAt).toBe(cooldownEnd);
  expect(later).toBe(during);
});
it('a knockout still flips ready', () => { /* knocked-out member: ready false, reason "You're knocked out" */ });
```

`room-broadcast.test.ts` (`roomSetup({ broadcast: true })`):

```ts
it('loading a character with a view read does not put them in changed', async () => {
  await s.room.broadcastState();
  await s.room.view(s.v('al'));
  expect((await s.room.broadcastState()).changed).toEqual([]);
});
it('a join that loads and changes a character does', async () => {
  await s.cmd(s.dock, { type: 'openSession' });
  await s.room.broadcastState();
  await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
  expect((await s.room.broadcastState()).changed).toEqual(['dev:al']);
});
it('a loaded character with no connection whose state changed is included, an unchanged one is not', async () => { /* al and bo loaded; only al's state changes */ });
it('a cooldown running out alone changes nothing', async () => {
  // fight running, al attacks, broadcastState(); advance past the cooldown with no other change
  // ({ type: 'holdMonster' } from the dock, so no monster turn lands); broadcastState().changed excludes dev:al
});
it('a fight starting puts members whose readiness flips in changed', async () => { /* al and bo joined; spawnMonster; both in changed */ });
it('a public change puts nobody in changed (starter pack)', async () => {
  /* al and bo in a held fight; broadcastState(); al attacks (monster HP drops, al's cooldown starts);
     changed is exactly ['dev:al'] (al's own cooldown), and bo, whose only difference is the monster's HP, is not in it */
});
it('with a pack whose canUse reads monster HP, a monster HP change puts the affected members in changed', async () => {
  /* roomSetup({ broadcast: true, bundles: [...official, testBundle] }) where the test bundle adds a status or passive whose
     modify.canUse returns 'Too early' while the monster is above half HP; bo holds it; al's attacks take the monster below half;
     changed includes dev:bo */
});
it('inputs counts saved inputs only', async () => {
  const before = s.room.inputs;
  await s.cmd(s.v('al'), { type: 'leave' }); // rejected: not in party
  expect(s.room.inputs).toBe(before);
  await s.cmd(s.dock, { type: 'openSession' });
  expect(s.room.inputs).toBe(before + 1);
  expect((await s.room.broadcastState()).inputs).toBe(before + 1);
});
it('broadcastState does not keep a Room loaded', async () => {
  await s.room.broadcastState();
  await s.clock.advance(31 * 60_000, () => s.room.idle());
  expect(s.room.canUnload(s.clock.now())).toBe(true);
});
it('a Room without a Broadcaster refuses broadcastState', async () => {
  const plain = await roomSetup();
  await expect(plain.room.broadcastState()).rejects.toThrow('broadcastState needs a Room with a Broadcaster');
});
```

Write each commented test out in full. The setup lines are the same commands `room-time.test.ts` uses.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/test/comparison.test.ts apps/server/test/room-broadcast.test.ts`
Expected: FAIL (module `../src/comparison` not found).

- [ ] **Step 3: Implement `comparisonView` and the Room additions as described above**

- [ ] **Step 4: Run the server tests**

Run: `pnpm vitest run apps/server`
Expected: PASS. Every 2a Room test is unchanged, because 2a Rooms have no `broadcast`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/comparison.ts apps/server/src/room.ts apps/server/test
git commit -m "feat(server): comparison view and room.broadcastState()"
```

---

### Task 4: The sweep waits for the broadcast (Room)

**Files:**
- Modify: `apps/server/src/room.ts` (`drop()`)
- Test: `apps/server/test/room-broadcast.test.ts`

**Interfaces:**
- Consumes: Task 3's recorded views.

In a broadcasting Room, `drop()` also skips a character whose current comparison view differs from their recorded one, and deletes the recorded view with the character. A non-broadcasting Room's `drop()` is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
it('the sweep keeps a character with an unbroadcast change, and drops them after broadcastState', async () => {
  const s = await roomSetup({ broadcast: true });
  await s.cmd(s.dock, { type: 'openSession' });
  await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
  await s.cmd(s.v('al'), { type: 'leave' });
  await s.clock.advance(11 * 60_000, () => s.room.idle());
  await s.room.sweep();
  expect(s.room.game.characters['dev:al']).toBeDefined();
  expect((await s.room.broadcastState()).changed).toContain('dev:al');
  await s.room.sweep();
  expect(s.room.game.characters['dev:al']).toBeUndefined();
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run apps/server/test/room-broadcast.test.ts -t sweep`
Expected: FAIL. The first `toBeDefined` fails because the sweep drops `dev:al`.

- [ ] **Step 3: Implement the extra check in `drop()`**

- [ ] **Step 4: Run the server tests**

Run: `pnpm vitest run apps/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/room.ts apps/server/test/room-broadcast.test.ts
git commit -m "feat(server): sweep keeps characters with an unbroadcast change"
```

---

### Task 5: `GET /health` and clean shutdown (server)

**Files:**
- Modify: `apps/server/src/app.ts`, `apps/server/src/server.ts`
- Test: `apps/server/test/health.test.ts`, `apps/server/test/shutdown.test.ts`

**Interfaces:**
- Produces:
  - `AppDeps.health: { ready: boolean }`; `GET /health` answers `200 { ok: true }` when `ready`, otherwise `503 { ok: false }`. It needs no token and isn't rate-limited.
  - `startServer` takes the lock, builds the app, listens (when `port` is given), boots, then sets `health.ready = true`. It still resolves only after boot.
  - `ServerOpts.idleTimeoutMs?: number` (default 15 000)
  - `RunningServer.close()`: `app.close()` (stops accepting requests), then `manager.idle()` raced against `idleTimeoutMs`, then `manager.close()`, then `store.close()`. Plan B inserts the Broadcasters' last ticks between the idle wait and `manager.close()`.

`apps/cli/src/server.ts` already calls `srv.close()` on SIGINT or SIGTERM, so `start` needs no change.

- [ ] **Step 1: Write the failing tests**

`health.test.ts`:

```ts
it('is 503 before boot finishes and 200 after', async () => {
  const health = { ready: false };
  const app = await buildApp({ ...appDeps(), health });
  expect((await app.inject('/health')).statusCode).toBe(503);
  health.ready = true;
  const r = await app.inject('/health');
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ ok: true });
});
it('a started server is healthy', async () => {
  const srv = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0) });
  expect((await srv.app.inject('/health')).statusCode).toBe(200);
  await srv.close();
});
```

(`appDeps()` builds a `RoomManager`, `Hub`, `Secrets` and `RateLimiter` as `app.test.ts` does; reuse its helper if it has one.)

`shutdown.test.ts`:

```ts
it('a command waiting in a Room queue when close() starts is still saved', async () => {
  const srv = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0), rateLimits: false });
  const room = (await srv.manager.get(channelId))!;
  const pending = room.command({ role: 'dock' }, 'r1', { type: 'openSession' });
  await srv.close();
  expect((await pending).ok).toBe(true);
  const store = Store.open(t.url);
  expect((await store.room(channelId))!.session).not.toBeNull();
  await store.close();
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/test/health.test.ts apps/server/test/shutdown.test.ts`
Expected: FAIL. `/health` is 404, and `pending` rejects with `RoomClosedError`.

- [ ] **Step 3: Implement the route, the boot order and `close()` as described above**

- [ ] **Step 4: Run every test**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/app.ts apps/server/src/server.ts apps/server/test/health.test.ts apps/server/test/shutdown.test.ts
git commit -m "feat(server): GET /health and shutdown that waits for in-flight inputs"
```
