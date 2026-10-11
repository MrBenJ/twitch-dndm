import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('encounter kinds', () => {
  it('starts by ID, ends on its own timer', () => {
    const h = harness();
    h.open();
    h.do({ type: 'startEncounter', encounter: 'tp:chat' });
    expect(h.game.session!.encounter).toMatchObject({ kind: 'tp:show', state: { endsAt: 10000 } });
    h.wait(10000);
    expect(h.game.session!.encounter).toBeNull();
    expect(h.log.at(-1)).toMatchObject({ type: 'core:encounter-ended', data: { outcome: 'done' } });
  });

  it('starts inline, with params checked', () => {
    const h = harness();
    h.open();
    expect(h.fail({ type: 'startEncounter', encounter: { 'tp:ballot': { choices: { a: 'A' } } } }))
      .toEqual({ code: 'invalid-input', message: 'tp:ballot.time: required' });
    h.do({ type: 'startEncounter', encounter: { 'tp:ballot': { choices: { a: 'A', b: 'B' }, time: '30s' } } });
    expect(h.fail({ type: 'startEncounter', encounter: 'tp:chat' }).code).toBe('busy');
  });

  it('only party members respond; input is checked; plugin errors roll back', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'startEncounter', encounter: { 'tp:ballot': { choices: { a: 'A', b: 'B' }, time: '30s' } } });
    expect(h.fail({ type: 'respond', character: 'bo', input: { choice: 'a' } }).code).toBe('unknown-character');
    h.join('bo');
    h.do({ type: 'leave', character: 'bo' });
    expect(h.fail({ type: 'respond', character: 'bo', input: { choice: 'a' } }).code).toBe('not-in-party');
    expect(h.fail({ type: 'respond', character: 'al', input: {} })).toEqual({ code: 'invalid-input', message: 'choice: required' });
    const err = h.fail({ type: 'respond', character: 'al', input: { choice: 'zzz' } });
    expect(err.code).toBe('plugin-error');
    expect(err.message).toContain('tp:ballot respond');
    h.do({ type: 'respond', character: 'al', input: { choice: 'b' } });
    h.wait(30000);
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'b' });
  });

  it('knocked-out members can still respond', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'knockOut', character: 'al' });
    h.do({ type: 'startEncounter', encounter: { 'tp:ballot': { choices: { a: 'A' }, time: '5s' } } });
    h.do({ type: 'respond', character: 'al', input: { choice: 'a' } });
  });

  it('the streamer ends early with endEarly, an allowed outcome, or ended', () => {
    const h = harness();
    h.open();
    h.do({ type: 'startEncounter', encounter: { 'tp:ballot': { choices: { a: 'A', b: 'B' }, time: '30s' } } });
    expect(h.fail({ type: 'endEncounter', outcome: 'won' })).toEqual({ code: 'bad-outcome', message: "That encounter can't end with 'won'" });
    h.do({ type: 'endEncounter' });
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'a' });
    h.do({ type: 'startEncounter', encounter: 'tp:chat' });
    h.do({ type: 'endEncounter', outcome: 'ended' });
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'ended' });
  });

  it('onEnd runs on every ending, including closeSession', () => {
    const ends: string[] = [];
    const h = harness({
      plugins: (api) => api.encounterKind('tally', {
        name: 'Tally', outcomes: () => ['done'], start: () => ({}), respond: (_c, s) => s, wakeAt: () => null,
        advance: (_c, s) => s, endEarly: () => 'done', onEnd: (_c, _s, outcome) => { ends.push(outcome); },
        panel: () => ({ type: 'none' }), overlay: () => null,
      }),
    });
    h.open();
    h.do({ type: 'startEncounter', encounter: { 'tp:tally': {} } });
    h.do({ type: 'endEncounter' });
    h.do({ type: 'startEncounter', encounter: { 'tp:tally': {} } });
    h.do({ type: 'closeSession' });
    expect(ends).toEqual(['done', 'ended']);
  });

  it('non-fight encounters never remove idle members', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'startEncounter', encounter: 'tp:chat' });
    h.wait(10000);
    expect(h.game.session!.party).toEqual(['al']);
  });
});
