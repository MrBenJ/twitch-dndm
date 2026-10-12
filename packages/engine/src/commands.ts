import { z } from 'zod';
import { go, skipTo, startAdventure, stopAdventure } from './adventure';
import { Rejection } from './errors';
import { endEncounterCommand, respond, startEncounterCommand } from './encounters';
import { holdMonster, monsterActNow, releaseMonster, setMonsterHp, spawnMonster } from './fight';
import { equip, unequip } from './gear';
import type { EntityRef } from './pack';
import type { Runtime } from './runtime';
import { banPlayer, closeSession, join, leave, openSession, removePlayer, unbanPlayer } from './session';
import {
  applyStatusCommand, giveGoldCommand, giveItemCommand, giveXpCommand, healParty, healPlayer, knockOutCommand,
  postMessage, removeStatusCommand, reviveAll, revivePlayer,
} from './streamer';
import { useCommand } from './use';

export type Command =
  // viewer commands
  | { type: 'join'; character: string; name?: string; pick?: string }
  | { type: 'leave'; character: string }
  | { type: 'use'; character: string; ability: string; chosen?: EntityRef | null }
  | { type: 'equip'; character: string; item: string }
  | { type: 'unequip'; character: string; slot: string }
  | { type: 'respond'; character: string; input: unknown }
  // streamer: session
  | { type: 'openSession' }
  | { type: 'closeSession' }
  | { type: 'removePlayer'; character: string }
  | { type: 'banPlayer'; character: string }
  | { type: 'unbanPlayer'; character: string }
  // streamer: encounters
  | { type: 'spawnMonster'; monster: string }
  | { type: 'startEncounter'; encounter: string | Record<string, unknown> }
  | { type: 'endEncounter'; outcome?: string }
  // streamer: adventures
  | { type: 'startAdventure'; adventure: string }
  | { type: 'go' }
  | { type: 'skipTo'; node: string }
  | { type: 'stopAdventure' }
  // streamer: healing
  | { type: 'healPlayer'; character: string; amount: number | 'full' }
  | { type: 'healParty' }
  | { type: 'revivePlayer'; character: string }
  | { type: 'reviveAll' }
  // streamer: statuses
  | { type: 'applyStatus'; target: EntityRef; status: string; duration?: string | number | null; params?: unknown }
  | { type: 'removeStatus'; target: EntityRef; status: string }
  | { type: 'knockOut'; character: string }
  // streamer: monster
  | { type: 'monsterActNow' }
  | { type: 'holdMonster' }
  | { type: 'releaseMonster' }
  | { type: 'setMonsterHp'; value: number }
  // streamer: rewards and feed
  | { type: 'giveXp'; target: string; amount: number }
  | { type: 'giveGold'; target: string; amount: number }
  | { type: 'giveItem'; target: string; item: string }
  | { type: 'postMessage'; text: string };

export const VIEWER_COMMANDS = ['join', 'leave', 'use', 'equip', 'unequip', 'respond'] as const;

const id = z.string().min(1);
const ref = z.object({ kind: z.enum(['character', 'monster']), id }).strict();
const amount = z.number();
const cmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => z.object({ type: z.literal(type), ...shape }).strict();

const COMMAND_SCHEMAS = [
  cmd('join', { character: id, name: z.string().optional(), pick: id.optional() }),
  cmd('leave', { character: id }),
  cmd('use', { character: id, ability: id, chosen: ref.nullable().optional() }),
  cmd('equip', { character: id, item: id }),
  cmd('unequip', { character: id, slot: id }),
  cmd('respond', { character: id, input: z.unknown() }),
  cmd('openSession', {}),
  cmd('closeSession', {}),
  cmd('removePlayer', { character: id }),
  cmd('banPlayer', { character: id }),
  cmd('unbanPlayer', { character: id }),
  cmd('spawnMonster', { monster: id }),
  cmd('startEncounter', { encounter: z.union([id, z.record(z.string(), z.unknown())]) }),
  cmd('endEncounter', { outcome: id.optional() }),
  cmd('startAdventure', { adventure: id }),
  cmd('go', {}),
  cmd('skipTo', { node: id }),
  cmd('stopAdventure', {}),
  cmd('healPlayer', { character: id, amount: z.union([amount, z.literal('full')]) }),
  cmd('healParty', {}),
  cmd('revivePlayer', { character: id }),
  cmd('reviveAll', {}),
  cmd('applyStatus', { target: ref, status: id, duration: z.union([z.string(), z.number()]).nullable().optional(), params: z.unknown().optional() }),
  cmd('removeStatus', { target: ref, status: id }),
  cmd('knockOut', { character: id }),
  cmd('monsterActNow', {}),
  cmd('holdMonster', {}),
  cmd('releaseMonster', {}),
  cmd('setMonsterHp', { value: amount }),
  cmd('giveXp', { target: id, amount }),
  cmd('giveGold', { target: id, amount }),
  cmd('giveItem', { target: id, item: id }),
  cmd('postMessage', { text: z.string() }),
] as const;
const BY_TYPE = new Map(COMMAND_SCHEMAS.map((s) => [s.shape.type.value as string, s as z.ZodType]));

