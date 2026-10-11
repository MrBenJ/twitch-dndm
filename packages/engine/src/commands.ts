import { go, skipTo, startAdventure, stopAdventure } from './adventure';
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
