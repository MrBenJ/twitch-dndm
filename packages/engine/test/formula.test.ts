import { describe, expect, it } from 'vitest';
import {
  evaluateFormula, FormulaError, formulaVars, mapFormulaStats, parseFormula, printFormula,
  type FormulaEnv, type FormulaVar,
} from '../src/formula';

const env = (vals: Record<string, number>, rand = 0.5): FormulaEnv => ({
  value: (v: FormulaVar) => {
    const key = `${v.side}.${v.what === 'stat' ? v.stat : v.what}`;
    return vals[key] ?? 0;
  },
  random: (a, b) => a + (b - a) * rand,
});
const ev = (text: string, vals: Record<string, number> = {}, rand?: number) =>
  evaluateFormula(parseFormula(text), env(vals, rand));

describe('parse and evaluate', () => {
  it('does arithmetic with precedence and parentheses', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 / 4')).toBe(2.5);
    expect(ev('.5 + 1.5')).toBe(2);
  });

  it('reads source and target stats, hp and level', () => {
    const vals = { 'source.power': 10, 'target.power': 3, 'source.hp': 50, 'source.hp.max': 80, 'target.level': 4 };
    expect(ev('1.5 * power + 2', vals)).toBe(17);
    expect(ev('power - target.power', vals)).toBe(7);
    expect(ev('hp.max - hp', vals)).toBe(30);
    expect(ev('target.level * 2', vals)).toBe(8);
  });

  it('reads hyphenated and prefixed stat names', () => {
    const f = parseFormula('luck-bonus * 2 + tp:mana + target.tp:mana');
    expect(formulaVars(f)).toEqual([
      { side: 'source', what: 'stat', stat: 'luck-bonus' },
      { side: 'source', what: 'stat', stat: 'tp:mana' },
      { side: 'target', what: 'stat', stat: 'tp:mana' },
    ]);
  });

  it('treats a hyphen without spaces as part of a name', () => {
    expect(formulaVars(parseFormula('power-2'))).toEqual([{ side: 'source', what: 'stat', stat: 'power-2' }]);
  });

  it('requires spaces around binary minus', () => {
    expect(() => parseFormula('power -2')).toThrow(/space on both sides/);
    expect(() => parseFormula('2-power')).toThrow(/space on both sides/);
    expect(ev('power - 2', { 'source.power': 5 })).toBe(3);
  });

  it('allows unary minus', () => {
    expect(ev('-2 * 3')).toBe(-6);
    expect(ev('max(-1, 4)')).toBe(4);
    expect(ev('2 * -power', { 'source.power': 3 })).toBe(-6);
  });

  it('supports every function', () => {
    expect(ev('min(3, 1, 2)')).toBe(1);
    expect(ev('max(3, 1, 2)')).toBe(3);
    expect(ev('floor(2.7)')).toBe(2);
    expect(ev('ceil(2.1)')).toBe(3);
    expect(ev('round(2.5)')).toBe(3);
    expect(ev('random(1, 3)', {}, 0.5)).toBe(2);
  });

  it('never yields NaN or Infinity', () => {
    expect(ev('5 / 0')).toBe(0);
    expect(ev('power / target.power', { 'source.power': 5, 'target.power': 0 })).toBe(0);
    expect(ev('0 / 0')).toBe(0);
  });

  it('rejects bad syntax with readable messages', () => {
    expect(() => parseFormula('')).toThrow(FormulaError);
    expect(() => parseFormula('1 +')).toThrow(/Unexpected end/);
    expect(() => parseFormula('(1 + 2')).toThrow(/Expected '\)'/);
    expect(() => parseFormula('foo(1)')).toThrow(/Unknown function 'foo'/);
    expect(() => parseFormula('floor(1, 2)')).toThrow(/floor takes 1/);
    expect(() => parseFormula('random(1)')).toThrow(/random takes 2/);
    expect(() => parseFormula('1 $ 2')).toThrow(/Unexpected '\$'/);
    expect(() => parseFormula('hp.min')).toThrow(/Unknown name 'hp.min'/);
    expect(() => parseFormula('2power')).toThrow(/after a number/);
  });
});

describe('printFormula and mapFormulaStats', () => {
  it('round-trips', () => {
    for (const text of ['1.5 * power + 2', 'power - target.power', 'max(-1, random(1, 2))', 'hp.max / 2', '-(power)']) {
      const node = parseFormula(text);
      expect(parseFormula(printFormula(node))).toEqual(node);
    }
  });
  it('rewrites stat names', () => {
    const node = mapFormulaStats(parseFormula('power + target.power + hp'), (s) => `tp:${s}`);
    expect(printFormula(node)).toBe('((tp:power + target.tp:power) + hp)');
  });
});
