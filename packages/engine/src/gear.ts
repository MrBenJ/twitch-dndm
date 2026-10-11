import { charRef, currentFight, maxHp, owns } from './entities';
import { Rejection } from './errors';
import type { Runtime } from './runtime';
import type { Character } from './state';

/** After the character's own gear change: saved HP never exceeds max HP. */
export function capHp(rt: Runtime, ch: Character): void {
  const m = maxHp(rt, charRef(ch.id));
  if (ch.hp > m) ch.hp = m;
}

export function gearLocked(rt: Runtime, id: string): boolean {
  const s = rt.game.session;
  return !!s && s.party.includes(id) && !!currentFight(rt) && rt.settings.gearLockDuringCombat;
}

export function equip(rt: Runtime, id: string, itemId: string): void {
  const ch = rt.requireChar(id);
  if (ch.banned) throw new Rejection("Banned characters can't change gear", 'banned');
  const item = rt.reg.items.get(itemId);
  if (!item || !owns(rt, ch, itemId)) throw new Rejection("You don't have that item", 'not-owned');
  if (!item.slot || !rt.reg.slots.has(item.slot)) throw new Rejection("That item can't be equipped", 'not-gear');
  if (gearLocked(rt, id)) throw new Rejection('Gear is locked during fights', 'gear-locked');
  ch.equipped[item.slot] = itemId;
  capHp(rt, ch);
  rt.emit('core:equipped', `${ch.name} equips ${item.name}`, { character: id, item: itemId, slot: item.slot });
}

export function unequip(rt: Runtime, id: string, slot: string): void {
  const ch = rt.requireChar(id);
  if (ch.banned) throw new Rejection("Banned characters can't change gear", 'banned');
  if (slot === rt.settings.classSlot) throw new Rejection("You can't empty your class slot; swap it instead", 'class-slot');
  if (!ch.equipped[slot]) throw new Rejection('Nothing is equipped there', 'empty-slot');
  if (gearLocked(rt, id)) throw new Rejection('Gear is locked during fights', 'gear-locked');
  delete ch.equipped[slot];
  capHp(rt, ch);
  rt.emit('core:unequipped', `${ch.name} takes off their ${rt.reg.slots.get(slot)?.name ?? slot}`, { character: id, slot });
}
