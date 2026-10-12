import type { PackBundle } from '@dndm/engine';
import { FakeClock } from '../../src/clock';
import { Secrets } from '../../src/crypto';
import { Room, type RoomDeps, type RoomOutput, type Sender } from '../../src/room';
import { createChannel, defaultConfig, officialBundles } from '../../src/server';
import { Store } from '../../src/store';
import { freshDb } from './db';

let bundles: PackBundle[] | null = null;
export const SECRET = 'test-secret-0123456789';

export async function roomSetup(opts: { settings?: Record<string, unknown>; seed?: number } = {}) {
  const t = await freshDb();
  const store = new Store(t.db, t.sql);
  const clock = new FakeClock(0);
  const secrets = new Secrets(SECRET);
  bundles ??= await officialBundles();
  const base = defaultConfig() as { settings?: Record<string, unknown> };
  const config = { ...base, settings: { ...(base.settings ?? {}), ...(opts.settings ?? {}) } };
  const made = await createChannel({ store, secrets, bundles, name: 'test', config, seed: opts.seed ?? 1 });
  const deps: RoomDeps = { store, clock, secrets, bundles };
  let room = (await Room.load(made.id, deps))!;
  const out: RoomOutput[] = [];
  let unsub = room.subscribe((o) => out.push(o));
  let n = 0;
  const s = {
    t, store, clock, secrets, deps, made, out,
    get room() { return room; },
    dock: { role: 'dock' } as Sender,
    overlay: { role: 'overlay' } as Sender,
    v: (name: string): Sender => ({ role: 'viewer', character: `dev:${name}` }),
    cmd: (sender: Sender, command: Record<string, unknown> & { type: string }, id = `r${++n}`) => room.command(sender, id, command),
    advance: (ms: number) => clock.advance(ms, () => room.idle()),
    /** Drops the Room and loads it again from the database, like a restart. */
    async reload() {
      room.close(); unsub();
      room = (await Room.load(made.id, deps))!;
      unsub = room.subscribe((o) => out.push(o));
      return room;
    },
    events: () => out.flatMap((o) => (o.type === 'events' ? o.events : [])),
    async done() { room.close(); await t.drop(); },
  };
  return s;
}
