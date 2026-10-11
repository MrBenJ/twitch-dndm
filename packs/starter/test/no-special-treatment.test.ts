import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PackApi } from '@dndm/engine';
import { listPackDirs, loadPack, repoRoot } from '@dndm/pack-loader';
import { describe, expect, it } from 'vitest';

const TYPE_KEYS = ['stat', 'slot', 'class', 'ability', 'item', 'monster', 'encounter', 'adventure'];

async function starterIds(): Promise<Set<string>> {
  const dir = listPackDirs().find((d) => d.endsWith(join('packs', 'starter')))!;
  const bundle = await loadPack(dir);
  const ids = new Set<string>();
  for (const { doc } of bundle.content) {
    for (const key of TYPE_KEYS) {
      const v = (doc as Record<string, unknown>)[key];
      if (typeof v === 'string') ids.add(v);
    }
  }
  const record = (id: string) => { ids.add(id); };
  const api: PackApi = {
    effect: record, status: record, passive: record, targeting: record, behavior: record, encounterKind: record,
  } as unknown as PackApi;
  bundle.register!(api);
  for (const id of [...ids]) ids.add(`starter:${id}`);
  return ids;
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === 'node_modules') continue;
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function literals(text: string): string[] {
  const out: string[] = [];
  const re = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

describe('the starter pack gets no special treatment (success criterion 6)', () => {
  it('no string literal anywhere in packages/engine equals a starter-pack ID', async () => {
    const ids = await starterIds();
    expect(ids.size).toBeGreaterThan(40);
    const hits: string[] = [];
    for (const file of tsFiles(join(repoRoot(), 'packages', 'engine'))) {
      for (const lit of literals(readFileSync(file, 'utf8'))) {
        if (ids.has(lit)) hits.push(`${file.slice(repoRoot().length + 1)}: '${lit}'`);
      }
    }
    expect(hits).toEqual([]);
  });
});
