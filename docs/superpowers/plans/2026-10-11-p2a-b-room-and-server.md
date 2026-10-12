# Project 2a, Plan B: Room and Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run each channel's game as a live `Room` behind a Fastify server: commands over HTTP, live updates over WebSocket, every input saved before anyone hears about it, restarts that pick up mid-fight, and an end-to-end test that the server plays exactly like `dndm run`.

**Architecture:** A `Room` owns one channel's engine, its `GameState` (with only the characters in play loaded), one input queue and one timer. Every input runs in four steps: load the characters it needs, call the engine, save in one transaction, then publish. A `RoomManager` loads and unloads Rooms. A `Hub` fans a Room's output out to dock, overlay and viewer connections, filtering events by audience. The Fastify app authenticates, rate-limits and routes requests to Rooms. Time comes from an injected `Clock`, so tests use a `FakeClock`.

**Tech Stack:** Plan A's stack, plus `fastify@5.12.5` and `@fastify/websocket@11.3.1`.

**Spec:** `docs/superpowers/specs/2026-10-11-server-core-design.md` (rev 7), mainly §4, §5, §6, §9. Flagged decisions: `docs/superpowers/plans/2026-10-11-project-2a-README.md`.

**Prerequisite:** Plan A complete. Postgres running (`docker compose up -d postgres`).

## Global Constraints

- Nothing is broadcast or answered before the save commits (spec §6.1). A failed save leaves the Room's state exactly as it was (§6.3).
- Every input to a Room runs through its one queue, one at a time (§6.1).
- Game time comes only from the Room's `Clock`. Tests never sleep: they move a `FakeClock`.
- Rate limits: 5 requests per second per viewer, 5 per overlay token and 20 per dock token. Commands, view and `describe` reads, and WebSocket connects all count (§4.4). Dev login doesn't count (§8.3).
- Request IDs: 1–64 characters, remembered for 5 minutes, for accepted commands that change state only (§4.1).
- Characters stay loaded per §6.2: in the party; a running timer; removed by the streamer while a session is open and `streamerRemovalWaitsForRest` is on; watched; or touched in the last 10 minutes.
- Dependency versions: `fastify@5.12.5`, `@fastify/websocket@11.3.1`.

## Review Focus

1. **Two commands for the same Room arriving at once**: a person expects them to run one after the other, with the second seeing the first's result. Test in Task 2.
2. **A viewer who sends `character: "dev:someone-else"`**: a person expects the command to run as themselves, not as the other viewer. Test in Task 2.
3. **The database going away for a moment during a fight**: a person expects no events to reach anyone until saving works again, then the fight to carry on without losing the monster's turn. Test in Task 3.
4. **A WebSocket client that connects and never says hello**: a person expects the server to close it after 5 seconds rather than keep it forever. Test in Task 6.
5. **A dock that regenerates its own token and loses the answer**: a person expects a retry with the old token and the same request ID to return the same new token. Test in Task 4 (Room) and Task 6 (HTTP).

---

## File map (this plan)

```
apps/server/src/
  clock.ts          Clock, realClock, FakeClock
  room.ts           Room, Sender, RoomOutput, visibleTo
  room-manager.ts   RoomManager
  hub.ts            Hub, Conn
  auth.ts           authenticate, RateLimiter
  app.ts            buildApp (HTTP routes, WebSocket, dev login)
  server.ts         startServer, createChannel, officialBundles, defaultConfig
  index.ts          exports
apps/server/test/
  helpers/room.ts
  clock.test.ts
  room-commands.test.ts
  room-time.test.ts
  room-config.test.ts
  hub.test.ts
  app.test.ts
  server.test.ts
  e2e-golden.test.ts
```

---

### Task 1: Clock

**Files:**
- Create: `apps/server/src/clock.ts`
- Test: `apps/server/test/clock.test.ts`

