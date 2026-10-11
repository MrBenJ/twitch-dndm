# Project 1, Plan A: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the engine's foundation: the monorepo, units, seeded RNG, IDs, the formula language, the param-schema library, content document schemas, the pack API types, channel config, and a registry that loads packs plus a channel and validates everything, exposed as `createEngine()` with `describe()`.

**Architecture:** `packages/engine` is pure TypeScript with no I/O. A pack bundle (manifest + optional `register` function + parsed content documents) and a channel config go into `buildRegistry`, which orders packs, registers plugins, applies overrides, resolves every reference (marking channel content dormant where the spec allows), normalizes content into typed definitions, and either throws a `ValidationError` with every problem or returns the registry plus warnings. Plan B adds the game loop on top of this registry.

**Tech Stack:** TypeScript 5.9.3, pnpm 12 workspaces, Node.js ≥ 24, Vitest 5.0.3, Zod 4.6.6, tsx 4.23.15.

**Spec:** `docs/superpowers/specs/2026-10-11-engine-and-packs-design.md` (rev 6). Read §4, §5, §7, §8 and §10 before starting. Plan index and flagged decisions: `docs/superpowers/plans/2026-10-11-project-1-README.md`.

## Global Constraints

- `packages/engine` never does I/O and never calls `Math.random`, `Date.now` or `new Date()` (spec §3). The same applies to `packs/*`.
- The engine never names a starter-pack ID in any string literal (spec §1.1 rule 1). Test packs in this plan use made-up IDs only: `tp`, `power`, `grit`, `hand`, `brute`, `mender`, `poke`, `zap`, `mend`, `foe`, `pal`, `club`, `mallet`, `rod`, `blob`, `ogre`, `snooze`, `shielded`, `whack`, `pile`, `hunt`, `ballot`, `show`, `nap`. Never use `attack`, `damage`, `heal`, `self`, `enemy`, `ally`, `weapon`, `story`, `vote`, `shop` or any other ID listed in spec §9.
- Full IDs are `pack:id`. Core IDs use the pack `core`. The channel pack's ID is `channel`.
- Data keys are kebab-case in files and saved state (`grants-class`, `show-for`, `party-cap`). TypeScript fields on normalized definitions are camelCase.
- Durations in files: `500ms`, `8s`, `2m`, `1h` (decimals allowed: `1.5s`). Inside the engine: integer milliseconds.
- Every validation problem is collected; `createEngine` throws one `ValidationError` listing all of them. Dormant references are warnings, not errors.

## Review Focus

1. **Division by zero or huge numbers in a formula** (`attack / target.defense` with defense 0): a person expects 0 damage, not `Infinity` or `NaN`. Test in Task 4.
2. **A formula like `attack -2` or `attack-2`**: a person expects a clear validation message, not a silent wrong result. Test in Task 4.
3. **A YAML document with no type key, or two type keys** (`class:` and `item:` in one document): a person expects an error naming the file and document index. Test in Task 9.
4. **An override that names a disabled pack's content versus one with a typo**: the first is a warning, the second an error. Test in Task 10.
5. **Channel content that refers to a pack that's off, through a chain** (a channel adventure → channel monster → disabled pack's ability): every link goes dormant, nothing errors. Test in Task 10.

---

## File map (this plan)

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, tsconfig.json, vitest.config.ts, .gitignore
scripts/lint-determinism.ts
test/lint-determinism.test.ts
packages/engine/
  package.json
  src/
    units.ts        durations, percents, formatting
    rng.ts          mulberry32 step function
    ids.ts          ID types, parsing, patterns
    errors.ts       Issue, ValidationError, Rejection, PluginError, EngineError
    formula.ts      formula lexer, parser, printer, evaluator
    params.ts       param-schema library `p` + normalizeParams
    content.ts      Zod schemas for content documents, detectDocType, normalized Def types
    pack.ts         PackManifest, PackBundle, PackApi, plugin def types, Ctx interface, widgets
    semver.ts       satisfies(version, range)
    channel.ts      channel config schema, Settings, deepMerge
    registry.ts     buildRegistry orchestration
    resolve.ts      reference resolver + NormalizeCtx implementation
    normalize.ts    per-content-type normalization into Defs
    describe.ts     describe(registry)
    engine.ts       createEngine
    index.ts        public exports
  test/
    helpers/tp-pack.ts   the shared test pack
    units.test.ts, rng.test.ts, ids.test.ts, formula.test.ts, params.test.ts,
    content.test.ts, channel.test.ts, semver.test.ts, registry.test.ts,
    dormancy.test.ts, engine.test.ts
```

---

### Task 1: Workspace scaffold and the determinism check

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/engine/package.json`, `packages/engine/src/index.ts`
- Create: `scripts/lint-determinism.ts`
- Test: `test/lint-determinism.test.ts`

**Interfaces:**
- Produces: `findDeterminismViolations(roots: string[]): string[]` in `scripts/lint-determinism.ts` (each entry `"<file>:<line>: <text>"`). Root scripts `pnpm test`, `pnpm typecheck`, `pnpm lint`. Workspace package `@dndm/engine` whose entry is `packages/engine/src/index.ts`.

- [ ] **Step 1: Create the root files**

`package.json`:
```json
{
  "name": "twitch-dndm",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.4.1",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsx scripts/lint-determinism.ts"
  },
  "devDependencies": {
    "@types/node": "24.19.2",
    "tsx": "4.23.15",
    "typescript": "5.9.3",
    "vitest": "5.0.3"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - packs/*
  - apps/*
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": false,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

`tsconfig.json`:
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": [
    "packages/*/src", "packages/*/test",
    "packs/*/src", "packs/*/test",
    "apps/*/src", "apps/*/test",
    "scripts", "test", "vitest.config.ts"
  ]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
```

`.gitignore`:
```
node_modules/
*.log
.DS_Store
```

`packages/engine/package.json`:
```json
{
  "name": "@dndm/engine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "4.6.6" }
}
```

`packages/engine/src/index.ts`:
```ts
export {};
```

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: lockfile created, no errors.

- [ ] **Step 3: Write the failing test**

`test/lint-determinism.test.ts`:
```ts
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
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm vitest run test/lint-determinism.test.ts`
Expected: FAIL, cannot find module `../scripts/lint-determinism`.

- [ ] **Step 5: Implement**

`scripts/lint-determinism.ts`:
```ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BANNED = [/\bMath\.random\s*\(/, /\bDate\.now\s*\(/, /\bnew\s+Date\s*\(/];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
}

/** Lines in .ts files under `roots` (tests excluded) that use banned nondeterministic calls. */
export function findDeterminismViolations(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) if (existsSync(root)) walk(root, files);
  const found: string[] = [];
  for (const file of files.sort()) {
    readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
      if (BANNED.some((re) => re.test(text))) found.push(`${file}:${i + 1}: ${text.trim()}`);
    });
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = findDeterminismViolations(['packages/engine/src', 'packs']);
  for (const line of found) console.error(line);
  if (found.length) {
    console.error(`\n${found.length} nondeterministic call(s). Use the engine's RNG and the 'now' passed in.`);
    process.exit(1);
  }
  console.log('Determinism check passed.');
}
```

- [ ] **Step 6: Run tests, typecheck and lint**

Run: `pnpm vitest run test/lint-determinism.test.ts && pnpm typecheck && pnpm lint`
Expected: 3 tests pass; typecheck clean; "Determinism check passed."

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: monorepo scaffold and determinism check"
```

---

### Task 2: Units and the seeded RNG

**Files:**
- Create: `packages/engine/src/units.ts`, `packages/engine/src/rng.ts`
- Test: `packages/engine/test/units.test.ts`, `packages/engine/test/rng.test.ts`

**Interfaces:**
- Produces:
  - `parseDuration(value: string | number): number` (ms; throws `Error` with a readable message)
  - `parsePercent(value: string | number): number` (`"25%"` → 25; a number is taken as a percent)
  - `formatDuration(ms: number): string` (`4000` → `"4s"`, rounds seconds up; under 1s → `"1s"`)
  - `nextRandom(state: number): [value: number, next: number]` (value in [0, 1))
  - `seedState(seed: number): number`

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/units.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration, parsePercent } from '../src/units';

describe('parseDuration', () => {
  it.each([
    ['500ms', 500], ['8s', 8000], ['1.5s', 1500], ['2m', 120000], ['1h', 3600000], [250, 250],
  ])('%s -> %d', (input, ms) => expect(parseDuration(input)).toBe(ms));

  it.each(['', '8', 's', '-1s', '1d', 'abc', -5, Number.NaN])('rejects %s', (input) => {
    expect(() => parseDuration(input as string | number)).toThrow(/duration/i);
  });
});

describe('parsePercent', () => {
  it('reads "25%" and plain numbers', () => {
    expect(parsePercent('25%')).toBe(25);
    expect(parsePercent('12.5%')).toBe(12.5);
    expect(parsePercent(40)).toBe(40);
  });
  it('rejects bad input', () => {
    expect(() => parsePercent('25')).toThrow(/percent/i);
    expect(() => parsePercent('x%')).toThrow(/percent/i);
  });
});

describe('formatDuration', () => {
  it('rounds up to whole seconds', () => {
    expect(formatDuration(4000)).toBe('4s');
    expect(formatDuration(3200)).toBe('4s');
    expect(formatDuration(1)).toBe('1s');
    expect(formatDuration(90000)).toBe('90s');
  });
});
```

`packages/engine/test/rng.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { nextRandom, seedState } from '../src/rng';

