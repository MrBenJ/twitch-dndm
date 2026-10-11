import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('sessions', () => {
  it('opens and closes, and refuses double opens', () => {
    const h = harness();
    expect(h.fail({ type: 'closeSession' }).code).toBe('no-session');
    h.open();
    expect(h.fail({ type: 'openSession' }).code).toBe('session-open');
    h.join('al');
    h.do({ type: 'closeSession' });
    expect(h.game.session).toBeNull();
    expect(h.types()).toEqual(['core:session-opened', 'core:joined', 'core:session-closed']);
  });

  it('closing during a fight ends it as ended with no rewards', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    h.use('al', 'tp:whack');
    h.do({ type: 'closeSession' });
    expect(h.log.find((e) => e.type === 'core:encounter-ended')?.data).toMatchObject({ outcome: 'ended' });
    expect(h.char('al').xp).toBe(0);
  });
});

describe('joining', () => {
  it('needs an open session', () => {
    const h = harness();
    expect(h.fail({ type: 'join', character: 'al', name: 'Al', pick: 'tp:club' }).code).toBe('no-session');
    expect(h.game.characters).toEqual({});
  });

  it('creates a character at full HP with the picked class item', () => {
    const h = harness();
    h.open();
    expect(h.fail({ type: 'join', character: 'al', name: 'Al' })).toEqual({ code: 'pick-required', message: 'Pick your class item: tp:club, tp:rod' });
    expect(h.fail({ type: 'join', character: 'al', name: 'Al', pick: 'tp:vest' }).code).toBe('bad-pick');
    h.join('al', 'tp:rod');
    expect(h.char('al')).toMatchObject({ name: 'Al', hp: 90, equipped: { 'tp:hand': 'tp:rod' } });
    expect(h.game.session!.party).toEqual(['al']);
    expect(h.fail({ type: 'join', character: 'al', name: 'Al' }).code).toBe('in-party');
  });

  it('a returning character joins with their item, no pick needed', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'leave', character: 'al' });
    h.do({ type: 'join', character: 'al', name: 'Al' });
    expect(h.game.session!.party).toEqual(['al']);
  });

  it('respects the party cap', () => {
    const h = harness({ settings: { 'party-cap': 1 } });
    h.open(); h.join('al');
    expect(h.fail({ type: 'join', character: 'bo', name: 'Bo', pick: 'tp:club' }).code).toBe('party-full');
  });

  it('follows the join table for normal, removed and banned characters', () => {
    // During a fight, allowJoinMidFight on (default)
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    h.join('bo');
    expect(h.game.session!.party).toEqual(['al', 'bo']);
    // Removed by streamer during a fight: must wait (waits-for-rest on)
    h.do({ type: 'removePlayer', character: 'bo' });
    expect(h.fail({ type: 'join', character: 'bo', name: 'Bo' }).code).toBe('removed');
    // Banned: never
    h.do({ type: 'banPlayer', character: 'al' });
    expect(h.game.session!.party).toEqual([]);
    expect(h.fail({ type: 'join', character: 'al', name: 'Al' }).code).toBe('banned');
    h.do({ type: 'endEncounter', outcome: 'ended' });
    // Resting: removed flag cleared, can rejoin
    h.do({ type: 'join', character: 'bo', name: 'Bo' });
    h.do({ type: 'unbanPlayer', character: 'al' });
    h.do({ type: 'join', character: 'al', name: 'Al' });
  });

  it('allowJoinMidFight off blocks joining fights', () => {
    const h = harness({ settings: { 'allow-join-mid-fight': false } });
    h.open(); h.join('al'); h.spawn();
    expect(h.fail({ type: 'join', character: 'bo', name: 'Bo', pick: 'tp:club' }).code).toBe('mid-fight');
  });

  it('removed players may rejoin a fight when waits-for-rest is off', () => {
    const h = harness({ settings: { 'streamer-removal-waits-for-rest': false } });
    h.open(); h.join('al'); h.spawn();
    h.do({ type: 'removePlayer', character: 'al' });
    h.do({ type: 'join', character: 'al', name: 'Al' });
  });

  it('removed players wait during non-fight encounters too', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'startEncounter', encounter: 'tp:chat' });
    h.do({ type: 'removePlayer', character: 'al' });
    expect(h.fail({ type: 'join', character: 'al', name: 'Al' }).code).toBe('removed');
  });
});

describe('the API', () => {
  it('never mutates the caller and rejects unknown characters', () => {
    const h = harness();
    h.open();
    const before = structuredClone(h.game);
    const r = h.engine.apply(h.game, { type: 'use', character: 'ghost', ability: 'tp:whack' }, 0);
    expect(r).toEqual({ ok: false, error: { code: 'unknown-character', message: 'Unknown character' } });
    expect(h.game).toEqual(before);
    expect(h.fail({ type: 'healPlayer', character: 'ghost', amount: 'full' }).code).toBe('unknown-character');
  });

  it('clock never goes backwards', () => {
    const h = harness();
    h.at(5000).open();
    expect(h.game.clock).toBe(5000);
    h.at(1000).join('al');
    expect(h.game.clock).toBe(5000);
    expect(h.log.at(-1)!.at).toBe(5000);
  });
});
