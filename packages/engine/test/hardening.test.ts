import { describe, expect, it } from 'vitest';
import { createEngine, ValidationError } from '../src';
import { parseFormula, printFormula, FormulaError } from '../src/formula';
import { harness } from './helpers/harness';
import { tpBundle, tpChannel } from './helpers/tp-pack';

const kind = (over: Record<string, unknown>) => ({
  name: 'K', outcomes: () => ['done'], start: (ctx: { now: number }) => ({ at: ctx.now + 1000 }),
  respond: (_c: unknown, s: unknown) => s, wakeAt: (s: { at: number }) => s.at,
  advance: (_c: unknown, s: unknown) => s, endEarly: () => 'done',
  panel: () => ({ type: 'none' as const }), overlay: () => null, ...over,
});

describe('a broken encounter kind never wedges the game (review: Important 1)', () => {
  it('ctx.endEncounter with an unknown outcome is a plugin error, the encounter is force-ended', () => {
    const h = harness({ plugins: (api) => api.encounterKind('oops', kind({ advance: (ctx: { endEncounter(o: string): void }, s: unknown) => { ctx.endEncounter('nope'); return s; } }) as never) });
    h.open();
    h.do({ type: 'startEncounter', encounter: { 'tp:oops': {} } });
    h.wait(2000);
    expect(h.game.session!.encounter).toBeNull();
    expect(h.types()).toContain('core:plugin-error');
    h.do({ type: 'postMessage', text: 'still alive' });
  });

  it('a wakeAt that throws force-ends the encounter', () => {
    let calls = 0;
    const h = harness({ plugins: (api) => api.encounterKind('grumpy', kind({ wakeAt: () => { if (++calls > 1) throw new Error('bad wakeAt'); return 1000; } }) as never) });
    h.open();
    h.do({ type: 'startEncounter', encounter: { 'tp:grumpy': {} } });
    h.wait(2000);
    expect(h.game.session!.encounter).toBeNull();
    h.do({ type: 'postMessage', text: 'still alive' });
  });

  it('a wake that never moves its timer forward is force-ended, not spun forever', () => {
    const h = harness({ plugins: (api) => api.encounterKind('stuck', kind({}) as never) });
    h.open();
    h.do({ type: 'startEncounter', encounter: { 'tp:stuck': {} } });
    h.wait(2000);
    expect(h.game.session!.encounter).toBeNull();
    expect(h.types()).toContain('core:plugin-error');
  });
});

describe('formulas round-trip any finite number (review: Important 2)', () => {
  it.each(['0.0000001 * power + 5', '1000000000000000000000 + power', '123456789012345678901234567890 * 2', '0.5'])('%s', (text) => {
    const node = parseFormula(text);
    expect(parseFormula(printFormula(node))).toEqual(node);
    expect(printFormula(node)).not.toMatch(/\de|Infinity/);
  });
  it('rejects number literals too large to represent', () => {
    expect(() => parseFormula('9'.repeat(400))).toThrow(FormulaError);
  });
});

describe('apply checks command shapes (review: Important 3)', () => {
  it.each([
    [{ type: 'bogus' }, /Unknown command/],
    [{ type: 'join' }, /character/],
    [{ type: 'startEncounter', encounter: null }, /encounter/],
    [{ type: 'applyStatus', target: null, status: 'tp:snooze' }, /target/],
    [{ type: 'use', character: 'al', ability: 5 }, /ability/],
  ])('%j is rejected as invalid-input', (cmd, msg) => {
    const h = harness();
    h.open();
    const err = h.fail(cmd as never);
    expect(err.code).toBe('invalid-input');
    expect(err.message).toMatch(msg);
    expect(h.game.characters).toEqual({});
  });
  it('null steps in inline encounters are an input error, not a crash', () => {
    const h = harness({ plugins: (api) => api.encounterKind('pit', kind({ params: { t: 'object', fields: { steps: { t: 'steps', noSource: true } } } }) as never) });
    h.open();
    expect(h.fail({ type: 'startEncounter', encounter: { 'tp:pit': { steps: [null] } } }).code).toBe('invalid-input');
  });
});

describe('inline encounters get the same formula checks as files (review: Important 4)', () => {
  const pit = (api: Parameters<NonNullable<Parameters<typeof harness>[0]>['plugins'] & {}>[0]) =>
    api.encounterKind('pit', kind({ params: { t: 'object', fields: { steps: { t: 'steps', noSource: true } } } }) as never);
  it('enforces the no-source rule and unknown stats', () => {
    const h = harness({ plugins: pit });
    h.open();
    expect(h.fail({ type: 'startEncounter', encounter: { 'tp:pit': { steps: [{ 'tp:poke': { power: 'tp:power' } }] } } }).message).toMatch(/no source/);
    expect(h.fail({ type: 'startEncounter', encounter: { 'tp:pit': { steps: [{ 'tp:poke': { power: 'target.tp:pwoer' } }] } } }).message).toMatch(/Unknown stat 'tp:pwoer'/);
    h.do({ type: 'startEncounter', encounter: { 'tp:pit': { steps: [{ 'tp:poke': { power: 'target.tp:power * 2' } }] } } });
  });
  it('accepts status applications', () => {
    const h = harness({ plugins: pit });
    h.open();
    h.do({ type: 'startEncounter', encounter: { 'tp:pit': { steps: [{ 'tp:put': { status: 'tp:snooze', duration: '5s', factor: 2 } }] } } });
  });
});

describe('non-finite plugin results never reach saved state (review: Important 5)', () => {
  it('a modifier returning undefined leaves the value unchanged and reports it', () => {
    const h = harness({ plugins: (api) => api.status('leaky', { name: 'Leaky', modify: { damageTaken: (() => undefined) as never } }) });
    h.open(); h.join('al'); h.spawn();
    h.do({ type: 'applyStatus', target: { kind: 'monster', id: 'm1' }, status: 'tp:leaky' });
    h.use('al', 'tp:whack');
    expect(h.monster().hp).toBe(40);
    expect(h.types()).toContain('core:plugin-error');
    expect(Number.isFinite(h.char('al').hp)).toBe(true);
  });
});

describe('a typo in a pack prefix is an error, not dormancy (review: promoted minor)', () => {
  it('only installed-but-disabled packs go dormant', () => {
    const errorsOf = (channel: unknown) => {
      try { createEngine({ packs: [tpBundle()], channel }); } catch (e) { return (e as ValidationError).issues.filter((i) => i.level === 'error').map((i) => i.message); }
      return [];
    };
    expect(errorsOf(tpChannel({ overrides: { 'tq:blob': { hp: 1 } } }))).toEqual([expect.stringMatching(/no pack called 'tq'/)]);
    expect(errorsOf(tpChannel({ 'channel-pack': { content: [{ class: 'x', name: 'X', abilities: ['tq:whack'] }] } }))).toEqual([expect.stringMatching(/no pack called 'tq'/)]);
    expect(errorsOf({ packs: [], overrides: { 'tp:blob': { hp: 1 } } })).toEqual([]);
  });
});
