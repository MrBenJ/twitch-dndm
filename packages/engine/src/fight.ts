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

// ---- Stubs until Task 4 ----
import { Rejection } from './errors';
import type { FightState, Origin } from './state';

export function fightInterval(rt: Runtime, _f: FightState): number { return rt.settings.monsterInterval; }
export function startFight(_rt: Runtime, _monster: string, _origin: Origin | null): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function spawnMonster(_rt: Runtime, _monster: string): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function refreshFight(_rt: Runtime, _f: FightState): void {}
export function monsterTurn(_rt: Runtime, _f: FightState): void {}
export function holdMonster(_rt: Runtime): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function releaseMonster(_rt: Runtime): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function monsterActNow(_rt: Runtime): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function setMonsterHp(_rt: Runtime, _v: number): void { throw new Rejection('Not implemented yet', 'not-implemented'); }
export function endFight(_rt: Runtime, _f: FightState, _o: string): void {}
