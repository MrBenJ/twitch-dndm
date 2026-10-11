import type { Description } from '@dndm/engine';

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export type IdKind = 'ability' | 'item' | 'monster' | 'status' | 'encounter' | 'adventure' | 'class' | 'slot';

function listFor(d: Description, kind: IdKind): { id: string }[] {
  switch (kind) {
    case 'ability': return d.abilities;
    case 'item': return d.items;
    case 'monster': return d.monsters;
    case 'status': return d.statuses;
    case 'encounter': return d.encounters;
    case 'adventure': return d.adventures;
    case 'class': return d.classes;
    case 'slot': return d.slots;
  }
}

/** "slime" -> "starter:slime" when exactly one enabled pack has it. Full IDs pass through. */
export function resolveId(d: Description, kind: IdKind, text: string): string {
  if (text.includes(':')) return text;
  const matches = listFor(d, kind).map((x) => x.id).filter((id) => id.slice(id.indexOf(':') + 1) === text);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new CliError(`Unknown ${kind} '${text}'`);
  throw new CliError(`'${text}' could be ${matches.join(' or ')}; write the full ID`);
}
