import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Command, createEngine, type GameEvent, type GameState, parseDuration, VIEWER_COMMANDS } from '@dndm/engine';
import { repoRoot } from '@dndm/pack-loader';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock';
import { Secrets } from '../src/crypto';
import { createChannel, defaultConfig, officialBundles, type RunningServer, startServer } from '../src/server';
import { Store } from '../src/store';
import { freshDb } from './helpers/db';
import { SECRET } from './helpers/room';

type Line = { wait: string | number } | { next: true } | { as: string; command: Record<string, unknown> & { type: string } };
type Out = GameEvent | { rejected: string };

const DIR = join(repoRoot(), 'apps', 'cli', 'test', 'golden');
const scripts = readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort();
const read = (name: string): Line[] => readFileSync(join(DIR, name), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

/** What `dndm run` does (apps/cli/src/driver.ts), straight through the engine. */
async function direct(lines: Line[]): Promise<Out[]> {
  const engine = createEngine({ packs: await officialBundles(), channel: defaultConfig() });
  let game: GameState = engine.newGame({ seed: 1 });
  let now = 0;
  const out: Out[] = [];
  const advance = () => { const r = engine.advance(game, now); game = r.game; out.push(...r.events); };
  for (const l of lines) {
    if ('wait' in l) { now += parseDuration(l.wait); advance(); continue; }
    if ('next' in l) { const t = engine.nextWakeTime(game); if (t !== null) { now = Math.max(now, t); advance(); } continue; }
    if (l.as !== 'streamer' && !(VIEWER_COMMANDS as readonly string[]).includes(l.command.type)) { out.push({ rejected: 'streamer-only' }); continue; }
    const cmd = (l.as === 'streamer' ? l.command : { ...l.command, character: l.as }) as unknown as Command;
    const r = engine.apply(game, cmd, now);
    if (r.ok) { game = r.game; out.push(...r.events); } else out.push({ rejected: r.error.code });
  }
  return out;
}

/** A command that names a viewer's character (or targets one) names their server ID, `dev:<name>`. */
function toDev(c: Record<string, unknown>): Record<string, unknown> {
  const out = { ...c };
  if (typeof out.character === 'string') out.character = `dev:${out.character}`;
  if (typeof out.target === 'string' && out.target !== 'party') out.target = `dev:${out.target}`;
  const t = out.target as { kind?: string; id?: string } | undefined;
  if (t && typeof t === 'object' && t.kind === 'character') out.target = { ...t, id: `dev:${t.id}` };
  const chosen = out.chosen as { kind?: string; id?: string } | null | undefined;
  if (chosen && chosen.kind === 'character') out.chosen = { ...chosen, id: `dev:${chosen.id}` };
  return out;
}

/** Replaces every "dev:<name>" string with "<name>", anywhere in a value. */
function undev(v: unknown): unknown {
  if (typeof v === 'string') return v.startsWith('dev:') ? v.slice(4) : v;
  if (Array.isArray(v)) return v.map(undev);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, undev(x)]));
  return v;
}

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
