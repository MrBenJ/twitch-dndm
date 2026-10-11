import { makeCtx } from './ctx';
import { charRef, currentFight, entityExists, entityName, hp, isKnockedOut, maxHp, sameRef, statusList, storesOf, xpToReach } from './entities';
import { Rejection } from './errors';
import { markActed, markActive } from './fight';
import { callPlugin, modify, react } from './hooks';
import type { EntityRef, ReactionRole } from './pack';
import type { Step } from './params';
import { CORE_KO } from './registry';
import type { Runtime } from './runtime';
import type { Character } from './state';
import { parseDuration } from './units';

function setHp(rt: Runtime, e: EntityRef, value: number): void {
  if (e.kind === 'character') {
    rt.game.characters[e.id]!.hp = value;
    return;
  }
  const f = currentFight(rt);
  const m = f?.monsters.find((x) => x.id === e.id);
  if (m) m.hp = value;
}

function pair(source: EntityRef | null, target: EntityRef): { ref: EntityRef; role: ReactionRole }[] {
  return source ? [{ ref: source, role: 'source' }, { ref: target, role: 'target' }] : [{ ref: target, role: 'target' }];
}

export function dealDamage(rt: Runtime, source: EntityRef | null, target: EntityRef, amount: number, tags: string[]): number {
  if (!entityExists(rt, target) || isKnockedOut(rt, target)) return 0;
  let v = amount;
  if (source && entityExists(rt, source)) v = modify(rt, source, 'damageDealt', v, { source, target, tags });
  v = modify(rt, target, 'damageTaken', v, { source, target, tags });
  const dmg = Math.max(0, Math.round(v));
  const after = Math.max(0, hp(rt, target) - dmg);
  setHp(rt, target, after);
  const text = source ? `${entityName(rt, source)} hits ${entityName(rt, target)} for ${dmg}` : `${entityName(rt, target)} takes ${dmg} damage`;
  rt.emit('core:damaged', text, { source, target, amount: dmg, tags });
  react(rt, { type: 'damaged', source, target, amount: dmg }, pair(source, target));
  if (after === 0) knockOut(rt, target, undefined, source);
  return dmg;
}

export function heal(rt: Runtime, source: EntityRef | null, target: EntityRef, amount: number): number {
  if (!entityExists(rt, target) || isKnockedOut(rt, target)) return 0;
  let v = amount;
  if (source && entityExists(rt, source)) v = modify(rt, source, 'healingGiven', v, { source, target });
  v = modify(rt, target, 'healingReceived', v, { source, target });
  const before = hp(rt, target);
  const after = Math.min(maxHp(rt, target), before + Math.max(0, Math.round(v)));
  setHp(rt, target, after);
  const healed = after - before;
  const text = source ? `${entityName(rt, source)} heals ${entityName(rt, target)} for ${healed}` : `${entityName(rt, target)} heals ${healed}`;
  rt.emit('core:healed', text, { source, target, amount: healed });
  react(rt, { type: 'healed', source, target, amount: healed }, pair(source, target));
  return healed;
}

export function knockOut(rt: Runtime, target: EntityRef, duration: number | undefined, source: EntityRef | null): void {
  if (!entityExists(rt, target) || isKnockedOut(rt, target)) return;
  if (target.kind === 'character') {
    const ch = rt.game.characters[target.id]!;
    ch.knockedOutUntil = rt.now + (duration ?? rt.settings.knockoutDuration);
    ch.hp = 0;
  } else {
    const m = currentFight(rt)!.monsters.find((x) => x.id === target.id)!;
    m.knockedOut = true;
    m.hp = 0;
  }
  rt.emit('core:knocked-out', `${entityName(rt, target)} is knocked out`, { entity: target, source });
  react(rt, { type: 'knockedOut', entity: target, source }, source ? [{ ref: target, role: 'target' }, { ref: source, role: 'source' }] : [{ ref: target, role: 'target' }]);
}

