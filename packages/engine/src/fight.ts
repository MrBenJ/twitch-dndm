import { currentFight, isKnockedOut, charRef } from './entities';
import type { EntityRef } from './pack';
import type { Runtime } from './runtime';

export function markActed(rt: Runtime, user: EntityRef): void {
  const f = currentFight(rt);
  if (!f || user.kind !== 'character' || !rt.game.session!.party.includes(user.id)) return;
  if (!f.acted.includes(user.id)) f.acted.push(user.id);
}

export function markActive(rt: Runtime, id: string): void {
  const f = currentFight(rt);
  if (!f || !rt.game.session!.party.includes(id) || isKnockedOut(rt, charRef(id))) return;
  if (!f.wasActive.includes(id)) f.wasActive.push(id);
}
