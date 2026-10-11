# Project 1, Plan C: Pack Loader and Starter Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load packs from disk and ship the free starter pack (Fighter, Tank, Healer, three monsters, a shop, five encounter kinds, the sample adventure), built only through the public pack API. Prove the API is really public with a second test pack (a Mage class) and a test that fails if the engine ever names a starter-pack ID.

**Architecture:** `packages/pack-loader` (Node) turns a pack folder into a `PackBundle`: it reads `pack.json`, parses every YAML document under `content/`, and imports `src/index.ts` only for official packs (folders directly inside this repository's `packs/`). `packs/starter` is an ordinary workspace package whose code imports `@dndm/engine` like any outside pack would. `channels/default.yaml` is the CLI's default channel config.

**Tech Stack:** As before, plus `yaml@2.9.1` in the loader.

**Spec:** `docs/superpowers/specs/2026-10-11-engine-and-packs-design.md` (rev 6), mainly §1.2, §5.1, §8, §9, §12, §14. Flagged decisions: `docs/superpowers/plans/2026-10-11-project-1-README.md`.

**Prerequisite:** Plans A and B complete (all engine tests green).

## Global Constraints

- The starter pack uses only `@dndm/engine`'s public exports (`definePack`, `p`, `Rejection` and types). It never imports from `@dndm/engine/src/...`.
- Every number in spec §9 lives in the starter pack's YAML, so overrides reach it. Plugin code holds no tuning numbers except safe fallbacks.
- YAML formulas that contain a comma (`random(1.0, 1.2)`) must be quoted, otherwise YAML splits the flow map at the comma.
- No AI-generated art. The three class icons are simple hand-written vector SVGs (spec §12). Monster images and story media are `null`.
- `packs/` holds only code reviewed and merged into this repository (spec §5.1).

## Review Focus

1. **A YAML file with a syntax error or a tab-indented line**: a person expects an error that names the file and line, not a stack trace from deep in the loader. Test in Task 1.
2. **A pack folder with code outside this repository's `packs/`**: a person expects its code never to be imported (not merely refused later), since importing already runs it. Test in Task 1.
3. **A vote where nobody votes, or a tie**: a person expects the tie-break rule (random by default) to pick among all choices, never a crash or an `undefined` outcome. Test in Task 4.
4. **A shop purchase with exactly enough gold, and one with one gold short**: a person expects the first to work and the second to say "Not enough gold" with nothing changed. Test in Task 4.
5. **A guarding tank when the monster hits more than one person**: a person expects the tank to be hit first and the others after, not the tank twice. Test in Task 3.

---

## File map (this plan)

```
packages/pack-loader/
  package.json
  src/index.ts          loadPack, loadPacks, listPackDirs, loadChannel, repoRoot, LoadError
  test/loader.test.ts
packs/starter/
  package.json          workspace package @dndm/pack-starter
  pack.json             manifest
  src/index.ts          plugins: effects, statuses, targeting, behavior, encounter kinds
  content/stats.yaml, slots.yaml, classes.yaml, abilities.yaml, items.yaml,
          monsters.yaml, encounters.yaml, adventures/the-cave.yaml
  art/icons/sword.svg, shield.svg, staff.svg
  test/helpers.ts       starter harness
  test/classes.test.ts, kinds.test.ts, adventure.test.ts, mage.test.ts, no-special-treatment.test.ts
channels/default.yaml
```

---

### Task 1: The pack loader

**Files:**
- Create: `packages/pack-loader/package.json`, `packages/pack-loader/src/index.ts`
- Test: `packages/pack-loader/test/loader.test.ts`

**Interfaces:**
- Consumes: `PackBundle`, `PackManifest`, `ContentSource`, `PackDefinition` types from `@dndm/engine`.
- Produces:
  - `class LoadError extends Error` (message names the file)
  - `repoRoot(): string` (absolute path of this repository)
  - `listPackDirs(root?: string): string[]` (every folder in `<repo>/packs` with a `pack.json`, sorted)
  - `loadPack(dir: string): Promise<PackBundle>`
  - `loadPacks(dirs: string[]): Promise<PackBundle[]>`
  - `loadChannel(file: string): unknown`

- [ ] **Step 1: Create the package**

`packages/pack-loader/package.json`:
```json
{
  "name": "@dndm/pack-loader",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@dndm/engine": "workspace:*",
    "yaml": "2.9.1"
  }
}
```

Run: `pnpm install`
Expected: links `@dndm/engine`, installs `yaml`.

- [ ] **Step 2: Write the failing test**

`packages/pack-loader/test/loader.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    expect(repoRoot()).toMatch(/twitch-dndm$/);
    expect(listPackDirs()).toEqual([join(repoRoot(), 'packs', 'starter')]);
  });

  it('loads YAML channel files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ch-'));
    writeFileSync(join(dir, 'c.yaml'), 'packs: [starter]\nsettings:\n  party-cap: 3\n');
    expect(loadChannel(join(dir, 'c.yaml'))).toEqual({ packs: ['starter'], settings: { 'party-cap': 3 } });
  });
});
```

Note: `listPackDirs()` expects the starter pack, which Task 2 creates. That one assertion fails until then.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run packages/pack-loader`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`packages/pack-loader/src/index.ts`:
```ts
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ContentSource, PackBundle, PackDefinition, PackManifest } from '@dndm/engine';
import { parseAllDocuments, parse as parseYaml } from 'yaml';

export class LoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadError';
  }
}

