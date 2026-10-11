import type { RefType } from './ids';
import { parseDuration, parsePercent } from './units';

export type ParamSchema =
  | { t: 'number'; min?: number; max?: number; integer?: boolean }
  | { t: 'string' }
  | { t: 'boolean' }
  | { t: 'duration' }
  | { t: 'percent' }
  | { t: 'amountOrPercent' }
  | { t: 'formula' }
  | { t: 'ref'; ref: RefType }
  | { t: 'enum'; values: string[] }
  | { t: 'list'; of: ParamSchema }
  | { t: 'record'; of: ParamSchema }
  | { t: 'refMap'; ref: RefType; of: ParamSchema }
  | { t: 'object'; fields: Record<string, ParamSchema> }
  | { t: 'optional'; of: ParamSchema; default?: unknown }
  | { t: 'steps'; noSource?: boolean }
  | { t: 'statusApplication' }
  | { t: 'any' };

export interface Step { effect: string; params: unknown }
export interface StatusApplication { status: string; duration: number | null; params: unknown }
export type AmountOrPercent = { amount: number } | { percent: number };

export const p = {
  number: (o: { min?: number; max?: number } = {}): ParamSchema => ({ t: 'number', ...o }),
  integer: (o: { min?: number; max?: number } = {}): ParamSchema => ({ t: 'number', integer: true, ...o }),
  string: (): ParamSchema => ({ t: 'string' }),
  boolean: (): ParamSchema => ({ t: 'boolean' }),
  duration: (): ParamSchema => ({ t: 'duration' }),
  percent: (): ParamSchema => ({ t: 'percent' }),
  amountOrPercent: (): ParamSchema => ({ t: 'amountOrPercent' }),
  formula: (): ParamSchema => ({ t: 'formula' }),
  ref: (ref: RefType): ParamSchema => ({ t: 'ref', ref }),
  enum: (...values: string[]): ParamSchema => ({ t: 'enum', values }),
  list: (of: ParamSchema): ParamSchema => ({ t: 'list', of }),
  record: (of: ParamSchema): ParamSchema => ({ t: 'record', of }),
  refMap: (ref: RefType, of: ParamSchema): ParamSchema => ({ t: 'refMap', ref, of }),
  object: (fields: Record<string, ParamSchema>): ParamSchema => ({ t: 'object', fields }),
  optional: (of: ParamSchema, dflt?: unknown): ParamSchema => ({ t: 'optional', of, default: dflt }),
  steps: (o: { noSource?: boolean } = {}): ParamSchema => ({ t: 'steps', ...o }),
  statusApplication: (): ParamSchema => ({ t: 'statusApplication' }),
  any: (): ParamSchema => ({ t: 'any' }),
};

export interface NormalizeCtx {
  ref(type: RefType, raw: string, path: string): string | null;
  formula(text: string, path: string, noSource: boolean): string | null;
  steps(value: unknown, path: string, noSource: boolean): Step[] | null;
  statusApplication(value: unknown, path: string, noSource: boolean): StatusApplication | null;
  issue(path: string, message: string): void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const join = (path: string, key: string | number) =>
  typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;

export function normalizeParams(schema: ParamSchema, value: unknown, ctx: NormalizeCtx, path = '', noSource = false): unknown {
  const fail = (message: string): undefined => { ctx.issue(path, message); return undefined; };
  switch (schema.t) {
    case 'any': return value;
    case 'optional':
      return value === undefined || value === null ? schema.default : normalizeParams(schema.of, value, ctx, path, noSource);
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('must be a number');
      if (schema.integer && !Number.isInteger(value)) return fail('must be a whole number');
      if (schema.min !== undefined && value < schema.min) return fail(`must be at least ${schema.min}`);
      if (schema.max !== undefined && value > schema.max) return fail(`must be at most ${schema.max}`);
      return value;
    }
    case 'string': return typeof value === 'string' ? value : fail('must be text');
    case 'boolean': return typeof value === 'boolean' ? value : fail('must be true or false');
    case 'duration':
    case 'percent': {
      if (typeof value !== 'string' && typeof value !== 'number') return fail(`must be a ${schema.t}`);
      try { return schema.t === 'duration' ? parseDuration(value) : parsePercent(value); }
      catch (e) { return fail((e as Error).message); }
    }
    case 'amountOrPercent': {
      if (typeof value === 'number' && Number.isFinite(value)) return { amount: value };
      if (typeof value === 'string') {
        try { return { percent: parsePercent(value) }; } catch (e) { return fail((e as Error).message); }
      }
      return fail('must be a number or a percent like 50%');
    }
    case 'formula': {
      if (typeof value === 'number' && Number.isFinite(value)) return ctx.formula(String(value), path, noSource) ?? undefined;
      if (typeof value !== 'string') return fail('must be a number or a formula');
      return ctx.formula(value, path, noSource) ?? undefined;
    }
    case 'ref': {
      if (typeof value !== 'string' || value === '') return fail(`must be a ${schema.ref} ID`);
      return ctx.ref(schema.ref, value, path) ?? undefined;
    }
    case 'enum':
      return typeof value === 'string' && schema.values.includes(value) ? value : fail(`must be one of: ${schema.values.join(', ')}`);
    case 'list': {
      if (!Array.isArray(value)) return fail('must be a list');
      return value.map((v, i) => normalizeParams(schema.of, v, ctx, join(path, i), noSource));
    }
    case 'record': {
      if (!isObj(value)) return fail('must be a map');
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeParams(schema.of, v, ctx, join(path, k), noSource)]));
    }
    case 'refMap': {
      if (!isObj(value)) return fail('must be a map');
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const id = ctx.ref(schema.ref, k, join(path, k));
        const nv = normalizeParams(schema.of, v, ctx, join(path, k), noSource);
        if (id) out[id] = nv;
      }
      return out;
    }
    case 'object': {
      if (!isObj(value)) return fail('must be a map of fields');
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(schema.fields)) {
        const v = value[key];
        if ((v === undefined || v === null) && field.t !== 'optional') { ctx.issue(join(path, key), 'required'); continue; }
        const nv = normalizeParams(field, v, ctx, join(path, key), noSource);
        if (nv !== undefined) out[key] = nv;
      }
      for (const key of Object.keys(value)) if (!(key in schema.fields)) ctx.issue(join(path, key), 'unknown field');
      return out;
    }
    case 'steps': return ctx.steps(value, path, noSource || !!schema.noSource) ?? undefined;
    case 'statusApplication': return ctx.statusApplication(value, path, noSource) ?? undefined;
  }
}
