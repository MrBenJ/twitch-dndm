import type { Character, SessionState } from '@dndm/engine';
import { and, asc, eq, inArray, isNotNull, or, sql as dsql } from 'drizzle-orm';
import { connect, type Db, type Sql } from './db/connect';
import { allowlist, channels, characters, type RecentRequest, rooms } from './db/schema';

export interface ChannelRow {
  id: string; name: string; config: Record<string, unknown>; configVersion: number;
  dockTokenHash: string; dockTokenEnc: string; overlayTokenHash: string; overlayTokenEnc: string;
  /** The channel's Twitch broadcaster ID, or null for a channel not on Twitch (spec 2b §3). */
  twitchId: string | null;
}
export interface RoomRow {
  stateVersion: number; clock: number; rng: number; seq: number; session: SessionState | null; recentRequests: RecentRequest[];
}
export interface CharacterSave { data: Character; wakeAt: number | null; removed: boolean }

const LOCK_KEY = 727_274_001;

/** The only code that talks to Postgres (spec 2a §2.2). */
export class Store {
  private lockConn: Awaited<ReturnType<Sql['reserve']>> | null = null;

  constructor(readonly db: Db, readonly sql: Sql) {}

  static open(url: string): Store {
    const { db, sql } = connect(url);
    return new Store(db, sql);
  }

