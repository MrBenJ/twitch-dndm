import { Room, type RoomDeps } from './room';

const SWEEP_EVERY = 60_000;

/** Loads Rooms on demand and at boot, and unloads idle ones (spec 2a §6.4, §6.6). */
export class RoomManager {
  private loaded = new Map<string, Room>();
  private loading = new Map<string, Promise<Room | null>>();
  private cancelSweep: (() => void) | null = null;

  constructor(readonly deps: RoomDeps) {}

  get(channelId: string): Promise<Room | null> {
    const room = this.loaded.get(channelId);
    if (room && !room.closed) return Promise.resolve(room);
    if (room) this.loaded.delete(channelId);
    let p = this.loading.get(channelId);
    if (!p) {
      p = Room.load(channelId, this.deps)
        .then((r) => { if (r) this.loaded.set(channelId, r); return r; })
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

  async sweep(): Promise<void> {
    const now = this.deps.clock.now();
    for (const [id, room] of this.loaded) {
      await room.sweep();
      if (room.canUnload(now)) {
        room.close();
        this.loaded.delete(id);
      }
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

  async idle(): Promise<void> {
    await Promise.all(this.rooms().map((r) => r.idle()));
  }

  close(): void {
    this.cancelSweep?.();
    this.cancelSweep = null;
    for (const r of this.loaded.values()) r.close();
    this.loaded.clear();
  }
}
