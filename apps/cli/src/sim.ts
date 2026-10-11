import { type Command, type Engine, type EntityRef, type GameEvent, type GameState, parseDuration } from '@dndm/engine';
import { CliError, resolveId } from './ids';
import { makeRng } from './rng';
import { setup, type SetupOpts } from './setup';

export interface SimOptions {
  engine: Engine;
  party: string[];
  vs: string;
  runs: number;
  seed: number;
  reaction: [number, number];
  maxTime: number;
}

export interface SimReport {
  runs: number;
  wins: number;
  winRate: number;
  timeouts: number;
  avgDuration: number;
  avgKnockouts: number;
  byAbility: { ability: string; uses: number; damage: number; healing: number }[];
}

interface Tally { uses: number; damage: number; healing: number }

function tallyEvents(events: GameEvent[], byAbility: Map<string, Tally>): number {
  let current: { user: EntityRef; ability: string } | null = null;
  let knockouts = 0;
  const get = (a: string) => byAbility.get(a) ?? (byAbility.set(a, { uses: 0, damage: 0, healing: 0 }), byAbility.get(a)!);
  for (const e of events) {
    if (e.type === 'core:ability-used') {
      current = { user: e.data.user as EntityRef, ability: e.data.ability as string };
      get(current.ability).uses++;
    } else if ((e.type === 'core:damaged' || e.type === 'core:healed') && current) {
      const src = e.data.source as EntityRef | null;
      if (src && src.kind === current.user.kind && src.id === current.user.id && typeof e.data.amount === 'number') {
        if (e.type === 'core:damaged') get(current.ability).damage += e.data.amount;
        else get(current.ability).healing += e.data.amount;
      }
    } else if (e.type === 'core:knocked-out' && (e.data.entity as EntityRef).kind === 'character') {
      knockouts++;
    }
  }
  return knockouts;
}

