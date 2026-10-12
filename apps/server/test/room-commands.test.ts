import { afterEach, describe, expect, it } from 'vitest';
import { roomSetup } from './helpers/room';

let s: Awaited<ReturnType<typeof roomSetup>>;
afterEach(async () => { await s.done(); });

const join = (pick = 'starter:sword') => ({ type: 'join', name: 'Al', pick });

describe('Room commands (spec 2a §4.1, §6.1)', () => {
  it('runs a command, saves it, then answers and publishes', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    const a = await s.cmd(s.v('al'), join());
    expect(a).toMatchObject({ ok: true, events: [{ type: 'core:joined', data: { character: 'dev:al' } }] });
    expect((await s.store.characters(s.made.id, ['dev:al']))[0]!.name).toBe('Al');
    expect((await s.store.room(s.made.id))!.session!.party).toEqual(['dev:al']);
    expect(s.events().map((e) => e.type)).toEqual(['core:session-opened', 'core:joined']);
  });

  it('a viewer always acts as themselves and only sends viewer commands', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    const a = await s.cmd(s.v('al'), { ...join(), character: 'dev:bo' });
    expect(a.ok && a.events[0]!.data).toEqual({ character: 'dev:al' });
    expect(await s.cmd(s.v('al'), { type: 'giveGold', target: 'dev:al', amount: 99 })).toMatchObject({ ok: false, error: { code: 'streamer-only' } });
    expect(await s.cmd(s.overlay, { type: 'openSession' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('engine rejections are answers, saved nothing and published nothing', async () => {
    s = await roomSetup();
    const before = await s.store.room(s.made.id);
    expect(await s.cmd(s.v('al'), join())).toMatchObject({ ok: false, error: { code: 'no-session' } });
    expect(await s.store.room(s.made.id)).toEqual(before);
    expect(s.out).toEqual([]);
  });

  it('runs commands one at a time, in order', async () => {
    s = await roomSetup();
    const [a, b] = await Promise.all([s.cmd(s.dock, { type: 'openSession' }), s.cmd(s.v('al'), join())]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('a repeated request ID returns the first answer, even after a restart', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    await s.cmd(s.v('al'), join());
    const give = { type: 'giveGold', target: 'dev:al', amount: 5 };
    const first = await s.cmd(s.dock, give, 'gift-1');
    expect(await s.cmd(s.dock, give, 'gift-1')).toEqual(first);
    await s.reload();
    expect(await s.cmd(s.dock, give, 'gift-1')).toEqual(first);
    expect((await s.store.characters(s.made.id, ['dev:al']))[0]!.gold).toBe(5);
    await s.advance(5 * 60_000);
    await s.cmd(s.dock, give, 'gift-1');
    expect((await s.store.characters(s.made.id, ['dev:al']))[0]!.gold).toBe(10);
  });

  it('a repeated ID for a rejected command runs it again', async () => {
    s = await roomSetup();
    expect((await s.cmd(s.dock, { type: 'closeSession' }, 'x')).ok).toBe(false);
    await s.cmd(s.dock, { type: 'openSession' });
    expect((await s.cmd(s.dock, { type: 'closeSession' }, 'x')).ok).toBe(true);
  });

  it('request IDs belong to their sender', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    expect((await s.cmd(s.v('al'), join(), 'same')).ok).toBe(true);
    expect((await s.cmd(s.v('bo'), { ...join(), name: 'Bo' }, 'same')).ok).toBe(true);
    expect(s.room.game.session!.party).toEqual(['dev:al', 'dev:bo']);
  });

  it('a failed save keeps the old state and tells the sender', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    const real = s.store.saveInput.bind(s.store);
    s.store.saveInput = async () => { throw new Error('database down'); };
    const before = s.out.length;
    expect(await s.cmd(s.v('al'), join())).toMatchObject({ ok: false, error: { code: 'save-failed' } });
    expect(s.room.game.session!.party).toEqual([]);
    expect(s.out.length).toBe(before);
    s.store.saveInput = real;
    expect((await s.cmd(s.v('al'), join())).ok).toBe(true);
  });

  it('loads a saved character before a command that names them', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    await s.cmd(s.v('al'), join());
    await s.cmd(s.dock, { type: 'giveGold', target: 'dev:al', amount: 7 });
    await s.cmd(s.v('al'), { type: 'leave' });
    await s.reload();
    expect(s.room.game.characters['dev:al']).toBeUndefined();
    expect((await s.cmd(s.dock, { type: 'giveGold', target: 'dev:al', amount: 1 })).ok).toBe(true);
    expect(s.room.game.characters['dev:al']!.gold).toBe(8);
  });
});
