import { type Character, type Command, commandCharacters, type Engine, type GameState } from '@dndm/engine';
import { describe, expect, it } from 'vitest';
import { starterHarness } from './helpers';

type Step = Command | number;

const ko = (id: string): Command => ({ type: 'knockOut', character: id });
const join = (id: string, pick = 'starter:sword'): Command => ({ type: 'join', character: id, name: id, pick });

const SCRIPT: Step[] = [
  { type: 'openSession' }, join('al'), join('bo', 'starter:shield'), join('cy', 'starter:staff'),
  { type: 'spawnMonster', monster: 'starter:slime' },
  { type: 'use', character: 'al', ability: 'starter:attack' },
  ko('bo'), { type: 'leave', character: 'bo' },                       // knocked out and gone: must stay loaded
  { type: 'applyStatus', target: { kind: 'character', id: 'cy' }, status: 'starter:drowsy', duration: '40s', params: { multiplier: 2 } },
  { type: 'removePlayer', character: 'cy' },                          // removed mid-fight: flag must clear at rest
  20_000,
  { type: 'giveGold', target: 'dd', amount: 5 },                     // never seen: rejected the same way in both runs
  join('dd'), { type: 'giveGold', target: 'dd', amount: 5 }, { type: 'leave', character: 'dd' },
  70_000,
  { type: 'endEncounter', outcome: 'won' },
  { type: 'spawnMonster', monster: 'starter:slime' },
  join('cy', 'starter:staff'),                                       // mid-fight: only allowed if the rest cleared cy's flag
  join('bo', 'starter:shield'),
  { type: 'giveGold', target: 'dd', amount: 3 },                     // dd was dropped: loaded again from the store
  30_000,
  { type: 'closeSession' }, { type: 'openSession' }, join('al'),
];

interface Run { events: unknown[]; characters: Record<string, Character> }

function full(engine: Engine): Run {
  let game: GameState = engine.newGame({ seed: 7 });
  let now = 0;
  const events: unknown[] = [];
  for (const step of SCRIPT) {
    if (typeof step === 'number') {
      now += step;
      const r = engine.advance(game, now);
      game = r.game; events.push(...r.events);
      continue;
    }
    const r = engine.apply(game, step, now);
    if (r.ok) { game = r.game; events.push(...r.events); } else events.push({ rejected: r.error.code });
  }
  return { events, characters: game.characters };
}

function partial(engine: Engine): Run {
  let game: GameState = engine.newGame({ seed: 7 });
  let now = 0;
  const events: unknown[] = [];
  const store = new Map<string, Character>();
  const waits = engine.registry.settings.streamerRemovalWaitsForRest;
  const load = (ids: string[]) => {
    for (const id of ids) if (!game.characters[id] && store.has(id)) game.characters[id] = structuredClone(store.get(id)!);
  };
  const saveAndDrop = () => {
    for (const [id, ch] of Object.entries(game.characters)) store.set(id, structuredClone(ch));
    const s = game.session;
    for (const [id, ch] of Object.entries(game.characters)) {
      const keep = !!s?.party.includes(id) || engine.characterWake(game, id) !== null || (!!s && waits && ch.removedByStreamer);
      if (!keep) delete game.characters[id];
    }
  };
  for (const step of SCRIPT) {
    if (typeof step === 'number') {
      now += step;
      const r = engine.advance(game, now);
      game = r.game; events.push(...r.events);
    } else {
      load(commandCharacters(step));
      if (step.type === 'openSession' && waits) load([...store.values()].filter((c) => c.removedByStreamer).map((c) => c.id));
      const r = engine.apply(game, step, now);
      if (r.ok) { game = r.game; events.push(...r.events); } else events.push({ rejected: r.error.code });
    }
    saveAndDrop();
  }
  return { events, characters: Object.fromEntries(store) };
}

describe('partial character state (spec 2a §7.1)', () => {
  it('gives the same events and characters as keeping everyone loaded', async () => {
    const { engine } = await starterHarness();
    const a = full(engine);
    const b = partial(engine);
    expect(b.events).toEqual(a.events);
    expect(b.characters).toEqual(a.characters);
    // The script really exercised the rules it's meant to.
    expect(a.events).toContainEqual(expect.objectContaining({ type: 'core:knockout-ended' }));
    expect(a.characters.cy!.removedByStreamer).toBe(false);
  });
});
