import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Engine } from '@dndm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup } from '../src/setup';
import { simCommand, simulate } from '../src/sim';

let engine: Engine;
beforeAll(async () => { engine = await setup({}); });
const base = { party: ['fighter', 'tank', 'healer'], vs: 'slime', runs: 10, seed: 1, reaction: [0, 0] as [number, number], maxTime: 30 * 60_000 };

describe('dndm sim', () => {
  it('runs fights with bots and reports', () => {
    const r = simulate({ engine, ...base });
    expect(r.runs).toBe(10);
    expect(r.winRate).toBe(1);
    expect(r.avgDuration).toBeGreaterThan(0);
    const attack = r.byAbility.find((a) => a.ability === 'starter:attack')!;
    expect(attack.uses).toBeGreaterThan(0);
    expect(attack.damage).toBeGreaterThan(0);
  });

  it('is deterministic for a seed', () => {
    expect(simulate({ engine, ...base })).toEqual(simulate({ engine, ...base }));
  });

  it('healers heal hurt allies', () => {
    const r = simulate({ engine, ...base, vs: 'goblin-king', runs: 3 });
    expect(r.byAbility.find((a) => a.ability === 'starter:heal')?.healing ?? 0).toBeGreaterThan(0);
  });

  it('stops at max-time and reports a timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-'));
    const channel = join(dir, 'c.yaml');
    writeFileSync(channel, [
      'packs: [starter]',
      'overrides:',
      '  starter:slime: { hp: 100000 }',
      'settings:',
      '  class-slot: starter:weapon',
      '  starting-items: [starter:sword, starter:shield, starter:staff]',
    ].join('\n'));
    const strong = await setup({ channel });
    const r = simulate({ engine: strong, ...base, runs: 1, maxTime: 60_000 });
    expect(r).toMatchObject({ runs: 1, wins: 0, timeouts: 1 });
  });

  it.each(['Infinity', '0', '-2', '1.5', 'abc', '100001'])('rejects --runs %s', async (runs) => {
    const lines: string[] = [];
    expect(await simCommand({ party: 'fighter', vs: 'slime', runs, seed: 1, write: (l) => lines.push(l) })).toBe(2);
    expect(lines[0]).toBe('error: --runs must be a whole number from 1 to 100000');
  });

  it('the command prints a report and rejects bad input', async () => {
    const lines: string[] = [];
    expect(await simCommand({ party: 'fighter,tank', vs: 'slime', runs: '3', seed: 1, write: (l) => lines.push(l) })).toBe(0);
    expect(lines.join('\n')).toMatch(/Win rate: 100%/);
    lines.length = 0;
    expect(await simCommand({ party: 'wizard', vs: 'slime', seed: 1, write: (l) => lines.push(l) })).toBe(2);
    expect(lines[0]).toBe("error: Unknown class 'wizard'");
    lines.length = 0;
    expect(await simCommand({ party: 'fighter', vs: 'slime', runs: '2', seed: 1, json: true, write: (l) => lines.push(l) })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'sim', runs: 2 });
  });
});
