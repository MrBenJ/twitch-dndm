import { z } from 'zod';
import { CONTENT_TYPES, type ContentType, LOCAL_ID_PATTERN } from './ids';
import type { Step } from './params';

const id = z.string().min(1);
const durationLike = z.union([z.string(), z.number()]);
const statMap = z.record(z.string(), z.number()).default({});
const passiveEntry = z.union([z.string(), z.record(z.string(), z.unknown())]);
const text = z.string().default('');
const icon = z.string().nullable().default(null);

export const DOC_SCHEMAS: Record<ContentType, z.ZodType> = {
  stat: z.object({ stat: id, name: z.string(), icon, default: z.number(), 'per-level': z.number().default(0) }).strict(),
  slot: z.object({ slot: id, name: z.string() }).strict(),
  class: z.object({
    class: id, name: z.string(), description: text, icon, tags: z.array(z.string()).default([]),
    stats: statMap, abilities: z.array(z.string()).default([]), passives: z.array(passiveEntry).default([]),
  }).strict(),
  ability: z.object({
    ability: id, name: z.string(), description: text, icon, cooldown: durationLike,
    when: z.enum(['fight', 'anytime']).default('fight'),
    target: z.union([z.string(), z.record(z.string(), z.unknown())]),
    steps: z.array(z.record(z.string(), z.unknown())),
  }).strict(),
  item: z.object({
    item: id, name: z.string(), description: text, icon, slot: z.string().optional(),
    'grants-class': z.string().optional(), stats: statMap, passives: z.array(passiveEntry).default([]),
    abilities: z.array(z.string()).default([]), use: z.string().optional(),
    uses: z.number().int().min(1).default(1), price: z.number().min(0).default(0),
  }).strict(),
  monster: z.object({
    monster: id, name: z.string(), description: text, image: z.string().nullable().default(null),
    tags: z.array(z.string()).default([]), hp: z.number().positive(), stats: statMap,
    abilities: z.array(z.string()).min(1), passives: z.array(passiveEntry).default([]),
    behavior: z.record(z.string(), z.unknown()), interval: durationLike.optional(),
    rewards: z.object({ xp: z.number().min(0).default(0), gold: z.number().min(0).default(0) }).strict().default({ xp: 0, gold: 0 }),
    drops: z.array(z.object({ item: z.string(), chance: z.number().min(0).max(1) }).strict()).default([]),
  }).strict(),
  encounter: z.object({ encounter: id, name: z.string().optional() }).catchall(z.unknown()),
  adventure: z.object({
    adventure: id, name: z.string(), description: text, start: z.string(),
    nodes: z.record(z.string(), z.object({
      next: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
      use: z.string().optional(),
    }).catchall(z.unknown())),
  }).strict(),
};

export function detectDocType(doc: unknown): { type: ContentType; id: string } | { error: string } {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { error: 'A content document must be a map' };
  // The type is the document's first key (spec §8): other fields, such as an item's `slot`, may share a type's name.
  const first = Object.keys(doc)[0];
  if (first === undefined || !(CONTENT_TYPES as readonly string[]).includes(first)) {
    const later = Object.keys(doc).find((k) => (CONTENT_TYPES as readonly string[]).includes(k));
    if (later) return { error: `Start the document with its type key (found '${later}' later)` };
    return { error: `Document has no type key (one of: ${CONTENT_TYPES.join(', ')})` };
  }
  const type = first as ContentType;
  const raw = (doc as Record<string, unknown>)[type];
  if (typeof raw !== 'string') return { error: `The '${type}' key must be an ID` };
  if (raw.includes(':')) return { error: `Write the ${type} ID '${raw}' without a pack prefix` };
  if (!LOCAL_ID_PATTERN.test(raw)) return { error: `Invalid ID '${raw}' (use lowercase letters, digits and -)` };
  return { type, id: raw };
}

export interface StatDef { id: string; name: string; icon: string | null; default: number; perLevel: number }
export interface SlotDef { id: string; name: string; order: number }
export interface PassiveUse { passive: string; params: unknown }
export interface TargetUse { rule: string; params: unknown }
export interface ClassDef {
  id: string; name: string; description: string; icon: string | null; tags: string[];
  stats: Record<string, number>; abilities: string[]; passives: PassiveUse[];
}
export interface AbilityDef {
  id: string; name: string; description: string; icon: string | null; cooldown: number;
  when: 'fight' | 'anytime'; target: TargetUse; steps: Step[];
}
export interface ItemDef {
  id: string; name: string; description: string; icon: string | null; slot: string | null;
  grantsClass: string | null; stats: Record<string, number>; passives: PassiveUse[];
  abilities: string[]; use: string | null; uses: number; price: number;
}
export interface MonsterDef {
  id: string; name: string; description: string; image: string | null; tags: string[]; hp: number;
  stats: Record<string, number>; abilities: string[]; passives: PassiveUse[];
  behavior: { behavior: string; params: unknown }; interval: number | null;
  rewards: { xp: number; gold: number }; drops: { item: string; chance: number }[];
}
export interface EncounterSpec { kind: string; params: unknown }
export interface EncounterDef { id: string; name: string; spec: EncounterSpec }
export interface AdventureNode { spec: EncounterSpec | null; use: string | null; next: string | Record<string, string> | null }
export interface AdventureDef { id: string; name: string; description: string; start: string; nodes: Record<string, AdventureNode> }
