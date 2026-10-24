import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock';
import type { TwitchConfig } from '../src/config';
import { HttpTwitchClient, TwitchError } from '../src/twitch/api';
import { fakeTwitch, type FakeTwitch } from './helpers/fake-twitch';

const SECRET = Buffer.from('test-ext-secret').toString('base64');
const T0 = 1_800_000_000_000;

let fake: FakeTwitch;
let clock: FakeClock;
let cfg: TwitchConfig;
let c: HttpTwitchClient;
const extra: FakeTwitch[] = [];

beforeEach(async () => {
  fake = await fakeTwitch();
  clock = new FakeClock(T0);
  cfg = {
    clientId: fake.clientId, clientSecret: 'shh', extensionSecret: SECRET, extensionSecretPrevious: null,
    ownerId: '999', publicUrl: 'https://dndm.example', apiBase: fake.apiBase, authBase: fake.authBase,
  };
  c = new HttpTwitchClient(cfg, clock);
  fake.addUser({ id: '1', login: 'alice', displayName: 'Alice' });
});
afterEach(async () => {
  await fake.close();
  await Promise.all(extra.splice(0).map((f) => f.close()));
});

const tokenRequests = () => fake.requests.filter((r) => r.path === '/oauth2/token');

describe('HttpTwitchClient', () => {
  it('gets an app token once and reuses it', async () => {
    await c.usersById(['1']);
    await c.usersById(['1']);
    expect(tokenRequests()).toHaveLength(1);
    expect(tokenRequests()[0]!.body).toMatchObject({ client_id: fake.clientId, client_secret: 'shh', grant_type: 'client_credentials' });
  });

  it('sends Client-Id and the bearer token, and maps display_name', async () => {
    expect(await c.usersById(['1'])).toEqual([{ id: '1', login: 'alice', displayName: 'Alice' }]);
    const get = fake.requests.find((r) => r.path === '/helix/users')!;
    expect(get.headers['client-id']).toBe(fake.clientId);
    expect(get.headers.authorization).toBe('Bearer app-1');
  });

  it('refreshes the app token when less than 10 minutes remain', async () => {
    const short = await fakeTwitch({ appTokenTtlSec: 900 });
    extra.push(short);
    short.addUser({ id: '1', login: 'alice', displayName: 'Alice' });
    const sc = new HttpTwitchClient({ ...cfg, clientId: short.clientId, apiBase: short.apiBase, authBase: short.authBase }, clock);
    await sc.usersById(['1']);
    await clock.advance(4 * 60_000);
    await sc.usersById(['1']);
    expect(short.requests.filter((r) => r.path === '/oauth2/token')).toHaveLength(1);
    await clock.advance(2 * 60_000);
    await sc.usersById(['1']);
    expect(short.requests.filter((r) => r.path === '/oauth2/token')).toHaveLength(2);
    expect(short.requests.filter((r) => r.path === '/helix/users').at(-1)!.headers.authorization).toBe('Bearer app-2');
  });

  it('refreshes once on a 401 and retries', async () => {
    await c.usersById(['1']);
    fake.revokeAppTokens();
    expect(await c.usersById(['1'])).toHaveLength(1);
    expect(tokenRequests()).toHaveLength(2);
  });

  it('gives up after one refresh when the retry is also a 401', async () => {
    await c.usersById(['1']);
    fake.revokeAppTokens({ always: true });
    await expect(c.usersById(['1'])).rejects.toBeInstanceOf(TwitchError);
    expect(tokenRequests()).toHaveLength(2);
  });

  it('looks users up by login and the token owner by user token', async () => {
    expect(await c.usersByLogin(['alice'])).toEqual([{ id: '1', login: 'alice', displayName: 'Alice' }]);
    const code = fake.codeFor('1');
    const token = await c.exchangeCode(code);
    expect(await c.tokenOwner(token)).toEqual({ id: '1', login: 'alice', displayName: 'Alice' });
    const exch = tokenRequests().at(-1)!;
    expect(exch.body).toMatchObject({ grant_type: 'authorization_code', code, redirect_uri: 'https://dndm.example/signup/callback' });
  });

  it('batches ids as repeated id parameters', async () => {
    fake.addUser({ id: '2', login: 'bob', displayName: 'Bob' });
    expect((await c.usersById(['1', '2'])).map((u) => u.id)).toEqual(['1', '2']);
    expect(fake.requests.find((r) => r.path === '/helix/users')!.query).toEqual({ id: ['1', '2'] });
    expect(await c.usersById([])).toEqual([]);
  });

  it('builds the authorize URL', () => {
    const u = new URL(c.authorizeUrl('st ate'));
    expect(`${u.origin}${u.pathname}`).toBe(`${fake.authBase}/authorize`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: fake.clientId, redirect_uri: 'https://dndm.example/signup/callback', response_type: 'code', scope: '', state: 'st ate',
    });
  });

  it('a bad code or token throws TwitchError', async () => {
    await expect(c.exchangeCode('nope')).rejects.toBeInstanceOf(TwitchError);
    await expect(c.tokenOwner('nope')).rejects.toBeInstanceOf(TwitchError);
  });

  it('revoke posts client_id and token, and failure throws', async () => {
    await c.revoke('tok');
    expect(fake.requests.find((r) => r.path === '/oauth2/revoke')!.body).toEqual({ client_id: fake.clientId, token: 'tok' });
    fake.failNext('revoke');
    await expect(c.revoke('tok')).rejects.toBeInstanceOf(TwitchError);
  });

  it('a failed token request throws TwitchError', async () => {
    fake.failNext('token');
    await expect(c.usersById(['1'])).rejects.toBeInstanceOf(TwitchError);
  });

  it('a failed Get Users throws TwitchError', async () => {
    fake.failNext('users');
    await expect(c.usersById(['1'])).rejects.toBeInstanceOf(TwitchError);
  });

  it('an unreachable Twitch throws TwitchError', async () => {
    const dead = new HttpTwitchClient({ ...cfg, apiBase: 'http://127.0.0.1:1/helix', authBase: 'http://127.0.0.1:1/oauth2' }, clock, 500);
    await expect(dead.usersById(['1'])).rejects.toBeInstanceOf(TwitchError);
  });

  it('a hung Get Users times out as TwitchError', async () => {
    const quick = new HttpTwitchClient(cfg, clock, 50);
    await quick.usersById(['1']);
    fake.hangNext('users');
    await expect(quick.usersById(['1'])).rejects.toBeInstanceOf(TwitchError);
  });
});

