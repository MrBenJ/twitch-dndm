import { randomBytes } from 'node:crypto';
import type { View } from '@dndm/engine';
import type { Clock } from '../clock.js';
import { RoomClosedError, type BroadcastState, type Room } from '../room.js';
import type { PubSubResult, TwitchClient } from './api.js';
import type { PacingGate } from './gate.js';
import { BACKLOG_CAP, buildSnapshot, RF_WINDOW, type Built } from './snapshot.js';

const TICK_MS = 1000;

export interface RosterMember { id: string; key: string; name: string; class: string | null; level: number }

export interface BroadcasterDeps {
  room: Room;
  twitchId: string;
  client: TwitchClient;
  gate: PacingGate;
  clock: Clock;
  keyOf: (characterId: string) => string;
  /** The first Broadcaster for this channel since the process started: its first send is an rf (spec 2b §5.3). */
  firstSinceStart: boolean;
  /** More waiting keys than this make the send an rf. BACKLOG_CAP; tests lower it. */
  backlogCap?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** A snapshot ready to send, with what its success settles. */
interface Planned {
  built: Built;
  cv: number;
  inputs: number;
  /** The gate had dropped keys recorded when it was built. */
  dropped: boolean;
}

const sameRoster = (a: RosterMember[], b: RosterMember[]) =>
  a.length === b.length && a.every((m, i) => {
    const o = b[i]!;
    return m.id === o.id && m.name === o.name && m.class === o.class && m.level === o.level;
  });

/**
 * Sends a Room's snapshots to its channel's Extension PubSub topic (spec 2b §5.3–§5.5). Reads the Room through
 * broadcastState() on a 1 s tick, carries changed keys until a send delivers them, and paces every send through
 * the channel's gate.
 */
export class Broadcaster {
  readonly epoch = randomBytes(6).toString('base64url').slice(0, 6);
  rv = 1;
  roster: RosterMember[] = [];

  private readonly backlogCap: number;
  /** Keys waiting for delivery, in insertion order (longest-waiting first). */
  private waiting = new Set<string>();
  private lastSent = '';
  private lastInputs = 0;
  /** The config version the last rf (or the load) told viewers about. */
  private sentCv = 0;
  private firstPending: boolean;
  private lastBareAt = -Infinity;
  private inputsAtBare: number | null = null;
  /** The last snapshot was bare and owed a send that the 30 s throttle held back. */
  private barePending = false;
  /** A tick's send failed and nothing has been delivered since: the next tick reads again even if nothing moved. */
  private unsent = false;
  private cancelTimer: (() => void) | null = null;
  private stopped = false;
  private ticking: Promise<void> | null = null;
  private sending = false;

  constructor(private readonly d: BroadcasterDeps) {
    this.backlogCap = d.backlogCap ?? BACKLOG_CAP;
    this.firstPending = d.firstSinceStart;
  }

  /** Records the Room's state as loaded as "last sent", without sending, and arms the tick. */
  async start(): Promise<void> {
    const r = await this.d.room.broadcastState();
    this.lastInputs = r.inputs;
    this.sentCv = this.d.room.channel.configVersion;
    this.roster = this.rosterOf(r.publicView);
    this.rv = 1;
    this.lastSent = buildSnapshot({
      e: this.epoch, t: this.d.clock.now(), publicView: r.publicView, keyOf: this.d.keyOf, rv: this.rv, cv: this.sentCv,
      waiting: [], rf: false,
    }).content;
    if (!this.stopped) this.arm(this.d.clock.now() + TICK_MS);
  }

  tick(): Promise<void> {
    if (this.stopped || this.sending || this.ticking) return Promise.resolve();
    const p = this.runTick().finally(() => { if (this.ticking === p) this.ticking = null; });
    this.ticking = p;
    return p;
  }