describe('rng', () => {
  it('is deterministic for a seed', () => {
    const run = (seed: number) => {
      let s = seedState(seed);
      const out: number[] = [];
      for (let i = 0; i < 5; i++) { const [v, n] = nextRandom(s); out.push(v); s = n; }
      return out;
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('stays in [0, 1)', () => {
    let s = seedState(7);
    for (let i = 0; i < 10000; i++) {
      const [v, n] = nextRandom(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      s = n;
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/engine/test/units.test.ts packages/engine/test/rng.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/engine/src/units.ts`:
```ts
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** "8s" -> 8000. A number is taken as milliseconds. */
export function parseDuration(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid duration: ${value}`);
    return Math.round(value);
  }
  const m = DURATION.exec(value.trim());
  if (!m) throw new Error(`Invalid duration '${value}' (use 500ms, 8s, 2m or 1h)`);
  return Math.round(Number(m[1]) * UNIT_MS[m[2]!]!);
}

/** "25%" -> 25. A number is taken as a percent already. */
export function parsePercent(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid percent: ${value}`);
    return value;
  }
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(value.trim());
  if (!m) throw new Error(`Invalid percent '${value}' (write it like 25%)`);
  return Number(m[1]);
}

/** Milliseconds as whole seconds, rounded up: 3200 -> "4s". */
export function formatDuration(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}
```

`packages/engine/src/rng.ts`:
```ts
/** Turn any seed into a 32-bit RNG state. */
export function seedState(seed: number): number {
  return (Math.floor(seed) >>> 0) || 0x9e3779b9;
}

/** One mulberry32 step: returns a float in [0, 1) and the next state. */
export function nextRandom(state: number): [number, number] {
  const next = (state + 0x6d2b79f5) >>> 0;
  let r = Math.imul(next ^ (next >>> 15), next | 1);
  r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
  return [((r ^ (r >>> 14)) >>> 0) / 4294967296, next];
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run packages/engine/test/units.test.ts packages/engine/test/rng.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): durations, percents and seeded RNG"
```

---

### Task 3: IDs and errors

**Files:**
- Create: `packages/engine/src/ids.ts`, `packages/engine/src/errors.ts`
- Test: `packages/engine/test/ids.test.ts`

**Interfaces:**
- Produces (`ids.ts`):
  - `CORE = 'core'`, `CHANNEL = 'channel'`
  - `type ContentType = 'stat' | 'slot' | 'class' | 'ability' | 'item' | 'monster' | 'encounter' | 'adventure'`
  - `type PluginType = 'effect' | 'status' | 'passive' | 'targeting' | 'behavior' | 'encounterKind'`
  - `type RefType = ContentType | PluginType`
  - `CONTENT_TYPES: readonly ContentType[]` (in that order; also the normalization order)
  - `PACK_ID_PATTERN = /^[a-z][a-z0-9-]*$/`, `LOCAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/`
  - `splitId(ref: string): { pack: string | null; id: string }`
  - `fullId(pack: string, id: string): string`
  - `packOf(full: string): string`, `localOf(full: string): string`
  - `refKey(type: RefType, full: string): string` (`"ability starter:x"`, used for dormancy sets)
- Produces (`errors.ts`):
  - `interface Issue { level: 'error' | 'warning'; pack: string; file?: string; doc?: number; path: string; message: string }`
  - `formatIssue(issue: Issue): string`
  - `class ValidationError extends Error { issues: Issue[] }`
  - `class Rejection extends Error { code: string }` with `constructor(message: string, code = 'rejected')`
  - `class PluginError extends Error { pack: string; plugin: string; cause: unknown }`
  - `class EngineError extends Error { code: string }`

- [ ] **Step 1: Write the failing test**

`packages/engine/test/ids.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatIssue, Rejection, ValidationError } from '../src/errors';
import { fullId, localOf, packOf, refKey, splitId } from '../src/ids';

describe('ids', () => {
  it('splits prefixed and bare IDs', () => {
    expect(splitId('tp:club')).toEqual({ pack: 'tp', id: 'club' });
    expect(splitId('club')).toEqual({ pack: null, id: 'club' });
  });
  it('builds and takes apart full IDs', () => {
    expect(fullId('tp', 'club')).toBe('tp:club');
    expect(packOf('tp:club')).toBe('tp');
    expect(localOf('tp:club')).toBe('club');
    expect(refKey('ability', 'tp:club')).toBe('ability tp:club');
  });
});

describe('errors', () => {
  it('formats issues with location', () => {
    expect(formatIssue({ level: 'error', pack: 'tp', file: 'a.yaml', doc: 2, path: 'steps[0]', message: 'Unknown effect' }))
      .toBe('error: [tp] a.yaml#2 steps[0]: Unknown effect');
    expect(formatIssue({ level: 'warning', pack: 'channel', path: '', message: 'Dormant' }))
      .toBe('warning: [channel] Dormant');
  });
  it('ValidationError lists every issue', () => {
    const e = new ValidationError([
      { level: 'error', pack: 'a', path: 'x', message: 'one' },
      { level: 'error', pack: 'b', path: 'y', message: 'two' },
    ]);
    expect(e.message).toContain('one');
    expect(e.message).toContain('two');
    expect(e.issues).toHaveLength(2);
  });
  it('Rejection carries a code', () => {
    expect(new Rejection('Nope').code).toBe('rejected');
    expect(new Rejection('Cooling', 'on-cooldown').code).toBe('on-cooldown');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/engine/test/ids.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/engine/src/ids.ts`:
```ts
export const CORE = 'core';
export const CHANNEL = 'channel';

export type ContentType = 'stat' | 'slot' | 'class' | 'ability' | 'item' | 'monster' | 'encounter' | 'adventure';
export type PluginType = 'effect' | 'status' | 'passive' | 'targeting' | 'behavior' | 'encounterKind';
export type RefType = ContentType | PluginType;

/** Content types in normalization order: later types may depend on earlier ones. */
export const CONTENT_TYPES: readonly ContentType[] = [
  'stat', 'slot', 'class', 'ability', 'item', 'monster', 'encounter', 'adventure',
];
export const PLUGIN_TYPES: readonly PluginType[] = [
  'effect', 'status', 'passive', 'targeting', 'behavior', 'encounterKind',
];

export const PACK_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const LOCAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function splitId(ref: string): { pack: string | null; id: string } {
  const i = ref.indexOf(':');
  return i === -1 ? { pack: null, id: ref } : { pack: ref.slice(0, i), id: ref.slice(i + 1) };
}

export function fullId(pack: string, id: string): string {
  return `${pack}:${id}`;
}

export function packOf(full: string): string {
  return splitId(full).pack ?? '';
}

export function localOf(full: string): string {
  return splitId(full).id;
}

export function refKey(type: RefType, full: string): string {
  return `${type} ${full}`;
}
```

`packages/engine/src/errors.ts`:
```ts
export interface Issue {
  level: 'error' | 'warning';
  pack: string;
  file?: string;
  doc?: number;
  path: string;
  message: string;
}

export function formatIssue(i: Issue): string {
  const where = [i.file ? `${i.file}${i.doc !== undefined ? `#${i.doc}` : ''}` : '', i.path].filter(Boolean).join(' ');
  return `${i.level}: [${i.pack}] ${where ? `${where}: ` : ''}${i.message}`;
}

export class ValidationError extends Error {
  constructor(readonly issues: Issue[]) {
    super(`Validation failed:\n${issues.map(formatIssue).join('\n')}`);
    this.name = 'ValidationError';
  }
}

/** A viewer-facing refusal. The command is rejected and the game state is unchanged. */
export class Rejection extends Error {
  constructor(message: string, readonly code: string = 'rejected') {
    super(message);
    this.name = 'Rejection';
  }
}

/** Any other throw from pack code, tagged with where it came from. */
export class PluginError extends Error {
  constructor(readonly pack: string, readonly plugin: string, readonly cause: unknown) {
    super(`Error in ${plugin} (pack ${pack}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PluginError';
  }
}

/** An engine-level refusal with a stable code, e.g. 'content-in-use'. */
export class EngineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}
```

Note: `verbatimModuleSyntax` plus parameter properties (`readonly issues`) is fine for tsc, and tsx/esbuild support them.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/engine/test/ids.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): IDs and error types"
```

---

### Task 4: The formula language

**Files:**
- Create: `packages/engine/src/formula.ts`
- Test: `packages/engine/test/formula.test.ts`

**Interfaces:**
- Produces:
  - `type FormulaFn = 'min' | 'max' | 'floor' | 'ceil' | 'round' | 'random'`
  - `type FormulaVar = { side: 'source' | 'target'; what: 'hp' | 'hp.max' | 'level' | 'stat'; stat?: string }`
  - `type FormulaNode = { k: 'num'; v: number } | ({ k: 'var' } & FormulaVar) | { k: 'neg'; a: FormulaNode } | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: FormulaNode; b: FormulaNode } | { k: 'call'; fn: FormulaFn; args: FormulaNode[] }`
  - `class FormulaError extends Error`
  - `parseFormula(text: string): FormulaNode` (throws `FormulaError`)
  - `printFormula(node: FormulaNode): string` (canonical text that parses back to the same tree)
  - `formulaVars(node: FormulaNode): FormulaVar[]`
  - `mapFormulaStats(node: FormulaNode, fn: (stat: string) => string): FormulaNode`
  - `interface FormulaEnv { value(v: FormulaVar): number; random(a: number, b: number): number }`
  - `evaluateFormula(node: FormulaNode, env: FormulaEnv): number` (never returns NaN or ±Infinity; division by zero gives 0)

- [ ] **Step 1: Write the failing test**

`packages/engine/test/formula.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  evaluateFormula, FormulaError, formulaVars, mapFormulaStats, parseFormula, printFormula,
  type FormulaEnv, type FormulaVar,
} from '../src/formula';

const env = (vals: Record<string, number>, rand = 0.5): FormulaEnv => ({
  value: (v: FormulaVar) => {
    const key = `${v.side}.${v.what === 'stat' ? v.stat : v.what}`;
    return vals[key] ?? 0;
  },
  random: (a, b) => a + (b - a) * rand,
});
const ev = (text: string, vals: Record<string, number> = {}, rand?: number) =>
  evaluateFormula(parseFormula(text), env(vals, rand));

describe('parse and evaluate', () => {
  it('does arithmetic with precedence and parentheses', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 / 4')).toBe(2.5);
    expect(ev('.5 + 1.5')).toBe(2);
  });

  it('reads source and target stats, hp and level', () => {
    const vals = { 'source.power': 10, 'target.power': 3, 'source.hp': 50, 'source.hp.max': 80, 'target.level': 4 };
    expect(ev('1.5 * power + 2', vals)).toBe(17);
    expect(ev('power - target.power', vals)).toBe(7);
    expect(ev('hp.max - hp', vals)).toBe(30);
    expect(ev('target.level * 2', vals)).toBe(8);
  });

  it('reads hyphenated and prefixed stat names', () => {
    const f = parseFormula('luck-bonus * 2 + tp:mana + target.tp:mana');
    expect(formulaVars(f)).toEqual([
      { side: 'source', what: 'stat', stat: 'luck-bonus' },
      { side: 'source', what: 'stat', stat: 'tp:mana' },
      { side: 'target', what: 'stat', stat: 'tp:mana' },
    ]);
  });

  it('treats a hyphen without spaces as part of a name', () => {
    expect(formulaVars(parseFormula('power-2'))).toEqual([{ side: 'source', what: 'stat', stat: 'power-2' }]);
  });

  it('requires spaces around binary minus', () => {
    expect(() => parseFormula('power -2')).toThrow(/space on both sides/);
    expect(() => parseFormula('2-power')).toThrow(/space on both sides/);
    expect(ev('power - 2', { 'source.power': 5 })).toBe(3);
  });

  it('allows unary minus', () => {
    expect(ev('-2 * 3')).toBe(-6);
    expect(ev('max(-1, 4)')).toBe(4);
    expect(ev('2 * -power', { 'source.power': 3 })).toBe(-6);
  });

  it('supports every function', () => {
    expect(ev('min(3, 1, 2)')).toBe(1);
    expect(ev('max(3, 1, 2)')).toBe(3);
    expect(ev('floor(2.7)')).toBe(2);
    expect(ev('ceil(2.1)')).toBe(3);
    expect(ev('round(2.5)')).toBe(3);
    expect(ev('random(1, 3)', {}, 0.5)).toBe(2);
  });

  it('never yields NaN or Infinity', () => {
    expect(ev('5 / 0')).toBe(0);
    expect(ev('power / target.power', { 'source.power': 5, 'target.power': 0 })).toBe(0);
    expect(ev('0 / 0')).toBe(0);
  });

  it('rejects bad syntax with readable messages', () => {
    expect(() => parseFormula('')).toThrow(FormulaError);
    expect(() => parseFormula('1 +')).toThrow(/Unexpected end/);
    expect(() => parseFormula('(1 + 2')).toThrow(/Expected '\)'/);
    expect(() => parseFormula('foo(1)')).toThrow(/Unknown function 'foo'/);
    expect(() => parseFormula('floor(1, 2)')).toThrow(/floor takes 1/);
    expect(() => parseFormula('random(1)')).toThrow(/random takes 2/);
    expect(() => parseFormula('1 $ 2')).toThrow(/Unexpected '\$'/);
    expect(() => parseFormula('hp.min')).toThrow(/Unknown name 'hp.min'/);
    expect(() => parseFormula('2power')).toThrow(/after a number/);
  });
});

describe('printFormula and mapFormulaStats', () => {
  it('round-trips', () => {
    for (const text of ['1.5 * power + 2', 'power - target.power', 'max(-1, random(1, 2))', 'hp.max / 2', '-(power)']) {
      const node = parseFormula(text);
      expect(parseFormula(printFormula(node))).toEqual(node);
    }
  });
  it('rewrites stat names', () => {
    const node = mapFormulaStats(parseFormula('power + target.power + hp'), (s) => `tp:${s}`);
    expect(printFormula(node)).toBe('((tp:power + target.tp:power) + hp)');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/engine/test/formula.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/engine/src/formula.ts`:
```ts
export type FormulaFn = 'min' | 'max' | 'floor' | 'ceil' | 'round' | 'random';
export type FormulaVar = { side: 'source' | 'target'; what: 'hp' | 'hp.max' | 'level' | 'stat'; stat?: string };
export type FormulaNode =
  | { k: 'num'; v: number }
  | ({ k: 'var' } & FormulaVar)
  | { k: 'neg'; a: FormulaNode }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: FormulaNode; b: FormulaNode }
  | { k: 'call'; fn: FormulaFn; args: FormulaNode[] };

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

const ARITY: Record<FormulaFn, [number, number]> = {
  min: [1, Infinity], max: [1, Infinity], floor: [1, 1], ceil: [1, 1], round: [1, 1], random: [2, 2],
};

type Tok =
  | { t: 'num'; v: number; pos: number }
  | { t: 'name'; v: string; pos: number }
  | { t: 'op'; v: string; pos: number; spaceBefore: boolean; spaceAfter: boolean }
  | { t: 'end'; pos: number };

const isLetter = (c: string | undefined) => c !== undefined && /[A-Za-z]/.test(c);
const isWordChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

function lex(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(\d*\.\d+|\d+)/.exec(text.slice(i))!;
      toks.push({ t: 'num', v: Number(m[1]), pos: i });
      i += m[1]!.length;
      if (isLetter(text[i])) throw new FormulaError(`Unexpected '${text[i]}' after a number at ${i + 1}`);
      continue;
    }
    if (isLetter(c)) {
      let j = i;
      const readWord = (start: number) => {
        while (
          j < text.length &&
          (isWordChar(text[j]) || (text[j] === '-' && j > start && isWordChar(text[j - 1]) && isWordChar(text[j + 1])))
        ) j++;
      };
      readWord(i);
      while ((text[j] === ':' || text[j] === '.') && isLetter(text[j + 1])) {
        j++;
        readWord(j);
      }
      toks.push({ t: 'name', v: text.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if ('+-*/(),'.includes(c)) {
      toks.push({ t: 'op', v: c, pos: i, spaceBefore: isSpace(text[i - 1]) || i === 0, spaceAfter: isSpace(text[i + 1]) });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected '${c}' at ${i + 1}`);
  }
  toks.push({ t: 'end', pos: text.length });
  return toks;
}

function varFromName(name: string): FormulaVar {
  let side: 'source' | 'target' = 'source';
  let rest = name;
  if (rest.startsWith('target.')) {
    side = 'target';
    rest = rest.slice('target.'.length);
  }
  if (rest === 'hp') return { side, what: 'hp' };
  if (rest === 'hp.max') return { side, what: 'hp.max' };
  if (rest === 'level') return { side, what: 'level' };
  if (rest.includes('.') || rest === '') throw new FormulaError(`Unknown name '${name}'`);
  return { side, what: 'stat', stat: rest };
}

export function parseFormula(text: string): FormulaNode {
  const toks = lex(text);
  let k = 0;
  const peek = () => toks[k]!;
  const isOp = (v: string) => { const t = peek(); return t.t === 'op' && t.v === v; };
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`Expected '${v}' at ${peek().pos + 1}`);
    k++;
  };

  const expr = (): FormulaNode => {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = peek() as Extract<Tok, { t: 'op' }>;
      if (op.v === '-' && !(op.spaceBefore && op.spaceAfter)) {
        throw new FormulaError(`Put a space on both sides of '-' for subtraction (at ${op.pos + 1})`);
      }
      k++;
      left = { k: 'bin', op: op.v as '+' | '-', a: left, b: term() };
    }
    return left;
  };
  const term = (): FormulaNode => {
    let left = unary();
    while (isOp('*') || isOp('/')) {
      const op = (peek() as Extract<Tok, { t: 'op' }>).v as '*' | '/';
      k++;
      left = { k: 'bin', op, a: left, b: unary() };
    }
    return left;
  };
  const unary = (): FormulaNode => {
    if (isOp('-')) { k++; return { k: 'neg', a: unary() }; }
    if (isOp('+')) { k++; return unary(); }
    return primary();
  };
  const primary = (): FormulaNode => {
    const t = peek();
    if (t.t === 'end') throw new FormulaError('Unexpected end of formula');
    if (t.t === 'num') { k++; return { k: 'num', v: t.v }; }
    if (t.t === 'op' && t.v === '(') { k++; const e = expr(); expectOp(')'); return e; }
    if (t.t === 'name') {
      k++;
      if (isOp('(')) {
        if (!(t.v in ARITY)) throw new FormulaError(`Unknown function '${t.v}'`);
        const fn = t.v as FormulaFn;
        k++;
        const args: FormulaNode[] = [];
        if (!isOp(')')) {
          args.push(expr());
          while (isOp(',')) { k++; args.push(expr()); }
        }
        expectOp(')');
        const [lo, hi] = ARITY[fn];
        if (args.length < lo || args.length > hi) {
          throw new FormulaError(`${fn} takes ${lo === hi ? lo : `at least ${lo}`} argument${lo === 1 && hi === 1 ? '' : 's'}`);
        }
        return { k: 'call', fn, args };
      }
      return { k: 'var', ...varFromName(t.v) };
    }
    throw new FormulaError(`Unexpected '${(t as { v: string }).v}' at ${t.pos + 1}`);
  };

  const node = expr();
  if (peek().t !== 'end') {
    const t = peek() as Exclude<Tok, { t: 'end' }>;
    throw new FormulaError(`Unexpected '${t.v}' at ${t.pos + 1}`);
  }
  return node;
}

export function printFormula(node: FormulaNode): string {
  switch (node.k) {
    case 'num': return String(node.v);
    case 'var': {
      const name = node.what === 'stat' ? node.stat! : node.what;
      return node.side === 'target' ? `target.${name}` : name;
    }
    case 'neg': return `-(${printFormula(node.a)})`;
    case 'bin': return `(${printFormula(node.a)} ${node.op} ${printFormula(node.b)})`;
    case 'call': return `${node.fn}(${node.args.map(printFormula).join(', ')})`;
  }
}

export function formulaVars(node: FormulaNode): FormulaVar[] {
  switch (node.k) {
    case 'num': return [];
    case 'var': return [node.what === 'stat' ? { side: node.side, what: 'stat', stat: node.stat } : { side: node.side, what: node.what }];
    case 'neg': return formulaVars(node.a);
    case 'bin': return [...formulaVars(node.a), ...formulaVars(node.b)];
    case 'call': return node.args.flatMap(formulaVars);
  }
}

export function mapFormulaStats(node: FormulaNode, fn: (stat: string) => string): FormulaNode {
  switch (node.k) {
    case 'num': return node;
    case 'var': return node.what === 'stat' ? { ...node, stat: fn(node.stat!) } : node;
    case 'neg': return { k: 'neg', a: mapFormulaStats(node.a, fn) };
    case 'bin': return { ...node, a: mapFormulaStats(node.a, fn), b: mapFormulaStats(node.b, fn) };
    case 'call': return { ...node, args: node.args.map((a) => mapFormulaStats(a, fn)) };
  }
}

export interface FormulaEnv {
  value(v: FormulaVar): number;
  random(a: number, b: number): number;
}

const finite = (n: number) => (Number.isFinite(n) ? n : 0);

export function evaluateFormula(node: FormulaNode, env: FormulaEnv): number {
  switch (node.k) {
    case 'num': return node.v;
    case 'var': return finite(env.value(node));
    case 'neg': return -evaluateFormula(node.a, env);
    case 'bin': {
      const a = evaluateFormula(node.a, env);
      const b = evaluateFormula(node.b, env);
      if (node.op === '+') return finite(a + b);
      if (node.op === '-') return finite(a - b);
      if (node.op === '*') return finite(a * b);
      return b === 0 ? 0 : finite(a / b);
    }
    case 'call': {
      const args = node.args.map((a) => evaluateFormula(a, env));
      switch (node.fn) {
        case 'min': return Math.min(...args);
        case 'max': return Math.max(...args);
        case 'floor': return Math.floor(args[0]!);
        case 'ceil': return Math.ceil(args[0]!);
        case 'round': return Math.round(args[0]!);
        case 'random': return finite(env.random(args[0]!, args[1]!));
      }
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/engine/test/formula.test.ts`
Expected: PASS. If the round-trip test fails for `-(power)`, check that `printFormula` of `neg` prints `-(x)` and that parsing `-(power)` produces `{ k: 'neg', a: var }`.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): formula language"
```

---

### Task 5: The param-schema library

Plugin params (effect, status, passive, targeting, behavior, encounter kind) are described with a small schema library `p`. It validates content, converts units (durations to ms, percents to numbers), resolves references to full IDs and canonicalizes formulas. Resolving references needs the registry, so normalization takes a `NormalizeCtx` that the registry supplies (Task 10). This task tests it with a fake context.

**Files:**
- Create: `packages/engine/src/params.ts`
- Test: `packages/engine/test/params.test.ts`

**Interfaces:**
- Consumes: `parseDuration`, `parsePercent` (Task 2); `RefType` (Task 3).
- Produces:
  - `type ParamSchema` (union below), `p` builder object
  - `interface Step { effect: string; params: unknown }`
  - `interface StatusApplication { status: string; duration: number | null; params: unknown }`
  - `type AmountOrPercent = { amount: number } | { percent: number }`
  - `interface NormalizeCtx { ref(type: RefType, raw: string, path: string): string | null; formula(text: string, path: string, noSource: boolean): string | null; steps(value: unknown, path: string, noSource: boolean): Step[] | null; statusApplication(value: unknown, path: string, noSource: boolean): StatusApplication | null; issue(path: string, message: string): void }`
  - `normalizeParams(schema: ParamSchema, value: unknown, ctx: NormalizeCtx, path?: string, noSource?: boolean): unknown` (returns the normalized value; problems go to `ctx.issue`; a failed field normalizes to `undefined`)

- [ ] **Step 1: Write the failing test**

`packages/engine/test/params.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { normalizeParams, p, type NormalizeCtx } from '../src/params';

function fakeCtx() {
  const issues: string[] = [];
  const ctx: NormalizeCtx = {
    ref: (type, raw, path) => {
      if (raw === 'missing') { issues.push(`${path}: Unknown ${type} '${raw}'`); return null; }
      return raw.includes(':') ? raw : `tp:${raw}`;
    },
    formula: (text, path, noSource) => {
      if (noSource && text.includes('power')) { issues.push(`${path}: no source`); return null; }
      return `canon(${text})`;
    },
    steps: (value) => (value as unknown[]).map(() => ({ effect: 'tp:poke', params: {} })),
    statusApplication: (value) => ({ status: 'tp:snooze', duration: 1000, params: value }),
    issue: (path, message) => issues.push(`${path}: ${message}`),
  };
  return { ctx, issues };
}

describe('normalizeParams', () => {
  it('normalizes a full object', () => {
    const { ctx, issues } = fakeCtx();
    const schema = p.object({
      power: p.formula(),
      wait: p.duration(),
      share: p.percent(),
      target: p.ref('status'),
      count: p.optional(p.integer({ min: 1 }), 1),
      mode: p.enum('all', 'some'),
      tags: p.list(p.string()),
      weights: p.refMap('ability', p.number({ min: 0 })),
      labels: p.record(p.string()),
      heal: p.amountOrPercent(),
      on: p.boolean(),
    });
    const out = normalizeParams(schema, {
      power: '2 * power', wait: '8s', share: '25%', target: 'snooze', mode: 'all',
      tags: ['a'], weights: { whack: 3, 'tp:pile': 1 }, labels: { left: 'Left' }, heal: '50%', on: true,
    }, ctx);
    expect(issues).toEqual([]);
    expect(out).toEqual({
      power: 'canon(2 * power)', wait: 8000, share: 25, target: 'tp:snooze', count: 1, mode: 'all',
      tags: ['a'], weights: { 'tp:whack': 3, 'tp:pile': 1 }, labels: { left: 'Left' }, heal: { percent: 50 }, on: true,
    });
  });

  it('accepts numbers as formulas and amounts', () => {
    const { ctx } = fakeCtx();
    expect(normalizeParams(p.formula(), 15, ctx)).toBe('canon(15)');
    expect(normalizeParams(p.amountOrPercent(), 40, ctx)).toEqual({ amount: 40 });
  });

  it('reports every problem with a path', () => {
    const { ctx, issues } = fakeCtx();
    normalizeParams(p.object({ a: p.number({ max: 5 }), b: p.duration(), c: p.ref('item'), d: p.enum('x') }),
      { a: 9, b: 'soon', c: 'missing', d: 'y', extra: 1 }, ctx);
    expect(issues).toEqual([
      'a: must be at most 5',
      "b: Invalid duration 'soon' (use 500ms, 8s, 2m or 1h)",
      "c: Unknown item 'missing'",
      'd: must be one of: x',
      'extra: unknown field',
    ]);
  });

  it('requires non-optional fields', () => {
    const { ctx, issues } = fakeCtx();
    normalizeParams(p.object({ a: p.number() }), {}, ctx);
    expect(issues).toEqual(['a: required']);
  });

  it('passes noSource down to formulas inside objects', () => {
    const { ctx, issues } = fakeCtx();
    normalizeParams(p.object({ f: p.formula() }), { f: 'power' }, ctx, '', true);
    expect(issues).toEqual(['f: no source']);
  });

  it('delegates steps and status applications to the ctx', () => {
    const { ctx } = fakeCtx();
    expect(normalizeParams(p.steps(), [{ poke: {} }], ctx)).toEqual([{ effect: 'tp:poke', params: {} }]);
    expect(normalizeParams(p.statusApplication(), { status: 'snooze' }, ctx))
      .toEqual({ status: 'tp:snooze', duration: 1000, params: { status: 'snooze' } });
  });

  it('treats a missing schema value of p.any as is', () => {
    const { ctx } = fakeCtx();
    expect(normalizeParams(p.any(), { x: [1] }, ctx)).toEqual({ x: [1] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/engine/test/params.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/engine/src/params.ts`:
```ts
import type { RefType } from './ids';
import { parseDuration, parsePercent } from './units';

export type ParamSchema =
  | { t: 'number'; min?: number; max?: number; integer?: boolean }
  | { t: 'string' }
  | { t: 'boolean' }
  | { t: 'duration' }
  | { t: 'percent' }
  | { t: 'amountOrPercent' }
  | { t: 'formula' }
  | { t: 'ref'; ref: RefType }
  | { t: 'enum'; values: string[] }
  | { t: 'list'; of: ParamSchema }
  | { t: 'record'; of: ParamSchema }
  | { t: 'refMap'; ref: RefType; of: ParamSchema }
  | { t: 'object'; fields: Record<string, ParamSchema> }
  | { t: 'optional'; of: ParamSchema; default?: unknown }
  | { t: 'steps'; noSource?: boolean }
  | { t: 'statusApplication' }
  | { t: 'any' };

export interface Step { effect: string; params: unknown }
export interface StatusApplication { status: string; duration: number | null; params: unknown }
export type AmountOrPercent = { amount: number } | { percent: number };

export const p = {
  number: (o: { min?: number; max?: number } = {}): ParamSchema => ({ t: 'number', ...o }),
  integer: (o: { min?: number; max?: number } = {}): ParamSchema => ({ t: 'number', integer: true, ...o }),
  string: (): ParamSchema => ({ t: 'string' }),
  boolean: (): ParamSchema => ({ t: 'boolean' }),
  duration: (): ParamSchema => ({ t: 'duration' }),
  percent: (): ParamSchema => ({ t: 'percent' }),
  amountOrPercent: (): ParamSchema => ({ t: 'amountOrPercent' }),
  formula: (): ParamSchema => ({ t: 'formula' }),
  ref: (ref: RefType): ParamSchema => ({ t: 'ref', ref }),
  enum: (...values: string[]): ParamSchema => ({ t: 'enum', values }),
  list: (of: ParamSchema): ParamSchema => ({ t: 'list', of }),
  record: (of: ParamSchema): ParamSchema => ({ t: 'record', of }),
  refMap: (ref: RefType, of: ParamSchema): ParamSchema => ({ t: 'refMap', ref, of }),
  object: (fields: Record<string, ParamSchema>): ParamSchema => ({ t: 'object', fields }),
  optional: (of: ParamSchema, dflt?: unknown): ParamSchema => ({ t: 'optional', of, default: dflt }),
  steps: (o: { noSource?: boolean } = {}): ParamSchema => ({ t: 'steps', ...o }),
  statusApplication: (): ParamSchema => ({ t: 'statusApplication' }),
  any: (): ParamSchema => ({ t: 'any' }),
};

export interface NormalizeCtx {
  ref(type: RefType, raw: string, path: string): string | null;
  formula(text: string, path: string, noSource: boolean): string | null;
  steps(value: unknown, path: string, noSource: boolean): Step[] | null;
  statusApplication(value: unknown, path: string, noSource: boolean): StatusApplication | null;
  issue(path: string, message: string): void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const join = (path: string, key: string | number) =>
  typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;

export function normalizeParams(schema: ParamSchema, value: unknown, ctx: NormalizeCtx, path = '', noSource = false): unknown {
  const fail = (message: string): undefined => { ctx.issue(path, message); return undefined; };
  switch (schema.t) {
    case 'any': return value;
    case 'optional':
      return value === undefined || value === null ? schema.default : normalizeParams(schema.of, value, ctx, path, noSource);
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('must be a number');
      if (schema.integer && !Number.isInteger(value)) return fail('must be a whole number');
      if (schema.min !== undefined && value < schema.min) return fail(`must be at least ${schema.min}`);
      if (schema.max !== undefined && value > schema.max) return fail(`must be at most ${schema.max}`);
      return value;
    }
    case 'string': return typeof value === 'string' ? value : fail('must be text');
    case 'boolean': return typeof value === 'boolean' ? value : fail('must be true or false');
    case 'duration':
    case 'percent': {
      if (typeof value !== 'string' && typeof value !== 'number') return fail(`must be a ${schema.t}`);
      try { return schema.t === 'duration' ? parseDuration(value) : parsePercent(value); }
      catch (e) { return fail((e as Error).message); }
    }
    case 'amountOrPercent': {
      if (typeof value === 'number' && Number.isFinite(value)) return { amount: value };
      if (typeof value === 'string') {
        try { return { percent: parsePercent(value) }; } catch (e) { return fail((e as Error).message); }
      }
      return fail('must be a number or a percent like 50%');
    }
    case 'formula': {
      if (typeof value === 'number' && Number.isFinite(value)) return ctx.formula(String(value), path, noSource) ?? undefined;
      if (typeof value !== 'string') return fail('must be a number or a formula');
      return ctx.formula(value, path, noSource) ?? undefined;
    }
    case 'ref': {
      if (typeof value !== 'string' || value === '') return fail(`must be a ${schema.ref} ID`);
      return ctx.ref(schema.ref, value, path) ?? undefined;
    }
    case 'enum':
      return typeof value === 'string' && schema.values.includes(value) ? value : fail(`must be one of: ${schema.values.join(', ')}`);
    case 'list': {
      if (!Array.isArray(value)) return fail('must be a list');
      return value.map((v, i) => normalizeParams(schema.of, v, ctx, join(path, i), noSource));
    }
    case 'record': {
      if (!isObj(value)) return fail('must be a map');
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeParams(schema.of, v, ctx, join(path, k), noSource)]));
    }
    case 'refMap': {
      if (!isObj(value)) return fail('must be a map');
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const id = ctx.ref(schema.ref, k, join(path, k));
        const nv = normalizeParams(schema.of, v, ctx, join(path, k), noSource);
        if (id) out[id] = nv;
      }
      return out;
    }
    case 'object': {
      if (!isObj(value)) return fail('must be a map of fields');
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(schema.fields)) {
        const v = value[key];
        if ((v === undefined || v === null) && field.t !== 'optional') { ctx.issue(join(path, key), 'required'); continue; }
        const nv = normalizeParams(field, v, ctx, join(path, key), noSource);
        if (nv !== undefined) out[key] = nv;
      }
      for (const key of Object.keys(value)) if (!(key in schema.fields)) ctx.issue(join(path, key), 'unknown field');
      return out;
    }
    case 'steps': return ctx.steps(value, path, noSource || !!schema.noSource) ?? undefined;
    case 'statusApplication': return ctx.statusApplication(value, path, noSource) ?? undefined;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/engine/test/params.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): param-schema library"
```

---

### Task 6: Content document schemas and pack/plugin types

**Files:**
- Create: `packages/engine/src/content.ts`, `packages/engine/src/pack.ts`
- Test: `packages/engine/test/content.test.ts`

**Interfaces:**
- Consumes: `ContentType` (Task 3), `ParamSchema`, `Step`, `StatusApplication` (Task 5).
- Produces (`content.ts`):
  - `DOC_SCHEMAS: Record<ContentType, z.ZodType>` (Zod schemas over the raw kebab-case documents)
  - `detectDocType(doc: unknown): { type: ContentType; id: string } | { error: string }`
  - Normalized definition types (camelCase):
    ```ts
    interface StatDef { id: string; name: string; icon: string | null; default: number; perLevel: number }
    interface SlotDef { id: string; name: string; order: number }
    interface PassiveUse { passive: string; params: unknown }
    interface TargetUse { rule: string; params: unknown }
    interface ClassDef { id; name; description: string; icon: string | null; tags: string[]; stats: Record<string, number>; abilities: string[]; passives: PassiveUse[] }
    interface AbilityDef { id; name; description; icon; cooldown: number; when: 'fight' | 'anytime'; target: TargetUse; steps: Step[] }
    interface ItemDef { id; name; description; icon; slot: string | null; grantsClass: string | null; stats: Record<string, number>; passives: PassiveUse[]; abilities: string[]; use: string | null; uses: number; price: number }
    interface MonsterDef { id; name; description; image: string | null; tags: string[]; hp: number; stats: Record<string, number>; abilities: string[]; passives: PassiveUse[]; behavior: { behavior: string; params: unknown }; interval: number | null; rewards: { xp: number; gold: number }; drops: { item: string; chance: number }[] }
    interface EncounterSpec { kind: string; params: unknown }
    interface EncounterDef { id; name: string; spec: EncounterSpec }
    interface AdventureNode { spec: EncounterSpec | null; use: string | null; next: string | Record<string, string> | null }
    interface AdventureDef { id; name; description: string; start: string; nodes: Record<string, AdventureNode> }
    ```
- Produces (`pack.ts`): `EntityRef`, `PackManifest`, `ContentSource`, `PackBundle`, `PackApi`, `definePack`, `EffectDef`, `StatusDef`, `PassiveDef`, `TargetingDef`, `BehaviorDef`, `EncounterKindDef`, `Hooks`, `Modifiers`, `Reactions`, `ReactionEvent`, `Ctx`, `Widget`, `Scene`, `Viewer` (exact code below; Plan B implements `Ctx`).

- [ ] **Step 1: Write the failing test**

`packages/engine/test/content.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { detectDocType, DOC_SCHEMAS } from '../src/content';

describe('detectDocType', () => {
  it('finds the single type key', () => {
    expect(detectDocType({ class: 'brute', name: 'Brute' })).toEqual({ type: 'class', id: 'brute' });
    expect(detectDocType({ encounter: 'pile', ballot: {} })).toEqual({ type: 'encounter', id: 'pile' });
  });
  it('rejects no type, two types, bad IDs and non-objects', () => {
    expect(detectDocType({ name: 'x' })).toEqual({ error: expect.stringMatching(/no type key/) });
    expect(detectDocType({ class: 'a', item: 'b' })).toEqual({ error: expect.stringMatching(/more than one type key \(class, item\)/) });
    expect(detectDocType({ class: 'Bad Id' })).toEqual({ error: expect.stringMatching(/Invalid ID 'Bad Id'/) });
    expect(detectDocType({ class: 'tp:brute' })).toEqual({ error: expect.stringMatching(/without a pack prefix/) });
    expect(detectDocType('x')).toEqual({ error: expect.stringMatching(/must be a map/) });
  });
});

describe('DOC_SCHEMAS', () => {
  it('applies defaults', () => {
    const cls = DOC_SCHEMAS.class.parse({ class: 'brute', name: 'Brute' });
    expect(cls).toMatchObject({ tags: [], stats: {}, abilities: [], passives: [] });
    const item = DOC_SCHEMAS.item.parse({ item: 'club', name: 'Club' });
    expect(item).toMatchObject({ uses: 1, price: 0, stats: {}, abilities: [], passives: [] });
    const ab = DOC_SCHEMAS.ability.parse({ ability: 'poke', name: 'Poke', cooldown: '5s', target: 'foe', steps: [] });
    expect(ab).toMatchObject({ when: 'fight' });
  });
  it('rejects unknown fields and wrong types', () => {
    expect(DOC_SCHEMAS.stat.safeParse({ stat: 'power', name: 'Power', default: 'five' }).success).toBe(false);
    expect(DOC_SCHEMAS.slot.safeParse({ slot: 'hand', name: 'Hand', colour: 'red' }).success).toBe(false);
    expect(DOC_SCHEMAS.monster.safeParse({ monster: 'blob', name: 'Blob', hp: 10, abilities: [], behavior: { pile: {} } }).success).toBe(false);
  });
  it('lets encounter and adventure nodes carry a kind key', () => {
    expect(DOC_SCHEMAS.encounter.safeParse({ encounter: 'e', show: { text: 'hi' } }).success).toBe(true);
    expect(DOC_SCHEMAS.adventure.safeParse({
      adventure: 'a', name: 'A', start: 'n1', nodes: { n1: { show: { text: 'x' }, next: 'n2' }, n2: { use: 'e' } },
    }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/engine/test/content.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `content.ts`**

`packages/engine/src/content.ts`:
```ts
import { z } from 'zod';
import { CONTENT_TYPES, type ContentType, LOCAL_ID_PATTERN } from './ids';
import type { Step } from './params';

const id = z.string().min(1);
const durationLike = z.union([z.string(), z.number()]);
const statMap = z.record(z.string(), z.number()).default({});
const passiveEntry = z.union([z.string(), z.record(z.string(), z.unknown())]);
const text = z.string().default('');
const icon = z.string().nullable().default(null);

export const DOC_SCHEMAS: Record<ContentType, z.ZodType> = {
  stat: z.object({ stat: id, name: z.string(), icon, default: z.number(), 'per-level': z.number().default(0) }).strict(),
  slot: z.object({ slot: id, name: z.string() }).strict(),
  class: z.object({
    class: id, name: z.string(), description: text, icon, tags: z.array(z.string()).default([]),
    stats: statMap, abilities: z.array(z.string()).default([]), passives: z.array(passiveEntry).default([]),
  }).strict(),
  ability: z.object({
    ability: id, name: z.string(), description: text, icon, cooldown: durationLike,
    when: z.enum(['fight', 'anytime']).default('fight'),
    target: z.union([z.string(), z.record(z.string(), z.unknown())]),
    steps: z.array(z.record(z.string(), z.unknown())),
  }).strict(),
  item: z.object({
    item: id, name: z.string(), description: text, icon, slot: z.string().optional(),
    'grants-class': z.string().optional(), stats: statMap, passives: z.array(passiveEntry).default([]),
    abilities: z.array(z.string()).default([]), use: z.string().optional(),
    uses: z.number().int().min(1).default(1), price: z.number().min(0).default(0),
  }).strict(),
  monster: z.object({
    monster: id, name: z.string(), description: text, image: z.string().nullable().default(null),
    tags: z.array(z.string()).default([]), hp: z.number().positive(), stats: statMap,
    abilities: z.array(z.string()).min(1), passives: z.array(passiveEntry).default([]),
    behavior: z.record(z.string(), z.unknown()), interval: durationLike.optional(),
    rewards: z.object({ xp: z.number().min(0).default(0), gold: z.number().min(0).default(0) }).strict().default({ xp: 0, gold: 0 }),
    drops: z.array(z.object({ item: z.string(), chance: z.number().min(0).max(1) }).strict()).default([]),
  }).strict(),
  encounter: z.object({ encounter: id, name: z.string().optional() }).catchall(z.unknown()),
  adventure: z.object({
    adventure: id, name: z.string(), description: text, start: z.string(),
    nodes: z.record(z.string(), z.object({
      next: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
      use: z.string().optional(),
    }).catchall(z.unknown())),
  }).strict(),
};

export function detectDocType(doc: unknown): { type: ContentType; id: string } | { error: string } {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { error: 'A content document must be a map' };
  const keys = CONTENT_TYPES.filter((t) => t in doc);
  if (keys.length === 0) return { error: `Document has no type key (one of: ${CONTENT_TYPES.join(', ')})` };
  if (keys.length > 1) return { error: `Document has more than one type key (${keys.join(', ')})` };
  const type = keys[0]!;
  const raw = (doc as Record<string, unknown>)[type];
  if (typeof raw !== 'string') return { error: `The '${type}' key must be an ID` };
  if (raw.includes(':')) return { error: `Write the ${type} ID '${raw}' without a pack prefix` };
  if (!LOCAL_ID_PATTERN.test(raw)) return { error: `Invalid ID '${raw}' (use lowercase letters, digits and -)` };
  return { type, id: raw };
}

export interface StatDef { id: string; name: string; icon: string | null; default: number; perLevel: number }
export interface SlotDef { id: string; name: string; order: number }
export interface PassiveUse { passive: string; params: unknown }
export interface TargetUse { rule: string; params: unknown }
export interface ClassDef {
  id: string; name: string; description: string; icon: string | null; tags: string[];
  stats: Record<string, number>; abilities: string[]; passives: PassiveUse[];
}
export interface AbilityDef {
  id: string; name: string; description: string; icon: string | null; cooldown: number;
  when: 'fight' | 'anytime'; target: TargetUse; steps: Step[];
}
export interface ItemDef {
  id: string; name: string; description: string; icon: string | null; slot: string | null;
  grantsClass: string | null; stats: Record<string, number>; passives: PassiveUse[];
  abilities: string[]; use: string | null; uses: number; price: number;
}
export interface MonsterDef {
  id: string; name: string; description: string; image: string | null; tags: string[]; hp: number;
  stats: Record<string, number>; abilities: string[]; passives: PassiveUse[];
  behavior: { behavior: string; params: unknown }; interval: number | null;
  rewards: { xp: number; gold: number }; drops: { item: string; chance: number }[];
}
export interface EncounterSpec { kind: string; params: unknown }
export interface EncounterDef { id: string; name: string; spec: EncounterSpec }
export interface AdventureNode { spec: EncounterSpec | null; use: string | null; next: string | Record<string, string> | null }
export interface AdventureDef { id: string; name: string; description: string; start: string; nodes: Record<string, AdventureNode> }
```

- [ ] **Step 4: Implement `pack.ts` (types and `definePack`)**

`packages/engine/src/pack.ts`:
```ts
import type { ParamSchema, Step } from './params';

/** A character (viewer) or a monster in the current fight. */
export interface EntityRef { kind: 'character' | 'monster'; id: string }

export interface PackManifest {
  id: string;
  version: string;
  name: string;
  license?: string;
  depends: Record<string, string>;
}

/** One parsed content document and where it came from. */
export interface ContentSource { file: string; index: number; doc: unknown }

export interface PackBundle {
  manifest: PackManifest;
  /** Set only by the pack loader for folders in this repository's packs/, or by trusted callers. */
  official: boolean;
  /** True when the folder has code (src/), even if the loader refused to import it. */
  hasCode?: boolean;
  register?: (api: PackApi) => void;
  content: ContentSource[];
}

export interface PackDefinition { register(api: PackApi): void }

/** Default export of a pack's src/index.ts. */
export function definePack(def: PackDefinition): PackDefinition {
  return def;
}

// ---- Panel widgets and overlay scenes (spec §6.8) ----

export type Widget =
  | { type: 'story-card'; title?: string; text: string }
  | { type: 'choices'; prompt: string; options: { key: string; label: string }[]; selected?: string; 'closes-at'?: number }
  | { type: 'shop-list'; entries: { item: string; price: number; affordable: boolean }[]; gold: number; 'closes-at'?: number }
  | { type: 'tap-button'; label: string; tapped: boolean; 'closes-at'?: number }
  | { type: 'none' };

export interface Scene {
  title?: string;
  text?: string;
  media?: { type: 'image' | 'video'; src: string }[];
  'closes-at'?: number;
  tallies?: { label: string; count: number }[];
  list?: string[];
}

/** What an encounter kind's panel() is told about the viewer. */
export interface Viewer { id: string; inParty: boolean; gold: number; knockedOut: boolean }

// ---- Hooks (spec §5.4) ----

interface HookInfo { ctx: Ctx; holder: EntityRef; params: any }

export interface Modifiers {
  damageDealt(value: number, info: HookInfo & { source: EntityRef; target: EntityRef; tags: string[] }): number;
  damageTaken(value: number, info: HookInfo & { source: EntityRef | null; target: EntityRef; tags: string[] }): number;
  healingGiven(value: number, info: HookInfo & { source: EntityRef; target: EntityRef }): number;
  healingReceived(value: number, info: HookInfo & { source: EntityRef | null; target: EntityRef }): number;
  cooldown(value: number, info: HookInfo & { ability: string }): number;
  targetPriority(value: number, info: HookInfo & { user: EntityRef; ability: string }): number;
  stat(value: number, info: HookInfo & { stat: string }): number;
  canUse(value: true | string, info: HookInfo & { ability: string }): true | string;
  rewardsReceived(value: { xp: number; gold: number }, info: HookInfo): { xp: number; gold: number };
}

export type ReactionEvent =
  | { type: 'abilityUsed'; user: EntityRef; ability: string; targets: EntityRef[] }
  | { type: 'damaged'; source: EntityRef | null; target: EntityRef; amount: number }
  | { type: 'healed'; source: EntityRef | null; target: EntityRef; amount: number }
  | { type: 'knockedOut'; entity: EntityRef; source: EntityRef | null }
  | { type: 'revived'; entity: EntityRef; source: EntityRef | null }
  | { type: 'statusApplied'; holder: EntityRef; status: string }
  | { type: 'statusEnded'; holder: EntityRef; status: string; reason: 'expired' | 'removed' }
  | { type: 'encounterStarted'; kind: string }
  | { type: 'encounterEnded'; kind: string; outcome: string };

export type ReactionRole = 'source' | 'target' | 'present';
type ReactionFn<E> = (info: HookInfo & { role: ReactionRole; event: E }) => void;
export type Reactions = { [K in ReactionEvent['type']]: ReactionFn<Extract<ReactionEvent, { type: K }>> };

export interface Hooks { modify?: Partial<Modifiers>; react?: Partial<Reactions> }

// ---- Plugin definitions (spec §5.2) ----

export interface EffectDef {
  params?: ParamSchema;
  apply(ctx: Ctx, args: { source: EntityRef | null; target: EntityRef; params: any }): void;
}

export interface StatusDef extends Hooks {
  name: string;
  icon?: string | null;
  params?: ParamSchema;
  /** refresh (default): reapplying replaces it. stack: instances add up. keep: reapplying does nothing. */
  stacking?: 'refresh' | 'stack' | 'keep';
  tick?: { every: string | number; run(ctx: Ctx, args: { holder: EntityRef; params: any; source: EntityRef | null }): void };
}

export interface PassiveDef extends Hooks { name: string; params?: ParamSchema }

export interface TargetingDef {
  params?: ParamSchema;
  /** True when a viewer must pick the target (a heal on an ally). */
  needsChoice?: boolean;
  /** Who could be targeted; a viewer's choice must be one of these. */
  candidates(ctx: Ctx, args: { user: EntityRef; params: any }): EntityRef[];
  select(ctx: Ctx, args: { user: EntityRef; ability: string; params: any; chosen: EntityRef | null; hints: Record<string, unknown> }): EntityRef[];
}

export interface BehaviorDef {
  params?: ParamSchema;
  act(ctx: Ctx, args: { monster: EntityRef; params: any }): void;
}

export interface EncounterKindDef<S = any> {
  name: string;
  params?: ParamSchema;
  input?: ParamSchema;
  outcomes(params: any): string[];
  validate?(params: any): string[];
  start(ctx: Ctx, params: any): S;
  respond(ctx: Ctx, state: S, character: EntityRef, input: any, params: any): S;
  wakeAt(state: S): number | null;
  advance(ctx: Ctx, state: S, params: any): S;
  endEarly(state: S, params: any): string;
  onEnd?(ctx: Ctx, state: S, outcome: string, params: any): void;
  panel(state: S, viewer: Viewer, params: any): Widget;
  overlay(state: S, params: any): Scene | null;
}

export interface PackApi {
  effect(id: string, def: EffectDef): void;
  status(id: string, def: StatusDef): void;
  passive(id: string, def: PassiveDef): void;
  targeting(id: string, def: TargetingDef): void;
  behavior(id: string, def: BehaviorDef): void;
  encounterKind(id: string, def: EncounterKindDef): void;
}

// ---- The plugin context (spec §5.2). Implemented in Plan B. ----

export interface StatusView { status: string; until: number | null; params: unknown; source: EntityRef | null }

export interface Ctx {
  readonly now: number;
  random(): number;
  randomInt(min: number, max: number): number;
  name(e: EntityRef): string;
  tags(e: EntityRef): string[];
  stat(e: EntityRef, statId: string): number;
  hp(e: EntityRef): number;
  maxHp(e: EntityRef): number;
  level(e: EntityRef): number;
  gold(character: EntityRef): number;
  isKnockedOut(e: EntityRef): boolean;
  statuses(e: EntityRef): StatusView[];
  party(): EntityRef[];
  active(): EntityRef[];
  enemiesOf(e: EntityRef): EntityRef[];
  alliesOf(e: EntityRef): EntityRef[];
  byPriority(user: EntityRef, ability: string, candidates: EntityRef[]): EntityRef[];
  formula(text: string, sides: { source: EntityRef | null; target: EntityRef | null }): number;
  store(e: EntityRef): any;
  startingItems(): string[];

  dealDamage(source: EntityRef | null, target: EntityRef, amount: number, opts?: { tags?: string[] }): number;
  heal(source: EntityRef | null, target: EntityRef, amount: number): number;
  revive(target: EntityRef, hp: number): void;
  knockOut(target: EntityRef, duration?: number): void;
  applyStatus(target: EntityRef, statusId: string, opts?: { duration?: number | null; params?: unknown; source?: EntityRef | null }): void;
  removeStatus(target: EntityRef, statusId: string): void;
  useAbility(user: EntityRef, abilityId: string, opts?: { chosen?: EntityRef | null; hints?: Record<string, unknown> }): void;
  runSteps(steps: Step[], args: { source: EntityRef | null; targets: EntityRef[] }): void;
  giveRewards(character: EntityRef, rewards: { xp?: number; gold?: number; items?: string[] }): void;
  spendGold(character: EntityRef, amount: number): void;
  giveItem(character: EntityRef, item: string, count?: number): void;
  endEncounter(outcome: string): void;
  emit(type: string, data: Record<string, unknown>, text: string): void;
  setStore(e: EntityRef, data: unknown): void;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run packages/engine/test/content.test.ts && pnpm typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): content schemas and pack API types"
```

---

### Task 7: Semver, channel config and settings

**Files:**
- Create: `packages/engine/src/semver.ts`, `packages/engine/src/channel.ts`
- Test: `packages/engine/test/semver.test.ts`, `packages/engine/test/channel.test.ts`

**Interfaces:**
- Produces (`semver.ts`): `satisfies(version: string, range: string): boolean` (supports `*`, exact `1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`); `isVersion(v: string): boolean`.
- Produces (`channel.ts`):
  - `interface Settings` (camelCase, fields below), `DEFAULT_SETTINGS: Settings` (without `classSlot`/`startingItems` resolution)
  - `interface ChannelConfig { packs: string[]; channelPack: { content: unknown[]; deleted: string[] }; overrides: Record<string, Record<string, unknown>>; settings: Record<string, unknown> }`
  - `parseChannel(raw: unknown): { channel: ChannelConfig } | { errors: string[] }`
  - `parseSettings(raw: Record<string, unknown>): { settings: Omit<Settings, 'classSlot' | 'startingItems'>; classSlot: string | null; startingItems: string[]; errors: string[] }` (references are resolved later by the registry)
  - `deepMerge(base: unknown, patch: unknown): unknown`

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/semver.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isVersion, satisfies } from '../src/semver';

describe('satisfies', () => {
  it.each([
    ['1.2.3', '*', true], ['1.2.3', '1.2.3', true], ['1.2.4', '1.2.3', false],
    ['1.4.0', '^1.2.3', true], ['2.0.0', '^1.2.3', false], ['1.2.2', '^1.2.3', false],
    ['0.2.5', '^0.2.3', true], ['0.3.0', '^0.2.3', false],
    ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false],
    ['3.0.0', '>=1.2.3', true], ['1.2.2', '>=1.2.3', false],
  ])('%s satisfies %s: %s', (v, r, ok) => expect(satisfies(v, r)).toBe(ok));

  it('rejects bad ranges and versions', () => {
    expect(satisfies('1.2.3', 'banana')).toBe(false);
    expect(isVersion('1.2')).toBe(false);
    expect(isVersion('1.2.3')).toBe(true);
  });
});
```

`packages/engine/test/channel.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { deepMerge, DEFAULT_SETTINGS, parseChannel, parseSettings } from '../src/channel';

describe('parseChannel', () => {
  it('fills defaults', () => {
    const r = parseChannel({ packs: ['tp'] });
    expect(r).toEqual({ channel: { packs: ['tp'], channelPack: { content: [], deleted: [] }, overrides: {}, settings: {} } });
  });
  it('reads channel-pack content and deleted IDs', () => {
    const r = parseChannel({ packs: [], 'channel-pack': { content: [{ slot: 'x', name: 'X' }], deleted: ['old'] } });
    expect('channel' in r && r.channel.channelPack).toEqual({ content: [{ slot: 'x', name: 'X' }], deleted: ['old'] });
  });
  it('rejects unknown keys and bad shapes', () => {
    expect(parseChannel({ packs: 'tp' })).toHaveProperty('errors');
    expect(parseChannel({ packs: [], extra: 1 })).toHaveProperty('errors');
  });
});

describe('parseSettings', () => {
  it('uses defaults', () => {
    const r = parseSettings({});
    expect(r.errors).toEqual([]);
    expect(r.settings).toEqual(DEFAULT_SETTINGS);
    expect(r.classSlot).toBeNull();
    expect(r.startingItems).toEqual([]);
    expect(DEFAULT_SETTINGS).toMatchObject({
      partyCap: null, allowJoinMidFight: true, autoRemoveIdle: true, rewardsRequireAction: true,
      knockedOutExemptFromIdle: true, healBetweenFights: false, gearLockDuringCombat: true,
      streamerRemovalWaitsForRest: true, fullIntervalAfterWaiting: true, fullIntervalAfterRelease: true,
      fullIntervalAfterRestart: true, knockoutDuration: 60000, knockoutReturnHp: 25, baseHp: 100, hpPerLevel: 5,
      xpCurve: { first: 80, step: 50 }, xpMultiplier: 1, goldMultiplier: 1, monsterInterval: 20000,
    });
  });
  it('reads kebab-case keys and units', () => {
    const r = parseSettings({
      'party-cap': 10, 'knockout-duration': '30s', 'knockout-return-hp': '50%', 'xp-curve': { first: 100, step: 20 },
      'class-slot': 'tp:hand', 'starting-items': ['tp:club'],
    });
    expect(r.errors).toEqual([]);
    expect(r.settings).toMatchObject({ partyCap: 10, knockoutDuration: 30000, knockoutReturnHp: 50, xpCurve: { first: 100, step: 20 } });
    expect(r.classSlot).toBe('tp:hand');
    expect(r.startingItems).toEqual(['tp:club']);
  });
  it('rejects out-of-range and unknown settings', () => {
    const r = parseSettings({ 'knockout-return-hp': '150%', 'xp-multiplier': -1, 'monster-interval': '0s', colour: 'red' });
    expect(r.errors).toEqual([
      'knockout-return-hp: must be between 0% and 100%',
      'xp-multiplier: must be at least 0',
      'monster-interval: must be longer than 0',
      'colour: unknown setting',
    ]);
  });
});

describe('deepMerge', () => {
  it('merges objects, replaces lists and values', () => {
    expect(deepMerge({ a: 1, b: { c: 2, d: [1, 2] } }, { b: { c: 3, d: [9] }, e: 4 }))
      .toEqual({ a: 1, b: { c: 3, d: [9] }, e: 4 });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/engine/test/semver.test.ts packages/engine/test/channel.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/engine/src/semver.ts`:
```ts
const V = /^(\d+)\.(\d+)\.(\d+)$/;

export function isVersion(v: string): boolean {
  return V.test(v);
}

function parse(v: string): [number, number, number] | null {
  const m = V.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  const r = range.trim();
  if (r === '*') return true;
  const op = /^(\^|~|>=)?(.*)$/.exec(r)!;
  const base = parse(op[2]!);
  if (!base) return false;
  switch (op[1]) {
    case undefined: return cmp(v, base) === 0;
    case '>=': return cmp(v, base) >= 0;
    case '~': return v[0] === base[0] && v[1] === base[1] && v[2] >= base[2];
    case '^':
      if (cmp(v, base) < 0) return false;
      if (base[0] > 0) return v[0] === base[0];
      if (base[1] > 0) return v[0] === 0 && v[1] === base[1];
      return v[0] === 0 && v[1] === 0 && v[2] === base[2];
  }
  return false;
}
```

`packages/engine/src/channel.ts`:
```ts
import { z } from 'zod';
import { parseDuration, parsePercent } from './units';

export interface Settings {
  partyCap: number | null;
  allowJoinMidFight: boolean;
  autoRemoveIdle: boolean;
  rewardsRequireAction: boolean;
  knockedOutExemptFromIdle: boolean;
  healBetweenFights: boolean;
  gearLockDuringCombat: boolean;
  streamerRemovalWaitsForRest: boolean;
  fullIntervalAfterWaiting: boolean;
  fullIntervalAfterRelease: boolean;
  fullIntervalAfterRestart: boolean;
  knockoutDuration: number;
  knockoutReturnHp: number;
  baseHp: number;
  hpPerLevel: number;
  xpCurve: { first: number; step: number };
  xpMultiplier: number;
  goldMultiplier: number;
  monsterInterval: number;
  /** Resolved by the registry. null when unset or dormant. */
  classSlot: string | null;
  /** Resolved by the registry; dormant entries skipped. */
  startingItems: string[];
}

export type BaseSettings = Omit<Settings, 'classSlot' | 'startingItems'>;

export const DEFAULT_SETTINGS: BaseSettings = {
  partyCap: null,
  allowJoinMidFight: true,
  autoRemoveIdle: true,
  rewardsRequireAction: true,
  knockedOutExemptFromIdle: true,
  healBetweenFights: false,
  gearLockDuringCombat: true,
  streamerRemovalWaitsForRest: true,
  fullIntervalAfterWaiting: true,
  fullIntervalAfterRelease: true,
  fullIntervalAfterRestart: true,
  knockoutDuration: 60_000,
  knockoutReturnHp: 25,
  baseHp: 100,
  hpPerLevel: 5,
  xpCurve: { first: 80, step: 50 },
  xpMultiplier: 1,
  goldMultiplier: 1,
  monsterInterval: 20_000,
};

export interface ChannelConfig {
  packs: string[];
  channelPack: { content: unknown[]; deleted: string[] };
  overrides: Record<string, Record<string, unknown>>;
  settings: Record<string, unknown>;
}

const channelSchema = z.object({
  packs: z.array(z.string()),
  'channel-pack': z.object({
    content: z.array(z.unknown()).default([]),
    deleted: z.array(z.string()).default([]),
  }).strict().default({ content: [], deleted: [] }),
  overrides: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  settings: z.record(z.string(), z.unknown()).default({}),
}).strict();

export function parseChannel(raw: unknown): { channel: ChannelConfig } | { errors: string[] } {
  const r = channelSchema.safeParse(raw);
  if (!r.success) return { errors: r.error.issues.map((i) => `${i.path.join('.') || '(channel)'}: ${i.message}`) };
  const d = r.data;
  return { channel: { packs: d.packs, channelPack: d['channel-pack'], overrides: d.overrides, settings: d.settings } };
}

type Kind = 'bool' | 'count' | 'nonneg' | 'duration' | 'percent' | 'curve';
const SETTING_KEYS: Record<string, [keyof BaseSettings, Kind]> = {
  'party-cap': ['partyCap', 'count'],
  'allow-join-mid-fight': ['allowJoinMidFight', 'bool'],
  'auto-remove-idle': ['autoRemoveIdle', 'bool'],
  'rewards-require-action': ['rewardsRequireAction', 'bool'],
  'knocked-out-exempt-from-idle': ['knockedOutExemptFromIdle', 'bool'],
  'heal-between-fights': ['healBetweenFights', 'bool'],
  'gear-lock-during-combat': ['gearLockDuringCombat', 'bool'],
  'streamer-removal-waits-for-rest': ['streamerRemovalWaitsForRest', 'bool'],
  'full-interval-after-waiting': ['fullIntervalAfterWaiting', 'bool'],
  'full-interval-after-release': ['fullIntervalAfterRelease', 'bool'],
  'full-interval-after-restart': ['fullIntervalAfterRestart', 'bool'],
  'knockout-duration': ['knockoutDuration', 'duration'],
  'knockout-return-hp': ['knockoutReturnHp', 'percent'],
  'base-hp': ['baseHp', 'count'],
  'hp-per-level': ['hpPerLevel', 'nonneg'],
  'xp-curve': ['xpCurve', 'curve'],
  'xp-multiplier': ['xpMultiplier', 'nonneg'],
  'gold-multiplier': ['goldMultiplier', 'nonneg'],
  'monster-interval': ['monsterInterval', 'duration'],
};

export function parseSettings(raw: Record<string, unknown>): {
  settings: BaseSettings; classSlot: string | null; startingItems: string[]; errors: string[];
} {
  const settings: BaseSettings = structuredClone(DEFAULT_SETTINGS);
  const errors: string[] = [];
  let classSlot: string | null = null;
  let startingItems: string[] = [];
  const out = settings as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'class-slot') {
      if (value === null) classSlot = null;
      else if (typeof value === 'string') classSlot = value;
      else errors.push('class-slot: must be a slot ID');
      continue;
    }
    if (key === 'starting-items') {
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) startingItems = value;
      else errors.push('starting-items: must be a list of item IDs');
      continue;
    }
    const entry = SETTING_KEYS[key];
    if (!entry) { errors.push(`${key}: unknown setting`); continue; }
    const [field, kind] = entry;
    try {
      switch (kind) {
        case 'bool':
          if (typeof value !== 'boolean') throw new Error('must be true or false');
          out[field] = value; break;
        case 'count':
          if (field === 'partyCap' && value === null) { out[field] = null; break; }
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error('must be a whole number of at least 1');
          out[field] = value; break;
        case 'nonneg':
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('must be a number');
          if (value < 0) throw new Error('must be at least 0');
          out[field] = value; break;
        case 'duration': {
          const ms = parseDuration(value as string | number);
          if (ms <= 0) throw new Error('must be longer than 0');
          out[field] = ms; break;
        }
        case 'percent': {
          const pct = parsePercent(value as string | number);
          if (pct < 0 || pct > 100) throw new Error('must be between 0% and 100%');
          out[field] = pct; break;
        }
        case 'curve': {
          const c = value as { first?: unknown; step?: unknown };
          if (typeof c !== 'object' || c === null || typeof c.first !== 'number' || typeof c.step !== 'number' || c.first < 1 || c.step < 0) {
            throw new Error('must be { first: number ≥ 1, step: number ≥ 0 }');
          }
          out[field] = { first: c.first, step: c.step }; break;
        }
      }
    } catch (e) {
      errors.push(`${key}: ${(e as Error).message}`);
    }
  }
  return { settings, classSlot, startingItems, errors };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge key by key; lists and plain values are replaced. */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObj(base) || !isObj(patch)) return structuredClone(patch);
  const out: Record<string, unknown> = { ...structuredClone(base) };
  for (const [k, v] of Object.entries(patch)) out[k] = k in out ? deepMerge(out[k], v) : structuredClone(v);
  return out;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run packages/engine/test/semver.test.ts packages/engine/test/channel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): semver, channel config and settings"
```

---

### Task 8: The shared test pack

Every engine test from here on uses one small test pack, `tp`, built in code (spec §14: test packs live inside the tests and use made-up IDs). It has a stat, two slots, two classes, an effect, statuses, targeting rules, a behavior and a simple encounter kind. Plan B extends its use; keep it in one helper file.

**Files:**
- Create: `packages/engine/test/helpers/tp-pack.ts`

**Interfaces:**
- Consumes: `definePack`, `PackBundle`, `p` (Tasks 5–6).
- Produces:
  - `tpBundle(extraContent?: unknown[]): PackBundle` (manifest `tp@1.0.0`, `official: true`)
  - `tpChannel(overrides?: Partial<{ packs: string[]; settings: Record<string, unknown>; overrides: Record<string, unknown>; 'channel-pack': unknown }>): unknown` (a raw channel config with `class-slot: tp:hand` and `starting-items: [tp:club, tp:rod]`)
  - The `tp` content (YAML-equivalent objects) exported as `TP_CONTENT`.

- [ ] **Step 1: Write the helper**

`packages/engine/test/helpers/tp-pack.ts`:
```ts
import { definePack, type PackBundle } from '../../src/pack';
import { p } from '../../src/params';

/** Content for the test pack. Mirrors what YAML would hold. */
export const TP_CONTENT: unknown[] = [
  { stat: 'power', name: 'Power', default: 5, 'per-level': 1 },
  { stat: 'grit', name: 'Grit', default: 0 },
  { slot: 'hand', name: 'Hand' },
  { slot: 'body', name: 'Body' },
  { class: 'brute', name: 'Brute', stats: { power: 5 }, abilities: ['whack', 'zap'] },
  { class: 'mender', name: 'Mender', stats: { hp: -10 }, abilities: ['whack', 'mend', 'wake'] },
  { ability: 'whack', name: 'Whack', cooldown: '10s', target: 'foe', steps: [{ poke: { power: 'power' } }] },
  { ability: 'zap', name: 'Zap', cooldown: '30s', target: 'foe', steps: [{ poke: { power: 'power' } }, { poke: { power: '2 * power' } }] },
  { ability: 'mend', name: 'Mend', cooldown: '15s', target: 'pal', steps: [{ fix: { amount: 20 } }] },
  { ability: 'wake', name: 'Wake', cooldown: '60s', target: 'downed-pal', steps: [{ lift: { hp: '30%' } }] },
  { ability: 'snack', name: 'Snack', cooldown: '5s', when: 'anytime', target: 'me', steps: [{ fix: { amount: 15 } }] },
  { ability: 'slam', name: 'Slam', cooldown: '1s', target: { hunt: { count: 1 } }, steps: [{ poke: { power: 'power' } }] },
  { ability: 'lull', name: 'Lull', cooldown: '1s', target: { hunt: {} }, steps: [{ put: { status: 'snooze', duration: '30s', factor: 1.5 } }] },
  { item: 'club', name: 'Club', slot: 'hand', 'grants-class': 'brute' },
  { item: 'rod', name: 'Rod', slot: 'hand', 'grants-class': 'mender' },
  { item: 'mallet', name: 'Mallet', slot: 'hand', 'grants-class': 'brute', stats: { power: 2 }, price: 30 },
  { item: 'vest', name: 'Vest', slot: 'body', stats: { hp: 20, grit: 5 }, price: 40 },
  { item: 'biscuit', name: 'Biscuit', use: 'snack', uses: 2, price: 5 },
  {
    monster: 'blob', name: 'Blob', hp: 50, stats: { power: 6 }, abilities: ['slam'],
    behavior: { pile: { abilities: { slam: 1 }, 'targets-per': 5 } }, interval: '15s',
    rewards: { xp: 20, gold: 5 }, drops: [{ item: 'biscuit', chance: 0.5 }],
  },
  {
    monster: 'ogre', name: 'Ogre', hp: 300, stats: { power: 15, grit: 10 }, abilities: ['slam', 'lull'],
    behavior: { pile: { abilities: { slam: 2, lull: 1 }, 'targets-per': 5 } },
    rewards: { xp: 100, gold: 40 },
  },
  { encounter: 'chat', show: { text: 'Hello there', 'show-for': '10s' } },
  {
    adventure: 'trip', name: 'Trip', start: 'intro',
    nodes: {
      intro: { show: { text: 'Off we go' }, next: 'pick' },
      pick: { ballot: { choices: { a: 'Left', b: 'Right' }, time: '30s' }, next: { a: 'fight', b: 'talk' } },
      fight: { fight: 'blob', next: { won: 'end', default: 'end' } },
      talk: { use: 'chat', next: 'end' },
      end: { show: { text: 'Done' } },
    },
  },
];

export function tpBundle(extraContent: unknown[] = []): PackBundle {
  return {
    manifest: { id: 'tp', version: '1.0.0', name: 'Test Pack', depends: {} },
    official: true,
    content: [...TP_CONTENT, ...extraContent].map((doc, index) => ({ file: 'tp.yaml', index, doc })),
    register: definePack({
      register(api) {
        api.effect('poke', {
          params: p.object({ power: p.formula() }),
          apply(ctx, { source, target, params }) {
            const raw = ctx.formula(params.power, { source, target });
            ctx.dealDamage(source, target, raw * (1 - ctx.stat(target, 'grit') / 100));
          },
        });
        api.effect('fix', {
          params: p.object({ amount: p.formula() }),
          apply(ctx, { source, target, params }) {
            ctx.heal(source, target, ctx.formula(params.amount, { source, target }));
          },
        });
        api.effect('lift', {
          params: p.object({ hp: p.percent() }),
          apply(ctx, { target, params }) {
            if (ctx.isKnockedOut(target)) ctx.revive(target, Math.max(1, Math.round((ctx.maxHp(target) * params.hp) / 100)));
          },
        });
        api.effect('put', {
          params: p.statusApplication(),
          apply(ctx, { source, target, params }) {
            ctx.applyStatus(target, params.status, { duration: params.duration, params: params.params, source });
          },
        });
        api.status('snooze', {
          name: 'Snooze',
          params: p.object({ factor: p.number({ min: 0 }) }),
          modify: { cooldown: (ms, { params }) => ms * params.factor },
        });
        api.status('shielded', {
          name: 'Shielded',
          params: p.object({ cut: p.number({ min: 0, max: 100 }), priority: p.number() }),
          modify: {
            damageTaken: (v, { params }) => v * (1 - params.cut / 100),
            targetPriority: (v, { params }) => v + params.priority,
          },
        });
        api.targeting('me', { candidates: (_ctx, { user }) => [user], select: (_ctx, { user }) => [user] });
        api.targeting('foe', {
          candidates: (ctx, { user }) => ctx.enemiesOf(user).filter((e) => !ctx.isKnockedOut(e)),
          select(ctx, { user, chosen }) {
            const list = ctx.enemiesOf(user).filter((e) => !ctx.isKnockedOut(e));
            if (chosen) return [chosen];
            return list.length ? [list[ctx.randomInt(0, list.length - 1)]!] : [];
          },
        });
        api.targeting('pal', {
          needsChoice: true,
          candidates: (ctx, { user }) => ctx.alliesOf(user).filter((e) => !ctx.isKnockedOut(e)),
          select: (_ctx, { chosen }) => (chosen ? [chosen] : []),
        });
        api.targeting('downed-pal', {
          needsChoice: true,
          candidates: (ctx, { user }) => ctx.alliesOf(user).filter((e) => ctx.isKnockedOut(e)),
          select: (_ctx, { chosen }) => (chosen ? [chosen] : []),
        });
        api.targeting('hunt', {
          params: p.object({ count: p.optional(p.integer({ min: 1 })) }),
          candidates: (ctx, { user }) => ctx.enemiesOf(user).filter((e) => !ctx.isKnockedOut(e)),
          select(ctx, { user, ability, params, hints }) {
            const n = (hints.count as number | undefined) ?? params.count ?? 1;
            const list = ctx.enemiesOf(user).filter((e) => !ctx.isKnockedOut(e));
            return ctx.byPriority(user, ability, list).slice(0, n);
          },
        });
        api.behavior('pile', {
          params: p.object({ abilities: p.refMap('ability', p.number({ min: 0 })), 'targets-per': p.integer({ min: 1 }) }),
          act(ctx, { monster, params }) {
            const entries = Object.entries(params.abilities as Record<string, number>).filter(([, w]) => w > 0);
            const total = entries.reduce((s, [, w]) => s + w, 0);
            if (total === 0) return;
            let roll = ctx.random() * total;
            const pick = entries.find(([, w]) => (roll -= w) < 0)?.[0] ?? entries[entries.length - 1]![0];
            const count = Math.max(1, Math.ceil(ctx.active().length / params['targets-per']));
            ctx.useAbility(monster, pick, { hints: { count } });
          },
        });
        api.encounterKind('show', {
          name: 'Show',
          params: p.object({ text: p.string(), 'show-for': p.optional(p.duration()) }),
          input: p.object({}),
          outcomes: () => ['done'],
          start: (ctx, params) => ({ endsAt: params['show-for'] ? ctx.now + params['show-for'] : null }),
          respond: () => { throw new Error('nothing to respond to'); },
          wakeAt: (s) => s.endsAt,
          advance(ctx, s) { ctx.endEncounter('done'); return s; },
          endEarly: () => 'done',
          panel: (_s, _v, params) => ({ type: 'story-card', text: params.text }),
          overlay: (s, params) => ({ text: params.text, ...(s.endsAt ? { 'closes-at': s.endsAt } : {}) }),
        });
        api.encounterKind('ballot', {
          name: 'Ballot',
          params: p.object({ choices: p.record(p.string()), time: p.duration() }),
          input: p.object({ choice: p.string() }),
          outcomes: (params) => Object.keys(params.choices),
          start: (ctx, params) => ({ closesAt: ctx.now + params.time, votes: {} as Record<string, string> }),
          respond(_ctx, s, character, input, params) {
            if (!(input.choice in params.choices)) throw new Error(`no such choice ${input.choice}`);
            return { ...s, votes: { ...s.votes, [character.id]: input.choice } };
          },
          wakeAt: (s) => s.closesAt,
          advance(ctx, s, params) {
            const keys = Object.keys(params.choices);
            const count = (k: string) => Object.values(s.votes).filter((v) => v === k).length;
            const best = keys.reduce((a, b) => (count(b) > count(a) ? b : a));
            ctx.endEncounter(best);
            return s;
          },
          endEarly: (s, params) => Object.keys(params.choices)[0]!,
          panel: (s, viewer, params) => ({
            type: 'choices', prompt: 'Pick', options: Object.entries(params.choices as Record<string, string>).map(([key, label]) => ({ key, label })),
            ...(s.votes[viewer.id] ? { selected: s.votes[viewer.id] } : {}), 'closes-at': s.closesAt,
          }),
          overlay: () => null,
        });
      },
    }).register,
  };
}

export function tpChannel(over: Record<string, unknown> = {}): unknown {
  const { settings, ...rest } = over as { settings?: Record<string, unknown> };
  return {
    packs: ['tp'],
    ...rest,
    settings: { 'class-slot': 'tp:hand', 'starting-items': ['tp:club', 'tp:rod'], ...(settings ?? {}) },
  };
}
```

Note: the `ballot` kind's `respond` throws a plain `Error` for a bad choice on purpose, so Plan B can test that a plugin error discards the command. Real packs throw `Rejection`.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/test/helpers
git commit -m "test(engine): shared tp test pack"
```

---

### Task 9: The registry, part 1: packs, plugins, documents and overrides

**Files:**
- Create: `packages/engine/src/registry.ts`
- Test: `packages/engine/test/registry.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–8.
- Produces:
  ```ts
  interface Registered<T> { id: string; pack: string; def: T }
  interface KindEntry extends Registered<EncounterKindDef> { builtin: boolean }
  interface Registry {
    packs: PackManifest[];                         // enabled, in load order
    stats: Map<string, StatDef>; slots: Map<string, SlotDef>;
    classes: Map<string, ClassDef>; abilities: Map<string, AbilityDef>; items: Map<string, ItemDef>;
    monsters: Map<string, MonsterDef>; encounters: Map<string, EncounterDef>; adventures: Map<string, AdventureDef>;
    effects: Map<string, Registered<EffectDef>>; statuses: Map<string, Registered<StatusDef>>;
    passives: Map<string, Registered<PassiveDef>>; targeting: Map<string, Registered<TargetingDef>>;
    behaviors: Map<string, Registered<BehaviorDef>>; kinds: Map<string, KindEntry>;
    settings: Settings;
    dormant: Set<string>;                          // refKey(type, fullId) of dormant channel content
    warnings: Issue[];
  }
  buildRegistry(bundles: PackBundle[], channelRaw: unknown): Registry   // throws ValidationError
  CORE_HP = 'core:hp', CORE_KO = 'core:knocked-out', CORE_FIGHT = 'core:fight'
  ```
- Internal (exported for Task 10): `interface BuildState`, `interface RawDoc { type: ContentType; full: string; pack: string; file: string; index: number; doc: Record<string, unknown> }`.

This task builds everything up to "documents parsed and overrides applied". Task 10 adds reference resolution, normalization and dormancy into `registry.ts` via `resolve.ts` and `normalize.ts`. Until then `buildRegistry` fills only plugin maps, `packs` and `settings` base values, and leaves content maps empty.

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/registry.test.ts`:
```ts
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
      buildRegistry([tpBundle([{ name: 'no type' }, { class: 'a', item: 'b' }, { slot: 'hand', name: 'Dup' }])], tpChannel());
    } catch (e) { issues = (e as ValidationError).issues; }
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'tp.yaml', message: expect.stringMatching(/no type key/) }),
      expect.objectContaining({ file: 'tp.yaml', message: expect.stringMatching(/more than one type key/) }),
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
```

Note: the `applies overrides by ID` test depends on content normalization from Task 10 (`abilities`, `monsters` maps). It fails in this task and passes after Task 10; that's expected. Run only the other tests in Step 4 of this task.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/engine/test/registry.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `registry.ts` (part 1)**

`packages/engine/src/registry.ts`:
```ts
import { type ChannelConfig, deepMerge, parseChannel, parseSettings, type Settings } from './channel';
import {
  type AbilityDef, type AdventureDef, type ClassDef, type EncounterDef, type ItemDef, type MonsterDef,
  type SlotDef, type StatDef, detectDocType, DOC_SCHEMAS,
} from './content';
import { type Issue, ValidationError } from './errors';
import { CHANNEL, CONTENT_TYPES, type ContentType, CORE, fullId, PACK_ID_PATTERN, type PluginType, splitId } from './ids';
import type {
  BehaviorDef, EffectDef, EncounterKindDef, PackApi, PackBundle, PackManifest, PassiveDef, StatusDef, TargetingDef,
} from './pack';
import { p } from './params';
import { isVersion, satisfies } from './semver';
import { normalizeAll } from './normalize';

export const CORE_HP = 'core:hp';
export const CORE_KO = 'core:knocked-out';
export const CORE_FIGHT = 'core:fight';

export interface Registered<T> { id: string; pack: string; def: T }
export interface KindEntry extends Registered<EncounterKindDef> { builtin: boolean }

export interface Registry {
  packs: PackManifest[];
  stats: Map<string, StatDef>;
  slots: Map<string, SlotDef>;
  classes: Map<string, ClassDef>;
  abilities: Map<string, AbilityDef>;
  items: Map<string, ItemDef>;
  monsters: Map<string, MonsterDef>;
  encounters: Map<string, EncounterDef>;
  adventures: Map<string, AdventureDef>;
  effects: Map<string, Registered<EffectDef>>;
  statuses: Map<string, Registered<StatusDef>>;
  passives: Map<string, Registered<PassiveDef>>;
  targeting: Map<string, Registered<TargetingDef>>;
  behaviors: Map<string, Registered<BehaviorDef>>;
  kinds: Map<string, KindEntry>;
  settings: Settings;
  dormant: Set<string>;
  warnings: Issue[];
}

export interface RawDoc {
  type: ContentType;
  full: string;
  pack: string;
  file: string;
  index: number;
  doc: Record<string, unknown>;
}

export interface BuildState {
  reg: Registry;
  issues: Issue[];
  channel: ChannelConfig;
  enabled: Set<string>;
  depends: Map<string, Set<string>>;
  raw: Map<ContentType, Map<string, RawDoc>>;
  deleted: Set<string>;
  classSlotRaw: string | null;
  startingItemsRaw: string[];
}

/** Built-in fight kind. The engine runs fights itself; these functions are never called. */
const FIGHT_KIND: EncounterKindDef = {
  name: 'Fight',
  params: p.ref('monster'),
  outcomes: () => ['won'],
  start: () => { throw new Error('fight is built in'); },
  respond: () => { throw new Error('fight is built in'); },
  wakeAt: () => null,
  advance: (_c, s) => s,
  endEarly: () => 'ended',
  panel: () => ({ type: 'none' }),
  overlay: () => null,
};

function emptyRegistry(): Registry {
  return {
    packs: [], stats: new Map(), slots: new Map(), classes: new Map(), abilities: new Map(), items: new Map(),
    monsters: new Map(), encounters: new Map(), adventures: new Map(), effects: new Map(), statuses: new Map(),
    passives: new Map(), targeting: new Map(), behaviors: new Map(), kinds: new Map(),
    settings: undefined as unknown as Settings, dormant: new Set(), warnings: [],
  };
}

const PLUGIN_MAPS: Record<PluginType, keyof Registry> = {
  effect: 'effects', status: 'statuses', passive: 'passives', targeting: 'targeting', behavior: 'behaviors', encounterKind: 'kinds',
};

function orderPacks(st: BuildState, bundles: Map<string, PackBundle>): PackBundle[] {
  const err = (pack: string, message: string) => st.issues.push({ level: 'error', pack, path: '', message });
  const enabled = st.channel.packs;
  for (const id of enabled) {
    if (id === CORE || id === CHANNEL) { err(id, "'core' and 'channel' are reserved pack IDs"); continue; }
    const b = bundles.get(id);
    if (!b) { err(id, 'pack is enabled but not installed'); continue; }
    const m = b.manifest;
    if (!PACK_ID_PATTERN.test(m.id)) err(id, `invalid pack ID '${m.id}'`);
    if (!isVersion(m.version)) err(id, 'version must look like 1.2.3');
    if (typeof m.name !== 'string' || !m.name) err(id, 'manifest needs a name');
    st.depends.set(id, new Set(Object.keys(m.depends ?? {})));
    for (const [dep, range] of Object.entries(m.depends ?? {})) {
      const d = bundles.get(dep);
      if (!st.enabled.has(dep) || !d) err(id, `depends on ${dep}, which is not enabled`);
      else if (!satisfies(d.manifest.version, range)) err(id, `depends on ${dep} ${range} but ${d.manifest.version} is enabled`);
    }
  }
  // Topological order, otherwise list order.
  const ordered: PackBundle[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: string[]): void => {
    const b = bundles.get(id);
    if (!b || !st.enabled.has(id) || id === CORE || id === CHANNEL) return;
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const start = trail.indexOf(id);
      err(trail[start]!, `dependency cycle: ${[...trail.slice(start), id].join(' -> ')}`);
      return;
    }
    state.set(id, 'visiting');
    for (const dep of Object.keys(b.manifest.depends ?? {})) visit(dep, [...trail, id]);
    state.set(id, 'done');
    ordered.push(b);
  };
  for (const id of enabled) visit(id, []);
  return ordered;
}

function registerPlugins(st: BuildState, bundle: PackBundle): void {
  const pack = bundle.manifest.id;
  if (!bundle.official && (bundle.register || bundle.hasCode)) {
    st.issues.push({ level: 'error', pack, path: '', message: "this pack isn't official, so it can't contain code" });
    return;
  }
  if (!bundle.register) return;
  const add = (type: PluginType, id: string, def: unknown) => {
    const map = st.reg[PLUGIN_MAPS[type]] as Map<string, unknown>;
    const full = fullId(pack, id);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { st.issues.push({ level: 'error', pack, path: '', message: `invalid ${type} ID '${id}'` }); return; }
    if (map.has(full)) { st.issues.push({ level: 'error', pack, path: '', message: `duplicate ${type} '${id}'` }); return; }
    map.set(full, type === 'encounterKind' ? { id: full, pack, def, builtin: false } : { id: full, pack, def });
  };
  const api: PackApi = {
    effect: (id, def) => add('effect', id, def),
    status: (id, def) => add('status', id, def),
    passive: (id, def) => add('passive', id, def),
    targeting: (id, def) => add('targeting', id, def),
    behavior: (id, def) => add('behavior', id, def),
    encounterKind: (id, def) => add('encounterKind', id, def),
  };
  try {
    bundle.register(api);
  } catch (e) {
    st.issues.push({ level: 'error', pack, path: '', message: `register() failed: ${(e as Error).message}` });
  }
}

function collectDocs(st: BuildState, pack: string, sources: { file: string; index: number; doc: unknown }[]): void {
  for (const src of sources) {
    const where = { pack, file: src.file, doc: src.index };
    const t = detectDocType(src.doc);
    if ('error' in t) { st.issues.push({ level: 'error', ...where, path: '', message: t.error }); continue; }
    const full = fullId(pack, t.id);
    const map = st.raw.get(t.type)!;
    if (map.has(full)) { st.issues.push({ level: 'error', ...where, path: '', message: `duplicate ${t.type} '${t.id}'` }); continue; }
    map.set(full, { type: t.type, full, pack, file: src.file, index: src.index, doc: src.doc as Record<string, unknown> });
  }
}

function applyOverrides(st: BuildState): void {
  for (const [key, patch] of Object.entries(st.channel.overrides)) {
    const issue = (level: 'error' | 'warning', message: string) =>
      st.issues.push({ level, pack: CHANNEL, path: `overrides.${key}`, message });
    const m = /^(?:([a-z]+) )?(.+)$/.exec(key)!;
    const typeWord = m[1] as ContentType | undefined;
    const target = m[2]!;
    const { pack } = splitId(target);
    if (typeWord && !CONTENT_TYPES.includes(typeWord)) { issue('error', `unknown content type '${typeWord}'`); continue; }
    if (!pack) { issue('error', `write the full ID, like tp:${target}`); continue; }
    const types = typeWord ? [typeWord] : CONTENT_TYPES;
    const matches = types.map((t) => st.raw.get(t)!.get(target)).filter((d): d is RawDoc => !!d);
    if (matches.length === 0) {
      const dormant = (pack !== CHANNEL && pack !== CORE && !st.enabled.has(pack)) || (pack === CHANNEL && st.deleted.has(target));
      if (dormant) issue('warning', `override for ${target} is kept but ignored: it's dormant`);
      else issue('error', `nothing called '${target}' to override`);
      continue;
    }
    if (matches.length > 1) {
      issue('error', `'${target}' names more than one thing (${matches.map((d) => d.type).join(', ')}); write it as ${matches.map((d) => `'${d.type} ${target}'`).join(' or ')}`);
      continue;
    }
    const doc = matches[0]!;
    if (doc.type in patch) { issue('error', `an override can't change the '${doc.type}' key`); continue; }
    doc.doc = deepMerge(doc.doc, patch) as Record<string, unknown>;
  }
}

function parseDocs(st: BuildState): void {
  for (const type of CONTENT_TYPES) {
    for (const raw of st.raw.get(type)!.values()) {
      const r = DOC_SCHEMAS[type].safeParse(raw.doc);
      if (!r.success) {
        for (const i of r.error.issues) {
          st.issues.push({ level: 'error', pack: raw.pack, file: raw.file, doc: raw.index, path: i.path.join('.'), message: i.message });
        }
        st.raw.get(type)!.delete(raw.full);
      } else {
        raw.doc = r.data as Record<string, unknown>;
      }
    }
  }
}

export function buildRegistry(bundles: PackBundle[], channelRaw: unknown): Registry {
  const parsed = parseChannel(channelRaw);
  if ('errors' in parsed) {
    throw new ValidationError(parsed.errors.map((message) => ({ level: 'error' as const, pack: CHANNEL, path: '', message })));
  }
  const channel = parsed.channel;
  const st: BuildState = {
    reg: emptyRegistry(),
    issues: [],
    channel,
    enabled: new Set(channel.packs),
    depends: new Map(),
    raw: new Map(CONTENT_TYPES.map((t) => [t, new Map()])),
    deleted: new Set(channel.channelPack.deleted.map((d) => (d.includes(':') ? d : fullId(CHANNEL, d)))),
    classSlotRaw: null,
    startingItemsRaw: [],
  };

  // Core entries.
  st.reg.stats.set(CORE_HP, { id: CORE_HP, name: 'HP', icon: null, default: 0, perLevel: 0 });
  st.reg.statuses.set(CORE_KO, { id: CORE_KO, pack: CORE, def: { name: 'Knocked out', stacking: 'keep' } });
  st.reg.kinds.set(CORE_FIGHT, { id: CORE_FIGHT, pack: CORE, def: FIGHT_KIND, builtin: true });

  const byId = new Map<string, PackBundle>();
  for (const b of bundles) {
    if (byId.has(b.manifest.id)) st.issues.push({ level: 'error', pack: b.manifest.id, path: '', message: 'installed twice' });
    byId.set(b.manifest.id, b);
  }
  const ordered = orderPacks(st, byId);
  st.reg.packs = ordered.map((b) => b.manifest);

  for (const b of ordered) registerPlugins(st, b);
  for (const b of ordered) collectDocs(st, b.manifest.id, b.content);
  collectDocs(st, CHANNEL, channel.channelPack.content.map((doc, index) => ({ file: 'channel-pack', index, doc })));
  applyOverrides(st);
  parseDocs(st);

  const s = parseSettings(channel.settings);
  for (const message of s.errors) st.issues.push({ level: 'error', pack: CHANNEL, path: 'settings', message });
  st.reg.settings = { ...s.settings, classSlot: null, startingItems: [] };
  st.classSlotRaw = s.classSlot;
  st.startingItemsRaw = s.startingItems;

  normalizeAll(st);

  const errors = st.issues.filter((i) => i.level === 'error');
  st.reg.warnings = st.issues.filter((i) => i.level === 'warning');
  if (errors.length) throw new ValidationError(st.issues);
  return st.reg;
}
```

Also create a temporary stub so this compiles until Task 10:

`packages/engine/src/normalize.ts`:
```ts
import type { BuildState } from './registry';

/** Filled in by Task 10. */
export function normalizeAll(_st: BuildState): void {}
```

- [ ] **Step 4: Run the tests that don't need normalization**

Run: `pnpm vitest run packages/engine/test/registry.test.ts -t "packs and plugins|bad documents|ambiguous|unknown content"`
Expected: those tests PASS (the `ambiguous` test's second half and `applies overrides by ID` need Task 10; if the `-t` filter picks up `ambiguous`, its second assertion fails until Task 10. That's expected).

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): registry packs, plugins, documents and overrides"
```

---

### Task 10: The registry, part 2: resolution, normalization and dormancy

**Files:**
- Create: `packages/engine/src/resolve.ts`
- Modify: `packages/engine/src/normalize.ts` (replace the stub)
- Test: `packages/engine/test/dormancy.test.ts`, and the remaining tests in `packages/engine/test/registry.test.ts` now pass

**Interfaces:**
- Consumes: `BuildState`, `RawDoc`, `Registry` (Task 9), `normalizeParams`, `NormalizeCtx`, `Step` (Task 5), formula functions (Task 4).
- Produces:
  - `resolve.ts`: `const DORMANT: unique symbol`; `makeNormalizeCtx(st: BuildState, fromPack: string, where: { file?: string; doc?: number }, mode: { dormant: Set<string>; probe: boolean }): NormalizeCtx & { hitDormant: boolean }`
  - `normalize.ts`: `normalizeAll(st: BuildState): void`. It fills every content map in `st.reg`, sets `st.reg.dormant`, resolves `classSlot`/`startingItems`, and validates adventures and `grants-class`.

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/dormancy.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/errors';
import { buildRegistry } from '../src/registry';
import { tpBundle, tpChannel } from './helpers/tp-pack';

const errorsOf = (fn: () => unknown): string[] => {
  try { fn(); } catch (e) {
    if (e instanceof ValidationError) return e.issues.filter((i) => i.level === 'error').map((i) => `${i.pack} ${i.path}: ${i.message}`);
    throw e;
  }
  return [];
};

describe('normalization', () => {
  it('normalizes tp content into definitions', () => {
    const r = buildRegistry([tpBundle()], tpChannel());
    expect(r.stats.get('tp:power')).toEqual({ id: 'tp:power', name: 'Power', icon: null, default: 5, perLevel: 1 });
    expect([...r.slots.values()].map((s) => [s.id, s.order])).toEqual([['tp:hand', 0], ['tp:body', 1]]);
    expect(r.classes.get('tp:mender')?.stats).toEqual({ 'core:hp': -10 });
    expect(r.abilities.get('tp:zap')).toMatchObject({
      cooldown: 30000, when: 'fight', target: { rule: 'tp:foe', params: {} },
      steps: [
        { effect: 'tp:poke', params: { power: 'tp:power' } },
        { effect: 'tp:poke', params: { power: '(2 * tp:power)' } },
      ],
    });
    expect(r.abilities.get('tp:lull')?.steps[0]).toEqual({
      effect: 'tp:put', params: { status: 'tp:snooze', duration: 30000, params: { factor: 1.5 } },
    });
    expect(r.items.get('tp:club')).toMatchObject({ slot: 'tp:hand', grantsClass: 'tp:brute' });
    expect(r.items.get('tp:biscuit')).toMatchObject({ use: 'tp:snack', uses: 2, slot: null });
    expect(r.monsters.get('tp:blob')).toMatchObject({
      interval: 15000, behavior: { behavior: 'tp:pile', params: { abilities: { 'tp:slam': 1 }, 'targets-per': 5 } },
      drops: [{ item: 'tp:biscuit', chance: 0.5 }],
    });
    expect(r.encounters.get('tp:chat')?.spec).toEqual({ kind: 'tp:show', params: { text: 'Hello there', 'show-for': 10000 } });
    const trip = r.adventures.get('tp:trip')!;
    expect(trip.nodes.fight).toEqual({ spec: { kind: 'core:fight', params: 'tp:blob' }, use: null, next: { won: 'end', default: 'end' } });
    expect(trip.nodes.talk).toEqual({ spec: null, use: 'tp:chat', next: 'end' });
    expect(r.settings.classSlot).toBe('tp:hand');
    expect(r.settings.startingItems).toEqual(['tp:club', 'tp:rod']);
  });

  it('reports reference, formula and param problems with paths', () => {
    const errors = errorsOf(() => buildRegistry([tpBundle([
      { ability: 'bad1', name: 'B', cooldown: '1s', target: 'nobody', steps: [{ poke: { power: 'strength' } }] },
      { ability: 'bad2', name: 'B', cooldown: 'soon', target: 'me', steps: [{ poke: {} }, { nope: {} }, { poke: { power: 'power -2' } }] },
      { class: 'bad3', name: 'B', stats: { speed: 1 }, abilities: ['missing'] },
      { item: 'bad4', name: 'B', 'grants-class': 'brute' },
      { monster: 'bad5', name: 'B', hp: 5, stats: { hp: 3 }, abilities: ['slam'], behavior: { pile: { abilities: {}, 'targets-per': 0 } } },
    ])], tpChannel()));
    expect(errors).toEqual(expect.arrayContaining([
      "tp target: Unknown targeting 'nobody'",
      "tp steps[0].poke.power: Unknown stat 'strength'",
      "tp cooldown: Invalid duration 'soon' (use 500ms, 8s, 2m or 1h)",
      'tp steps[0].poke.power: required',
      "tp steps[1]: Unknown effect 'nope'",
      "tp steps[2].poke.power: Put a space on both sides of '-' for subtraction (at 7)",
      "tp stats.speed: Unknown stat 'speed'",
      "tp abilities[0]: Unknown ability 'missing'",
      'tp grants-class: an item that grants a class needs a slot',
      "tp stats.hp: a monster's HP is set with 'hp:', not in stats",
      'tp behavior.pile.targets-per: must be at least 1',
    ]));
  });

  it('only lets a pack refer to its dependencies', () => {
    const other = { ...tpBundle(), manifest: { id: 'xx', version: '1.0.0', name: 'xx', depends: {} }, content: [
      { file: 'x.yaml', index: 0, doc: { class: 'thief', name: 'Thief', abilities: ['tp:whack'] } },
    ], register: undefined };
    expect(errorsOf(() => buildRegistry([tpBundle(), other], tpChannel({ packs: ['tp', 'xx'] }))))
      .toContain("xx abilities[0]: 'tp:whack': xx doesn't depend on tp");
  });

  it('validates adventures: start, next targets, outcomes and reachability', () => {
    const errors = errorsOf(() => buildRegistry([tpBundle([{
      adventure: 'broken', name: 'B', start: 'nowhere',
      nodes: {
        a: { show: { text: 'x' }, next: 'ghost' },
        b: { ballot: { choices: { x: 'X' }, time: '5s' }, next: { y: 'a', ended: 'a', default: 'a' } },
        c: { fight: 'blob', next: { lost: 'a' } },
        d: { show: { text: 'x' }, ballot: { choices: {}, time: '1s' } },
      },
    }])], tpChannel()));
    expect(errors).toEqual(expect.arrayContaining([
      "tp start: no node called 'nowhere'",
      "tp nodes.a.next: no node called 'ghost'",
      "tp nodes.b.next.y: 'y' isn't an outcome of this node (outcomes: x, ended)",
      "tp nodes.c.next.lost: 'lost' isn't an outcome of this node (outcomes: won, ended)",
      'tp nodes.d: a node needs exactly one encounter kind or use (found: show, ballot)',
    ]));
  });

  it('warns when grants-class is outside the class slot', () => {
    const r = buildRegistry([tpBundle([{ item: 'badge', name: 'Badge', slot: 'body', 'grants-class': 'brute' }])], tpChannel());
    expect(r.items.get('tp:badge')?.grantsClass).toBeNull();
    expect(r.warnings.map((w) => w.message)).toContain("grants-class is ignored: tp:badge isn't in the class slot");
  });

  it('works with no class slot and no classes at all', () => {
    const r = buildRegistry([tpBundle()], { packs: ['tp'] });
    expect(r.settings.classSlot).toBeNull();
    expect([...r.items.values()].every((i) => i.grantsClass === null)).toBe(true);
  });
});

describe('dormancy', () => {
  const channelPack = (content: unknown[], deleted: string[] = []) => ({ 'channel-pack': { content, deleted } });

  it('makes channel content that refers to a disabled pack dormant, through chains', () => {
    const r = buildRegistry([tpBundle()], tpChannel({
      packs: [],
      settings: { 'class-slot': 'tp:hand', 'starting-items': ['tp:club'] },
      ...channelPack([
        { monster: 'grub', name: 'Grub', hp: 10, abilities: ['tp:slam'], behavior: { 'tp:pile': { abilities: { 'tp:slam': 1 }, 'targets-per': 5 } } },
        { adventure: 'hunt', name: 'Hunt', start: 'go', nodes: { go: { fight: 'grub' } } },
        { slot: 'paw', name: 'Paw' },
      ]),
    }));
    expect(r.monsters.has('channel:grub')).toBe(false);
    expect(r.adventures.has('channel:hunt')).toBe(false);
    expect(r.slots.has('channel:paw')).toBe(true);
    expect([...r.dormant].sort()).toEqual(['adventure channel:hunt', 'monster channel:grub']);
    expect(r.settings.classSlot).toBeNull();
    expect(r.settings.startingItems).toEqual([]);
    expect(r.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('treats deleted channel content as dormant but typos as errors', () => {
    const ok = buildRegistry([tpBundle()], tpChannel({
      ...channelPack([{ adventure: 'old', name: 'Old', start: 'go', nodes: { go: { fight: 'gone' } } }], ['gone']),
    }));
    expect(ok.dormant.has('adventure channel:old')).toBe(true);

    expect(errorsOf(() => buildRegistry([tpBundle()], tpChannel({
      ...channelPack([{ adventure: 'old', name: 'Old', start: 'go', nodes: { go: { fight: 'gnoe' } } }]),
    })))).toContain("channel nodes.go.fight: Unknown monster 'gnoe'");

    expect(errorsOf(() => buildRegistry([tpBundle()], tpChannel({ settings: { 'starting-items': ['tp:clbu'] } }))))
      .toContain("channel settings.starting-items[0]: Unknown item 'tp:clbu'");
  });

  it('keeps overrides for dormant content as warnings', () => {
    const r = buildRegistry([tpBundle()], { packs: [], overrides: { 'tp:zap': { cooldown: '1s' } } });
    expect(r.warnings.map((w) => w.message)).toContain("override for tp:zap is kept but ignored: it's dormant");
  });

  it('resolves bare IDs in the channel pack to channel content, then core', () => {
    const r = buildRegistry([tpBundle()], tpChannel({
      ...channelPack([
        { monster: 'grub', name: 'Grub', hp: 10, abilities: ['tp:slam'], behavior: { 'tp:pile': { abilities: { 'tp:slam': 1 }, 'targets-per': 5 } } },
        { encounter: 'scrap', fight: 'grub' },
      ]),
    }));
    expect(r.encounters.get('channel:scrap')?.spec).toEqual({ kind: 'core:fight', params: 'channel:grub' });
  });

  it('applies the no-source rule to steps marked noSource', () => {
    const bundle = tpBundle();
    const inner = bundle.register!;
    bundle.register = (api) => {
      inner(api);
      api.encounterKind('pit', {
        name: 'Pit', params: (({ t: 'object', fields: { steps: { t: 'steps', noSource: true } } }) as const),
        outcomes: () => ['done'], start: () => ({}), respond: (_c, s) => s, wakeAt: () => null,
        advance: (_c, s) => s, endEarly: () => 'done', panel: () => ({ type: 'none' }), overlay: () => null,
      });
    };
    bundle.content.push({ file: 'tp.yaml', index: 99, doc: { encounter: 'drop', pit: { steps: [{ poke: { power: 'power' } }, { poke: { power: 'target.power * 2' } }] } } });
    expect(errorsOf(() => buildRegistry([bundle], tpChannel())))
      .toEqual(["tp pit.steps[0].poke.power: This formula has no source; use target.<stat> or numbers"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/engine/test/dormancy.test.ts`
Expected: FAIL (normalization is a stub; content maps are empty).

- [ ] **Step 3: Implement `resolve.ts`**

`packages/engine/src/resolve.ts`:
```ts
import { FormulaError, formulaVars, mapFormulaStats, parseFormula, printFormula } from './formula';
import { CHANNEL, CONTENT_TYPES, type ContentType, CORE, fullId, LOCAL_ID_PATTERN, PACK_ID_PATTERN, type RefType, refKey, splitId } from './ids';
import { type NormalizeCtx, normalizeParams, p, type Step, type StatusApplication } from './params';
import type { BuildState } from './registry';

const PLUGIN_MAP: Record<string, string> = {
  effect: 'effects', status: 'statuses', passive: 'passives', targeting: 'targeting', behavior: 'behaviors', encounterKind: 'kinds',
};

function exists(st: BuildState, type: RefType, full: string): boolean {
  if ((CONTENT_TYPES as readonly string[]).includes(type)) {
    if (type === 'stat' && full === 'core:hp') return true;
    return st.raw.get(type as ContentType)!.has(full);
  }
  return (st.reg[PLUGIN_MAP[type] as 'effects'] as Map<string, unknown>).has(full);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Builds the NormalizeCtx for content from `fromPack`.
 * In probe mode, issues are swallowed; only `hitDormant` matters (used to compute dormancy).
 */
export function makeNormalizeCtx(
  st: BuildState,
  fromPack: string,
  where: { file?: string; doc?: number },
  mode: { dormant: Set<string>; probe: boolean },
): NormalizeCtx & { hitDormant: boolean; dormantRefs: string[] } {
  const isChannel = fromPack === CHANNEL;
  const ctx = {
    hitDormant: false,
    dormantRefs: [] as string[],
    issue(path: string, message: string) {
      if (!mode.probe) st.issues.push({ level: 'error', pack: fromPack, ...where, path, message });
    },
    ref(type: RefType, raw: string, path: string): string | null {
      const { pack, id } = splitId(raw);
      if (!LOCAL_ID_PATTERN.test(id) || (pack !== null && !PACK_ID_PATTERN.test(pack))) {
        ctx.issue(path, `Invalid ID '${raw}'`);
        return null;
      }
      let full: string;
      if (pack !== null) {
        if (pack !== fromPack && pack !== CORE) {
          if (isChannel) {
            if (!st.enabled.has(pack)) { ctx.markDormant(`${type} ${raw}`); return null; }
          } else if (!st.depends.get(fromPack)?.has(pack)) {
            ctx.issue(path, `'${raw}': ${fromPack} doesn't depend on ${pack}`);
            return null;
          }
        }
        full = fullId(pack, id);
      } else {
        const own = fullId(fromPack, id);
        const core = fullId(CORE, id);
        full = exists(st, type, own) ? own : exists(st, type, core) ? core : own;
      }
      if (exists(st, type, full)) {
        if (mode.dormant.has(refKey(type, full))) { ctx.markDormant(`${type} ${full}`); return null; }
        return full;
      }
      if (isChannel && st.deleted.has(full)) { ctx.markDormant(`${type} ${full} (deleted)`); return null; }
      ctx.issue(path, `Unknown ${type === 'encounterKind' ? 'encounter kind' : type} '${raw}'`);
      return null;
    },
    markDormant(what: string) {
      ctx.hitDormant = true;
      ctx.dormantRefs.push(what);
    },
    formula(text: string, path: string, noSource: boolean): string | null {
      let node;
      try { node = parseFormula(text); } catch (e) {
        if (e instanceof FormulaError) { ctx.issue(path, e.message); return null; }
        throw e;
      }
      const vars = formulaVars(node);
      if (noSource && vars.some((v) => v.side === 'source')) {
        ctx.issue(path, 'This formula has no source; use target.<stat> or numbers');
        return null;
      }
      let ok = true;
      const mapped = mapFormulaStats(node, (stat) => {
        const full = ctx.ref('stat', stat, path);
        if (!full) ok = false;
        return full ?? stat;
      });
      return ok ? printFormula(mapped) : null;
    },
    steps(value: unknown, path: string, noSource: boolean): Step[] | null {
      if (!Array.isArray(value)) { ctx.issue(path, 'must be a list of steps'); return null; }
      const out: Step[] = [];
      value.forEach((step, i) => {
        const sp = `${path}[${i}]`;
        if (!isObj(step) || Object.keys(step).length !== 1) { ctx.issue(sp, 'each step is one effect with its params, like { poke: { ... } }'); return; }
        const [key, params] = Object.entries(step)[0]!;
        const effect = ctx.ref('effect', key, sp);
        if (!effect) return;
        const def = st.reg.effects.get(effect)!.def;
        const np = normalizeParams(def.params ?? p.object({}), params ?? {}, ctx, `${sp}.${key}`, noSource);
        out.push({ effect, params: np });
      });
      return out;
    },
    statusApplication(value: unknown, path: string, noSource: boolean): StatusApplication | null {
      if (!isObj(value)) { ctx.issue(path, 'must be a map with a status'); return null; }
      const { status, duration, ...rest } = value;
      if (typeof status !== 'string') { ctx.issue(`${path}.status`, 'required'); return null; }
      const id = ctx.ref('status', status, `${path}.status`);
      if (!id) return null;
      const d = duration === undefined || duration === null ? null : normalizeParams(p.duration(), duration, ctx, `${path}.duration`);
      const def = st.reg.statuses.get(id)!.def;
      const params = normalizeParams(def.params ?? p.object({}), rest, ctx, path, noSource);
      return { status: id, duration: (d as number | null | undefined) ?? null, params };
    },
  };
  return ctx;
}
```

- [ ] **Step 4: Implement `normalize.ts`**

`packages/engine/src/normalize.ts`:
```ts
import type {
  AbilityDef, AdventureDef, AdventureNode, ClassDef, EncounterDef, EncounterSpec, ItemDef, MonsterDef, PassiveUse, SlotDef, StatDef, TargetUse,
} from './content';
import { CHANNEL, CONTENT_TYPES, type ContentType, refKey } from './ids';
import { type NormalizeCtx, normalizeParams, p } from './params';
import type { BuildState, RawDoc } from './registry';
import { makeNormalizeCtx } from './resolve';
import { parseDuration } from './units';

type Ctx = NormalizeCtx & { hitDormant: boolean; dormantRefs: string[] };

function statMap(raw: Record<string, number>, ctx: Ctx, path: string, allowHp: boolean): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const id = ctx.ref('stat', k, `${path}.${k}`);
    if (!id) continue;
    if (id === 'core:hp' && !allowHp) { ctx.issue(`${path}.${k}`, "a monster's HP is set with 'hp:', not in stats"); continue; }
    out[id] = v;
  }
  return out;
}

function passives(st: BuildState, raw: unknown[], ctx: Ctx, path: string): PassiveUse[] {
  const out: PassiveUse[] = [];
  raw.forEach((entry, i) => {
    const pth = `${path}[${i}]`;
    const [key, params] = typeof entry === 'string' ? [entry, {}] : (Object.entries(entry as object)[0] ?? ['', {}]);
    const id = ctx.ref('passive', key as string, pth);
    if (!id) return;
    out.push({ passive: id, params: normalizeParams(st.reg.passives.get(id)!.def.params ?? p.object({}), params ?? {}, ctx, pth) });
  });
  return out;
}

function single(v: Record<string, unknown>, ctx: Ctx, path: string, what: string): [string, unknown] | null {
  const entries = Object.entries(v);
  if (entries.length !== 1) { ctx.issue(path, `${what} must be one ID with its params`); return null; }
  return entries[0]!;
}

function duration(v: unknown, ctx: Ctx, path: string): number | null {
  try { return parseDuration(v as string | number); } catch (e) { ctx.issue(path, (e as Error).message); return null; }
}

const NODE_KEYS = new Set(['next', 'use']);

/** Parses `{ <kind>: params }` (plus excluded keys) into a spec. */
function encounterSpec(st: BuildState, obj: Record<string, unknown>, exclude: Set<string>, ctx: Ctx, path: string, label: string): EncounterSpec | null {
  const keys = Object.keys(obj).filter((k) => !exclude.has(k));
  if (keys.length !== 1) {
    ctx.issue(path, `${label} needs exactly one encounter kind${label === 'a node' ? ' or use' : ''} (found: ${keys.join(', ') || 'none'})`);
    return null;
  }
  const key = keys[0]!;
  const kind = ctx.ref('encounterKind', key, path ? `${path}.${key}` : key);
  if (!kind) return null;
  const entry = st.reg.kinds.get(kind)!;
  const params = normalizeParams(entry.def.params ?? p.object({}), obj[key] ?? {}, ctx, path ? `${path}.${key}` : key);
  if (!entry.builtin && entry.def.validate) {
    try {
      for (const message of entry.def.validate(params)) ctx.issue(path ? `${path}.${key}` : key, message);
    } catch (e) {
      ctx.issue(path ? `${path}.${key}` : key, `validate() failed: ${(e as Error).message}`);
    }
  }
  return { kind, params };
}

function normalizeDoc(st: BuildState, raw: RawDoc, ctx: Ctx): unknown {
  const d = raw.doc as Record<string, any>;
  switch (raw.type) {
    case 'stat': return { id: raw.full, name: d.name, icon: d.icon, default: d.default, perLevel: d['per-level'] } satisfies StatDef;
    case 'slot': return { id: raw.full, name: d.name, order: 0 } satisfies SlotDef;
    case 'class': return {
      id: raw.full, name: d.name, description: d.description, icon: d.icon, tags: d.tags,
      stats: statMap(d.stats, ctx, 'stats', true),
      abilities: (d.abilities as string[]).map((a, i) => ctx.ref('ability', a, `abilities[${i}]`)).filter((a): a is string => !!a),
      passives: passives(st, d.passives, ctx, 'passives'),
    } satisfies ClassDef;
    case 'ability': {
      let target: TargetUse | null = null;
      const t = typeof d.target === 'string' ? [d.target, {}] as [string, unknown] : single(d.target, ctx, 'target', 'target');
      if (t) {
        const rule = ctx.ref('targeting', t[0], 'target');
        if (rule) target = { rule, params: normalizeParams(st.reg.targeting.get(rule)!.def.params ?? p.object({}), t[1] ?? {}, ctx, `target.${t[0]}`) };
      }
      return {
        id: raw.full, name: d.name, description: d.description, icon: d.icon,
        cooldown: duration(d.cooldown, ctx, 'cooldown') ?? 0, when: d.when,
        target: target ?? { rule: '', params: {} }, steps: ctx.steps(d.steps, 'steps', false) ?? [],
      } satisfies AbilityDef;
    }
    case 'item': {
      const slot = d.slot ? ctx.ref('slot', d.slot, 'slot') : null;
      let grantsClass: string | null = null;
      if (d['grants-class']) {
        if (!d.slot) ctx.issue('grants-class', 'an item that grants a class needs a slot');
        else grantsClass = ctx.ref('class', d['grants-class'], 'grants-class');
      }
      return {
        id: raw.full, name: d.name, description: d.description, icon: d.icon, slot, grantsClass,
        stats: statMap(d.stats, ctx, 'stats', true), passives: passives(st, d.passives, ctx, 'passives'),
        abilities: (d.abilities as string[]).map((a, i) => ctx.ref('ability', a, `abilities[${i}]`)).filter((a): a is string => !!a),
        use: d.use ? ctx.ref('ability', d.use, 'use') : null, uses: d.uses, price: d.price,
      } satisfies ItemDef;
    }
    case 'monster': {
      const b = single(d.behavior, ctx, 'behavior', 'behavior');
      let behavior = { behavior: '', params: {} as unknown };
      if (b) {
        const id = ctx.ref('behavior', b[0], 'behavior');
        if (id) behavior = { behavior: id, params: normalizeParams(st.reg.behaviors.get(id)!.def.params ?? p.object({}), b[1] ?? {}, ctx, `behavior.${b[0]}`) };
      }
      return {
        id: raw.full, name: d.name, description: d.description, image: d.image, tags: d.tags, hp: d.hp,
        stats: statMap(d.stats, ctx, 'stats', false),
        abilities: (d.abilities as string[]).map((a, i) => ctx.ref('ability', a, `abilities[${i}]`)).filter((a): a is string => !!a),
        passives: passives(st, d.passives, ctx, 'passives'), behavior,
        interval: d.interval === undefined ? null : duration(d.interval, ctx, 'interval'),
        rewards: d.rewards,
        drops: (d.drops as { item: string; chance: number }[]).map((x, i) => ({ item: ctx.ref('item', x.item, `drops[${i}].item`) ?? '', chance: x.chance })),
      } satisfies MonsterDef;
    }
    case 'encounter': {
      const spec = encounterSpec(st, d, new Set(['encounter', 'name']), ctx, '', 'an encounter');
      return { id: raw.full, name: d.name ?? raw.full, spec: spec ?? { kind: '', params: null } } satisfies EncounterDef;
    }
    case 'adventure': {
      const nodes: Record<string, AdventureNode> = {};
      for (const [name, node] of Object.entries(d.nodes as Record<string, Record<string, unknown>>)) {
        const path = `nodes.${name}`;
        let spec: EncounterSpec | null = null;
        let use: string | null = null;
        const kinds = Object.keys(node).filter((k) => !NODE_KEYS.has(k));
        if (typeof node.use === 'string') {
          if (kinds.length) ctx.issue(path, `a node needs exactly one encounter kind or use (found: use, ${kinds.join(', ')})`);
          use = ctx.ref('encounter', node.use, `${path}.use`);
        } else {
          spec = encounterSpec(st, node, NODE_KEYS, ctx, path, 'a node');
        }
        nodes[name] = { spec, use, next: (node.next as AdventureNode['next']) ?? null };
      }
      return { id: raw.full, name: d.name, description: d.description, start: d.start, nodes } satisfies AdventureDef;
    }
  }
}

const MAPS: Record<ContentType, keyof BuildState['reg']> = {
  stat: 'stats', slot: 'slots', class: 'classes', ability: 'abilities', item: 'items',
  monster: 'monsters', encounter: 'encounters', adventure: 'adventures',
};

function checkAdventure(st: BuildState, adv: AdventureDef, raw: RawDoc): void {
  const issue = (path: string, message: string) => st.issues.push({ level: 'error', pack: raw.pack, file: raw.file, doc: raw.index, path, message });
  if (!(adv.start in adv.nodes)) issue('start', `no node called '${adv.start}'`);
  for (const [name, node] of Object.entries(adv.nodes)) {
    const spec = node.spec ?? (node.use ? st.reg.encounters.get(node.use)?.spec : undefined);
    let outcomes: string[] = [];
    if (spec?.kind) {
      const entry = st.reg.kinds.get(spec.kind);
      try { outcomes = entry?.builtin ? ['won'] : entry?.def.outcomes(spec.params) ?? []; }
      catch (e) { issue(`nodes.${name}`, `outcomes() failed: ${(e as Error).message}`); }
    }
    const next = node.next;
    if (typeof next === 'string') {
      if (!(next in adv.nodes)) issue(`nodes.${name}.next`, `no node called '${next}'`);
    } else if (next) {
      for (const [key, target] of Object.entries(next)) {
        if (key !== 'default' && key !== 'ended' && !outcomes.includes(key)) {
          issue(`nodes.${name}.next.${key}`, `'${key}' isn't an outcome of this node (outcomes: ${[...outcomes, 'ended'].join(', ')})`);
        }
        if (!(target in adv.nodes)) issue(`nodes.${name}.next.${key}`, `no node called '${target}'`);
      }
    }
  }
  if (adv.start in adv.nodes) {
    const seen = new Set<string>();
    const queue = [adv.start];
    while (queue.length) {
      const n = queue.shift()!;
      if (seen.has(n) || !(n in adv.nodes)) continue;
      seen.add(n);
      const next = adv.nodes[n]!.next;
      if (typeof next === 'string') queue.push(next);
      else if (next) queue.push(...Object.values(next));
    }
    for (const n of Object.keys(adv.nodes)) if (!seen.has(n)) issue(`nodes.${n}`, `node '${n}' can't be reached from '${adv.start}'`);
  }
}

export function normalizeAll(st: BuildState): void {
  const all = CONTENT_TYPES.flatMap((t) => [...st.raw.get(t)!.values()]);
  const channelDocs = all.filter((d) => d.pack === CHANNEL);

  // 1. Dormancy fixed point over channel content (probe mode swallows issues).
  const dormant = new Set<string>();
  const why = new Map<string, string[]>();
  for (let changed = true; changed;) {
    changed = false;
    for (const raw of channelDocs) {
      const key = refKey(raw.type, raw.full);
      if (dormant.has(key)) continue;
      const ctx = makeNormalizeCtx(st, CHANNEL, {}, { dormant, probe: true });
      normalizeDoc(st, raw, ctx);
      if (ctx.hitDormant) { dormant.add(key); why.set(key, ctx.dormantRefs); changed = true; }
    }
  }
  st.reg.dormant = dormant;
  for (const key of dormant) {
    const raw = channelDocs.find((d) => refKey(d.type, d.full) === key)!;
    st.issues.push({ level: 'warning', pack: CHANNEL, file: raw.file, doc: raw.index, path: '', message: `${key} is dormant (needs ${why.get(key)!.join(', ')})` });
  }

  // 2. Real pass, in type order, filling the registry maps.
  let slotOrder = 0;
  for (const type of CONTENT_TYPES) {
    for (const raw of st.raw.get(type)!.values()) {
      if (dormant.has(refKey(type, raw.full))) continue;
      const ctx = makeNormalizeCtx(st, raw.pack, { file: raw.file, doc: raw.index }, { dormant, probe: false });
      const def = normalizeDoc(st, raw, ctx) as { id: string; order?: number };
      if (type === 'slot') def.order = slotOrder++;
      (st.reg[MAPS[type]] as Map<string, unknown>).set(raw.full, def);
    }
  }
  for (const adv of st.reg.adventures.values()) checkAdventure(st, adv, st.raw.get('adventure')!.get(adv.id)!);

  // 3. Settings references (resolved from the channel's point of view).
  const sctx = makeNormalizeCtx(st, CHANNEL, {}, { dormant, probe: false });
  if (st.classSlotRaw) {
    const id = sctx.ref('slot', st.classSlotRaw, 'settings.class-slot');
    if (sctx.hitDormant) st.issues.push({ level: 'warning', pack: CHANNEL, path: 'settings.class-slot', message: `class slot ${st.classSlotRaw} is dormant, so it counts as unset` });
    st.reg.settings.classSlot = id;
  }
  st.reg.settings.startingItems = st.startingItemsRaw.flatMap((raw, i) => {
    const c = makeNormalizeCtx(st, CHANNEL, {}, { dormant, probe: false });
    const id = c.ref('item', raw, `settings.starting-items[${i}]`);
    if (c.hitDormant) st.issues.push({ level: 'warning', pack: CHANNEL, path: `settings.starting-items[${i}]`, message: `starting item ${raw} is dormant and skipped` });
    return id ? [id] : [];
  });

  // 4. grants-class only counts in the class slot.
  for (const item of st.reg.items.values()) {
    if (item.grantsClass && item.slot !== st.reg.settings.classSlot) {
      st.issues.push({ level: 'warning', pack: item.id.split(':')[0]!, path: 'grants-class', message: `grants-class is ignored: ${item.id} isn't in the class slot` });
      item.grantsClass = null;
    }
  }
}
```

- [ ] **Step 5: Run every registry test**

Run: `pnpm vitest run packages/engine/test/registry.test.ts packages/engine/test/dormancy.test.ts`
Expected: PASS. If a message differs only in wording, fix the code to match the test, not the other way round: the tests pin the messages people will read.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck`
Expected: clean.

```bash
git add packages/engine
git commit -m "feat(engine): reference resolution, normalization and dormancy"
```

---

### Task 11: `createEngine` and `describe()`

**Files:**
- Create: `packages/engine/src/describe.ts`, `packages/engine/src/engine.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/test/engine.test.ts`

**Interfaces:**
- Consumes: `buildRegistry`, `Registry` (Tasks 9–10).
- Produces:
  - `interface Description` (plain JSON; fields below)
  - `describe(reg: Registry): Description`
  - `interface Engine { registry: Registry; warnings: Issue[]; describe(): Description }` (Plan B adds game methods to this interface and object)
  - `createEngine(opts: { packs: PackBundle[]; channel: unknown }): Engine`
  - `index.ts` re-exports: `createEngine`, `Engine`, `definePack`, `p`, `Rejection`, `ValidationError`, `PluginError`, `EngineError`, `formatIssue`, `parseDuration`, `formatDuration`, and all types from `pack.ts`, `content.ts`, `params.ts`, `errors.ts`, `channel.ts` (`Settings`), `describe.ts`.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/engine.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createEngine, ValidationError } from '../src';
import { tpBundle, tpChannel } from './helpers/tp-pack';

describe('createEngine', () => {
  it('builds and describes a channel', () => {
    const engine = createEngine({ packs: [tpBundle()], channel: tpChannel() });
    const d = engine.describe();
    expect(d.packs).toEqual([{ id: 'tp', version: '1.0.0', name: 'Test Pack' }]);
    expect(d.classes.map((c) => c.id)).toEqual(['tp:brute', 'tp:mender']);
    expect(d.abilities.find((a) => a.id === 'tp:mend')).toMatchObject({ name: 'Mend', needsChoice: true, cooldown: 15000, when: 'fight' });
    expect(d.items.find((i) => i.id === 'tp:club')).toMatchObject({ slot: 'tp:hand', grantsClass: 'tp:brute', starting: true });
    expect(d.monsters.map((m) => m.id)).toEqual(['tp:blob', 'tp:ogre']);
    expect(d.kinds.map((k) => k.id)).toEqual(['core:fight', 'tp:show', 'tp:ballot']);
    expect(d.adventures[0]).toMatchObject({ id: 'tp:trip', start: 'intro', nodes: ['intro', 'pick', 'fight', 'talk', 'end'] });
    expect(d.settings.classSlot).toBe('tp:hand');
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it('throws ValidationError for bad input', () => {
    expect(() => createEngine({ packs: [tpBundle()], channel: { packs: ['nope'] } })).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/engine/test/engine.test.ts`
Expected: FAIL, `createEngine` not exported.

- [ ] **Step 3: Implement**

`packages/engine/src/describe.ts`:
```ts
import type { Settings } from './channel';
import type { Issue } from './errors';
import type { Registry } from './registry';

export interface Description {
  packs: { id: string; version: string; name: string }[];
  stats: { id: string; name: string; icon: string | null; default: number; perLevel: number }[];
  slots: { id: string; name: string }[];
  classes: { id: string; name: string; description: string; icon: string | null; abilities: string[] }[];
  abilities: { id: string; name: string; description: string; icon: string | null; cooldown: number; when: 'fight' | 'anytime'; rule: string; needsChoice: boolean }[];
  items: { id: string; name: string; description: string; icon: string | null; slot: string | null; grantsClass: string | null; use: string | null; uses: number; price: number; starting: boolean }[];
  monsters: { id: string; name: string; image: string | null; hp: number }[];
  statuses: { id: string; name: string; icon: string | null }[];
  kinds: { id: string; name: string }[];
  encounters: { id: string; name: string; kind: string }[];
  adventures: { id: string; name: string; start: string; nodes: string[] }[];
  settings: Settings;
  dormant: string[];
  warnings: Issue[];
}

export function describe(reg: Registry): Description {
  return {
    packs: reg.packs.map((m) => ({ id: m.id, version: m.version, name: m.name })),
    stats: [...reg.stats.values()].map((s) => ({ id: s.id, name: s.name, icon: s.icon, default: s.default, perLevel: s.perLevel })),
    slots: [...reg.slots.values()].map((s) => ({ id: s.id, name: s.name })),
    classes: [...reg.classes.values()].map((c) => ({ id: c.id, name: c.name, description: c.description, icon: c.icon, abilities: c.abilities })),
    abilities: [...reg.abilities.values()].map((a) => ({
      id: a.id, name: a.name, description: a.description, icon: a.icon, cooldown: a.cooldown, when: a.when,
      rule: a.target.rule, needsChoice: !!reg.targeting.get(a.target.rule)?.def.needsChoice,
    })),
    items: [...reg.items.values()].map((i) => ({
      id: i.id, name: i.name, description: i.description, icon: i.icon, slot: i.slot, grantsClass: i.grantsClass,
      use: i.use, uses: i.uses, price: i.price, starting: reg.settings.startingItems.includes(i.id),
    })),
    monsters: [...reg.monsters.values()].map((m) => ({ id: m.id, name: m.name, image: m.image, hp: m.hp })),
    statuses: [...reg.statuses.values()].map((s) => ({ id: s.id, name: s.def.name, icon: s.def.icon ?? null })),
    kinds: [...reg.kinds.values()].map((k) => ({ id: k.id, name: k.def.name })),
    encounters: [...reg.encounters.values()].map((e) => ({ id: e.id, name: e.name, kind: e.spec.kind })),
    adventures: [...reg.adventures.values()].map((a) => ({ id: a.id, name: a.name, start: a.start, nodes: Object.keys(a.nodes) })),
    settings: structuredClone(reg.settings),
    dormant: [...reg.dormant],
    warnings: reg.warnings,
  };
}
```

`packages/engine/src/engine.ts`:
```ts
import { type Description, describe } from './describe';
import type { Issue } from './errors';
import type { PackBundle } from './pack';
import { buildRegistry, type Registry } from './registry';

export interface Engine {
  registry: Registry;
  warnings: Issue[];
  describe(): Description;
}

export function createEngine(opts: { packs: PackBundle[]; channel: unknown }): Engine {
  const registry = buildRegistry(opts.packs, opts.channel);
  return {
    registry,
    warnings: registry.warnings,
    describe: () => describe(registry),
  };
}
```

`packages/engine/src/index.ts`:
```ts
export { createEngine, type Engine } from './engine';
export { definePack } from './pack';
export type * from './pack';
export type * from './content';
export { p } from './params';
export type { ParamSchema, Step, StatusApplication, AmountOrPercent } from './params';
export { EngineError, formatIssue, PluginError, Rejection, ValidationError, type Issue } from './errors';
export type { Settings } from './channel';
export type { Description } from './describe';
export { formatDuration, parseDuration, parsePercent } from './units';
```

- [ ] **Step 4: Run all tests, typecheck and lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): createEngine and describe"
```

---

## Plan A self-review notes

- Spec coverage for this plan: §4.2 naming (Tasks 3, 10), §5.1 bundles and official packs (Tasks 6, 9), §5.2 registration and content in bundles (Tasks 9–10), §5.5 formulas (Tasks 4, 10), §7.1–7.4 channel layering, overrides, dormancy (Tasks 7, 9, 10), §7.5 settings (Task 7), §8 content types (Tasks 6, 10), §10 validation (Tasks 9–10), §3 determinism lint (Task 1). Game-loop sections (§6, §11) are Plan B.
- `Ctx` is declared here (Task 6) and implemented in Plan B.
