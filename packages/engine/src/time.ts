import type { Runtime } from './runtime';

/** Task 5 processes due timers here. For now time only moves forward. */
export function advanceTo(rt: Runtime, target: number): void {
  rt.now = Math.max(rt.now, target);
}
