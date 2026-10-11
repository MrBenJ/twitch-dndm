const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** "8s" -> 8000. A number is taken as milliseconds. */
export function parseDuration(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid duration: ${value}`);
    return Math.round(value);
  }
  const m = DURATION.exec(value.trim());
  if (!m) throw new Error(`Invalid duration '${value}' (use 500ms, 8s, 2m or 1h)`);
  return Math.round(Number(m[1]) * UNIT_MS[m[2]!]!);
}

/** "25%" -> 25. A number is taken as a percent already. */
export function parsePercent(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid percent: ${value}`);
    return value;
  }
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(value.trim());
  if (!m) throw new Error(`Invalid percent '${value}' (write it like 25%)`);
  return Number(m[1]);
}

/** Milliseconds as whole seconds, rounded up: 3200 -> "4s". */
export function formatDuration(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}
