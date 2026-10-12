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
