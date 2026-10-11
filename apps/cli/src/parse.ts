import { type Command, type Description, parseDuration } from '@dndm/engine';
import { CliError, type IdKind, resolveId } from './ids';

export type ScriptLine = { wait: string | number } | { next: true } | { as: string; command: Record<string, unknown> };
export type Action =
  | { kind: 'script'; line: ScriptLine }
  | { kind: 'state' } | { kind: 'view'; id: string } | { kind: 'describe' } | { kind: 'help' } | { kind: 'quit' };

export const HELP = `Viewer commands (first word after the command is the character):
  join <char> [class-item]   leave <char>       use <char> <ability> [target|monster]
  equip <char> <item>        unequip <char> <slot>
  vote <char> <choice>       tap <char>         buy <char> <item>     respond <char> [json]
Streamer commands:
  open | close               spawn <monster>    start <encounter>     end [outcome]
  adventure <id> | go | skip <node> | stop
  heal <char|party> [amount|full]    revive <char|all>    ko <char>
  status <char|monster> <status> [duration] [json params]    unstatus <char|monster> <status>
  act | hold | release | monster-hp <n>
  give-xp <char|party> <n>   give-gold <char|party> <n>   give-item <char|party> <item>
  remove <char> | ban <char> | unban <char> | say <text>
Time and info:
  wait <duration> | next | state | view <char> | describe | help | quit
Short IDs work when only one pack has them (spawn slime); otherwise write pack:id.`;

const entity = (t: string) => (t === 'monster' || t === 'm1' ? { kind: 'monster', id: 'm1' } : { kind: 'character', id: t });

export function parseLine(input: string, d: Description): Action | null {
  const text = input.trim();
  if (!text || text.startsWith('#')) return null;
  const [cmd, ...args] = text.split(/\s+/) as [string, ...string[]];
  const need = (n: number, usage: string) => { if (args.length < n) throw new CliError(`Usage: ${usage}`); };
  const id = (kind: IdKind, t: string) => resolveId(d, kind, t);
  const rest = (from: number) => args.slice(from).join(' ');
  const json = (raw: string, usage: string): unknown => {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { throw new CliError(`Usage: ${usage} (write params as JSON)`); }
  };
  const S = (command: Command): Action => ({ kind: 'script', line: { as: 'streamer', command: command as unknown as Record<string, unknown> } });
  const V = (who: string, command: Record<string, unknown>): Action => ({ kind: 'script', line: { as: who, command } });
  const a0 = args[0]!;
  const a1 = args[1]!;

  switch (cmd) {
    case 'open': return S({ type: 'openSession' });
    case 'close': return S({ type: 'closeSession' });
    case 'join': need(1, 'join <character> [class-item]'); return V(a0, { type: 'join', name: a0, ...(args[1] ? { pick: id('item', a1) } : {}) });
    case 'leave': need(1, 'leave <character>'); return V(a0, { type: 'leave' });
    case 'use': need(2, 'use <character> <ability> [target]');
      return V(a0, { type: 'use', ability: id('ability', a1), ...(args[2] ? { chosen: entity(args[2]) } : {}) });
    case 'equip': need(2, 'equip <character> <item>'); return V(a0, { type: 'equip', item: id('item', a1) });
    case 'unequip': need(2, 'unequip <character> <slot>'); return V(a0, { type: 'unequip', slot: id('slot', a1) });
    case 'vote': need(2, 'vote <character> <choice>'); return V(a0, { type: 'respond', input: { choice: a1 } });
    case 'tap': need(1, 'tap <character>'); return V(a0, { type: 'respond', input: {} });
    case 'buy': need(2, 'buy <character> <item>'); return V(a0, { type: 'respond', input: { buy: id('item', a1) } });
    case 'respond': need(1, 'respond <character> [json]'); return V(a0, { type: 'respond', input: json(rest(1), 'respond <character> [json]') });
    case 'spawn': need(1, 'spawn <monster>'); return S({ type: 'spawnMonster', monster: id('monster', a0) });
    case 'start': need(1, 'start <encounter>'); return S({ type: 'startEncounter', encounter: id('encounter', a0) });
    case 'end': return S(args[0] ? { type: 'endEncounter', outcome: a0 } : { type: 'endEncounter' });
    case 'adventure': need(1, 'adventure <id>'); return S({ type: 'startAdventure', adventure: id('adventure', a0) });
    case 'go': return S({ type: 'go' });
    case 'skip': need(1, 'skip <node>'); return S({ type: 'skipTo', node: a0 });
    case 'stop': return S({ type: 'stopAdventure' });
    case 'heal': need(1, 'heal <character|party> [amount|full]');
      if (a0 === 'party') return S({ type: 'healParty' });
      return S({ type: 'healPlayer', character: a0, amount: args[1] && a1 !== 'full' ? Number(a1) : 'full' });
    case 'revive': need(1, 'revive <character|all>');
      return S(a0 === 'all' ? { type: 'reviveAll' } : { type: 'revivePlayer', character: a0 });
    case 'ko': need(1, 'ko <character>'); return S({ type: 'knockOut', character: a0 });
    case 'status': {
      need(2, 'status <character|monster> <status> [duration] [json params]');
      const hasDuration = !!args[2] && !args[2].startsWith('{');
      return S({
        type: 'applyStatus', target: entity(a0) as { kind: 'character' | 'monster'; id: string }, status: id('status', a1),
        ...(hasDuration ? { duration: args[2] } : {}),
        params: json(rest(hasDuration ? 3 : 2), 'status <character|monster> <status> [duration] [json params]'),
      });
    }
    case 'unstatus': need(2, 'unstatus <character|monster> <status>');
      return S({ type: 'removeStatus', target: entity(a0) as { kind: 'character' | 'monster'; id: string }, status: id('status', a1) });
    case 'act': return S({ type: 'monsterActNow' });
    case 'hold': return S({ type: 'holdMonster' });
    case 'release': return S({ type: 'releaseMonster' });
    case 'monster-hp': need(1, 'monster-hp <n>'); return S({ type: 'setMonsterHp', value: Number(a0) });
    case 'give-xp': need(2, 'give-xp <character|party> <n>'); return S({ type: 'giveXp', target: a0, amount: Number(a1) });
    case 'give-gold': need(2, 'give-gold <character|party> <n>'); return S({ type: 'giveGold', target: a0, amount: Number(a1) });
    case 'give-item': need(2, 'give-item <character|party> <item>'); return S({ type: 'giveItem', target: a0, item: id('item', a1) });
    case 'remove': need(1, 'remove <character>'); return S({ type: 'removePlayer', character: a0 });
    case 'ban': need(1, 'ban <character>'); return S({ type: 'banPlayer', character: a0 });
    case 'unban': need(1, 'unban <character>'); return S({ type: 'unbanPlayer', character: a0 });
    case 'say': need(1, 'say <text>'); return S({ type: 'postMessage', text: rest(0) });
    case 'wait':
      need(1, 'wait <duration>');
      try { parseDuration(a0); } catch (e) { throw new CliError((e as Error).message); }
      return { kind: 'script', line: { wait: a0 } };
    case 'next': return { kind: 'script', line: { next: true } };
    case 'state': return { kind: 'state' };
    case 'view': need(1, 'view <character>'); return { kind: 'view', id: a0 };
    case 'describe': return { kind: 'describe' };
    case 'help': return { kind: 'help' };
    case 'quit':
    case 'exit': return { kind: 'quit' };
    default: throw new CliError(`Unknown command '${cmd}'. Type help for the list.`);
  }
}
