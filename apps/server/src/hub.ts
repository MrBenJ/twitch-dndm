import { type Role, type ServerMessage, WS_CLOSE } from '@dndm/protocol';
import { type Room, type RoomOutput, visibleTo } from './room';

/** One live connection, whatever carries it (a WebSocket in 2a; 2b may add others). */
export interface Conn {
  role: Role;
  character: string | null;
  tokenHash: string | null;
  send(m: ServerMessage): void;
  close(code: number, reason: string): void;
}

/** Fans a Room's output out to its connections (spec 2a §5). */
export class Hub {
  private conns = new Map<Room, Set<Conn>>();
  private unsubs = new Map<Room, () => void>();

  async add(room: Room, conn: Conn): Promise<void> {
    let set = this.conns.get(room);
    if (!set) {
      set = new Set();
      this.conns.set(room, set);
      this.unsubs.set(room, room.subscribe((o) => this.deliver(room, o)));
    }
    set.add(conn);
    const view = conn.role === 'viewer' ? await room.watch(conn.character!) : await room.view({ role: conn.role } as { role: 'dock' | 'overlay' });
    if (!this.conns.get(room)?.has(conn)) return; // closed while we waited
    conn.send({ type: 'welcome', role: conn.role, character: conn.character, view });
  }

  connections(): number {
    let n = 0;
    for (const set of this.conns.values()) n += set.size;
    return n;
  }

  remove(room: Room, conn: Conn): void {
    const set = this.conns.get(room);
    if (!set?.delete(conn)) return;
    if (conn.role === 'viewer' && conn.character) room.unwatch(conn.character);
    if (!set.size) {
      this.conns.delete(room);
      this.unsubs.get(room)?.();
      this.unsubs.delete(room);
    }
  }

  private deliver(room: Room, o: RoomOutput): void {
    for (const c of [...(this.conns.get(room) ?? [])]) {
      switch (o.type) {
        case 'events': {
          const events = o.events.filter((e) => visibleTo(e, c.role, c.character));
          if (events.length) c.send({ type: 'events', events });
          break;
        }
        case 'views':
          if (c.role !== 'viewer') c.send({ type: 'view', view: o.publicView });
          else if (c.character && o.viewers.has(c.character)) c.send({ type: 'view', view: o.viewers.get(c.character)! });
          break;
        case 'config-changed':
          c.send({ type: 'config-changed', configVersion: o.configVersion });
          break;
        case 'token-revoked':
          if (c.tokenHash === o.tokenHash) {
            c.close(WS_CLOSE.revoked, 'This token was replaced');
            this.remove(room, c);
          }
          break;
      }
    }
  }
}
