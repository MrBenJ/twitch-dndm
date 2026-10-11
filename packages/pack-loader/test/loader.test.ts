import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listPackDirs, loadChannel, loadPack, LoadError, repoRoot } from '../src';

function makePack(root: string, id: string, files: Record<string, string>): string {
  const dir = join(root, id);
  for (const [rel, text] of Object.entries({ 'pack.json': JSON.stringify({ id, version: '1.0.0', name: id, depends: {} }), ...files })) {
    const path = join(dir, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
  return dir;
}

describe('loadPack', () => {
  it('reads the manifest and every YAML document, in path order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packs-'));
    const dir = makePack(root, 'aa', {
      'content/b.yaml': 'slot: hand\nname: Hand\n',
      'content/a.yaml': 'stat: power\nname: Power\ndefault: 5\n---\nstat: grit\nname: Grit\ndefault: 0\n---\n',
      'content/sub/c.yml': 'slot: body\nname: Body\n',
      'content/notes.txt': 'ignored',
    });
    const b = await loadPack(dir);
    expect(b.manifest).toEqual({ id: 'aa', version: '1.0.0', name: 'aa', depends: {} });
    expect(b.official).toBe(false);
    expect(b.content.map((c) => [c.file, c.index, (c.doc as { name: string }).name])).toEqual([
      ['content/a.yaml', 0, 'Power'], ['content/a.yaml', 1, 'Grit'], ['content/b.yaml', 0, 'Hand'], ['content/sub/c.yml', 0, 'Body'],
    ]);
  });

  it('never imports code from non-official folders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packs-'));
    const dir = makePack(root, 'bb', { 'src/index.ts': "throw new Error('this code must not run');\n" });
    const b = await loadPack(dir);
    expect(b).toMatchObject({ official: false, hasCode: true });
    expect(b.register).toBeUndefined();
  });

  it('reports YAML errors with the file and line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packs-'));
    const dir = makePack(root, 'cc', { 'content/bad.yaml': 'stat: x\n\tname: X\n' });
    await expect(loadPack(dir)).rejects.toThrow(LoadError);
    await expect(loadPack(dir)).rejects.toThrow(/content\/bad\.yaml.*line 2/s);
  });

  it('reports a missing or broken pack.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packs-'));
    mkdirSync(join(root, 'dd'));
    await expect(loadPack(join(root, 'dd'))).rejects.toThrow(/pack\.json/);
    writeFileSync(join(root, 'dd', 'pack.json'), '{ nope');
    await expect(loadPack(join(root, 'dd'))).rejects.toThrow(/pack\.json/);
  });
});

describe('repo helpers', () => {
  it('finds the repo and its packs', () => {
    // Any checkout folder name works; the root is wherever the workspace file lives.
    expect(existsSync(join(repoRoot(), 'pnpm-workspace.yaml'))).toBe(true);
    expect(listPackDirs()).toEqual([join(repoRoot(), 'packs', 'starter')]);
  });

  it('loads YAML channel files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ch-'));
    writeFileSync(join(dir, 'c.yaml'), 'packs: [starter]\nsettings:\n  party-cap: 3\n');
    expect(loadChannel(join(dir, 'c.yaml'))).toEqual({ packs: ['starter'], settings: { 'party-cap': 3 } });
  });
});
