import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../src/clock';
import { Secrets } from '../src/crypto';
import { startServer } from '../src/server';
import { Cookies, SESSION_MS } from '../src/session';
import { esc, page } from '../src/signup';
import { freshDb } from './helpers/db';
import { officialTestBundles, SECRET } from './helpers/room';
import { twitchSetup } from './helpers/twitch';

const T = 20_000;

type Setup = Awaited<ReturnType<typeof twitchSetup>>;
let s: Setup | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await s?.close();
  s = null;
});

async function setup(signup?: 'allowlist' | 'open'): Promise<Setup> {
  s = await twitchSetup(signup ? { serverOpts: { signup } } : {});
  s.fake.addUser({ id: '77', login: 'newbie', displayName: 'Newbie' });
  return s;
}

async function signIn(x: Setup, user = '77'): Promise<LightMyRequestResponse> {
  const start = await x.srv.app.inject('/signup/start');
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const cookie = (start.headers['set-cookie'] as string).split(';')[0]!;
  return x.srv.app.inject({ url: `/signup/callback?code=${x.fake.codeFor(user)}&state=${state}`, headers: { cookie } });
}

const setCookies = (res: LightMyRequestResponse): string[] => {
  const h = res.headers['set-cookie'];
  return h === undefined ? [] : Array.isArray(h) ? h : [h];
};
const sessionOf = (x: Setup, res: LightMyRequestResponse) => {
  const c = setCookies(res).find((v) => v.startsWith('dndm_session='));
  return c ? new Cookies(new Secrets(SECRET)).readSession(c.split(';')[0], x.clock.now()) : null;
};

