import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/errors';
import { buildRegistry } from '../src/registry';
import { tpBundle, tpChannel } from './helpers/tp-pack';

const errorsOf = (fn: () => unknown): string[] => {
  try { fn(); } catch (e) {
    if (e instanceof ValidationError) return e.issues.filter((i) => i.level === 'error').map((i) => `${i.pack} ${i.path}: ${i.message}`);
    throw e;
  }
  return [];
};

describe('normalization', () => {
  it('normalizes tp content into definitions', () => {
    const r = buildRegistry([tpBundle()], tpChannel());
    expect(r.stats.get('tp:power')).toEqual({ id: 'tp:power', name: 'Power', icon: null, default: 5, perLevel: 1 });
    expect([...r.slots.values()].map((s) => [s.id, s.order])).toEqual([['tp:hand', 0], ['tp:body', 1]]);
    expect(r.classes.get('tp:mender')?.stats).toEqual({ 'core:hp': -10 });
    expect(r.abilities.get('tp:zap')).toMatchObject({
      cooldown: 30000, when: 'fight', target: { rule: 'tp:foe', params: {} },
      steps: [
        { effect: 'tp:poke', params: { power: 'tp:power' } },
        { effect: 'tp:poke', params: { power: '(2 * tp:power)' } },
      ],
    });
    expect(r.abilities.get('tp:lull')?.steps[0]).toEqual({
      effect: 'tp:put', params: { status: 'tp:snooze', duration: 30000, params: { factor: 1.5 } },
    });
    expect(r.items.get('tp:club')).toMatchObject({ slot: 'tp:hand', grantsClass: 'tp:brute' });
    expect(r.items.get('tp:biscuit')).toMatchObject({ use: 'tp:snack', uses: 2, slot: null });
    expect(r.monsters.get('tp:blob')).toMatchObject({
      interval: 15000, behavior: { behavior: 'tp:pile', params: { abilities: { 'tp:slam': 1 }, 'targets-per': 5 } },
      drops: [{ item: 'tp:biscuit', chance: 0.5 }],
    });
    expect(r.encounters.get('tp:chat')?.spec).toEqual({ kind: 'tp:show', params: { text: 'Hello there', 'show-for': 10000 } });
    const trip = r.adventures.get('tp:trip')!;
    expect(trip.nodes.fight).toEqual({ spec: { kind: 'core:fight', params: 'tp:blob' }, use: null, next: { won: 'end', default: 'end' } });
    expect(trip.nodes.talk).toEqual({ spec: null, use: 'tp:chat', next: 'end' });
    expect(r.settings.classSlot).toBe('tp:hand');
    expect(r.settings.startingItems).toEqual(['tp:club', 'tp:rod']);
  });

  it('reports reference, formula and param problems with paths', () => {
    const errors = errorsOf(() => buildRegistry([tpBundle([
      { ability: 'bad1', name: 'B', cooldown: '1s', target: 'nobody', steps: [{ poke: { power: 'strength' } }] },
      { ability: 'bad2', name: 'B', cooldown: 'soon', target: 'me', steps: [{ poke: {} }, { nope: {} }, { poke: { power: 'power -2' } }] },
      { class: 'bad3', name: 'B', stats: { speed: 1 }, abilities: ['missing'] },
      { item: 'bad4', name: 'B', 'grants-class': 'brute' },
      { monster: 'bad5', name: 'B', hp: 5, stats: { hp: 3 }, abilities: ['slam'], behavior: { pile: { abilities: {}, 'targets-per': 0 } } },
    ])], tpChannel()));
    expect(errors).toEqual(expect.arrayContaining([
      "tp target: Unknown targeting 'nobody'",
      "tp steps[0].poke.power: Unknown stat 'strength'",
      "tp cooldown: Invalid duration 'soon' (use 500ms, 8s, 2m or 1h)",
      'tp steps[0].poke.power: required',
      "tp steps[1]: Unknown effect 'nope'",
      "tp steps[2].poke.power: Put a space on both sides of '-' for subtraction (at 7)",
      "tp stats.speed: Unknown stat 'speed'",
      "tp abilities[0]: Unknown ability 'missing'",
      'tp grants-class: an item that grants a class needs a slot',
      "tp stats.hp: a monster's HP is set with 'hp:', not in stats",
      'tp behavior.pile.targets-per: must be at least 1',
    ]));
  });

  it('only lets a pack refer to its dependencies', () => {
    const other = { ...tpBundle(), manifest: { id: 'xx', version: '1.0.0', name: 'xx', depends: {} }, content: [
      { file: 'x.yaml', index: 0, doc: { class: 'thief', name: 'Thief', abilities: ['tp:whack'] } },
    ], register: undefined };
    expect(errorsOf(() => buildRegistry([tpBundle(), other], tpChannel({ packs: ['tp', 'xx'] }))))
      .toContain("xx abilities[0]: 'tp:whack': xx doesn't depend on tp");
  });

  it('validates adventures: start, next targets, outcomes and reachability', () => {
    const errors = errorsOf(() => buildRegistry([tpBundle([{
      adventure: 'broken', name: 'B', start: 'nowhere',
      nodes: {
        a: { show: { text: 'x' }, next: 'ghost' },
        b: { ballot: { choices: { x: 'X' }, time: '5s' }, next: { y: 'a', ended: 'a', default: 'a' } },
        c: { fight: 'blob', next: { lost: 'a' } },
        d: { show: { text: 'x' }, ballot: { choices: {}, time: '1s' } },
      },
    }])], tpChannel()));
    expect(errors).toEqual(expect.arrayContaining([
      "tp start: no node called 'nowhere'",
      "tp nodes.a.next: no node called 'ghost'",
      "tp nodes.b.next.y: 'y' isn't an outcome of this node (outcomes: x, ended)",
      "tp nodes.c.next.lost: 'lost' isn't an outcome of this node (outcomes: won, ended)",
      'tp nodes.d: a node needs exactly one encounter kind or use (found: show, ballot)',
    ]));
  });

  it('warns when grants-class is outside the class slot', () => {
    const r = buildRegistry([tpBundle([{ item: 'badge', name: 'Badge', slot: 'body', 'grants-class': 'brute' }])], tpChannel());
    expect(r.items.get('tp:badge')?.grantsClass).toBeNull();
    expect(r.warnings.map((w) => w.message)).toContain("grants-class is ignored: tp:badge isn't in the class slot");
  });

  it('works with no class slot and no classes at all', () => {
    const r = buildRegistry([tpBundle()], { packs: ['tp'] });
    expect(r.settings.classSlot).toBeNull();
    expect([...r.items.values()].every((i) => i.grantsClass === null)).toBe(true);
  });
});