**Interfaces:**
- Produces:
  - `interface Clock { now(): number; setTimer(at: number, fn: () => void): () => void }` (the returned function cancels)
  - `realClock: Clock` (handles delays beyond `setTimeout`'s 24.8-day limit)
  - `class FakeClock implements Clock { constructor(start?: number); advanceTo(t: number, settle?: () => Promise<void>): Promise<void>; advance(ms: number, settle?: () => Promise<void>): Promise<void> }`

- [ ] **Step 1: Write the failing test**

`apps/server/test/clock.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakeClock, realClock } from '../src/clock';

describe('FakeClock', () => {
  it('fires due timers in time order, then stops at the target', async () => {
    const c = new FakeClock(100);
    const seen: string[] = [];
    c.setTimer(300, () => seen.push(`b@${c.now()}`));
    c.setTimer(200, () => seen.push(`a@${c.now()}`));
    c.setTimer(900, () => seen.push('late'));
    await c.advanceTo(500);
    expect(seen).toEqual(['a@200', 'b@300']);
    expect(c.now()).toBe(500);
  });

  it('fires timers set by timers, and waits for settle between them', async () => {
    const c = new FakeClock(0);
    const seen: number[] = [];
    let pending = Promise.resolve();
    const tick = () => { pending = (async () => { await Promise.resolve(); seen.push(c.now()); if (c.now() < 30) c.setTimer(c.now() + 10, tick); })(); };
    c.setTimer(10, tick);
    await c.advance(100, () => pending);
    expect(seen).toEqual([10, 20, 30]);
  });

  it('cancels', async () => {
    const c = new FakeClock(0);
    let fired = false;
    const cancel = c.setTimer(10, () => { fired = true; });
    cancel();
    await c.advance(20);
    expect(fired).toBe(false);
  });
});

describe('realClock', () => {
  it('fires a near timer and can cancel a far one', async () => {
    const fired = await new Promise<boolean>((resolve) => {
      realClock.setTimer(realClock.now() + 5, () => resolve(true));
    });
    expect(fired).toBe(true);
    const cancel = realClock.setTimer(realClock.now() + 40 * 24 * 3600 * 1000, () => { throw new Error('must not fire'); });
    cancel();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/server/test/clock.test.ts`
Expected: FAIL (cannot find `../src/clock`).

- [ ] **Step 3: Implement**

`apps/server/src/clock.ts`:

```ts
/** The server's only source of time (spec 2a §6.1 step 2). */
export interface Clock {
  now(): number;
  /** Calls fn at (or soon after) `at`. Returns a function that cancels it. */
  setTimer(at: number, fn: () => void): () => void;
}

const MAX_DELAY = 2 ** 31 - 1;

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer(at, fn) {
    let handle: ReturnType<typeof setTimeout>;
    const arm = () => {
      const d = at - Date.now();
      if (d <= 0) fn();
      else handle = setTimeout(arm, Math.min(d, MAX_DELAY));
    };
    handle = setTimeout(arm, Math.min(Math.max(0, at - Date.now()), MAX_DELAY));
    return () => clearTimeout(handle);
  },
};

interface FakeTimer { at: number; seq: number; fn: () => void }

/** A clock tests move by hand. `settle` waits for the work a fired timer started (usually `room.idle()`). */
export class FakeClock implements Clock {
  private t: number;
  private timers: FakeTimer[] = [];
  private seq = 0;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimer(at: number, fn: () => void): () => void {
    const timer = { at, seq: this.seq++, fn };
    this.timers.push(timer);
    return () => { this.timers = this.timers.filter((x) => x !== timer); };
  }

  async advanceTo(target: number, settle: () => Promise<void> = async () => {}): Promise<void> {
    for (;;) {
      await settle();
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = Math.max(this.t, target);
    await settle();
  }

  advance(ms: number, settle?: () => Promise<void>): Promise<void> {
    return this.advanceTo(this.t + ms, settle);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run apps/server/test/clock.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/clock.ts apps/server/test/clock.test.ts
git commit -m "feat(server): Clock with a fake for tests"
```

---

### Task 2: Room: loading, engine commands, saving and request IDs

**Files:**
- Create: `apps/server/src/room.ts`, `apps/server/src/server.ts` (only `officialBundles`, `defaultConfig`, `createChannel` for now)
- Create: `apps/server/test/helpers/room.ts`
- Test: `apps/server/test/room-commands.test.ts`

**Interfaces:**
- Consumes: Plan A (`Store`, `RoomRow`, `CharacterSave`, `RecentRequest`, `Secrets`, `newToken`, `hashToken`, `commandCharacters`, `VIEWER_COMMANDS`, `engine.characterWake`), Task 1 (`Clock`).
- Produces (`apps/server/src/room.ts`):

```ts
export type Sender = { role: 'dock' } | { role: 'overlay' } | { role: 'viewer'; character: string };
export type RoomOutput =
  | { type: 'events'; events: GameEvent[] }
  | { type: 'views'; publicView: View; viewers: Map<string, View> }
  | { type: 'config-changed'; configVersion: number }
  | { type: 'token-revoked'; role: 'dock' | 'overlay'; tokenHash: string };
export interface RoomDeps { store: Store; clock: Clock; secrets: Secrets; bundles: PackBundle[]; log?: (msg: string, extra?: Record<string, unknown>) => void }
export const REQUEST_TTL = 300_000, IDLE_CHARACTER = 600_000, IDLE_ROOM = 1_800_000, STATE_VERSION = 1;
export function visibleTo(e: GameEvent, role: Role, character: string | null): boolean;
export class Room {
  static load(channelId: string, deps: RoomDeps): Promise<Room | null>;
  channel: ChannelRow; engine: Engine; game: GameState; lastActivity: number;
  command(sender: Sender, requestId: string, command: { type: string } & Record<string, unknown>): Promise<Answer>;
  view(sender: Sender): Promise<View>;
  describe(): Description;
  watch(characterId: string): Promise<View>;
  unwatch(characterId: string): void;
  subscribe(fn: (o: RoomOutput) => void): () => void;
  nextWake(): number | null;
  replayRevoked(tokenHash: string, requestId: string): Promise<Answer | null>;
  sweep(): Promise<void>;
  canUnload(now: number): boolean;
  idle(): Promise<void>;
  close(): void;
}
```

- Produces (`apps/server/src/server.ts`, first part):
  - `officialBundles(): Promise<PackBundle[]>` (every official pack, code included)
  - `defaultConfig(): Record<string, unknown>` (`channels/default.yaml`)
  - `createChannel(o: { store: Store; secrets: Secrets; bundles: PackBundle[]; name: string; config: Record<string, unknown>; seed: number }): Promise<{ id: string; dockToken: string; overlayToken: string }>` (throws `ValidationError` for a bad config)

Tasks 3 and 4 fill in the parts of `Room` this task leaves as stubs (timers, memory rules, views, server commands). The class is written once here in full so each later task only adds tests and fills in a marked method.

- [ ] **Step 1: `server.ts` first part**

`apps/server/src/server.ts`:

```ts
import { join } from 'node:path';
import { createEngine, type PackBundle } from '@dndm/engine';
import { listPackDirs, loadChannel, loadPacks, repoRoot } from '@dndm/pack-loader';
import { hashToken, newToken, type Secrets } from './crypto';
import { STATE_VERSION } from './room';
import type { Store } from './store';

/** Every official pack, code included: any channel may enable any of them (spec 2a §2.2). */
export function officialBundles(): Promise<PackBundle[]> {
  return loadPacks(listPackDirs());
}

export function defaultConfig(): Record<string, unknown> {
  return loadChannel(join(repoRoot(), 'channels', 'default.yaml')) as Record<string, unknown>;
}

/** Spec 2a §8.1: validates the config, creates the channel and its room, returns the tokens. */
export async function createChannel(o: {
  store: Store; secrets: Secrets; bundles: PackBundle[]; name: string; config: Record<string, unknown>; seed: number;
}): Promise<{ id: string; dockToken: string; overlayToken: string }> {
  const engine = createEngine({ packs: o.bundles, channel: o.config });
  const g = engine.newGame({ seed: o.seed });
  if (g.version !== STATE_VERSION) throw new Error(`The engine's game version ${g.version} isn't supported by this server`);
  const dockToken = newToken();
  const overlayToken = newToken();
  const id = await o.store.createChannel({
    name: o.name, config: o.config,
    room: { stateVersion: g.version, clock: g.clock, rng: g.rng, seq: g.seq, session: g.session, recentRequests: [] },
    dock: { hash: hashToken(dockToken), enc: o.secrets.encrypt(dockToken) },
    overlay: { hash: hashToken(overlayToken), enc: o.secrets.encrypt(overlayToken) },
  });
  return { id, dockToken, overlayToken };
}
```

- [ ] **Step 2: Write `room.ts`**

`apps/server/src/room.ts`:

```ts
import {
  type Command, commandCharacters, createEngine, type Description, type Engine, EngineError, formatIssue,
  type GameEvent, type GameState, type PackBundle, ValidationError, VIEWER_COMMANDS, type View,
} from '@dndm/engine';
import { type Answer, isReadOnlyCommand, isServerCommand, type Role, type ServerCommand, serverCommandSchema } from '@dndm/protocol';
import type { Clock } from './clock';
import { hashToken, newToken, type Secrets } from './crypto';
import type { RecentRequest } from './db/schema';
import type { CharacterSave, ChannelRow, RoomRow, Store } from './store';

export type Sender = { role: 'dock' } | { role: 'overlay' } | { role: 'viewer'; character: string };
export type RoomOutput =
  | { type: 'events'; events: GameEvent[] }
  | { type: 'views'; publicView: View; viewers: Map<string, View> }
  | { type: 'config-changed'; configVersion: number }
  | { type: 'token-revoked'; role: 'dock' | 'overlay'; tokenHash: string };
export interface RoomDeps {
  store: Store; clock: Clock; secrets: Secrets; bundles: PackBundle[];
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export const REQUEST_TTL = 5 * 60_000;
export const IDLE_CHARACTER = 10 * 60_000;
export const IDLE_ROOM = 30 * 60_000;
export const STATE_VERSION = 1;

type Raw = { type: string } & Record<string, unknown>;
const fail = (code: string, message: string): Answer => ({ ok: false, error: { code, message } });

/** Spec 2a §5: the dock sees every event; the overlay only public ones; a viewer public ones and their own. */
export function visibleTo(e: GameEvent, role: Role, character: string | null): boolean {
  if (role === 'dock' || !e.audience) return true;
  return role === 'viewer' && character !== null && e.audience.includes(character);
}

function filterFor(sender: Sender, a: Answer): Answer {
  if (!a.ok || sender.role === 'dock') return a;
  const character = sender.role === 'viewer' ? sender.character : null;
  return { ...a, events: a.events.filter((e) => visibleTo(e, sender.role, character)) };
}

const requestKey = (s: Sender, id: string) => (s.role === 'viewer' ? `viewer:${s.character}:${id}` : `${s.role}:${id}`);

/** One channel's live game (spec 2a §6). */
export class Room {
  lastActivity: number;
  private queue: Promise<void> = Promise.resolve();
  private saved = new Map<string, string>();
  private touched = new Map<string, number>();
  private watchers = new Map<string, number>();
  private lastViews = new Map<string, string>();
  private listeners = new Set<(o: RoomOutput) => void>();
  private cancelTimer: (() => void) | null = null;
  private failures = 0;
  private closed = false;

  private constructor(
    private readonly deps: RoomDeps,
    public channel: ChannelRow,
    public engine: Engine,
    public game: GameState,
    private recent: RecentRequest[],
  ) {
    this.lastActivity = deps.clock.now();
  }

  /** Spec 2a §6.2 "Loading a Room": the room row, the party, characters with timers, removed ones; then resume. */
  static async load(channelId: string, deps: RoomDeps): Promise<Room | null> {
    const channel = await deps.store.channel(channelId);
    if (!channel) return null;
    const row = await deps.store.room(channelId);
    if (!row) throw new Error(`Channel ${channelId} has no room`);
    if (row.stateVersion !== STATE_VERSION) throw new Error(`Room ${channelId} was saved by game version ${row.stateVersion}, which this server doesn't support`);
    const engine = createEngine({ packs: deps.bundles, channel: channel.config });
    const game: GameState = { version: STATE_VERSION, clock: row.clock, rng: row.rng, seq: row.seq, session: row.session, characters: {} };
    const room = new Room(deps, channel, engine, game, row.recentRequests);
    const withRemoved = !!row.session && engine.registry.settings.streamerRemovalWaitsForRest;
    room.add(await deps.store.roomCharacters(channelId, row.session?.party ?? [], withRemoved));
    const now = deps.clock.now();
    const r = engine.resume(room.game, now);
    if (!(await room.save(r.game, room.pruned(now)))) throw new Error(`Room ${channelId} could not be saved after loading`);
    room.arm();
    return room;
  }

  // ---- inputs ----

  async command(sender: Sender, requestId: string, raw: Raw): Promise<Answer> {
    if (sender.role === 'overlay') return fail('forbidden', 'The overlay can only watch');
    const type = raw.type;
    let server: ServerCommand | null = null;
    if (isServerCommand(type)) {
      if (sender.role !== 'dock') return fail('streamer-only', 'Only the streamer can do that');
      const parsed = serverCommandSchema.safeParse(raw);
      if (!parsed.success) return fail('bad-command', parsed.error.issues[0]?.message ?? 'Bad command');
      server = parsed.data;
      if (isReadOnlyCommand(type)) return this.readOnly(server);
    }
    let command = raw;
    if (sender.role === 'viewer') {
      if (!(VIEWER_COMMANDS as readonly string[]).includes(type)) return fail('streamer-only', 'Only the streamer can do that');
      command = { ...raw, character: sender.character };
    }
    const key = requestKey(sender, requestId);
    return this.run(async () => {
      const now = this.deps.clock.now();
      this.lastActivity = now;
      const prior = this.recent.find((r) => r.key === key && now - r.at < REQUEST_TTL);
      if (prior) return filterFor(sender, this.open(prior));
      try {
        if (server) return await this.serverCommand(server, key, now);
        return filterFor(sender, await this.engineCommand(command, key, now));
      } catch (e) {
        this.deps.log?.('room error', { channel: this.channel.id, error: e instanceof Error ? e.stack : String(e) });
        return fail('internal', 'Something went wrong on the server');
      }
    });
  }

  private async engineCommand(command: Raw, key: string, now: number): Promise<Answer> {
    const ids = commandCharacters(command);
    await this.ensureLoaded(ids);
    if (command.type === 'openSession' && this.engine.registry.settings.streamerRemovalWaitsForRest) {
      this.add(await this.deps.store.removedCharacters(this.channel.id));
    }
    const r = this.engine.apply(this.game, command as unknown as Command, now);
    if (!r.ok) return { ok: false, error: r.error };
    const answer: Answer = { ok: true, events: r.events };
    if (!(await this.save(r.game, [...this.pruned(now), { key, at: now, answer }]))) {
      return fail('save-failed', 'The game could not be saved, so nothing changed. Try again.');
    }
    for (const id of ids) this.touched.set(id, now);
    this.afterInput(r.events, now);
    return answer;
  }

  async view(sender: Sender): Promise<View> {
    return this.run(async () => {
      const now = this.deps.clock.now();
      if (sender.role !== 'viewer') return this.engine.view(this.game, null, now);
      await this.ensureLoaded([sender.character]);
      this.touched.set(sender.character, now);
      return this.engine.view(this.game, sender.character, now);
    });
  }

  describe(): Description {
    return this.engine.describe();
  }

  nextWake(): number | null {
    return this.engine.nextWakeTime(this.game);
  }

  subscribe(fn: (o: RoomOutput) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // ---- filled in by Task 3 ----
  async watch(_characterId: string): Promise<View> { throw new Error('Task 3'); }
  unwatch(_characterId: string): void {}
  async sweep(): Promise<void> {}
  canUnload(_now: number): boolean { return false; }
  private arm(): void {}
  private afterInput(events: GameEvent[], _now: number): void {
    if (events.length) this.emit({ type: 'events', events });
  }

  // ---- filled in by Task 4 ----
  private readOnly(_c: ServerCommand): Answer { return fail('internal', 'Task 4'); }
  private async serverCommand(_c: ServerCommand, _key: string, _now: number): Promise<Answer> { return fail('internal', 'Task 4'); }
  async replayRevoked(_tokenHash: string, _requestId: string): Promise<Answer | null> { return null; }

  // ---- plumbing ----

  /** Every input runs here, one at a time (spec 2a §6.1). */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.then(() => undefined, () => undefined);
    return p;
  }

  async idle(): Promise<void> {
    let q: Promise<void>;
    do { q = this.queue; await q; } while (q !== this.queue);
  }

  close(): void {
    this.closed = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private emit(o: RoomOutput): void {
    for (const fn of this.listeners) {
      try { fn(o); } catch (e) { this.deps.log?.('listener error', { channel: this.channel.id, error: String(e) }); }
    }
  }

  private add(chars: { id: string }[]): void {
    for (const ch of chars) {
      if (this.game.characters[ch.id]) continue;
      this.game.characters[ch.id] = ch as GameState['characters'][string];
      this.saved.set(ch.id, JSON.stringify(ch));
    }
  }

  private async ensureLoaded(ids: string[]): Promise<void> {
    const missing = ids.filter((id) => !this.game.characters[id]);
    if (missing.length) this.add(await this.deps.store.characters(this.channel.id, missing));
  }

  private pruned(now: number): RecentRequest[] {
    return this.recent.filter((r) => now - r.at < REQUEST_TTL);
  }

  private open(r: RecentRequest): Answer {
    const a = r.answer as Answer | { enc: string };
    return 'enc' in a ? (JSON.parse(this.deps.secrets.decrypt(a.enc)) as Answer) : a;
  }

  private roomRow(game: GameState, recent: RecentRequest[]): RoomRow {
    return { stateVersion: game.version, clock: game.clock, rng: game.rng, seq: game.seq, session: game.session, recentRequests: recent };
  }

  private changed(next: GameState, engine: Engine = this.engine, all = false): CharacterSave[] {
    const out: CharacterSave[] = [];
    for (const [id, ch] of Object.entries(next.characters)) {
      if (!all && this.saved.get(id) === JSON.stringify(ch)) continue;
      out.push({ data: ch, wakeAt: engine.characterWake(next, id), removed: ch.removedByStreamer });
    }
    return out;
  }

  /** Spec 2a §6.1 step 3 and §6.3: save, or keep the old state and report false. */
  private async save(next: GameState, recent: RecentRequest[]): Promise<boolean> {
    const chars = this.changed(next);
    try {
      await this.deps.store.saveInput(this.channel.id, this.roomRow(next, recent), chars);
    } catch (e) {
      this.deps.log?.('save failed', { channel: this.channel.id, error: String(e) });
      return false;
    }
    this.game = next;
    this.recent = recent;
    for (const c of chars) this.saved.set(c.data.id, JSON.stringify(c.data));
    return true;
  }
}
```

Note: `arm`, `afterInput` and the Task 3/4 stubs are `private` methods that later tasks replace in place. The `ServerCommand` and `RoomRow` imports are used by those tasks; keep them.

- [ ] **Step 3: The test helper**

`apps/server/test/helpers/room.ts`:

```ts
import type { PackBundle } from '@dndm/engine';
import { FakeClock } from '../../src/clock';
import { Secrets } from '../../src/crypto';
import { Room, type RoomDeps, type RoomOutput, type Sender } from '../../src/room';
import { createChannel, defaultConfig, officialBundles } from '../../src/server';
import { Store } from '../../src/store';
import { freshDb } from './db';

