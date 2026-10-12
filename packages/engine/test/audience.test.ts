import { describe, expect, it } from 'vitest';
import type { PackApi } from '../src/pack';
import { harness } from './helpers/harness';

const kinds = (api: PackApi) => {
  api.encounterKind<{ members: string[] }>('hush', {
    name: 'Hush',
    outcomes: () => ['done'],
    start: (ctx) => {
      ctx.emit('tp:whisper', {}, 'psst');
      return { members: ctx.party().map((e) => e.id) };
    },
    respond: (ctx, s, ch) => { ctx.heal(null, ch, 1); return s; },
    wakeAt: () => null,
    advance: (_ctx, s) => s,
    endEarly: () => 'done',
    panel: () => ({ type: 'none' }),
    overlay: () => null,
    audience: (s) => s.members,
  });
  api.encounterKind<null>('tell', {
    name: 'Tell',
    outcomes: () => ['done'],
    start: () => null,
    respond: (ctx, s, ch) => { ctx.emit('tp:told', {}, 'just you', { audience: [ch] }); return s; },
    wakeAt: () => null,
    advance: (_ctx, s) => s,
    endEarly: () => 'done',
    panel: () => ({ type: 'none' }),
    overlay: () => null,
  });
};

describe('event audiences (spec 2a §7.2)', () => {
  it('stamps every event while handling an encounter that declares an audience', () => {
    const h = harness({ plugins: kinds });
    h.open(); h.join('al'); h.join('bo');
    const started = h.do({ type: 'startEncounter', encounter: { 'tp:hush': {} } });
    expect(started.map((e) => [e.type, e.audience])).toEqual([
      ['tp:whisper', ['al', 'bo']],
      ['core:encounter-started', ['al', 'bo']],
    ]);
    h.do({ type: 'leave', character: 'bo' });
    const healed = h.do({ type: 'respond', character: 'al', input: {} });
    expect(healed.every((e) => JSON.stringify(e.audience) === '["al","bo"]')).toBe(true);
    expect(healed.some((e) => e.type === 'core:healed')).toBe(true);
    const ended = h.do({ type: 'endEncounter' });
    expect(ended.find((e) => e.type === 'core:encounter-ended')!.audience).toEqual(['al', 'bo']);
  });

  it('events outside such an encounter stay public', () => {
    const h = harness({ plugins: kinds });
    h.open();
    const [joined] = h.join('al');
    expect(joined!.audience).toBeUndefined();
  });

  it('a plugin can address one emit to some characters', () => {
    const h = harness({ plugins: kinds });
    h.open(); h.join('al'); h.join('bo');
    h.do({ type: 'startEncounter', encounter: { 'tp:tell': {} } });
    const out = h.do({ type: 'respond', character: 'bo', input: {} });
    expect(out.map((e) => [e.type, e.audience])).toEqual([['tp:told', ['bo']]]);
  });

  it('an audience hook that returns something other than a list of IDs is a plugin error', () => {
    const h = harness({
      plugins: (api) => api.encounterKind('bad', {
        name: 'Bad', outcomes: () => ['done'], start: () => null, respond: (_c, s) => s, wakeAt: () => null,
        advance: (_c, s) => s, endEarly: () => 'done', panel: () => ({ type: 'none' }), overlay: () => null,
        audience: () => 'everyone' as unknown as string[],
      }),
    });
    h.open();
    expect(h.fail({ type: 'startEncounter', encounter: { 'tp:bad': {} } }).code).toBe('plugin-error');
  });
});
