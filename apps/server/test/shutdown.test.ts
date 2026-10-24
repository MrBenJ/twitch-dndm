import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock';
import { Secrets } from '../src/crypto';
import { createChannel, defaultConfig, officialBundles, startServer } from '../src/server';
import { Store } from '../src/store';
import { freshDb } from './helpers/db';
import { SECRET } from './helpers/room';

let t: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => { t = await freshDb(); });
afterEach(async () => { await t.drop(); });

describe('shutdown', () => {
  it('a command waiting in a Room queue when close() starts is still saved', async () => {
    const seed = Store.open(t.url);
    const c = await createChannel({ store: seed, secrets: new Secrets(SECRET), bundles: await officialBundles(), name: 'test', config: defaultConfig(), seed: 1 });
    await seed.close();
    const srv = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0), rateLimits: false });
    const room = (await srv.manager.get(c.id))!;
    const pending = room.command({ role: 'dock' }, 'r1', { type: 'openSession' });
    await srv.close();
    expect((await pending).ok).toBe(true);
    const store = Store.open(t.url);
    expect((await store.room(c.id))!.session).not.toBeNull();
    await store.close();
  });
});
