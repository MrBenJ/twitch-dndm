import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('starting a fight', () => {
  it('copies the monster and schedules its first turn', () => {
    const h = harness();
    h.open(); h.join('al');
    expect(h.fail({ type: 'spawnMonster', monster: 'tp:nobody' }).code).toBe('unknown-content');
    h.spawn();
    expect(h.fight()).toMatchObject({ sub: 'fighting', nextTurnAt: 15000, held: false, wasActive: ['al'] });
    expect(h.monster()).toMatchObject({ hp: 50, def: { name: 'Blob' } });
    expect(h.fail({ type: 'spawnMonster', monster: 'tp:blob' }).code).toBe('busy');
  });

  it('with an empty party it starts waiting', () => {
    const h = harness();
    h.open(); h.spawn();
    expect(h.fight()).toMatchObject({ sub: 'waiting', nextTurnAt: null });
    h.join('al');
    expect(h.fight()).toMatchObject({ sub: 'fighting', nextTurnAt: 15000 });
  });
});

describe('character abilities', () => {
  it('checks party, knockout, ownership, phase and cooldown', () => {
    const h = harness();
    h.open(); h.join('al');
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:whack' }).code).toBe('fight-only');
    h.spawn();
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:mend' }).code).toBe('no-ability');
    h.use('al', 'tp:whack');
    expect(h.monster().hp).toBe(40);
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:whack' })).toEqual({ code: 'on-cooldown', message: 'On cooldown (10s)' });
    h.at(4000);
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:whack' }).message).toBe('On cooldown (6s)');
    h.at(10000).use('al', 'tp:whack');
    h.do({ type: 'knockOut', character: 'al' });
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:zap' }).code).toBe('knocked-out');
    h.do({ type: 'leave', character: 'al' });
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:zap' }).code).toBe('not-in-party');
  });

  it('canUse modifiers can refuse', () => {
    const h = harness({ plugins: (api) => api.status('mute', { name: 'Mute', modify: { canUse: () => 'You are muted' } }) });
    h.open(); h.join('al'); h.spawn();
    h.do({ type: 'applyStatus', target: { kind: 'character', id: 'al' }, status: 'tp:mute' });
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:whack' })).toEqual({ code: 'cannot-use', message: 'You are muted' });
  });

  it('consumables spend uses, then the item', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'giveItem', target: 'al', item: 'tp:biscuit' });
    h.do({ type: 'healPlayer', character: 'al', amount: 0 });
    h.use('al', 'tp:snack');
    expect(h.char('al')).toMatchObject({ inventory: { 'tp:biscuit': 1 }, usesLeft: { 'tp:biscuit': 1 } });
    h.at(5000).use('al', 'tp:snack');
    expect(h.char('al').inventory).toEqual({});
    expect(h.char('al').usesLeft).toEqual({});
    expect(h.fail({ type: 'use', character: 'al', ability: 'tp:snack' }).code).toBe('no-ability');
  });
});

describe('monster turns and sub-states', () => {
  it('acts on its interval and hits ceil(active/5) members', () => {
    const h = harness();
    h.open();
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) h.join(id);
    h.spawn();
    h.wait(15000);
    const hit = Object.values(h.game.characters).filter((c) => c.hp === 94);
    expect(hit).toHaveLength(2);
    expect(h.fight().nextTurnAt).toBe(30000);
  });

  it('goes waiting on a wipe and fighting again, with a full interval by default', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    h.at(5000).do({ type: 'knockOut', character: 'al' });
    expect(h.fight()).toMatchObject({ sub: 'waiting', nextTurnAt: null, pausedTurnAt: 15000 });
    h.at(8000).do({ type: 'revivePlayer', character: 'al' });
    expect(h.fight()).toMatchObject({ sub: 'fighting', nextTurnAt: 23000 });
  });

  it('keeps the original schedule when fullIntervalAfterWaiting is off', () => {
    const h = harness({ settings: { 'full-interval-after-waiting': false } });
    h.open(); h.join('al'); h.spawn();
    h.at(5000).do({ type: 'knockOut', character: 'al' });
    h.at(8000).do({ type: 'revivePlayer', character: 'al' });
    expect(h.fight().nextTurnAt).toBe(15000);
  });

  it('hold stops the timer; act-now strikes once; release reschedules', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    h.at(5000).do({ type: 'holdMonster' });
    expect(h.fail({ type: 'holdMonster' }).code).toBe('already-held');
    h.wait(60000);
    expect(h.char('al').hp).toBe(100);
    h.do({ type: 'monsterActNow' });
    expect(h.char('al').hp).toBe(94);
    expect(h.fight()).toMatchObject({ held: true, nextTurnAt: null, heldRemaining: 10000 });
    h.do({ type: 'releaseMonster' });
    expect(h.fight().nextTurnAt).toBe(h.now + 15000);
    expect(h.fail({ type: 'releaseMonster' }).code).toBe('not-held');
  });

  it('release continues the remaining time when fullIntervalAfterRelease is off', () => {
    const h = harness({ settings: { 'full-interval-after-release': false } });
    h.open(); h.join('al'); h.spawn();
    h.at(5000).do({ type: 'holdMonster' });
    h.at(9000).do({ type: 'releaseMonster' });
    expect(h.fight().nextTurnAt).toBe(19000);
  });

  it('act-now while waiting is rejected', () => {
    const h = harness();
    h.open(); h.spawn();
    expect(h.fail({ type: 'monsterActNow' })).toEqual({ code: 'no-one', message: 'No one to act against' });
  });
});

