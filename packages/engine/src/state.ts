import type { MonsterDef } from './content';
import type { EntityRef } from './pack';
import { seedState } from './rng';

export interface StatusInstance {
  status: string;
  until: number | null;
  params: unknown;
  source: EntityRef | null;
  appliedAt: number;
  nextTick: number | null;
  seq: number;
}

export interface Character {
  id: string;
  name: string;
  level: number;
  xp: number;
  gold: number;
  hp: number;
  inventory: Record<string, number>;
  equipped: Record<string, string>;
  statuses: StatusInstance[];
  cooldowns: Record<string, number>;
  usesLeft: Record<string, number>;
  knockedOutUntil: number | null;
  banned: boolean;
  removedByStreamer: boolean;
  stores: Record<string, unknown>;
}

export interface MonsterState {
  id: string;
  def: MonsterDef;
  hp: number;
  knockedOut: boolean;
  statuses: StatusInstance[];
  stores: Record<string, unknown>;
}

export interface Origin { adventure: string; node: string }

export interface FightState {
  kind: 'core:fight';
  startedAt: number;
  origin: Origin | null;
  monsters: MonsterState[];
  sub: 'fighting' | 'waiting';
  held: boolean;
  heldRemaining: number | null;
  nextTurnAt: number | null;
  pausedTurnAt: number | null;
  acted: string[];
  wasActive: string[];
  joinedAt: Record<string, number>;
}

export interface KindEncounterState {
  kind: string;
  startedAt: number;
  origin: Origin | null;
  params: unknown;
  state: unknown;
}

export type EncounterState = FightState | KindEncounterState;

export interface SessionState {
  party: string[];
  encounter: EncounterState | null;
  adventure: { id: string; lined: string | null } | null;
}

export interface GameState {
  version: 1;
  clock: number;
  rng: number;
  seq: number;
  session: SessionState | null;
  characters: Record<string, Character>;
}

export function isFight(e: EncounterState): e is FightState {
  return e.kind === 'core:fight';
}

export function newGameState(seed: number): GameState {
  return { version: 1, clock: 0, rng: seedState(seed), seq: 0, session: null, characters: {} };
}

export function newCharacter(id: string, name: string): Character {
  return {
    id, name, level: 1, xp: 0, gold: 0, hp: 0, inventory: {}, equipped: {}, statuses: [], cooldowns: {},
    usesLeft: {}, knockedOutUntil: null, banned: false, removedByStreamer: false, stores: {},
  };
}
