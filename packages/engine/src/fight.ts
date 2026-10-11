import { makeCtx } from './ctx';
import { charRef, currentFight, entityName, isKnockedOut, maxHp, monsterRef } from './entities';
import { Rejection } from './errors';
import { callPlugin, react } from './hooks';
import { giveItem, giveRewards, knockOut } from './ops';
import type { EntityRef } from './pack';
import { CORE_FIGHT } from './registry';
import type { Runtime } from './runtime';
import type { FightState, MonsterState, Origin } from './state';
import { requireResting } from './encounters';

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

export function fightInterval(rt: Runtime, f: FightState): number {
  return f.monsters[0]?.def.interval ?? rt.settings.monsterInterval;
}

function activeIds(rt: Runtime): string[] {
  return (rt.game.session?.party ?? []).filter((id) => !isKnockedOut(rt, charRef(id)));
}

function requireFight(rt: Runtime): FightState {
  const f = currentFight(rt);
  if (!f) throw new Rejection("There's no fight running", 'not-a-fight');
  return f;
}

export function startFight(rt: Runtime, monsterId: string, origin: Origin | null): void {
  const s = requireResting(rt);
  const def = rt.reg.monsters.get(monsterId);
  if (!def) throw new Rejection(`Unknown monster '${monsterId}'`, 'unknown-content');
  const m: MonsterState = { id: 'm1', def: structuredClone(def), hp: 0, knockedOut: false, statuses: [], stores: {} };
  const f: FightState = {
    kind: CORE_FIGHT, startedAt: rt.now, origin, monsters: [m], sub: 'waiting', held: false, heldRemaining: null,
    nextTurnAt: null, pausedTurnAt: null, acted: [], wasActive: [], joinedAt: Object.fromEntries(s.party.map((id) => [id, rt.now])),
  };
  s.encounter = f;
  m.hp = maxHp(rt, monsterRef(m.id));
  const active = activeIds(rt);
  if (active.length) {
    f.sub = 'fighting';
    f.nextTurnAt = rt.now + fightInterval(rt, f);
    f.wasActive = active;
  }
  rt.emit('core:encounter-started', `${def.name} appears!`, { kind: CORE_FIGHT, monster: monsterId });
  const present = [...s.party.map((id) => ({ ref: charRef(id), role: 'present' as const })), { ref: monsterRef(m.id), role: 'present' as const }];
  react(rt, { type: 'encounterStarted', kind: CORE_FIGHT }, present);
}

export function spawnMonster(rt: Runtime, monsterId: string): void {
  startFight(rt, monsterId, null);
}

/** Move between fighting and waiting as party members become active or not. */
export function refreshFight(rt: Runtime, f: FightState): void {
  const active = activeIds(rt);
  for (const id of active) if (!f.wasActive.includes(id)) f.wasActive.push(id);
  if (f.sub === 'fighting' && active.length === 0) {
    f.sub = 'waiting';
    f.pausedTurnAt = f.nextTurnAt;
    f.nextTurnAt = null;
    rt.emit('core:fight-waiting', `${f.monsters[0]!.def.name} waits. No one is standing.`, {});
  } else if (f.sub === 'waiting' && active.length > 0) {
    f.sub = 'fighting';
    if (!f.held) {
      const full = rt.settings.fullIntervalAfterWaiting || f.pausedTurnAt === null;
      f.nextTurnAt = full ? rt.now + fightInterval(rt, f) : f.pausedTurnAt;
    }
    f.pausedTurnAt = null;
    rt.emit('core:fight-fighting', 'The fight is on again', {});
  }
}

export function monsterAct(rt: Runtime, f: FightState): void {
  const m = f.monsters[0];
  if (!m || m.knockedOut) return;
  const beh = rt.reg.behaviors.get(m.def.behavior.behavior);
  if (!beh) return;
  callPlugin(beh.pack, `${beh.id} act`, () => beh.def.act(makeCtx(rt, beh.pack), { monster: monsterRef(m.id), params: m.def.behavior.params }));
}

export function monsterTurn(rt: Runtime, f: FightState): void {
  f.nextTurnAt = rt.now + fightInterval(rt, f);
  monsterAct(rt, f);
}

export function holdMonster(rt: Runtime): void {
  const f = requireFight(rt);
  if (f.held) throw new Rejection('The monster is already held', 'already-held');
  f.held = true;
  f.heldRemaining = f.nextTurnAt !== null ? Math.max(0, f.nextTurnAt - rt.now) : null;
  f.nextTurnAt = null;
  rt.emit('core:monster-held', `${f.monsters[0]!.def.name} is held`, {});
}

export function releaseMonster(rt: Runtime): void {
  const f = requireFight(rt);
  if (!f.held) throw new Rejection("The monster isn't held", 'not-held');
  f.held = false;
  if (f.sub === 'fighting') {
    const full = rt.settings.fullIntervalAfterRelease || f.heldRemaining === null;
    f.nextTurnAt = rt.now + (full ? fightInterval(rt, f) : f.heldRemaining!);
  } else {
    f.pausedTurnAt = null;
  }
  f.heldRemaining = null;
  rt.emit('core:monster-released', `${f.monsters[0]!.def.name} is released`, {});
}

export function monsterActNow(rt: Runtime): void {
  const f = requireFight(rt);
  if (f.sub === 'waiting') throw new Rejection('No one to act against', 'no-one');
  rt.emit('core:monster-forced', `The streamer makes ${f.monsters[0]!.def.name} act`, {});
  monsterAct(rt, f);
}

export function setMonsterHp(rt: Runtime, value: number): void {
  const f = requireFight(rt);
  const m = f.monsters[0]!;
  if (!Number.isFinite(value)) throw new Rejection('HP must be a number', 'bad-amount');
  m.hp = Math.min(maxHp(rt, monsterRef(m.id)), Math.max(0, Math.round(value)));
  rt.emit('core:monster-hp-set', `${m.def.name}'s HP is set to ${m.hp}`, { hp: m.hp });
  if (m.hp === 0) knockOut(rt, monsterRef(m.id), undefined, null);
}

export function endFight(rt: Runtime, f: FightState, outcome: string): void {
  const s = rt.game.session!;
  const party = [...s.party];
  if (outcome === 'won') {
    const m = f.monsters[0]!;
    for (const id of party) {
      if (rt.settings.rewardsRequireAction && !f.acted.includes(id)) continue;
      giveRewards(rt, charRef(id), { xp: m.def.rewards.xp, gold: m.def.rewards.gold });
      for (const d of m.def.drops) if (rt.reg.items.has(d.item) && rt.random() < d.chance) giveItem(rt, charRef(id), d.item, 1);
    }
  }
  if (rt.settings.autoRemoveIdle) {
    for (const id of party) {
      if (f.acted.includes(id)) continue;
      if (rt.settings.knockedOutExemptFromIdle && !f.wasActive.includes(id)) continue;
      s.party = s.party.filter((x) => x !== id);
      rt.emit('core:removed-idle', `${entityName(rt, charRef(id))} sat out the fight and left the party`, { character: id });
    }
  }
  if (rt.settings.healBetweenFights) {
    for (const id of s.party) {
      if (isKnockedOut(rt, charRef(id))) continue;
      const ch = rt.game.characters[id]!;
      ch.hp = maxHp(rt, charRef(id));
      rt.emit('core:healed', `${ch.name} rests and heals`, { source: null, target: charRef(id), amount: null });
    }
  }
}
