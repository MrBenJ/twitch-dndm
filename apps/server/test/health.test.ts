import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { RateLimiter } from '../src/auth';
import { FakeClock } from '../src/clock';
import { Hub } from '../src/hub';
import { RoomManager } from '../src/room-manager';
import { startServer } from '../src/server';
import { freshDb } from './helpers/db';
import { roomSetup, SECRET } from './helpers/room';

let t: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => { t = await freshDb(); });
afterEach(async () => { await t.drop(); });

describe('GET /health', () => {
  it('is 503 before boot finishes and 200 after', async () => {
    const s = await roomSetup();
    s.room.close();
    const manager = new RoomManager(s.deps);
    const health = { ready: false };
    const app: FastifyInstance = await buildApp({
      manager, hub: new Hub(), secrets: s.secrets, limiter: new RateLimiter(s.clock, true), dev: false, health,
    });
    expect((await app.inject('/health')).statusCode).toBe(503);
    expect((await app.inject('/health')).json()).toEqual({ ok: false });
    health.ready = true;
    const r = await app.inject('/health');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    await app.close();
    manager.close();
    await s.done();
  });

  it('a started server is healthy', async () => {
    const srv = await startServer({ databaseUrl: t.url, secret: SECRET, clock: new FakeClock(0) });
    expect((await srv.app.inject('/health')).statusCode).toBe(200);
    await srv.close();
  });
});
