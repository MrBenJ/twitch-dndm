import { createEngine } from '../../src';
import type { Command } from '../../src/commands';
import type { GameEvent } from '../../src/events';
import type { PackApi, PackBundle } from '../../src/pack';
import type { FightState, GameState } from '../../src/state';
import { tpBundle, tpChannel } from './tp-pack';

export function withPlugins(bundle: PackBundle, extra: (api: PackApi) => void): PackBundle {
  const inner = bundle.register!;
  return { ...bundle, register: (api) => { inner(api); extra(api); } };
}

export interface HarnessOpts {
  settings?: Record<string, unknown>;
  content?: unknown[];
  plugins?: (api: PackApi) => void;
  seed?: number;
  channel?: Record<string, unknown>;
}

export function harness(opts: HarnessOpts = {}) {
  let bundle = tpBundle(opts.content ?? []);
  if (opts.plugins) bundle = withPlugins(bundle, opts.plugins);
  const engine = createEngine({ packs: [bundle], channel: tpChannel({ ...(opts.channel ?? {}), settings: opts.settings ?? {} }) });
  let game: GameState = engine.newGame({ seed: opts.seed ?? 1 });
  let now = 0;
  const log: GameEvent[] = [];
  const h = {
    engine,
    bundle,
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
    fail(cmd: Command): { code: string; message: string } {
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
    log,
    types(events: GameEvent[] = log) { return events.map((e) => e.type); },
    open() { return h.do({ type: 'openSession' }); },
    join(id: string, pick: string | null = 'tp:club') {
      return h.do({ type: 'join', character: id, name: id[0]!.toUpperCase() + id.slice(1), ...(pick ? { pick } : {}) });
    },
    spawn(monster = 'tp:blob') { return h.do({ type: 'spawnMonster', monster }); },
    use(id: string, ability: string, chosen?: string) {
      return h.do({ type: 'use', character: id, ability, ...(chosen ? { chosen: { kind: 'character' as const, id: chosen } } : {}) });
    },
  };
  return h;
}
