import { describe, expect, it } from 'vitest';
import type { Command } from '../src';
import { harness } from './helpers/harness';

const SCRIPT: [number, Command][] = [
  [0, { type: 'openSession' }],
  [0, { type: 'join', character: 'al', name: 'Al', pick: 'tp:club' }],
  [0, { type: 'join', character: 'mo', name: 'Mo', pick: 'tp:rod' }],
  [0, { type: 'join', character: 'cy', name: 'Cy', pick: 'tp:club' }],
  [0, { type: 'spawnMonster', monster: 'tp:ogre' }],
  [1000, { type: 'use', character: 'al', ability: 'tp:zap' }],
  [2000, { type: 'use', character: 'cy', ability: 'tp:whack' }],
  [16000, { type: 'use', character: 'mo', ability: 'tp:mend', chosen: { kind: 'character', id: 'al' } }],
  [31000, { type: 'use', character: 'al', ability: 'tp:whack' }],
  [41000, { type: 'use', character: 'cy', ability: 'tp:whack' }],
  [61000, { type: 'endEncounter', outcome: 'won' }],
  [62000, { type: 'closeSession' }],
];

function play(seed: number) {
  const h = harness({ seed });
  for (const [at, cmd] of SCRIPT) {
    h.at(at);
    const r = h.engine.apply(h.game, cmd, at);
    if (r.ok) { h.game = r.game; h.log.push(...r.events); }
    else h.log.push({ type: 'rejected', at, text: r.error.message, data: { code: r.error.code } });
  }
  return { events: h.log, game: h.game };
}

describe('determinism and the full loop (success criteria 2 and 4)', () => {
  it('the same seed and script give identical events and state', () => {
    const a = play(7);
    const b = play(7);
    expect(a.events).toEqual(b.events);
    expect(a.game).toEqual(b.game);
  });

  it('a different seed can change the outcome', () => {
    expect(JSON.stringify(play(7).events)).not.toEqual(JSON.stringify(play(8).events));
  });

  it('runs a whole fight with only the test pack loaded', () => {
    const { events, game } = play(7);
    const types = events.map((e) => e.type);
    expect(types).toContain('core:ability-used');
    expect(types).toContain('core:encounter-ended');
    expect(types).toContain('core:session-closed');
    expect(game.characters.al!.xp).toBeGreaterThan(0);
  });
});
