import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration, parsePercent } from '../src/units';

describe('parseDuration', () => {
  it.each([
    ['500ms', 500], ['8s', 8000], ['1.5s', 1500], ['2m', 120000], ['1h', 3600000], [250, 250],
  ])('%s -> %d', (input, ms) => expect(parseDuration(input)).toBe(ms));

  it.each(['', '8', 's', '-1s', '1d', 'abc', -5, Number.NaN])('rejects %s', (input) => {
    expect(() => parseDuration(input as string | number)).toThrow(/duration/i);
  });
});

describe('parsePercent', () => {
  it('reads "25%" and plain numbers', () => {
    expect(parsePercent('25%')).toBe(25);
    expect(parsePercent('12.5%')).toBe(12.5);
    expect(parsePercent(40)).toBe(40);
  });
  it('rejects bad input', () => {
    expect(() => parsePercent('25')).toThrow(/percent/i);
    expect(() => parsePercent('x%')).toThrow(/percent/i);
  });
});

describe('formatDuration', () => {
  it('rounds up to whole seconds', () => {
    expect(formatDuration(4000)).toBe('4s');
    expect(formatDuration(3200)).toBe('4s');
    expect(formatDuration(1)).toBe('1s');
    expect(formatDuration(90000)).toBe('90s');
  });
});
