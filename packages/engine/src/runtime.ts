import type { Settings } from './channel';
import { Rejection } from './errors';
import type { GameEvent } from './events';
import type { FormulaNode } from './formula';
import type { ReactionJob } from './hooks';
import type { Registry } from './registry';
import { nextRandom } from './rng';
import type { Character, GameState } from './state';

/** One command or time step's working copy of the game. */
export class Runtime {
  events: GameEvent[] = [];
  queue: ReactionJob[] = [];
  depth = 0;
  limitHit = false;
  /** The audience of the reaction now running; null outside one. */
  reactionAudience: string[] | null = null;
  pendingEnd: string | null = null;
  inStatModifier = 0;
  readonly formulaCache = new Map<string, FormulaNode>();
  now: number;

  constructor(readonly reg: Registry, public game: GameState) {
    this.now = game.clock;
  }

  get settings(): Settings {
    return this.reg.settings;
  }

  emit(type: string, text: string, data: Record<string, unknown> = {}, audience?: string[]): void {
    const aud = audience ?? (this.reactionAudience ? [...this.reactionAudience] : undefined);
    this.events.push({ type, at: this.now, text, data, ...(aud ? { audience: aud } : {}) });
  }

  random(): number {
    const [value, next] = nextRandom(this.game.rng);
    this.game.rng = next;
    return value;
  }

  randomInt(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  requireChar(id: string): Character {
    const ch = this.game.characters[id];
    if (!ch) throw new Rejection('Unknown character', 'unknown-character');
    return ch;
  }
}
