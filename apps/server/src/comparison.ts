import type { Engine, GameState } from '@dndm/engine';

/**
 * Spec 2b §5.2: what a character's view is compared by to decide whether it changed. Targets are left out, and a
 * running cooldown is ignored: `ready` and `reason` are worked out as if this character had no cooldowns, and
 * `readyAt` is the stored cooldown end time, which changes only when the ability is used (the engine never deletes
 * cooldown entries), so a cooldown running out is not a change.
 */
export function comparisonView(engine: Engine, game: GameState, id: string, now: number): string {
  return comparisonViews(engine, game, [id], now).get(id)!;
}

/**
 * comparisonView for many characters in one pass: one engine.ownViews call, so one copy of the game whatever the count
 * (2b decision 18). Keyed and ordered by `ids`.
 */
export function comparisonViews(engine: Engine, game: GameState, ids: string[], now: number): Map<string, string> {
  const own = engine.ownViews(game, ids, now, { ignoreCooldowns: true });
  const out = new Map<string, string>();
  for (const id of ids) {
    const { character, panel, abilities } = own.get(id)!;
    const cooldowns = game.characters[id]?.cooldowns ?? {};
    out.set(id, JSON.stringify({
      character,
      panel,
      abilities: abilities.map((a) => ({ ...a, readyAt: cooldowns[a.ability] ?? null })),
    }));
  }
  return out;
}
