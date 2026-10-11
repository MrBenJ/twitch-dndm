import { describe, expect, it } from 'vitest';
import { normalizeParams, p, type NormalizeCtx } from '../src/params';

function fakeCtx() {
  const issues: string[] = [];
  const ctx: NormalizeCtx = {
    ref: (type, raw, path) => {
      if (raw === 'missing') { issues.push(`${path}: Unknown ${type} '${raw}'`); return null; }
      return raw.includes(':') ? raw : `tp:${raw}`;
    },
    formula: (text, path, noSource) => {
      if (noSource && text.includes('power')) { issues.push(`${path}: no source`); return null; }
      return `canon(${text})`;
    },
    steps: (value) => (value as unknown[]).map(() => ({ effect: 'tp:poke', params: {} })),
    statusApplication: (value) => ({ status: 'tp:snooze', duration: 1000, params: value }),
    issue: (path, message) => issues.push(`${path}: ${message}`),
  };
  return { ctx, issues };
}

describe('normalizeParams', () => {
  it('normalizes a full object', () => {
    const { ctx, issues } = fakeCtx();
    const schema = p.object({
      power: p.formula(),
      wait: p.duration(),
      share: p.percent(),
      target: p.ref('status'),
      count: p.optional(p.integer({ min: 1 }), 1),
      mode: p.enum('all', 'some'),
      tags: p.list(p.string()),
      weights: p.refMap('ability', p.number({ min: 0 })),
      labels: p.record(p.string()),
      heal: p.amountOrPercent(),
      on: p.boolean(),
    });
    const out = normalizeParams(schema, {
      power: '2 * power', wait: '8s', share: '25%', target: 'snooze', mode: 'all',
      tags: ['a'], weights: { whack: 3, 'tp:pile': 1 }, labels: { left: 'Left' }, heal: '50%', on: true,
    }, ctx);
    expect(issues).toEqual([]);
    expect(out).toEqual({
      power: 'canon(2 * power)', wait: 8000, share: 25, target: 'tp:snooze', count: 1, mode: 'all',
      tags: ['a'], weights: { 'tp:whack': 3, 'tp:pile': 1 }, labels: { left: 'Left' }, heal: { percent: 50 }, on: true,
    });
  });

  it('accepts numbers as formulas and amounts', () => {
    const { ctx } = fakeCtx();
    expect(normalizeParams(p.formula(), 15, ctx)).toBe('canon(15)');
    expect(normalizeParams(p.amountOrPercent(), 40, ctx)).toEqual({ amount: 40 });
  });

  it('reports every problem with a path', () => {
    const { ctx, issues } = fakeCtx();
    normalizeParams(p.object({ a: p.number({ max: 5 }), b: p.duration(), c: p.ref('item'), d: p.enum('x') }),
      { a: 9, b: 'soon', c: 'missing', d: 'y', extra: 1 }, ctx);
    expect(issues).toEqual([
      'a: must be at most 5',
      "b: Invalid duration 'soon' (use 500ms, 8s, 2m or 1h)",
      "c: Unknown item 'missing'",
      'd: must be one of: x',
      'extra: unknown field',
    ]);
  });

  it('requires non-optional fields', () => {
    const { ctx, issues } = fakeCtx();
    normalizeParams(p.object({ a: p.number() }), {}, ctx);
    expect(issues).toEqual(['a: required']);
  });

  it('passes noSource down to formulas inside objects', () => {
    const { ctx, issues } = fakeCtx();
    normalizeParams(p.object({ f: p.formula() }), { f: 'power' }, ctx, '', true);
    expect(issues).toEqual(['f: no source']);
  });

  it('delegates steps and status applications to the ctx', () => {
    const { ctx } = fakeCtx();
    expect(normalizeParams(p.steps(), [{ poke: {} }], ctx)).toEqual([{ effect: 'tp:poke', params: {} }]);
    expect(normalizeParams(p.statusApplication(), { status: 'snooze' }, ctx))
      .toEqual({ status: 'tp:snooze', duration: 1000, params: { status: 'snooze' } });
  });

  it('treats a missing schema value of p.any as is', () => {
    const { ctx } = fakeCtx();
    expect(normalizeParams(p.any(), { x: [1] }, ctx)).toEqual({ x: [1] });
  });
});
