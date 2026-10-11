import { join } from 'node:path';
import { createEngine, type Description } from '@dndm/engine';
import { listPackDirs, loadChannel, loadPacks, repoRoot } from '@dndm/pack-loader';
import { beforeAll, describe, expect, it } from 'vitest';
import { CliError } from '../src/ids';
import { parseLine } from '../src/parse';

let d: Description;
beforeAll(async () => {
  d = createEngine({ packs: await loadPacks(listPackDirs()), channel: loadChannel(join(repoRoot(), 'channels', 'default.yaml')) }).describe();
});

const line = (text: string) => {
  const a = parseLine(text, d);
  if (!a || a.kind !== 'script') throw new Error('not a script line');
  return a.line;
};

describe('parseLine', () => {
  it('turns viewer commands into script lines with full IDs', () => {
    expect(line('join al sword')).toEqual({ as: 'al', command: { type: 'join', name: 'al', pick: 'starter:sword' } });
    expect(line('use al power-strike')).toEqual({ as: 'al', command: { type: 'use', ability: 'starter:power-strike' } });
    expect(line('use he heal al')).toEqual({ as: 'he', command: { type: 'use', ability: 'starter:heal', chosen: { kind: 'character', id: 'al' } } });
    expect(line('vote al left')).toEqual({ as: 'al', command: { type: 'respond', input: { choice: 'left' } } });
    expect(line('tap al')).toEqual({ as: 'al', command: { type: 'respond', input: {} } });
    expect(line('buy al health-potion')).toEqual({ as: 'al', command: { type: 'respond', input: { buy: 'starter:health-potion' } } });
    expect(line('respond al {"choice":"x"}')).toEqual({ as: 'al', command: { type: 'respond', input: { choice: 'x' } } });
    expect(line('equip al leather-armor')).toEqual({ as: 'al', command: { type: 'equip', item: 'starter:leather-armor' } });
    expect(line('unequip al armor')).toEqual({ as: 'al', command: { type: 'unequip', slot: 'starter:armor' } });
  });

  it('turns streamer commands into script lines', () => {
    expect(line('open')).toEqual({ as: 'streamer', command: { type: 'openSession' } });
    expect(line('spawn goblin-king')).toEqual({ as: 'streamer', command: { type: 'spawnMonster', monster: 'starter:goblin-king' } });
    expect(line('start wandering-merchant')).toEqual({ as: 'streamer', command: { type: 'startEncounter', encounter: 'starter:wandering-merchant' } });
    expect(line('end won')).toEqual({ as: 'streamer', command: { type: 'endEncounter', outcome: 'won' } });
    expect(line('adventure the-cave')).toEqual({ as: 'streamer', command: { type: 'startAdventure', adventure: 'starter:the-cave' } });
    expect(line('heal party')).toEqual({ as: 'streamer', command: { type: 'healParty' } });
    expect(line('heal al 20')).toEqual({ as: 'streamer', command: { type: 'healPlayer', character: 'al', amount: 20 } });
    expect(line('heal al')).toEqual({ as: 'streamer', command: { type: 'healPlayer', character: 'al', amount: 'full' } });
    expect(line('revive all')).toEqual({ as: 'streamer', command: { type: 'reviveAll' } });
    expect(line('status al drowsy 30s {"multiplier":1.5}')).toEqual({
      as: 'streamer', command: { type: 'applyStatus', target: { kind: 'character', id: 'al' }, status: 'starter:drowsy', duration: '30s', params: { multiplier: 1.5 } },
    });
    expect(line('status monster guarding {"reduction":50,"priority":1}')).toMatchObject({ command: { target: { kind: 'monster', id: 'm1' }, params: { reduction: 50, priority: 1 } } });
    expect(line('give-gold party 10')).toEqual({ as: 'streamer', command: { type: 'giveGold', target: 'party', amount: 10 } });
    expect(line('give-item al health-potion')).toEqual({ as: 'streamer', command: { type: 'giveItem', target: 'al', item: 'starter:health-potion' } });
    expect(line('say hello there chat')).toEqual({ as: 'streamer', command: { type: 'postMessage', text: 'hello there chat' } });
    expect(line('monster-hp 50')).toEqual({ as: 'streamer', command: { type: 'setMonsterHp', value: 50 } });
  });

  it('time and local commands', () => {
    expect(line('wait 3s')).toEqual({ wait: '3s' });
    expect(line('next')).toEqual({ next: true });
    expect(parseLine('state', d)).toEqual({ kind: 'state' });
    expect(parseLine('view al', d)).toEqual({ kind: 'view', id: 'al' });
    expect(parseLine('quit', d)).toEqual({ kind: 'quit' });
    expect(parseLine('   ', d)).toBeNull();
    expect(parseLine('# a comment', d)).toBeNull();
  });

  it('gives readable errors for typos and bad arguments', () => {
    expect(() => parseLine('spwan slime', d)).toThrow(new CliError("Unknown command 'spwan'. Type help for the list."));
    expect(() => parseLine('use al atack', d)).toThrow("Unknown ability 'atack'");
    expect(() => parseLine('use al', d)).toThrow('Usage: use <character> <ability> [target]');
    expect(() => parseLine('wait soon', d)).toThrow(/Invalid duration 'soon'/);
    expect(() => parseLine('respond al {nope', d)).toThrow(/as JSON/);
  });
});