describe('ending a fight', () => {
  const overrides = { 'tp:blob': { drops: [{ item: 'biscuit', chance: 1 }] } };

  it('pays eligible members, removes idle ones, keeps the knocked-out-whole-time', () => {
    const h = harness({ channel: { overrides } });
    h.open(); h.join('al'); h.join('bo'); h.join('cy');
    h.do({ type: 'knockOut', character: 'cy' });
    h.spawn();
    h.use('al', 'tp:zap');
    h.at(10000).use('al', 'tp:whack');
    h.at(20000).use('al', 'tp:whack');
    expect(h.game.session!.encounter).toBeNull();
    expect(h.char('al')).toMatchObject({ xp: 20, gold: 5, inventory: { 'tp:biscuit': 1 } });
    expect(h.char('bo').xp).toBe(0);
    expect(h.game.session!.party).toEqual(['al', 'cy']);
    expect(h.types()).toContain('core:removed-idle');
  });

  it('rewardsRequireAction off pays everyone; autoRemoveIdle off keeps everyone', () => {
    const h = harness({ settings: { 'rewards-require-action': false, 'auto-remove-idle': false }, channel: { overrides } });
    h.open(); h.join('al'); h.join('bo'); h.spawn();
    h.do({ type: 'setMonsterHp', value: 0 });
    expect(h.char('bo').xp).toBe(20);
    expect(h.game.session!.party).toEqual(['al', 'bo']);
  });

  it('knockedOutExemptFromIdle off removes knocked-out idlers', () => {
    const h = harness({ settings: { 'knocked-out-exempt-from-idle': false } });
    h.open(); h.join('al'); h.join('cy');
    h.do({ type: 'knockOut', character: 'cy' });
    h.spawn(); h.use('al', 'tp:zap');
    h.do({ type: 'endEncounter', outcome: 'won' });
    expect(h.game.session!.party).toEqual(['al']);
  });

  it('mid-fight joiners are judged from when they joined', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    h.at(5000).join('bo');
    h.use('bo', 'tp:whack');
    h.do({ type: 'endEncounter', outcome: 'won' });
    expect(h.game.session!.party).toEqual(['bo']);
  });

  it('healBetweenFights heals the party except knocked out members', () => {
    const h = harness({ settings: { 'heal-between-fights': true } });
    h.open(); h.join('al'); h.join('bo'); h.spawn();
    h.use('al', 'tp:whack'); h.use('bo', 'tp:whack');
    h.wait(15000);
    h.do({ type: 'knockOut', character: 'bo' });
    h.do({ type: 'endEncounter', outcome: 'won' });
    expect(h.char('al').hp).toBe(100);
    expect(h.char('bo').knockedOutUntil).not.toBeNull();
  });

  it('endEncounter with no outcome ends a fight as ended', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn(); h.use('al', 'tp:whack');
    h.do({ type: 'endEncounter' });
    expect(h.char('al').xp).toBe(0);
    expect(h.fail({ type: 'endEncounter' }).code).toBe('no-encounter');
  });
});
