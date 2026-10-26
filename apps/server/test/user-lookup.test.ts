import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock';
import type { TwitchConfig } from '../src/config';
import { HttpTwitchClient, TwitchError, type TwitchUser } from '../src/twitch/api';
import { UserLookup, type UserLookupOpts } from '../src/twitch/users';
import { fakeTwitch, type FakeTwitch } from './helpers/fake-twitch';

const T0 = 1_800_000_000_000;

let fake: FakeTwitch;
let clock: FakeClock;
let client: HttpTwitchClient;

/** Flush-window timers the test fires by hand. */
function manualTimers() {
  let armed: { ms: number; fn: () => void }[] = [];
  return {
    schedule(ms: number, fn: () => void) {
      const t = { ms, fn };
      armed.push(t);
      return () => { armed = armed.filter((x) => x !== t); };
    },
    get armed() { return armed.map((t) => t.ms); },
    fire() {
      const due = armed;
      armed = [];
      for (const t of due) t.fn();
    },
  };
}

let timers: ReturnType<typeof manualTimers>;
const lookup = (opts: UserLookupOpts = {}) => new UserLookup(client, clock, { schedule: timers.schedule, ...opts });
const userRequests = () => fake.requests.filter((r) => r.path === '/helix/users');
const idsOf = (i: number) => [userRequests()[i]!.query.id].flat();
const user = (n: number): TwitchUser => ({ id: String(n), login: `u${n}`, displayName: `User${n}` });
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(async () => {
  fake = await fakeTwitch();
  clock = new FakeClock(T0);
  timers = manualTimers();
  const cfg: TwitchConfig = {
    clientId: fake.clientId, clientSecret: 'shh', extensionSecret: 'c2VjcmV0', extensionSecretPrevious: null,
    ownerId: '999', publicUrl: 'https://dndm.example', apiBase: fake.apiBase, authBase: fake.authBase,
  };
  client = new HttpTwitchClient(cfg, clock, 200);
  for (let n = 1; n <= 250; n += 1) fake.addUser(user(n));
});
afterEach(async () => {
  await fake.close();
});

