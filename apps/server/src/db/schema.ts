import type { Character, SessionState } from '@dndm/engine';
import { bigint, boolean, index, integer, json, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** A repeated request ID's first answer (spec 2a §4.1). `replacedHash`: the token a regenerate replaced. */
export interface RecentRequest { key: string; at: number; answer: unknown; replacedHash?: string }

// json, not jsonb: jsonb reorders object keys, and the engine iterates some objects (README decision 1).
export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  twitchId: text('twitch_id').unique(),
  config: json('config').$type<Record<string, unknown>>().notNull(),
  configVersion: integer('config_version').notNull().default(1),
  dockTokenHash: text('dock_token_hash').notNull().unique(),
  dockTokenEnc: text('dock_token_enc').notNull(),
  overlayTokenHash: text('overlay_token_hash').notNull().unique(),
  overlayTokenEnc: text('overlay_token_enc').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rooms = pgTable('rooms', {
  channelId: uuid('channel_id').primaryKey().references(() => channels.id, { onDelete: 'cascade' }),
  stateVersion: integer('state_version').notNull(),
  clock: bigint('clock', { mode: 'number' }).notNull(),
  rng: bigint('rng', { mode: 'number' }).notNull(),
  seq: integer('seq').notNull(),
  session: json('session').$type<SessionState>(),
  recentRequests: json('recent_requests').$type<RecentRequest[]>().notNull().default([]),
  savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
});

export const characters = pgTable('characters', {
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  id: text('id').notNull(),
  data: json('data').$type<Character>().notNull(),
  wakeAt: bigint('wake_at', { mode: 'number' }),
  removed: boolean('removed').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.channelId, t.id] }),
  index('characters_wake_at').on(t.wakeAt),
  index('characters_removed').on(t.channelId, t.removed),
]);
