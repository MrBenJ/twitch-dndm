import type { EntityRef, Modifiers, ReactionEvent, ReactionRole } from './pack';
import type { Runtime } from './runtime';

export interface ReactionJob { event: ReactionEvent; ref: EntityRef; role: ReactionRole; depth: number }

/** Replaced in Task 2. */
export function modify<K extends keyof Modifiers>(
  _rt: Runtime, _holder: EntityRef, _point: K, value: Parameters<Modifiers[K]>[0], _extra: Record<string, unknown>,
): Parameters<Modifiers[K]>[0] {
  return value;
}