/** A character's knockout timer ran out. */
export function endKnockout(rt: Runtime, id: string): void {
  const ch = rt.game.characters[id]!;
  ch.knockedOutUntil = null;
  ch.hp = Math.max(1, Math.round((maxHp(rt, charRef(id)) * rt.settings.knockoutReturnHp) / 100));
  rt.emit('core:knockout-ended', `${ch.name} is back on their feet`, { character: id, hp: ch.hp });
  markActive(rt, id);
}

export function revive(rt: Runtime, target: EntityRef, hpValue: number, source: EntityRef | null): void {
  if (!entityExists(rt, target) || !isKnockedOut(rt, target)) return;
  const value = Math.min(maxHp(rt, target), Math.max(1, Math.round(hpValue)));
  if (target.kind === 'character') rt.game.characters[target.id]!.knockedOutUntil = null;
  else currentFight(rt)!.monsters.find((m) => m.id === target.id)!.knockedOut = false;
  setHp(rt, target, value);
  rt.emit('core:revived', `${entityName(rt, target)} is revived`, { entity: target, source, hp: value });
  react(rt, { type: 'revived', entity: target, source }, source ? [{ ref: target, role: 'target' }, { ref: source, role: 'source' }] : [{ ref: target, role: 'target' }]);
  if (target.kind === 'character') markActive(rt, target.id);
}

export function applyStatus(rt: Runtime, target: EntityRef, statusId: string, duration: number | null, params: unknown, source: EntityRef | null): void {
  if (statusId === CORE_KO) { knockOut(rt, target, duration ?? undefined, source); return; }
  const reg = rt.reg.statuses.get(statusId);
  if (!reg) throw new Error(`Unknown status '${statusId}'`);
  if (!entityExists(rt, target)) return;
  const list = statusList(rt, target);
  const stacking = reg.def.stacking ?? 'refresh';
  const existing = list.filter((s) => s.status === statusId);
  if (stacking === 'keep' && existing.length) return;
  if (stacking === 'refresh') for (const s of existing) list.splice(list.indexOf(s), 1);
  const every = reg.def.tick ? parseDuration(reg.def.tick.every) : null;
  list.push({
    status: statusId, until: duration === null ? null : rt.now + duration, params: params ?? {}, source,
    appliedAt: rt.now, nextTick: every ? rt.now + every : null, seq: rt.game.seq++,
  });
  rt.emit('core:status-applied', `${entityName(rt, target)} is ${reg.def.name}`, { holder: target, status: statusId, until: duration === null ? null : rt.now + duration });
  react(rt, { type: 'statusApplied', holder: target, status: statusId }, [{ ref: target, role: 'target' }]);
}

/** Removes every instance of a status (or one instance, by seq). */
export function removeStatus(rt: Runtime, target: EntityRef, statusId: string, reason: 'expired' | 'removed', seq?: number): void {
  if (!entityExists(rt, target)) return;
  const list = statusList(rt, target);
  const gone = list.filter((s) => s.status === statusId && (seq === undefined || s.seq === seq));
  if (!gone.length) return;
  for (const s of gone) list.splice(list.indexOf(s), 1);
  const name = rt.reg.statuses.get(statusId)?.def.name ?? statusId;
  rt.emit('core:status-ended', `${entityName(rt, target)} is no longer ${name}`, { holder: target, status: statusId, reason });
  react(rt, { type: 'statusEnded', holder: target, status: statusId, reason }, [{ ref: target, role: 'target' }]);
}

export function runSteps(rt: Runtime, steps: Step[], source: EntityRef | null, targets: EntityRef[]): void {
  for (const step of steps) {
    const eff = rt.reg.effects.get(step.effect);
    if (!eff) continue;
    for (const target of targets) {
      if (!entityExists(rt, target)) continue;
      callPlugin(eff.pack, eff.id, () => eff.def.apply(makeCtx(rt, eff.pack), { source, target, params: step.params }));
    }
  }
}

