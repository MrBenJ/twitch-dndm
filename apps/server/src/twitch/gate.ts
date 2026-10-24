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
}

/**
 * Paces PubSub sends per Twitch channel (spec §5.3). State is keyed by Twitch ID and lives as
 * long as the gate, so it outlives Broadcasters. All waiting goes through the Clock.
 */
export class PacingGate {
  private channels = new Map<string, Channel>();
  private dropped = new Set<string>();
  private pending = new Set<Promise<unknown>>();

  constructor(private clock: Clock) {}

  /**
   * Queues `attempt` behind this channel's earlier sends. Without `retryUntil` it makes one attempt;
   * with it, it keeps attempting until one succeeds or the next attempt would start after `retryUntil`.
   */
  send(twitchId: string, attempt: () => Promise<PubSubResult>, opts: { retryUntil?: number } = {}): Promise<boolean> {
    let ch = this.channels.get(twitchId);
    if (!ch) {
      ch = { tail: Promise.resolve(), lastAttemptAt: -Infinity, notBefore: -Infinity, failures: 0 };
      this.channels.set(twitchId, ch);
    }
    const channel = ch;
    const result = channel.tail.then(() => this.run(channel, attempt, opts.retryUntil));
    channel.tail = result;
    this.pending.add(result);
    void result.finally(() => this.pending.delete(result));
    return result;
  }

  markDropped(twitchId: string): void { this.dropped.add(twitchId); }
  hasDropped(twitchId: string): boolean { return this.dropped.has(twitchId); }
  clearDropped(twitchId: string): void { this.dropped.delete(twitchId); }

  /** Resolves when no send is queued or running. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private async run(ch: Channel, attempt: () => Promise<PubSubResult>, retryUntil: number | undefined): Promise<boolean> {
    for (;;) {
      const at = Math.max(ch.lastAttemptAt + MIN_GAP_MS, ch.notBefore);
      if (retryUntil !== undefined && at > retryUntil) return false;
      await this.waitUntil(at);
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

  private waitUntil(at: number): Promise<void> {
    if (at <= this.clock.now()) return Promise.resolve();
    return new Promise((resolve) => { this.clock.setTimer(at, resolve); });
  }
}
