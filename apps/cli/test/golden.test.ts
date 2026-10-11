import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Engine } from '@dndm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { runLines } from '../src/run';
import { setup } from '../src/setup';

const DIR = join(import.meta.dirname, 'golden');
let engine: Engine;
beforeAll(async () => { engine = await setup({}); });

const scripts = readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort();

describe('golden replays', () => {
  it.each(scripts)('%s matches its recorded output', (name) => {
    const lines = readFileSync(join(DIR, name), 'utf8').split('\n');
    const out = runLines(lines, { engine, seed: 1 }).join('\n') + '\n';
    const expectedFile = join(DIR, name.replace(/\.jsonl$/, '.out'));
    if (process.env.UPDATE_GOLDEN || !existsSync(expectedFile)) writeFileSync(expectedFile, out);
    expect(out).toBe(readFileSync(expectedFile, 'utf8'));
  });

  it.each(scripts)('%s is deterministic (success criterion 4)', (name) => {
    const lines = readFileSync(join(DIR, name), 'utf8').split('\n');
    expect(runLines(lines, { engine, seed: 1 })).toEqual(runLines(lines, { engine, seed: 1 }));
    expect(runLines(lines, { engine, seed: 1, json: true })).toEqual(runLines(lines, { engine, seed: 1, json: true }));
  });
});
