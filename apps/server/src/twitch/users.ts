import type { Clock } from '../clock';
import { type TwitchClient, TwitchError, TwitchRateLimitError, type TwitchUser } from './api';

export interface UserLookupOpts {
  /** How long a lookup waits for others to share its request (default 250 ms). */
  windowMs?: number;
  /** Ids per request, at most Helix's 100 (default 100). A full batch is sent at once. */
  maxBatch?: number;
  /** How long a found user is kept (default 10 minutes). */
  ttlMs?: number;
  /** Users kept at most; the least recently used goes first (default 10 000). */
  maxEntries?: number;
  /** Arms the window's timer and returns a function that cancels it (tests). Defaults to an unref'd setTimeout. */
  schedule?: (ms: number, fn: () => void) => () => void;
}

/** Requests in flight at once; more batches wait for one to finish. */
const MAX_IN_FLIGHT = 2;
/** How long a 429 without a usable Ratelimit-Reset holds lookups back, and the most any 429 does. */
const DEFAULT_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

interface Waiter { resolve(u: TwitchUser | null): void; reject(e: TwitchError): void }

const realSchedule = (ms: number, fn: () => void) => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

/**
 * Get Users by ID for joins (spec 2b §4.2, §6.2): lookups within a short window share one request of up to 100 ids,
 * found users are cached for a while, and a 429 holds every lookup back until Twitch's reset. Each lookup gets its own
 * answer: the user, null when Twitch left them out of its answer, or a TwitchError when its batch failed.
 */
export class UserLookup {
  private readonly windowMs: number;
  private readonly maxBatch: number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly schedule: (ms: number, fn: () => void) => () => void;
  /** Found users by id, least recently used first. */
  private readonly cache = new Map<string, { user: TwitchUser; expiresAt: number }>();
  /** Ids not sent yet, in arrival order. */
  private queue = new Map<string, Waiter>();
  /** Every id waiting on Twitch, queued or in flight, so a repeat lookup shares the answer. */
  private readonly waiting = new Map<string, Promise<TwitchUser | null>>();
  private cancelTimer: (() => void) | null = null;
  /** The window ran out while every request slot was busy: send as soon as one frees up. */
  private due = false;
  private inFlight = 0;
  private blockedUntil = 0;

  constructor(private readonly client: TwitchClient, private readonly clock: Clock, opts: UserLookupOpts = {}) {
    this.windowMs = opts.windowMs ?? 250;
    this.maxBatch = Math.min(100, opts.maxBatch ?? 100);
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.schedule = opts.schedule ?? realSchedule;
  }

  lookup(id: string): Promise<TwitchUser | null> {
    const hit = this.cache.get(id);
    if (hit) {
      this.cache.delete(id);
      if (hit.expiresAt > this.clock.now()) {
        this.cache.set(id, hit);
        return Promise.resolve(hit.user);
      }
    }
    const shared = this.waiting.get(id);
    if (shared) return shared;
    if (this.clock.now() < this.blockedUntil) return Promise.reject(new TwitchError('Twitch Get Users is rate limited'));

    const answer = new Promise<TwitchUser | null>((resolve, reject) => { this.queue.set(id, { resolve, reject }); });
    this.waiting.set(id, answer);
    this.pump();
    return answer;
  }

  /** Sends what's ready, while slots are free, and arms the window for what's left. */
  private pump(): void {
    while (this.queue.size && this.inFlight < MAX_IN_FLIGHT && (this.due || this.queue.size >= this.maxBatch)) {
      const batch = new Map([...this.queue].slice(0, this.maxBatch));
      for (const id of batch.keys()) this.queue.delete(id);
      void this.send(batch);
    }
    if (!this.queue.size) {
      this.due = false;
      this.cancelTimer?.();
      this.cancelTimer = null;
    } else if (!this.due && !this.cancelTimer) {
      this.cancelTimer = this.schedule(this.windowMs, () => {
        this.cancelTimer = null;
        this.due = true;
        this.pump();
      });
    }
  }

  private async send(batch: Map<string, Waiter>): Promise<void> {
    this.inFlight += 1;
    try {
      const found = new Map((await this.client.usersById([...batch.keys()])).map((u) => [u.id, u]));
      for (const [id, w] of batch) {
        const user = found.get(id) ?? null;
        if (user) this.remember(user);
        this.waiting.delete(id);
        w.resolve(user);
      }
    } catch (e) {
      if (e instanceof TwitchRateLimitError) {
        const now = this.clock.now();
        const until = e.retryAt ?? now + DEFAULT_BACKOFF_MS;
        this.blockedUntil = Math.max(this.blockedUntil, Math.min(until, now + MAX_BACKOFF_MS));
      }
      const err = e instanceof TwitchError ? e : new TwitchError('Twitch Get Users failed', { cause: e });
      this.rejectAll(batch, err);
      // Lookups queued behind a 429 would only be refused by Twitch: fail them now too.
      if (this.clock.now() < this.blockedUntil) {
        const queued = this.queue;
        this.queue = new Map();
        this.rejectAll(queued, err);
      }
    } finally {
      this.inFlight -= 1;
      this.pump();
    }
  }

  private rejectAll(waiters: Map<string, Waiter>, err: TwitchError): void {
    for (const [id, w] of waiters) {
      this.waiting.delete(id);
      w.reject(err);
    }
  }

  private remember(user: TwitchUser): void {
    this.cache.delete(user.id);
    this.cache.set(user.id, { user, expiresAt: this.clock.now() + this.ttlMs });
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
  }
}
