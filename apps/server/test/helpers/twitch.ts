import type { Answer } from '@dndm/protocol';
import type { LightMyRequestResponse } from 'fastify';
import { FakeClock } from '../../src/clock';
import type { TwitchConfig } from '../../src/config';
import { Secrets } from '../../src/crypto';
import { createChannel, defaultConfig, type RunningServer, type ServerOpts, startServer } from '../../src/server';
import { Store } from '../../src/store';
import { HttpTwitchClient, type PubSubResult, type TwitchClient } from '../../src/twitch/api';
import { signJwt } from '../../src/twitch/jwt';
import { freshDb } from './db';
import { fakeTwitch } from './fake-twitch';
import { officialTestBundles, SECRET } from './room';

/** The test extension secret, base64 as Twitch shows it. */
export const EXT_SECRET = Buffer.from('test-extension-secret-0123456789').toString('base64');
export const TWITCH_ID = '1001';

/** A PubSub snapshot as parsed from the fake (spec 2b §5.1). */
export interface Snapshot {
  v: number; e: string; t: number; ph?: string; adv?: string | null; f?: { n: string } | null;
  p?: [string, string | null, number, number][]; pt?: number; rv?: number; ch?: string[]; rf?: true; rw: number; cv: number;
}

/** One sendPubSub call the server made: when on the server clock, to whom, and whether it was delivered. */
export interface Attempt { at: number; broadcasterId: string; ok: boolean }

/** Wraps a client to log every PubSub attempt with the clock time it started. */
function recording(inner: TwitchClient, clock: FakeClock, log: Attempt[]): TwitchClient {
  return {
    usersById: (ids) => inner.usersById(ids),
    usersByLogin: (logins) => inner.usersByLogin(logins),
    tokenOwner: (token) => inner.tokenOwner(token),
    authorizeUrl: (state) => inner.authorizeUrl(state),
    exchangeCode: (code) => inner.exchangeCode(code),
    revoke: (token) => inner.revoke(token),
    async sendPubSub(broadcasterId, message): Promise<PubSubResult> {
      const at = clock.now();
      const res = await inner.sendPubSub(broadcasterId, message);
      log.push({ at, broadcasterId, ok: res.ok });
      return res;
    },
  };
}

/**
 * Closes a server whose clock is a FakeClock: shutdown step 3 waits on the clock (pacing gaps, the 10 s budget), so the
 * clock moves 100 ms at a time until close() resolves. Resolves with how far the clock moved.
 */
export async function closeOnClock(srv: RunningServer, clock: FakeClock): Promise<number> {
  const t0 = clock.now();
  let done = false;
  const p = srv.close().finally(() => { done = true; });
  p.catch(() => {});
  while (!done) {
    await new Promise((r) => setTimeout(r, 2));
    if (!done) await clock.advance(100);
  }
  await p;
  return clock.now() - t0;
}

/**
 * A server with Twitch configured against a fake Twitch, a FakeClock, rate limits on, and one channel with
 * twitch_id 1001. `serverOpts` is merged into the startServer options.
 */
export async function twitchSetup(o: { serverOpts?: Partial<ServerOpts> } = {}) {
  const t = await freshDb();
  const fake = await fakeTwitch();
  const clock = new FakeClock(1_800_000_000_000);
  const bundles = await officialTestBundles();
  const twitch: TwitchConfig = {
    clientId: fake.clientId, clientSecret: 'fake-client-secret', extensionSecret: EXT_SECRET, extensionSecretPrevious: null,
    ownerId: '999', publicUrl: 'https://dndm.example', apiBase: fake.apiBase, authBase: fake.authBase,
  };
  const attempts: Attempt[] = [];
  const seed = Store.open(t.url);
  const made = await createChannel({
    store: seed, secrets: new Secrets(SECRET), bundles, name: 'twitch', config: defaultConfig(), seed: 1, twitchId: TWITCH_ID,
  });
  await seed.close();

  const opts = (): ServerOpts => ({
    databaseUrl: t.url, secret: SECRET, clock, rateLimits: true, bundles, twitch,
    twitchClient: recording(new HttpTwitchClient(twitch, clock), clock, attempts),
    ...o.serverOpts,
  });
  let srv = await startServer(opts());
  let n = 0;
  const settle = async () => {
    await srv.manager.idle();
    await srv.layer!.idle();
    await srv.manager.idle();
  };

  return {
    t, fake, clock, channelId: made.id, twitchId: TWITCH_ID, dockToken: made.dockToken, attempts,
    get srv() { return srv; },
    /** An extension JWT for the channel (Twitch ID 1001 unless `channel`), valid for an hour unless `exp`. */
    jwt(j: { user?: string; opaque?: string; exp?: number; channel?: string } = {}): string {
      return signJwt({
        channel_id: j.channel ?? TWITCH_ID,
        opaque_user_id: j.opaque ?? (j.user ? `U${j.user}` : 'A-anon'),
        ...(j.user ? { user_id: j.user } : {}),
        role: 'viewer',
        exp: j.exp ?? Math.floor(clock.now() / 1000) + 3600,
      }, EXT_SECRET);
    },
    ext(method: 'GET' | 'POST', path: string, e: { jwt?: string; body?: unknown; origin?: string } = {}): Promise<LightMyRequestResponse> {
      return srv.app.inject({
        method, url: path,
        headers: { ...(e.jwt ? { authorization: `Bearer ${e.jwt}` } : {}), ...(e.origin ? { origin: e.origin } : {}) },
        ...(e.body !== undefined ? { payload: e.body as Record<string, unknown> } : {}),
      });
    },
    async dock(command: Record<string, unknown> & { type: string }): Promise<Answer> {
      const res = await srv.app.inject({
        method: 'POST', url: `/channels/${made.id}/commands`,
        payload: { id: `dock-${++n}`, command }, headers: { authorization: `Bearer ${made.dockToken}` },
      });
      return res.json() as Answer;
    },
    advance: (ms: number) => clock.advance(ms, settle),
    /** Snapshots delivered to a channel's topic (1001 unless given), oldest first. */
    snapshots: (twitchId = TWITCH_ID): Snapshot[] =>
      fake.pubsub().filter((m) => m.broadcasterId === twitchId).map((m) => m.message as Snapshot),
    /** Closes the server and starts a new process on the same database, fake Twitch and clock. */
    async restart(): Promise<RunningServer> {
      await closeOnClock(srv, clock);
      srv = await startServer(opts());
      return srv;
    },
    async close(): Promise<void> {
      try {
        await closeOnClock(srv, clock);
      } finally {
        await fake.close();
        await t.drop();
      }
    },
  };
}
