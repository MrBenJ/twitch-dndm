import { WS_CLOSE } from '@dndm/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionCookie, setCookies, signIn, type Setup } from './helpers/signin';
import { twitchSetup } from './helpers/twitch';

const T = 20_000;
let s: Setup | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

async function signedIn(displayName = 'Newbie') {
  s = await twitchSetup({ serverOpts: { signup: 'open' } });
  s.fake.addUser({ id: '77', login: 'newbie', displayName });
  const res = await signIn(s);
  const cookie = sessionCookie(res);
  const channel = (await s.srv.store.channelByTwitchId('77'))!;
  const get = (url: string, c: string | null = cookie) => s!.srv.app.inject({ url, headers: c ? { cookie: c } : {} });
  const post = (url: string, form: string, c: string | null = cookie) =>
    s!.srv.app.inject({ method: 'POST', url, payload: form, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(c ? { cookie: c } : {}) } });
  const csrf = async (c = cookie) => /name="csrf" value="([^"]+)"/.exec((await get('/setup', c)).body)![1]!;
  const dockToken = async () => /\/dock#([^<]+)</.exec((await get('/setup')).body)![1]!;
  return { x: s, cookie, channel, get, post, csrf, dockToken };
}

describe('setup page (spec 2b §4.4)', () => {
  it('/setup without a session redirects to /signup', async () => {
    const { get } = await signedIn();
    const res = await get('/setup', null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/signup');
  }, T);

  it('/setup shows both URLs with tokens in the fragment, the connect line and the install link', async () => {
    const { x, get, channel } = await signedIn();
    const res = await get('/setup');
    expect(res.statusCode).toBe(200);
    const dockToken = /\/dock#([^<]+)</.exec(res.body)![1]!;
    const overlayToken = /\/overlay#([^<]+)</.exec(res.body)![1]!;
    expect(dockToken).toHaveLength(43);
    expect(res.body).toContain(`https://dndm.example/dock#${dockToken}`);
    expect(res.body).toContain(`https://dndm.example/overlay#${overlayToken}`);
    expect(res.body).toContain(`dndm connect https://dndm.example --channel ${channel.id} --dock ${dockToken}`);
    expect(res.body).toContain(`dashboard.twitch.tv/extensions/${x.fake.clientId}`);
    expect(res.body).toContain('Install the extension');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  }, T);

  it('after a DNDM_SECRET rotation /setup still renders and regenerate recovers the URL', async () => {
    const { x, post, channel } = await signedIn();
    const oldBody = (await x.srv.app.inject({ url: '/setup', headers: { cookie: sessionCookie(await signIn(x)) } })).body;
    const oldDock = /\/dock#([^<]+)</.exec(oldBody)![1]!;
    await x.restart('a-completely-different-secret-value');
    const cookie = sessionCookie(await signIn(x));
    const res = await x.srv.app.inject({ url: '/setup', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("This URL can&#39;t be shown because the server&#39;s key changed. Regenerate it.");
    expect(res.body).not.toContain(oldDock);
    expect(res.body).toContain('Regenerate dock URL');
    expect(res.body).toContain('Regenerate overlay URL');
    expect(res.body).toContain('Sign out');
    expect(res.body).not.toContain('dndm connect');
    const csrf = /name="csrf" value="([^"]+)"/.exec(res.body)![1]!;
    const regen = await post('/setup/regenerate', `which=dock&csrf=${encodeURIComponent(csrf)}`, cookie);
    expect(regen.statusCode).toBe(303);
    const after = (await x.srv.app.inject({ url: '/setup', headers: { cookie } })).body;
    const newDock = /\/dock#([^<]+)</.exec(after)![1]!;
    expect(newDock).not.toBe(oldDock);
    expect(after).toContain(`dndm connect https://dndm.example --channel ${channel.id} --dock ${newDock}`);
  }, T);

  it('a session for a channel whose twitch_id changed is sent back to /signup', async () => {
    const { x, get, channel } = await signedIn();
    await x.srv.store.sql`update channels set twitch_id = '78' where id = ${channel.id}`;
    const res = await get('/setup');
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/signup');
    expect(setCookies(res).find((c) => c.startsWith('dndm_session='))).toContain('Max-Age=0');
  }, T);

  it('a display name with HTML is shown as text', async () => {
    const { get } = await signedIn('<b>Bo & Co</b>');
    expect((await get('/setup')).body).toContain('&lt;b&gt;Bo &amp; Co&lt;/b&gt;');
  }, T);

  it('CSRF is required on regenerate', async () => {
    const { x, post, dockToken, csrf } = await signedIn();
    const before = await dockToken();
    expect((await post('/setup/regenerate', 'which=dock')).statusCode).toBe(403);
    expect((await post('/setup/regenerate', 'which=dock&csrf=nope')).statusCode).toBe(403);
    // Another account's token does not work either.
    x.fake.addUser({ id: '88', login: 'other', displayName: 'Other' });
    await x.srv.store.allow('88', 'other');
    const otherCookie = sessionCookie(await signIn(x, '88'));
    expect((await post('/setup/regenerate', `which=dock&csrf=${encodeURIComponent(await csrf(otherCookie))}`)).statusCode).toBe(403);
    expect(await dockToken()).toBe(before);
  }, T);

  it('regenerate gives a new dock URL and closes open dock WebSockets', async () => {
    const { x, post, csrf, dockToken } = await signedIn();
    const old = await dockToken();
    const ws = await x.srv.app.injectWS(`/channels/${(await x.srv.store.channelByTwitchId('77'))!.id}/live`);
    const welcome = new Promise<void>((resolve) => ws.on('message', () => resolve()));
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.send(JSON.stringify({ type: 'hello', token: old }));
    await welcome;

    const res = await post('/setup/regenerate', `which=dock&csrf=${encodeURIComponent(await csrf())}`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/setup');
    expect(await dockToken()).not.toBe(old);
    expect(await closed).toBe(WS_CLOSE.revoked);
  }, T);

  it('regenerate overlay changes only the overlay URL', async () => {
    const { get, post, csrf, dockToken } = await signedIn();
    const dock = await dockToken();
    const overlay = /\/overlay#([^<]+)</.exec((await get('/setup')).body)![1]!;
    expect((await post('/setup/regenerate', `which=overlay&csrf=${encodeURIComponent(await csrf())}`)).statusCode).toBe(303);
    expect(await dockToken()).toBe(dock);
    expect(/\/overlay#([^<]+)</.exec((await get('/setup')).body)![1]).not.toBe(overlay);
  }, T);

  it('sign out clears the cookie', async () => {
    const { post, csrf } = await signedIn();
    expect((await post('/signout', '')).statusCode).toBe(403);
    const res = await post('/signout', `csrf=${encodeURIComponent(await csrf())}`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/signup');
    const cookie = setCookies(res).find((c) => c.startsWith('dndm_session='))!;
    expect(cookie).toMatch(/^dndm_session=;/);
    expect(cookie).toContain('Max-Age=0');
  }, T);

  it('/dock and /overlay answer the Project 3 placeholder', async () => {
    const { get } = await signedIn();
    for (const url of ['/dock', '/overlay']) {
      const res = await get(url, null);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Project 3');
    }
  }, T);

  it('2a routes still answer 415 to a url-encoded body', async () => {
    const { x, channel } = await signedIn();
    const res = await x.srv.app.inject({
      method: 'POST', url: `/channels/${channel.id}/commands`, payload: 'id=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(415);
  }, T);
});
