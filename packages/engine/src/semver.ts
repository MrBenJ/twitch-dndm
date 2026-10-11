const V = /^(\d+)\.(\d+)\.(\d+)$/;

export function isVersion(v: string): boolean {
  return V.test(v);
}

function parse(v: string): [number, number, number] | null {
  const m = V.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  const r = range.trim();
  if (r === '*') return true;
  const op = /^(\^|~|>=)?(.*)$/.exec(r)!;
  const base = parse(op[2]!);
  if (!base) return false;
  switch (op[1]) {
    case undefined: return cmp(v, base) === 0;
    case '>=': return cmp(v, base) >= 0;
    case '~': return v[0] === base[0] && v[1] === base[1] && v[2] >= base[2];
    case '^':
      if (cmp(v, base) < 0) return false;
      if (base[0] > 0) return v[0] === base[0];
      if (base[1] > 0) return v[0] === 0 && v[1] === base[1];
      return v[0] === 0 && v[1] === 0 && v[2] === base[2];
  }
  return false;
}
