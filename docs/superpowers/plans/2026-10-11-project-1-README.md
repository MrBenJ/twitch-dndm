# Project 1 implementation plans: index

Project 1 (engine, packs, starter pack, CLI) is split into four plans. Run them
in order: each depends on the ones before it, and each ends with working,
tested software.

| Plan | File | Delivers |
|---|---|---|
| A | `2026-10-11-p1a-foundation.md` | Workspace, units, RNG, IDs, formulas, param schemas, content schemas, pack API types, channel config, registry and validation, `createEngine` + `describe()` |
| B | `2026-10-11-p1b-game-loop.md` | Game state, runtime and `ctx`, hooks, operations, sessions, gear, abilities, fights, knockouts, rewards, time, encounter kinds, adventures, streamer commands, `apply`/`advance`/`resume`/`adopt`/`view` |
| C | `2026-10-11-p1c-loader-and-starter.md` | `packages/pack-loader`, `packs/starter`, `channels/default.yaml`, starter-pack tests, the no-special-treatment test, the second-pack (Mage) test |
| D | `2026-10-11-p1d-cli.md` | `apps/cli` (`dndm validate/play/run/sim`), golden replays, determinism test, CI workflow |

**Spec:** `docs/superpowers/specs/2026-10-11-engine-and-packs-design.md` (rev 6).

## Decisions the plans make that the spec leaves open

These are implementation choices, flagged so the owner can overrule them:

1. **`engine.view(game, characterId, now)`**: a read-only call that returns a viewer's ability options (with valid targets), the current panel widget and the overlay scene. Spec §6.8 and §13 need this (screens and sim bots must know valid targets), but §11.1 doesn't list it.
2. **`apply` advances time first.** `engine.apply(game, cmd, now)` processes every timer due up to `now` before running the command, so callers can't act on stale state. Events from that catch-up are returned with the command's events.
3. **Two optional hooks on encounter kinds:** `validate(params)` (extra checks such as "a trap needs either `taps` or `answer` + `choices`") and `onEnd(ctx, state, outcome)` (runs when the encounter ends by any route, so a treasure ended early by the streamer still pays the people who claimed it, and a trap's penalty runs once).
4. **Three extra `ctx` helpers:** `runSteps(steps, { source, targets })` (traps run penalty steps), `startingItems()` (shops refuse to sell starting items) and `gold(character)`.
5. **Override keys:** `starter:power-strike` works when the ID names exactly one piece of content. When the same ID exists in two types (the stat `starter:attack` and the ability `starter:attack`), the key must name the type: `ability starter:attack`.
6. **Streamer `revivePlayer` / `reviveAll`** restore `knockoutReturnHp` of max HP, the same as a knockout ending naturally.
7. **Formulas never produce infinity or NaN.** Division by zero gives 0.
8. **The "lint rule" for determinism** is a small script plus a test (no ESLint dependency).
9. **A plugin error during a time step** (a monster turn, a status tick, an encounter waking up) rolls back just that step, emits `core:plugin-error`, and moves that timer on: the monster skips a turn, the tick is skipped, a broken encounter is force-ended. A live stream never gets stuck on the same failing timer.
10. **`view()` includes the character's stats**, so screens (and tests) can show them without reaching into engine internals.
11. **A vote needs at least one choice; a trap needs either `taps` or `answer` + `choices`** (checked when content loads and when the streamer starts one inline).

## Running order notes

Plan B's tasks interlock: some tests written in Tasks 3–4 use commands finished in Tasks 5 and 7. Each task says which of its tests can run immediately. The whole engine suite must be green at the end of Task 7, and stay green from then on.
