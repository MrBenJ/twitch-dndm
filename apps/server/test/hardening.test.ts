import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { RateLimiter } from '../src/auth';
import { FakeClock } from '../src/clock';
import { Hub } from '../src/hub';
import type { Room } from '../src/room';
import { RoomManager } from '../src/room-manager';
import { type RunningServer, startServer } from '../src/server';
import { freshDb } from './helpers/db';
import { roomSetup, SECRET } from './helpers/room';

let s: Awaited<ReturnType<typeof roomSetup>>;
let app: FastifyInstance;
let manager: RoomManager;
let hub: Hub;
let limiter: RateLimiter;
afterEach(async () => { await app?.close(); manager?.close(); await s?.done(); });

async function setup() {
  s = await roomSetup();
  s.room.close();
  manager = new RoomManager(s.deps);
  hub = new Hub();
  limiter = new RateLimiter(s.clock, false);
  app = await buildApp({ manager, hub, secrets: s.secrets, limiter, dev: true });
  await app.ready();
}

const closeCode = (ws: { on(e: 'close', fn: (code: number) => void): unknown }) => new Promise<number>((r) => ws.on('close', (c) => r(c)));
const hello = (token: string) => JSON.stringify({ type: 'hello', token });

describe('final review fixes', () => {
  it('#1 a WebSocket hello while the database is down closes that socket, not the server', async () => {
    await setup();
    manager.get = async () => { throw new Error('db down'); };
    const ws = await app.injectWS(`/channels/${s.made.id}/live`);
    const code = closeCode(ws);
    ws.send(hello(s.made.overlayToken));
    expect(await code).toBe(1011);
  });

  it('#2a a socket that closes while its Room loads is never added to the Hub', async () => {
    await setup();
    const real = manager.get.bind(manager);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    manager.get = async (id) => { await gate; return real(id); };
    const ws = await app.injectWS(`/channels/${s.made.id}/live`);
    ws.send(hello(s.made.overlayToken));
    await new Promise((r) => setTimeout(r, 20));
    ws.terminate();
    await new Promise((r) => setTimeout(r, 20));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.connections()).toBe(0);
  });

  it('#2b unwatching before a queued watch runs leaves nobody watching', async () => {
    s = await roomSetup();
    const p = s.room.watch('dev:al');
    s.room.unwatch('dev:al');
    await p;
    expect(s.room.watchCount()).toBe(0);
  });

  it('#3 a closed Room refuses inputs, and the server retries on a fresh Room', async () => {
    await setup();
    const stale = (await manager.get(s.made.id))!;
    stale.close();
    await expect(stale.command({ role: 'dock' }, 'x', { type: 'openSession' })).rejects.toThrow(/closed/);
    const real = manager.get.bind(manager);
    let first = true;
    manager.get = async (id) => { if (first) { first = false; return stale as Room; } return real(id); };
    const r = await app.inject({
      method: 'POST', url: `/channels/${s.made.id}/commands`, payload: { id: 'a', command: { type: 'openSession' } },
      headers: { authorization: `Bearer ${s.made.dockToken}` },
    });
    expect(r.json()).toMatchObject({ ok: true });
  });

  it('reloads a Room closed after authentication before serving a view', async () => {
    await setup();
    const loaded = (await manager.get(s.made.id))!;
    const take = limiter.take.bind(limiter);
    limiter.take = (role, key) => {
      loaded.close();
      return take(role, key);
    };
    const r = await app.inject({
      method: 'GET', url: `/channels/${s.made.id}/view`,
      headers: { authorization: `Bearer ${s.made.dockToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, view: { phase: 'closed' } });
  });

  it('a closed Room refuses read-only commands', async () => {
    s = await roomSetup();
    s.room.close();
    await expect(s.room.command(s.dock, 'config', { type: 'getConfig' })).rejects.toThrow(/closed/);
  });

  it('#10 an oversized hello is refused', async () => {
    await setup();
    const ws = await app.injectWS(`/channels/${s.made.id}/live`);
    const code = closeCode(ws);
    ws.send(JSON.stringify({ type: 'hello', token: 'x'.repeat(200_000) }));
    expect(await code).toBe(1009);
  });
});

describe('#12 boot', () => {
  let t: Awaited<ReturnType<typeof freshDb>>;
  let srv: RunningServer | null = null;
  afterEach(async () => { await srv?.close(); await t.drop(); });

  it('one Room that fails to load does not stop the others', async () => {
    s = undefined as never;
    t = await freshDb();
    const room = { stateVersion: 1, clock: 0, rng: 1, seq: 0, session: { party: [], encounter: null, adventure: null }, recentRequests: [] };
    const { Store } = await import('../src/store');
    const store = Store.open(t.url);
    const good = await store.createChannel({ name: 'good', config: { packs: [] }, room, dock: { hash: 'h1', enc: 'e1' }, overlay: { hash: 'h2', enc: 'e2' } });
    const bad = await store.createChannel({ name: 'bad', config: { packs: [] }, room: { ...room, stateVersion: 99 }, dock: { hash: 'h3', enc: 'e3' }, overlay: { hash: 'h4', enc: 'e4' } });
    await store.close();
    const logs: string[] = [];
    srv = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0), log: (m, x) => logs.push(`${m} ${JSON.stringify(x)}`) });
    expect(srv.manager.rooms().map((r) => r.channel.id)).toEqual([good]);
    expect(logs.join('\n')).toContain(bad);
  });
});
