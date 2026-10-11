import { describe, expect, it } from 'vitest';
import { createEngine, EngineError } from '../src';
import { harness } from './helpers/harness';
import { tpBundle, tpChannel } from './helpers/tp-pack';

describe('resume', () => {
  it('ends expired knockouts and statuses, does not replay monster turns, full interval by default', () => {
    const h = harness();
    h.open(); h.join('al'); h.join('bo'); h.spawn();
    h.do({ type: 'knockOut', character: 'al' });
    h.do({ type: 'applyStatus', target: { kind: 'character', id: 'bo' }, status: 'tp:snooze', duration: '10s', params: { factor: 2 } });
    const saved = JSON.parse(JSON.stringify(h.game));
    const r = h.engine.resume(saved, 120000);
    expect(r.game.characters.al!.knockedOutUntil).toBeNull();
    expect(r.game.characters.bo!.statuses).toEqual([]);
    expect(r.events.filter((e) => e.type === 'core:damaged')).toEqual([]);
    expect((r.game.session!.encounter as { nextTurnAt: number }).nextTurnAt).toBe(135000);
  });

  it('with fullIntervalAfterRestart off, runs exactly one overdue turn', () => {
    const h = harness({ settings: { 'full-interval-after-restart': false } });
    h.open(); h.join('al'); h.spawn();
    const r = h.engine.resume(structuredClone(h.game), 100000);
    expect(r.events.filter((e) => e.type === 'core:ability-used')).toHaveLength(1);
    expect((r.game.session!.encounter as { nextTurnAt: number }).nextTurnAt).toBe(115000);
  });

  it('with fullIntervalAfterRestart off and the turn still ahead, keeps it', () => {
    const h = harness({ settings: { 'full-interval-after-restart': false } });
    h.open(); h.join('al'); h.spawn();
    const r = h.engine.resume(structuredClone(h.game), 5000);
    expect((r.game.session!.encounter as { nextTurnAt: number }).nextTurnAt).toBe(15000);
  });

  it('closes an encounter whose time ran out during the downtime', () => {
    const h = harness();
    h.open();
    h.do({ type: 'startEncounter', encounter: 'tp:chat' });
    const r = h.engine.resume(structuredClone(h.game), 60000);
    expect(r.game.session!.encounter).toBeNull();
  });
});

describe('adopt', () => {
  it('rejects when the running encounter or adventure uses missing content', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    const without = createEngine({ packs: [tpBundle()], channel: { packs: [] } });
    expect(() => without.adopt(h.game)).toThrow(EngineError);
    try { without.adopt(h.game); } catch (e) { expect((e as EngineError).code).toBe('content-in-use'); }
    h.do({ type: 'endEncounter' });
    h.do({ type: 'startAdventure', adventure: 'tp:trip' });
    expect(() => without.adopt(h.game)).toThrow(/adventure/);
    h.do({ type: 'stopAdventure' });
    expect(without.adopt(h.game)).toEqual(h.game);
  });

  it('accepts a game when the same content is still there', () => {
    const h = harness();
    h.open(); h.join('al'); h.spawn();
    const same = createEngine({ packs: [tpBundle()], channel: tpChannel() });
    expect(same.adopt(h.game)).toEqual(h.game);
  });
});
