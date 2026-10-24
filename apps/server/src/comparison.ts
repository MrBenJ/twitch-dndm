import type { Engine, GameState } from '@dndm/engine';

/**
 * Spec 2b §5.2: what a character's view is compared by to decide whether it changed. Targets are left out, and a
 * running cooldown is ignored: `ready` and `reason` come from a view with this character's cooldowns cleared, and
 * `readyAt` is the stored cooldown end time, which changes only when the ability is used (the engine never deletes
 * cooldown entries), so a cooldown running out is not a change.
 */
export function comparisonView(engine: Engine, game: GameState, id: string, now: number): string {
  const { character, panel, abilities } = engine.view(game, id, now);
  const ch = game.characters[id];
  if (!ch) return JSON.stringify({ character, panel, abilities: [] });
  const cleared: GameState = { ...game, characters: { ...game.characters, [id]: { ...ch, cooldowns: {} } } };
  const free = engine.view(cleared, id, now).abilities;
  return JSON.stringify({
    character,
    panel,
    abilities: abilities.map(({ targets: _targets, ...a }, i) => ({
      ...a,
      ready: free[i]!.ready,
      reason: free[i]!.reason,
      readyAt: ch.cooldowns[a.ability] ?? null,
    })),
  });
}
