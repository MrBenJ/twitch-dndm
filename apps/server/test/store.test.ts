import { type Character, createEngine } from '@dndm/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RoomRow } from '../src/store';
import { freshDb } from './helpers/db';

let t: Awaited<ReturnType<typeof freshDb>>;
let store: Store;
beforeAll(async () => { t = await freshDb(); store = new Store(t.db, t.sql); });
afterAll(async () => { await store.close(); await t.drop(); });

const room = (over: Partial<RoomRow> = {}): RoomRow => ({ stateVersion: 1, clock: 0, rng: 7, seq: 0, session: null, recentRequests: [], ...over });
const tok = (s: string) => ({ hash: `h-${s}`, enc: `e-${s}` });
const ch = (id: string, over: Partial<Character> = {}): Character => ({
  id, name: id, level: 1, xp: 0, gold: 0, hp: 10, inventory: {}, equipped: {}, statuses: [], cooldowns: {}, usesLeft: {},
  knockedOutUntil: null, banned: false, removedByStreamer: false, stores: {}, ...over,
});
let n = 0;
const newChannel = () => {
  n += 1;
  return store.createChannel({ name: `c${n}`, config: { packs: ['starter'] }, room: room(), dock: tok(`d${n}`), overlay: tok(`o${n}`) });
};

describe('Store (spec 2a §3, §6)', () => {
  it('creates a channel with its room and finds it by token hash', async () => {
    const id = await newChannel();
    expect((await store.channel(id))!.configVersion).toBe(1);
    expect(await store.room(id)).toEqual(room());
    const found = await store.channelByTokenHash(`h-o${n}`);
    expect(found).toMatchObject({ role: 'overlay', channel: { id } });
    expect(await store.channelByTokenHash('nope')).toBeNull();
    expect(await store.channel('6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b')).toBeNull();
  });

  it('saves the room and changed characters in one go, keeping key order', async () => {
    const id = await newChannel();
    const al = ch('dev:al', { inventory: { 'starter:z': 1, 'starter:a': 2 } });
    await store.saveInput(id, room({ clock: 500, seq: 3, session: { party: ['dev:al'], encounter: null, adventure: null } }), [
      { data: al, wakeAt: null, removed: false },
    ]);
    expect((await store.room(id))!.clock).toBe(500);
    const [loaded] = await store.characters(id, ['dev:al', 'dev:nobody']);
    expect(Object.keys(loaded!.inventory)).toEqual(['starter:z', 'starter:a']);
    await store.saveInput(id, room({ clock: 600 }), [{ data: { ...al, gold: 9 }, wakeAt: null, removed: false }]);
    expect((await store.characters(id, ['dev:al']))[0]!.gold).toBe(9);
  });

  it('a failed save changes nothing', async () => {
    const id = await newChannel();
    const bad = { data: ch('dev:x'), wakeAt: Number.NaN, removed: false };
    await expect(store.saveInput(id, room({ clock: 999 }), [bad])).rejects.toThrow();
    expect((await store.room(id))!.clock).toBe(0);
    expect(await store.characters(id, ['dev:x'])).toEqual([]);
  });

  it("loads a room's characters: party, timers, and removed ones only when asked", async () => {
    const id = await newChannel();
    await store.saveInput(id, room(), [
      { data: ch('dev:p'), wakeAt: null, removed: false },
      { data: ch('dev:t'), wakeAt: 5000, removed: false },
      { data: ch('dev:r', { removedByStreamer: true }), wakeAt: null, removed: true },
      { data: ch('dev:idle'), wakeAt: null, removed: false },
    ]);
    const ids = (cs: Character[]) => cs.map((c) => c.id).sort();
    expect(ids(await store.roomCharacters(id, ['dev:p'], false))).toEqual(['dev:p', 'dev:t']);
    expect(ids(await store.roomCharacters(id, ['dev:p'], true))).toEqual(['dev:p', 'dev:r', 'dev:t']);
    expect(ids(await store.removedCharacters(id))).toEqual(['dev:r']);
  });

  it('finds rooms to load at boot: a session open, or a character timer', async () => {
    const quiet = await newChannel();
    const open = await newChannel();
    const timer = await newChannel();
    await store.saveInput(open, room({ session: { party: [], encounter: null, adventure: null } }), []);
    await store.saveInput(timer, room(), [{ data: ch('dev:k'), wakeAt: 1, removed: false }]);
    const closed = await newChannel();
    await store.saveInput(closed, room({ session: { party: [], encounter: null, adventure: null } }), []);
    await store.saveInput(closed, room({ session: null }), []);   // a closed session is SQL NULL, not JSON null
    const boot = await store.roomsToBoot();
    expect(boot).toEqual(expect.arrayContaining([open, timer]));
    expect(boot).not.toContain(quiet);
    expect(boot).not.toContain(closed);
  });

  it('saves a config with its new version, and a new token', async () => {
    const id = await newChannel();
    await store.saveConfig(id, { packs: [] }, 2, room({ seq: 1 }), []);
    expect(await store.channel(id)).toMatchObject({ config: { packs: [] }, configVersion: 2 });
    await store.saveToken(id, 'dock', tok('new'), room({ seq: 2 }));
    expect((await store.channelByTokenHash('h-new'))!.role).toBe('dock');
    expect((await store.room(id))!.seq).toBe(2);
  });

  it('takes the advisory lock once per database', async () => {
    expect(await store.tryLock()).toBe(true);
    const other = Store.open(t.url);
    expect(await other.tryLock()).toBe(false);
    await other.close();
  });

  it('round-trips a real new game room', async () => {
    const engine = createEngine({ packs: [], channel: { packs: [] } });
    const g = engine.newGame({ seed: 42 });
    const id = await store.createChannel({
      name: 'real', config: { packs: [] }, dock: tok('rd'), overlay: tok('ro'),
      room: { stateVersion: g.version, clock: g.clock, rng: g.rng, seq: g.seq, session: g.session, recentRequests: [] },
    });
    expect((await store.room(id))!.rng).toBe(g.rng);
  });
});
