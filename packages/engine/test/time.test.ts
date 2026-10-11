import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('time', () => {
  it('reports the next wake time', () => {
    const h = harness();
    expect(h.engine.nextWakeTime(h.game)).toBeNull();
    h.open(); h.join('al'); h.spawn();
    expect(h.engine.nextWakeTime(h.game)).toBe(15000);
  });

  it('processes monster turns at their own times during a long wait', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    const events = h.wait(46000);
    const hits = events.filter((e) => e.type === 'core:damaged');
    expect(hits.map((e) => e.at)).toEqual([15000, 30000, 45000]);
    expect(h.char('al').hp).toBe(82);
    expect(h.game.clock).toBe(46000);
  });

  it('ends knockouts with the return HP', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'knockOut', character: 'al' });
    h.wait(60000);
    expect(h.char('al')).toMatchObject({ knockedOutUntil: null, hp: 25 });
    expect(h.types()).toContain('core:knockout-ended');
  });

  it('knockouts keep running outside the party and the session', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'knockOut', character: 'al' });
    h.do({ type: 'closeSession' });
    h.wait(61000);
    expect(h.char('al').knockedOutUntil).toBeNull();
  });

  it('a knockout ending at the same time as a monster turn ends first', () => {
    const h = harness({ settings: { 'knockout-duration': '15s' } });
    h.open(); h.join('al'); h.join('bo'); h.spawn();
    h.do({ type: 'knockOut', character: 'al' });
    h.wait(15000);
    const order = h.log.filter((e) => e.at === 15000).map((e) => e.type);
    expect(order.indexOf('core:knockout-ended')).toBeLessThan(order.indexOf('core:ability-used'));
  });

  it('expires statuses and runs ticks', () => {
    const h = harness({
      plugins: (api) => api.status('bleed', {
        name: 'Bleed', tick: { every: '5s', run: (ctx, { holder }) => { ctx.dealDamage(null, holder, 2); } },
      }),
    });
    h.open(); h.join('al');
    h.do({ type: 'applyStatus', target: { kind: 'character', id: 'al' }, status: 'tp:bleed', duration: '12s' });
    h.wait(20000);
    expect(h.char('al').hp).toBe(96);
    expect(h.char('al').statuses).toEqual([]);
    expect(h.types().filter((t) => t === 'core:status-ended')).toHaveLength(1);
  });

  it('a plugin error in a time step skips that timer and keeps going', () => {
    const h = harness({
      plugins: (api) => api.behavior('broken', { act: () => { throw new Error('kaboom'); } }),
      content: [{ monster: 'glitch', name: 'Glitch', hp: 10, abilities: ['slam'], behavior: { broken: {} } }],
    });
    h.open(); h.join('al'); h.spawn('tp:glitch');
    const events = h.wait(41000);
    expect(events.filter((e) => e.type === 'core:plugin-error')).toHaveLength(2);
    expect(h.fight().nextTurnAt).toBe(60000);
  });

  it('an encounter kind that throws on every wake is force-ended', () => {
    const h = harness({
      plugins: (api) => api.encounterKind('sulk', {
        name: 'Sulk', outcomes: () => ['done'], start: (ctx) => ({ at: ctx.now + 1000 }), respond: (_c, s) => s,
        wakeAt: (s) => s.at, advance: () => { throw new Error('no'); }, endEarly: () => 'done',
        panel: () => ({ type: 'none' }), overlay: () => null,
      }),
    });
    h.open();
    h.do({ type: 'startEncounter', encounter: { 'tp:sulk': {} } });
    h.wait(2000);
    expect(h.game.session!.encounter).toBeNull();
    expect(h.types()).toEqual(expect.arrayContaining(['core:plugin-error', 'core:encounter-ended']));
  });
});
