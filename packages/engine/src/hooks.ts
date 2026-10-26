import { makeCtx } from './ctx';
import { entityExists, holders } from './entities';
import { EngineError, PluginError, Rejection } from './errors';
import type { EntityRef, Modifiers, ReactionEvent, ReactionRole } from './pack';
import type { Runtime } from './runtime';

export const MAX_DEPTH = 8;

export interface ReactionJob { event: ReactionEvent; ref: EntityRef; role: ReactionRole; depth: number; audience?: string[] }

/** Run pack code; tag unexpected throws with the pack and plugin. */
export function callPlugin<T>(pack: string, label: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Rejection || e instanceof PluginError || e instanceof EngineError) throw e;
    throw new PluginError(pack, label, e);
  }
}

export function modify<K extends keyof Modifiers>(
  rt: Runtime, holder: EntityRef, point: K, value: Parameters<Modifiers[K]>[0], extra: Record<string, unknown>,
): Parameters<Modifiers[K]>[0] {
  let v = value;
  for (const h of holders(rt, holder)) {
    const fn = h.hooks.modify?.[point] as ((value: unknown, info: unknown) => unknown) | undefined;
    if (!fn) continue;
    const next = callPlugin(h.pack, `${h.label} modify.${point}`, () =>
      fn(v, { ctx: makeCtx(rt, h.pack), holder, params: h.params, ...extra })) as typeof v;
    if (validResult(point, next)) v = next;
    else rt.emit('core:plugin-error', `${h.label} modify.${point} returned ${JSON.stringify(next) ?? 'nothing'}; it was ignored`, {});
  }
  return v;
}

/** A modifier's result must keep the value's shape; anything else (NaN, undefined, Infinity) is ignored. */
function validResult(point: keyof Modifiers, v: unknown): boolean {
  if (point === 'canUse') return v === true || typeof v === 'string';
  if (point === 'rewardsReceived') {
    const r = v as { xp?: unknown; gold?: unknown } | null;
    return !!r && typeof r.xp === 'number' && Number.isFinite(r.xp) && typeof r.gold === 'number' && Number.isFinite(r.gold);
  }
  return typeof v === 'number' && Number.isFinite(v);
}

export function react(rt: Runtime, event: ReactionEvent, recipients: { ref: EntityRef; role: ReactionRole }[]): void {
  for (const r of recipients) {
    rt.queue.push({
      event, ref: r.ref, role: r.role, depth: rt.depth + 1,
      ...(rt.reactionAudience ? { audience: [...rt.reactionAudience] } : {}),
    });
  }
}

export function drainReactions(rt: Runtime): void {
  while (rt.queue.length) {
    const job = rt.queue.shift()!;
    if (job.depth > MAX_DEPTH) {
      if (!rt.limitHit) {
        rt.limitHit = true;
        rt.emit('core:reaction-limit', 'A chain of reactions was stopped', {}, job.audience);
      }
      continue;
    }
    if (!entityExists(rt, job.ref)) continue;
    const prev = rt.depth;
    const prevAudience = rt.reactionAudience;
    rt.depth = job.depth;
    rt.reactionAudience = job.audience ?? null;
    try {
      for (const h of holders(rt, job.ref)) {
        const fn = h.hooks.react?.[job.event.type] as ((info: unknown) => void) | undefined;
        if (!fn) continue;
        callPlugin(h.pack, `${h.label} react.${job.event.type}`, () =>
          fn({ ctx: makeCtx(rt, h.pack), holder: job.ref, params: h.params, role: job.role, event: job.event }));
      }
    } finally {
      rt.depth = prev;
      rt.reactionAudience = prevAudience;
    }
  }
}