/** This repository's root (packages/pack-loader/src -> ../../..). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function listPackDirs(root: string = join(repoRoot(), 'packs')): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, 'pack.json')))
    .sort();
}

function isOfficial(dir: string): boolean {
  const packsRoot = realpathSync(join(repoRoot(), 'packs'));
  const real = realpathSync(dir);
  return dirname(real) === packsRoot;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ya?ml$/.test(name)) out.push(full);
  }
}

function readContent(dir: string): ContentSource[] {
  const root = join(dir, 'content');
  if (!existsSync(root)) return [];
  const files: string[] = [];
  walk(root, files);
  const out: ContentSource[] = [];
  for (const file of files.sort()) {
    const rel = relative(dir, file).split(sep).join('/');
    const docs = parseAllDocuments(readFileSync(file, 'utf8'), { prettyErrors: true });
    let index = 0;
    for (const doc of docs) {
      if (doc.errors.length) {
        const e = doc.errors[0]!;
        const line = e.linePos?.[0]?.line;
        throw new LoadError(`${rel}${line ? ` (line ${line})` : ''}: ${e.message}`);
      }
      const value = doc.toJS();
      if (value === null || value === undefined) continue;
      out.push({ file: rel, index: index++, doc: value });
    }
  }
  return out;
}

export async function loadPack(dir: string): Promise<PackBundle> {
  const manifestPath = join(dir, 'pack.json');
  let manifest: PackManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackManifest;
  } catch (e) {
    throw new LoadError(`${manifestPath}: can't read pack.json (${(e as Error).message})`);
  }
  manifest.depends ??= {};
  const official = isOfficial(dir);
  const content = readContent(dir);
  const entry = join(dir, 'src', 'index.ts');
  const hasCode = existsSync(entry);
  const bundle: PackBundle = { manifest, official, content, ...(hasCode ? { hasCode } : {}) };
  if (hasCode && official) {
    const mod = (await import(pathToFileURL(entry).href)) as { default?: PackDefinition };
    if (!mod.default || typeof mod.default.register !== 'function') {
      throw new LoadError(`${entry}: the default export must be definePack({ register(api) { ... } })`);
    }
    bundle.register = mod.default.register;
  }
  return bundle;
}

export async function loadPacks(dirs: string[]): Promise<PackBundle[]> {
  const out: PackBundle[] = [];
  for (const dir of dirs) out.push(await loadPack(dir));
  return out;
}

export function loadChannel(file: string): unknown {
  try {
    return parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new LoadError(`${file}: ${(e as Error).message}`);
  }
}
```

If `yaml`'s error object exposes the line differently in 2.9.1, adjust the `line` lookup so the message contains `line N`; the test pins that wording.

- [ ] **Step 5: Run to verify (all but the starter-dependent assertion)**

Run: `pnpm vitest run packages/pack-loader -t "loadPack|YAML channel"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/pack-loader pnpm-lock.yaml
git commit -m "feat(pack-loader): load packs and channel files from disk"
```

---

### Task 2: Starter pack content, manifest, art and default channel

**Files:**
- Create: `packs/starter/package.json`, `packs/starter/pack.json`
- Create: every file under `packs/starter/content/` and `packs/starter/art/icons/`
- Create: `channels/default.yaml`
- Create (stub, filled in Task 3): `packs/starter/src/index.ts`

**Interfaces:**
- Produces: the content listed in spec §9, with these IDs (all `starter:`):
  - stats `attack`, `defense`, `healing`, `crit-chance`, `crit-multiplier`; slots `weapon`, `armor`
  - classes `fighter`, `tank`, `healer`
  - abilities `attack`, `power-strike`, `guard`, `heal`, `revive`, `cure`, `drink-potion`, `smelling-salts`, `club-swing`, `yawn`, `crushing-blow`
  - items `sword`, `shield`, `staff`, `leather-armor`, `health-potion`, `smelling-salts`
  - monsters `slime`, `goblin-king`, `dozing-ogre`; encounter `wandering-merchant`; adventure `the-cave`
- Plugin IDs used by the content (implemented in Task 3): effects `damage`, `heal`, `revive`, `apply-status`, `remove-status`, `knock-out`; statuses `drowsy`, `guarding`; targeting `self`, `enemy`, `ally`, `knocked-out-ally`, `random-enemies`; behavior `weighted`; kinds `story`, `vote`, `treasure`, `trap`, `shop`.

- [ ] **Step 1: Package and manifest**

`packs/starter/package.json`:
```json
{
  "name": "@dndm/pack-starter",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": { "@dndm/engine": "workspace:*" },
  "devDependencies": { "@dndm/pack-loader": "workspace:*" }
}
```

`packs/starter/pack.json`:
```json
{
  "id": "starter",
  "version": "1.0.0",
  "name": "Starter Pack",
  "license": "Same as the engine",
  "depends": {}
}
```

`packs/starter/src/index.ts` (stub; Task 3 replaces it):
```ts
import { definePack } from '@dndm/engine';

export default definePack({ register() {} });
```

Run: `pnpm install`

- [ ] **Step 2: Stats and slots**

`packs/starter/content/stats.yaml`:
```yaml
stat: attack
name: Attack
default: 5
per-level: 1
---
stat: defense
name: Defense
default: 0
---
stat: healing
name: Healing
default: 10
---
stat: crit-chance
name: Crit Chance
default: 5
---
stat: crit-multiplier
name: Crit Multiplier
default: 2
```

`packs/starter/content/slots.yaml`:
```yaml
slot: weapon
name: Weapon
---
slot: armor
name: Armor
```

- [ ] **Step 3: Classes**

`packs/starter/content/classes.yaml`:
```yaml
class: fighter
name: Fighter
description: Hits hard, hits twice.
icon: art/icons/sword.svg
stats: { attack: 5 }
abilities: [attack, power-strike]
---
class: tank
name: Tank
description: Takes the hits so the party doesn't have to.
icon: art/icons/shield.svg
stats: { hp: 60, defense: 10 }
abilities: [attack, guard]
---
class: healer
name: Healer
description: Keeps everyone standing.
icon: art/icons/staff.svg
stats: { hp: -10, attack: -1, healing: 20 }
abilities: [attack, heal, revive, cure]
```

- [ ] **Step 4: Abilities**

`packs/starter/content/abilities.yaml`:
```yaml
ability: attack
name: Attack
description: A basic hit.
cooldown: 10s
target: enemy
steps:
  - damage: { power: "attack * random(1.0, 1.2)" }
---
ability: power-strike
name: Power Strike
description: Strike, then strike again harder.
cooldown: 45s
target: enemy
steps:
  - damage: { power: "attack * random(1.0, 1.2)" }
  - damage: { power: "1.5 * attack * random(1.0, 1.2)" }
---
ability: guard
name: Guard
description: Halve the damage you take and draw the monster's attacks for 8 seconds.
cooldown: 30s
target: self
steps:
  - apply-status: { status: guarding, duration: 8s, reduction: 50, priority: 1 }
---
ability: heal
name: Heal
description: Heal an ally (or yourself).
cooldown: 15s
target: ally
steps:
  - heal: { amount: healing }
---
ability: revive
name: Revive
description: Bring a knocked-out ally back with 30% HP.
cooldown: 60s
target: knocked-out-ally
steps:
  - revive: { hp: 30% }
---
ability: cure
name: Cure
description: Wake an ally from drowsiness.
cooldown: 20s
target: ally
steps:
  - remove-status: { status: drowsy }
---
ability: drink-potion
name: Drink Potion
description: Heal yourself for 40.
cooldown: 5s
when: anytime
target: self
steps:
  - heal: { amount: 40 }
---
ability: smelling-salts
name: Smelling Salts
description: Shake off drowsiness.
cooldown: 5s
when: anytime
target: self
steps:
  - remove-status: { status: drowsy }
---
ability: club-swing
name: Club Swing
description: A heavy swing.
cooldown: 0s
target: random-enemies
steps:
  - damage: { power: attack }
---
ability: yawn
name: Yawn
description: A yawn so big it's catching. Drowsy for 30 seconds.
cooldown: 0s
target: random-enemies
steps:
  - apply-status: { status: drowsy, duration: 30s, multiplier: 1.5 }
---
ability: crushing-blow
name: Crushing Blow
description: A brutal hit that can knock someone out cold.
cooldown: 0s
target: random-enemies
steps:
  - damage: { power: 1.5 * attack }
  - knock-out: { chance: 0.1 }
```

- [ ] **Step 5: Items, monsters, encounter**

`packs/starter/content/items.yaml`:
```yaml
item: sword
name: Sword
slot: weapon
grants-class: fighter
icon: art/icons/sword.svg
---
item: shield
name: Shield
slot: weapon
grants-class: tank
icon: art/icons/shield.svg
---
item: staff
name: Staff
slot: weapon
grants-class: healer
icon: art/icons/staff.svg
---
item: leather-armor
name: Leather Armor
slot: armor
stats: { defense: 5 }
price: 40
---
item: health-potion
name: Health Potion
use: drink-potion
price: 15
---
item: smelling-salts
name: Smelling Salts
use: smelling-salts
price: 10
```

`packs/starter/content/monsters.yaml`:
```yaml
monster: slime
name: Slime
hp: 80
stats: { attack: 6, defense: 0, crit-chance: 0 }
abilities: [club-swing]
behavior: { weighted: { abilities: { club-swing: 1 }, targets-per: 5 } }
interval: 15s
rewards: { xp: 20, gold: 5 }
drops: [{ item: health-potion, chance: 0.1 }]
---
monster: goblin-king
name: Goblin King
tags: [goblin]
hp: 400
stats: { attack: 12, defense: 10, crit-chance: 0 }
abilities: [club-swing, yawn]
behavior: { weighted: { abilities: { club-swing: 3, yawn: 1 }, targets-per: 5 } }
interval: 20s
rewards: { xp: 60, gold: 25 }
drops: [{ item: health-potion, chance: 0.2 }]
---
monster: dozing-ogre
name: Dozing Ogre
hp: 600
stats: { attack: 18, defense: 5, crit-chance: 0 }
abilities: [club-swing, yawn, crushing-blow]
behavior: { weighted: { abilities: { club-swing: 2, yawn: 2, crushing-blow: 1 }, targets-per: 5 } }
interval: 25s
rewards: { xp: 120, gold: 50 }
drops: [{ item: leather-armor, chance: 0.15 }]
```

`packs/starter/content/encounters.yaml`:
```yaml
encounter: wandering-merchant
name: Wandering Merchant
shop:
  stock:
    - { item: health-potion, price: 15 }
    - { item: smelling-salts, price: 10 }
    - { item: leather-armor, price: 40 }
  time: 2m
```

- [ ] **Step 6: The sample adventure**

`packs/starter/content/adventures/the-cave.yaml`:
```yaml
adventure: the-cave
name: The Cave
description: A short trip into a goblin cave. Uses every starter encounter kind.
start: entrance
nodes:
  entrance:
    story:
      title: The Cave
      text: A cold wind blows from the cave mouth. Something inside is snoring.
      show-for: 10s
    next: fork
  fork:
    vote:
      prompt: Two tunnels. Which way?
      choices: { left: The left tunnel (snoring), right: The right tunnel (lantern light) }
      time: 30s
    next: { left: goblin-fight, right: merchant }
  goblin-fight:
    fight: goblin-king
    next: { won: trap, default: rest }
  merchant:
    use: wandering-merchant
    next: trap
  trap:
    trap:
      prompt: A tripwire glints in the torchlight. Dodge!
      time: 20s
      taps: 50%
      penalty:
        target: non-responders
        steps:
          - damage: { power: 15 }
    next: treasure
  treasure:
    treasure: { gold: 25, heal: 50%, time: 30s }
  rest:
    story:
      text: You limp back to camp to lick your wounds.
```

- [ ] **Step 7: Class icons (simple vector shapes, no AI art)**

`packs/starter/art/icons/sword.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M44 6 L58 6 L58 20 L26 52 L12 38 Z"/>
  <path d="M10 40 L24 54"/>
  <path d="M17 47 L6 58"/>
</svg>
```

`packs/starter/art/icons/shield.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round">
  <path d="M32 6 L54 14 L54 30 C54 44 44 54 32 58 C20 54 10 44 10 30 L10 14 Z"/>
  <path d="M32 6 L32 58"/>
</svg>
```

`packs/starter/art/icons/staff.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round">
  <circle cx="40" cy="16" r="8"/>
  <path d="M34 22 L10 58"/>
</svg>
```

- [ ] **Step 8: Default channel**

`channels/default.yaml`:
```yaml
# The CLI's default channel (spec §7.5). Enables the starter pack.
packs: [starter]
settings:
  class-slot: starter:weapon
  starting-items: [starter:sword, starter:shield, starter:staff]
```

- [ ] **Step 9: Check the YAML parses**

Run: `pnpm vitest run packages/pack-loader`
Expected: PASS (now including `listPackDirs`). Validation against the plugins happens in Task 3; the stub registers none, so don't call `createEngine` yet.

- [ ] **Step 10: Commit**

```bash
git add packs/starter channels pnpm-lock.yaml
git commit -m "feat(starter): content, manifest, icons and default channel"
```

---

### Task 3: Starter plugins: effects, statuses, targeting and behavior

**Files:**
- Modify: `packs/starter/src/index.ts`
- Create: `packs/starter/test/helpers.ts`
- Test: `packs/starter/test/classes.test.ts`

**Interfaces:**
- Consumes: `definePack`, `p`, `Rejection`, `Ctx`, `EntityRef` from `@dndm/engine`; `loadPacks`, `loadChannel`, `listPackDirs`, `repoRoot` from `@dndm/pack-loader`.
- Produces:
  - Starter plugins (spec §9.2). Encounter kinds are added in Task 4, in the same file.
  - `packs/starter/test/helpers.ts`: `starterHarness(opts?: { settings?: Record<string, unknown>; overrides?: Record<string, unknown>; seed?: number; extraPacks?: PackBundle[]; packs?: string[]; startingItems?: string[] }): Promise<Harness>`, where `Harness` mirrors the engine harness (`do`, `fail`, `wait`, `at`, `char`, `fight`, `monster`, `view`, `log`, `types`, `open`, `join`, `spawn`, `use`).

- [ ] **Step 1: Write the test helper**

`packs/starter/test/helpers.ts`:
```ts
import { join } from 'node:path';
import { type Command, createEngine, type FightState, type GameEvent, type GameState, type PackBundle } from '@dndm/engine';
import { listPackDirs, loadChannel, loadPacks, repoRoot } from '@dndm/pack-loader';

export interface StarterOpts {
  settings?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  seed?: number;
  extraPacks?: PackBundle[];
  packs?: string[];
  startingItems?: string[];
}

export async function starterHarness(opts: StarterOpts = {}) {
  const bundles = [...(await loadPacks(listPackDirs())), ...(opts.extraPacks ?? [])];
  const base = loadChannel(join(repoRoot(), 'channels', 'default.yaml')) as { packs: string[]; settings: Record<string, unknown> };
  const channel = {
    packs: opts.packs ?? base.packs,
    overrides: opts.overrides ?? {},
    settings: {
      ...base.settings,
      ...(opts.startingItems ? { 'starting-items': opts.startingItems } : {}),
      ...(opts.settings ?? {}),
    },
  };
  const engine = createEngine({ packs: bundles, channel });
  let game: GameState = engine.newGame({ seed: opts.seed ?? 1 });
  let now = 0;
  const log: GameEvent[] = [];
  const h = {
    engine,
    get game() { return game; },
    set game(g: GameState) { game = g; },
    get now() { return now; },
    at(t: number) { now = t; return h; },
    do(cmd: Command): GameEvent[] {
      const r = engine.apply(game, cmd, now);
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      game = r.game;
      log.push(...r.events);
      return r.events;
    },
    fail(cmd: Command) {
      const r = engine.apply(game, cmd, now);
      if (r.ok) throw new Error(`expected ${cmd.type} to be rejected`);
      return r.error;
    },
    wait(ms: number): GameEvent[] {
      now += ms;
      const r = engine.advance(game, now);
      game = r.game;
      log.push(...r.events);
      return r.events;
    },
    char(id: string) { return game.characters[id]!; },
    fight() { return game.session!.encounter as FightState; },
    monster() { return (game.session!.encounter as FightState).monsters[0]!; },
    view(id: string | null) { return engine.view(game, id, now); },
    log,
    types(events: GameEvent[] = log) { return events.map((e) => e.type); },
    open() { return h.do({ type: 'openSession' }); },
    join(id: string, pick: string = 'starter:sword') {
      return h.do({ type: 'join', character: id, name: id[0]!.toUpperCase() + id.slice(1), pick });
    },
    spawn(monster = 'starter:slime') { return h.do({ type: 'spawnMonster', monster }); },
    use(id: string, ability: string, chosen?: string) {
      return h.do({ type: 'use', character: id, ability, ...(chosen ? { chosen: { kind: 'character' as const, id: chosen } } : {}) });
    },
  };
  return h;
}

export const me = (id: string) => ({ kind: 'character' as const, id });
```

- [ ] **Step 2: Write the failing test**

`packs/starter/test/classes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { me, starterHarness } from './helpers';

describe('starter classes (spec §9.3)', () => {
  it('fighter, tank and healer have the right stats and HP', async () => {
    const h = await starterHarness();
    h.open();
    h.join('fi', 'starter:sword'); h.join('ta', 'starter:shield'); h.join('he', 'starter:staff');
    expect(h.view('fi').character).toMatchObject({ class: 'starter:fighter', maxHp: 100, stats: { 'starter:attack': 10, 'starter:defense': 0 } });
    expect(h.view('ta').character).toMatchObject({ class: 'starter:tank', maxHp: 160, stats: { 'starter:attack': 5, 'starter:defense': 10 } });
    expect(h.view('he').character).toMatchObject({ class: 'starter:healer', maxHp: 90, stats: { 'starter:attack': 4, 'starter:healing': 30 } });
    expect(h.view('he').abilities.map((a) => a.ability)).toEqual(['starter:attack', 'starter:heal', 'starter:revive', 'starter:cure']);
  });

  it('attack does attack × 1.0–1.2, or double on a crit', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const h = await starterHarness({ seed });
      h.open(); h.join('fi'); h.spawn();
      h.use('fi', 'starter:attack');
      const dmg = h.log.find((e) => e.type === 'core:damaged')!.data.amount as number;
      expect(dmg >= 10 && dmg <= 12 || dmg >= 20 && dmg <= 24).toBe(true);
    }
  });

  it('power strike hits twice', async () => {
    const h = await starterHarness();
    h.open(); h.join('fi'); h.spawn('starter:goblin-king');
    h.use('fi', 'starter:power-strike');
    expect(h.log.filter((e) => e.type === 'core:damaged')).toHaveLength(2);
    expect(h.char('fi').cooldowns['starter:power-strike']).toBe(45000);
  });

  it('guard halves damage and draws the attack; with more targets the tank is hit first and once', async () => {
    const overrides = { 'starter:goblin-king': { behavior: { weighted: { abilities: { 'club-swing': 1 }, 'targets-per': 1 } } } };
    const h = await starterHarness({ overrides });
    h.open(); h.join('ta', 'starter:shield'); h.join('fi');
    h.spawn('starter:goblin-king');
    h.at(15000).use('ta', 'starter:guard');
    h.wait(5000);
    // goblin attack 12 × (1 - 10% defense) = 10.8, × 50% guarding = 5.4 -> 5. targets-per 1 with 2 active -> 2 targets.
    expect(h.char('ta').hp).toBe(155);
    expect(h.char('fi').hp).toBe(88);
    const hits = h.log.filter((e) => e.type === 'core:damaged' && e.at === 20000);
    expect(hits.map((e) => (e.data.target as { id: string }).id)).toEqual(['ta', 'fi']);
  });

  it('heal, revive and cure', async () => {
    const h = await starterHarness();
    h.open(); h.join('he', 'starter:staff'); h.join('fi'); h.spawn('starter:dozing-ogre');
    h.do({ type: 'knockOut', character: 'fi' });
    h.use('he', 'starter:revive', 'fi');
    expect(h.char('fi')).toMatchObject({ knockedOutUntil: null, hp: 30 });
    h.use('he', 'starter:heal', 'fi');
    expect(h.char('fi').hp).toBe(60);
    h.do({ type: 'applyStatus', target: me('fi'), status: 'starter:drowsy', duration: '30s', params: { multiplier: 1.5 } });
    h.use('he', 'starter:cure', 'fi');
    expect(h.char('fi').statuses).toEqual([]);
  });

  it('drowsy makes new cooldowns longer', async () => {
    const h = await starterHarness();
    h.open(); h.join('fi'); h.spawn();
    h.do({ type: 'applyStatus', target: me('fi'), status: 'starter:drowsy', duration: '30s', params: { multiplier: 1.5 } });
    h.use('fi', 'starter:attack');
    expect(h.char('fi').cooldowns['starter:attack']).toBe(15000);
  });

  it('crushing blow can knock out', async () => {
    const overrides = {
      'ability starter:crushing-blow': { steps: [{ 'knock-out': { chance: 1 } }] },
      'starter:dozing-ogre': { behavior: { weighted: { abilities: { 'crushing-blow': 1 }, 'targets-per': 5 } } },
    };
    const h = await starterHarness({ overrides });
    h.open(); h.join('fi'); h.spawn('starter:dozing-ogre');
    h.wait(25000);
    expect(h.char('fi').knockedOutUntil).not.toBeNull();
  });

  it('potions and smelling salts work outside fights', async () => {
    const h = await starterHarness();
    h.open(); h.join('fi');
    h.do({ type: 'giveItem', target: 'fi', item: 'starter:health-potion' });
    h.do({ type: 'giveItem', target: 'fi', item: 'starter:smelling-salts' });
    h.do({ type: 'applyStatus', target: me('fi'), status: 'starter:drowsy', duration: '30s', params: { multiplier: 1.5 } });
    h.use('fi', 'starter:smelling-salts');
    expect(h.char('fi').statuses).toEqual([]);
    expect(h.char('fi').inventory).toEqual({ 'starter:health-potion': 1 });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run packs/starter/test/classes.test.ts`
Expected: FAIL, `createEngine` throws a `ValidationError` (unknown effects, targeting, statuses, behavior and kinds).

- [ ] **Step 4: Implement the plugins (effects, statuses, targeting, behavior)**

`packs/starter/src/index.ts`:
```ts
import { type Ctx, definePack, type EntityRef, p, type PackApi } from '@dndm/engine';
import { registerKinds } from './kinds';

const alive = (ctx: Ctx, list: EntityRef[]) => list.filter((e) => !ctx.isKnockedOut(e));

function registerCombat(api: PackApi): void {
  api.effect('damage', {
    params: p.object({ power: p.formula() }),
    apply(ctx, { source, target, params }) {
      let amount = ctx.formula(params.power, { source, target });
      if (source && ctx.random() * 100 < ctx.stat(source, 'crit-chance')) {
        amount *= ctx.stat(source, 'crit-multiplier');
        ctx.emit('starter:crit', { source, target }, `${ctx.name(source)} lands a critical hit!`);
      }
      amount *= 1 - Math.min(100, Math.max(0, ctx.stat(target, 'defense'))) / 100;
      ctx.dealDamage(source, target, amount);
    },
  });

  api.effect('heal', {
    params: p.object({ amount: p.formula() }),
    apply(ctx, { source, target, params }) {
      ctx.heal(source, target, ctx.formula(params.amount, { source, target }));
    },
  });

  api.effect('revive', {
    params: p.object({ hp: p.percent() }),
    apply(ctx, { target, params }) {
      if (ctx.isKnockedOut(target)) ctx.revive(target, Math.max(1, Math.round((ctx.maxHp(target) * params.hp) / 100)));
    },
  });

  api.effect('apply-status', {
    params: p.statusApplication(),
    apply(ctx, { source, target, params }) {
      ctx.applyStatus(target, params.status, { duration: params.duration, params: params.params, source });
    },
  });

  api.effect('remove-status', {
    params: p.object({ status: p.ref('status') }),
    apply(ctx, { target, params }) {
      ctx.removeStatus(target, params.status);
    },
  });

  api.effect('knock-out', {
    params: p.object({ chance: p.number({ min: 0, max: 1 }) }),
    apply(ctx, { target, params }) {
      if (ctx.random() < params.chance) ctx.knockOut(target);
    },
  });

  api.status('drowsy', {
    name: 'Drowsy',
    params: p.object({ multiplier: p.number({ min: 0 }) }),
    stacking: 'refresh',
    modify: { cooldown: (ms, { params }) => ms * params.multiplier },
  });

  api.status('guarding', {
    name: 'Guarding',
    params: p.object({ reduction: p.number({ min: 0, max: 100 }), priority: p.number() }),
    stacking: 'refresh',
    modify: {
      damageTaken: (v, { params }) => v * (1 - params.reduction / 100),
      targetPriority: (v, { params }) => v + params.priority,
    },
  });

  api.targeting('self', {
    candidates: (_ctx, { user }) => [user],
    select: (_ctx, { user }) => [user],
  });

  api.targeting('enemy', {
    candidates: (ctx, { user }) => alive(ctx, ctx.enemiesOf(user)),
    select(ctx, { user, chosen }) {
      if (chosen) return [chosen];
      const list = alive(ctx, ctx.enemiesOf(user));
      return list.length ? [list[ctx.randomInt(0, list.length - 1)]!] : [];
    },
  });

  api.targeting('ally', {
    needsChoice: true,
    candidates: (ctx, { user }) => alive(ctx, ctx.alliesOf(user)),
    select: (_ctx, { chosen }) => (chosen ? [chosen] : []),
  });

  api.targeting('knocked-out-ally', {
    needsChoice: true,
    candidates: (ctx, { user }) => ctx.alliesOf(user).filter((e) => ctx.isKnockedOut(e)),
    select: (_ctx, { chosen }) => (chosen ? [chosen] : []),
  });

  api.targeting('random-enemies', {
    params: p.object({ count: p.optional(p.integer({ min: 1 })) }),
    candidates: (ctx, { user }) => alive(ctx, ctx.enemiesOf(user)),
    select(ctx, { user, ability, params, hints }) {
      const n = (hints.count as number | undefined) ?? params.count ?? 1;
      return ctx.byPriority(user, ability, alive(ctx, ctx.enemiesOf(user))).slice(0, n);
    },
  });

  api.behavior('weighted', {
    params: p.object({ abilities: p.refMap('ability', p.number({ min: 0 })), 'targets-per': p.integer({ min: 1 }) }),
    act(ctx, { monster, params }) {
      const entries = Object.entries(params.abilities as Record<string, number>).filter(([, w]) => w > 0);
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      if (total === 0) return;
      let roll = ctx.random() * total;
      const pick = entries.find(([, w]) => (roll -= w) < 0)?.[0] ?? entries[entries.length - 1]![0];
      const count = Math.max(1, Math.ceil(ctx.active().length / params['targets-per']));
      ctx.useAbility(monster, pick, { hints: { count } });
    },
  });
}

export default definePack({
  register(api) {
    registerCombat(api);
    registerKinds(api);
  },
});
```

Create a placeholder `packs/starter/src/kinds.ts` now (Task 4 fills it in):
```ts
import type { PackApi } from '@dndm/engine';

export function registerKinds(_api: PackApi): void {}
```

Because the content's adventure and encounter use kinds from Task 4, `createEngine` still fails validation until Task 4. To run this task's tests on their own, temporarily move `packs/starter/content/encounters.yaml` and `packs/starter/content/adventures/` out of `content/`, run the tests, then move them back before committing. Alternatively implement Task 4 Step 3 first.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run packs/starter/test/classes.test.ts`
Expected: PASS.

Check on the guard test: with `targets-per: 1` and two active members, the behavior asks for 2 targets; `byPriority` puts the guarding tank first, then the fighter. The tank takes 5, the fighter 12 × (1 − 0) = 12, so the fighter ends at 88.

- [ ] **Step 6: Commit**

```bash
git add packs/starter
git commit -m "feat(starter): effects, statuses, targeting and monster behavior"
```

---

### Task 4: Starter encounter kinds

**Files:**
- Modify: `packs/starter/src/kinds.ts`
- Test: `packs/starter/test/kinds.test.ts`

**Interfaces:**
- Produces: encounter kinds `story`, `vote`, `treasure`, `trap`, `shop` (spec §9.6), and custom events `starter:purchased`, `starter:crit`.

- [ ] **Step 1: Write the failing test**

`packs/starter/test/kinds.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { starterHarness } from './helpers';

const start = (encounter: Record<string, unknown>) => ({ type: 'startEncounter' as const, encounter });

describe('story', () => {
  it('shows text and ends after show-for, or when the streamer ends it', async () => {
    const h = await starterHarness();
    h.open(); h.join('al');
    h.do(start({ 'starter:story': { title: 'Hi', text: 'Once upon a time', 'show-for': '5s' } }));
    expect(h.view('al').panel).toEqual({ type: 'story-card', title: 'Hi', text: 'Once upon a time' });
    expect(h.view(null).overlay).toMatchObject({ title: 'Hi', text: 'Once upon a time', 'closes-at': 5000 });
    expect(h.fail({ type: 'respond', character: 'al', input: {} }).code).toBe('rejected');
    h.wait(5000);
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'done' });
    h.do(start({ 'starter:story': { text: 'Waits for the streamer' } }));
    h.wait(600000);
    expect(h.game.session!.encounter).not.toBeNull();
    h.do({ type: 'endEncounter' });
  });
});

describe('vote', () => {
  const vote = { 'starter:vote': { prompt: 'Which way?', choices: { left: 'Left', right: 'Right' }, time: '30s' } };

  it('counts votes, lets members change their vote, picks the most voted', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1'); h.join('a2'); h.join('a3');
    h.do(start(vote));
    h.do({ type: 'respond', character: 'a1', input: { choice: 'left' } });
    h.do({ type: 'respond', character: 'a2', input: { choice: 'left' } });
    h.do({ type: 'respond', character: 'a3', input: { choice: 'right' } });
    h.do({ type: 'respond', character: 'a2', input: { choice: 'right' } });
    expect(h.view('a2').panel).toMatchObject({ type: 'choices', selected: 'right', prompt: 'Which way?' });
    expect(h.view(null).overlay).toMatchObject({ tallies: [{ label: 'Left', count: 1 }, { label: 'Right', count: 2 }] });
    expect(h.fail({ type: 'respond', character: 'a1', input: { choice: 'up' } }).message).toBe("That isn't one of the choices");
    h.wait(30000);
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'right' });
  });

  it('a vote with no votes is a tie among all choices; tie-break first picks the first', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1');
    h.do(start({ 'starter:vote': { prompt: 'P', choices: { x: 'X', y: 'Y' }, time: '5s', 'tie-break': 'first' } }));
    h.wait(5000);
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'x' });
  });

  it('random tie-break always picks one of the tied choices', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const h = await starterHarness({ seed });
      h.open();
      h.do(start(vote));
      h.wait(30000);
      expect(['left', 'right']).toContain(h.log.at(-1)!.data.outcome);
    }
  });

  it('the streamer ending a vote early takes the current leader', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1');
    h.do(start(vote));
    h.do({ type: 'respond', character: 'a1', input: { choice: 'right' } });
    h.do({ type: 'endEncounter' });
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'right' });
  });
});

describe('treasure', () => {
  it('pays and heals those who claimed, once each; knocked-out claimants get no heal', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1'); h.join('a2'); h.join('a3');
    h.do({ type: 'knockOut', character: 'a1' });
    h.do({ type: 'revivePlayer', character: 'a1' });
    h.do({ type: 'knockOut', character: 'a2' });
    h.do(start({ 'starter:treasure': { gold: 10, xp: 5, items: ['starter:health-potion'], heal: '50%', time: '20s' } }));
    h.do({ type: 'respond', character: 'a1', input: {} });
    h.do({ type: 'respond', character: 'a2', input: {} });
    expect(h.fail({ type: 'respond', character: 'a1', input: {} }).message).toBe("You've already claimed this");
    expect(h.view('a1').panel).toMatchObject({ type: 'tap-button', label: 'Claim', tapped: true });
    h.wait(20000);
    expect(h.char('a1')).toMatchObject({ gold: 10, xp: 5, hp: 75, inventory: { 'starter:health-potion': 1 } });
    expect(h.char('a2')).toMatchObject({ gold: 10, hp: 0 });
    expect(h.char('a3').gold).toBe(0);
  });

  it('pays claimants when the streamer ends it early, not when the session closes', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1');
    h.do(start({ 'starter:treasure': { gold: 10, time: '20s' } }));
    h.do({ type: 'respond', character: 'a1', input: {} });
    h.do({ type: 'endEncounter' });
    expect(h.char('a1').gold).toBe(10);
    h.do(start({ 'starter:treasure': { gold: 10, time: '20s' } }));
    h.do({ type: 'respond', character: 'a1', input: {} });
    h.do({ type: 'closeSession' });
    expect(h.char('a1').gold).toBe(10);
  });
});

describe('trap', () => {
  const tapTrap = { 'starter:trap': { prompt: 'Dodge!', time: '10s', taps: '50%', penalty: { target: 'non-responders', steps: [{ damage: { power: 15 } }] } } };

  it('is disarmed when enough members tap', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1'); h.join('a2');
    h.do(start(tapTrap));
    h.do({ type: 'respond', character: 'a1', input: {} });
    expect(h.fail({ type: 'respond', character: 'a1', input: {} }).message).toBe('Already tapped');
    h.wait(10000);
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'disarmed' });
    expect(h.char('a2').hp).toBe(100);
  });

  it('when triggered, hurts only those who did not respond', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1'); h.join('a2'); h.join('a3');
    h.do(start(tapTrap));
    h.do({ type: 'respond', character: 'a1', input: {} });
    h.wait(10000);
    expect(h.log.find((e) => e.type === 'core:encounter-ended')!.data).toMatchObject({ outcome: 'triggered' });
    expect([h.char('a1').hp, h.char('a2').hp, h.char('a3').hp]).toEqual([100, 85, 85]);
  });

  it('answer mode: the most voted choice must be the answer; penalty target all', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1'); h.join('a2');
    h.do(start({ 'starter:trap': {
      prompt: 'Which lever?', time: '10s', answer: 'red', choices: { red: 'Red', blue: 'Blue' },
      penalty: { target: 'all', steps: [{ damage: { power: 10 } }] },
    } }));
    h.do({ type: 'respond', character: 'a1', input: { choice: 'blue' } });
    h.wait(10000);
    expect([h.char('a1').hp, h.char('a2').hp]).toEqual([90, 90]);
  });

  it('the streamer ending a trap counts as disarmed', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1');
    h.do(start(tapTrap));
    h.do({ type: 'endEncounter' });
    expect(h.char('a1').hp).toBe(100);
  });

  it('rejects a trap with both or neither mode, or a missing answer', async () => {
    const h = await starterHarness();
    h.open();
    const bad = (params: Record<string, unknown>) => h.fail(start({ 'starter:trap': { prompt: 'P', time: '5s', penalty: { target: 'all', steps: [] }, ...params } }));
    expect(bad({}).message).toMatch(/needs either taps or answer \+ choices/);
    expect(bad({ taps: '50%', answer: 'x', choices: { x: 'X' } }).message).toMatch(/needs either/);
    expect(bad({ answer: 'z', choices: { x: 'X' } }).message).toMatch(/answer must be one of the choices/);
  });
});

describe('shop', () => {
  const shop = { 'starter:shop': { stock: [{ item: 'starter:health-potion', price: 15 }, { item: 'starter:sword', price: 1 }], time: '1m' } };

  it('sells for gold, with exact gold working and one short refused', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1');
    h.do({ type: 'giveGold', target: 'a1', amount: 15 });
    h.do(start(shop));
    h.do({ type: 'respond', character: 'a1', input: { buy: 'starter:health-potion' } });
    expect(h.char('a1')).toMatchObject({ gold: 0, inventory: { 'starter:health-potion': 1 } });
    expect(h.types()).toContain('starter:purchased');
    const before = structuredClone(h.char('a1'));
    expect(h.fail({ type: 'respond', character: 'a1', input: { buy: 'starter:health-potion' } }).message).toBe('Not enough gold');
    expect(h.char('a1')).toEqual(before);
    expect(h.fail({ type: 'respond', character: 'a1', input: { buy: 'starter:sword' } }).message).toBe('You already have that');
    expect(h.fail({ type: 'respond', character: 'a1', input: { buy: 'starter:staff' } }).message).toBe("That isn't for sale here");
    expect(h.view('a1').panel).toMatchObject({ type: 'shop-list', gold: 0, entries: [{ item: 'starter:health-potion', price: 15, affordable: false }, expect.anything()] });
    h.wait(60000);
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'closed' });
  });

  it('a secret shop has no overlay and only serves members present when it opened', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1');
    h.do(start({ 'starter:shop': { ...shop['starter:shop'], secret: true } }));
    h.join('a2');
    h.do({ type: 'giveGold', target: 'party', amount: 50 });
    expect(h.view(null).overlay).toBeNull();
    expect(h.view('a2').panel).toEqual({ type: 'none' });
    expect(h.fail({ type: 'respond', character: 'a2', input: { buy: 'starter:health-potion' } }).message).toBe("This shop isn't open to you");
    h.do({ type: 'respond', character: 'a1', input: { buy: 'starter:health-potion' } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packs/starter/test/kinds.test.ts`
Expected: FAIL (kinds not registered).

- [ ] **Step 3: Implement `kinds.ts`**

`packs/starter/src/kinds.ts`:
```ts
import { type AmountOrPercent, type Ctx, type EntityRef, p, type PackApi, Rejection, type Step } from '@dndm/engine';

const character = (id: string): EntityRef => ({ kind: 'character', id });
const closes = (at: number | null) => (at === null ? {} : { 'closes-at': at });

function counts(choices: Record<string, string>, votes: Record<string, string>): [string, number][] {
  return Object.keys(choices).map((k) => [k, Object.values(votes).filter((v) => v === k).length]);
}

function leaders(choices: Record<string, string>, votes: Record<string, string>): string[] {
  const c = counts(choices, votes);
  const top = Math.max(...c.map(([, n]) => n));
  return c.filter(([, n]) => n === top).map(([k]) => k);
}

interface VoteState { closesAt: number; votes: Record<string, string> }
interface TreasureState { closesAt: number; claimed: string[] }
interface TrapState { closesAt: number; taps: string[]; votes: Record<string, string> }
interface ShopState { closesAt: number | null; members: string[] }
interface StoryState { endsAt: number | null }

export function registerKinds(api: PackApi): void {
  api.encounterKind<StoryState>('story', {
    name: 'Story',
    params: p.object({
      text: p.string(),
      title: p.optional(p.string()),
      media: p.optional(p.list(p.object({ type: p.enum('image', 'video'), src: p.string() }))),
      'show-for': p.optional(p.duration()),
    }),
    input: p.object({}),
    outcomes: () => ['done'],
    start: (ctx, params) => ({ endsAt: params['show-for'] ? ctx.now + params['show-for'] : null }),
    respond: () => { throw new Rejection('There is nothing to answer here'); },
    wakeAt: (s) => s.endsAt,
    advance(ctx, s) { ctx.endEncounter('done'); return s; },
    endEarly: () => 'done',
    panel: (_s, _v, params) => ({ type: 'story-card', ...(params.title ? { title: params.title } : {}), text: params.text }),
    overlay: (s, params) => ({
      ...(params.title ? { title: params.title } : {}), text: params.text,
      ...(params.media ? { media: params.media } : {}), ...closes(s.endsAt),
    }),
  });

  api.encounterKind<VoteState>('vote', {
    name: 'Vote',
    params: p.object({
      prompt: p.string(),
      choices: p.record(p.string()),
      time: p.duration(),
      'tie-break': p.optional(p.enum('random', 'first'), 'random'),
    }),
    input: p.object({ choice: p.string() }),
    outcomes: (params) => Object.keys(params.choices),
    validate: (params) => (Object.keys(params.choices ?? {}).length === 0 ? ['a vote needs at least one choice'] : []),
    start: (ctx, params) => ({ closesAt: ctx.now + params.time, votes: {} }),
    respond(_ctx, s, ch, input, params) {
      if (!(input.choice in params.choices)) throw new Rejection("That isn't one of the choices");
      return { ...s, votes: { ...s.votes, [ch.id]: input.choice } };
    },
    wakeAt: (s) => s.closesAt,
    advance(ctx, s, params) {
      const tied = leaders(params.choices, s.votes);
      const winner = tied.length === 1 || params['tie-break'] === 'first' ? tied[0]! : tied[ctx.randomInt(0, tied.length - 1)]!;
      ctx.endEncounter(winner);
      return s;
    },
    endEarly: (s, params) => leaders(params.choices, s.votes)[0]!,
    panel: (s, viewer, params) => ({
      type: 'choices', prompt: params.prompt,
      options: Object.entries(params.choices as Record<string, string>).map(([key, label]) => ({ key, label })),
      ...(s.votes[viewer.id] ? { selected: s.votes[viewer.id] } : {}), ...closes(s.closesAt),
    }),
    overlay: (s, params) => ({
      title: params.prompt,
      tallies: counts(params.choices, s.votes).map(([k, count]) => ({ label: params.choices[k], count })),
      ...closes(s.closesAt),
    }),
  });

  api.encounterKind<TreasureState>('treasure', {
    name: 'Treasure',
    params: p.object({
      gold: p.optional(p.integer({ min: 0 }), 0),
      xp: p.optional(p.integer({ min: 0 }), 0),
      items: p.optional(p.list(p.ref('item')), []),
      heal: p.optional(p.amountOrPercent()),
      time: p.duration(),
    }),
    input: p.object({}),
    outcomes: () => ['done'],
    start: (ctx, params) => ({ closesAt: ctx.now + params.time, claimed: [] }),
    respond(_ctx, s, ch) {
      if (s.claimed.includes(ch.id)) throw new Rejection("You've already claimed this");
      return { ...s, claimed: [...s.claimed, ch.id] };
    },
    wakeAt: (s) => s.closesAt,
    advance(ctx, s) { ctx.endEncounter('done'); return s; },
    endEarly: () => 'done',
    onEnd(ctx, s, outcome, params) {
      if (outcome !== 'done') return;
      const party = new Set(ctx.party().map((e) => e.id));
      for (const id of s.claimed) {
        if (!party.has(id)) continue;
        const ch = character(id);
        ctx.giveRewards(ch, { xp: params.xp, gold: params.gold, items: params.items });
        const heal = params.heal as AmountOrPercent | undefined;
        if (heal && !ctx.isKnockedOut(ch)) {
          ctx.heal(null, ch, 'percent' in heal ? (ctx.maxHp(ch) * heal.percent) / 100 : heal.amount);
        }
      }
    },
    panel: (s, viewer) => ({ type: 'tap-button', label: 'Claim', tapped: s.claimed.includes(viewer.id), ...closes(s.closesAt) }),
    overlay: (s, params) => ({
      title: 'Treasure!',
      text: [params.gold ? `${params.gold} gold` : '', params.xp ? `${params.xp} XP` : '', ...(params.items as string[])].filter(Boolean).join(', '),
      tallies: [{ label: 'Claimed', count: s.claimed.length }], ...closes(s.closesAt),
    }),
  });

  api.encounterKind<TrapState>('trap', {
    name: 'Trap',
    params: p.object({
      prompt: p.string(),
      time: p.duration(),
      taps: p.optional(p.percent()),
      answer: p.optional(p.string()),
      choices: p.optional(p.record(p.string())),
      penalty: p.object({ target: p.enum('all', 'non-responders'), steps: p.steps({ noSource: true }) }),
    }),
    input: p.object({ choice: p.optional(p.string()) }),
    outcomes: () => ['disarmed', 'triggered'],
    validate(params) {
      const tapMode = params.taps !== undefined;
      const answerMode = params.answer !== undefined || params.choices !== undefined;
      if (tapMode === answerMode) return ['a trap needs either taps or answer + choices'];
      if (answerMode && !(params.choices && params.answer && params.answer in params.choices)) return ['answer must be one of the choices'];
      return [];
    },
    start: (ctx, params) => ({ closesAt: ctx.now + params.time, taps: [], votes: {} }),
    respond(_ctx, s, ch, input, params) {
      if (params.taps !== undefined) {
        if (s.taps.includes(ch.id)) throw new Rejection('Already tapped');
        return { ...s, taps: [...s.taps, ch.id] };
      }
      if (!input.choice || !(input.choice in params.choices)) throw new Rejection("That isn't one of the choices");
      return { ...s, votes: { ...s.votes, [ch.id]: input.choice } };
    },
    wakeAt: (s) => s.closesAt,
    advance(ctx, s, params) {
      const party = ctx.party().map((e) => e.id);
      let disarmed: boolean;
      if (params.taps !== undefined) {
        const tapped = s.taps.filter((id) => party.includes(id)).length;
        disarmed = party.length === 0 || (tapped / party.length) * 100 >= params.taps;
      } else {
        const tied = leaders(params.choices, s.votes);
        disarmed = tied.length === 1 && tied[0] === params.answer;
      }
      ctx.endEncounter(disarmed ? 'disarmed' : 'triggered');
      return s;
    },
    endEarly: () => 'disarmed',
    onEnd(ctx: Ctx, s, outcome, params) {
      if (outcome !== 'triggered') return;
      const responded = new Set([...s.taps, ...Object.keys(s.votes)]);
      const party = ctx.party();
      const targets = params.penalty.target === 'all' ? party : party.filter((e) => !responded.has(e.id));
      ctx.runSteps(params.penalty.steps as Step[], { source: null, targets });
    },
    panel: (s, viewer, params) =>
      params.taps !== undefined
        ? { type: 'tap-button', label: params.prompt, tapped: s.taps.includes(viewer.id), ...closes(s.closesAt) }
        : {
          type: 'choices', prompt: params.prompt,
          options: Object.entries(params.choices as Record<string, string>).map(([key, label]) => ({ key, label })),
          ...(s.votes[viewer.id] ? { selected: s.votes[viewer.id] } : {}), ...closes(s.closesAt),
        },
    overlay: (s, params) => ({ title: 'Trap!', text: params.prompt, ...closes(s.closesAt) }),
  });

  api.encounterKind<ShopState>('shop', {
    name: 'Shop',
    params: p.object({
      stock: p.list(p.object({ item: p.ref('item'), price: p.integer({ min: 0 }) })),
      time: p.optional(p.duration()),
      secret: p.optional(p.boolean(), false),
    }),
    input: p.object({ buy: p.ref('item') }),
    outcomes: () => ['closed'],
    start: (ctx, params) => ({ closesAt: params.time ? ctx.now + params.time : null, members: ctx.party().map((e) => e.id) }),
    respond(ctx, s, ch, input, params) {
      if (params.secret && !s.members.includes(ch.id)) throw new Rejection("This shop isn't open to you");
      const entry = (params.stock as { item: string; price: number }[]).find((x) => x.item === input.buy);
      if (!entry) throw new Rejection("That isn't for sale here");
      if (ctx.startingItems().includes(input.buy)) throw new Rejection('You already have that');
      ctx.spendGold(ch, entry.price);
      ctx.giveItem(ch, input.buy, 1);
      ctx.emit('starter:purchased', { character: ch.id, item: input.buy, price: entry.price }, `${ctx.name(ch)} buys ${input.buy}`);
      return s;
    },
    wakeAt: (s) => s.closesAt,
    advance(ctx, s) { ctx.endEncounter('closed'); return s; },
    endEarly: () => 'closed',
    panel(s, viewer, params) {
      if (params.secret && !s.members.includes(viewer.id)) return { type: 'none' };
      return {
        type: 'shop-list', gold: viewer.gold,
        entries: (params.stock as { item: string; price: number }[]).map((e) => ({ item: e.item, price: e.price, affordable: viewer.gold >= e.price })),
        ...closes(s.closesAt),
      };
    },
    overlay: (s, params) => (params.secret ? null : {
      title: 'A shop opens',
      list: (params.stock as { item: string; price: number }[]).map((e) => `${e.item}: ${e.price} gold`),
      ...closes(s.closesAt),
    }),
  });
}
```

`api.encounterKind<StoryState>(...)` needs `PackApi.encounterKind` to be generic. In `packages/engine/src/pack.ts`, change its signature to:
```ts
  encounterKind<S = any>(id: string, def: EncounterKindDef<S>): void;
```
(this is the one engine edit in this plan; it changes types only). Also export `AmountOrPercent` and `Step` from `@dndm/engine` if not already (Plan A Task 11 exports them).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packs/starter`
Expected: PASS (`classes` and `kinds`).

The `story` test's respond-rejection expects code `rejected`, which is `Rejection`'s default code.

- [ ] **Step 5: Commit**

```bash
git add packs/starter packages/engine/src/pack.ts
git commit -m "feat(starter): story, vote, treasure, trap and shop encounter kinds"
```

---

### Task 5: The sample adventure on both branches (success criterion 1)

**Files:**
- Test: `packs/starter/test/adventure.test.ts`

- [ ] **Step 1: Write the test**

`packs/starter/test/adventure.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { starterHarness } from './helpers';

async function party() {
  const h = await starterHarness({ seed: 3 });
  h.open();
  h.join('fi', 'starter:sword'); h.join('ta', 'starter:shield'); h.join('he', 'starter:staff');
  h.do({ type: 'startAdventure', adventure: 'starter:the-cave' });
  h.do({ type: 'go' });          // entrance story
  h.wait(10000);
  h.do({ type: 'go' });          // fork vote
  return h;
}

function lined(h: Awaited<ReturnType<typeof party>>) {
  return h.game.session!.adventure?.lined ?? null;
}

describe('the-cave', () => {
  it('left branch: story, vote, fight won, trap, treasure', async () => {
    const h = await party();
    for (const id of ['fi', 'ta', 'he']) h.do({ type: 'respond', character: id, input: { choice: 'left' } });
    h.wait(30000);
    expect(lined(h)).toBe('goblin-fight');
    h.do({ type: 'go' });
    for (const id of ['fi', 'ta', 'he']) h.use(id, 'starter:attack');
    h.do({ type: 'endEncounter', outcome: 'won' });
    expect(lined(h)).toBe('trap');
    h.do({ type: 'go' });
    for (const id of ['fi', 'ta']) h.do({ type: 'respond', character: id, input: {} });
    h.wait(20000);
    expect(lined(h)).toBe('treasure');
    h.do({ type: 'go' });
    for (const id of ['fi', 'ta', 'he']) h.do({ type: 'respond', character: id, input: {} });
    h.wait(30000);
    expect(h.game.session!.adventure).toBeNull();
    expect(h.types()).toContain('core:adventure-finished');
    expect(h.char('fi').gold).toBeGreaterThanOrEqual(25 + 25);
    h.do({ type: 'closeSession' });
  });

  it('right branch: story, vote, shop purchase, trap, treasure', async () => {
    const h = await party();
    for (const id of ['fi', 'ta', 'he']) h.do({ type: 'respond', character: id, input: { choice: 'right' } });
    h.wait(30000);
    expect(lined(h)).toBe('merchant');
    h.do({ type: 'go' });
    h.do({ type: 'giveGold', target: 'fi', amount: 15 });
    h.do({ type: 'respond', character: 'fi', input: { buy: 'starter:health-potion' } });
    expect(h.char('fi').inventory).toEqual({ 'starter:health-potion': 1 });
    h.do({ type: 'endEncounter' });
    expect(lined(h)).toBe('trap');
    h.do({ type: 'go' });
    h.wait(20000);
    expect(h.char('he').hp).toBe(75);
    h.do({ type: 'go' });
    h.do({ type: 'respond', character: 'he', input: {} });
    h.wait(30000);
    expect(h.char('he').hp).toBe(90);
    expect(h.game.session!.adventure).toBeNull();
    h.do({ type: 'closeSession' });
  });

  it('ending the fight without a win goes to rest', async () => {
    const h = await party();
    h.do({ type: 'respond', character: 'fi', input: { choice: 'left' } });
    h.wait(30000);
    h.do({ type: 'go' });
    h.do({ type: 'endEncounter' });
    expect(lined(h)).toBe('rest');
  });
});
```

Check on the right branch: nobody taps the trap, so everyone takes 15 × (1 − defense%). The healer (defense 0) goes 90 → 75. The treasure heals 50% of max (45) only for those who claimed: the healer claims and goes back to 90 (capped at max).

- [ ] **Step 2: Run**

Run: `pnpm vitest run packs/starter/test/adventure.test.ts`
Expected: PASS. If the left-branch fight is won earlier by the attacks (it isn't; the Goblin King has 400 HP), `endEncounter` would fail with `no-encounter`.

- [ ] **Step 3: Commit**

```bash
git add packs/starter/test/adventure.test.ts
git commit -m "test(starter): the sample adventure down both branches"
```

---

### Task 6: The second pack (success criterion 3) and no special treatment (criterion 6)

**Files:**
- Test: `packs/starter/test/mage.test.ts`, `packs/starter/test/no-special-treatment.test.ts`

- [ ] **Step 1: Write the Mage test**

`packs/starter/test/mage.test.ts`:
```ts
import { definePack, p, type PackBundle, Rejection } from '@dndm/engine';
import { describe, expect, it } from 'vitest';
import { starterHarness } from './helpers';

/** A pack outside the starter, written only against the public API. */
const mage: PackBundle = {
  manifest: { id: 'mage', version: '1.0.0', name: 'Mage', depends: { starter: '^1.0.0' } },
  official: true,
  content: [
    { stat: 'mana', name: 'Mana', default: 20 },
    { class: 'mage', name: 'Mage', stats: { 'starter:defense': 5 }, abilities: ['starter:attack', 'fireball'], passives: [{ thorns: { amount: 2 } }] },
    { item: 'wand', name: 'Wand', slot: 'starter:weapon', 'grants-class': 'mage' },
    { ability: 'fireball', name: 'Fireball', cooldown: '5s', target: 'starter:enemy', steps: [{ fireball: { power: '2 * starter:attack', cost: 10 } }] },
  ].map((doc, index) => ({ file: 'mage.yaml', index, doc })),
  register: definePack({
    register(api) {
      api.effect('fireball', {
        params: p.object({ power: p.formula(), cost: p.integer({ min: 0 }) }),
        apply(ctx, { source, target, params }) {
          if (!source) return;
          const store = ctx.store(source) as { mana?: number };
          const mana = store.mana ?? ctx.stat(source, 'mana');
          if (mana < params.cost) throw new Rejection('Not enough mana');
          ctx.setStore(source, { mana: mana - params.cost });
          ctx.dealDamage(source, target, ctx.formula(params.power, { source, target }), { tags: ['fire'] });
          ctx.applyStatus(target, 'burning', { duration: 6000, params: { per: 3 }, source });
        },
      });
      api.status('burning', {
        name: 'Burning',
        params: p.object({ per: p.integer({ min: 0 }) }),
        tick: { every: '2s', run: (ctx, { holder, params, source }) => { ctx.dealDamage(source, holder, params.per, { tags: ['fire'] }); } },
      });
      api.passive('thorns', {
        name: 'Thorns',
        params: p.object({ amount: p.integer({ min: 0 }) }),
        react: {
          damaged: ({ ctx, holder, role, event, params }) => {
            if (role === 'target' && event.source && event.source.kind !== holder.kind) ctx.dealDamage(holder, event.source, params.amount);
          },
        },
      });
    },
  }).register,
};

