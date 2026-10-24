import { parseDuration } from '@dndm/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { direct, type Line, type Out, read, scripts, toId, unprefix } from './helpers/golden';
import { twitchSetup } from './helpers/twitch';

const T = 60_000; // per-test timeout, so a hang fails fast

type Setup = Awaited<ReturnType<typeof twitchSetup>>;
let s: Setup | null = null;
afterEach(async () => { await s?.close(); s = null; });

async function setup(): Promise<Setup> {
  s = await twitchSetup({ serverOpts: { rateLimits: false }, startAt: 0 }); // channel: seed 1, defaultConfig(); clock at 0 like dndm run
  return s;
}

/** Each viewer's Twitch user ID is their script name; their display name is the name their join line uses. */
function addViewers(x: Setup, lines: Line[]): void {
  const names = new Map<string, string>();
  for (const l of lines) {
    if (!('as' in l) || l.as === 'streamer') continue;
    if (!names.has(l.as)) names.set(l.as, l.as);
    if (l.command.type === 'join' && typeof l.command.name === 'string') names.set(l.as, l.command.name);
  }
  for (const [id, displayName] of names) x.fake.addUser({ id, login: id, displayName });
}

/** The script through the dock (streamer lines) and /ext (viewer lines), collecting what the room emits. */
async function viaExt(lines: Line[]): Promise<Out[]> {
  const x = await setup();
  addViewers(x, lines);
  const room = (await x.srv.manager.get(x.channelId))!;
  const out: Out[] = [];
  room.subscribe((o) => { if (o.type === 'events') out.push(...o.events); });
  let n = 0;
  for (const l of lines) {
    if ('wait' in l) { await x.advance(parseDuration(l.wait)); continue; }
    if ('next' in l) {
      const at = room.nextWake();
      if (at !== null) await x.advance(Math.max(0, at - x.clock.now()));
      continue;
    }
    if (l.as === 'streamer') {
      const a = await x.dock(toId(l.command, 'twitch:') as typeof l.command);
      if (!a.ok) out.push({ rejected: a.error.code });
      continue;
    }
    const { character: _drop, ...command } = l.command;
    const r = await x.ext('POST', '/ext/commands', { jwt: x.jwt({ user: l.as }), body: { id: `g${++n}`, command: toId(command, 'twitch:') } });
    const body = r.json();
    if (!body.ok) out.push({ rejected: body.error.code });
  }
  return unprefix(out, 'twitch:') as Out[];
}

describe.each(scripts)('extension golden script %s (criterion 2)', (name) => {
  it('gives the same events as dndm run', async () => {
    expect(await viaExt(read(name))).toEqual(await direct(read(name)));
  }, T);
});

describe('criterion 1', () => {
  it('read, join, fight and see state change through /ext and snapshots', async () => {
    const x = await setup();
    x.fake.addUser({ id: '42', login: 'viewer42', displayName: 'Viewer42' });
    expect((await x.dock({ type: 'openSession' })).ok).toBe(true);
    const j = x.jwt({ user: '42' });
    const key = x.srv.layer!.keyOf(x.channelId, 'twitch:42');

    const view = await x.ext('GET', '/ext/view', { jwt: j });
    expect(view.json()).toMatchObject({ ok: true, key, view: { character: null } });

    const joined = await x.ext('POST', '/ext/commands', { jwt: j, body: { id: 'c1', command: { type: 'join', pick: 'starter:sword' } } });
    expect(joined.json()).toMatchObject({ ok: true, view: { character: { inParty: true, name: 'Viewer42' } } });
    expect(joined.json().view.phase).toBe('resting');

    expect((await x.dock({ type: 'spawnMonster', monster: 'starter:goblin-king' })).ok).toBe(true);
    const afterSpawn = await x.ext('GET', '/ext/view', { jwt: j });
    const fight = afterSpawn.json().view.fight;
    expect(afterSpawn.json().view.phase).toBe('fight');
    expect(fight.monster.hp).toBe(fight.monster.maxHp);

    const attack = await x.ext('POST', '/ext/commands', { jwt: j, body: { id: 'c2', command: { type: 'use', ability: 'starter:attack' } } });
    expect(attack.json().ok).toBe(true);
    expect(attack.json().view.fight.monster.hp).toBeLessThan(fight.monster.maxHp); // their attack changed the monster

    await x.advance(2000); // the first snapshot goes out (a full refresh)
    await x.advance(10_000); // the attack's cooldown passes
    const again = await x.ext('POST', '/ext/commands', { jwt: j, body: { id: 'c3', command: { type: 'use', ability: 'starter:attack' } } });
    expect(again.json().ok).toBe(true);
    await x.advance(2000); // a later snapshot names the viewer in ch, so their client refetches
    const snaps = x.snapshots();
    expect(snaps.length).toBeGreaterThan(0);
    const mine = snaps.filter((m) => m.ch?.includes(key));
    expect(mine.length).toBeGreaterThan(0); // a snapshot sent to the fake Twitch whose ch holds their key
    expect(snaps.some((m) => m.f)).toBe(true); // and the fight reached the topic
  }, T);
});
