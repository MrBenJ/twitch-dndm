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
