import type { ClassDef, ItemDef } from './content';
import { modify } from './hooks';
import type { EntityRef, Hooks, StatusView } from './pack';
import { CORE_HP, CORE_KO } from './registry';
import type { Runtime } from './runtime';
import { type Character, type FightState, isFight, type MonsterState, type StatusInstance } from './state';

export const charRef = (id: string): EntityRef => ({ kind: 'character', id });
export const monsterRef = (id: string): EntityRef => ({ kind: 'monster', id });
export const sameRef = (a: EntityRef, b: EntityRef): boolean => a.kind === b.kind && a.id === b.id;

export function currentFight(rt: Runtime): FightState | null {
  const e = rt.game.session?.encounter;
  return e && isFight(e) ? e : null;
}

function monsterOf(rt: Runtime, id: string): MonsterState | undefined {
  return currentFight(rt)?.monsters.find((m) => m.id === id);
}

export function entityExists(rt: Runtime, e: EntityRef): boolean {
  return e.kind === 'character' ? !!rt.game.characters[e.id] : !!monsterOf(rt, e.id);
}

function charOf(rt: Runtime, e: EntityRef): Character {
  const ch = rt.game.characters[e.id];
  if (!ch) throw new Error(`No character ${e.id}`);
  return ch;
}

function monOf(rt: Runtime, e: EntityRef): MonsterState {
  const m = monsterOf(rt, e.id);
  if (!m) throw new Error(`No monster ${e.id}`);
  return m;
}

export function entityName(rt: Runtime, e: EntityRef | null): string {
  if (!e) return 'Something';
  if (e.kind === 'character') return rt.game.characters[e.id]?.name ?? e.id;
  return monsterOf(rt, e.id)?.def.name ?? e.id;
}

export function entityTags(rt: Runtime, e: EntityRef): string[] {
  if (e.kind === 'monster') return [...monOf(rt, e).def.tags];
  return [...(classOf(rt, charOf(rt, e))?.tags ?? [])];
}

/** The raw, mutable status array. */
export function statusList(rt: Runtime, e: EntityRef): StatusInstance[] {
  return e.kind === 'character' ? charOf(rt, e).statuses : monOf(rt, e).statuses;
}

/** Statuses whose definition resolves (dormant ones are ignored while dormant). */
export function liveStatuses(rt: Runtime, e: EntityRef): StatusInstance[] {
  return statusList(rt, e).filter((s) => rt.reg.statuses.has(s.status));
}

export function statusViews(rt: Runtime, e: EntityRef): StatusView[] {
  const out: StatusView[] = [];
  if (e.kind === 'character' && charOf(rt, e).knockedOutUntil !== null) {
    out.push({ status: CORE_KO, until: charOf(rt, e).knockedOutUntil, params: {}, source: null });
  }
  if (e.kind === 'monster' && monOf(rt, e).knockedOut) out.push({ status: CORE_KO, until: null, params: {}, source: null });
  for (const s of liveStatuses(rt, e)) out.push({ status: s.status, until: s.until, params: s.params, source: s.source });
  return out;
}

export function storesOf(rt: Runtime, e: EntityRef): Record<string, unknown> {
  return e.kind === 'character' ? charOf(rt, e).stores : monOf(rt, e).stores;
}

export function isKnockedOut(rt: Runtime, e: EntityRef): boolean {
  return e.kind === 'character' ? charOf(rt, e).knockedOutUntil !== null : monOf(rt, e).knockedOut;
}

export function owns(rt: Runtime, ch: Character, item: string): boolean {
  return (ch.inventory[item] ?? 0) > 0 || rt.settings.startingItems.includes(item);
}

/** Resolvable items the character owns: inventory first (in insertion order), then starting items. */
export function ownedItems(rt: Runtime, ch: Character): ItemDef[] {
  const ids = [...Object.keys(ch.inventory).filter((i) => (ch.inventory[i] ?? 0) > 0), ...rt.settings.startingItems];
  return [...new Set(ids)].map((i) => rt.reg.items.get(i)).filter((i): i is ItemDef => !!i);
}

/** Equipped items that count, in slot order. A dormant class item falls back to the first starting item for that slot. */
export function effectiveEquipped(rt: Runtime, ch: Character): [string, ItemDef][] {
  const out: [string, ItemDef][] = [];
  for (const slot of rt.reg.slots.keys()) {
    const stored = ch.equipped[slot];
    if (!stored) continue;
    const item = rt.reg.items.get(stored);
    if (item && item.slot === slot && owns(rt, ch, stored)) { out.push([slot, item]); continue; }
    if (!item && slot === rt.settings.classSlot) {
      const fallback = rt.settings.startingItems.map((i) => rt.reg.items.get(i)).find((i) => i && i.slot === slot);
      if (fallback) out.push([slot, fallback]);
    }
  }
  return out;
}

export function classOf(rt: Runtime, ch: Character): ClassDef | null {
  const slot = rt.settings.classSlot;
  if (!slot) return null;
  const item = effectiveEquipped(rt, ch).find(([s]) => s === slot)?.[1];
  return item?.grantsClass ? rt.reg.classes.get(item.grantsClass) ?? null : null;
}

