import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock';
import { Secrets } from '../src/crypto';
import type { Answer } from '@dndm/protocol';
import { IDLE_ROOM, type Room, RoomClosedError } from '../src/room';
import { createChannel, defaultConfig, startServer } from '../src/server';
import { HttpTwitchClient } from '../src/twitch/api';
import { TwitchLayer } from '../src/twitch/layer';
import { freshDb } from './helpers/db';
import { officialTestBundles, SECRET } from './helpers/room';
import { closeOnClock, EXT_SECRET, twitchSetup } from './helpers/twitch';

const T = 20_000; // per-test timeout, so a hang fails fast
const UNLOAD = IDLE_ROOM + 60_000; // idle long enough for the sweeper to unload a Room

type Setup = Awaited<ReturnType<typeof twitchSetup>>;
let s: Setup | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

/** Another channel on the same database, with a Twitch ID or without. */
async function another(x: Setup, twitchId?: string) {
  return createChannel({
    store: x.srv.store, secrets: x.srv.secrets, bundles: await officialTestBundles(), name: 'other', config: defaultConfig(), seed: 2,
    ...(twitchId ? { twitchId } : {}),
  });
}

async function dockAs(x: Setup, channelId: string, token: string, command: Record<string, unknown> & { type: string }, id: string) {
  const res = await x.srv.app.inject({
    method: 'POST', url: `/channels/${channelId}/commands`, payload: { id, command }, headers: { authorization: `Bearer ${token}` },
  });
  return res.json() as { ok: boolean; result?: unknown };
}

let cfgN = 0;
/** A config change (cv moves, so the next send is an rf). */
async function updateConfig(x: Setup, channel?: { id: string; dockToken: string }) {
  const c = channel ?? { id: x.channelId, dockToken: x.dockToken };
  const got = await dockAs(x, c.id, c.dockToken, { type: 'getConfig' }, `cfg-${++cfgN}`);
  const { config, configVersion } = got.result as { config: Record<string, unknown>; configVersion: number };
  const r = await dockAs(x, c.id, c.dockToken, { type: 'updateConfig', config, basedOn: configVersion }, `cfg-${++cfgN}`);
  expect(r.ok).toBe(true);
}

/** Makes a Room idle long enough to unload without moving the clock (no tick runs in between). */
function makeIdle(x: Setup, room: Room) {
  room.lastActivity = x.clock.now() - IDLE_ROOM;
}

const ok = (x: Setup, twitchId = '1001') => x.attempts.filter((a) => a.broadcasterId === twitchId && a.ok);
const failed = (x: Setup, twitchId = '1001') => x.attempts.filter((a) => a.broadcasterId === twitchId && !a.ok);

