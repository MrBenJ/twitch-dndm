import {
  alliesOf, enemiesOf, entityName, entityTags, hp, isKnockedOut, level, maxHp, partyRefs, stat, statusViews, storesOf,
} from './entities';
import { evaluateFormula, FormulaError, mapFormulaStats, parseFormula, printFormula } from './formula';
import { modify } from './hooks';
import { CORE, type RefType } from './ids';
import {
  applyStatus, dealDamage, giveItem, giveRewards, heal, knockOut, removeStatus, revive, runSteps, setStore, spendGold, useAbility,
} from './ops';
import type { Ctx, EntityRef } from './pack';
import { type NormalizeCtx, normalizeParams, p, type Step } from './params';
import type { Registry } from './registry';
import type { Runtime } from './runtime';

const MAPS: Record<RefType, keyof Registry> = {
  stat: 'stats', slot: 'slots', class: 'classes', ability: 'abilities', item: 'items', monster: 'monsters',
  encounter: 'encounters', adventure: 'adventures', effect: 'effects', status: 'statuses', passive: 'passives',
  targeting: 'targeting', behavior: 'behaviors', encounterKind: 'kinds',
};

/** A short ID means the calling pack's, then the core's. Prefixed IDs pass through. */
export function resolveFor(rt: Runtime, pack: string, type: RefType, id: string): string {
  if (id.includes(':')) return id;
  const map = rt.reg[MAPS[type]] as Map<string, unknown>;
  const own = `${pack}:${id}`;
  if (map.has(own)) return own;
  const core = `${CORE}:${id}`;
  return map.has(core) ? core : own;
}

export function evalFormula(rt: Runtime, pack: string, text: string, sides: { source: EntityRef | null; target: EntityRef | null }): number {
  let node = rt.formulaCache.get(text);
  if (!node) {
    node = parseFormula(text);
    rt.formulaCache.set(text, node);
  }
  return evaluateFormula(node, {
    value(v) {
      const e = v.side === 'source' ? sides.source : sides.target;
      if (!e) throw new Error(`This formula uses the ${v.side}, but there is none`);
      if (v.what === 'hp') return hp(rt, e);
      if (v.what === 'hp.max') return maxHp(rt, e);
      if (v.what === 'level') return level(rt, e);
      return stat(rt, e, resolveFor(rt, pack, 'stat', v.stat!));
    },
    random: (a, b) => a + (b - a) * rt.random(),
  });
}

export function byPriority(rt: Runtime, user: EntityRef, ability: string, candidates: EntityRef[]): EntityRef[] {
  return candidates
    .map((c) => ({ c, pr: modify(rt, c, 'targetPriority', 0, { user, ability }), r: rt.random() }))
    .sort((a, b) => b.pr - a.pr || a.r - b.r)
    .map((x) => x.c);
}

export function makeCtx(rt: Runtime, pack: string): Ctx {
  const R = (type: RefType, id: string) => resolveFor(rt, pack, type, id);
  return {
    get now() { return rt.now; },
    random: () => rt.random(),
    randomInt: (a, b) => rt.randomInt(a, b),
    name: (e) => entityName(rt, e),
    tags: (e) => entityTags(rt, e),
    stat: (e, id) => stat(rt, e, R('stat', id)),
    hp: (e) => hp(rt, e),
    maxHp: (e) => maxHp(rt, e),
    level: (e) => level(rt, e),
    gold: (c) => rt.requireChar(c.id).gold,
    isKnockedOut: (e) => isKnockedOut(rt, e),
    statuses: (e) => statusViews(rt, e),
    party: () => partyRefs(rt),
    active: () => partyRefs(rt).filter((e) => !isKnockedOut(rt, e)),
    enemiesOf: (e) => enemiesOf(rt, e),
    alliesOf: (e) => alliesOf(rt, e),
    byPriority: (user, ability, candidates) => byPriority(rt, user, R('ability', ability), candidates),
    formula: (text, sides) => evalFormula(rt, pack, text, sides),
    store: (e) => structuredClone(storesOf(rt, e)[pack] ?? {}),
    startingItems: () => [...rt.settings.startingItems],
    dealDamage: (s, t, a, o) => dealDamage(rt, s, t, a, o?.tags ?? []),
    heal: (s, t, a) => heal(rt, s, t, a),
    revive: (t, h) => revive(rt, t, h, null),
    knockOut: (t, d) => knockOut(rt, t, d, null),
    applyStatus: (t, id, o) => applyStatus(rt, t, R('status', id), o?.duration ?? null, o?.params ?? {}, o?.source ?? null),
    removeStatus: (t, id) => removeStatus(rt, t, R('status', id), 'removed'),
    useAbility: (u, id, o) => { useAbility(rt, u, R('ability', id), o?.chosen ?? null, o?.hints ?? {}, false); },
    runSteps: (steps: Step[], a) => runSteps(rt, steps, a.source, a.targets),
    giveRewards: (c, r) => giveRewards(rt, c, r),
    spendGold: (c, n) => spendGold(rt, c, n),
    giveItem: (c, i, n) => giveItem(rt, c, R('item', i), n ?? 1),
    endEncounter: (outcome) => { rt.pendingEnd = outcome; },
    emit: (type, data, text) => {
      if (!type.startsWith(`${pack}:`)) throw new Error(`Custom event types must start with '${pack}:'`);
      rt.emit(type, text, data);
    },
    setStore: (e, data) => setStore(rt, pack, e, data),
  };
}

/** Normalizes runtime input (viewer responses, streamer status params) against the registry. */
export function runtimeNormalizeCtx(rt: Runtime, pack: string): NormalizeCtx & { issues: string[] } {
  const ctx = {
    issues: [] as string[],
    issue(path: string, message: string) { ctx.issues.push(path ? `${path}: ${message}` : message); },
    ref(type: RefType, raw: string, path: string): string | null {
      const id = resolveFor(rt, pack, type, raw);
      if ((rt.reg[MAPS[type]] as Map<string, unknown>).has(id)) return id;
      ctx.issue(path, `Unknown ${type} '${raw}'`);
      return null;
    },
    formula(text: string, path: string): string | null {
      try {
        const node = mapFormulaStats(parseFormula(text), (s) => resolveFor(rt, pack, 'stat', s));
        return printFormula(node);
      } catch (e) {
        if (e instanceof FormulaError) { ctx.issue(path, e.message); return null; }
        throw e;
      }
    },
    steps(value: unknown, path: string): Step[] | null {
      if (!Array.isArray(value)) { ctx.issue(path, 'must be a list of steps'); return null; }
      return value.flatMap((step, i) => {
        const [key, params] = Object.entries(step as object)[0] ?? ['', {}];
        const effect = ctx.ref('effect', key, `${path}[${i}]`);
        if (!effect) return [];
        const def = rt.reg.effects.get(effect)!.def;
        return [{ effect, params: normalizeParams(def.params ?? p.object({}), params, ctx, `${path}[${i}].${key}`) }];
      });
    },
    statusApplication(): null {
      ctx.issue('', 'status applications are not accepted here');
      return null;
    },
  };
  return ctx;
}
