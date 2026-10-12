import { PassThrough, Readable } from 'node:stream';
import { createChannel, defaultConfig, officialBundles, type RunningServer, Secrets, startServer, Store } from '@dndm/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/main';
import { freshDb } from '../../server/test/helpers/db';

const SECRET = 'cli-test-secret-0123456789';
let t: Awaited<ReturnType<typeof freshDb>>;
let srv: RunningServer;
let made: { id: string; dockToken: string };
beforeAll(async () => {
  t = await freshDb();
  const store = Store.open(t.url);
  made = await createChannel({ store, secrets: new Secrets(SECRET), bundles: await officialBundles(), name: 'c', config: defaultConfig(), seed: 1 });
  await store.close();
  srv = await startServer({ databaseUrl: t.url, secret: SECRET, dev: true, port: 0 });
});
afterAll(async () => { await srv.close(); await t.drop(); });

describe('interactive dndm connect', () => {
  it('takes play-style commands, shows state and refuses stepped time', async () => {
    const stdout = new PassThrough();
    let out = '';
    stdout.on('data', (c) => { out += String(c); });
    const stdin = Readable.from(['open\n', 'join al sword\n', 'wait 5s\n', 'pause 0.1s\n', 'state\n', 'view al\n', 'quit\n']);
    const code = await main(['connect', srv.url, '--channel', made.id, '--dock', made.dockToken], { stdout, stdin });
    expect(code).toBe(0);
    expect(out).toContain('A new session begins');
    expect(out).toContain('al joins the party');
    expect(out).toMatch(/pause/);
    expect(out).toContain('Phase: resting');
  });
});
