import { describe, expect, it } from 'vitest';
import { createEngine, ValidationError } from '../src';
import { tpBundle, tpChannel } from './helpers/tp-pack';

describe('createEngine', () => {
  it('builds and describes a channel', () => {
    const engine = createEngine({ packs: [tpBundle()], channel: tpChannel() });
    const d = engine.describe();
    expect(d.packs).toEqual([{ id: 'tp', version: '1.0.0', name: 'Test Pack' }]);
    expect(d.classes.map((c) => c.id)).toEqual(['tp:brute', 'tp:mender']);
    expect(d.abilities.find((a) => a.id === 'tp:mend')).toMatchObject({ name: 'Mend', needsChoice: true, cooldown: 15000, when: 'fight' });
    expect(d.items.find((i) => i.id === 'tp:club')).toMatchObject({ slot: 'tp:hand', grantsClass: 'tp:brute', starting: true });
    expect(d.monsters.map((m) => m.id)).toEqual(['tp:blob', 'tp:ogre']);
    expect(d.kinds.map((k) => k.id)).toEqual(['core:fight', 'tp:show', 'tp:ballot']);
    expect(d.adventures[0]).toMatchObject({ id: 'tp:trip', start: 'intro', nodes: ['intro', 'pick', 'fight', 'talk', 'end'] });
    expect(d.settings.classSlot).toBe('tp:hand');
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it('throws ValidationError for bad input', () => {
    expect(() => createEngine({ packs: [tpBundle()], channel: { packs: ['nope'] } })).toThrow(ValidationError);
  });
});
