import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock';
import { Secrets } from '../src/crypto';
import { createChannel, defaultConfig, officialBundles, type RunningServer, startServer } from '../src/server';
import { Store } from '../src/store';
import { freshDb } from './helpers/db';
import { SECRET } from './helpers/room';

let t: Awaited<ReturnType<typeof freshDb>>;
let running: RunningServer[] = [];
beforeEach(async () => { t = await freshDb(); running = []; });
afterEach(async () => { for (const r of running) await r.close().catch(() => {}); await t.drop(); });

async function start(clock: FakeClock) {
  const r = await startServer({ databaseUrl: t.url, secret: SECRET, dev: true, clock, rateLimits: false });
  running.push(r);
  return r;
}

async function made() {
  const store = Store.open(t.url);
  const c = await createChannel({ store, secrets: new Secrets(SECRET), bundles: await officialBundles(), name: 'test', config: defaultConfig(), seed: 1 });
  await store.close();
  return c;
}

describe('startServer (spec 2a §6.4, §6.6)', () => {
  it('refuses to start a second server against the same database', async () => {
    await start(new FakeClock(0));
    await expect(startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0) })).rejects.toThrow(/already running/);
  });

  it('resumes a fight after a restart (success criterion 3)', async () => {
    const c = await made();
    const clock = new FakeClock(1_000_000);
    const a = await start(clock);
    const post = (srv: RunningServer, token: string, id: string, command: Record<string, unknown>) =>
      srv.app.inject({ method: 'POST', url: `/channels/${c.id}/commands`, payload: { id, command }, headers: { authorization: `Bearer ${token}` } });
    await post(a, c.dockToken, '1', { type: 'openSession' });
    const al = (await a.app.inject({ method: 'POST', url: '/dev/login', payload: { channel: c.id, viewer: 'al' } })).json().token;
    await post(a, al, '2', { type: 'join', name: 'Al', pick: 'starter:sword' });
    await post(a, c.dockToken, '3', { type: 'spawnMonster', monster: 'starter:slime' });
    await post(a, al, '4', { type: 'use', ability: 'starter:attack' });
    const before = (await a.app.inject({ method: 'GET', url: `/channels/${c.id}/view`, headers: { authorization: `Bearer ${c.dockToken}` } })).json().view;
    await a.close();
    running = running.filter((r) => r !== a);

    await clock.advance(60_000);
    const b = await start(clock);
    expect(b.manager.rooms().map((r) => r.channel.id)).toEqual([c.id]);
    const after = (await b.app.inject({ method: 'GET', url: `/channels/${c.id}/view`, headers: { authorization: `Bearer ${c.dockToken}` } })).json().view;
    expect(after.phase).toBe('fight');
    expect(after.fight.monster.hp).toBe(before.fight.monster.hp);
    expect(after.party).toEqual(before.party);
    expect(after.fight.nextTurnAt).toBe(clock.now() + 15_000);
  });
});