describe('sendPubSub', () => {
  it('posts the broadcast body with a pubsub JWT', async () => {
    expect(await c.sendPubSub('1001', '{"v":1}')).toEqual({ ok: true });
    expect(fake.pubsub()).toEqual([{ broadcasterId: '1001', message: { v: 1 } }]);
    const req = fake.requests.find((r) => r.path === '/helix/extensions/pubsub')!;
    expect(req.body).toEqual({ target: ['broadcast'], broadcaster_id: '1001', message: '{"v":1}' });
    expect(req.headers['client-id']).toBe(fake.clientId);
    const jwt = req.headers.authorization!.replace('Bearer ', '');
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
    expect(claims).toMatchObject({ channel_id: '1001', role: 'external', user_id: '999', pubsub_perms: { send: ['broadcast'] } });
    expect(claims.exp).toBe(T0 / 1000 + 60);
  });

  it('a 429 reports retryAt from Ratelimit-Reset', async () => {
    fake.rateLimitNext(1_800_000_100);
    expect(await c.sendPubSub('1001', '{}')).toEqual({ ok: false, status: 429, retryAt: 1_800_000_100_000 });
    expect(fake.pubsub()).toEqual([]);
  });

  it('another failure reports its status with no retryAt', async () => {
    fake.failNext('pubsub', 2);
    expect(await c.sendPubSub('1001', '{}')).toEqual({ ok: false, status: 500, retryAt: null });
    expect(await c.sendPubSub('1001', '{}')).toEqual({ ok: false, status: 500, retryAt: null });
    expect(await c.sendPubSub('1001', '{}')).toEqual({ ok: true });
  });

  it('a hung send times out as a failure', async () => {
    const quick = new HttpTwitchClient(cfg, clock, 50);
    fake.hangNext('pubsub');
    expect(await quick.sendPubSub('1001', '{}')).toEqual({ ok: false, status: 0, retryAt: null });
  });

  it('an unreachable Twitch is a failure, not a throw', async () => {
    const dead = new HttpTwitchClient({ ...cfg, apiBase: 'http://127.0.0.1:1/helix' }, clock, 500);
    expect(await dead.sendPubSub('1001', '{}')).toEqual({ ok: false, status: 0, retryAt: null });
  });

  it('close() releases a hung request', async () => {
    const f = await fakeTwitch();
    const hc = new HttpTwitchClient({ ...cfg, clientId: f.clientId, apiBase: f.apiBase, authBase: f.authBase }, clock, 30_000);
    f.hangNext('pubsub');
    const pending = hc.sendPubSub('1001', '{}');
    await new Promise((r) => setTimeout(r, 50));
    await f.close();
    expect(await pending).toEqual({ ok: false, status: 0, retryAt: null });
  });
});
