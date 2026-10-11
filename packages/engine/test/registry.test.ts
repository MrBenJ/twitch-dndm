import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/errors';
import type { PackBundle } from '../src/pack';
import { buildRegistry, CORE_FIGHT, CORE_HP, CORE_KO } from '../src/registry';
import { tpBundle, tpChannel } from './helpers/tp-pack';

function errorsOf(fn: () => unknown): string[] {
  try { fn(); } catch (e) {
    if (e instanceof ValidationError) return e.issues.filter((i) => i.level === 'error').map((i) => `${i.pack} ${i.path}: ${i.message}`);
    throw e;
  }
  return [];
}

const pack = (id: string, over: Partial<PackBundle> = {}): PackBundle => ({
  manifest: { id, version: '1.0.0', name: id, depends: {} }, official: true, content: [], ...over,
});

describe('buildRegistry: packs and plugins', () => {
  it('registers core entries and tp plugins', () => {
    const r = buildRegistry([tpBundle()], tpChannel());
    expect(r.stats.has(CORE_HP)).toBe(true);
    expect(r.statuses.has(CORE_KO)).toBe(true);
    expect(r.kinds.get(CORE_FIGHT)?.builtin).toBe(true);
    expect([...r.effects.keys()]).toEqual(['tp:poke', 'tp:fix', 'tp:lift', 'tp:put']);
    expect(r.kinds.get('tp:ballot')?.pack).toBe('tp');
    expect(r.packs.map((m) => m.id)).toEqual(['tp']);
  });

  it('orders packs after their dependencies', () => {
    const a = pack('aa', { manifest: { id: 'aa', version: '1.0.0', name: 'aa', depends: { bb: '^1.0.0' } } });
    const b = pack('bb');
    const r = buildRegistry([a, b], { packs: ['aa', 'bb'] });
    expect(r.packs.map((m) => m.id)).toEqual(['bb', 'aa']);
  });

  it('reports manifest and dependency problems together', () => {
    const errors = errorsOf(() => buildRegistry([
      pack('aa', { manifest: { id: 'aa', version: '1.0.0', name: 'aa', depends: { bb: '^2.0.0', zz: '*' } } }),
      pack('bb'),
      pack('cc', { manifest: { id: 'cc', version: 'one', name: 'cc', depends: {} } }),
      pack('core'),
    ], { packs: ['aa', 'bb', 'cc', 'core', 'missing'] }));
    expect(errors).toEqual(expect.arrayContaining([
      "aa : depends on bb ^2.0.0 but 1.0.0 is enabled",
      "aa : depends on zz, which is not enabled",
      'cc : version must look like 1.2.3',
      "core : 'core' and 'channel' are reserved pack IDs",
      "missing : pack is enabled but not installed",
    ]));
  });

  it('detects dependency cycles', () => {
    const errors = errorsOf(() => buildRegistry([
      pack('aa', { manifest: { id: 'aa', version: '1.0.0', name: 'aa', depends: { bb: '*' } } }),
      pack('bb', { manifest: { id: 'bb', version: '1.0.0', name: 'bb', depends: { aa: '*' } } }),
    ], { packs: ['aa', 'bb'] }));
    expect(errors).toContain('aa : dependency cycle: aa -> bb -> aa');
  });

  it('refuses code from non-official packs', () => {
    const errors = errorsOf(() => buildRegistry([
      pack('xx', { official: false, register: () => {} }),
      pack('yy', { official: false, hasCode: true }),
    ], { packs: ['xx', 'yy'] }));
    expect(errors).toEqual([
      "xx : this pack isn't official, so it can't contain code",
      "yy : this pack isn't official, so it can't contain code",
    ]);
  });

  it('reports duplicate plugin IDs and register() throws', () => {
    const errors = errorsOf(() => buildRegistry([
      pack('aa', { register: (api) => { api.status('s', { name: 'S' }); api.status('s', { name: 'S2' }); } }),
      pack('bb', { register: () => { throw new Error('boom'); } }),
    ], { packs: ['aa', 'bb'] }));
    expect(errors).toEqual(["aa : duplicate status 's'", 'bb : register() failed: boom']);
  });
});

describe('buildRegistry: documents and overrides', () => {
  it('reports bad documents with file and index', () => {
    let issues: { file?: string; doc?: number; message: string }[] = [];
    try {
      buildRegistry([tpBundle([{ name: 'no type' }, { name: 'x', class: 'a' }, { slot: 'hand', name: 'Dup' }])], tpChannel());
    } catch (e) { issues = (e as ValidationError).issues; }
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'tp.yaml', message: expect.stringMatching(/no type key/) }),
      expect.objectContaining({ file: 'tp.yaml', message: expect.stringMatching(/Start the document with its type key/) }),
      expect.objectContaining({ message: "duplicate slot 'hand'" }),
    ]));
  });

  it('applies overrides by ID', () => {
    const r = buildRegistry([tpBundle()], tpChannel({ overrides: { 'tp:zap': { cooldown: '6s' }, 'tp:blob': { hp: 70 } } }));
    expect(r.abilities.get('tp:zap')?.cooldown).toBe(6000);
    expect(r.monsters.get('tp:blob')?.hp).toBe(70);
  });

  it('needs a type in the override key when an ID is ambiguous', () => {
    const bundle = tpBundle([{ ability: 'power', name: 'Power move', cooldown: '1s', target: 'me', steps: [] }]);
    expect(errorsOf(() => buildRegistry([bundle], tpChannel({ overrides: { 'tp:power': { name: 'X' } } }))))
      .toContain("channel overrides.tp:power: 'tp:power' names more than one thing (stat, ability); write it as 'stat tp:power' or 'ability tp:power'");
    const r = buildRegistry([bundle], tpChannel({ overrides: { 'ability tp:power': { name: 'X' } } }));
    expect(r.abilities.get('tp:power')?.name).toBe('X');
  });

  it('rejects overrides for unknown content and changes to the type key', () => {
    expect(errorsOf(() => buildRegistry([tpBundle()], tpChannel({ overrides: { 'tp:zapp': { cooldown: '6s' }, 'tp:zap': { ability: 'other' } } }))))
      .toEqual(expect.arrayContaining([
        "channel overrides.tp:zapp: nothing called 'tp:zapp' to override",
        "channel overrides.tp:zap: an override can't change the 'ability' key",
      ]));
  });
});
