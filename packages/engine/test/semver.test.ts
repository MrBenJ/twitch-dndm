import { describe, expect, it } from 'vitest';
import { isVersion, satisfies } from '../src/semver';

describe('satisfies', () => {
  it.each([
    ['1.2.3', '*', true], ['1.2.3', '1.2.3', true], ['1.2.4', '1.2.3', false],
    ['1.4.0', '^1.2.3', true], ['2.0.0', '^1.2.3', false], ['1.2.2', '^1.2.3', false],
    ['0.2.5', '^0.2.3', true], ['0.3.0', '^0.2.3', false],
    ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false],
    ['3.0.0', '>=1.2.3', true], ['1.2.2', '>=1.2.3', false],
  ])('%s satisfies %s: %s', (v, r, ok) => expect(satisfies(v, r)).toBe(ok));

  it('rejects bad ranges and versions', () => {
    expect(satisfies('1.2.3', 'banana')).toBe(false);
    expect(isVersion('1.2')).toBe(false);
    expect(isVersion('1.2.3')).toBe(true);
  });
});
