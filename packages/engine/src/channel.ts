import { z } from 'zod';
import { parseDuration, parsePercent } from './units';

export interface Settings {
  partyCap: number | null;
  allowJoinMidFight: boolean;
  autoRemoveIdle: boolean;
  rewardsRequireAction: boolean;
  knockedOutExemptFromIdle: boolean;
  healBetweenFights: boolean;
  gearLockDuringCombat: boolean;
  streamerRemovalWaitsForRest: boolean;
  fullIntervalAfterWaiting: boolean;
  fullIntervalAfterRelease: boolean;
  fullIntervalAfterRestart: boolean;
  knockoutDuration: number;
  knockoutReturnHp: number;
  baseHp: number;
  hpPerLevel: number;
  xpCurve: { first: number; step: number };
  xpMultiplier: number;
  goldMultiplier: number;
  monsterInterval: number;
  /** Resolved by the registry. null when unset or dormant. */
  classSlot: string | null;
  /** Resolved by the registry; dormant entries skipped. */
  startingItems: string[];
}

export type BaseSettings = Omit<Settings, 'classSlot' | 'startingItems'>;

export const DEFAULT_SETTINGS: BaseSettings = {
  partyCap: null,
  allowJoinMidFight: true,
  autoRemoveIdle: true,
  rewardsRequireAction: true,
  knockedOutExemptFromIdle: true,
  healBetweenFights: false,
  gearLockDuringCombat: true,
  streamerRemovalWaitsForRest: true,
  fullIntervalAfterWaiting: true,
  fullIntervalAfterRelease: true,
  fullIntervalAfterRestart: true,
  knockoutDuration: 60_000,
  knockoutReturnHp: 25,
  baseHp: 100,
  hpPerLevel: 5,
  xpCurve: { first: 80, step: 50 },
  xpMultiplier: 1,
  goldMultiplier: 1,
  monsterInterval: 20_000,
};

export interface ChannelConfig {
  packs: string[];
  channelPack: { content: unknown[]; deleted: string[] };
  overrides: Record<string, Record<string, unknown>>;
  settings: Record<string, unknown>;
}

const channelSchema = z.object({
  packs: z.array(z.string()),
  'channel-pack': z.object({
    content: z.array(z.unknown()).default([]),
    deleted: z.array(z.string()).default([]),
  }).strict().default({ content: [], deleted: [] }),
  overrides: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  settings: z.record(z.string(), z.unknown()).default({}),
}).strict();

export function parseChannel(raw: unknown): { channel: ChannelConfig } | { errors: string[] } {
  const r = channelSchema.safeParse(raw);
  if (!r.success) return { errors: r.error.issues.map((i) => `${i.path.join('.') || '(channel)'}: ${i.message}`) };
  const d = r.data;
  return { channel: { packs: d.packs, channelPack: d['channel-pack'], overrides: d.overrides, settings: d.settings } };
}

type Kind = 'bool' | 'count' | 'nonneg' | 'duration' | 'percent' | 'curve';
const SETTING_KEYS: Record<string, [keyof BaseSettings, Kind]> = {
  'party-cap': ['partyCap', 'count'],
  'allow-join-mid-fight': ['allowJoinMidFight', 'bool'],
  'auto-remove-idle': ['autoRemoveIdle', 'bool'],
  'rewards-require-action': ['rewardsRequireAction', 'bool'],
  'knocked-out-exempt-from-idle': ['knockedOutExemptFromIdle', 'bool'],
  'heal-between-fights': ['healBetweenFights', 'bool'],
  'gear-lock-during-combat': ['gearLockDuringCombat', 'bool'],
  'streamer-removal-waits-for-rest': ['streamerRemovalWaitsForRest', 'bool'],
  'full-interval-after-waiting': ['fullIntervalAfterWaiting', 'bool'],
  'full-interval-after-release': ['fullIntervalAfterRelease', 'bool'],
  'full-interval-after-restart': ['fullIntervalAfterRestart', 'bool'],
  'knockout-duration': ['knockoutDuration', 'duration'],
  'knockout-return-hp': ['knockoutReturnHp', 'percent'],
  'base-hp': ['baseHp', 'count'],
  'hp-per-level': ['hpPerLevel', 'nonneg'],
  'xp-curve': ['xpCurve', 'curve'],
  'xp-multiplier': ['xpMultiplier', 'nonneg'],
  'gold-multiplier': ['goldMultiplier', 'nonneg'],
  'monster-interval': ['monsterInterval', 'duration'],
};

export function parseSettings(raw: Record<string, unknown>): {
  settings: BaseSettings; classSlot: string | null; startingItems: string[]; errors: string[];
} {
  const settings: BaseSettings = structuredClone(DEFAULT_SETTINGS);
  const errors: string[] = [];
  let classSlot: string | null = null;
  let startingItems: string[] = [];
  const out = settings as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'class-slot') {
      if (value === null) classSlot = null;
      else if (typeof value === 'string') classSlot = value;
      else errors.push('class-slot: must be a slot ID');
      continue;
    }
    if (key === 'starting-items') {
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) startingItems = value;
      else errors.push('starting-items: must be a list of item IDs');
      continue;
    }
    const entry = SETTING_KEYS[key];
    if (!entry) { errors.push(`${key}: unknown setting`); continue; }
    const [field, kind] = entry;
    try {
      switch (kind) {
        case 'bool':
          if (typeof value !== 'boolean') throw new Error('must be true or false');
          out[field] = value; break;
        case 'count':
          if (field === 'partyCap' && value === null) { out[field] = null; break; }
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error('must be a whole number of at least 1');
          out[field] = value; break;
        case 'nonneg':
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('must be a number');
          if (value < 0) throw new Error('must be at least 0');
          out[field] = value; break;
        case 'duration': {
          const ms = parseDuration(value as string | number);
          if (ms <= 0) throw new Error('must be longer than 0');
          out[field] = ms; break;
        }
        case 'percent': {
          const pct = parsePercent(value as string | number);
          if (pct < 0 || pct > 100) throw new Error('must be between 0% and 100%');
          out[field] = pct; break;
        }
        case 'curve': {
          const c = value as { first?: unknown; step?: unknown };
          const whole = (n: unknown, min: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
          if (typeof c !== 'object' || c === null || !whole(c.first, 1) || !whole(c.step, 0)) {
            throw new Error('must be { first: whole number ≥ 1, step: whole number ≥ 0 }');
          }
          out[field] = { first: c.first, step: c.step }; break;
        }
      }
    } catch (e) {
      errors.push(`${key}: ${(e as Error).message}`);
    }
  }
  return { settings, classSlot, startingItems, errors };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge key by key; lists and plain values are replaced. */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObj(base) || !isObj(patch)) return structuredClone(patch);
  const out: Record<string, unknown> = { ...structuredClone(base) };
  for (const [k, v] of Object.entries(patch)) out[k] = k in out ? deepMerge(out[k], v) : structuredClone(v);
  return out;
}
