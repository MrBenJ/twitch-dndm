import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('gear', () => {
  it('equips owned items, locks during fights, unlocks after', () => {
    const h = harness();
    h.open(); h.join('al');
    expect(h.fail({ type: 'equip', character: 'al', item: 'tp:vest' }).code).toBe('not-owned');
    h.do({ type: 'giveItem', target: 'al', item: 'tp:vest' });
    h.do({ type: 'equip', character: 'al', item: 'tp:vest' });
    expect(h.char('al').equipped['tp:body']).toBe('tp:vest');
    h.spawn();
    expect(h.fail({ type: 'equip', character: 'al', item: 'tp:rod' }).code).toBe('gear-locked');
    h.do({ type: 'endEncounter' });
    h.do({ type: 'equip', character: 'al', item: 'tp:rod' });
  });

  it('gearLockDuringCombat off allows swaps mid-fight; non-gear and class slot rules', () => {
    const h = harness({ settings: { 'gear-lock-during-combat': false } });
    h.open(); h.join('al'); h.spawn();
    h.do({ type: 'equip', character: 'al', item: 'tp:rod' });
    h.do({ type: 'giveItem', target: 'al', item: 'tp:biscuit' });
    expect(h.fail({ type: 'equip', character: 'al', item: 'tp:biscuit' }).code).toBe('not-gear');
    expect(h.fail({ type: 'unequip', character: 'al', slot: 'tp:hand' }).code).toBe('class-slot');
    expect(h.fail({ type: 'unequip', character: 'al', slot: 'tp:body' }).code).toBe('empty-slot');
  });

  it('a gear change that lowers max HP caps saved HP; a rise does not heal', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'giveItem', target: 'al', item: 'tp:vest' });
    h.do({ type: 'equip', character: 'al', item: 'tp:vest' });
    expect(h.char('al').hp).toBe(100);
    h.do({ type: 'healPlayer', character: 'al', amount: 'full' });
    expect(h.char('al').hp).toBe(120);
    h.do({ type: 'unequip', character: 'al', slot: 'tp:body' });
    expect(h.char('al').hp).toBe(100);
  });

  it('banned characters cannot change gear; characters outside a session can', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'giveItem', target: 'al', item: 'tp:vest' });
    h.do({ type: 'closeSession' });
    h.do({ type: 'equip', character: 'al', item: 'tp:vest' });
    h.do({ type: 'banPlayer', character: 'al' });
    expect(h.fail({ type: 'unequip', character: 'al', slot: 'tp:body' }).code).toBe('banned');
  });
});