let bundles: PackBundle[] | null = null;
export const SECRET = 'test-secret-0123456789';

export async function roomSetup(opts: { settings?: Record<string, unknown>; seed?: number } = {}) {
  const t = await freshDb();
  const store = new Store(t.db, t.sql);
  const clock = new FakeClock(0);
  const secrets = new Secrets(SECRET);
  bundles ??= await officialBundles();
  const base = defaultConfig() as { settings?: Record<string, unknown> };
  const config = { ...base, settings: { ...(base.settings ?? {}), ...(opts.settings ?? {}) } };
  const made = await createChannel({ store, secrets, bundles, name: 'test', config, seed: opts.seed ?? 1 });
  const deps: RoomDeps = { store, clock, secrets, bundles };
  let room = (await Room.load(made.id, deps))!;
  const out: RoomOutput[] = [];
  let unsub = room.subscribe((o) => out.push(o));
  let n = 0;
  const s = {
    t, store, clock, secrets, deps, made, out,
    get room() { return room; },
    dock: { role: 'dock' } as Sender,
    overlay: { role: 'overlay' } as Sender,
    v: (name: string): Sender => ({ role: 'viewer', character: `dev:${name}` }),
    cmd: (sender: Sender, command: Record<string, unknown> & { type: string }, id = `r${++n}`) => room.command(sender, id, command),
    advance: (ms: number) => clock.advance(ms, () => room.idle()),
    /** Drops the Room and loads it again from the database, like a restart. */
    async reload() {
      room.close(); unsub();
      room = (await Room.load(made.id, deps))!;
      unsub = room.subscribe((o) => out.push(o));
      return room;
    },
    events: () => out.flatMap((o) => (o.type === 'events' ? o.events : [])),
    async done() { room.close(); await t.drop(); },
  };
  return s;
}
```

- [ ] **Step 4: Write the failing tests**

`apps/server/test/room-commands.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { roomSetup } from './helpers/room';

let s: Awaited<ReturnType<typeof roomSetup>>;
afterEach(async () => { await s.done(); });

const join = (pick = 'starter:sword') => ({ type: 'join', name: 'Al', pick });

