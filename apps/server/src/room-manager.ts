import { Room, type RoomDeps } from './room';

const SWEEP_EVERY = 60_000;

/** What the RoomManager calls around a broadcasting Room's life (spec 2b §5.3). */
export interface RoomHooks {
  /** Starts the Room's Broadcaster; the Room is handed out only once this resolves. */
  attach(room: Room): Promise<void>;
  /** Runs the last broadcastState(), closes the Room, starts the last send in the background; resolves once closed. */
  detach(room: Room): Promise<void>;
}

/** Loads Rooms on demand and at boot, and unloads idle ones (spec 2a §6.4, §6.6). */
export class RoomManager {
  private loaded = new Map<string, Room>();
  private loading = new Map<string, Promise<Room | null>>();
  private cancelSweep: (() => void) | null = null;
  private sweeping: Promise<void> | null = null;

  constructor(readonly deps: RoomDeps, private readonly hooks?: RoomHooks) {}

  get(id: string): Promise<Room | null> {
    // Channel IDs are UUIDs, which the store matches in any case: key the maps by the canonical lowercase form, so an
    // alias like the uppercase ID finds the same Room instead of loading a second one.
    const channelId = id.toLowerCase();
    const room = this.loaded.get(channelId);
    if (room && !room.closed) return Promise.resolve(room);
    if (room) this.loaded.delete(channelId);
    let p = this.loading.get(channelId);
    if (!p) {
      p = Room.load(channelId, this.deps)
        .then(async (r) => {
          if (r?.broadcasting && this.hooks) {
            try {
              await this.hooks.attach(r);
            } catch (e) {
              r.close();
              throw e;
            }
          }
          if (r) this.loaded.set(channelId, r);
          return r;
        })
        .finally(() => this.loading.delete(channelId));
      this.loading.set(channelId, p);
    }
    return p;
  }

  rooms(): Room[] {
    return [...this.loaded.values()];
  }

  async boot(): Promise<void> {
    for (const id of await this.deps.store.roomsToBoot()) {
      // One Room that can't load mustn't keep every other channel offline.
      try { await this.get(id); } catch (e) { this.deps.log?.('room failed to load at boot', { channel: id, error: String(e) }); }
    }
  }

  sweep(): Promise<void> {
    const p = this.sweepOnce().finally(() => { if (this.sweeping === p) this.sweeping = null; });
    this.sweeping = p;
    return p;
  }

  private async sweepOnce(): Promise<void> {
    const now = this.deps.clock.now();
    for (const [id, room] of [...this.loaded]) {
      await room.sweep();
      if (!room.canUnload(now)) continue;
      if (room.broadcasting && this.hooks) {
        // The Room stays in the map until it is closed, so inputs meanwhile go to it (and retry once it closes).
        try {
          await this.hooks.detach(room);
        } catch (e) {
          this.deps.log?.('room unload failed', { channel: id, error: String(e) });
          room.close();
        }
      } else {
        room.close();
      }
      if (this.loaded.get(id) === room) this.loaded.delete(id);
    }
  }

  startSweeper(): void {
    const next = () => {
      this.cancelSweep = this.deps.clock.setTimer(this.deps.clock.now() + SWEEP_EVERY, () => {
        void this.sweep().catch((e) => this.deps.log?.('sweep failed', { error: String(e) })).finally(next);
      });
    };
    next();
  }

  /** Resolves when a running sweep has finished and every Room's queue is empty. */
  async idle(): Promise<void> {
    if (this.sweeping) await this.sweeping.catch(() => {});
    await Promise.all(this.rooms().map((r) => r.idle()));
  }

  close(): void {
    this.cancelSweep?.();
    this.cancelSweep = null;
    for (const r of this.loaded.values()) r.close();
    this.loaded.clear();
  }
}
