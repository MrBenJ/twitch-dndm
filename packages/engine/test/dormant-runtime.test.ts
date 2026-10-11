import { describe, expect, it } from 'vitest';
import { createEngine } from '../src';
import type { PackBundle } from '../src/pack';
import { tpBundle, tpChannel } from './helpers/tp-pack';

const extra: PackBundle = {
  manifest: { id: 'ex', version: '1.0.0', name: 'Extra', depends: { tp: '^1.0.0' } },
  official: true,
  content: [
    { file: 'ex.yaml', index: 0, doc: { item: 'wand', name: 'Wand', slot: 'tp:hand', 'grants-class': 'tp:mender', stats: { 'tp:power': 3 } } },
    { file: 'ex.yaml', index: 1, doc: { item: 'cape', name: 'Cape', slot: 'tp:body', stats: { hp: 30 } } },
    { file: 'ex.yaml', index: 2, doc: { item: 'gem', name: 'Gem', price: 5 } },
  ],
};

describe('dormancy at runtime (success criterion 5)', () => {
  it('turning a pack off and on restores items and equipment exactly', () => {
    const on = createEngine({ packs: [tpBundle(), extra], channel: tpChannel({ packs: ['tp', 'ex'] }) });
    const off = createEngine({ packs: [tpBundle(), extra], channel: tpChannel({ packs: ['tp'] }) });
    let game = on.newGame({ seed: 1 });
    const run = (engine: typeof on, cmd: Parameters<typeof on.apply>[1]) => {
      const r = engine.apply(game, cmd, 0);
      if (!r.ok) throw new Error(r.error.message);
      game = r.game;
    };
    run(on, { type: 'openSession' });
    run(on, { type: 'join', character: 'al', name: 'Al', pick: 'tp:club' });
    for (const item of ['ex:wand', 'ex:cape', 'ex:gem']) run(on, { type: 'giveItem', target: 'al', item });
    run(on, { type: 'equip', character: 'al', item: 'ex:wand' });
    run(on, { type: 'equip', character: 'al', item: 'ex:cape' });
    const before = structuredClone(game.characters.al);

    game = off.adopt(game);
    const v = off.view(game, 'al', 0);
    expect(v.character!.class).toBe('tp:brute');
    expect(v.character!.inventory['ex:gem']).toEqual({ count: 1, dormant: true });
    expect(v.character!.maxHp).toBe(100);
    expect(off.apply(game, { type: 'equip', character: 'al', item: 'ex:cape' }, 0)).toMatchObject({ ok: false, error: { code: 'not-owned' } });

    game = on.adopt(game);
    expect(game.characters.al).toEqual(before);
    expect(on.view(game, 'al', 0).character!.class).toBe('tp:mender');
  });

  it('a character who swaps a dormant class item keeps it in the inventory', () => {
    const on = createEngine({ packs: [tpBundle(), extra], channel: tpChannel({ packs: ['tp', 'ex'] }) });
    const off = createEngine({ packs: [tpBundle(), extra], channel: tpChannel({ packs: ['tp'] }) });
    let game = on.newGame({ seed: 1 });
    for (const cmd of [
      { type: 'openSession' }, { type: 'join', character: 'al', name: 'Al', pick: 'tp:club' },
      { type: 'giveItem', target: 'al', item: 'ex:wand' }, { type: 'equip', character: 'al', item: 'ex:wand' },
    ] as const) game = (on.apply(game, cmd, 0) as { game: typeof game }).game;
    game = (off.apply(game, { type: 'equip', character: 'al', item: 'tp:rod' }, 0) as { game: typeof game }).game;
    game = on.adopt(game);
    expect(game.characters.al!.equipped['tp:hand']).toBe('tp:rod');
    expect(game.characters.al!.inventory['ex:wand']).toBe(1);
  });
});
