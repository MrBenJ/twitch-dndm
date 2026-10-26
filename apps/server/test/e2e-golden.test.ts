import { parseDuration } from '@dndm/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock';
import { Secrets } from '../src/crypto';
import { createChannel, defaultConfig, officialBundles, type RunningServer, startServer } from '../src/server';
import { Store } from '../src/store';
import { freshDb } from './helpers/db';
import { direct, type Line, type Out, read, scripts, toId, unprefix } from './helpers/golden';
import { SECRET } from './helpers/room';

const toDev = (c: Record<string, unknown>) => toId(c, 'dev:');
const undev = (v: unknown) => unprefix(v, 'dev:');

let t: Awaited<ReturnType<typeof freshDb>>;
let srv: RunningServer;
beforeEach(async () => { t = await freshDb(); });
afterEach(async () => { await srv?.close(); await t.drop(); });

async function viaServer(lines: Line[]): Promise<Out[]> {
  const store = Store.open(t.url);
  const c = await createChannel({ store, secrets: new Secrets(SECRET), bundles: await officialBundles(), name: 'golden', config: defaultConfig(), seed: 1 });
  await store.close();
  const clock = new FakeClock(0);
  srv = await startServer({ databaseUrl: t.url, secret: SECRET, dev: true, clock, rateLimits: false });
  const room = (await srv.manager.get(c.id))!;
  const out: Out[] = [];
  room.subscribe((o) => { if (o.type === 'events') out.push(...o.events); });
  const tokens = new Map<string, string>([['streamer', c.dockToken]]);
  let n = 0;
  const settle = () => srv.manager.idle();
  for (const l of lines) {
    if ('wait' in l) { await clock.advance(parseDuration(l.wait), settle); continue; }
    if ('next' in l) { const at = room.nextWake(); if (at !== null) await clock.advanceTo(Math.max(clock.now(), at), settle); continue; }
    if (!tokens.has(l.as)) {
      const r = await srv.app.inject({ method: 'POST', url: '/dev/login', payload: { channel: c.id, viewer: l.as } });
      tokens.set(l.as, r.json().token);
    }
    const { character: _drop, ...command } = l.command;
    const r = await srv.app.inject({
      method: 'POST', url: `/channels/${c.id}/commands`,
      payload: { id: `g${++n}`, command: toDev(l.as === 'streamer' ? l.command : command) },
      headers: { authorization: `Bearer ${tokens.get(l.as)}` },
    });
    const body = r.json();
    if (!body.ok) out.push({ rejected: body.error.code });
  }
  return undev(out) as Out[];
}

describe('end to end (success criterion 2)', () => {
  it.each(scripts)('%s gives the same events through the server', async (name) => {
    const lines = read(name);
    expect(await viaServer(lines)).toEqual(await direct(lines));
  });
});
