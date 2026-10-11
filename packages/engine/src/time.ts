import { charRef, currentFight, monsterRef, statusList } from './entities';
import { kindWake } from './encounters';
import { PluginError, Rejection } from './errors';
import { fightInterval, monsterTurn } from './fight';
import { callPlugin, react } from './hooks';
import { endKnockout, removeStatus } from './ops';
import { makeCtx } from './ctx';
import type { EntityRef } from './pack';
import type { Runtime } from './runtime';
import { settle } from './settle';
import { isFight, type StatusInstance } from './state';
import { parseDuration } from './units';

export interface Due { at: number; order: number; key: string; run(rt: Runtime): void; skip(rt: Runtime): void }

function find(rt: Runtime, ref: EntityRef, seq: number): StatusInstance | undefined {
  try { return statusList(rt, ref).find((s) => s.seq === seq); } catch { return undefined; }
}

function statusDue(rt: Runtime, ref: EntityRef, list: StatusInstance[], out: Due[]): void {
  for (const s of list) {
    const reg = rt.reg.statuses.get(s.status);
    if (!reg) continue;
    const key = `${ref.kind}:${ref.id}:${s.seq}`;
    if (s.until !== null) {
      out.push({
        at: s.until, order: 1, key,
        run: (r) => removeStatus(r, ref, s.status, 'expired', s.seq),
        skip: (r) => { const list2 = statusList(r, ref); const i = list2.findIndex((x) => x.seq === s.seq); if (i >= 0) list2.splice(i, 1); },
      });
    }
    if (s.nextTick !== null && reg.def.tick && (s.until === null || s.nextTick < s.until)) {
      const every = parseDuration(reg.def.tick.every);
      out.push({
        at: s.nextTick, order: 2, key,
        run: (r) => {
          const inst = find(r, ref, s.seq)!;
          inst.nextTick = inst.nextTick! + every;
          callPlugin(reg.pack, `${reg.id} tick`, () => reg.def.tick!.run(makeCtx(r, reg.pack), { holder: ref, params: inst.params, source: inst.source }));
        },
        skip: (r) => { const inst = find(r, ref, s.seq); if (inst) inst.nextTick = inst.nextTick! + every; },
      });
    }
  }
}

export function dueItems(rt: Runtime): Due[] {
  const out: Due[] = [];
  for (const ch of Object.values(rt.game.characters)) {
    if (ch.knockedOutUntil !== null) {
      const id = ch.id;
      out.push({
        at: ch.knockedOutUntil, order: 0, key: id,
        run: (r) => endKnockout(r, id),
        skip: (r) => { const c = r.game.characters[id]!; c.knockedOutUntil = null; c.hp = Math.max(1, c.hp); },
      });
    }
    statusDue(rt, charRef(ch.id), ch.statuses, out);
  }
  const f = currentFight(rt);
  if (f) {
    for (const m of f.monsters) statusDue(rt, monsterRef(m.id), m.statuses, out);
    if (f.sub === 'fighting' && !f.held && f.nextTurnAt !== null) {
      out.push({
        at: f.nextTurnAt, order: 3, key: 'turn',
        run: (r) => monsterTurn(r, currentFight(r)!),
        skip: (r) => { const ff = currentFight(r)!; ff.nextTurnAt = r.now + fightInterval(r, ff); },
      });
    }
  }
  const enc = rt.game.session?.encounter;
  if (enc && !isFight(enc)) {
    const kind = rt.reg.kinds.get(enc.kind);
    if (kind) {
      const at = callPlugin(kind.pack, `${kind.id} wakeAt`, () => kind.def.wakeAt(enc.state));
      if (at !== null) out.push({ at, order: 4, key: 'wake', run: (r) => kindWake(r), skip: (r) => forceEnd(r) });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function forceEnd(rt: Runtime): void {
  const s = rt.game.session;
  if (!s?.encounter) return;
  const kind = s.encounter.kind;
  s.encounter = null;
  rt.emit('core:encounter-ended', 'The encounter was stopped after an error', { kind, outcome: 'ended' });
  react(rt, { type: 'encounterEnded', kind, outcome: 'ended' }, []);
}

/** Runs one time step; on a plugin error rolls it back, skips that timer and emits core:plugin-error. */
export function runGuarded(rt: Runtime, run: () => void, skip: () => void): void {
  const snapshot = structuredClone(rt.game);
  const count = rt.events.length;
  try {
    run();
  } catch (e) {
    if (!(e instanceof PluginError || e instanceof Rejection)) throw e;
    rt.game = snapshot;
    rt.events.length = count;
    rt.queue = [];
    rt.pendingEnd = null;
    rt.depth = 0;
    skip();
    rt.emit('core:plugin-error', e.message, {});
  }
}

export function advanceTo(rt: Runtime, target: number): void {
  for (let i = 0; ; i++) {
    if (i > 100_000) throw new Error('Too many timed events at once; a pack may be scheduling in a loop');
    const next = dueItems(rt)[0];
    if (!next || next.at > target) break;
    rt.now = Math.max(rt.now, next.at);
    rt.depth = 0;
    rt.limitHit = false;
    runGuarded(rt, () => { next.run(rt); settle(rt); }, () => next.skip(rt));
  }
  rt.now = Math.max(rt.now, target);
}

export function nextWake(rt: Runtime): number | null {
  return dueItems(rt)[0]?.at ?? null;
}
