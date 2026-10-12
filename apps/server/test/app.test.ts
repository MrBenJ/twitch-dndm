import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { RateLimiter } from '../src/auth';
import { Hub } from '../src/hub';
import { RoomManager } from '../src/room-manager';
import { roomSetup } from './helpers/room';

let s: Awaited<ReturnType<typeof roomSetup>>;
let app: FastifyInstance;
let manager: RoomManager;
afterEach(async () => { await app.close(); manager.close(); await s.done(); });

async function setup(opts: { dev?: boolean; limits?: boolean; helloTimeoutMs?: number } = {}) {
  s = await roomSetup();
  s.room.close();
  manager = new RoomManager(s.deps);
  app = await buildApp({
    manager, hub: new Hub(), secrets: s.secrets, limiter: new RateLimiter(s.clock, opts.limits ?? false),
    dev: opts.dev ?? true, helloTimeoutMs: opts.helloTimeoutMs,
  });
  await app.ready();
}

const post = (token: string | null, id: string, command: Record<string, unknown>, channel = s.made.id) =>
  app.inject({
    method: 'POST', url: `/channels/${channel}/commands`, payload: { id, command },
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
const login = async (viewer: string) => (await app.inject({ method: 'POST', url: '/dev/login', payload: { channel: s.made.id, viewer } })).json().token as string;

describe('HTTP API (spec 2a §4)', () => {
  it('runs dock and viewer commands with their tokens', async () => {
    await setup();
    expect((await post(s.made.dockToken, 'a', { type: 'openSession' })).json()).toMatchObject({ ok: true });
    const al = await login('Al');
    const r = await post(al, 'b', { type: 'join', name: 'Al', pick: 'starter:sword' });
    expect(r.statusCode).toBe(200);
    expect(r.json().events[0].data).toEqual({ character: 'dev:al' });
  });

  it('answers with stable codes and statuses', async () => {
    await setup();
    expect((await post(null, 'a', { type: 'openSession' })).statusCode).toBe(401);
    expect((await post('nope', 'a', { type: 'openSession' })).json().error.code).toBe('unauthorized');
    expect((await post(s.made.overlayToken, 'a', { type: 'openSession' })).statusCode).toBe(403);
    expect((await post(s.made.dockToken, 'a', { type: 'openSession' }, '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b')).statusCode).toBe(404);
    const bad = await app.inject({ method: 'POST', url: `/channels/${s.made.id}/commands`, payload: { command: {} }, headers: { authorization: `Bearer ${s.made.dockToken}` } });
    expect(bad.statusCode).toBe(400);
    const rejected = await post(s.made.dockToken, 'b', { type: 'closeSession' });
    expect([rejected.statusCode, rejected.json().error.code]).toEqual([200, 'no-session']);
  });

  it('a viewer token only works on its own channel', async () => {
    await setup();
    const al = await login('al');
    const other = await s.store.createChannel({
      name: 'x', config: { packs: [] }, room: { stateVersion: 1, clock: 0, rng: 1, seq: 0, session: null, recentRequests: [] },
      dock: { hash: 'hx', enc: 'ex' }, overlay: { hash: 'hy', enc: 'ey' },
    });
    expect((await post(al, 'a', { type: 'leave' }, other)).statusCode).toBe(403);
  });

  it('serves views and describe', async () => {
    await setup();
    const auth = { authorization: `Bearer ${s.made.overlayToken}` };
    expect((await app.inject({ method: 'GET', url: `/channels/${s.made.id}/view`, headers: auth })).json()).toMatchObject({ ok: true, view: { phase: 'closed' } });
    const d = (await app.inject({ method: 'GET', url: `/channels/${s.made.id}/describe`, headers: auth })).json();
    expect(d.describe.classes.length).toBeGreaterThan(0);
  });

  it('rate-limits per sender, counting reads too', async () => {
    await setup({ limits: true });
    const al = await login('al');
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await app.inject({ method: 'GET', url: `/channels/${s.made.id}/view`, headers: { authorization: `Bearer ${al}` } })).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await post(s.made.dockToken, 'x', { type: 'openSession' })).statusCode).toBe(200);
  });

  it('replays a regenerate answer to a retry with the old dock token', async () => {
    await setup();
    const first = (await post(s.made.dockToken, 'regen', { type: 'regenerateDockUrl' })).json();
    const retry = await post(s.made.dockToken, 'regen', { type: 'regenerateDockUrl' });
    expect(retry.json()).toEqual(first);
    expect((await post(s.made.dockToken, 'other', { type: 'openSession' })).statusCode).toBe(401);
    expect((await post(first.result.token, 'other', { type: 'openSession' })).statusCode).toBe(200);
  });

  it('has no dev login unless dev mode is on', async () => {
    await setup({ dev: false });
    expect((await app.inject({ method: 'POST', url: '/dev/login', payload: { channel: s.made.id, viewer: 'al' } })).statusCode).toBe(404);
  });
});

describe('WebSocket (spec 2a §5)', () => {
  it('welcomes after hello, then streams events', async () => {
    await setup();
    const ws = await app.injectWS(`/channels/${s.made.id}/live`);
    const got: { type: string }[] = [];
    const welcome = new Promise<void>((resolve) => ws.on('message', (raw) => { got.push(JSON.parse(String(raw))); if (got.length === 1) resolve(); }));
    ws.send(JSON.stringify({ type: 'hello', token: s.made.overlayToken }));
    await welcome;
    expect(got[0]).toMatchObject({ type: 'welcome', role: 'overlay' });
    await post(s.made.dockToken, 'a', { type: 'openSession' });
    await manager.idle();
    await new Promise((r) => setTimeout(r, 50));
    expect(got.map((m) => m.type)).toEqual(['welcome', 'events', 'view']);
    ws.terminate();
  });

  it('closes with 4401 on a bad hello or no hello', async () => {
    await setup({ helloTimeoutMs: 50 });
    const bad = await app.injectWS(`/channels/${s.made.id}/live`);
    const badCode = new Promise<number>((resolve) => bad.on('close', (code) => resolve(code)));
    bad.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
    expect(await badCode).toBe(4401);
    const silent = await app.injectWS(`/channels/${s.made.id}/live`);
    expect(await new Promise<number>((resolve) => silent.on('close', (code) => resolve(code)))).toBe(4401);
  });
});