export function simulate(o: SimOptions): SimReport {
  const d = o.engine.describe();
  const classSlot = d.settings.classSlot;
  const classes = o.party.map((c) => resolveId(d, 'class', c));
  const monster = resolveId(d, 'monster', o.vs);
  const itemFor = (cls: string) => {
    const item = d.items.find((i) => i.grantsClass === cls && i.slot === classSlot);
    if (!item) throw new CliError(`No item grants ${cls} in the class slot`);
    return item;
  };
  const byAbility = new Map<string, Tally>();
  let wins = 0, timeouts = 0, totalDuration = 0, totalKnockouts = 0;

  for (let run = 0; run < o.runs; run++) {
    const rand = makeRng(o.seed * 7919 + run);
    let game: GameState = o.engine.newGame({ seed: o.seed + run });
    let now = 0;
    const events: GameEvent[] = [];
    const apply = (cmd: Command): boolean => {
      const r = o.engine.apply(game, cmd, now);
      if (!r.ok) return false;
      game = r.game;
      events.push(...r.events);
      return true;
    };
    const reaction = () => o.reaction[0] + Math.floor(rand() * (o.reaction[1] - o.reaction[0] + 1));

    apply({ type: 'openSession' });
    const bots = classes.map((cls, i) => {
      const id = `bot${i + 1}`;
      const item = itemFor(cls);
      if (!item.starting) apply({ type: 'giveItem', target: id, item: item.id });
      apply({ type: 'join', character: id, name: `${d.classes.find((c) => c.id === cls)!.name} ${i + 1}`, pick: item.id });
      return id;
    });
    if (!apply({ type: 'spawnMonster', monster })) throw new CliError(`Can't spawn ${monster}`);
    const start = now;
    const nextAct = new Map(bots.map((b) => [b, now + reaction()]));
    let outcome: string | null = null;

    while (outcome === null) {
      const wake = o.engine.nextWakeTime(game) ?? Infinity;
      const t = Math.min(wake, ...nextAct.values());
      if (t === Infinity) break;
      if (t - start > o.maxTime) {
        now = start + o.maxTime;
        apply({ type: 'endEncounter', outcome: 'ended' });
        outcome = 'timeout';
        break;
      }
      now = Math.max(now, t);
      const adv = o.engine.advance(game, now);
      game = adv.game;
      events.push(...adv.events);
      for (const bot of bots) {
        if (!game.session?.encounter) break;
        if ((nextAct.get(bot) ?? Infinity) > now) continue;
        const v = o.engine.view(game, bot, now);
        const ready = v.abilities.filter((a) => a.ready && a.targets.length > 0);
        if (ready.length) {
          const pick = ready[Math.floor(rand() * ready.length)]!;
          let chosen: EntityRef | null = null;
          if (pick.needsChoice) {
            const party = new Map(v.party.map((m) => [m.id, m]));
            chosen = [...pick.targets].sort((a, b) => {
              const ma = party.get(a.id), mb = party.get(b.id);
              const ka = ma?.knockedOut ? -1 : (ma ? ma.hp / ma.maxHp : 1);
              const kb = mb?.knockedOut ? -1 : (mb ? mb.hp / mb.maxHp : 1);
              return ka - kb;
            })[0]!;
          }
          apply({ type: 'use', character: bot, ability: pick.ability, ...(chosen ? { chosen } : {}) });
        }
        const after = o.engine.view(game, bot, now);
        const soonest = Math.min(...after.abilities.map((a) => a.readyAt ?? Infinity), now + 1000);
        nextAct.set(bot, Math.max(now + 1, soonest) + reaction());
      }
      const ended = [...events].reverse().find((e) => e.type === 'core:encounter-ended');
      if (!game.session?.encounter && ended) outcome = ended.data.outcome as string;
    }

    if (outcome === 'won') wins++;
    if (outcome === 'timeout') timeouts++;
    totalDuration += now - start;
    totalKnockouts += tallyEvents(events, byAbility);
  }

  return {
    runs: o.runs, wins, winRate: o.runs ? wins / o.runs : 0, timeouts,
    avgDuration: o.runs ? Math.round(totalDuration / o.runs) : 0,
    avgKnockouts: o.runs ? totalKnockouts / o.runs : 0,
    byAbility: [...byAbility.entries()].map(([ability, t]) => ({ ability, ...t })).sort((a, b) => a.ability.localeCompare(b.ability)),
  };
}

function parseReaction(text: string | undefined): [number, number] {
  if (!text) return [0, 0];
  const [lo, hi] = text.split('-');
  return [parseDuration(lo!), parseDuration(hi ?? lo!)];
}

export async function simCommand(opts: SetupOpts & {
  seed: number; party?: string; vs?: string; runs?: string; reaction?: string; maxTime?: string; json?: boolean; write: (line: string) => void;
}): Promise<number> {
  try {
    if (!opts.party || !opts.vs) throw new CliError('Usage: dndm sim --party <classes> --vs <monster>');
    const engine = await setup(opts);
    const report = simulate({
      engine, party: opts.party.split(','), vs: opts.vs, runs: opts.runs ? Number(opts.runs) : 100, seed: opts.seed,
      reaction: parseReaction(opts.reaction), maxTime: parseDuration(opts.maxTime ?? '30m'),
    });
    if (opts.json) {
      opts.write(JSON.stringify({ kind: 'sim', ...report }));
      return 0;
    }
    opts.write(`Runs: ${report.runs}   Win rate: ${Math.round(report.winRate * 100)}%   Timeouts: ${report.timeouts}`);
    opts.write(`Average fight: ${(report.avgDuration / 1000).toFixed(1)}s   Average knockouts: ${report.avgKnockouts.toFixed(2)}`);
    opts.write('Ability                        uses     damage    healing');
    for (const a of report.byAbility) {
      opts.write(`${a.ability.padEnd(28)} ${String(a.uses).padStart(6)} ${String(a.damage).padStart(10)} ${String(a.healing).padStart(10)}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof CliError) { opts.write(opts.json ? JSON.stringify({ kind: 'error', text: e.message }) : `error: ${e.message}`); return 2; }
    throw e;
  }
}