describe('TwitchLayer (spec 2b §5.3, §7.4)', () => {
  it('a Twitch channel gets a Broadcaster when its Room loads; a channel without twitch_id does not', async () => {
    s = await twitchSetup();
    const room = (await s.srv.manager.get(s.channelId))!;
    expect(room.broadcasting).toBe(true);
    expect(s.srv.layer!.broadcaster(s.channelId)).toBeDefined();
    const plain = await another(s);
    const r2 = (await s.srv.manager.get(plain.id))!;
    expect(r2.broadcasting).toBe(false);
    expect(s.srv.layer!.broadcaster(plain.id)).toBeUndefined();
  }, T);

  it('the first Broadcaster for a channel after a restart sends rf, at boot or on a later load', async () => {
    s = await twitchSetup();
    expect((await s.dock({ type: 'openSession' })).ok).toBe(true); // an open session: the Room loads at boot
    const two = await another(s, '1002');
    await s.restart();
    expect(s.srv.manager.rooms().map((r) => r.channel.id)).toEqual([s.channelId]);
    const before = s.snapshots().length;
    await s.advance(1000);
    const atBoot = s.snapshots().slice(before);
    expect(atBoot).toHaveLength(1);
    expect(atBoot[0]).toMatchObject({ rf: true, e: s.srv.layer!.broadcaster(s.channelId)!.epoch });

    // A later, on-demand load is also the first in this process.
    await s.srv.manager.get(two.id);
    await s.advance(1000);
    expect(s.snapshots('1002')).toEqual([expect.objectContaining({ rf: true, e: s.srv.layer!.broadcaster(two.id)!.epoch })]);

    // Unloaded and loaded again in the same process: the first send is an ordinary one, made on a change.
    await s.advance(UNLOAD);
    await s.srv.manager.sweep();
    expect(s.srv.layer!.broadcaster(two.id)).toBeUndefined();
    await s.advance(1000); // the unload's last send, if it owed one
    const n = s.snapshots('1002').length;
    await s.srv.manager.get(two.id);
    const again = s.srv.layer!.broadcaster(two.id)!;
    await s.advance(2000);
    expect(s.snapshots('1002')).toHaveLength(n); // nothing changed: nothing sent, not even an rf
    expect((await dockAs(s, two.id, two.dockToken, { type: 'openSession' }, 'two-1')).ok).toBe(true);
    await s.advance(1000);
    const sent = s.snapshots('1002');
    expect(sent).toHaveLength(n + 1);
    expect(sent[n]).toMatchObject({ e: again.epoch, ch: [] });
    expect(sent[n]!.ph).not.toBe('closed');
    expect(sent[n]!.rf).toBeUndefined();
  }, T);

  it('an unload prunes the channel\'s describe and roster caches', async () => {
    s = await twitchSetup();
    const layer = s.srv.layer!;
    const caches = layer as unknown as { descriptions: Map<string, unknown>; rosters: Map<string, unknown> };
    const room = (await s.srv.manager.get(s.channelId))!;
    layer.describe(room);
    expect(layer.roster(s.channelId)).not.toBeNull();
    expect(caches.descriptions.has(s.channelId)).toBe(true);
    expect(caches.rosters.has(s.channelId)).toBe(true);
    await s.advance(UNLOAD);
    expect(room.closed).toBe(true);
    expect(caches.descriptions.has(s.channelId)).toBe(false);
    expect(caches.rosters.has(s.channelId)).toBe(false);
  }, T);

  it('an attach still starting when the layer shuts down stops its Broadcaster and fails', async () => {
    s = await twitchSetup();
    const x = s;
    const room = (await x.srv.manager.get(x.channelId))!;
    // A second layer over the same Room, so the attach can race its own shutdown.
    const config = {
      clientId: x.fake.clientId, clientSecret: 'fake-client-secret', extensionSecret: EXT_SECRET, extensionSecretPrevious: null,
      ownerId: '999', publicUrl: 'https://dndm.example', apiBase: x.fake.apiBase, authBase: x.fake.authBase,
    };
    const layer = new TwitchLayer({ config, client: new HttpTwitchClient(config, x.clock), clock: x.clock, secrets: x.srv.secrets });
    const attaching = layer.attach(room);
    attaching.catch(() => {});
    await layer.shutdown(1000);
    await expect(attaching).rejects.toThrow('The Twitch layer has shut down');
    expect(layer.broadcaster(x.channelId)).toBeUndefined();
    // A leaked Broadcaster would be its channel's first since start and send an rf on its first tick.
    await x.advance(5000);
    const mine = x.srv.layer!.broadcaster(x.channelId)!.epoch;
    expect(x.snapshots().length).toBeGreaterThan(0);
    expect(x.snapshots().filter((m) => m.e !== mine)).toEqual([]);
  }, T);

  it('e is new with every Broadcaster', async () => {
    s = await twitchSetup();
    await s.srv.manager.get(s.channelId);
    await s.advance(1000);
    const first = s.snapshots()[0]!.e;
    await s.advance(UNLOAD);
    expect(s.srv.layer!.broadcaster(s.channelId)).toBeUndefined();
    await s.srv.manager.get(s.channelId);
    await updateConfig(s);
    await s.advance(1000);
    const last = s.snapshots().at(-1)!;
    expect(last.e).not.toBe(first);
    expect(last.e).toBe(s.srv.layer!.broadcaster(s.channelId)!.epoch);
  }, T);

  it('the unload runs the last broadcastState before the Room closes and sends it', async () => {
    s = await twitchSetup();
    const room = (await s.srv.manager.get(s.channelId))!;
    const b = s.srv.layer!.broadcaster(s.channelId)!;
    await s.advance(1000);
    expect(s.snapshots()).toHaveLength(1);
    await updateConfig(s);
    makeIdle(s, room);
    let sentAtClose = -1;
    const realClose = room.close.bind(room);
    room.close = () => { sentAtClose = s!.snapshots().length; realClose(); };
    await s.srv.manager.sweep();
    expect(room.closed).toBe(true);
    expect(sentAtClose).toBe(1);
    expect(s.srv.manager.rooms()).toEqual([]);
    await s.advance(1000);
    const sent = s.snapshots();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ e: b.epoch, cv: 2, rf: true });
  }, T);

  it('an input that arrives during an unload lands on a fresh Room, and its change reaches viewers', async () => {
    s = await twitchSetup();
    const room = (await s.srv.manager.get(s.channelId))!;
    await s.advance(1000);
    makeIdle(s, room);
    // Queue inputs right behind the unload's last read: one straight on the old Room, one through the app route.
    const real = room.broadcastState.bind(room);
    let direct: Promise<unknown> | undefined;
    let routed: Promise<Answer> | undefined;
    room.broadcastState = (o) => {
      const p = real(o);
      if (o?.last) {
        direct = room.command({ role: 'dock' }, 'direct-1', { type: 'openSession' });
        routed = s!.dock({ type: 'openSession' });
      }
      return p;
    };
    await s.srv.manager.sweep();
    await expect(direct).rejects.toBeInstanceOf(RoomClosedError);
    expect((await routed!).ok).toBe(true);
    expect(room.closed).toBe(true);
    expect(room.game.session).toBeNull(); // nothing ran on the old Room after its last read
    const fresh = (await s.srv.manager.get(s.channelId))!;
    expect(fresh).not.toBe(room);
    expect(fresh.game.session).not.toBeNull();
    await s.advance(2000);
    const last = s.snapshots().at(-1)!;
    expect(last.e).toBe(s.srv.layer!.broadcaster(s.channelId)!.epoch);
    expect(last.ph).not.toBe('closed');
  }, T);

  it('a reload within a second queues its first send behind the old last send', async () => {
    s = await twitchSetup();
    const t0 = s.clock.now();
    const room = (await s.srv.manager.get(s.channelId))!;
    const old = s.srv.layer!.broadcaster(s.channelId)!;
    await s.advance(1000); // the first rf goes at t0 + 1000
    await s.advance(400);
    await updateConfig(s);
    makeIdle(s, room);
    await s.srv.manager.sweep(); // the last send waits on the gate until t0 + 2000
    await s.advance(200);
    await s.srv.manager.get(s.channelId); // a new Broadcaster at t0 + 1600: its ticks fall at t0 + 2600, 3600, …
    const fresh = s.srv.layer!.broadcaster(s.channelId)!;
    expect(fresh).not.toBe(old);
    await updateConfig(s);
    await s.advance(3000);
    expect(ok(s).map((a) => a.at - t0)).toEqual([1000, 2000, 3000]);
    expect(s.snapshots().map((m) => m.e)).toEqual([old.epoch, old.epoch, fresh.epoch]);
  }, T);

  it('an unload last send that fails for 30 s records dropped keys, and the next Broadcaster sends rf', async () => {
    s = await twitchSetup();
    const t0 = s.clock.now();
    const room = (await s.srv.manager.get(s.channelId))!;
    await s.advance(1000);
    await updateConfig(s);
    makeIdle(s, room);
    // With backoff from a clean channel, the last send tries at +2, +3, +5, +9 and +17 s; the next try (+33 s) is past +31 s.
    s.fake.failNext('pubsub', 5);
    await s.srv.manager.sweep();
    await s.advance(31_000);
    expect(failed(s).map((a) => a.at - t0)).toEqual([2000, 3000, 5000, 9000, 17_000]);
    expect(s.srv.layer!.gate.hasDropped('1001')).toBe(true);
    await s.srv.manager.get(s.channelId);
    const fresh = s.srv.layer!.broadcaster(s.channelId)!;
    await s.advance(2000);
    expect(s.snapshots()).toHaveLength(2);
    expect(s.snapshots()[1]).toMatchObject({ e: fresh.epoch, rf: true });
    expect(s.srv.layer!.gate.hasDropped('1001')).toBe(false);
  }, T);

  it('keys dropped while a newer Broadcaster already runs make its next send an rf', async () => {
    s = await twitchSetup();
    const t0 = s.clock.now();
    const room = (await s.srv.manager.get(s.channelId))!;
    await s.advance(1000);
    await updateConfig(s);
    makeIdle(s, room);
    s.fake.failNext('pubsub', 5);
    await s.srv.manager.sweep();
    await s.advance(200);
    await s.srv.manager.get(s.channelId);
    const fresh = s.srv.layer!.broadcaster(s.channelId)!;
    await s.advance(10_000);
    expect(s.srv.layer!.gate.hasDropped('1001')).toBe(false); // the old last send is still retrying
    await s.advance(25_000);
    expect(failed(s)).toHaveLength(5);
    const sent = s.snapshots();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ e: fresh.epoch, rf: true });
    // Built on the first tick after the drop, it waited for the gate's backoff from the last failure.
    expect(ok(s).at(-1)!.at - t0).toBe(33_000);
    expect(s.srv.layer!.gate.hasDropped('1001')).toBe(false);
  }, T);

  it('shutdown runs each last tick and sends it', async () => {
    s = await twitchSetup();
    const two = await another(s, '1002');
    await s.srv.manager.get(s.channelId);
    await s.srv.manager.get(two.id);
    await s.advance(1000);
    await updateConfig(s);
    await updateConfig(s, two);
    await closeOnClock(s.srv, s.clock);
    expect(s.snapshots()).toEqual([expect.objectContaining({ cv: 1 }), expect.objectContaining({ cv: 2, rf: true })]);
    expect(s.snapshots('1002')).toEqual([expect.objectContaining({ cv: 1 }), expect.objectContaining({ cv: 2, rf: true })]);
  }, T);

  it('shutdown runs each last tick and waits at most 10 s', async () => {
    s = await twitchSetup();
    await s.srv.manager.get(s.channelId); // its first send (an rf) is still owed: the last tick sends it
    s.fake.hangNext('pubsub');
    const moved = await closeOnClock(s.srv, s.clock);
    expect(s.fake.requests.filter((r) => r.path.endsWith('/extensions/pubsub'))).toHaveLength(1);
    expect(s.snapshots()).toEqual([]);
    expect(moved).toBeGreaterThanOrEqual(10_000);
    expect(moved).toBeLessThan(11_000);
  }, T);

  it('a last send still parked on a 429 when shutdown gives up never goes out afterwards', async () => {
    s = await twitchSetup();
    await s.srv.manager.get(s.channelId); // its first send (an rf) is owed
    s.fake.rateLimitNext(Math.ceil((s.clock.now() + 60_000) / 1000));
    await s.advance(1000);
    expect(failed(s)).toHaveLength(1);
    const moved = await closeOnClock(s.srv, s.clock);
    expect(moved).toBeLessThan(11_000);
    const before = s.attempts.length;
    await s.clock.advance(120_000, () => new Promise<void>((r) => setImmediate(r)));
    expect(s.attempts).toHaveLength(before);
    expect(s.snapshots()).toEqual([]);
  }, T);

  it('shutdown step 3 runs even if closing the HTTP app fails', async () => {
    const x = s = await twitchSetup();
    await x.srv.manager.get(x.channelId);
    await x.advance(1000);
    await updateConfig(x);
    const realClose = x.srv.app.close.bind(x.srv.app);
    (x.srv.app as { close: () => Promise<void> }).close = () => Promise.reject(new Error('boom'));
    await expect(closeOnClock(x.srv, x.clock)).rejects.toThrow('boom');
    await realClose();
    expect(x.snapshots().at(-1)).toMatchObject({ cv: 2, rf: true });
    // close() stays rejected, so clean up here rather than in afterEach.
    s = null;
    await x.fake.close();
    await x.t.drop();
  }, T);

  it('a failing layer shutdown still unloads the Rooms and closes the database', async () => {
    s = await twitchSetup();
    const room = (await s.srv.manager.get(s.channelId))!;
    (s.srv.layer as { shutdown: (ms: number) => Promise<void> }).shutdown = () => Promise.reject(new Error('layer boom'));
    await closeOnClock(s.srv, s.clock);
    expect(room.closed).toBe(true);
    // The lock went with the store, so another server starts.
    const again = await startServer({ databaseUrl: s.t.url, secret: SECRET, clock: new FakeClock(0), rateLimits: false, bundles: await officialTestBundles() });
    await again.close();
  }, T);

  it('no Twitch settings: no layer, no Broadcasters', async () => {
    const t = await freshDb();
    try {
      const srv = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0), rateLimits: false, bundles: await officialTestBundles() });
      try {
        expect(srv.layer).toBeNull();
        const c = await createChannel({
          store: srv.store, secrets: new Secrets(SECRET), bundles: await officialTestBundles(), name: 'x', config: defaultConfig(), seed: 1, twitchId: '1003',
        });
        expect((await srv.manager.get(c.id))!.broadcasting).toBe(false);
      } finally {
        await srv.close();
      }
    } finally {
      await t.drop();
    }
  }, T);
});