/** Returns false when there was nothing to target (only possible when command is false). */
export function useAbility(
  rt: Runtime, user: EntityRef, abilityId: string, chosen: EntityRef | null, hints: Record<string, unknown>, command: boolean,
): boolean {
  const ab = rt.reg.abilities.get(abilityId);
  if (!ab) throw new Rejection("That ability isn't available", 'no-ability');
  const rule = rt.reg.targeting.get(ab.target.rule);
  if (!rule) throw new Rejection("That ability isn't available", 'no-ability');
  const tctx = makeCtx(rt, rule.pack);
  if (chosen) {
    const candidates = callPlugin(rule.pack, `${rule.id} candidates`, () => rule.def.candidates(tctx, { user, params: ab.target.params }));
    if (!candidates.some((c) => sameRef(c, chosen))) throw new Rejection("That target isn't valid", 'invalid-target');
  } else if (rule.def.needsChoice) {
    throw new Rejection('Pick a target', 'target-required');
  }
  const targets = callPlugin(rule.pack, `${rule.id} select`, () =>
    rule.def.select(tctx, { user, ability: abilityId, params: ab.target.params, chosen, hints }));
  if (targets.length === 0) {
    if (command) throw new Rejection('No valid target', 'no-target');
    return false;
  }
  if (user.kind === 'character') {
    const cd = modify(rt, user, 'cooldown', ab.cooldown, { ability: abilityId });
    rt.game.characters[user.id]!.cooldowns[abilityId] = rt.now + Math.max(0, Math.round(cd));
  }
  rt.emit('core:ability-used', `${entityName(rt, user)} uses ${ab.name}`, { user, ability: abilityId, targets });
  runSteps(rt, ab.steps, user, targets);
  react(rt, { type: 'abilityUsed', user, ability: abilityId, targets }, [
    { ref: user, role: 'source' }, ...targets.map((t) => ({ ref: t, role: 'target' as const })),
  ]);
  markActed(rt, user);
  return true;
}

export function addXp(rt: Runtime, ch: Character, n: number): void {
  ch.xp += n;
  while (ch.xp >= xpToReach(rt, ch.level + 1)) {
    ch.level++;
    rt.emit('core:level-up', `${ch.name} reached level ${ch.level}`, { character: ch.id, level: ch.level });
  }
}

export function addGold(_rt: Runtime, ch: Character, n: number): void {
  ch.gold += n;
}

export function giveRewards(rt: Runtime, character: EntityRef, r: { xp?: number; gold?: number; items?: string[] }): void {
  const ch = rt.requireChar(character.id);
  const base = {
    xp: Math.round((r.xp ?? 0) * rt.settings.xpMultiplier),
    gold: Math.round((r.gold ?? 0) * rt.settings.goldMultiplier),
  };
  const got = modify(rt, character, 'rewardsReceived', base, {});
  const xp = Math.max(0, Math.round(got.xp));
  const gold = Math.max(0, Math.round(got.gold));
  ch.gold += gold;
  rt.emit('core:rewarded', `${ch.name} gets ${xp} XP and ${gold} gold`, { character: ch.id, xp, gold });
  addXp(rt, ch, xp);
  for (const item of r.items ?? []) giveItem(rt, character, item, 1);
}

export function spendGold(rt: Runtime, character: EntityRef, n: number): void {
  const ch = rt.requireChar(character.id);
  if (ch.gold < n) throw new Rejection('Not enough gold', 'not-enough-gold');
  ch.gold -= n;
  rt.emit('core:gold-spent', `${ch.name} spends ${n} gold`, { character: ch.id, amount: n });
}

export function giveItem(rt: Runtime, character: EntityRef, item: string, count: number): void {
  const def = rt.reg.items.get(item);
  if (!def) throw new Error(`Unknown item '${item}'`);
  const ch = rt.requireChar(character.id);
  ch.inventory[item] = (ch.inventory[item] ?? 0) + count;
  rt.emit('core:item-given', `${ch.name} gets ${count > 1 ? `${count}× ` : ''}${def.name}`, { character: ch.id, item, count });
}

export function setStore(rt: Runtime, pack: string, e: EntityRef, data: unknown): void {
  storesOf(rt, e)[pack] = structuredClone(data);
  rt.emit('core:store-changed', `${pack} data changed for ${entityName(rt, e)}`, { entity: e, pack });
}