describe('a second pack alongside the starter (success criterion 3)', () => {
  it('adds a stat, status, effect, passive and class with no engine change', async () => {
    const h = await starterHarness({
      extraPacks: [mage], packs: ['starter', 'mage'],
      startingItems: ['starter:sword', 'starter:shield', 'starter:staff', 'mage:wand'],
      overrides: { 'starter:goblin-king': { behavior: { weighted: { abilities: { 'club-swing': 1 }, 'targets-per': 5 } } } },
    });
    h.open();
    h.join('mo', 'mage:wand');
    expect(h.view('mo').character).toMatchObject({ class: 'mage:mage', stats: { 'mage:mana': 20, 'starter:defense': 5 } });
    h.spawn('starter:goblin-king');

    // New effect + new status: 20 mana -> 10, burning applied.
    h.use('mo', 'mage:fireball');
    expect(h.monster().statuses.map((s) => s.status)).toEqual(['mage:burning']);
    // Second cast after the cooldown: 10 -> 0. A third is refused by the effect itself.
    h.at(5000).use('mo', 'mage:fireball');
    expect(h.fail({ type: 'use', character: 'mo', ability: 'mage:fireball' }).code).toBe('on-cooldown');
    h.at(10000);
    expect(h.fail({ type: 'use', character: 'mo', ability: 'mage:fireball' })).toEqual({ code: 'rejected', message: 'Not enough mana' });

    // Burning ticks every 2s for 3 (from the caster).
    const ticks = h.wait(10000).filter((e) => e.type === 'core:damaged' && e.data.amount === 3);
    expect(ticks.length).toBeGreaterThan(0);

    // New passive: the goblin's swing at 20s is answered by thorns for 2.
    h.wait(1000);
    const thorns = h.log.filter((e) => e.type === 'core:damaged' && (e.data.target as { kind: string }).kind === 'monster' && e.data.amount === 2);
    expect(thorns).toHaveLength(1);
    expect(thorns[0]!.at).toBe(20000);
  });
});
```

What it proves:
- a new stat (`mana`, read through `ctx.stat` and tracked in `ctx.store`)
- a new effect that can refuse with a `Rejection`
- a new status with a `tick`
- a new passive that reacts to damage
- a new class granted by an item in the starter's weapon slot

All of this works with no engine change.

- [ ] **Step 2: Write the no-special-treatment test**

`packs/starter/test/no-special-treatment.test.ts`:
```ts
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
```

- [ ] **Step 3: Run**

Run: `pnpm vitest run packs/starter`
Expected: PASS. If the no-special-treatment test lists hits, rename those literals in the engine or its test packs (for example a test-pack ID that happens to equal a starter ID); never weaken the test.

- [ ] **Step 4: Run everything and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

```bash
git add packs/starter
git commit -m "test(starter): second pack (mage) and no-special-treatment check"
```

---

## Plan C self-review notes

- Spec coverage: §5.1 pack shape, official packs and the loader (Task 1), §8 content and §9.1–9.5 starter content (Tasks 2–3), §9.6 encounter kinds (Task 4), §9.7 and success criterion 1 at the engine level (Task 5), success criteria 3 and 6 (Task 6), §12 art (Task 2). Success criterion 1 through `dndm play` itself is exercised in Plan D.
- The engine edit here is type-only (`encounterKind` generic), allowed by rule 1 because it adds no special case.
