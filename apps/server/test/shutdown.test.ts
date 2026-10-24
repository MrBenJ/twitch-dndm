import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock';
import { Secrets } from '../src/crypto';
import { createChannel, defaultConfig, officialBundles, startServer } from '../src/server';
import type { Room } from '../src/room';
import { Store } from '../src/store';
import { freshDb } from './helpers/db';
import { SECRET } from './helpers/room';

let t: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => { t = await freshDb(); });
afterEach(async () => { await t.drop(); });

async function channel() {
  const seed = Store.open(t.url);
  const c = await createChannel({ store: seed, secrets: new Secrets(SECRET), bundles: await officialBundles(), name: 'test', config: defaultConfig(), seed: 1 });
  await seed.close();
  return c;
}

/** Holds a Room's queue busy until the returned function is called. */
function hold(room: Room): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  void (room as unknown as { run(fn: () => Promise<void>): Promise<void> }).run(() => gate);
  return release;
}

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

  it('over real HTTP, a request in flight across close() completes and close() stays within the budget', async () => {
    const c = await channel();
    const srv = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0), rateLimits: false, port: 0, idleTimeoutMs: 10_000 });
    const room = (await srv.manager.get(c.id))!;
    const release = hold(room);
    const res = fetch(`${srv.url}/channels/${c.id}/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.dockToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'r1', command: { type: 'openSession' } }),
    });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = performance.now();
    const closed = srv.close();
    setTimeout(release, 300);
    await closed;
    const ms = performance.now() - t0;
    const r = await res;
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    // Without closing the kept-alive connection this took Fastify's keepAliveTimeout (~72 s).
    expect(ms).toBeLessThan(5_000);
  }, 20_000);

  it('when Rooms stay busy past idleTimeoutMs, close() gives up after about that long and logs it', async () => {
    const c = await channel();
    const logs: [string, Record<string, unknown> | undefined][] = [];
    const srv = await startServer({
      databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0), rateLimits: false, idleTimeoutMs: 300,
      log: (msg, extra) => { logs.push([msg, extra]); },
    });
    const release = hold((await srv.manager.get(c.id))!);
    const t0 = performance.now();
    await srv.close();
    const ms = performance.now() - t0;
    release();
    expect(ms).toBeGreaterThanOrEqual(290);
    expect(ms).toBeLessThan(2_000);
    expect(logs).toContainEqual(['shutdown: rooms still busy after idle timeout', { idleTimeoutMs: 300 }]);
  });

  it('a second close() is a no-op that returns the first call\'s promise', async () => {
    const srv = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0), rateLimits: false });
    const a = srv.close();
    expect(srv.close()).toBe(a);
    await a;
    await srv.close();
  });

  it('close() finishes even if the HTTP app never finishes closing', async () => {
    const srv = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0), rateLimits: false, idleTimeoutMs: 300 });
    const realClose = srv.app.close.bind(srv.app);
    (srv.app as { close: () => Promise<void> }).close = () => new Promise<void>(() => {});
    const t0 = performance.now();
    await srv.close();
    expect(performance.now() - t0).toBeLessThan(3_000);
    await realClose();
    const again = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0), rateLimits: false });
    await again.close();
  }, 10_000);

  it('the database is closed even if closing the HTTP app fails', async () => {
    const srv = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0), rateLimits: false });
    const realClose = srv.app.close.bind(srv.app);
    (srv.app as { close: () => Promise<void> }).close = () => Promise.reject(new Error('boom'));
    await expect(srv.close()).rejects.toThrow('boom');
    await realClose();
    // The advisory lock went with the store, so another server can start.
    const again = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0), rateLimits: false });
    await again.close();
  });
});
