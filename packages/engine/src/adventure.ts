import type { EncounterSpec } from './content';
import { requireResting, startEncounter } from './encounters';
import { Rejection } from './errors';
import type { Runtime } from './runtime';
import type { SessionState } from './state';

function requireSession(rt: Runtime): SessionState {
  const s = rt.game.session;
  if (!s) throw new Rejection('No session is open', 'no-session');
  return s;
}

function requireAdventure(rt: Runtime) {
  const s = requireSession(rt);
  if (!s.adventure) throw new Rejection('No adventure is running', 'no-adventure');
  const def = rt.reg.adventures.get(s.adventure.id);
  if (!def) throw new Rejection('That adventure is not available', 'unknown-content');
  return { s, adv: s.adventure, def };
}

export function startAdventure(rt: Runtime, id: string): void {
  const s = requireSession(rt);
  if (s.adventure) throw new Rejection('An adventure is already running', 'adventure-running');
  const def = rt.reg.adventures.get(id);
  if (!def) throw new Rejection(`Unknown adventure '${id}'`, 'unknown-content');
  s.adventure = { id, lined: def.start };
  rt.emit('core:adventure-started', `${def.name} begins`, { adventure: id });
  rt.emit('core:adventure-lined-up', `Next up: ${def.start}`, { adventure: id, node: def.start });
}

export function go(rt: Runtime): void {
  const { adv, def } = requireAdventure(rt);
  requireResting(rt);
  if (!adv.lined) throw new Rejection('Nothing is lined up', 'nothing-lined');
  const name = adv.lined;
  const node = def.nodes[name]!;
  const spec: EncounterSpec | undefined = node.spec ?? (node.use ? rt.reg.encounters.get(node.use)?.spec : undefined);
  if (!spec) throw new Rejection('That node is not available', 'unknown-content');
  adv.lined = null;
  startEncounter(rt, spec, { adventure: adv.id, node: name });
}

export function skipTo(rt: Runtime, node: string): void {
  const { adv, def } = requireAdventure(rt);
  if (!(node in def.nodes)) throw new Rejection(`No node called '${node}'`, 'unknown-node');
  adv.lined = node;
  rt.emit('core:adventure-lined-up', `Next up: ${node}`, { adventure: adv.id, node });
}

export function stopAdventure(rt: Runtime): void {
  const { s, def } = requireAdventure(rt);
  s.adventure = null;
  rt.emit('core:adventure-stopped', `${def.name} stops`, { adventure: def.id });
}
