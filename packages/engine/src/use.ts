import { abilitiesOf, charRef, currentFight, isKnockedOut } from './entities';
import { Rejection } from './errors';
import { modify } from './hooks';
import { useAbility } from './ops';
import type { EntityRef } from './pack';
import type { Runtime } from './runtime';
import type { Character } from './state';
import { formatDuration } from './units';

function spendUse(rt: Runtime, ch: Character, itemId: string): void {
  if (rt.settings.startingItems.includes(itemId) && !(ch.inventory[itemId] ?? 0)) return;
  const item = rt.reg.items.get(itemId)!;
  const left = (ch.usesLeft[itemId] ?? item.uses) - 1;
  if (left > 0) { ch.usesLeft[itemId] = left; return; }
  delete ch.usesLeft[itemId];
  const count = (ch.inventory[itemId] ?? 0) - 1;
  if (count > 0) ch.inventory[itemId] = count;
  else delete ch.inventory[itemId];
}

export function useCommand(rt: Runtime, id: string, abilityId: string, chosen: EntityRef | null): void {
  const ch = rt.requireChar(id);
  const s = rt.game.session;
  if (!s || !s.party.includes(id)) throw new Rejection('Not in the party', 'not-in-party');
  const me = charRef(id);
  if (isKnockedOut(rt, me)) throw new Rejection("You're knocked out", 'knocked-out');
  const src = abilitiesOf(rt, ch).find((a) => a.ability === abilityId);
  if (!src) throw new Rejection("You don't have that ability", 'no-ability');
  const ab = rt.reg.abilities.get(abilityId)!;
  if (ab.when === 'fight' && !currentFight(rt)) throw new Rejection('You can only use that during a fight', 'fight-only');
  const until = ch.cooldowns[abilityId];
  if (until !== undefined && until > rt.now) throw new Rejection(`On cooldown (${formatDuration(until - rt.now)})`, 'on-cooldown');
  const can = modify(rt, me, 'canUse', true as true | string, { ability: abilityId });
  if (can !== true) throw new Rejection(can, 'cannot-use');
  useAbility(rt, me, abilityId, chosen, {}, true);
  if (src.from === 'item' && src.item) spendUse(rt, ch, src.item);
}
