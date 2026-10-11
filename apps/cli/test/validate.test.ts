import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '@dndm/engine';
import { listPackDirs, loadChannel, loadPacks, repoRoot } from '@dndm/pack-loader';
import { describe, expect, it } from 'vitest';
import { CliError, resolveId } from '../src/ids';
import { validate } from '../src/validate';

describe('dndm validate', () => {
  it('passes the repository packs and default channel', async () => {
    const r = await validate({});
    expect(r.ok).toBe(true);
    expect(r.lines.at(-1)).toMatch(/^Valid: 1 pack, 3 classes, \d+ abilities, \d+ items, 3 monsters, 1 adventure$/);
  });

  it('lists every problem in a broken pack, and refuses code outside packs/', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bad-'));
    mkdirSync(join(dir, 'content'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'pack.json'), JSON.stringify({ id: 'bad', version: '1.0.0', name: 'Bad', depends: { starter: '^1.0.0' } }));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export default {};\n');
    writeFileSync(join(dir, 'content', 'x.yaml'), 'class: oops\nname: Oops\nabilities: [starter:atack]\n');
    const channel = join(dir, 'channel.yaml');
    writeFileSync(channel, 'packs: [starter, bad]\n');
    const r = await validate({ packs: [...listPackDirs(), dir], channel });
    expect(r.ok).toBe(false);
    expect(r.lines).toEqual(expect.arrayContaining([
      "error: [bad] this pack isn't official, so it can't contain code",
      "error: [bad] content/x.yaml#0 abilities[0]: Unknown ability 'starter:atack'",
    ]));
  });

  it('prints JSON lines with --json', async () => {
    const r = await validate({ json: true });
    expect(JSON.parse(r.lines.at(-1)!)).toMatchObject({ kind: 'valid', packs: 1, classes: 3 });
  });
});

describe('resolveId', () => {
  it('resolves unique short IDs and refuses unknown or ambiguous ones', async () => {
    const engine = createEngine({ packs: await loadPacks(listPackDirs()), channel: loadChannel(join(repoRoot(), 'channels', 'default.yaml')) });
    const d = engine.describe();
    expect(resolveId(d, 'monster', 'slime')).toBe('starter:slime');
    expect(resolveId(d, 'monster', 'starter:slime')).toBe('starter:slime');
    expect(() => resolveId(d, 'monster', 'slim')).toThrow(new CliError("Unknown monster 'slim'"));
    const twice = { ...d, monsters: [...d.monsters, { ...d.monsters[0]!, id: 'other:slime' }] };
    expect(() => resolveId(twice, 'monster', 'slime')).toThrow("'slime' could be starter:slime or other:slime; write the full ID");
  });
});

describe('setup', () => {
  it("doesn't import code from installed packs the channel leaves disabled", async () => {
    const { mkdtempSync: mk, writeFileSync: wf } = await import('node:fs');
    const dir = mk(join(tmpdir(), 'ch-'));
    wf(join(dir, 'none.yaml'), 'packs: []\n');
    const { setupBundles } = await import('../src/setup');
    const bundles = await setupBundles({ channel: join(dir, 'none.yaml') });
    expect(bundles.map((b) => [b.manifest.id, b.register === undefined])).toEqual([['starter', true]]);
  });
});
