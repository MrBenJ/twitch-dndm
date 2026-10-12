import { afterEach, describe, expect, it } from 'vitest';
import { IDLE_CHARACTER, IDLE_ROOM } from '../src/room';
import { roomSetup } from './helpers/room';

let s: Awaited<ReturnType<typeof roomSetup>>;
afterEach(async () => { await s.done(); });

async function fight(names = ['al']) {
  await s.cmd(s.dock, { type: 'openSession' });
  for (const n of names) await s.cmd(s.v(n), { type: 'join', name: n, pick: 'starter:sword' });
  await s.cmd(s.dock, { type: 'spawnMonster', monster: 'starter:slime' });
}

describe('Room timers (spec 2a §6.1, §6.3)', () => {
  it('runs monster turns on time and saves them', async () => {
    s = await roomSetup();
    await fight();
    await s.advance(15_000);
    expect(s.events().some((e) => e.type === 'core:ability-used')).toBe(true);
    expect((await s.store.room(s.made.id))!.clock).toBe(15_000);
  });

  it('a failed save holds the events back and retries with backoff', async () => {
    s = await roomSetup();
    await fight();
    const real = s.store.saveInput.bind(s.store);
    const tries: number[] = [];
    s.store.saveInput = async () => { tries.push(s.clock.now()); throw new Error('down'); };
    const before = s.events().length;
    await s.advance(18_000);
    expect(tries).toEqual([15_000, 16_000, 18_000]);
    expect(s.events().length).toBe(before);
    s.store.saveInput = real;
    await s.advance(4_000);
    expect(s.events().slice(before).some((e) => e.type === 'core:ability-used')).toBe(true);
  });
});

describe('views and watching (spec 2a §5)', () => {
  it('sends the public view after every input and a viewer view only when it changed', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    const first = await s.room.watch('dev:al');
    expect(first.character).toBeNull();
    const from = s.out.length;
    await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
    await s.cmd(s.dock, { type: 'postMessage', text: 'hi' });
    const views = s.out.slice(from).filter((o) => o.type === 'views');
    expect(views).toHaveLength(2);
    expect(views.map((v) => v.type === 'views' && v.viewers.has('dev:al'))).toEqual([true, false]);
  });
});

describe('memory rules (spec 2a §6.2, §6.6)', () => {
  it('drops a character who left, after 10 idle minutes, but not while watched', async () => {
    s = await roomSetup();
    await fight(['al', 'bo']);
    await s.cmd(s.dock, { type: 'endEncounter' });
    await s.cmd(s.v('al'), { type: 'leave' });
    await s.cmd(s.v('bo'), { type: 'leave' });
    await s.room.watch('dev:bo');
    await s.advance(IDLE_CHARACTER);
    await s.room.sweep();
    expect(s.room.game.characters['dev:al']).toBeUndefined();
    expect(s.room.game.characters['dev:bo']).toBeDefined();
    s.room.unwatch('dev:bo');
    await s.room.sweep();
    expect(s.room.game.characters['dev:bo']).toBeUndefined();
  });

  it('keeps a knocked-out character who left until the knockout ends', async () => {
    s = await roomSetup({ settings: { 'knockout-duration': '20m' } });
    await fight();
    await s.cmd(s.dock, { type: 'knockOut', character: 'dev:al' });
    await s.cmd(s.dock, { type: 'endEncounter' });
    await s.cmd(s.v('al'), { type: 'leave' });
    await s.advance(IDLE_CHARACTER);
    await s.room.sweep();
    expect(s.room.game.characters['dev:al']).toBeDefined();
  });

  it('keeps a removed character during the session, and the flag clears at rest', async () => {
    s = await roomSetup();
    await fight(['al', 'bo']);
    await s.cmd(s.dock, { type: 'removePlayer', character: 'dev:al' });
    await s.advance(IDLE_CHARACTER);
    await s.room.sweep();
    expect(s.room.game.characters['dev:al']!.removedByStreamer).toBe(true);
    await s.cmd(s.dock, { type: 'endEncounter' });
    // Cleared at the rest; with nothing keeping them loaded any more, only the saved copy remains.
    expect((await s.store.characters(s.made.id, ['dev:al']))[0]!.removedByStreamer).toBe(false);
  });

  it('opening a session loads removed characters so the flag can clear', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
    await s.cmd(s.dock, { type: 'closeSession' });
    // A flag left set while no session is open (possible when the setting was off at the time).
    const [al] = await s.store.characters(s.made.id, ['dev:al']);
    await s.store.saveInput(s.made.id, (await s.store.room(s.made.id))!, [{ data: { ...al!, removedByStreamer: true }, wakeAt: null, removed: true }]);
    await s.reload();
    expect(s.room.game.characters['dev:al']).toBeUndefined();
    await s.cmd(s.dock, { type: 'openSession' });
    expect(s.room.game.characters['dev:al']!.removedByStreamer).toBe(false);
    expect((await s.store.characters(s.made.id, ['dev:al']))[0]!.removedByStreamer).toBe(false);
  });

  it('a Room can unload only when idle, sessionless, unwatched and without timers', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    await s.advance(IDLE_ROOM);
    expect(s.room.canUnload(s.clock.now())).toBe(false);
    await s.cmd(s.dock, { type: 'closeSession' });
    expect(s.room.canUnload(s.clock.now())).toBe(false);
    await s.advance(IDLE_ROOM);
    expect(s.room.canUnload(s.clock.now())).toBe(false); // the test helper still listens
  });
});
