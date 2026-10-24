import type { Clock } from '../clock';
import type { TwitchConfig } from '../config';
import type { Secrets } from '../crypto';
import type { Room } from '../room';
import type { RoomHooks } from '../room-manager';
import type { ChannelRow } from '../store';
import type { TwitchClient } from './api';
import { Broadcaster } from './broadcaster';
import { PacingGate } from './gate';
import { keyFor } from './snapshot';

/** How long an unload's last send keeps trying (spec 2b §5.3 "Unloading"). */
const UNLOAD_RETRY_MS = 30_000;

type Log = (msg: string, extra?: Record<string, unknown>) => void;

interface Entry { room: Room; broadcaster: Broadcaster }

/**
 * The Twitch side of the server (spec 2b §5.3, §7.4): one Broadcaster per loaded Room of a channel with a Twitch ID,
 * the per-channel pacing gate they share, and the last sends on unload and at shutdown.
 */
export class TwitchLayer implements RoomHooks {
  readonly gate: PacingGate;
  private readonly key: Buffer;
  private readonly entries = new Map<string, Entry>();
  /** Channels that have had a Broadcaster start in this process. */
  private readonly started = new Set<string>();
  private closed = false;

  constructor(private readonly o: { config: TwitchConfig; client: TwitchClient; clock: Clock; secrets: Secrets; log?: Log }) {
    this.gate = new PacingGate(o.clock);
    this.key = o.secrets.derive('snapshot-key');
  }

  wantsBroadcast(c: ChannelRow): boolean {
    return c.twitchId !== null;
  }

  keyOf(channelId: string, characterId: string): string {
    return keyFor(this.key, channelId, characterId);
  }

  broadcaster(channelId: string): Broadcaster | undefined {
    return this.entries.get(channelId)?.broadcaster;
  }

  /** Starts the Room's Broadcaster: its baseline broadcastState() is the first entry in the Room's queue. */
  async attach(room: Room): Promise<void> {
    if (this.closed) throw new Error('The Twitch layer has shut down');
    const channelId = room.channel.id;
    const twitchId = room.channel.twitchId;
    if (twitchId === null) throw new Error(`Channel ${channelId} has no Twitch ID`);
    const b = new Broadcaster({
      room, twitchId, client: this.o.client, gate: this.gate, clock: this.o.clock,
      keyOf: (id) => this.keyOf(channelId, id),
      firstSinceStart: !this.started.has(channelId),
      ...(this.o.log ? { log: this.o.log } : {}),
    });
    try {
      await b.start();
    } catch (e) {
      b.stop();
      throw e;
    }
    // Only a started Broadcaster counts: one that failed to start sent nothing, so the next is still the first.
    this.started.add(channelId);
    this.entries.set(channelId, { room, broadcaster: b });
  }

  /**
   * Spec 2b §5.3 "Unloading": the last broadcastState() through the Room's queue, then the Room closes, then the last
   * snapshot goes out in the background, retrying for 30 s. Resolves once the Room is closed.
   */
  async detach(room: Room): Promise<void> {
    const channelId = room.channel.id;
    const entry = this.entries.get(channelId);
    if (!entry || entry.room !== room) { room.close(); return; }
    this.entries.delete(channelId);
    const twitchId = room.channel.twitchId!;
    let send: (retryUntil: number | null) => Promise<boolean>;
    try {
      send = await entry.broadcaster.final();
    } catch (e) {
      // The last read failed, so any keys it would have carried are lost: the next Broadcaster sends an rf.
      this.gate.markDropped(twitchId);
      this.o.log?.('last broadcast read failed on unload', { twitchId, error: String(e) });
      return;
    } finally {
      room.close();
    }
    // In the background: the unload doesn't wait for it. gate.idle() covers it while an attempt runs.
    void send(this.o.clock.now() + UNLOAD_RETRY_MS)
      .then((delivered) => {
        if (!delivered) {
          this.gate.markDropped(twitchId);
          this.o.log?.('unload last send failed; keys dropped', { twitchId });
        }
      })
      .catch((e: unknown) => {
        this.gate.markDropped(twitchId);
        this.o.log?.('unload last send failed; keys dropped', { twitchId, error: String(e) });
      });
  }

  /**
   * Spec 2b §7.4 step 3: each Broadcaster's last tick through the pacing gate, one attempt each, waiting at most
   * `timeoutMs` on the server clock. Whatever is still waiting then is abandoned.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    // final() stops each tick synchronously, before its first await.
    const lasts = entries.map(async ({ room, broadcaster }) => {
      try {
        const send = await broadcaster.final();
        if (!(await send(null))) this.o.log?.('shutdown: last send not delivered', { twitchId: room.channel.twitchId });
      } catch (e) {
        this.o.log?.('shutdown: last send failed', { twitchId: room.channel.twitchId, error: String(e) });
      }
    });
    let cancel: () => void = () => {};
    const timedOut = new Promise<'timeout'>((resolve) => { cancel = this.o.clock.setTimer(this.o.clock.now() + timeoutMs, () => resolve('timeout')); });
    try {
      const r = await Promise.race([Promise.all(lasts).then(() => 'done' as const), timedOut]);
      if (r === 'timeout') this.o.log?.('shutdown: abandoned last sends still waiting', { timeoutMs });
    } finally {
      cancel();
    }
  }

  /** Resolves when no tick is running and no send is in flight (sends parked on a future timer don't count). */
  async idle(): Promise<void> {
    for (const { broadcaster } of [...this.entries.values()]) await broadcaster.idle();
    await this.gate.idle();
  }
}
