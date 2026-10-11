import { describe, expect, it } from 'vitest';
import { createEngine } from '../src';
import {
  abilitiesOf, charRef, classOf, effectiveEquipped, maxHp, stat, xpToReach,
} from '../src/entities';
import { Runtime } from '../src/runtime';
import { newCharacter, newGameState } from '../src/state';
import { tpBundle, tpChannel } from './helpers/tp-pack';

function rtWith(channel = tpChannel(), extra: unknown[] = []) {
  const engine = createEngine({ packs: [tpBundle(extra)], channel });
  const game = newGameState(1);
  const rt = new Runtime(engine.registry, game);
  return { rt, game };
}

describe('entities', () => {
  it('computes stats from default, level, class and gear', () => {
    const { rt, game } = rtWith();
    const ch = newCharacter('al', 'Al');
    ch.equipped['tp:hand'] = 'tp:mallet';
    ch.inventory['tp:mallet'] = 1;
    game.characters.al = ch;
    expect(classOf(rt, ch)?.id).toBe('tp:brute');
    expect(stat(rt, charRef('al'), 'tp:power')).toBe(5 + 5 + 2);
    ch.level = 3;
    expect(stat(rt, charRef('al'), 'tp:power')).toBe(5 + 2 + 5 + 2);
  });

  it('computes max HP from settings, level, class and gear', () => {
    const { rt, game } = rtWith();
    const ch = newCharacter('mo', 'Mo');
    ch.equipped['tp:hand'] = 'tp:rod';
    ch.equipped['tp:body'] = 'tp:vest';
    ch.inventory['tp:vest'] = 1;
    game.characters.mo = ch;
    expect(maxHp(rt, charRef('mo'))).toBe(100 - 10 + 20);
    ch.level = 2;
    expect(maxHp(rt, charRef('mo'))).toBe(100 + 5 - 10 + 20);
  });

  it('only counts owned, resolvable gear', () => {
    const { rt, game } = rtWith();
    const ch = newCharacter('al', 'Al');
    ch.equipped['tp:body'] = 'tp:vest';
    game.characters.al = ch;
    expect(effectiveEquipped(rt, ch)).toEqual([]);
    ch.inventory['tp:vest'] = 1;
    expect(effectiveEquipped(rt, ch).map(([s, i]) => [s, i.id])).toEqual([['tp:body', 'tp:vest']]);
  });

  it('falls back to the first starting item when the class item is dormant', () => {
    const { rt, game } = rtWith();
    const ch = newCharacter('al', 'Al');
    ch.equipped['tp:hand'] = 'gone:wand';
    ch.inventory['gone:wand'] = 1;
    game.characters.al = ch;
    expect(effectiveEquipped(rt, ch).map(([s, i]) => [s, i.id])).toEqual([['tp:hand', 'tp:club']]);
    expect(classOf(rt, ch)?.id).toBe('tp:brute');
  });

  it('a character with no class item has no class', () => {
    const { rt, game } = rtWith();
    game.characters.al = newCharacter('al', 'Al');
    expect(classOf(rt, game.characters.al)).toBeNull();
    expect(abilitiesOf(rt, game.characters.al)).toEqual([]);
  });

  it('lists abilities from class, gear and consumables, skipping duplicates', () => {
    const { rt, game } = rtWith();
    const ch = newCharacter('mo', 'Mo');
    ch.equipped['tp:hand'] = 'tp:rod';
    ch.inventory['tp:biscuit'] = 2;
    game.characters.mo = ch;
    expect(abilitiesOf(rt, ch)).toEqual([
      { ability: 'tp:whack', from: 'class' },
      { ability: 'tp:mend', from: 'class' },
      { ability: 'tp:wake', from: 'class' },
      { ability: 'tp:snack', from: 'item', item: 'tp:biscuit' },
    ]);
  });

  it('xpToReach follows the curve', () => {
    const { rt } = rtWith();
    expect([1, 2, 3, 4].map((l) => xpToReach(rt, l))).toEqual([0, 80, 210, 390]);
  });
});
