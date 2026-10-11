import type { EncounterSpec } from './content';
import { makeCtx, resolveFor, runtimeNormalizeCtx } from './ctx';
import { charRef, currentFight, partyRefs } from './entities';
import { Rejection } from './errors';
import { endFight, startFight } from './fight';
import { callPlugin, react } from './hooks';
import { CHANNEL } from './ids';
import type { EntityRef } from './pack';
import { normalizeParams, p } from './params';
import { CORE_FIGHT } from './registry';
import type { Runtime } from './runtime';
import { clearRemovals } from './session';
import { isFight, type KindEncounterState, type Origin, type SessionState } from './state';

export function requireResting(rt: Runtime): SessionState {
  const s = rt.game.session;
  if (!s) throw new Rejection('No session is open', 'no-session');
  if (s.encounter) throw new Rejection('An encounter is already running', 'busy');
  return s;
}

function present(rt: Runtime): { ref: EntityRef; role: 'present' }[] {
  const monsters = (currentFight(rt)?.monsters ?? []).map((m) => ({ ref: { kind: 'monster' as const, id: m.id }, role: 'present' as const }));
  return [...partyRefs(rt).map((ref) => ({ ref, role: 'present' as const })), ...monsters];
}

export function startEncounter(rt: Runtime, spec: EncounterSpec, origin: Origin | null): void {
  const s = requireResting(rt);
  if (spec.kind === CORE_FIGHT) { startFight(rt, spec.params as string, origin); return; }
  const kind = rt.reg.kinds.get(spec.kind);
  if (!kind) throw new Rejection('Unknown encounter kind', 'unknown-content');
  const enc: KindEncounterState = { kind: spec.kind, startedAt: rt.now, origin, params: spec.params, state: null };
  s.encounter = enc;
  enc.state = callPlugin(kind.pack, `${kind.id} start`, () => kind.def.start(makeCtx(rt, kind.pack), spec.params));
  rt.emit('core:encounter-started', `${kind.def.name} begins`, { kind: spec.kind });
  react(rt, { type: 'encounterStarted', kind: spec.kind }, present(rt));
}

/** Command form: an encounter ID, or an inline `{ <kind>: params }`. */
export function startEncounterCommand(rt: Runtime, encounter: string | Record<string, unknown>): void {
  if (typeof encounter === 'string') {
    const def = rt.reg.encounters.get(encounter);
    if (!def) throw new Rejection(`Unknown encounter '${encounter}'`, 'unknown-content');
    return startEncounter(rt, def.spec, null);
  }
  const entries = Object.entries(encounter);
  if (entries.length !== 1) throw new Rejection('Give exactly one encounter kind', 'invalid-input');
  const [key, raw] = entries[0]!;
  const kindId = resolveFor(rt, CHANNEL, 'encounterKind', key);
  const kind = rt.reg.kinds.get(kindId);
  if (!kind) throw new Rejection(`Unknown encounter kind '${key}'`, 'unknown-content');
  const nctx = runtimeNormalizeCtx(rt, CHANNEL);
  const params = normalizeParams(kind.def.params ?? p.object({}), raw ?? {}, nctx, key);
  if (nctx.issues.length) throw new Rejection(nctx.issues[0]!, 'invalid-input');
  if (!kind.builtin && kind.def.validate) {
    const problems = callPlugin(kind.pack, `${kind.id} validate`, () => kind.def.validate!(params));
    if (problems.length) throw new Rejection(problems[0]!, 'invalid-input');
  }
  return startEncounter(rt, { kind: kindId, params }, null);
}

function allowedOutcomes(rt: Runtime): string[] {
  const enc = rt.game.session!.encounter!;
  if (isFight(enc)) return ['won', 'ended'];
  const kind = rt.reg.kinds.get(enc.kind)!;
  return [...callPlugin(kind.pack, `${kind.id} outcomes`, () => kind.def.outcomes(enc.params)), 'ended'];
}

export function endEncounterCommand(rt: Runtime, outcome: string | undefined): void {
  const enc = rt.game.session?.encounter;
  if (!enc) throw new Rejection('No encounter is running', 'no-encounter');
  let o = outcome;
  if (o !== undefined) {
    if (!allowedOutcomes(rt).includes(o)) throw new Rejection(`That encounter can't end with '${o}'`, 'bad-outcome');
  } else if (isFight(enc)) {
    o = 'ended';
  } else {
    const kind = rt.reg.kinds.get(enc.kind)!;
    o = callPlugin(kind.pack, `${kind.id} endEarly`, () => kind.def.endEarly(enc.state, enc.params));
  }
  finishEncounter(rt, o);
}

export function finishEncounter(rt: Runtime, outcome: string): void {
  const s = rt.game.session!;
  const enc = s.encounter!;
  if (!allowedOutcomes(rt).includes(outcome)) {
    throw new Error(`Encounter ${enc.kind} can't end with '${outcome}'`);
  }
  if (isFight(enc)) endFight(rt, enc, outcome);
  else {
    const kind = rt.reg.kinds.get(enc.kind)!;
    if (kind.def.onEnd) callPlugin(kind.pack, `${kind.id} onEnd`, () => kind.def.onEnd!(makeCtx(rt, kind.pack), enc.state, outcome, enc.params));
  }
  const who = present(rt);
  s.encounter = null;
  rt.emit('core:encounter-ended', `The encounter ends (${outcome})`, { kind: enc.kind, outcome });
  react(rt, { type: 'encounterEnded', kind: enc.kind, outcome }, who);
  clearRemovals(rt);
  if (enc.origin && s.adventure && s.adventure.id === enc.origin.adventure) {
    const adv = rt.reg.adventures.get(enc.origin.adventure);
    const next = adv?.nodes[enc.origin.node]?.next ?? null;
    const target = typeof next === 'string' ? next : next ? next[outcome] ?? next.default ?? null : null;
    if (!target) {
      s.adventure = null;
      rt.emit('core:adventure-finished', `${adv?.name ?? 'The adventure'} is complete`, { adventure: enc.origin.adventure });
    } else {
      s.adventure.lined = target;
      rt.emit('core:adventure-lined-up', `Next up: ${target}`, { adventure: enc.origin.adventure, node: target });
    }
  }
}

/** Filled in by Task 6. */
export function respond(_rt: Runtime, _id: string, _input: unknown): void {
  throw new Rejection('Not implemented yet', 'not-implemented');
}

export function kindWake(rt: Runtime): void {
  const enc = rt.game.session?.encounter;
  if (!enc || isFight(enc)) return;
  const kind = rt.reg.kinds.get(enc.kind)!;
  enc.state = callPlugin(kind.pack, `${kind.id} advance`, () => kind.def.advance(makeCtx(rt, kind.pack), enc.state, enc.params));
}
