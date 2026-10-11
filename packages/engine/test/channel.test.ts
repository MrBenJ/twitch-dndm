import { describe, expect, it } from 'vitest';
import { deepMerge, DEFAULT_SETTINGS, parseChannel, parseSettings } from '../src/channel';

describe('parseChannel', () => {
  it('fills defaults', () => {
    const r = parseChannel({ packs: ['tp'] });
    expect(r).toEqual({ channel: { packs: ['tp'], channelPack: { content: [], deleted: [] }, overrides: {}, settings: {} } });
  });
  it('reads channel-pack content and deleted IDs', () => {
    const r = parseChannel({ packs: [], 'channel-pack': { content: [{ slot: 'x', name: 'X' }], deleted: ['old'] } });
    expect('channel' in r && r.channel.channelPack).toEqual({ content: [{ slot: 'x', name: 'X' }], deleted: ['old'] });
  });
  it('rejects unknown keys and bad shapes', () => {
    expect(parseChannel({ packs: 'tp' })).toHaveProperty('errors');
    expect(parseChannel({ packs: [], extra: 1 })).toHaveProperty('errors');
  });
});

describe('parseSettings', () => {
  it('uses defaults', () => {
    const r = parseSettings({});
    expect(r.errors).toEqual([]);
    expect(r.settings).toEqual(DEFAULT_SETTINGS);
    expect(r.classSlot).toBeNull();
    expect(r.startingItems).toEqual([]);
    expect(DEFAULT_SETTINGS).toMatchObject({
      partyCap: null, allowJoinMidFight: true, autoRemoveIdle: true, rewardsRequireAction: true,
      knockedOutExemptFromIdle: true, healBetweenFights: false, gearLockDuringCombat: true,
      streamerRemovalWaitsForRest: true, fullIntervalAfterWaiting: true, fullIntervalAfterRelease: true,
      fullIntervalAfterRestart: true, knockoutDuration: 60000, knockoutReturnHp: 25, baseHp: 100, hpPerLevel: 5,
      xpCurve: { first: 80, step: 50 }, xpMultiplier: 1, goldMultiplier: 1, monsterInterval: 20000,
    });
  });
  it('reads kebab-case keys and units', () => {
    const r = parseSettings({
      'party-cap': 10, 'knockout-duration': '30s', 'knockout-return-hp': '50%', 'xp-curve': { first: 100, step: 20 },
      'class-slot': 'tp:hand', 'starting-items': ['tp:club'],
    });
    expect(r.errors).toEqual([]);
    expect(r.settings).toMatchObject({ partyCap: 10, knockoutDuration: 30000, knockoutReturnHp: 50, xpCurve: { first: 100, step: 20 } });
    expect(r.classSlot).toBe('tp:hand');
    expect(r.startingItems).toEqual(['tp:club']);
  });
  it('rejects out-of-range and unknown settings', () => {
    const r = parseSettings({ 'knockout-return-hp': '150%', 'xp-multiplier': -1, 'monster-interval': '0s', colour: 'red' });
    expect(r.errors).toEqual([
      'knockout-return-hp: must be between 0% and 100%',
      'xp-multiplier: must be at least 0',
      'monster-interval: must be longer than 0',
      'colour: unknown setting',
    ]);
  });
});

describe('xp-curve', () => {
  it.each([
    [{ first: Number.NaN, step: 0 }], [{ first: Number.POSITIVE_INFINITY, step: 0 }],
    [{ first: 80, step: Number.NaN }], [{ first: 80, step: Number.POSITIVE_INFINITY }], [{ first: 80.5, step: 50 }],
  ])('rejects %j', (curve) => {
    expect(parseSettings({ 'xp-curve': curve }).errors).toEqual(['xp-curve: must be { first: whole number ≥ 1, step: whole number ≥ 0 }']);
  });
});

describe('deepMerge', () => {
  it('merges objects, replaces lists and values', () => {
    expect(deepMerge({ a: 1, b: { c: 2, d: [1, 2] } }, { b: { c: 3, d: [9] }, e: 4 }))
      .toEqual({ a: 1, b: { c: 3, d: [9] }, e: 4 });
  });
});
