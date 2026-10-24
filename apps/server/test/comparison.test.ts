import { type Command, createEngine, type Engine, type GameState } from '@dndm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { comparisonView } from '../src/comparison';
import { defaultConfig, officialBundles } from '../src/server';

let engine: Engine;
beforeAll(async () => {
  engine = createEngine({ packs: await officialBundles(), channel: defaultConfig() });
});

function play(cmds: [number, Command][]): GameState {
  let game = engine.newGame({ seed: 1 });
  for (const [at, cmd] of cmds) {
    const r = engine.apply(game, cmd, at);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    game = r.game;
  }
  return game;
}

const fightCmds: [number, Command][] = [
  [0, { type: 'openSession' }],
  [0, { type: 'join', character: 'al', name: 'Al', pick: 'starter:sword' }],
  [0, { type: 'spawnMonster', monster: 'starter:slime' }],
  [0, { type: 'holdMonster' }],
];

describe('comparisonView (spec 2b §5.2)', () => {
  it('ignores targets and a running cooldown, and keeps the cooldown end time', () => {
    const t = 1000;
    const game = play([...fightCmds, [t, { type: 'use', character: 'al', ability: 'starter:attack' }]]);
    const cooldownEnd = game.characters.al!.cooldowns['starter:attack']!;
    expect(cooldownEnd).toBeGreaterThan(t);
    // The real view says the attack is on cooldown.
    expect(engine.view(game, 'al', t).abilities[0]!.ready).toBe(false);
    const during = comparisonView(engine, game, 'al', t);
    const later = comparisonView(engine, game, 'al', cooldownEnd + 1);
    const a = JSON.parse(during).abilities[0];
    expect(a.ability).toBe('starter:attack');
    expect(a.targets).toBeUndefined();
    expect(a.ready).toBe(true);
    expect(a.reason).toBeNull();
    expect(a.readyAt).toBe(cooldownEnd);
    expect(later).toBe(during);
    // The game itself is untouched.
    expect(game.characters.al!.cooldowns['starter:attack']).toBe(cooldownEnd);
  });

  it('a knockout still flips ready', () => {
    const before = comparisonView(engine, play(fightCmds), 'al', 0);
    const game = play([...fightCmds, [0, { type: 'knockOut', character: 'al' }]]);
    const after = comparisonView(engine, game, 'al', 0);
    expect(after).not.toBe(before);
    const a = JSON.parse(after).abilities[0];
    expect(a.ready).toBe(false);
    expect(a.reason).toBe("You're knocked out");
  });

  it('holds the character, the panel and the abilities', () => {
    const parsed = JSON.parse(comparisonView(engine, play(fightCmds), 'al', 0));
    expect(Object.keys(parsed)).toEqual(['character', 'panel', 'abilities']);
    expect(parsed.character.id).toBe('al');
    expect(parsed.abilities.map((a: { readyAt: unknown }) => a.readyAt)).toEqual([null, null]);
  });
});
