/** Turn any seed into a 32-bit RNG state. */
export function seedState(seed: number): number {
  return (Math.floor(seed) >>> 0) || 0x9e3779b9;
}

/** One mulberry32 step: returns a float in [0, 1) and the next state. */
export function nextRandom(state: number): [number, number] {
  const next = (state + 0x6d2b79f5) >>> 0;
  let r = Math.imul(next ^ (next >>> 15), next | 1);
  r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
  return [((r ^ (r >>> 14)) >>> 0) / 4294967296, next];
}
