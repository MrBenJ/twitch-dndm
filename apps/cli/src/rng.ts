/** Small seeded RNG (mulberry32) for bot decisions, so sim runs are repeatable. */
export function makeRng(seed: number): () => number {
  let s = (Math.floor(seed) >>> 0) || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), s | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