describe('sign-up with Twitch (spec 2b §4.3, §8)', () => {
  it('/signup shows a sign-in link', async () => {
    const x = await setup();
    const res = await x.srv.app.inject('/signup');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toContain('href="/signup/start"');
    expect(res.body).toContain('Sign in with Twitch');
  }, T);

  it('/signup/start redirects to Twitch with no scopes and a state cookie', async () => {
    const x = await setup();
    const res = await x.srv.app.inject('/signup/start');
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${x.fake.authBase}/authorize`);
    expect(loc.searchParams.get('scope')).toBe('');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://dndm.example/signup/callback');
    const state = loc.searchParams.get('state')!;
    expect(Buffer.from(state, 'base64url')).toHaveLength(16);
    const cookie = res.headers['set-cookie'] as string;
    expect(cookie).toMatch(/^dndm_state=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=600');
    expect(new Cookies(new Secrets(SECRET)).readState(cookie.split(';')[0])).toBe(state);
    // Each start gets its own state.
    const again = new URL((await x.srv.app.inject('/signup/start')).headers.location as string).searchParams.get('state');
    expect(again).not.toBe(state);
  }, T);

  it('an account not on the allowlist is turned away, and open mode lets it in', async () => {
    const x = await setup();
    const res = await signIn(x);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain(esc("The game isn't open for sign-ups yet."));
    expect(res.body).toContain('href="/signup"');
    expect(await x.srv.store.channelByTwitchId('77')).toBeNull();
    await x.close();
    s = null;

    const o = await setup('open');
    const ok = await signIn(o);
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe('/setup');
  }, T * 2);

  it('the first sign-in creates a channel named after the display name, and a second reaches the same one', async () => {
    const x = await setup();
    await x.srv.store.allow('77', 'newbie');
    const first = await signIn(x);
    expect(first.statusCode).toBe(303);
    expect(first.headers.location).toBe('/setup');
    const channel = await x.srv.store.channelByTwitchId('77');
    expect(channel).toMatchObject({ name: 'Newbie', twitchId: '77' });
    const sess = sessionOf(x, first);
    expect(sess).toEqual({ channelId: channel!.id, twitchId: '77', expiresAt: x.clock.now() + SESSION_MS });
    const cookies = setCookies(first);
    expect(cookies.find((c) => c.startsWith('dndm_session='))).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(cookies.find((c) => c.startsWith('dndm_state='))).toMatch(/Max-Age=0/);

    const second = await signIn(x);
    expect(second.statusCode).toBe(303);
    expect(sessionOf(x, second)?.channelId).toBe(channel!.id);
    // Still the one channel.
    expect((await x.srv.store.channelByTwitchId('77'))!.id).toBe(channel!.id);
  }, T);

  it('two callbacks for the same new account at once make one channel', async () => {
    const x = await setup('open');
    // Both lookups miss before either inserts, so one insert hits the unique twitch_id.
    const real = x.srv.store.channelByTwitchId.bind(x.srv.store);
    let release!: () => void;
    const bothLooked = new Promise<void>((r) => { release = r; });
    let calls = 0;
    vi.spyOn(x.srv.store, 'channelByTwitchId').mockImplementation(async (id) => {
      const n = ++calls;
      const row = await real(id);
      if (n <= 2) {
        if (n === 2) release();
        await bothLooked;
      }
      return row;
    });
    const [a, b] = await Promise.all([signIn(x), signIn(x)]);
    expect(calls).toBe(3); // two misses, then the loser's reload
    expect(a.statusCode).toBe(303);
    expect(b.statusCode).toBe(303);
    const channel = await x.srv.store.channelByTwitchId('77');
    expect(sessionOf(x, a)?.channelId).toBe(channel!.id);
    expect(sessionOf(x, b)?.channelId).toBe(channel!.id);
  }, T);

  it('the user token is revoked and a revoke failure is ignored', async () => {
    const x = await setup('open');
    expect((await signIn(x)).statusCode).toBe(303);
    const revokes = x.fake.requests.filter((r) => r.method === 'POST' && r.path === '/oauth2/revoke');
    expect(revokes).toHaveLength(1);
    expect((revokes[0]!.body as Record<string, string>).token).toMatch(/^user-77-/);

    x.fake.failNext('revoke');
    expect((await signIn(x)).statusCode).toBe(303);
  }, T);

  it('a bad state is refused', async () => {
    const x = await setup('open');
    const start = await x.srv.app.inject('/signup/start');
    const cookie = (start.headers['set-cookie'] as string).split(';')[0]!;
    const code = x.fake.codeFor('77');
    const wrong = await x.srv.app.inject({ url: `/signup/callback?code=${code}&state=wrong`, headers: { cookie } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain('That sign-in link has expired or was tampered with');
    expect(wrong.body).toContain('href="/signup"');

    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const noCookie = await x.srv.app.inject(`/signup/callback?code=${code}&state=${state}`);
    expect(noCookie.statusCode).toBe(400);
    const noState = await x.srv.app.inject({ url: `/signup/callback?code=${code}`, headers: { cookie } });
    expect(noState.statusCode).toBe(400);
    // The code was never exchanged.
    expect(x.fake.requests.some((r) => r.path === '/oauth2/token')).toBe(false);
  }, T);

  it('cancelling at Twitch shows the cancelled page even without a state cookie', async () => {
    const x = await setup();
    const res = await x.srv.app.inject('/signup/callback?error=access_denied&error_description=The+user+denied');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('You cancelled at Twitch');
    expect(res.body).toContain('href="/signup"');
  }, T);

  it('Twitch not answering shows the try-again page', async () => {
    const x = await setup('open');
    x.fake.failNext('token');
    const res = await signIn(x);
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain(esc("Twitch didn't answer; try again"));
    expect(res.body).toContain('href="/signup"');

    x.fake.failNext('users');
    const owner = await signIn(x);
    expect(owner.statusCode).toBe(502);
    expect(await x.srv.store.channelByTwitchId('77')).toBeNull();
  }, T);

  it('without Twitch settings there is no sign-up', async () => {
    const t = await freshDb();
    const srv = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0), rateLimits: false, bundles: await officialTestBundles() });
    try {
      expect((await srv.app.inject('/signup')).statusCode).toBe(404);
      expect((await srv.app.inject('/signup/start')).statusCode).toBe(404);
    } finally {
      await srv.close();
      await t.drop();
    }
  }, T);

  it('page escapes its title and esc escapes HTML', () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    const html = page('<b>', '<p>body</p>');
    expect(html).toContain('<title>&lt;b&gt;</title>');
    expect(html).toContain('<p>body</p>');
  });
});