describe('UserLookup (batched Get Users by ID)', () => {
  it('coalesces lookups made within the window into one request, flushed by the timer', async () => {
    const users = lookup();
    const a = users.lookup('1');
    const b = users.lookup('2');
    const again = users.lookup('1');
    const c = users.lookup('3');
    await tick();
    expect(userRequests()).toHaveLength(0);
    expect(timers.armed).toEqual([250]);
    timers.fire();
    expect(await Promise.all([a, b, again, c])).toEqual([user(1), user(2), user(1), user(3)]);
    expect(userRequests()).toHaveLength(1);
    expect(idsOf(0)).toEqual(['1', '2', '3']);
  });

  it('flushes as soon as 100 ids are waiting, without the timer', async () => {
    const users = lookup();
    const first = Array.from({ length: 100 }, (_, i) => users.lookup(String(i + 1)));
    const rest = Array.from({ length: 50 }, (_, i) => users.lookup(String(i + 101)));
    expect((await Promise.all(first)).map((u) => u!.id)).toEqual(Array.from({ length: 100 }, (_, i) => String(i + 1)));
    expect(userRequests()).toHaveLength(1);
    expect(idsOf(0)).toHaveLength(100);
    // The other 50 wait for the window.
    expect(timers.armed).toEqual([250]);
    timers.fire();
    expect(await Promise.all(rest)).toHaveLength(50);
    expect(userRequests()).toHaveLength(2);
    expect(idsOf(1)).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 101)));
  });

  it('serves a looked-up user from the cache until the TTL passes', async () => {
    const users = lookup({ ttlMs: 60_000 });
    const p = users.lookup('1');
    timers.fire();
    expect(await p).toEqual(user(1));
    expect(await users.lookup('1')).toEqual(user(1));
    expect(timers.armed).toEqual([]);
    expect(userRequests()).toHaveLength(1);

    await clock.advance(60_000);
    const later = users.lookup('1');
    timers.fire();
    expect(await later).toEqual(user(1));
    expect(userRequests()).toHaveLength(2);
  });

  it('keeps at most maxEntries users, dropping the least recently used', async () => {
    const users = lookup({ maxEntries: 2 });
    const first = [users.lookup('1'), users.lookup('2')];
    timers.fire();
    await Promise.all(first);
    await users.lookup('1'); // 1 is now the most recently used
    const third = users.lookup('3');
    timers.fire();
    await third; // evicts 2
    expect(await users.lookup('1')).toEqual(user(1));
    expect(await users.lookup('3')).toEqual(user(3));
    expect(userRequests()).toHaveLength(2);
    const two = users.lookup('2');
    timers.fire();
    expect(await two).toEqual(user(2));
    expect(userRequests()).toHaveLength(3);
  });

  it('a partial answer resolves the missing ids to null, and nulls are not cached', async () => {
    const users = lookup();
    const found = users.lookup('1');
    const missing = users.lookup('9999');
    timers.fire();
    expect(await found).toEqual(user(1));
    expect(await missing).toBeNull();
    const retry = users.lookup('9999');
    timers.fire();
    expect(await retry).toBeNull();
    expect(userRequests()).toHaveLength(2);
  });

  it('a failed batch rejects only its own lookups', async () => {
    const users = lookup({ maxBatch: 2 });
    fake.failNext('users');
    const results = await Promise.allSettled(['1', '2', '3', '4'].map((id) => users.lookup(id)));
    expect(userRequests()).toHaveLength(2);
    const failedIds = idsOf(0); // the fake fails whichever request reaches it first
    for (const [i, r] of results.entries()) {
      if (failedIds.includes(String(i + 1))) {
        expect(r.status).toBe('rejected');
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(TwitchError);
      } else {
        expect(r).toEqual({ status: 'fulfilled', value: user(i + 1) });
      }
    }
    // The failed ids aren't stuck: the next lookup asks again.
    const again = users.lookup(failedIds[0]!);
    timers.fire();
    expect(await again).toEqual(user(Number(failedIds[0])));
  });

  it('after a 429, fails lookups at once without a request until Ratelimit-Reset; cached users still answer', async () => {
    const users = lookup();
    const cached = users.lookup('1');
    timers.fire();
    await cached;
    fake.rateLimitNext(T0 / 1000 + 30, 'users');
    const limited = users.lookup('2');
    timers.fire();
    await expect(limited).rejects.toBeInstanceOf(TwitchError);
    expect(userRequests()).toHaveLength(2);

    await expect(users.lookup('3')).rejects.toBeInstanceOf(TwitchError);
    expect(await users.lookup('1')).toEqual(user(1));
    expect(timers.armed).toEqual([]);
    expect(userRequests()).toHaveLength(2);

    await clock.advance(30_000);
    const after = users.lookup('3');
    timers.fire();
    expect(await after).toEqual(user(3));
    expect(userRequests()).toHaveLength(3);
  });

  it('keeps at most two requests in flight; the rest wait for one to finish', async () => {
    const users = lookup({ maxBatch: 1 });
    fake.hangNext('users');
    fake.hangNext('users');
    const results = Promise.allSettled(['1', '2', '3'].map((id) => users.lookup(id)));
    await tick();
    expect(userRequests()).toHaveLength(2);
    const [a, b, c] = await results;
    expect(a!.status).toBe('rejected'); // the client's 200 ms timeout
    expect(b!.status).toBe('rejected');
    expect(c).toEqual({ status: 'fulfilled', value: user(3) });
    expect(userRequests()).toHaveLength(3);
  });

  it('uses a real timer of windowMs by default', async () => {
    const users = new UserLookup(client, clock, { windowMs: 20 });
    const a = users.lookup('1');
    const b = users.lookup('2');
    expect(await Promise.all([a, b])).toEqual([user(1), user(2)]);
    expect(userRequests()).toHaveLength(1);
  });
});