  async createChannel(c: {
    name: string; config: Record<string, unknown>; room: RoomRow;
    dock: { hash: string; enc: string }; overlay: { hash: string; enc: string }; twitchId?: string;
  }): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(channels).values({
        name: c.name, config: c.config, twitchId: c.twitchId ?? null,
        dockTokenHash: c.dock.hash, dockTokenEnc: c.dock.enc, overlayTokenHash: c.overlay.hash, overlayTokenEnc: c.overlay.enc,
      }).returning({ id: channels.id });
      await tx.insert(rooms).values({ channelId: row!.id, ...roomValues(c.room) });
      return row!.id;
    });
  }

  async channel(id: string): Promise<ChannelRow | null> {
    if (!UUID.test(id)) return null;
    const [row] = await this.db.select().from(channels).where(eq(channels.id, id));
    return row ? toChannel(row) : null;
  }

  async channelByTwitchId(twitchId: string): Promise<ChannelRow | null> {
    const [row] = await this.db.select().from(channels).where(eq(channels.twitchId, twitchId));
    return row ? toChannel(row) : null;
  }

  async channelByTokenHash(hash: string): Promise<{ channel: ChannelRow; role: 'dock' | 'overlay' } | null> {
    const [row] = await this.db.select().from(channels)
      .where(or(eq(channels.dockTokenHash, hash), eq(channels.overlayTokenHash, hash)));
    if (!row) return null;
    return { channel: toChannel(row), role: row.dockTokenHash === hash ? 'dock' : 'overlay' };
  }

  async room(channelId: string): Promise<RoomRow | null> {
    const [row] = await this.db.select().from(rooms).where(eq(rooms.channelId, channelId));
    if (!row) return null;
    return {
      stateVersion: row.stateVersion, clock: row.clock, rng: row.rng, seq: row.seq,
      session: row.session ?? null, recentRequests: row.recentRequests,
    };
  }

  async characters(channelId: string, ids: string[]): Promise<Character[]> {
    if (!ids.length) return [];
    const rows = await this.db.select({ data: characters.data }).from(characters)
      .where(and(eq(characters.channelId, channelId), inArray(characters.id, ids)));
    return rows.map((r) => r.data);
  }

  /** Spec 2a §6.2 "Loading a Room": the party, every character with a timer, and removed ones when asked. */
  async roomCharacters(channelId: string, party: string[], withRemoved: boolean): Promise<Character[]> {
    const conds = [isNotNull(characters.wakeAt)];
    if (party.length) conds.push(inArray(characters.id, party));
    if (withRemoved) conds.push(eq(characters.removed, true));
    const rows = await this.db.select({ data: characters.data }).from(characters)
      .where(and(eq(characters.channelId, channelId), or(...conds)));
    return rows.map((r) => r.data);
  }

  async removedCharacters(channelId: string): Promise<Character[]> {
    const rows = await this.db.select({ data: characters.data }).from(characters)
      .where(and(eq(characters.channelId, channelId), eq(characters.removed, true)));
    return rows.map((r) => r.data);
  }

  /** Spec 2a §6.1 step 3: the room row and every changed character, in one transaction. */
  async saveInput(channelId: string, room: RoomRow, chars: CharacterSave[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(rooms).set({ ...roomValues(room), savedAt: new Date() }).where(eq(rooms.channelId, channelId));
      for (const c of chars) {
        if (c.wakeAt !== null && !Number.isFinite(c.wakeAt)) throw new Error(`Bad wake_at for ${c.data.id}`);
        const values = { channelId, id: c.data.id, data: c.data, wakeAt: c.wakeAt, removed: c.removed, updatedAt: new Date() };
        await tx.insert(characters).values(values).onConflictDoUpdate({
          target: [characters.channelId, characters.id],
          set: { data: values.data, wakeAt: values.wakeAt, removed: values.removed, updatedAt: values.updatedAt },
        });
      }
    });
  }

  async saveConfig(channelId: string, config: Record<string, unknown>, version: number, room: RoomRow, chars: CharacterSave[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(channels).set({ config, configVersion: version, updatedAt: new Date() }).where(eq(channels.id, channelId));
      await tx.update(rooms).set({ ...roomValues(room), savedAt: new Date() }).where(eq(rooms.channelId, channelId));
      for (const c of chars) {
        await tx.insert(characters).values({ channelId, id: c.data.id, data: c.data, wakeAt: c.wakeAt, removed: c.removed })
          .onConflictDoUpdate({ target: [characters.channelId, characters.id], set: { data: c.data, wakeAt: c.wakeAt, removed: c.removed, updatedAt: new Date() } });
      }
    });
  }

  async saveToken(channelId: string, role: 'dock' | 'overlay', token: { hash: string; enc: string }, room: RoomRow): Promise<void> {
    await this.db.transaction(async (tx) => {
      const set = role === 'dock' ? { dockTokenHash: token.hash, dockTokenEnc: token.enc } : { overlayTokenHash: token.hash, overlayTokenEnc: token.enc };
      await tx.update(channels).set({ ...set, updatedAt: new Date() }).where(eq(channels.id, channelId));
      await tx.update(rooms).set({ ...roomValues(room), savedAt: new Date() }).where(eq(rooms.channelId, channelId));
    });
  }

  /** Spec 2a §6.4: rooms with a session open or any character with a timer. */
  async roomsToBoot(): Promise<string[]> {
    const rows = await this.db.execute<{ channel_id: string }>(dsql`
      select channel_id from rooms where session is not null
      union
      select distinct channel_id from characters where wake_at is not null`);
    return [...rows].map((r) => r.channel_id);
  }

  async allow(twitchId: string, login: string): Promise<void> {
    await this.db.insert(allowlist).values({ twitchId, login })
      .onConflictDoUpdate({ target: allowlist.twitchId, set: { login } });
  }

  async disallowById(twitchId: string): Promise<boolean> {
    const rows = await this.db.delete(allowlist).where(eq(allowlist.twitchId, twitchId)).returning({ id: allowlist.twitchId });
    return rows.length > 0;
  }

  async disallowByLogin(login: string): Promise<boolean> {
    const rows = await this.db.delete(allowlist).where(eq(allowlist.login, login)).returning({ id: allowlist.twitchId });
    return rows.length > 0;
  }

  async allowlist(): Promise<{ twitchId: string; login: string; addedAt: Date }[]> {
    return this.db.select().from(allowlist).orderBy(asc(allowlist.addedAt), asc(allowlist.twitchId));
  }

  async isAllowed(twitchId: string): Promise<boolean> {
    const rows = await this.db.select({ id: allowlist.twitchId }).from(allowlist).where(eq(allowlist.twitchId, twitchId));
    return rows.length > 0;
  }

  /** Spec 2a §6.6: one server per database. Held on a dedicated connection until close(). */
  async tryLock(): Promise<boolean> {
    if (!this.lockConn) this.lockConn = await this.sql.reserve();
    const [row] = await this.lockConn<{ ok: boolean }[]>`select pg_try_advisory_lock(${LOCK_KEY}) as ok`;
    return !!row?.ok;
  }

  async close(): Promise<void> {
    this.lockConn?.release();
    this.lockConn = null;
    await this.sql.end();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function roomValues(r: RoomRow) {
  return { stateVersion: r.stateVersion, clock: r.clock, rng: r.rng, seq: r.seq, session: r.session, recentRequests: r.recentRequests };
}

function toChannel(row: typeof channels.$inferSelect): ChannelRow {
  return {
    id: row.id, name: row.name, config: row.config, configVersion: row.configVersion,
    dockTokenHash: row.dockTokenHash, dockTokenEnc: row.dockTokenEnc, overlayTokenHash: row.overlayTokenHash, overlayTokenEnc: row.overlayTokenEnc,
    twitchId: row.twitchId ?? null,
  };
}
