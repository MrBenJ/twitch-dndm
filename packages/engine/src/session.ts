import { charRef, effectiveEquipped, maxHp, ownedItems } from './entities';
import { Rejection } from './errors';
import { markActive } from './fight';
import { finishEncounter } from './encounters';
import type { Runtime } from './runtime';
import { settle } from './settle';
import { isFight, newCharacter, type SessionState } from './state';

export function requireSession(rt: Runtime): SessionState {
  const s = rt.game.session;
  if (!s) throw new Rejection('No session is open', 'no-session');
  return s;
}

function clearRemovals(rt: Runtime): void {
  if (!rt.settings.streamerRemovalWaitsForRest) return;
  for (const ch of Object.values(rt.game.characters)) ch.removedByStreamer = false;
}

export function openSession(rt: Runtime): void {
  if (rt.game.session) throw new Rejection('A session is already open', 'session-open');
  rt.game.session = { party: [], encounter: null, adventure: null };
  clearRemovals(rt);
  rt.emit('core:session-opened', 'A new session begins', {});
}

export function closeSession(rt: Runtime): void {
  const s = requireSession(rt);
  if (s.adventure) {
    s.adventure = null;
    rt.emit('core:adventure-stopped', 'The adventure stops', {});
  }
  if (s.encounter) finishEncounter(rt, 'ended');
  settle(rt);
  rt.game.session = null;
  rt.emit('core:session-closed', 'The session is over', {});
}

export function join(rt: Runtime, id: string, name: string | undefined, pick: string | undefined): void {
  const s = requireSession(rt);
  let ch = rt.game.characters[id];
  const created = !ch;
  if (!ch) {
    ch = newCharacter(id, name ?? id);
    rt.game.characters[id] = ch;
  } else if (name) {
    ch.name = name;
  }
  if (ch.banned) throw new Rejection("You're banned from this game", 'banned');
  if (s.party.includes(id)) throw new Rejection("You're already in the party", 'in-party');
  if (rt.settings.partyCap !== null && s.party.length >= rt.settings.partyCap) throw new Rejection('The party is full', 'party-full');

  const enc = s.encounter;
  const inFight = !!enc && isFight(enc);
  const inOther = !!enc && !inFight;
  if (ch.removedByStreamer && enc) {
    const waits = rt.settings.streamerRemovalWaitsForRest;
    const ok = (inOther && !waits) || (inFight && rt.settings.allowJoinMidFight && !waits);
    if (!ok) throw new Rejection('You were removed by the streamer. You can rejoin when the party rests', 'removed');
  } else if (inFight && !rt.settings.allowJoinMidFight) {
    throw new Rejection("You can't join in the middle of a fight", 'mid-fight');
  }

  const slot = rt.settings.classSlot;
  if (slot && !effectiveEquipped(rt, ch).some(([sl]) => sl === slot)) {
    const options = ownedItems(rt, ch).filter((i) => i.slot === slot);
    if (options.length) {
      if (!pick) throw new Rejection(`Pick your class item: ${options.map((o) => o.id).join(', ')}`, 'pick-required');
      if (!options.some((o) => o.id === pick)) throw new Rejection("You can't pick that", 'bad-pick');
      ch.equipped[slot] = pick;
    }
  }
  if (created) ch.hp = maxHp(rt, charRef(id));
  ch.removedByStreamer = false;
  s.party.push(id);
  if (enc && isFight(enc)) {
    enc.joinedAt[id] = rt.now;
    markActive(rt, id);
  }
  rt.emit('core:joined', `${ch.name} joins the party`, { character: id });
}

function removeFromParty(rt: Runtime, id: string): boolean {
  const s = requireSession(rt);
  if (!s.party.includes(id)) return false;
  s.party = s.party.filter((x) => x !== id);
  return true;
}

export function leave(rt: Runtime, id: string): void {
  const ch = rt.requireChar(id);
  if (!removeFromParty(rt, id)) throw new Rejection('Not in the party', 'not-in-party');
  rt.emit('core:left', `${ch.name} leaves the party`, { character: id });
}

export function removePlayer(rt: Runtime, id: string): void {
  const ch = rt.requireChar(id);
  if (!removeFromParty(rt, id)) throw new Rejection('Not in the party', 'not-in-party');
  if (rt.game.session!.encounter) ch.removedByStreamer = true;
  rt.emit('core:removed', `${ch.name} was removed from the party`, { character: id });
}

export function banPlayer(rt: Runtime, id: string): void {
  const ch = rt.requireChar(id);
  ch.banned = true;
  if (rt.game.session) removeFromParty(rt, id);
  rt.emit('core:banned', `${ch.name} was banned from the game`, { character: id });
}

export function unbanPlayer(rt: Runtime, id: string): void {
  const ch = rt.requireChar(id);
  ch.banned = false;
  rt.emit('core:unbanned', `${ch.name} was unbanned`, { character: id });
}

export { clearRemovals };
