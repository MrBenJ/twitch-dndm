import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Command, createEngine, type GameEvent, type GameState, parseDuration, VIEWER_COMMANDS } from '@dndm/engine';
import { repoRoot } from '@dndm/pack-loader';
import { defaultConfig, officialBundles } from '../../src/server';

export type Line = { wait: string | number } | { next: true } | { as: string; command: Record<string, unknown> & { type: string } };
export type Out = GameEvent | { rejected: string };

export const DIR = join(repoRoot(), 'apps', 'cli', 'test', 'golden');
export const scripts = readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort();
export const read = (name: string): Line[] => readFileSync(join(DIR, name), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

/** What `dndm run` does (apps/cli/src/driver.ts), straight through the engine. */
export async function direct(lines: Line[]): Promise<Out[]> {
  const engine = createEngine({ packs: await officialBundles(), channel: defaultConfig() });
  let game: GameState = engine.newGame({ seed: 1 });
  let now = 0;
  const out: Out[] = [];
  const advance = () => { const r = engine.advance(game, now); game = r.game; out.push(...r.events); };
  for (const l of lines) {
    if ('wait' in l) { now += parseDuration(l.wait); advance(); continue; }
    if ('next' in l) { const t = engine.nextWakeTime(game); if (t !== null) { now = Math.max(now, t); advance(); } continue; }
    if (l.as !== 'streamer' && !(VIEWER_COMMANDS as readonly string[]).includes(l.command.type)) { out.push({ rejected: 'streamer-only' }); continue; }
    const cmd = (l.as === 'streamer' ? l.command : { ...l.command, character: l.as }) as unknown as Command;
    const r = engine.apply(game, cmd, now);
    if (r.ok) { game = r.game; out.push(...r.events); } else out.push({ rejected: r.error.code });
  }
  return out;
}

/** A command that names a viewer's character (or targets one) names their server ID: `<prefix><name>`. */
export function toId(c: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out = { ...c };
  if (typeof out.character === 'string') out.character = `${prefix}${out.character}`;
  if (typeof out.target === 'string' && out.target !== 'party') out.target = `${prefix}${out.target}`;
  const t = out.target as { kind?: string; id?: string } | undefined;
  if (t && typeof t === 'object' && t.kind === 'character') out.target = { ...t, id: `${prefix}${t.id}` };
  const chosen = out.chosen as { kind?: string; id?: string } | null | undefined;
  if (chosen && chosen.kind === 'character') out.chosen = { ...chosen, id: `${prefix}${chosen.id}` };
  return out;
}

/** Replaces every "<prefix><name>" string with "<name>", anywhere in a value. */
export function unprefix(v: unknown, prefix: string): unknown {
  if (typeof v === 'string') return v.startsWith(prefix) ? v.slice(prefix.length) : v;
  if (Array.isArray(v)) return v.map((x) => unprefix(x, prefix));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unprefix(x, prefix)]));
  return v;
}
