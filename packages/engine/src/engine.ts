import { type Command, runCommand } from './commands';
import { type Description, describe } from './describe';
import { EngineError, type Issue, PluginError, Rejection } from './errors';
import type { GameEvent } from './events';
import type { PackBundle } from './pack';
import { buildRegistry, type Registry } from './registry';
import { Runtime } from './runtime';
import { settle } from './settle';
import { type GameState, newGameState } from './state';
import { advanceTo, nextWake } from './time';

export type ApplyResult =
  | { ok: true; game: GameState; events: GameEvent[] }
  | { ok: false; error: { code: string; message: string } };

export interface Engine {
  registry: Registry;
  warnings: Issue[];
  describe(): Description;
  newGame(opts: { seed: number }): GameState;
  apply(game: GameState, cmd: Command, now: number): ApplyResult;
  advance(game: GameState, now: number): { game: GameState; events: GameEvent[] };
  nextWakeTime(game: GameState): number | null;
}

export function toError(e: unknown): { code: string; message: string } | null {
  if (e instanceof Rejection) return { code: e.code, message: e.message };
  if (e instanceof EngineError) return { code: e.code, message: e.message };
  if (e instanceof PluginError) return { code: 'plugin-error', message: e.message };
  return null;
}

export function createEngine(opts: { packs: PackBundle[]; channel: unknown }): Engine {
  const registry = buildRegistry(opts.packs, opts.channel);
  return {
    registry,
    warnings: registry.warnings,
    describe: () => describe(registry),
    newGame: ({ seed }) => newGameState(seed),
    apply(game, cmd, now) {
      const rt = new Runtime(registry, structuredClone(game));
      const t = Math.max(now, game.clock);
      try {
        advanceTo(rt, t);
        rt.depth = 0;
        rt.limitHit = false;
        runCommand(rt, cmd);
        settle(rt);
        rt.game.clock = t;
        return { ok: true, game: rt.game, events: rt.events };
      } catch (e) {
        const error = toError(e);
        if (error) return { ok: false, error };
        throw e;
      }
    },
    advance(game, now) {
      const rt = new Runtime(registry, structuredClone(game));
      advanceTo(rt, Math.max(now, game.clock));
      rt.game.clock = rt.now;
      return { game: rt.game, events: rt.events };
    },
    nextWakeTime: (game) => nextWake(new Runtime(registry, structuredClone(game))),
  };
}
