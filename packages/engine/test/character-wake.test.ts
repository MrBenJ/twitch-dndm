import { describe, expect, it } from 'vitest';
import { commandCharacters } from '../src';
import { harness } from './helpers/harness';

describe('engine.characterWake (spec 2a §6.4)', () => {
  it('is null for a character with no timers, and ignores cooldowns', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    h.use('al', 'tp:whack');
    expect(Object.keys(h.char('al').cooldowns).length).toBeGreaterThan(0);
    expect(h.engine.characterWake(h.game, 'al')).toBeNull();
  });

  it('is the knockout end, or the earliest status end or tick', () => {
    const h = harness();
    h.open(); h.join('al'); h.join('bo');
    h.at(1000).do({ type: 'knockOut', character: 'al' });
    expect(h.engine.characterWake(h.game, 'al')).toBe(h.char('al').knockedOutUntil);
    h.do({ type: 'applyStatus', target: { kind: 'character', id: 'bo' }, status: 'tp:snooze', duration: '10s', params: { factor: 2 } });
    expect(h.engine.characterWake(h.game, 'bo')).toBe(11000);
  });

  it('is null for a character who is not in the state', () => {
    const h = harness();
    expect(h.engine.characterWake(h.game, 'nobody')).toBeNull();
  });
});

describe('commandCharacters (spec 2a §6.2)', () => {
  it('lists every character a command names', () => {
    expect(commandCharacters({ type: 'join', character: 'al' })).toEqual(['al']);
    expect(commandCharacters({ type: 'use', character: 'al', ability: 'x', chosen: { kind: 'character', id: 'bo' } })).toEqual(['al', 'bo']);
    expect(commandCharacters({ type: 'applyStatus', target: { kind: 'character', id: 'cy' }, status: 's' })).toEqual(['cy']);
    expect(commandCharacters({ type: 'applyStatus', target: { kind: 'monster', id: 'm1' }, status: 's' })).toEqual([]);
    expect(commandCharacters({ type: 'giveGold', target: 'al', amount: 1 })).toEqual(['al']);
    expect(commandCharacters({ type: 'giveGold', target: 'party', amount: 1 })).toEqual([]);
    expect(commandCharacters({ type: 'healParty' })).toEqual([]);
  });

  it('returns nothing for something that is not a command', () => {
    expect(commandCharacters({ type: 'nope', character: 'al' })).toEqual([]);
    expect(commandCharacters('join')).toEqual([]);
  });
});