describe('Room commands (spec 2a §4.1, §6.1)', () => {
  it('runs a command, saves it, then answers and publishes', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    const a = await s.cmd(s.v('al'), join());
    expect(a).toMatchObject({ ok: true, events: [{ type: 'core:joined', data: { character: 'dev:al' } }] });
    expect((await s.store.characters(s.made.id, ['dev:al']))[0]!.name).toBe('Al');
    expect((await s.store.room(s.made.id))!.session!.party).toEqual(['dev:al']);
    expect(s.events().map((e) => e.type)).toEqual(['core:session-opened', 'core:joined']);
  });

  it('a viewer always acts as themselves and only sends viewer commands', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    const a = await s.cmd(s.v('al'), { ...join(), character: 'dev:bo' });
    expect(a.ok && a.events[0]!.data).toEqual({ character: 'dev:al' });
    expect(await s.cmd(s.v('al'), { type: 'giveGold', target: 'dev:al', amount: 99 })).toMatchObject({ ok: false, error: { code: 'streamer-only' } });
    expect(await s.cmd(s.overlay, { type: 'openSession' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('engine rejections are answers, saved nothing and published nothing', async () => {
    s = await roomSetup();
    const before = await s.store.room(s.made.id);
    expect(await s.cmd(s.v('al'), join())).toMatchObject({ ok: false, error: { code: 'no-session' } });
    expect(await s.store.room(s.made.id)).toEqual(before);
    expect(s.out).toEqual([]);
  });

  it('runs commands one at a time, in order', async () => {
    s = await roomSetup();
    const [a, b] = await Promise.all([s.cmd(s.dock, { type: 'openSession' }), s.cmd(s.v('al'), join())]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('a repeated request ID returns the first answer, even after a restart', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    await s.cmd(s.v('al'), join());
    const give = { type: 'giveGold', target: 'dev:al', amount: 5 };
    const first = await s.cmd(s.dock, give, 'gift-1');
    expect(await s.cmd(s.dock, give, 'gift-1')).toEqual(first);
    await s.reload();
    expect(await s.cmd(s.dock, give, 'gift-1')).toEqual(first);
    expect((await s.store.characters(s.made.id, ['dev:al']))[0]!.gold).toBe(5);
    await s.advance(5 * 60_000);
    await s.cmd(s.dock, give, 'gift-1');
    expect((await s.store.characters(s.made.id, ['dev:al']))[0]!.gold).toBe(10);
  });

  it('a repeated ID for a rejected command runs it again', async () => {
    s = await roomSetup();
    expect((await s.cmd(s.dock, { type: 'closeSession' }, 'x')).ok).toBe(false);
    await s.cmd(s.dock, { type: 'openSession' });
    expect((await s.cmd(s.dock, { type: 'closeSession' }, 'x')).ok).toBe(true);
  });

  it('request IDs belong to their sender', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    expect((await s.cmd(s.v('al'), join(), 'same')).ok).toBe(true);
    expect((await s.cmd(s.v('bo'), { ...join(), name: 'Bo' }, 'same')).ok).toBe(true);
    expect(s.room.game.session!.party).toEqual(['dev:al', 'dev:bo']);
  });

  it('a failed save keeps the old state and tells the sender', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    const real = s.store.saveInput.bind(s.store);
    s.store.saveInput = async () => { throw new Error('database down'); };
    const before = s.out.length;
    expect(await s.cmd(s.v('al'), join())).toMatchObject({ ok: false, error: { code: 'save-failed' } });
    expect(s.room.game.session!.party).toEqual([]);
    expect(s.out.length).toBe(before);
    s.store.saveInput = real;
    expect((await s.cmd(s.v('al'), join())).ok).toBe(true);
  });

  it('loads a saved character before a command that names them', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    await s.cmd(s.v('al'), join());
    await s.cmd(s.dock, { type: 'giveGold', target: 'dev:al', amount: 7 });
    await s.cmd(s.v('al'), { type: 'leave' });
    await s.reload();
    expect(s.room.game.characters['dev:al']).toBeUndefined();
    expect((await s.cmd(s.dock, { type: 'giveGold', target: 'dev:al', amount: 1 })).ok).toBe(true);
    expect(s.room.game.characters['dev:al']!.gold).toBe(8);
  });
});
```

- [ ] **Step 5: Run them to verify they fail, then pass**

Run: `pnpm vitest run apps/server/test/room-commands.test.ts`
Expected before Step 2's files exist: FAIL (missing modules). After writing Steps 1–3: PASS (9 tests). Check that the "loads a saved character" test really reloaded without `dev:al`: the reload keeps only party members and characters with timers, and Al left the party.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(server): Room input queue, save-before-answer, request IDs"
```

---

### Task 3: Room: timers, views, watching and the memory rules

**Files:**
- Modify: `apps/server/src/room.ts` (replace the Task 3 stubs)
- Test: `apps/server/test/room-time.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces: working `watch`, `unwatch`, `sweep`, `canUnload`, `arm` and `afterInput`.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/room-time.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { IDLE_CHARACTER, IDLE_ROOM } from '../src/room';
import { roomSetup } from './helpers/room';

let s: Awaited<ReturnType<typeof roomSetup>>;
afterEach(async () => { await s.done(); });

async function fight(names = ['al']) {
  await s.cmd(s.dock, { type: 'openSession' });
  for (const n of names) await s.cmd(s.v(n), { type: 'join', name: n, pick: 'starter:sword' });
  await s.cmd(s.dock, { type: 'spawnMonster', monster: 'starter:slime' });
}

describe('Room timers (spec 2a §6.1, §6.3)', () => {
  it('runs monster turns on time and saves them', async () => {
    s = await roomSetup();
    await fight();
    await s.advance(15_000);
    expect(s.events().some((e) => e.type === 'core:ability-used')).toBe(true);
    expect((await s.store.room(s.made.id))!.clock).toBe(15_000);
  });

  it('a failed save holds the events back and retries with backoff', async () => {
    s = await roomSetup();
    await fight();
    const real = s.store.saveInput.bind(s.store);
    const tries: number[] = [];
    s.store.saveInput = async () => { tries.push(s.clock.now()); throw new Error('down'); };
    const before = s.events().length;
    await s.advance(18_000);
    expect(tries).toEqual([15_000, 16_000, 18_000]);
    expect(s.events().length).toBe(before);
    s.store.saveInput = real;
    await s.advance(4_000);
    expect(s.events().slice(before).some((e) => e.type === 'core:ability-used')).toBe(true);
  });
});

describe('views and watching (spec 2a §5)', () => {
  it('sends the public view after every input and a viewer view only when it changed', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    const first = await s.room.watch('dev:al');
    expect(first.character).toBeNull();
    const from = s.out.length;
    await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
    await s.cmd(s.dock, { type: 'postMessage', text: 'hi' });
    const views = s.out.slice(from).filter((o) => o.type === 'views');
    expect(views).toHaveLength(2);
    expect(views.map((v) => v.type === 'views' && v.viewers.has('dev:al'))).toEqual([true, false]);
  });
});

describe('memory rules (spec 2a §6.2, §6.6)', () => {
  it('drops a character who left, after 10 idle minutes, but not while watched', async () => {
    s = await roomSetup();
    await fight(['al', 'bo']);
    await s.cmd(s.dock, { type: 'endEncounter' });
    await s.cmd(s.v('al'), { type: 'leave' });
    await s.cmd(s.v('bo'), { type: 'leave' });
    await s.room.watch('dev:bo');
    await s.advance(IDLE_CHARACTER);
    await s.room.sweep();
    expect(s.room.game.characters['dev:al']).toBeUndefined();
    expect(s.room.game.characters['dev:bo']).toBeDefined();
    s.room.unwatch('dev:bo');
    await s.room.sweep();
    expect(s.room.game.characters['dev:bo']).toBeUndefined();
  });

  it('keeps a knocked-out character who left until the knockout ends', async () => {
    s = await roomSetup({ settings: { 'knockout-duration': '20m' } });
    await fight();
    await s.cmd(s.dock, { type: 'knockOut', character: 'dev:al' });
    await s.cmd(s.dock, { type: 'endEncounter' });
    await s.cmd(s.v('al'), { type: 'leave' });
    await s.advance(IDLE_CHARACTER);
    await s.room.sweep();
    expect(s.room.game.characters['dev:al']).toBeDefined();
  });

  it('keeps a removed character during the session, and the flag clears at rest', async () => {
    s = await roomSetup();
    await fight(['al', 'bo']);
    await s.cmd(s.dock, { type: 'removePlayer', character: 'dev:al' });
    await s.advance(IDLE_CHARACTER);
    await s.room.sweep();
    expect(s.room.game.characters['dev:al']!.removedByStreamer).toBe(true);
    await s.cmd(s.dock, { type: 'endEncounter' });
    // Cleared at the rest; with nothing keeping them loaded any more, only the saved copy remains.
    expect((await s.store.characters(s.made.id, ['dev:al']))[0]!.removedByStreamer).toBe(false);
  });

  it('opening a session loads removed characters so the flag can clear', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
    await s.cmd(s.dock, { type: 'closeSession' });
    // A flag left set while no session is open (possible when the setting was off at the time).
    const [al] = await s.store.characters(s.made.id, ['dev:al']);
    await s.store.saveInput(s.made.id, (await s.store.room(s.made.id))!, [{ data: { ...al!, removedByStreamer: true }, wakeAt: null, removed: true }]);
    await s.reload();
    expect(s.room.game.characters['dev:al']).toBeUndefined();
    await s.cmd(s.dock, { type: 'openSession' });
    expect(s.room.game.characters['dev:al']!.removedByStreamer).toBe(false);
    expect((await s.store.characters(s.made.id, ['dev:al']))[0]!.removedByStreamer).toBe(false);
  });

  it('a Room can unload only when idle, sessionless, unwatched and without timers', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    await s.advance(IDLE_ROOM);
    expect(s.room.canUnload(s.clock.now())).toBe(false);
    await s.cmd(s.dock, { type: 'closeSession' });
    expect(s.room.canUnload(s.clock.now())).toBe(false);
    await s.advance(IDLE_ROOM);
    expect(s.room.canUnload(s.clock.now())).toBe(false); // the test helper still listens
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run apps/server/test/room-time.test.ts`
Expected: FAIL (no monster turns, `watch` throws "Task 3").

- [ ] **Step 3: Replace the Task 3 stubs in `room.ts`**

Replace the block under `// ---- filled in by Task 3 ----` with:

```ts
  // ---- watching, views, timers and memory (spec 2a §5, §6.2, §6.6) ----

  /** A watched character stays loaded and gets their view after each input when it changed. */
  async watch(characterId: string): Promise<View> {
    return this.run(async () => {
      const now = this.deps.clock.now();
      this.watchers.set(characterId, (this.watchers.get(characterId) ?? 0) + 1);
      await this.ensureLoaded([characterId]);
      this.touched.set(characterId, now);
      const v = this.engine.view(this.game, characterId, now);
      this.lastViews.set(characterId, JSON.stringify(v));
      return v;
    });
  }

  unwatch(characterId: string): void {
    const n = (this.watchers.get(characterId) ?? 0) - 1;
    if (n > 0) { this.watchers.set(characterId, n); return; }
    this.watchers.delete(characterId);
    this.lastViews.delete(characterId);
  }

  async sweep(): Promise<void> {
    await this.run(async () => { this.drop(this.deps.clock.now()); });
  }

  canUnload(now: number): boolean {
    if (this.closed || this.game.session || this.watchers.size || this.listeners.size) return false;
    if (now - this.lastActivity < IDLE_ROOM) return false;
    return Object.keys(this.game.characters).every((id) => this.engine.characterWake(this.game, id) === null);
  }

  /** Spec 2a §6.2 "Staying loaded". Only characters whose saved copy is current are dropped. */
  private drop(now: number): void {
    const s = this.game.session;
    const waits = this.engine.registry.settings.streamerRemovalWaitsForRest;
    for (const [id, ch] of Object.entries(this.game.characters)) {
      if (s?.party.includes(id)) continue;
      if (this.engine.characterWake(this.game, id) !== null) continue;
      if (s && waits && ch.removedByStreamer) continue;
      if (this.watchers.has(id)) continue;
      if (now - (this.touched.get(id) ?? 0) < IDLE_CHARACTER) continue;
      if (this.saved.get(id) !== JSON.stringify(ch)) continue;
      delete this.game.characters[id];
      this.saved.delete(id);
      this.touched.delete(id);
    }
  }

  private afterInput(events: GameEvent[], now: number): void {
    this.drop(now);
    if (events.length) this.emit({ type: 'events', events });
    this.publishViews(now);
    this.arm();
  }

  private publishViews(now: number): void {
    const viewers = new Map<string, View>();
    for (const id of this.watchers.keys()) {
      const v = this.engine.view(this.game, id, now);
      const json = JSON.stringify(v);
      if (this.lastViews.get(id) !== json) { this.lastViews.set(id, json); viewers.set(id, v); }
    }
    this.emit({ type: 'views', publicView: this.engine.view(this.game, null, now), viewers });
  }

  /** One timer for the engine's next wake-up, or a retry after a failed save (spec 2a §6.3). */
  private arm(retryIn?: number): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.closed) return;
    const at = retryIn !== undefined ? this.deps.clock.now() + retryIn : this.engine.nextWakeTime(this.game);
    if (at === null) return;
    this.cancelTimer = this.deps.clock.setTimer(at, () => { void this.run(() => this.tick()); });
  }

  private async tick(): Promise<void> {
    if (this.closed) return;
    const now = this.deps.clock.now();
    const r = this.engine.advance(this.game, now);
    if (!(await this.save(r.game, this.pruned(now)))) {
      this.failures += 1;
      this.arm(Math.min(1000 * 2 ** (this.failures - 1), 30_000));
      return;
    }
    this.failures = 0;
    this.afterInput(r.events, now);
  }
```

Then delete the old Task 3 versions of `watch`, `unwatch`, `sweep`, `canUnload`, `arm` and `afterInput`.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run apps/server/test/room-time.test.ts apps/server/test/room-commands.test.ts`
Expected: PASS. In the backoff test the retries land at 15 s (the turn), 16 s (+1 s) and 18 s (+2 s).

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): Room timers with save retry, views, watching and memory rules"
```

---

### Task 4: Room: config changes and tokens

**Files:**
- Modify: `apps/server/src/room.ts` (replace the Task 4 stubs)
- Test: `apps/server/test/room-config.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: answers for the five server commands:
  - `getConfig` → `result: { config, configVersion }`
  - `validateConfig` → `result: { errors: string[] }`
  - `updateConfig` → `result: { configVersion }`
  - `regenerate*` → `result: { token }`
  - `replayRevoked(tokenHash, requestId)`

- [ ] **Step 1: Write the failing tests**

`apps/server/test/room-config.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto';
import { roomSetup } from './helpers/room';

let s: Awaited<ReturnType<typeof roomSetup>>;
afterEach(async () => { await s.done(); });

const get = async () => (await s.cmd(s.dock, { type: 'getConfig' })) as { ok: true; result: { config: Record<string, unknown>; configVersion: number } };

describe('config changes (spec 2a §6.5)', () => {
  it('reads and validates without saving or queueing', async () => {
    s = await roomSetup();
    const g = await get();
    expect(g.result.configVersion).toBe(1);
    expect(await s.cmd(s.dock, { type: 'validateConfig', config: { packs: ['nope'] } })).toMatchObject({ ok: true, result: { errors: [expect.any(String)] } });
    expect(await s.cmd(s.dock, { type: 'validateConfig', config: g.result.config })).toMatchObject({ ok: true, result: { errors: [] } });
    expect(await s.cmd(s.v('al'), { type: 'getConfig' })).toMatchObject({ ok: false, error: { code: 'streamer-only' } });
    expect((await s.store.room(s.made.id))!.recentRequests).toEqual([]);
  });

  it('refuses a stale or invalid config', async () => {
    s = await roomSetup();
    const { config } = (await get()).result;
    expect(await s.cmd(s.dock, { type: 'updateConfig', config, basedOn: 7 })).toMatchObject({ ok: false, error: { code: 'stale-config' } });
    expect(await s.cmd(s.dock, { type: 'updateConfig', config: { packs: 3 }, basedOn: 1 })).toMatchObject({ ok: false, error: { code: 'invalid-config' } });
    expect((await get()).result.configVersion).toBe(1);
  });

  it('refuses a change that breaks the running fight, mid-fight', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
    await s.cmd(s.dock, { type: 'spawnMonster', monster: 'starter:slime' });
    const { config } = (await get()).result;
    void config;
    expect(await s.cmd(s.dock, { type: 'updateConfig', config: { packs: [] }, basedOn: 1 })).toMatchObject({ ok: false, error: { code: 'content-in-use' } });
  });

  it('applies a good change mid-fight, saves it and tells everyone', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
    await s.cmd(s.dock, { type: 'spawnMonster', monster: 'starter:slime' });
    const { config } = (await get()).result;
    const next = { ...config, settings: { ...(config.settings as object), 'xp-multiplier': 2 } };
    expect(await s.cmd(s.dock, { type: 'updateConfig', config: next, basedOn: 1 })).toMatchObject({ ok: true, result: { configVersion: 2 } });
    expect(s.out).toContainEqual({ type: 'config-changed', configVersion: 2 });
    expect(s.room.engine.registry.settings.xpMultiplier).toBe(2);
    expect((await s.store.channel(s.made.id))!.configVersion).toBe(2);
  });

  it('turning streamer-removal-waits-for-rest on loads removed characters', async () => {
    s = await roomSetup({ settings: { 'streamer-removal-waits-for-rest': false } });
    await s.cmd(s.dock, { type: 'openSession' });
    for (const n of ['al', 'bo']) await s.cmd(s.v(n), { type: 'join', name: n, pick: 'starter:sword' });
    await s.cmd(s.dock, { type: 'spawnMonster', monster: 'starter:slime' });
    await s.cmd(s.dock, { type: 'removePlayer', character: 'dev:al' });
    await s.advance(11 * 60_000);
    await s.room.sweep();
    expect(s.room.game.characters['dev:al']).toBeUndefined();
    const { config } = (await get()).result;
    const on = { ...config, settings: { ...(config.settings as object), 'streamer-removal-waits-for-rest': true } };
    expect((await s.cmd(s.dock, { type: 'updateConfig', config: on, basedOn: 1 })).ok).toBe(true);
    expect(s.room.game.characters['dev:al']!.removedByStreamer).toBe(true);
  });
});

