import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../src/clock';
import { Room } from '../src/room';
import { startServer } from '../src/server';
import { HttpTwitchClient, type TwitchUser } from '../src/twitch/api';
import { UserLookup } from '../src/twitch/users';
import { freshDb } from './helpers/db';
import { officialTestBundles, SECRET } from './helpers/room';
import { twitchSetup } from './helpers/twitch';

const T = 20_000; // per-test timeout, so a hang fails fast

type Setup = Awaited<ReturnType<typeof twitchSetup>>;
let s: Setup | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await s?.close();
  s = null;
});

const join = (id: string, extra: Record<string, unknown> = {}) => ({ id, command: { type: 'join', pick: 'starter:sword', ...extra } });

async function setup(): Promise<Setup> {
  s = await twitchSetup();
  s.fake.addUser({ id: '42', login: 'viewer42', displayName: 'Viewer42' });
  expect((await s.dock({ type: 'openSession' })).ok).toBe(true);
  return s;
}

describe('/ext routes (spec 2b §4.1, §4.2, §5.6)', () => {
  it('each route answers', async () => {
    const x = await setup();
    const j = x.jwt({ user: '42' });
    const key = x.srv.layer!.keyOf(x.channelId, 'twitch:42');

    const view = await x.ext('GET', '/ext/view', { jwt: j });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ ok: true, key, view: { character: null } }); // not joined yet

    const cmd = await x.ext('POST', '/ext/commands', { jwt: j, body: join('j1') });
    expect(cmd.statusCode).toBe(200);
    expect(cmd.json()).toMatchObject({ ok: true, key, view: { character: { inParty: true, name: 'Viewer42' } } });

    const desc = await x.ext('GET', '/ext/describe', { jwt: j });
    expect(desc.statusCode).toBe(200);
    expect(desc.json().ok).toBe(true);
    expect(desc.json().describe).toEqual(x.srv.manager.rooms()[0]!.describe());

    await x.advance(1000);
    const roster = await x.ext('GET', '/ext/roster', { jwt: j });
    expect(roster.statusCode).toBe(200);
    const b = x.srv.layer!.broadcaster(x.channelId)!;
    expect(roster.json()).toEqual({ ok: true, rv: b.rv, members: [[key, 'twitch:42', 'Viewer42', expect.any(String), 1]] });

    const party = await x.ext('GET', '/ext/party', { jwt: j });
    expect(party.statusCode).toBe(200);
    expect(party.json()).toEqual({
      ok: true,
      members: [{
        key, id: 'twitch:42', name: 'Viewer42', class: expect.any(String), level: 1,
        hp: expect.any(Number), maxHp: expect.any(Number), knockedOut: false, statuses: [],
      }],
    });
  }, T);

  it('without user_id, view is the public view and commands answer identity-required', async () => {
    const x = await setup();
    const j = x.jwt({ opaque: 'U-anon' });
    const v = await x.ext('GET', '/ext/view', { jwt: j });
    expect(v.statusCode).toBe(200);
    expect(v.json().view.character).toBeNull();
    expect(v.json().key).toBeUndefined();
    const r = await x.ext('POST', '/ext/commands', { jwt: j, body: join('a') });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ ok: false, error: { code: 'identity-required' } });
  }, T);

  it('roster, party and describe answer a JWT without user_id', async () => {
    const x = await setup();
    const j = x.jwt({ opaque: 'U-anon' });
    for (const p of ['/ext/roster', '/ext/party', '/ext/describe']) {
      const r = await x.ext('GET', p, { jwt: j });
      expect(r.statusCode, p).toBe(200);
      expect(r.json().ok, p).toBe(true);
    }
  }, T);

  it('a bad or missing JWT is unauthorized', async () => {
    const x = await setup();
    expect((await x.ext('GET', '/ext/view')).statusCode).toBe(401);
    const bad = await x.ext('GET', '/ext/view', { jwt: `${x.jwt({ user: '42' })}x` });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    const expired = x.jwt({ user: '42', exp: Math.floor(x.clock.now() / 1000) - 120 });
    expect((await x.ext('GET', '/ext/roster', { jwt: expired })).statusCode).toBe(401);
    // A dock token is not a JWT.
    const dock = await x.srv.app.inject({ method: 'GET', url: '/ext/view', headers: { authorization: `Bearer ${x.dockToken}` } });
    expect(dock.statusCode).toBe(401);
  }, T);

  it('a viewer acts only as themselves', async () => {
    const x = await setup();
    x.fake.addUser({ id: '999', login: 'other', displayName: 'Other' });
    const r = await x.ext('POST', '/ext/commands', { jwt: x.jwt({ user: '42' }), body: join('j1', { character: 'twitch:999' }) });
    expect(r.json()).toMatchObject({ ok: true, view: { character: { id: 'twitch:42', inParty: true } } });
    const room = x.srv.manager.rooms()[0]!;
    expect((await room.view({ role: 'overlay' })).party.map((m) => m.id)).toEqual(['twitch:42']);
    // A streamer command from a viewer is refused, whatever their JWT role.
    const open = await x.ext('POST', '/ext/commands', { jwt: x.jwt({ user: '42' }), body: { id: 'c1', command: { type: 'closeSession' } } });
    expect(open.statusCode).toBe(403);
    expect(open.json().error.code).toBe('streamer-only');
  }, T);

  it('the rate limit is 5 per second per viewer', async () => {
    const x = await setup();
    const j = x.jwt({ user: '42' });
    for (let i = 0; i < 5; i++) expect((await x.ext('GET', '/ext/view', { jwt: j })).statusCode).toBe(200);
    const sixth = await x.ext('GET', '/ext/view', { jwt: j });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.code).toBe('rate-limited');
    // Another viewer has their own budget; so does each opaque ID.
    expect((await x.ext('GET', '/ext/view', { jwt: x.jwt({ user: '43' }) })).statusCode).toBe(200);
    const anon = x.jwt({ opaque: 'A-1' });
    for (let i = 0; i < 5; i++) expect((await x.ext('GET', '/ext/roster', { jwt: anon })).statusCode).toBe(200);
    expect((await x.ext('GET', '/ext/roster', { jwt: anon })).statusCode).toBe(429);
    expect((await x.ext('GET', '/ext/roster', { jwt: x.jwt({ opaque: 'A-2' }) })).statusCode).toBe(200);
    await x.clock.advance(1000);
    expect((await x.ext('GET', '/ext/view', { jwt: j })).statusCode).toBe(200);
  }, T);

  it('CORS for the extension origin only', async () => {
    const x = await setup();
    const origin = `https://${x.fake.clientId}.ext-twitch.tv`;
    const ok = await x.ext('GET', '/ext/roster', { jwt: x.jwt(), origin });
    expect(ok.headers['access-control-allow-origin']).toBe(origin);
    expect(ok.headers.vary).toContain('Origin');
    const unauth = await x.ext('GET', '/ext/roster', { origin });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers['access-control-allow-origin']).toBe(origin);

    const evil = await x.ext('GET', '/ext/roster', { jwt: x.jwt(), origin: 'https://evil.example' });
    expect(evil.statusCode).toBe(200);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();

    const pre = await x.srv.app.inject({ method: 'OPTIONS', url: '/ext/commands', headers: { origin } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(origin);
    expect(pre.headers['access-control-allow-headers']).toBe('Authorization, Content-Type');
    expect(pre.headers['access-control-allow-methods']).toBe('GET, POST');
    expect(pre.headers['access-control-max-age']).toBe('7200');
    const preEvil = await x.srv.app.inject({ method: 'OPTIONS', url: '/ext/commands', headers: { origin: 'https://evil.example' } });
    expect(preEvil.headers['access-control-allow-origin']).toBeUndefined();
    expect(preEvil.headers['access-control-allow-headers']).toBeUndefined();
    expect(preEvil.headers['access-control-max-age']).toBeUndefined();
  }, T);

  it('command answers carry view and key, on success and on engine rejection', async () => {
    const x = await setup();
    const j = x.jwt({ user: '42' });
    const key = x.srv.layer!.keyOf(x.channelId, 'twitch:42');
    const first = await x.ext('POST', '/ext/commands', { jwt: j, body: join('j1') });
    expect(first.json()).toMatchObject({ ok: true, key, view: { character: { inParty: true } } });
    const again = await x.ext('POST', '/ext/commands', { jwt: j, body: join('j2') });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: false, error: { code: 'in-party' }, key, view: { character: { inParty: true } } });
    // A server error carries neither.
    const bad = await x.ext('POST', '/ext/commands', { jwt: j, body: { id: 'x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().view).toBeUndefined();
    expect(bad.json().key).toBeUndefined();
  }, T);

  it('a client name is ignored on join', async () => {
    const x = await setup();
    x.fake.addUser({ id: '42', login: 'viewer42', displayName: 'Real Name' });
    const r = await x.ext('POST', '/ext/commands', { jwt: x.jwt({ user: '42' }), body: join('j1', { name: 'Fake' }) });
    expect(r.json()).toMatchObject({ ok: true, view: { character: { name: 'Real Name' } } });
  }, T);

  it('Get Users failing on join: an existing character joins with their stored name, a new one gets twitch-unavailable', async () => {
    const x = await setup();
    const j = x.jwt({ user: '42' });
    expect((await x.ext('POST', '/ext/commands', { jwt: j, body: join('j1') })).json().ok).toBe(true);
    expect((await x.ext('POST', '/ext/commands', { jwt: j, body: { id: 'l1', command: { type: 'leave' } } })).json().ok).toBe(true);
    x.fake.addUser({ id: '42', login: 'viewer42', displayName: 'Renamed' });
    await x.advance(10 * 60_000); // past the cached name's TTL, so the rejoin asks Twitch
    x.fake.failNext('users');
    const back = await x.ext('POST', '/ext/commands', { jwt: j, body: join('j2', { name: 'Fake' }) });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ ok: true, view: { character: { inParty: true, name: 'Viewer42' } } });

    x.fake.addUser({ id: '43', login: 'viewer43', displayName: 'Viewer43' });
    x.fake.failNext('users');
    const fresh = await x.ext('POST', '/ext/commands', { jwt: x.jwt({ user: '43' }), body: join('n1') });
    expect(fresh.statusCode).toBe(503);
    expect(fresh.json()).toMatchObject({ ok: false, error: { code: 'twitch-unavailable' } });
    expect(await x.srv.store.characters(x.channelId, ['twitch:43'])).toEqual([]);
    // Twitch back: the retry works.
    expect((await x.ext('POST', '/ext/commands', { jwt: x.jwt({ user: '43' }), body: join('n2') })).json().ok).toBe(true);
  }, T);

  it('joins at about the same time share one Get Users request', async () => {
    const x = await setup();
    x.fake.addUser({ id: '43', login: 'viewer43', displayName: 'Viewer43' });
    const [a, b] = await Promise.all([
      x.ext('POST', '/ext/commands', { jwt: x.jwt({ user: '42' }), body: join('a') }),
      x.ext('POST', '/ext/commands', { jwt: x.jwt({ user: '43' }), body: join('b') }),
    ]);
    expect(a.json()).toMatchObject({ ok: true, view: { character: { name: 'Viewer42' } } });
    expect(b.json()).toMatchObject({ ok: true, view: { character: { name: 'Viewer43' } } });
    const gets = x.fake.requests.filter((r) => r.path === '/helix/users');
    expect(gets).toHaveLength(1);
    expect([gets[0]!.query.id].flat().sort()).toEqual(['42', '43']);
  }, T);

  it('a rejoin within the cache TTL reuses the name without asking Twitch', async () => {
    const x = await setup();
    const j = x.jwt({ user: '42' });
    expect((await x.ext('POST', '/ext/commands', { jwt: j, body: join('j1') })).json().ok).toBe(true);
    expect((await x.ext('POST', '/ext/commands', { jwt: j, body: { id: 'l1', command: { type: 'leave' } } })).json().ok).toBe(true);
    const before = x.fake.requests.filter((r) => r.path === '/helix/users').length;
    const back = await x.ext('POST', '/ext/commands', { jwt: j, body: join('j2') });
    expect(back.json()).toMatchObject({ ok: true, view: { character: { inParty: true, name: 'Viewer42' } } });
    expect(x.fake.requests.filter((r) => r.path === '/helix/users')).toHaveLength(before);
  }, T);

  it('a replayed /ext/commands request gets a fresh view and key', async () => {
    const x = await setup();
    const j = x.jwt({ user: '42' });
    const first = await x.ext('POST', '/ext/commands', { jwt: j, body: join('j1') });
    expect(first.json().view.character.inParty).toBe(true);
    expect((await x.dock({ type: 'removePlayer', character: 'twitch:42' })).ok).toBe(true);
    const replay = await x.ext('POST', '/ext/commands', { jwt: j, body: join('j1') });
    expect(replay.json()).toMatchObject({ ok: true, key: first.json().key, view: { character: { inParty: false } } });
    expect(replay.json().events).toEqual(first.json().events);
  }, T);

  it('a key from /ext/view matches p, ch and /ext/roster', async () => {
    const x = await setup();
    await x.advance(1000); // the first Broadcaster since start sends its rf
    const j = x.jwt({ user: '42' });
    const key = (await x.ext('GET', '/ext/view', { jwt: j })).json().key as string;
    expect((await x.ext('POST', '/ext/commands', { jwt: j, body: join('j1') })).json().ok).toBe(true);
    await x.advance(1000);
    const snap = x.snapshots().at(-1)!;
    expect(snap.p![0]![0]).toBe(key);
    expect(snap.ch).toContain(key);
    expect((await x.ext('GET', '/ext/roster', { jwt: j })).json().members[0][0]).toBe(key);
  }, T);

  it('an unsigned-up channel_id is unknown-channel with the setup message', async () => {
    const x = await setup();
    const r = await x.ext('GET', '/ext/view', { jwt: x.jwt({ channel: '9999', user: '42' }) });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ ok: false, error: { code: 'unknown-channel', message: "This streamer hasn't set up the game yet." } });
  }, T);

  it('a channel whose Room failed to load is tried again', async () => {
    s = await twitchSetup();
    const x = s;
    vi.spyOn(Room, 'load').mockRejectedValueOnce(new Error('boom'));
    const failed = await x.ext('GET', '/ext/view', { jwt: x.jwt({ user: '42' }) });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ ok: false, error: { code: 'internal' } });
    const next = await x.ext('GET', '/ext/view', { jwt: x.jwt({ user: '42' }) });
    expect(next.statusCode).toBe(200);
    expect(next.json().ok).toBe(true);
  }, T);

  it('two joins for the same new viewer at once while Get Users is slow make one character', async () => {
    const x = await setup();
    const real = HttpTwitchClient.prototype.usersById;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    vi.spyOn(HttpTwitchClient.prototype, 'usersById').mockImplementation(async function (this: HttpTwitchClient, ids: string[]): Promise<TwitchUser[]> {
      calls += 1;
      await gate;
      return real.call(this, ids);
    });
    const lookups = vi.spyOn(UserLookup.prototype, 'lookup');
    const j = x.jwt({ user: '42' });
    const a = x.ext('POST', '/ext/commands', { jwt: j, body: join('a') });
    const b = x.ext('POST', '/ext/commands', { jwt: j, body: join('b') });
    await vi.waitFor(() => expect(lookups).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(calls).toBe(1)); // both joins share one Get Users
    release();
    const answers = (await Promise.all([a, b])).map((r) => r.json());
    expect(answers.filter((r) => r.ok)).toHaveLength(1);
    expect(answers.filter((r) => !r.ok).map((r) => r.error.code)).toEqual(['in-party']);
    await x.srv.manager.idle();
    expect(await x.srv.store.characters(x.channelId, ['twitch:42'])).toHaveLength(1);
  }, T);

  it('roster and describe are served from a cache', async () => {
    const x = await setup();
    const room = (await x.srv.manager.get(x.channelId))!;
    const describe = vi.spyOn(room, 'describe');
    const j = x.jwt();
    const d1 = (await x.ext('GET', '/ext/describe', { jwt: j })).json();
    const d2 = (await x.ext('GET', '/ext/describe', { jwt: x.jwt({ opaque: 'A-2' }) })).json();
    expect(d2).toEqual(d1);
    expect(describe).toHaveBeenCalledTimes(1);

    const layer = x.srv.layer!;
    const r1 = layer.roster(x.channelId);
    expect(layer.roster(x.channelId)).toBe(r1);
    expect((await x.ext('POST', '/ext/commands', { jwt: x.jwt({ user: '42' }), body: join('j1') })).json().ok).toBe(true);
    await x.advance(1000);
    const r2 = layer.roster(x.channelId)!;
    expect(r2).not.toBe(r1);
    expect(r2.rv).toBe(r1!.rv + 1);

    // The public view: one Room read per inputs value.
    const view = vi.spyOn(room, 'view');
    const anon = x.jwt({ opaque: 'A-3' });
    await x.ext('GET', '/ext/view', { jwt: anon });
    await x.ext('GET', '/ext/view', { jwt: anon });
    expect(view).toHaveBeenCalledTimes(1);
    expect((await x.ext('POST', '/ext/commands', { jwt: x.jwt({ user: '42' }), body: { id: 'l1', command: { type: 'leave' } } })).json().ok).toBe(true);
    view.mockClear();
    const after = (await x.ext('GET', '/ext/view', { jwt: anon })).json();
    expect(view).toHaveBeenCalledTimes(1);
    expect(after.view.party).toEqual([]);
  }, T);

  it('a config change gives a new describe', async () => {
    const x = await setup();
    const j = x.jwt();
    await x.ext('GET', '/ext/describe', { jwt: j });
    const room = (await x.srv.manager.get(x.channelId))!;
    const describe = vi.spyOn(room, 'describe');
    const got = await x.srv.app.inject({
      method: 'POST', url: `/channels/${x.channelId}/commands`, payload: { id: 'g', command: { type: 'getConfig' } },
      headers: { authorization: `Bearer ${x.dockToken}` },
    });
    const { config, configVersion } = got.json().result;
    const up = await x.srv.app.inject({
      method: 'POST', url: `/channels/${x.channelId}/commands`, payload: { id: 'u', command: { type: 'updateConfig', config, basedOn: configVersion } },
      headers: { authorization: `Bearer ${x.dockToken}` },
    });
    expect(up.json().ok).toBe(true);
    await x.ext('GET', '/ext/describe', { jwt: x.jwt({ opaque: 'A-2' }) });
    expect(describe).toHaveBeenCalledTimes(1);
  }, T);

  it('without Twitch settings there are no /ext routes', async () => {
    const t = await freshDb();
    const srv = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(1_800_000_000_000), bundles: await officialTestBundles() });
    try {
      expect((await srv.app.inject({ method: 'GET', url: '/ext/view' })).statusCode).toBe(404);
    } finally {
      await srv.close();
      await t.drop();
    }
  }, T);
});
