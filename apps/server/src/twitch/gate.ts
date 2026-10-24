import type { Clock } from '../clock.js';
import type { PubSubResult } from './api.js';

const MIN_GAP_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

interface Channel {
  /** Tail of this channel's send queue. */
  tail: Promise<unknown>;
  lastAttemptAt: number;
  /** No attempt may start before this (429 retryAt and failure backoff). */
  notBefore: number;
  failures: number;
  /** Sends queued or running for this channel. */
  outstanding: number;
  /** The head send is parked on a future clock timer. */
  parked: boolean;
}

/**
 * Paces PubSub sends per Twitch channel (spec §5.3). State is keyed by Twitch ID and lives as
 * long as the gate, so it outlives Broadcasters. All waiting goes through the Clock.
 */
export class PacingGate {
  private channels = new Map<string, Channel>();
  private dropped = new Set<string>();
  private watchers: (() => void)[] = [];

  constructor(private clock: Clock) {}

  /**
   * Queues `attempt` behind this channel's earlier sends. Without `retryUntil` it makes one attempt;
   * with it, it keeps attempting until one succeeds or the next attempt would start after `retryUntil`.
   */
  send(twitchId: string, attempt: () => Promise<PubSubResult>, opts: { retryUntil?: number } = {}): Promise<boolean> {
    let ch = this.channels.get(twitchId);
    if (!ch) {
      ch = { tail: Promise.resolve(), lastAttemptAt: -Infinity, notBefore: -Infinity, failures: 0, outstanding: 0, parked: false };
      this.channels.set(twitchId, ch);
    }
    const channel = ch;
    channel.outstanding += 1;
    const result = channel.tail
      .then(() => this.run(channel, attempt, opts.retryUntil))
      .finally(() => { channel.outstanding -= 1; this.notify(); });
    channel.tail = result;
    return result;
  }

  markDropped(twitchId: string): void { this.dropped.add(twitchId); }
  hasDropped(twitchId: string): boolean { return this.dropped.has(twitchId); }
  clearDropped(twitchId: string): void { this.dropped.delete(twitchId); }

  /**
   * Resolves when no attempt is in flight and no send is ready to run right now. Sends parked on a
   * future clock timer do not keep it pending; once such a timer fires, the send is ready again and
   * a later idle() waits for its attempt to finish.
   */
  async idle(): Promise<void> {
    while (this.busy()) await new Promise<void>((resolve) => { this.watchers.push(resolve); });
  }

  private busy(): boolean {
    for (const ch of this.channels.values()) if (ch.outstanding > 0 && !ch.parked) return true;
    return false;
  }

  private notify(): void {
    const ws = this.watchers;
    this.watchers = [];
    for (const w of ws) w();
  }

  private async run(ch: Channel, attempt: () => Promise<PubSubResult>, retryUntil: number | undefined): Promise<boolean> {
    for (;;) {
      const at = Math.max(ch.lastAttemptAt + MIN_GAP_MS, ch.notBefore);
      if (retryUntil !== undefined && at > retryUntil) return false;
      await this.waitUntil(ch, at);
      ch.lastAttemptAt = this.clock.now();
      let res: PubSubResult;
      try {
        res = await attempt();
      } catch {
        res = { ok: false, status: 0, retryAt: null };
      }
      if (res.ok) {
        ch.failures = 0;
        ch.notBefore = -Infinity;
        return true;
      }
      ch.failures += 1;
      const backoff = Math.min(MIN_GAP_MS * 2 ** (ch.failures - 1), MAX_BACKOFF_MS);
      ch.notBefore = Math.max(ch.lastAttemptAt + backoff, res.retryAt ?? -Infinity);
      if (retryUntil === undefined) return false;
    }
  }

  private waitUntil(ch: Channel, at: number): Promise<void> {
    if (at <= this.clock.now()) return Promise.resolve();
    return new Promise((resolve) => {
      ch.parked = true;
      this.clock.setTimer(at, () => { ch.parked = false; resolve(); });
      this.notify();
    });
  }
}