export interface AbilitySource { ability: string; from: 'class' | 'gear' | 'item'; item?: string }

export function abilitiesOf(rt: Runtime, ch: Character): AbilitySource[] {
  const out: AbilitySource[] = [];
  const seen = new Set<string>();
  const add = (ability: string, from: AbilitySource['from'], item?: string) => {
    if (!rt.reg.abilities.has(ability) || seen.has(ability)) return;
    seen.add(ability);
    out.push(item ? { ability, from, item } : { ability, from });
  };
  for (const a of classOf(rt, ch)?.abilities ?? []) add(a, 'class');
  for (const [, item] of effectiveEquipped(rt, ch)) for (const a of item.abilities) add(a, 'gear', item.id);
  for (const item of ownedItems(rt, ch)) if (item.use) add(item.use, 'item', item.id);
  return out;
}

function bonuses(rt: Runtime, ch: Character, statId: string): number {
  let total = classOf(rt, ch)?.stats[statId] ?? 0;
  for (const [, item] of effectiveEquipped(rt, ch)) total += item.stats[statId] ?? 0;
  return total;
}

export function level(rt: Runtime, e: EntityRef): number {
  return e.kind === 'character' ? charOf(rt, e).level : 1;
}

export function statRaw(rt: Runtime, e: EntityRef, statId: string): number {
  const def = rt.reg.stats.get(statId);
  if (!def) return 0;
  if (e.kind === 'monster') return monOf(rt, e).def.stats[statId] ?? def.default;
  const ch = charOf(rt, e);
  return def.default + def.perLevel * (ch.level - 1) + bonuses(rt, ch, statId);
}

function modified(rt: Runtime, e: EntityRef, statId: string, raw: number): number {
  if (rt.inStatModifier > 0) return raw;
  rt.inStatModifier++;
  try {
    return modify(rt, e, 'stat', raw, { stat: statId });
  } finally {
    rt.inStatModifier--;
  }
}

export function stat(rt: Runtime, e: EntityRef, statId: string): number {
  return modified(rt, e, statId, statRaw(rt, e, statId));
}

export function maxHp(rt: Runtime, e: EntityRef): number {
  let raw: number;
  if (e.kind === 'monster') raw = monOf(rt, e).def.hp;
  else {
    const ch = charOf(rt, e);
    raw = rt.settings.baseHp + rt.settings.hpPerLevel * (ch.level - 1) + bonuses(rt, ch, CORE_HP);
  }
  return Math.max(1, Math.round(modified(rt, e, CORE_HP, raw)));
}

/** The HP the game uses: 0 while knocked out, otherwise saved HP capped at max HP. */
export function hp(rt: Runtime, e: EntityRef): number {
  if (e.kind === 'monster') return monOf(rt, e).hp;
  const ch = charOf(rt, e);
  if (ch.knockedOutUntil !== null) return 0;
  return Math.min(ch.hp, maxHp(rt, e));
}

export interface Holder { pack: string; label: string; hooks: Hooks; params: unknown }

/** Passives (class, gear in slot order, monster), then statuses in the order applied. */
export function holders(rt: Runtime, e: EntityRef): Holder[] {
  const out: Holder[] = [];
  const addPassive = (passive: string, params: unknown) => {
    const p = rt.reg.passives.get(passive);
    if (p) out.push({ pack: p.pack, label: p.id, hooks: p.def, params });
  };
  if (e.kind === 'character') {
    const ch = charOf(rt, e);
    for (const u of classOf(rt, ch)?.passives ?? []) addPassive(u.passive, u.params);
    for (const [, item] of effectiveEquipped(rt, ch)) for (const u of item.passives) addPassive(u.passive, u.params);
  } else {
    for (const u of monOf(rt, e).def.passives) addPassive(u.passive, u.params);
  }
  for (const s of liveStatuses(rt, e)) {
    const st = rt.reg.statuses.get(s.status)!;
    out.push({ pack: st.pack, label: st.id, hooks: st.def, params: s.params });
  }
  return out;
}

export function partyRefs(rt: Runtime): EntityRef[] {
  return (rt.game.session?.party ?? []).filter((id) => rt.game.characters[id]).map(charRef);
}

export function enemiesOf(rt: Runtime, e: EntityRef): EntityRef[] {
  if (e.kind === 'monster') return partyRefs(rt);
  return (currentFight(rt)?.monsters ?? []).map((m) => monsterRef(m.id));
}

export function alliesOf(rt: Runtime, e: EntityRef): EntityRef[] {
  if (e.kind === 'character') return partyRefs(rt);
  return (currentFight(rt)?.monsters ?? []).map((m) => monsterRef(m.id));
}

/** Total XP needed to reach `lvl`: level 2 at `first`, each later step `step` more. */
export function xpToReach(rt: Runtime, lvl: number): number {
  const { first, step } = rt.settings.xpCurve;
  let total = 0;
  for (let l = 2; l <= lvl; l++) total += first + step * (l - 2);
  return total;
}
