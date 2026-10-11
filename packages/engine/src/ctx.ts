import {
  alliesOf, enemiesOf, entityName, entityTags, hp, isKnockedOut, level, maxHp, partyRefs, stat, statusViews, storesOf,
} from './entities';
import { evaluateFormula, FormulaError, formulaVars, mapFormulaStats, parseFormula, printFormula } from './formula';
import { allowedOutcomes } from './encounters';
import { modify } from './hooks';
import { CORE, type RefType } from './ids';
import {
  applyStatus, dealDamage, giveItem, giveRewards, heal, knockOut, removeStatus, revive, runSteps, setStore, spendGold, useAbility,
} from './ops';
import type { Ctx, EntityRef } from './pack';
import { type NormalizeCtx, normalizeParams, p, type StatusApplication, type Step } from './params';
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
    endEncounter: (outcome) => {
      if (!rt.game.session?.encounter) throw new Error('No encounter is running');
      const allowed = allowedOutcomes(rt);
      if (!allowed.includes(outcome)) throw new Error(`This encounter can't end with '${outcome}' (outcomes: ${allowed.join(', ')})`);
      rt.pendingEnd = outcome;
    },
    emit: (type, data, text) => {
      if (!type.startsWith(`${pack}:`)) throw new Error(`Custom event types must start with '${pack}:'`);
      rt.emit(type, text, data);
    },
    setStore: (e, data) => setStore(rt, pack, e, data),
  };
}

/**
 * Normalizes runtime input (viewer responses, streamer commands, inline encounters) against the registry,
 * with the same checks content gets at load time: known IDs, known stats in formulas, the no-source rule.
 */
export function runtimeNormalizeCtx(rt: Runtime, pack: string): NormalizeCtx & { issues: string[] } {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const ctx = {
    issues: [] as string[],
    issue(path: string, message: string) { ctx.issues.push(path ? `${path}: ${message}` : message); },
    ref(type: RefType, raw: string, path: string): string | null {
      const id = resolveFor(rt, pack, type, raw);
      if ((rt.reg[MAPS[type]] as Map<string, unknown>).has(id)) return id;
      ctx.issue(path, `Unknown ${type === 'encounterKind' ? 'encounter kind' : type} '${raw}'`);
      return null;
    },
    formula(text: string, path: string, noSource: boolean): string | null {
      let node;
      try { node = parseFormula(text); } catch (e) {
        if (e instanceof FormulaError) { ctx.issue(path, e.message); return null; }
        throw e;
      }
      if (noSource && formulaVars(node).some((v) => v.side === 'source')) {
        ctx.issue(path, 'This formula has no source; use target.<stat> or numbers');
        return null;
      }
      let ok = true;
      const mapped = mapFormulaStats(node, (s) => {
        const full = ctx.ref('stat', s, path);
        if (!full) ok = false;
        return full ?? s;
      });
      return ok ? printFormula(mapped) : null;
    },
    steps(value: unknown, path: string, noSource: boolean): Step[] | null {
      if (!Array.isArray(value)) { ctx.issue(path, 'must be a list of steps'); return null; }
      const out: Step[] = [];
      value.forEach((step, i) => {
        const sp = `${path}[${i}]`;
        if (!isObj(step) || Object.keys(step).length !== 1) { ctx.issue(sp, 'each step is one effect with its params, like { poke: { ... } }'); return; }
        const [key, params] = Object.entries(step)[0]!;
        const effect = ctx.ref('effect', key, sp);
        if (!effect) return;
        const def = rt.reg.effects.get(effect)!.def;
        out.push({ effect, params: normalizeParams(def.params ?? p.object({}), params ?? {}, ctx, `${sp}.${key}`, noSource) });
      });
      return out;
    },
    statusApplication(value: unknown, path: string, noSource: boolean): StatusApplication | null {
      if (!isObj(value)) { ctx.issue(path, 'must be a map with a status'); return null; }
      const { status, duration, ...rest } = value;
      if (typeof status !== 'string') { ctx.issue(`${path}.status`, 'required'); return null; }
      const id = ctx.ref('status', status, `${path}.status`);
      if (!id) return null;
      const d = duration === undefined || duration === null ? null : normalizeParams(p.duration(), duration, ctx, `${path}.duration`);
      const def = rt.reg.statuses.get(id)!.def;
      return { status: id, duration: (d as number | null | undefined) ?? null, params: normalizeParams(def.params ?? p.object({}), rest, ctx, path, noSource) };
    },
  };
  return ctx;
}
