import { describe, expect, it } from 'vitest';
import { nextRandom, seedState } from '../src/rng';

describe('rng', () => {
  it('is deterministic for a seed', () => {
    const run = (seed: number) => {
      let s = seedState(seed);
      const out: number[] = [];
      for (let i = 0; i < 5; i++) { const [v, n] = nextRandom(s); out.push(v); s = n; }
      return out;
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('stays in [0, 1)', () => {
    let s = seedState(7);
    for (let i = 0; i < 10000; i++) {
      const [v, n] = nextRandom(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      s = n;
    }
  });
});
