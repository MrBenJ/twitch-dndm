import { currentFight } from './entities';
import { finishEncounter } from './encounters';
import { refreshFight } from './fight';
import { drainReactions } from './hooks';
import type { Runtime } from './runtime';

/** Run queued reactions, end encounters that should end, and update the fight's sub-state, until nothing changes. */
export function settle(rt: Runtime): void {
  for (let i = 0; i < 100; i++) {
    drainReactions(rt);
    const enc = rt.game.session?.encounter ?? null;
    if (rt.pendingEnd !== null) {
      const outcome = rt.pendingEnd;
      rt.pendingEnd = null;
      if (enc) { finishEncounter(rt, outcome); continue; }
    }
    const f = currentFight(rt);
    if (f && f.monsters.every((m) => m.knockedOut)) { finishEncounter(rt, 'won'); continue; }
    if (f) refreshFight(rt, f);
    if (!rt.queue.length && rt.pendingEnd === null) return;
  }
  throw new Error('settle() did not converge');
}
