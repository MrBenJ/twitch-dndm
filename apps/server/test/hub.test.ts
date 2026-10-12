import type { ServerMessage } from '@dndm/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto';
import { type Conn, Hub } from '../src/hub';
import { RoomManager } from '../src/room-manager';
import { roomSetup } from './helpers/room';

let s: Awaited<ReturnType<typeof roomSetup>>;
afterEach(async () => { await s.done(); });

function conn(role: Conn['role'], character: string | null = null, tokenHash: string | null = null) {
  const got: ServerMessage[] = [];
  const closed: number[] = [];
  const c: Conn = { role, character, tokenHash, send: (m) => got.push(m), close: (code) => closed.push(code) };
  return { c, got, closed, types: () => got.map((m) => m.type) };
}

const shop = { type: 'startEncounter', encounter: { 'starter:shop': { stock: [{ item: 'starter:health-potion', price: 1 }], secret: true } } };

describe('Hub (spec 2a §5)', () => {
  it('welcomes each role with its view, then fans out by audience', async () => {
    s = await roomSetup();
    const hub = new Hub();
    const dock = conn('dock', null, hashToken(s.made.dockToken));
    const overlay = conn('overlay');
    const al = conn('viewer', 'dev:al');
    const cy = conn('viewer', 'dev:cy');
    for (const x of [dock, overlay, al, cy]) await hub.add(s.room, x.c);
    expect(dock.types()).toEqual(['welcome']);
    await s.cmd(s.dock, { type: 'openSession' });
    await s.cmd(s.v('al'), { type: 'join', name: 'Al', pick: 'starter:sword' });
    await s.cmd(s.dock, shop);
    const eventsOf = (x: typeof dock) => x.got.flatMap((m) => (m.type === 'events' ? m.events.map((e) => e.type) : []));
    expect(eventsOf(dock)).toContain('core:encounter-started');
    expect(eventsOf(al)).toContain('core:encounter-started');
    expect(eventsOf(overlay)).not.toContain('core:encounter-started');
    expect(eventsOf(cy)).not.toContain('core:encounter-started');
    expect(overlay.types()).toContain('view');
  });

  it('closes connections that used a revoked token', async () => {
    s = await roomSetup();
    const hub = new Hub();
    const dock = conn('dock', null, hashToken(s.made.dockToken));
    await hub.add(s.room, dock.c);
    await s.cmd(s.dock, { type: 'regenerateDockUrl' });
    expect(dock.closed).toEqual([4403]);
  });

  it('stops watching when a viewer leaves', async () => {
    s = await roomSetup();
    const hub = new Hub();
    const al = conn('viewer', 'dev:al');
    await hub.add(s.room, al.c);
    hub.remove(s.room, al.c);
    await s.cmd(s.dock, { type: 'openSession' });
    expect(al.types()).toEqual(['welcome']);
  });
});

describe('RoomManager (spec 2a §6.4, §6.6)', () => {
  it('loads a Room once, even when asked twice at the same time', async () => {
    s = await roomSetup();
    const m = new RoomManager(s.deps);
    const [a, b] = await Promise.all([m.get(s.made.id), m.get(s.made.id)]);
    expect(a).toBe(b);
    expect(await m.get('6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b')).toBeNull();
    m.close();
  });

  it('boots Rooms with a session open, and unloads idle ones', async () => {
    s = await roomSetup();
    await s.cmd(s.dock, { type: 'openSession' });
    s.room.close();
    const m = new RoomManager(s.deps);
    await m.boot();
    expect(m.rooms().map((r) => r.channel.id)).toEqual([s.made.id]);
    const room = m.rooms()[0]!;
    await room.command({ role: 'dock' }, 'c', { type: 'closeSession' });
    await s.clock.advance(31 * 60_000, () => m.idle());
    await m.sweep();
    expect(m.rooms()).toEqual([]);
    m.close();
  });
});
