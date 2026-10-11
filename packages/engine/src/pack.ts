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
  encounterKind<S = any>(id: string, def: EncounterKindDef<S>): void;
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
