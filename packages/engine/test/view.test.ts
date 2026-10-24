import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('view', () => {
  it('shows a character, their abilities with readiness and targets, and the fight', () => {
    const h = harness();
    h.open(); h.join('al'); h.join('mo', 'tp:rod'); h.spawn();
    h.use('al', 'tp:whack');
    const v = h.engine.view(h.game, 'mo', 1000);
    expect(v.phase).toBe('fight');
    expect(v.character).toMatchObject({ id: 'mo', class: 'tp:mender', hp: 90, maxHp: 90, inParty: true, stats: { 'tp:power': 5, 'tp:grit': 0 } });
    const mend = v.abilities.find((a) => a.ability === 'tp:mend')!;
    expect(mend).toMatchObject({ ready: true, needsChoice: true, targets: [{ kind: 'character', id: 'al' }, { kind: 'character', id: 'mo' }] });
    const alView = h.engine.view(h.game, 'al', 1000);
    expect(alView.abilities.find((a) => a.ability === 'tp:whack')).toMatchObject({ ready: false, readyAt: 10000, reason: 'On cooldown (9s)' });
    expect(v.fight).toMatchObject({ monster: { name: 'Blob', hp: 40, maxHp: 50 }, sub: 'fighting', nextTurnAt: 15000 });
    expect(v.party.map((m) => m.id)).toEqual(['al', 'mo']);
  });

  it('shows the encounter panel and overlay', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'startEncounter', encounter: { 'tp:ballot': { choices: { a: 'A' }, time: '30s' } } });
    h.do({ type: 'respond', character: 'al', input: { choice: 'a' } });
    const v = h.engine.view(h.game, 'al', 0);
    expect(v.panel).toMatchObject({ type: 'choices', selected: 'a', 'closes-at': 30000 });
    expect(h.engine.view(h.game, null, 0).panel).toEqual({ type: 'none' });
  });

  it('view does not change the game', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    const before = structuredClone(h.game);
    h.engine.view(h.game, 'al', 0);
    expect(h.game).toEqual(before);
  });

  it('ownViews gives each character their own part of view, without targets, and leaves the game alone', () => {
    const h = harness();
    h.open(); h.join('al'); h.join('mo', 'tp:rod'); h.spawn();
    h.use('al', 'tp:whack');
    const before = structuredClone(h.game);
    const own = h.engine.ownViews(h.game, ['al', 'mo', 'zz'], 1000);
    expect([...own.keys()]).toEqual(['al', 'mo', 'zz']);
    for (const id of ['al', 'mo']) {
      const v = h.engine.view(h.game, id, 1000);
      expect(own.get(id)).toEqual({ character: v.character, panel: v.panel, abilities: v.abilities.map(({ targets: _t, ...a }) => a) });
    }
    expect(own.get('zz')).toEqual({ character: null, panel: { type: 'none' }, abilities: [] });
    const free = h.engine.ownViews(h.game, ['al'], 1000, { ignoreCooldowns: true }).get('al')!;
    expect(free.abilities.find((a) => a.ability === 'tp:whack')).toMatchObject({ ready: true, readyAt: null, reason: null });
    expect(h.game).toEqual(before);
  });
});
