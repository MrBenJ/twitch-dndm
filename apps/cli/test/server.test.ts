import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Store, type TwitchClient } from '@dndm/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/main';
import { freshDb } from '../../server/test/helpers/db';

let t: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => { t = await freshDb(); });
afterAll(async () => { await t.drop(); });

const SECRET = 'cli-test-secret-0123456789';

async function cli(argv: string[], env: Record<string, string | undefined> = { DATABASE_URL: t.url, DNDM_SECRET: SECRET }) {
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (c) => { out += String(c); });
  const code = await main(argv, { stdout, stdin: Readable.from([]), env });
  return { code, out, lines: out.trim().split('\n') };
}

describe('dndm server (spec 2a §8.1)', () => {
  it('migrate is safe to run again', async () => {
    expect((await cli(['server', 'migrate'])).code).toBe(0);
  });

  it('create-channel prints the channel and its tokens', async () => {
    const r = await cli(['server', 'create-channel', 'dj_teknal', '--json', '--seed', '3']);
    expect(r.code).toBe(0);
    const made = JSON.parse(r.lines.at(-1)!);
    expect(made).toMatchObject({ kind: 'channel', name: 'dj_teknal', id: expect.any(String), dockToken: expect.any(String), overlayToken: expect.any(String) });
    const store = Store.open(t.url);
    expect((await store.channel(made.id))!.name).toBe('dj_teknal');
    await store.close();
  });

  it('create-channel refuses a config with errors and creates nothing', async () => {
    const file = join(tmpdir(), `dndm-bad-${process.pid}.yaml`);
    writeFileSync(file, 'packs: [nope]\n');
    const r = await cli(['server', 'create-channel', 'broken', '--config', file]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/nope/);
  });

  it('needs DATABASE_URL and a long enough DNDM_SECRET', async () => {
    expect(await cli(['server', 'migrate'], { DNDM_SECRET: SECRET })).toMatchObject({ code: 2, out: expect.stringContaining('set DATABASE_URL') });
    expect(await cli(['server', 'create-channel', 'x'], { DATABASE_URL: t.url, DNDM_SECRET: 'short' })).toMatchObject({ code: 2, out: expect.stringContaining('DNDM_SECRET') });
  });

  it('start listens and prints where', async () => {
    const stdout = new PassThrough();
    let out = '';
    stdout.on('data', (c) => { out += String(c); });
    const code = await main(['server', 'start', '--port', '0'], {
      stdout, stdin: Readable.from([]), env: { DATABASE_URL: t.url, DNDM_SECRET: SECRET, DNDM_DEV: '1' }, until: Promise.resolve(),
    });
    expect(code).toBe(0);
    expect(out).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+ \(dev login on\)/);
  });

  it('start with a partly configured Twitch refuses and names what is missing', async () => {
    const r = await cli(['server', 'start', '--port', '0'], { DATABASE_URL: t.url, DNDM_SECRET: SECRET, TWITCH_CLIENT_ID: 'x' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('Twitch is partly configured; missing: DNDM_PUBLIC_URL, TWITCH_CLIENT_SECRET, TWITCH_EXTENSION_SECRET, TWITCH_OWNER_ID');
  });

  it('start warns when DNDM_DEV=1 meets a full Twitch config', async () => {
    const stdout = new PassThrough();
    let out = '';
    stdout.on('data', (c) => { out += String(c); });
    const code = await main(['server', 'start', '--port', '0'], {
      stdout, stdin: Readable.from([]), until: Promise.resolve(),
      env: {
        DATABASE_URL: t.url, DNDM_SECRET: SECRET, DNDM_DEV: '1', TWITCH_CLIENT_ID: 'c', TWITCH_CLIENT_SECRET: 's',
        TWITCH_EXTENSION_SECRET: Buffer.alloc(32, 1).toString('base64'), TWITCH_OWNER_ID: '1', DNDM_PUBLIC_URL: 'https://x.example',
      },
    });
    expect(code).toBe(0);
    expect(out).toContain('DNDM_DEV=1 with Twitch configured');
  });

  describe('allowlist', () => {
    const user = { id: '42', login: 'streamer', displayName: 'Streamer' };
    const TW = { DATABASE_URL: '', DNDM_SECRET: SECRET, TWITCH_CLIENT_ID: 'c', TWITCH_CLIENT_SECRET: 's' };
    const fake = (): TwitchClient => ({
      usersByLogin: async (logins: string[]) => (logins.includes(user.login) ? [{ ...user }] : []),
    }) as unknown as TwitchClient;
    async function run(argv: string[], twitchClient: TwitchClient | null = fake(), env: Record<string, string | undefined> = { ...TW, DATABASE_URL: t.url }) {
      const stdout = new PassThrough();
      let out = '';
      stdout.on('data', (c) => { out += String(c); });
      const code = await main(argv, { stdout, stdin: Readable.from([]), env, twitchClient: twitchClient ?? undefined });
      return { code, out };
    }
    const rows = async () => { const s = Store.open(t.url); try { return await s.allowlist(); } finally { await s.close(); } };

    it('allow resolves the login and adds it; an unknown login is an error', async () => {
      expect((await run(['server', 'allow', 'Streamer'])).code).toBe(0);
      expect(await rows()).toEqual([{ twitchId: '42', login: 'streamer', addedAt: expect.any(Date) }]);
      expect(await run(['server', 'allow', 'ghost'])).toMatchObject({ code: 2, out: expect.stringContaining('No Twitch account is called ghost') });
    });

    it('disallow falls back to the stored login when the login no longer resolves', async () => {
      await run(['server', 'allow', 'streamer']);
      user.login = 'renamed';
      try {
        expect((await run(['server', 'disallow', 'streamer'])).code).toBe(0);
      } finally { user.login = 'streamer'; }
      expect(await rows()).toEqual([]);
    });

    it('disallow by a login that resolves removes that ID', async () => {
      await run(['server', 'allow', 'streamer']);
      expect((await run(['server', 'disallow', 'streamer'])).code).toBe(0);
      expect(await rows()).toEqual([]);
    });

    it('disallow of a login that is not listed is an error', async () => {
      expect(await run(['server', 'disallow', 'ghost'])).toMatchObject({ code: 2, out: expect.stringContaining("ghost isn't on the allowlist") });
    });

    it('allowlist prints the entries', async () => {
      await run(['server', 'allow', 'streamer']);
      const r = await run(['server', 'allowlist']);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/streamer.*42/);
      await run(['server', 'disallow', 'streamer']);
    });

    it('allow without Twitch client settings explains what to set', async () => {
      const r = await run(['server', 'allow', 'streamer'], null, { DATABASE_URL: t.url, DNDM_SECRET: SECRET });
      expect(r.code).toBe(2);
      expect(r.out).toContain('TWITCH_CLIENT_ID');
      expect(r.out).toContain('TWITCH_CLIENT_SECRET');
    });
  });
});
