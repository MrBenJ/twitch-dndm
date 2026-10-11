import { formatIssue, ValidationError } from '@dndm/engine';
import { LoadError } from '@dndm/pack-loader';
import { setup, type SetupOpts } from './setup';

const PLURALS: Record<string, string> = { pack: 'packs', class: 'classes', ability: 'abilities', item: 'items', monster: 'monsters', adventure: 'adventures' };
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : PLURALS[word]}`;

export async function validate(opts: SetupOpts & { json?: boolean }): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  try {
    const engine = await setup(opts);
    const d = engine.describe();
    for (const w of d.warnings) lines.push(opts.json ? JSON.stringify({ kind: 'issue', ...w }) : formatIssue(w));
    const counts = { packs: d.packs.length, classes: d.classes.length, abilities: d.abilities.length, items: d.items.length, monsters: d.monsters.length, adventures: d.adventures.length };
    lines.push(opts.json
      ? JSON.stringify({ kind: 'valid', ...counts })
      : `Valid: ${plural(counts.packs, 'pack')}, ${plural(counts.classes, 'class')}, ${plural(counts.abilities, 'ability')}, ${plural(counts.items, 'item')}, ${plural(counts.monsters, 'monster')}, ${plural(counts.adventures, 'adventure')}`);
    return { ok: true, lines };
  } catch (e) {
    if (e instanceof ValidationError) {
      for (const i of e.issues) lines.push(opts.json ? JSON.stringify({ kind: 'issue', ...i }) : formatIssue(i));
      return { ok: false, lines };
    }
    if (e instanceof LoadError) {
      lines.push(opts.json ? JSON.stringify({ kind: 'issue', level: 'error', message: e.message }) : `error: ${e.message}`);
      return { ok: false, lines };
    }
    throw e;
  }
}