describe('tokens (spec 2a §4.1)', () => {
  it('regenerating replaces the token, revokes the old one and can be replayed with it', async () => {
    s = await roomSetup();
    const oldHash = hashToken(s.made.dockToken);
    const a = (await s.cmd(s.dock, { type: 'regenerateDockUrl' }, 'regen-1')) as { ok: true; result: { token: string } };
    expect(a.ok).toBe(true);
    expect(s.room.channel.dockTokenHash).toBe(hashToken(a.result.token));
    expect(s.out).toContainEqual({ type: 'token-revoked', role: 'dock', tokenHash: oldHash });
    expect(await s.room.replayRevoked(oldHash, 'regen-1')).toEqual(a);
    expect(await s.room.replayRevoked(oldHash, 'other')).toBeNull();
    expect(await s.cmd(s.dock, { type: 'regenerateDockUrl' }, 'regen-1')).toEqual(a);
    const stored = (await s.store.room(s.made.id))!.recentRequests.find((r) => r.key === 'dock:regen-1')!;
    expect(JSON.stringify(stored)).not.toContain(a.result.token);
    await s.advance(5 * 60_000);
    expect(await s.room.replayRevoked(oldHash, 'regen-1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run apps/server/test/room-config.test.ts`
Expected: FAIL (answers with `internal` "Task 4").

- [ ] **Step 3: Replace the Task 4 stubs in `room.ts`**

Replace the block under `// ---- filled in by Task 4 ----` with:

```ts
  // ---- server commands (spec 2a §4.1, §6.5) ----

  /** getConfig and validateConfig change nothing, so they skip the queue and the request-ID store (§6.1). */
  private readOnly(c: ServerCommand): Answer {
    if (c.type === 'getConfig') return { ok: true, events: [], result: { config: this.channel.config, configVersion: this.channel.configVersion } };
    if (c.type !== 'validateConfig') return fail('bad-command', 'Not a read-only command');
    const checked = this.check(c.config);
    return { ok: true, events: [], result: { errors: 'errors' in checked ? checked.errors : [] } };
  }

  private check(config: Record<string, unknown>): { engine: Engine } | { errors: string[] } {
    try {
      return { engine: createEngine({ packs: this.deps.bundles, channel: config }) };
    } catch (e) {
      if (e instanceof ValidationError) return { errors: e.issues.map(formatIssue) };
      throw e;
    }
  }

  private async serverCommand(c: ServerCommand, key: string, now: number): Promise<Answer> {
    if (c.type === 'updateConfig') return this.updateConfig(c.config, c.basedOn, key, now);
    if (c.type === 'regenerateDockUrl') return this.regenerate('dock', key, now);
    if (c.type === 'regenerateOverlayUrl') return this.regenerate('overlay', key, now);
    return fail('bad-command', 'Not a command that changes anything');
  }

  private async updateConfig(config: Record<string, unknown>, basedOn: number, key: string, now: number): Promise<Answer> {
    const current = this.channel.configVersion;
    if (basedOn !== current) return fail('stale-config', `The config changed since you loaded it (it's now version ${current})`);
    const checked = this.check(config);
    if ('errors' in checked) return fail('invalid-config', checked.errors.join('\n'));
    const next = checked.engine;
    try {
      next.adopt(this.game);
    } catch (e) {
      if (e instanceof EngineError) return fail(e.code, e.message);
      throw e;
    }
    const before = this.engine.registry.settings.streamerRemovalWaitsForRest;
    if (this.game.session && next.registry.settings.streamerRemovalWaitsForRest && !before) {
      this.add(await this.deps.store.removedCharacters(this.channel.id));
    }
    const version = current + 1;
    const answer: Answer = { ok: true, events: [], result: { configVersion: version } };
    const recent = [...this.pruned(now), { key, at: now, answer }];
    const chars = this.changed(this.game, next, true);
    try {
      await this.deps.store.saveConfig(this.channel.id, config, version, this.roomRow(this.game, recent), chars);
    } catch (e) {
      this.deps.log?.('save failed', { channel: this.channel.id, error: String(e) });
      return fail('save-failed', 'The config could not be saved, so nothing changed. Try again.');
    }
    this.engine = next;
    this.channel = { ...this.channel, config, configVersion: version };
    this.recent = recent;
    for (const ch of chars) this.saved.set(ch.data.id, JSON.stringify(ch.data));
    this.emit({ type: 'config-changed', configVersion: version });
    this.afterInput([], now);
    return answer;
  }

  /** The answer is kept with the token encrypted, and can be replayed with the token it replaced (§4.1). */
  private async regenerate(role: 'dock' | 'overlay', key: string, now: number): Promise<Answer> {
    const token = newToken();
    const hash = hashToken(token);
    const oldHash = role === 'dock' ? this.channel.dockTokenHash : this.channel.overlayTokenHash;
    const answer: Answer = { ok: true, events: [], result: { token } };
    const entry: RecentRequest = { key, at: now, answer: { enc: this.deps.secrets.encrypt(JSON.stringify(answer)) }, replacedHash: oldHash };
    const recent = [...this.pruned(now), entry];
    const enc = this.deps.secrets.encrypt(token);
    try {
      await this.deps.store.saveToken(this.channel.id, role, { hash, enc }, this.roomRow(this.game, recent));
    } catch (e) {
      this.deps.log?.('save failed', { channel: this.channel.id, error: String(e) });
      return fail('save-failed', 'The new token could not be saved, so the old one still works. Try again.');
    }
    this.recent = recent;
    this.channel = role === 'dock'
      ? { ...this.channel, dockTokenHash: hash, dockTokenEnc: enc }
      : { ...this.channel, overlayTokenHash: hash, overlayTokenEnc: enc };
    this.emit({ type: 'token-revoked', role, tokenHash: oldHash });
    return answer;
  }

  /** A dock that regenerated its own token retries with the old one (§4.1). */
  async replayRevoked(tokenHash: string, requestId: string): Promise<Answer | null> {
    return this.run(async () => {
      const now = this.deps.clock.now();
      const r = this.recent.find((x) => x.replacedHash === tokenHash && x.key === `dock:${requestId}` && now - x.at < REQUEST_TTL);
      return r ? this.open(r) : null;
    });
  }
```

Then delete the old Task 4 stubs.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run apps/server/test/room-config.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the server suite and commit**

Run: `pnpm vitest run apps/server && pnpm typecheck`
Expected: all PASS.

```bash
git add apps/server
git commit -m "feat(server): config changes with adopt, token regeneration and replay"
```

---

### Task 5: RoomManager and Hub

**Files:**
- Create: `apps/server/src/room-manager.ts`, `apps/server/src/hub.ts`
- Test: `apps/server/test/hub.test.ts`

**Interfaces:**
- Consumes: `Room`, `RoomDeps`, `RoomOutput`, `visibleTo`, `ServerMessage`, `WS_CLOSE`.
- Produces:

```ts
export class RoomManager {
  constructor(deps: RoomDeps);
  get(channelId: string): Promise<Room | null>;
  boot(): Promise<void>;
  sweep(): Promise<void>;
  startSweeper(): void;
  rooms(): Room[];
  idle(): Promise<void>;
  close(): void;
}
export interface Conn { role: Role; character: string | null; tokenHash: string | null; send(m: ServerMessage): void; close(code: number, reason: string): void }
export class Hub { add(room: Room, conn: Conn): Promise<void>; remove(room: Room, conn: Conn): void }
```

- [ ] **Step 1: Write the failing test**

`apps/server/test/hub.test.ts`:

```ts
import type { ServerMessage } from '@dndm/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto';
import { type Conn, Hub } from '../src/hub';
import { RoomManager } from '../src/room-manager';
import { roomSetup } from './helpers/room';

let s: Awaited<ReturnType<typeof roomSetup>>;
afterEach(async () => { await s.done(); });

function conn(role: Conn['role'], character: string | null = null, tokenHash: string | null = null) {
  const got: ServerMessage[] = [];
  const closed: number[] = [];
  const c: Conn = { role, character, tokenHash, send: (m) => got.push(m), close: (code) => closed.push(code) };
  return { c, got, closed, types: () => got.map((m) => m.type) };
}

const shop = { type: 'startEncounter', encounter: { 'starter:shop': { stock: [{ item: 'starter:health-potion', price: 1 }], secret: true } } };

describe('Hub (spec 2a §5)', () => {
  it('welcomes each role with its view, then fans out by audience', async () => {
    s = await roomSetup();
    const hub = new Hub();
    const dock = conn('dock', null, hashToken(s.made.dockToken));
    const overlay = conn('overlay');
    const al = conn('viewer', 'dev:al');
    const cy = conn('viewer', 'dev:cy');
    for (const x of [dock, overlay, al, cy]) await hub.add(s.room, x.c);
    expect(dock.types()).toEqual(['welcome']);
    await s.cmd(s.dock, { type: 'openSession' });
    await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
    await s.cmd(s.dock, shop);
    const eventsOf = (x: typeof dock) => x.got.flatMap((m) => (m.type === 'events' ? m.events.map((e) => e.type) : []));
    expect(eventsOf(dock)).toContain('core:encounter-started');
    expect(eventsOf(al)).toContain('core:encounter-started');
    expect(eventsOf(overlay)).not.toContain('core:encounter-started');
    expect(eventsOf(cy)).not.toContain('core:encounter-started');
    expect(overlay.types()).toContain('view');
  });

  it('closes connections that used a revoked token', async () => {
    s = await roomSetup();
    const hub = new Hub();
    const dock = conn('dock', null, hashToken(s.made.dockToken));
    await hub.add(s.room, dock.c);
    await s.cmd(s.dock, { type: 'regenerateDockUrl' });
    expect(dock.closed).toEqual([4403]);
  });

  it('stops watching when a viewer leaves', async () => {
    s = await roomSetup();
    const hub = new Hub();
    const al = conn('viewer', 'dev:al');
    await hub.add(s.room, al.c);
    hub.remove(s.room, al.c);
    await s.cmd(s.dock, { type: 'openSession' });
    expect(al.types()).toEqual(['welcome']);
  });
});

describe('RoomManager (spec 2a §6.4, §6.6)', () => {
  it('loads a Room once, even when asked twice at the same time', async () => {
    s = await roomSetup();
    const m = new RoomManager(s.deps);
    const [a, b] = await Promise.all([m.get(s.made.id), m.get(s.made.id)]);
    expect(a).toBe(b);
    expect(await m.get('6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b')).toBeNull();
    m.close();
  });

  it('boots Rooms with a session open, and unloads idle ones', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    s.room.close();
    const m = new RoomManager(s.deps);
    await m.boot();
    expect(m.rooms().map((r) => r.channel.id)).toEqual([s.made.id]);
    const room = m.rooms()[0]!;
    await room.command({ role: 'dock' }, 'c', { type: 'closeSession' });
    await s.clock.advance(31 * 60_000, () => m.idle());
    await m.sweep();
    expect(m.rooms()).toEqual([]);
    m.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/server/test/hub.test.ts`
Expected: FAIL (cannot find `../src/hub`).

- [ ] **Step 3: Implement**

`apps/server/src/hub.ts`:

```ts
import { type Role, type ServerMessage, WS_CLOSE } from '@dndm/protocol';
import { type Room, type RoomOutput, visibleTo } from './room';

/** One live connection, whatever carries it (a WebSocket in 2a; 2b may add others). */
export interface Conn {
  role: Role;
  character: string | null;
  tokenHash: string | null;
  send(m: ServerMessage): void;
  close(code: number, reason: string): void;
}

/** Fans a Room's output out to its connections (spec 2a §5). */
export class Hub {
  private conns = new Map<Room, Set<Conn>>();
  private unsubs = new Map<Room, () => void>();

  async add(room: Room, conn: Conn): Promise<void> {
    let set = this.conns.get(room);
    if (!set) {
      set = new Set();
      this.conns.set(room, set);
      this.unsubs.set(room, room.subscribe((o) => this.deliver(room, o)));
    }
    set.add(conn);
    const view = conn.role === 'viewer' ? await room.watch(conn.character!) : await room.view({ role: conn.role } as { role: 'dock' | 'overlay' });
    conn.send({ type: 'welcome', role: conn.role, character: conn.character, view });
  }

  remove(room: Room, conn: Conn): void {
    const set = this.conns.get(room);
    if (!set?.delete(conn)) return;
    if (conn.role === 'viewer' && conn.character) room.unwatch(conn.character);
    if (!set.size) {
      this.conns.delete(room);
      this.unsubs.get(room)?.();
      this.unsubs.delete(room);
    }
  }

  private deliver(room: Room, o: RoomOutput): void {
    for (const c of [...(this.conns.get(room) ?? [])]) {
      switch (o.type) {
        case 'events': {
          const events = o.events.filter((e) => visibleTo(e, c.role, c.character));
          if (events.length) c.send({ type: 'events', events });
          break;
        }
        case 'views':
          if (c.role !== 'viewer') c.send({ type: 'view', view: o.publicView });
          else if (c.character && o.viewers.has(c.character)) c.send({ type: 'view', view: o.viewers.get(c.character)! });
          break;
        case 'config-changed':
          c.send({ type: 'config-changed', configVersion: o.configVersion });
          break;
        case 'token-revoked':
          if (c.tokenHash === o.tokenHash) {
            c.close(WS_CLOSE.revoked, 'This token was replaced');
            this.remove(room, c);
          }
          break;
      }
    }
  }
}
```

`apps/server/src/room-manager.ts`:

```ts
import { Room, type RoomDeps } from './room';

const SWEEP_EVERY = 60_000;

/** Loads Rooms on demand and at boot, and unloads idle ones (spec 2a §6.4, §6.6). */
export class RoomManager {
  private loaded = new Map<string, Room>();
  private loading = new Map<string, Promise<Room | null>>();
  private cancelSweep: (() => void) | null = null;

  constructor(readonly deps: RoomDeps) {}

  get(channelId: string): Promise<Room | null> {
    const room = this.loaded.get(channelId);
    if (room) return Promise.resolve(room);
    let p = this.loading.get(channelId);
    if (!p) {
      p = Room.load(channelId, this.deps)
        .then((r) => { if (r) this.loaded.set(channelId, r); return r; })
        .finally(() => this.loading.delete(channelId));
      this.loading.set(channelId, p);
    }
    return p;
  }

  rooms(): Room[] {
    return [...this.loaded.values()];
  }

  async boot(): Promise<void> {
    for (const id of await this.deps.store.roomsToBoot()) await this.get(id);
  }

  async sweep(): Promise<void> {
    const now = this.deps.clock.now();
    for (const [id, room] of this.loaded) {
      await room.sweep();
      if (room.canUnload(now)) {
        room.close();
        this.loaded.delete(id);
      }
    }
  }

  startSweeper(): void {
    const next = () => {
      this.cancelSweep = this.deps.clock.setTimer(this.deps.clock.now() + SWEEP_EVERY, () => {
        void this.sweep().catch((e) => this.deps.log?.('sweep failed', { error: String(e) })).finally(next);
      });
    };
    next();
  }

  async idle(): Promise<void> {
    await Promise.all(this.rooms().map((r) => r.idle()));
  }

  close(): void {
    this.cancelSweep?.();
    this.cancelSweep = null;
    for (const r of this.loaded.values()) r.close();
    this.loaded.clear();
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run apps/server/test/hub.test.ts`
Expected: PASS (5 tests). In "boots Rooms", `s.room.close()` stops the helper's Room so only the manager's copy runs; the helper's subscription doesn't apply to the manager's Room, so it can unload.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): RoomManager and Hub with audience filtering"
```

---

### Task 6: Auth, rate limits and the Fastify app

**Files:**
- Create: `apps/server/src/auth.ts`, `apps/server/src/app.ts`
- Modify: `apps/server/package.json` (add `fastify@5.12.5`, `@fastify/websocket@11.3.1`)
- Test: `apps/server/test/app.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5, `@dndm/protocol`.
- Produces:
  - `authenticate(room: Room, token: string | undefined, secrets: Secrets): Authed | ErrorBody`, with `Authed = Sender & { tokenHash: string | null }`
  - `class RateLimiter { constructor(clock: Clock, enabled?: boolean, limits?: Record<Role, number>); take(role: Role, key: string): boolean }`
  - `buildApp(deps: { manager: RoomManager; hub: Hub; secrets: Secrets; limiter: RateLimiter; dev: boolean; helloTimeoutMs?: number }): Promise<FastifyInstance>`
  - Routes:
    - `POST /channels/:channel/commands`
    - `GET /channels/:channel/view` → `{ ok: true, view }`
    - `GET /channels/:channel/describe` → `{ ok: true, describe }`
    - `GET /channels/:channel/live` (WebSocket)
    - `POST /dev/login` → `{ ok: true, token, character }` (only when `dev`)

- [ ] **Step 1: Add the dependencies**

In `apps/server/package.json` `dependencies` add `"fastify": "5.12.5"` and `"@fastify/websocket": "11.3.1"`.

Run: `pnpm install`
Expected: installs; lockfile updated.

- [ ] **Step 2: Write the failing test**

`apps/server/test/app.test.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { RateLimiter } from '../src/auth';
import { Hub } from '../src/hub';
import { RoomManager } from '../src/room-manager';
import { roomSetup } from './helpers/room';

let s: Awaited<ReturnType<typeof roomSetup>>;
let app: FastifyInstance;
let manager: RoomManager;
afterEach(async () => { await app.close(); manager.close(); await s.done(); });

async function setup(opts: { dev?: boolean; limits?: boolean; helloTimeoutMs?: number } = {}) {
  s = await roomSetup();
  s.room.close();
  manager = new RoomManager(s.deps);
  app = await buildApp({
    manager, hub: new Hub(), secrets: s.secrets, limiter: new RateLimiter(s.clock, opts.limits ?? false),
    dev: opts.dev ?? true, helloTimeoutMs: opts.helloTimeoutMs,
  });
  await app.ready();
}

const post = (token: string | null, id: string, command: Record<string, unknown>, channel = s.made.id) =>
  app.inject({
    method: 'POST', url: `/channels/${channel}/commands`, payload: { id, command },
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
const login = async (viewer: string) => (await app.inject({ method: 'POST', url: '/dev/login', payload: { channel: s.made.id, viewer } })).json().token as string;

describe('HTTP API (spec 2a §4)', () => {
  it('runs dock and viewer commands with their tokens', async () => {
    await setup();
    expect((await post(s.made.dockToken, 'a', { type: 'openSession' })).json()).toMatchObject({ ok: true });
    const al = await login('Al');
    const r = await post(al, 'b', { type: 'join', name: 'Al', pick: 'starter:sword' });
    expect(r.statusCode).toBe(200);
    expect(r.json().events[0].data).toEqual({ character: 'dev:al' });
  });

  it('answers with stable codes and statuses', async () => {
    await setup();
    expect((await post(null, 'a', { type: 'openSession' })).statusCode).toBe(401);
    expect((await post('nope', 'a', { type: 'openSession' })).json().error.code).toBe('unauthorized');
    expect((await post(s.made.overlayToken, 'a', { type: 'openSession' })).statusCode).toBe(403);
    expect((await post(s.made.dockToken, 'a', { type: 'openSession' }, '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b')).statusCode).toBe(404);
    const bad = await app.inject({ method: 'POST', url: `/channels/${s.made.id}/commands`, payload: { command: {} }, headers: { authorization: `Bearer ${s.made.dockToken}` } });
    expect(bad.statusCode).toBe(400);
    const rejected = await post(s.made.dockToken, 'b', { type: 'closeSession' });
    expect([rejected.statusCode, rejected.json().error.code]).toEqual([200, 'no-session']);
  });

  it('a viewer token only works on its own channel', async () => {
    await setup();
    const al = await login('al');
    const other = await s.store.createChannel({
      name: 'x', config: { packs: [] }, room: { stateVersion: 1, clock: 0, rng: 1, seq: 0, session: null, recentRequests: [] },
      dock: { hash: 'hx', enc: 'ex' }, overlay: { hash: 'hy', enc: 'ey' },
    });
    expect((await post(al, 'a', { type: 'leave' }, other)).statusCode).toBe(403);
  });

  it('serves views and describe', async () => {
    await setup();
    const auth = { authorization: `Bearer ${s.made.overlayToken}` };
    expect((await app.inject({ method: 'GET', url: `/channels/${s.made.id}/view`, headers: auth })).json()).toMatchObject({ ok: true, view: { phase: 'closed' } });
    const d = (await app.inject({ method: 'GET', url: `/channels/${s.made.id}/describe`, headers: auth })).json();
    expect(d.describe.classes.length).toBeGreaterThan(0);
  });

  it('rate-limits per sender, counting reads too', async () => {
    await setup({ limits: true });
    const al = await login('al');
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await app.inject({ method: 'GET', url: `/channels/${s.made.id}/view`, headers: { authorization: `Bearer ${al}` } })).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await post(s.made.dockToken, 'x', { type: 'openSession' })).statusCode).toBe(200);
  });

  it('replays a regenerate answer to a retry with the old dock token', async () => {
    await setup();
    const first = (await post(s.made.dockToken, 'regen', { type: 'regenerateDockUrl' })).json();
    const retry = await post(s.made.dockToken, 'regen', { type: 'regenerateDockUrl' });
    expect(retry.json()).toEqual(first);
    expect((await post(s.made.dockToken, 'other', { type: 'openSession' })).statusCode).toBe(401);
    expect((await post(first.result.token, 'other', { type: 'openSession' })).statusCode).toBe(200);
  });

  it('has no dev login unless dev mode is on', async () => {
    await setup({ dev: false });
    expect((await app.inject({ method: 'POST', url: '/dev/login', payload: { channel: s.made.id, viewer: 'al' } })).statusCode).toBe(404);
  });
});

describe('WebSocket (spec 2a §5)', () => {
  it('welcomes after hello, then streams events', async () => {
    await setup();
    const ws = await app.injectWS(`/channels/${s.made.id}/live`);
    const got: { type: string }[] = [];
    const welcome = new Promise<void>((resolve) => ws.on('message', (raw) => { got.push(JSON.parse(String(raw))); if (got.length === 1) resolve(); }));
    ws.send(JSON.stringify({ type: 'hello', token: s.made.overlayToken }));
    await welcome;
    expect(got[0]).toMatchObject({ type: 'welcome', role: 'overlay' });
    await post(s.made.dockToken, 'a', { type: 'openSession' });
    await manager.idle();
    await new Promise((r) => setTimeout(r, 50));
    expect(got.map((m) => m.type)).toEqual(['welcome', 'events', 'view']);
    ws.terminate();
  });

  it('closes with 4401 on a bad hello or no hello', async () => {
    await setup({ helloTimeoutMs: 50 });
    const bad = await app.injectWS(`/channels/${s.made.id}/live`);
    const badCode = new Promise<number>((resolve) => bad.on('close', (code) => resolve(code)));
    bad.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
    expect(await badCode).toBe(4401);
    const silent = await app.injectWS(`/channels/${s.made.id}/live`);
    expect(await new Promise<number>((resolve) => silent.on('close', (code) => resolve(code)))).toBe(4401);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run apps/server/test/app.test.ts`
Expected: FAIL (cannot find `../src/app`).

- [ ] **Step 4: Implement**

`apps/server/src/auth.ts`:

```ts
import type { ErrorBody, Role } from '@dndm/protocol';
import type { Clock } from './clock';
import { hashToken, isViewerToken, type Secrets } from './crypto';
import type { Room, Sender } from './room';

export type Authed = Sender & { tokenHash: string | null };

/** Spec 2a §4.3. A token only works for its own channel. */
export function authenticate(room: Room, token: string | undefined, secrets: Secrets): Authed | ErrorBody {
  if (!token) return { code: 'unauthorized', message: 'Send a token' };
  if (isViewerToken(token)) {
    const claim = secrets.verifyViewer(token);
    if (!claim) return { code: 'unauthorized', message: "That viewer token isn't valid" };
    if (claim.channel !== room.channel.id) return { code: 'forbidden', message: 'That viewer token is for another channel' };
    return { role: 'viewer', character: claim.character, tokenHash: null };
  }
  const hash = hashToken(token);
  if (hash === room.channel.dockTokenHash) return { role: 'dock', tokenHash: hash };
  if (hash === room.channel.overlayTokenHash) return { role: 'overlay', tokenHash: hash };
  return { code: 'unauthorized', message: "That token isn't valid for this channel" };
}

export const LIMITS: Record<Role, number> = { viewer: 5, overlay: 5, dock: 20 };

/** Requests per second per sender (spec 2a §4.4). Measured on the server's clock. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly clock: Clock, private readonly enabled = true, private readonly limits: Record<Role, number> = LIMITS) {}

  take(role: Role, key: string): boolean {
    if (!this.enabled) return true;
    const now = this.clock.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 1000);
    const ok = recent.length < this.limits[role];
    if (ok) recent.push(now);
    if (recent.length) this.hits.set(key, recent);
    else this.hits.delete(key);
    return ok;
  }
}

export const limitKey = (room: Room, who: Authed): string =>
  who.role === 'viewer' ? `viewer:${room.channel.id}:${who.character}` : `${who.role}:${who.tokenHash}`;
```

`apps/server/src/app.ts`:

```ts
import websocket from '@fastify/websocket';
import {
  type Answer, clientMessageSchema, commandRequestSchema, devLoginSchema, httpStatus, type ServerMessage, WS_CLOSE,
} from '@dndm/protocol';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { authenticate, limitKey, type RateLimiter } from './auth';
import { hashToken, isViewerToken, type Secrets } from './crypto';
import type { Conn, Hub } from './hub';
import type { Room } from './room';
import type { RoomManager } from './room-manager';

export interface AppDeps {
  manager: RoomManager; hub: Hub; secrets: Secrets; limiter: RateLimiter; dev: boolean;
  /** How long a WebSocket may stay silent before its hello (README decision 7). */
  helloTimeoutMs?: number;
}

type ChannelReq = FastifyRequest<{ Params: { channel: string } }>;
const fail = (code: string, message: string): Answer => ({ ok: false, error: { code, message } });
const bearer = (req: FastifyRequest) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
const reply = (res: FastifyReply, body: Answer | ({ ok: true } & Record<string, unknown>)) =>
  res.code(body.ok ? 200 : httpStatus(body.error.code)).send(body);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  async function roomAndSender(req: ChannelReq, res: FastifyReply) {
    const room = await deps.manager.get(req.params.channel);
    if (!room) { reply(res, fail('unknown-channel', 'No such channel')); return null; }
    const who = authenticate(room, bearer(req), deps.secrets);
    if ('code' in who) return { room, who: null, error: who };
    if (!deps.limiter.take(who.role, limitKey(room, who))) { reply(res, fail('rate-limited', 'Too many requests; slow down')); return null; }
    return { room, who, error: null };
  }

  app.post('/channels/:channel/commands', async (req: ChannelReq, res) => {
    const body = commandRequestSchema.safeParse(req.body);
    if (!body.success) return reply(res, fail('bad-command', body.error.issues[0]?.message ?? 'Bad request'));
    const r = await roomAndSender(req, res);
    if (!r) return res;
    if (!r.who) {
      const token = bearer(req);
      if (token && !isViewerToken(token)) {
        const replay = await r.room.replayRevoked(hashToken(token), body.data.id);
        if (replay) return reply(res, replay);
      }
      return reply(res, fail(r.error!.code, r.error!.message));
    }
    return reply(res, await r.room.command(r.who, body.data.id, body.data.command));
  });

  app.get('/channels/:channel/view', async (req: ChannelReq, res) => {
    const r = await roomAndSender(req, res);
    if (!r) return res;
    if (!r.who) return reply(res, fail(r.error!.code, r.error!.message));
    return reply(res, { ok: true, view: await r.room.view(r.who) });
  });

  app.get('/channels/:channel/describe', async (req: ChannelReq, res) => {
    const r = await roomAndSender(req, res);
    if (!r) return res;
    if (!r.who) return reply(res, fail(r.error!.code, r.error!.message));
    return reply(res, { ok: true, describe: r.room.describe() });
  });

  app.get('/channels/:channel/live', { websocket: true }, (socket, req) => {
    const channelId = (req.params as { channel: string }).channel;
    let room: Room | null = null;
    let conn: Conn | null = null;
    let greeted = false;
    const send = (m: ServerMessage) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m)); };
    const refuse = (code: number, error: string, message: string) => { send({ type: 'error', code: error, message }); socket.close(code, message); };
    const timer = setTimeout(() => refuse(WS_CLOSE.unauthorized, 'unauthorized', 'Say hello first'), deps.helloTimeoutMs ?? 5000);
    socket.on('message', async (raw) => {
      if (greeted) return;
      greeted = true;
      clearTimeout(timer);
      let token: string;
      try {
        token = clientMessageSchema.parse(JSON.parse(String(raw))).token;
      } catch {
        return refuse(WS_CLOSE.unauthorized, 'unauthorized', 'The first message must be a hello with a token');
      }
      room = await deps.manager.get(channelId);
      if (!room) return refuse(WS_CLOSE.unauthorized, 'unknown-channel', 'No such channel');
      const who = authenticate(room, token, deps.secrets);
      if ('code' in who) return refuse(WS_CLOSE.unauthorized, who.code, who.message);
      if (!deps.limiter.take(who.role, limitKey(room, who))) return refuse(WS_CLOSE.rateLimited, 'rate-limited', 'Too many connections; slow down');
      conn = {
        role: who.role, character: who.role === 'viewer' ? who.character : null, tokenHash: who.tokenHash,
        send, close: (code, reason) => socket.close(code, reason),
      };
      await deps.hub.add(room, conn);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (room && conn) deps.hub.remove(room, conn);
    });
  });

  if (deps.dev) {
    app.post('/dev/login', async (req, res) => {
      const body = devLoginSchema.safeParse(req.body);
      if (!body.success) return reply(res, fail('bad-command', body.error.issues[0]?.message ?? 'Bad request'));
      const room = await deps.manager.get(body.data.channel);
      if (!room) return reply(res, fail('unknown-channel', 'No such channel'));
      const character = `dev:${body.data.viewer.toLowerCase()}`;
      return reply(res, { ok: true, token: deps.secrets.signViewer({ channel: room.channel.id, character }), character });
    });
  }

  return app;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm vitest run apps/server/test/app.test.ts`
Expected: PASS (9 tests). If `injectWS` is missing, check that `@fastify/websocket` is registered before the route (it is, by `await app.register(websocket)`).

- [ ] **Step 6: Commit**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "feat(server): Fastify app with auth, rate limits, WebSocket and dev login"
```

---

### Task 7: `startServer`, boot and restart

**Files:**
- Modify: `apps/server/src/server.ts` (add `startServer`), `apps/server/src/index.ts`
- Test: `apps/server/test/server.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
export interface ServerOpts {
  databaseUrl: string; secret: string; dev?: boolean; port?: number; host?: string;
  clock?: Clock; rateLimits?: boolean; bundles?: PackBundle[];
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}
export interface RunningServer { app: FastifyInstance; manager: RoomManager; hub: Hub; store: Store; secrets: Secrets; url: string; close(): Promise<void> }
export function startServer(opts: ServerOpts): Promise<RunningServer>;
```

`index.ts` exports `startServer`, `createChannel`, `defaultConfig`, `officialBundles`, `migrate`, `Store`, `Secrets`, `FakeClock`, `realClock`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/server.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock';
import { Secrets } from '../src/crypto';
import { createChannel, defaultConfig, officialBundles, type RunningServer, startServer } from '../src/server';
import { Store } from '../src/store';
import { freshDb } from './helpers/db';
import { SECRET } from './helpers/room';

let t: Awaited<ReturnType<typeof freshDb>>;
let running: RunningServer[] = [];
beforeEach(async () => { t = await freshDb(); running = []; });
afterEach(async () => { for (const r of running) await r.close().catch(() => {}); await t.drop(); });

async function start(clock: FakeClock) {
  const r = await startServer({ databaseUrl: t.url, secret: SECRET, dev: true, clock, rateLimits: false });
  running.push(r);
  return r;
}

async function made() {
  const store = Store.open(t.url);
  const c = await createChannel({ store, secrets: new Secrets(SECRET), bundles: await officialBundles(), name: 'test', config: defaultConfig(), seed: 1 });
  await store.close();
  return c;
}

describe('startServer (spec 2a §6.4, §6.6)', () => {
  it('refuses to start a second server against the same database', async () => {
    await start(new FakeClock(0));
    await expect(startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0) })).rejects.toThrow(/already running/);
  });

  it('resumes a fight after a restart (success criterion 3)', async () => {
    const c = await made();
    const clock = new FakeClock(1_000_000);
    const a = await start(clock);
    const post = (srv: RunningServer, token: string, id: string, command: Record<string, unknown>) =>
      srv.app.inject({ method: 'POST', url: `/channels/${c.id}/commands`, payload: { id, command }, headers: { authorization: `Bearer ${token}` } });
    await post(a, c.dockToken, '1', { type: 'openSession' });
    const al = (await a.app.inject({ method: 'POST', url: '/dev/login', payload: { channel: c.id, viewer: 'al' } })).json().token;
    await post(a, al, '2', { type: 'join', name: 'Al', pick: 'starter:sword' });
    await post(a, c.dockToken, '3', { type: 'spawnMonster', monster: 'starter:slime' });
    await post(a, al, '4', { type: 'use', ability: 'starter:attack' });
    const before = (await a.app.inject({ method: 'GET', url: `/channels/${c.id}/view`, headers: { authorization: `Bearer ${c.dockToken}` } })).json().view;
    await a.close();
    running = running.filter((r) => r !== a);

    await clock.advance(60_000);
    const b = await start(clock);
    expect(b.manager.rooms().map((r) => r.channel.id)).toEqual([c.id]);
    const after = (await b.app.inject({ method: 'GET', url: `/channels/${c.id}/view`, headers: { authorization: `Bearer ${c.dockToken}` } })).json().view;
    expect(after.phase).toBe('fight');
    expect(after.fight.monster.hp).toBe(before.fight.monster.hp);
    expect(after.party).toEqual(before.party);
    expect(after.fight.nextTurnAt).toBe(clock.now() + 15_000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/server/test/server.test.ts`
Expected: FAIL (`startServer` not exported).

- [ ] **Step 3: Implement**

Append to `apps/server/src/server.ts` (and merge the new imports into the existing import block):

```ts
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { RateLimiter } from './auth';
import { type Clock, realClock } from './clock';
import { Secrets } from './crypto';
import { Hub } from './hub';
import { RoomManager } from './room-manager';
import { Store } from './store';

export interface ServerOpts {
  databaseUrl: string; secret: string; dev?: boolean; port?: number; host?: string;
  clock?: Clock; rateLimits?: boolean; bundles?: PackBundle[];
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}
export interface RunningServer {
  app: FastifyInstance; manager: RoomManager; hub: Hub; store: Store; secrets: Secrets; url: string;
  close(): Promise<void>;
}

/** Spec 2a §6.4 and §6.6: take the lock, load Rooms that need running, then listen. */
export async function startServer(opts: ServerOpts): Promise<RunningServer> {
  const store = Store.open(opts.databaseUrl);
  if (!(await store.tryLock())) {
    await store.close();
    throw new Error('Another dndm server is already running against this database');
  }
  try {
    const clock = opts.clock ?? realClock;
    const secrets = new Secrets(opts.secret);
    const bundles = opts.bundles ?? (await officialBundles());
    const manager = new RoomManager({ store, clock, secrets, bundles, log: opts.log });
    await manager.boot();
    manager.startSweeper();
    const hub = new Hub();
    const app = await buildApp({ manager, hub, secrets, limiter: new RateLimiter(clock, opts.rateLimits ?? true), dev: !!opts.dev });
    const url = opts.port !== undefined ? await app.listen({ port: opts.port, host: opts.host ?? '127.0.0.1' }) : '';
    return {
      app, manager, hub, store, secrets, url,
      async close() {
        await app.close();
        manager.close();
        await store.close();
      },
    };
  } catch (e) {
    await store.close();
    throw e;
  }
}
```

Replace the old `import type { Store } from './store';` at the top of `server.ts` with the value import above (`import { Store } from './store';`).

`apps/server/src/index.ts`:

```ts
export { connect, migrate, type Db, type Sql } from './db/connect';
export { Store, type ChannelRow, type RoomRow, type CharacterSave } from './store';
export { hashToken, newToken, Secrets } from './crypto';
export { FakeClock, realClock, type Clock } from './clock';
export { createChannel, defaultConfig, officialBundles, startServer, type RunningServer, type ServerOpts } from './server';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run apps/server/test/server.test.ts`
Expected: PASS (2 tests). The monster's next turn after restart is a full interval (15 s for the slime) from the moment of load, because `full-interval-after-restart` is on by default.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): startServer with advisory lock, boot and restart resume"
```

---

### Task 8: End-to-end golden test

**Files:**
- Test: `apps/server/test/e2e-golden.test.ts`

**Interfaces:**
- Consumes: `startServer`, `createChannel`, the golden scripts in `apps/cli/test/golden/*.jsonl`, `@dndm/engine`.

This is success criterion 2: every Project 1 golden script, played through the server over HTTP with a fake clock, gives the same events (after mapping `dev:<name>` back to `<name>`) and the same rejections as playing it straight through the engine the way `dndm run` does.

- [ ] **Step 1: Write the test**

`apps/server/test/e2e-golden.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Command, createEngine, type GameEvent, type GameState, parseDuration, VIEWER_COMMANDS } from '@dndm/engine';
import { repoRoot } from '@dndm/pack-loader';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock';
import { Secrets } from '../src/crypto';
import { createChannel, defaultConfig, officialBundles, type RunningServer, startServer } from '../src/server';
import { Store } from '../src/store';
import { freshDb } from './helpers/db';
import { SECRET } from './helpers/room';

type Line = { wait: string | number } | { next: true } | { as: string; command: Record<string, unknown> & { type: string } };
type Out = GameEvent | { rejected: string };

const DIR = join(repoRoot(), 'apps', 'cli', 'test', 'golden');
const scripts = readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort();
const read = (name: string): Line[] => readFileSync(join(DIR, name), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

/** What `dndm run` does (apps/cli/src/driver.ts), straight through the engine. */
async function direct(lines: Line[]): Promise<Out[]> {
  const engine = createEngine({ packs: await officialBundles(), channel: defaultConfig() });
  let game: GameState = engine.newGame({ seed: 1 });
  let now = 0;
  const out: Out[] = [];
  const advance = () => { const r = engine.advance(game, now); game = r.game; out.push(...r.events); };
  for (const l of lines) {
    if ('wait' in l) { now += parseDuration(l.wait); advance(); continue; }
    if ('next' in l) { const t = engine.nextWakeTime(game); if (t !== null) { now = Math.max(now, t); advance(); } continue; }
    if (l.as !== 'streamer' && !(VIEWER_COMMANDS as readonly string[]).includes(l.command.type)) { out.push({ rejected: 'streamer-only' }); continue; }
    const cmd = (l.as === 'streamer' ? l.command : { ...l.command, character: l.as }) as unknown as Command;
    const r = engine.apply(game, cmd, now);
    if (r.ok) { game = r.game; out.push(...r.events); } else out.push({ rejected: r.error.code });
  }
  return out;
}

/** A streamer command that names a viewer's character names their server ID, `dev:<name>`. */
function toDev(c: Record<string, unknown>): Record<string, unknown> {
  const out = { ...c };
  if (typeof out.character === 'string') out.character = `dev:${out.character}`;
  if (typeof out.target === 'string' && out.target !== 'party') out.target = `dev:${out.target}`;
  const t = out.target as { kind?: string; id?: string } | undefined;
  if (t && typeof t === 'object' && t.kind === 'character') out.target = { ...t, id: `dev:${t.id}` };
  return out;
}

/** Replaces every "dev:<name>" string with "<name>", anywhere in a value. */
function undev(v: unknown): unknown {
  if (typeof v === 'string') return v.startsWith('dev:') ? v.slice(4) : v;
  if (Array.isArray(v)) return v.map(undev);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, undev(x)]));
  return v;
}

let t: Awaited<ReturnType<typeof freshDb>>;
let srv: RunningServer;
beforeEach(async () => { t = await freshDb(); });
afterEach(async () => { await srv?.close(); await t.drop(); });

async function viaServer(lines: Line[]): Promise<Out[]> {
  const store = Store.open(t.url);
  const c = await createChannel({ store, secrets: new Secrets(SECRET), bundles: await officialBundles(), name: 'golden', config: defaultConfig(), seed: 1 });
  await store.close();
  const clock = new FakeClock(0);
  srv = await startServer({ databaseUrl: t.url, secret: SECRET, dev: true, clock, rateLimits: false });
  const room = (await srv.manager.get(c.id))!;
  const out: Out[] = [];
  room.subscribe((o) => { if (o.type === 'events') out.push(...o.events); });
  const tokens = new Map<string, string>([['streamer', c.dockToken]]);
  let n = 0;
  const settle = () => srv.manager.idle();
  for (const l of lines) {
    if ('wait' in l) { await clock.advance(parseDuration(l.wait), settle); continue; }
    if ('next' in l) { const at = room.nextWake(); if (at !== null) await clock.advanceTo(Math.max(clock.now(), at), settle); continue; }
    if (!tokens.has(l.as)) {
      const r = await srv.app.inject({ method: 'POST', url: '/dev/login', payload: { channel: c.id, viewer: l.as } });
      tokens.set(l.as, r.json().token);
    }
    const { character: _drop, ...command } = l.command;
    const r = await srv.app.inject({
      method: 'POST', url: `/channels/${c.id}/commands`,
      payload: { id: `g${++n}`, command: l.as === 'streamer' ? toDev(l.command) : command },
      headers: { authorization: `Bearer ${tokens.get(l.as)}` },
    });
    const body = r.json();
    if (!body.ok) out.push({ rejected: body.error.code });
  }
  return undev(out) as Out[];
}

describe('end to end (success criterion 2)', () => {
  it.each(scripts)('%s gives the same events through the server', async (name) => {
    const lines = read(name);
    expect(await viaServer(lines)).toEqual(await direct(lines));
  });
});
```

Each viewer name in the golden scripts (`fi`, `ta`, `he`, …) logs in as `dev:<name>`. The server sets `character` itself, so the script's own `character` field (if any) is dropped for viewers, as `dndm run` does.

- [ ] **Step 2: Run it**

Run: `pnpm vitest run apps/server/test/e2e-golden.test.ts`
Expected: PASS for every script. If one fails:
- Diff the first differing event.
- If the server output has fewer timer events, check that `FakeClock.advanceTo` fires the Room's re-armed timer within the same advance (`settle` must be `manager.idle`).
- If key order differs (inventory, abilities), check that the column is `json` and not `jsonb` (README decision 1).
- Don't change the golden scripts.

- [ ] **Step 3: Run everything and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS.

```bash
git add apps/server/test/e2e-golden.test.ts
git commit -m "test(server): golden scripts give the same events through the server"
```
