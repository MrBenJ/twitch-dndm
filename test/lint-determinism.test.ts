import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findDeterminismViolations } from '../scripts/lint-determinism';

describe('findDeterminismViolations', () => {
  it('flags Math.random, Date.now and new Date()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'det-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\nconst b = Math.random();\nconst c = Date.now();\nconst d = new Date();\n');
    const found = findDeterminismViolations([join(dir, 'src')]);
    expect(found).toHaveLength(3);
    expect(found[0]).toMatch(/a\.ts:2: /);
  });

  it('passes clean files and ignores missing roots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'det-'));
    writeFileSync(join(dir, 'b.ts'), 'export const x = 1;\n');
    expect(findDeterminismViolations([dir, join(dir, 'nope')])).toEqual([]);
  });

  it('finds no violations in the engine and packs', () => {
    expect(findDeterminismViolations(['packages/engine/src', 'packs'])).toEqual([]);
  });
});
