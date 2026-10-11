import { FormulaError, formulaVars, mapFormulaStats, parseFormula, printFormula } from './formula';
import { CHANNEL, CONTENT_TYPES, type ContentType, CORE, fullId, LOCAL_ID_PATTERN, PACK_ID_PATTERN, type RefType, refKey, splitId } from './ids';
import { type NormalizeCtx, normalizeParams, p, type Step, type StatusApplication } from './params';
import type { BuildState } from './registry';

const PLUGIN_MAP: Record<string, string> = {
  effect: 'effects', status: 'statuses', passive: 'passives', targeting: 'targeting', behavior: 'behaviors', encounterKind: 'kinds',
};

function exists(st: BuildState, type: RefType, full: string): boolean {
  if ((CONTENT_TYPES as readonly string[]).includes(type)) {
    if (type === 'stat' && full === 'core:hp') return true;
    return st.raw.get(type as ContentType)!.has(full);
  }
  return (st.reg[PLUGIN_MAP[type] as 'effects'] as Map<string, unknown>).has(full);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Builds the NormalizeCtx for content from `fromPack`.
 * In probe mode, issues are swallowed; only `hitDormant` matters (used to compute dormancy).
 */
export function makeNormalizeCtx(
  st: BuildState,
  fromPack: string,
  where: { file?: string; doc?: number },
  mode: { dormant: Set<string>; probe: boolean },
): NormalizeCtx & { hitDormant: boolean; dormantRefs: string[] } {
  const isChannel = fromPack === CHANNEL;
  const ctx = {
    hitDormant: false,
    dormantRefs: [] as string[],
    issue(path: string, message: string) {
      if (!mode.probe) st.issues.push({ level: 'error', pack: fromPack, ...where, path, message });
    },
    ref(type: RefType, raw: string, path: string): string | null {
      const { pack, id } = splitId(raw);
      if (!LOCAL_ID_PATTERN.test(id) || (pack !== null && !PACK_ID_PATTERN.test(pack))) {
        ctx.issue(path, `Invalid ID '${raw}'`);
        return null;
      }
      let full: string;
      if (pack !== null) {
        if (pack !== fromPack && pack !== CORE) {
          if (isChannel) {
            if (!st.installed.has(pack)) { ctx.issue(path, `'${raw}': there's no pack called '${pack}'`); return null; }
            if (!st.enabled.has(pack)) { ctx.markDormant(`${type} ${raw}`); return null; }
          } else if (!st.depends.get(fromPack)?.has(pack)) {
            ctx.issue(path, `'${raw}': ${fromPack} doesn't depend on ${pack}`);
            return null;
          }
        }
        full = fullId(pack, id);
      } else {
        const own = fullId(fromPack, id);
        const core = fullId(CORE, id);
        full = exists(st, type, own) ? own : exists(st, type, core) ? core : own;
      }
      if (exists(st, type, full)) {
        if (mode.dormant.has(refKey(type, full))) { ctx.markDormant(`${type} ${full}`); return null; }
        return full;
      }
      if (isChannel && st.deleted.has(full)) { ctx.markDormant(`${type} ${full} (deleted)`); return null; }
      ctx.issue(path, `Unknown ${type === 'encounterKind' ? 'encounter kind' : type} '${raw}'`);
      return null;
    },
    markDormant(what: string) {
      ctx.hitDormant = true;
      ctx.dormantRefs.push(what);
    },
    formula(text: string, path: string, noSource: boolean): string | null {
      let node;
      try { node = parseFormula(text); } catch (e) {
        if (e instanceof FormulaError) { ctx.issue(path, e.message); return null; }
        throw e;
      }
      const vars = formulaVars(node);
      if (noSource && vars.some((v) => v.side === 'source')) {
        ctx.issue(path, 'This formula has no source; use target.<stat> or numbers');
        return null;
      }
      let ok = true;
      const mapped = mapFormulaStats(node, (stat) => {
        const full = ctx.ref('stat', stat, path);
        if (!full) ok = false;
        return full ?? stat;
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
        const def = st.reg.effects.get(effect)!.def;
        const np = normalizeParams(def.params ?? p.object({}), params ?? {}, ctx, `${sp}.${key}`, noSource);
        out.push({ effect, params: np });
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
      const def = st.reg.statuses.get(id)!.def;
      const params = normalizeParams(def.params ?? p.object({}), rest, ctx, path, noSource);
      return { status: id, duration: (d as number | null | undefined) ?? null, params };
    },
  };
  return ctx;
}