  /**
   * Stops the tick, runs the last broadcastState() through the Room's queue, and builds the last snapshot (skipping
   * the bare 30 s throttle: nothing sends after it). The returned function sends it through the gate (retrying until
   * `retryUntil`, or once when null) and resolves with whether it was delivered. It resolves true without sending
   * only when nothing was owed: no keys waiting, no rf due, and content unchanged since the last delivered send.
   */
  async final(): Promise<(retryUntil: number | null) => Promise<boolean>> {
    this.stop();
    if (this.ticking) await this.ticking;
    const plan = this.plan(await this.d.room.broadcastState(), true);
    return async (retryUntil) => {
      if (!plan) return true;
      return this.d.gate.send(this.d.twitchId, this.attempt(plan), retryUntil === null ? {} : { retryUntil });
    };
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  /** Resolves when no tick is running and no send is in flight (a send parked on a future timer doesn't count). */
  async idle(): Promise<void> {
    for (;;) {
      if (this.ticking) await this.ticking;
      await this.d.gate.idle();
      if (!this.ticking) return;
    }
  }

  private arm(at: number): void {
    this.cancelTimer = this.d.clock.setTimer(at, () => {
      if (this.stopped) return;
      this.arm(at + TICK_MS);
      void this.tick();
    });
  }

  private due(): boolean {
    return this.firstPending || this.d.gate.hasDropped(this.d.twitchId) || this.d.room.channel.configVersion !== this.sentCv;
  }

  private async runTick(): Promise<void> {
    const bareOwed = this.barePending && this.d.clock.now() - this.lastBareAt >= RF_WINDOW;
    if (this.d.room.inputs === this.lastInputs && this.waiting.size === 0 && !bareOwed && !this.unsent && !this.due()) return;
    let r: BroadcastState;
    try {
      r = await this.d.room.broadcastState();
    } catch (e) {
      if (!(e instanceof RoomClosedError)) this.d.log?.('broadcast read failed', { twitchId: this.d.twitchId, error: String(e) });
      return;
    }
    // Fold the result in even if stopped meanwhile: the Room has recorded these views, so final() must carry the keys.
    const plan = this.plan(r);
    if (!plan || this.stopped) return;
    this.sending = true;
    this.unsent = true;
    const attempt = this.attempt(plan);
    // Cleared inside the attempt too, so it is false by the time gate.idle() can resolve.
    const once = async () => { try { return await attempt(); } finally { this.sending = false; } };
    void this.d.gate.send(this.d.twitchId, once).finally(() => { this.sending = false; });
  }

  /** Folds a broadcastState() result into the waiting keys and roster, builds the snapshot, and decides whether it goes out. */
  private plan(r: BroadcastState, last = false): Planned | null {
    this.lastInputs = r.inputs;
    for (const id of r.changed) this.waiting.add(this.d.keyOf(id));
    const roster = this.rosterOf(r.publicView);
    if (!sameRoster(roster, this.roster)) this.rv += 1;
    this.roster = roster;

    const cv = this.d.room.channel.configVersion;
    const dropped = this.d.gate.hasDropped(this.d.twitchId);
    const due = this.firstPending || dropped || cv !== this.sentCv;
    const built = buildSnapshot({
      e: this.epoch, t: this.d.clock.now(), publicView: r.publicView, keyOf: this.d.keyOf, rv: this.rv, cv,
      waiting: [...this.waiting], rf: due || this.waiting.size > this.backlogCap,
    });

    let send: boolean;
    this.barePending = false;
    if (built.bare) {
      // §5.4 step 3: at most once per 30 s and only after a change, unless an rf is due (or this is the last send).
      const owed = this.waiting.size > 0 || r.inputs !== this.inputsAtBare || built.content !== this.lastSent;
      send = due || (owed && (last || this.d.clock.now() - this.lastBareAt >= RF_WINDOW));
      this.barePending = owed && !send;
      if (send) this.d.log?.('snapshot does not fit; sending a bare rf', { twitchId: this.d.twitchId, due });
    } else {
      send = built.rf || built.content !== this.lastSent || built.sentKeys.length > 0;
    }
    return send ? { built, cv, inputs: r.inputs, dropped } : null;
  }

  /** One send attempt; its bookkeeping finishes before the gate sees the result, so gate.idle() covers it. */
  private attempt(plan: Planned): () => Promise<PubSubResult> {
    return async () => {
      const res = await this.d.client.sendPubSub(this.d.twitchId, plan.built.message);
      if (res.ok) this.delivered(plan);
      return res;
    };
  }

  private delivered({ built, cv, inputs, dropped }: Planned): void {
    this.lastSent = built.content;
    this.unsent = false;
    if (built.rf) {
      this.waiting.clear();
      this.firstPending = false;
      this.sentCv = cv;
      if (dropped) this.d.gate.clearDropped(this.d.twitchId);
    } else {
      for (const k of built.sentKeys) this.waiting.delete(k);
    }
    if (built.bare) {
      this.lastBareAt = this.d.clock.now();
      this.inputsAtBare = inputs;
    }
  }

  private rosterOf(view: View): RosterMember[] {
    return view.party.map((m) => ({ id: m.id, key: this.d.keyOf(m.id), name: m.name, class: m.class, level: m.level }));
  }
}