/** Checks an untrusted command's shape. Throws Rejection('invalid-input') with the first problem. */
export function checkCommand(raw: unknown): Command {
  const type = typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
  const schema = typeof type === 'string' ? BY_TYPE.get(type) : undefined;
  if (!schema) throw new Rejection(`Unknown command '${String(type)}'`, 'invalid-input');
  const r = schema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw new Rejection(`${i.path.join('.') || type}: ${i.message}`, 'invalid-input');
  }
  return r.data as Command;
}

export function runCommand(rt: Runtime, cmd: Command): void {
  switch (cmd.type) {
    case 'join': return join(rt, cmd.character, cmd.name, cmd.pick);
    case 'leave': return leave(rt, cmd.character);
    case 'use': return useCommand(rt, cmd.character, cmd.ability, cmd.chosen ?? null);
    case 'equip': return equip(rt, cmd.character, cmd.item);
    case 'unequip': return unequip(rt, cmd.character, cmd.slot);
    case 'respond': return respond(rt, cmd.character, cmd.input);
    case 'openSession': return openSession(rt);
    case 'closeSession': return closeSession(rt);
    case 'removePlayer': return removePlayer(rt, cmd.character);
    case 'banPlayer': return banPlayer(rt, cmd.character);
    case 'unbanPlayer': return unbanPlayer(rt, cmd.character);
    case 'spawnMonster': return spawnMonster(rt, cmd.monster);
    case 'startEncounter': return startEncounterCommand(rt, cmd.encounter);
    case 'endEncounter': return endEncounterCommand(rt, cmd.outcome);
    case 'startAdventure': return startAdventure(rt, cmd.adventure);
    case 'go': return go(rt);
    case 'skipTo': return skipTo(rt, cmd.node);
    case 'stopAdventure': return stopAdventure(rt);
    case 'healPlayer': return healPlayer(rt, cmd.character, cmd.amount);
    case 'healParty': return healParty(rt);
    case 'revivePlayer': return revivePlayer(rt, cmd.character);
    case 'reviveAll': return reviveAll(rt);
    case 'applyStatus': return applyStatusCommand(rt, cmd.target, cmd.status, cmd.duration ?? null, cmd.params);
    case 'removeStatus': return removeStatusCommand(rt, cmd.target, cmd.status);
    case 'knockOut': return knockOutCommand(rt, cmd.character);
    case 'monsterActNow': return monsterActNow(rt);
    case 'holdMonster': return holdMonster(rt);
    case 'releaseMonster': return releaseMonster(rt);
    case 'setMonsterHp': return setMonsterHp(rt, cmd.value);
    case 'giveXp': return giveXpCommand(rt, cmd.target, cmd.amount);
    case 'giveGold': return giveGoldCommand(rt, cmd.target, cmd.amount);
    case 'giveItem': return giveItemCommand(rt, cmd.target, cmd.item);
    case 'postMessage': return postMessage(rt, cmd.text);
  }
}

/** The character IDs a command names (spec 2a §6.2). The server loads them before applying it. */
export function commandCharacters(raw: unknown): string[] {
  let cmd: Command;
  try { cmd = checkCommand(raw); } catch { return []; }
  const out = new Set<string>();
  if ('character' in cmd && typeof cmd.character === 'string') out.add(cmd.character);
  if (cmd.type === 'use' && cmd.chosen?.kind === 'character') out.add(cmd.chosen.id);
  if ((cmd.type === 'applyStatus' || cmd.type === 'removeStatus') && cmd.target.kind === 'character') out.add(cmd.target.id);
  if ((cmd.type === 'giveXp' || cmd.type === 'giveGold' || cmd.type === 'giveItem') && cmd.target !== 'party') out.add(cmd.target);
  return [...out];
}
