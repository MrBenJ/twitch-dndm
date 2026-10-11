import { runtimeNormalizeCtx } from './ctx';
import { charRef, currentFight, entityExists, isKnockedOut, maxHp, partyRefs, statusList } from './entities';
import { Rejection } from './errors';
import { addGold, addXp, applyStatus, giveItem, heal, knockOut, removeStatus, revive } from './ops';
import type { EntityRef } from './pack';
import { normalizeParams, p } from './params';
import { CORE_KO } from './registry';
import type { Runtime } from './runtime';
import { parseDuration } from './units';

function amountOk(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Rejection('Amount must be 0 or more', 'bad-amount');
  return n;
}

function targets(rt: Runtime, target: string): string[] {
  if (target === 'party') return partyRefs(rt).map((r) => r.id);
  rt.requireChar(target);
  return [target];
}

export function healPlayer(rt: Runtime, id: string, amount: number | 'full'): void {
  rt.requireChar(id);
  const ref = charRef(id);
  if (amount !== 'full') amountOk(amount);
  if (isKnockedOut(rt, ref)) throw new Rejection("They're knocked out. Revive them instead", 'knocked-out');
  heal(rt, null, ref, amount === 'full' ? maxHp(rt, ref) : amount);
}

export function healParty(rt: Runtime): void {
  for (const ref of partyRefs(rt)) if (!isKnockedOut(rt, ref)) heal(rt, null, ref, maxHp(rt, ref));
}

function reviveOne(rt: Runtime, ref: EntityRef): void {
  revive(rt, ref, (maxHp(rt, ref) * rt.settings.knockoutReturnHp) / 100, null);
}

export function revivePlayer(rt: Runtime, id: string): void {
  rt.requireChar(id);
  if (!isKnockedOut(rt, charRef(id))) throw new Rejection("They aren't knocked out", 'not-knocked-out');
  reviveOne(rt, charRef(id));
}

export function reviveAll(rt: Runtime): void {
  for (const ref of partyRefs(rt)) if (isKnockedOut(rt, ref)) reviveOne(rt, ref);
}

function requireTarget(rt: Runtime, target: EntityRef): void {
  if (target.kind === 'character') rt.requireChar(target.id);
  else if (!currentFight(rt) || !entityExists(rt, target)) throw new Rejection('No such target', 'unknown-target');
}

export function applyStatusCommand(rt: Runtime, target: EntityRef, status: string, duration: string | number | null, params: unknown): void {
  requireTarget(rt, target);
  const ms = duration === null || duration === undefined ? null : (() => {
    try { return parseDuration(duration); } catch (e) { throw new Rejection((e as Error).message, 'invalid-input'); }
  })();
  if (status === CORE_KO) { knockOut(rt, target, ms ?? undefined, null); return; }
  const reg = rt.reg.statuses.get(status);
  if (!reg) throw new Rejection(`Unknown status '${status}'`, 'unknown-status');
  const nctx = runtimeNormalizeCtx(rt, reg.pack);
  const value = normalizeParams(reg.def.params ?? p.object({}), params ?? {}, nctx);
  if (nctx.issues.length) throw new Rejection(nctx.issues[0]!, 'invalid-input');
  applyStatus(rt, target, status, ms, value, null);
}

export function removeStatusCommand(rt: Runtime, target: EntityRef, status: string): void {
  requireTarget(rt, target);
  if (status === CORE_KO) throw new Rejection('Use revive for knockouts', 'use-revive');
  if (!statusList(rt, target).some((s) => s.status === status)) throw new Rejection("They don't have that status", 'no-status');
  removeStatus(rt, target, status, 'removed');
}

export function knockOutCommand(rt: Runtime, id: string): void {
  rt.requireChar(id);
  if (isKnockedOut(rt, charRef(id))) throw new Rejection("They're already knocked out", 'knocked-out');
  knockOut(rt, charRef(id), undefined, null);
}

export function giveXpCommand(rt: Runtime, target: string, amount: number): void {
  const n = Math.round(amountOk(amount));
  for (const id of targets(rt, target)) {
    const ch = rt.game.characters[id]!;
    rt.emit('core:xp-given', `${ch.name} gets ${n} XP`, { character: id, amount: n });
    addXp(rt, ch, n);
  }
}

export function giveGoldCommand(rt: Runtime, target: string, amount: number): void {
  const n = Math.round(amountOk(amount));
  for (const id of targets(rt, target)) {
    const ch = rt.game.characters[id]!;
    addGold(rt, ch, n);
    rt.emit('core:gold-given', `${ch.name} gets ${n} gold`, { character: id, amount: n });
  }
}

export function giveItemCommand(rt: Runtime, target: string, item: string): void {
  const ids = targets(rt, target);
  if (!rt.reg.items.has(item)) throw new Rejection(`Unknown item '${item}'`, 'unknown-content');
  for (const id of ids) giveItem(rt, charRef(id), item, 1);
}

export function postMessage(rt: Runtime, text: string): void {
  rt.emit('core:message', text, {});
}