describe('dormancy', () => {
  const channelPack = (content: unknown[], deleted: string[] = []) => ({ 'channel-pack': { content, deleted } });

  it('makes channel content that refers to a disabled pack dormant, through chains', () => {
    const r = buildRegistry([tpBundle()], tpChannel({
      packs: [],
      settings: { 'class-slot': 'tp:hand', 'starting-items': ['tp:club'] },
      ...channelPack([
        { monster: 'grub', name: 'Grub', hp: 10, abilities: ['tp:slam'], behavior: { 'tp:pile': { abilities: { 'tp:slam': 1 }, 'targets-per': 5 } } },
        { adventure: 'hunt', name: 'Hunt', start: 'go', nodes: { go: { fight: 'grub' } } },
        { slot: 'paw', name: 'Paw' },
      ]),
    }));
    expect(r.monsters.has('channel:grub')).toBe(false);
    expect(r.adventures.has('channel:hunt')).toBe(false);
    expect(r.slots.has('channel:paw')).toBe(true);
    expect([...r.dormant].sort()).toEqual(['adventure channel:hunt', 'monster channel:grub']);
    expect(r.settings.classSlot).toBeNull();
    expect(r.settings.startingItems).toEqual([]);
    expect(r.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('treats deleted channel content as dormant but typos as errors', () => {
    const ok = buildRegistry([tpBundle()], tpChannel({
      ...channelPack([{ adventure: 'old', name: 'Old', start: 'go', nodes: { go: { fight: 'gone' } } }], ['gone']),
    }));
    expect(ok.dormant.has('adventure channel:old')).toBe(true);

    expect(errorsOf(() => buildRegistry([tpBundle()], tpChannel({
      ...channelPack([{ adventure: 'old', name: 'Old', start: 'go', nodes: { go: { fight: 'gnoe' } } }]),
    })))).toContain("channel nodes.go.fight: Unknown monster 'gnoe'");

    expect(errorsOf(() => buildRegistry([tpBundle()], tpChannel({ settings: { 'starting-items': ['tp:clbu'] } }))))
      .toContain("channel settings.starting-items[0]: Unknown item 'tp:clbu'");
  });

  it('keeps overrides for dormant content as warnings', () => {
    const r = buildRegistry([tpBundle()], { packs: [], overrides: { 'tp:zap': { cooldown: '1s' } } });
    expect(r.warnings.map((w) => w.message)).toContain("override for tp:zap is kept but ignored: it's dormant");
  });

  it('resolves bare IDs in the channel pack to channel content, then core', () => {
    const r = buildRegistry([tpBundle()], tpChannel({
      ...channelPack([
        { monster: 'grub', name: 'Grub', hp: 10, abilities: ['tp:slam'], behavior: { 'tp:pile': { abilities: { 'tp:slam': 1 }, 'targets-per': 5 } } },
        { encounter: 'scrap', fight: 'grub' },
      ]),
    }));
    expect(r.encounters.get('channel:scrap')?.spec).toEqual({ kind: 'core:fight', params: 'channel:grub' });
  });

  it('applies the no-source rule to steps marked noSource', () => {
    const bundle = tpBundle();
    const inner = bundle.register!;
    bundle.register = (api) => {
      inner(api);
      api.encounterKind('pit', {
        name: 'Pit', params: (({ t: 'object', fields: { steps: { t: 'steps', noSource: true } } }) as const),
        outcomes: () => ['done'], start: () => ({}), respond: (_c, s) => s, wakeAt: () => null,
        advance: (_c, s) => s, endEarly: () => 'done', panel: () => ({ type: 'none' }), overlay: () => null,
      });
    };
    bundle.content.push({ file: 'tp.yaml', index: 99, doc: { encounter: 'drop', pit: { steps: [{ poke: { power: 'power' } }, { poke: { power: 'target.power * 2' } }] } } });
    expect(errorsOf(() => buildRegistry([bundle], tpChannel())))
      .toEqual(["tp pit.steps[0].poke.power: This formula has no source; use target.<stat> or numbers"]);
  });
});
