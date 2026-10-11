import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('streamer commands', () => {
  it('heals a player or the party, never a knocked-out one, never negative', () => {
    const h = harness();
    h.open(); h.join('al'); h.join('bo'); h.spawn();
    h.wait(15000);
    const hurt = ['al', 'bo'].find((id) => h.char(id).hp < 100)!;
    h.do({ type: 'healPlayer', character: hurt, amount: 3 });
    expect(h.char(hurt).hp).toBe(97);
    expect(h.fail({ type: 'healPlayer', character: hurt, amount: -50 }).code).toBe('bad-amount');
    h.do({ type: 'healParty' });
    expect(h.char(hurt).hp).toBe(100);
    h.do({ type: 'knockOut', character: 'al' });
    expect(h.fail({ type: 'healPlayer', character: 'al', amount: 'full' }).code).toBe('knocked-out');
  });

  it('revives to knockoutReturnHp; reviveAll revives every knocked-out member', () => {
    const h = harness();
    h.open(); h.join('al'); h.join('bo');
    expect(h.fail({ type: 'revivePlayer', character: 'al' }).code).toBe('not-knocked-out');
    h.do({ type: 'knockOut', character: 'al' });
    h.do({ type: 'knockOut', character: 'bo' });
    h.do({ type: 'revivePlayer', character: 'al' });
    expect(h.char('al')).toMatchObject({ knockedOutUntil: null, hp: 25 });
    h.do({ type: 'reviveAll' });
    expect(h.char('bo').knockedOutUntil).toBeNull();
  });

  it('applies and removes statuses with checked params', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    const al = { kind: 'character' as const, id: 'al' };
    expect(h.fail({ type: 'applyStatus', target: al, status: 'tp:nope' }).code).toBe('unknown-status');
    expect(h.fail({ type: 'applyStatus', target: al, status: 'tp:snooze', params: {} })).toEqual({ code: 'invalid-input', message: 'factor: required' });
    h.do({ type: 'applyStatus', target: al, status: 'tp:snooze', duration: '30s', params: { factor: 2 } });
    expect(h.char('al').statuses[0]).toMatchObject({ status: 'tp:snooze', until: 30000, params: { factor: 2 } });
    h.do({ type: 'applyStatus', target: { kind: 'monster', id: 'm1' }, status: 'tp:snooze', params: { factor: 2 } });
    expect(h.monster().statuses).toHaveLength(1);
    h.do({ type: 'removeStatus', target: al, status: 'tp:snooze' });
    expect(h.fail({ type: 'removeStatus', target: al, status: 'tp:snooze' }).code).toBe('no-status');
    expect(h.fail({ type: 'removeStatus', target: al, status: 'core:knocked-out' }).code).toBe('use-revive');
    expect(h.fail({ type: 'applyStatus', target: { kind: 'monster', id: 'm9' }, status: 'tp:snooze', params: { factor: 2 } }).code).toBe('unknown-target');
  });

  it('gives XP, gold and items to one character or the party', () => {
    const h = harness();
    h.open(); h.join('al'); h.join('bo');
    h.do({ type: 'giveXp', target: 'party', amount: 210 });
    expect(h.char('bo')).toMatchObject({ xp: 210, level: 3 });
    h.do({ type: 'giveGold', target: 'al', amount: 7 });
    expect(h.char('al').gold).toBe(7);
    expect(h.fail({ type: 'giveGold', target: 'al', amount: -10 }).code).toBe('bad-amount');
    h.do({ type: 'giveItem', target: 'party', item: 'tp:vest' });
    expect(h.char('bo').inventory).toEqual({ 'tp:vest': 1 });
    expect(h.fail({ type: 'giveItem', target: 'al', item: 'tp:nope' }).code).toBe('unknown-content');
    expect(h.fail({ type: 'giveXp', target: 'ghost', amount: 1 }).code).toBe('unknown-character');
  });

  it('posts a message to the feed', () => {
    const h = harness();
    expect(h.do({ type: 'postMessage', text: 'Hello chat' })).toEqual([{ type: 'core:message', at: 0, text: 'Hello chat', data: {} }]);
  });
});
