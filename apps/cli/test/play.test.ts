import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { play } from '../src/play';
import { runLines } from '../src/run';
import { setup } from '../src/setup';

async function session(lines: string[], extra: { save?: string; json?: boolean } = {}): Promise<string> {
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += String(c); });
  await play({ seed: 3, input: Readable.from(lines.map((l) => `${l}\n`)), output, ...extra });
  return text;
}

const OPENING = [
  'open', 'join fi sword', 'join ta shield', 'join he staff',
  'adventure the-cave', 'go', 'wait 10s', 'go',
];

describe('dndm play (success criterion 1)', () => {
  it('plays the cave down the left branch', async () => {
    const text = await session([
      ...OPENING,
      'vote fi left', 'vote ta left', 'vote he left', 'wait 30s',
      'go', 'use fi attack', 'use ta attack', 'use he attack', 'end won',
      'go', 'tap fi', 'tap ta', 'wait 20s',
      'go', 'tap fi', 'tap ta', 'tap he', 'wait 30s', 'state', 'close', 'quit',
    ]);
    for (const expected of ['Goblin King appears!', 'The encounter ends (won)', 'The encounter ends (disarmed)', 'The Cave is complete', 'The session is over']) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('✗');
  });

  it('plays the cave down the right branch, with a shop purchase', async () => {
    const text = await session([
      ...OPENING,
      'vote fi right', 'vote ta right', 'wait 30s',
      'go', 'give-gold fi 15', 'buy fi health-potion', 'view fi', 'end',
      'go', 'wait 20s', 'go', 'tap he', 'wait 30s', 'close',
    ]);
    for (const expected of ['buys starter:health-potion', 'The encounter ends (triggered)', 'The Cave is complete']) expect(text).toContain(expected);
    expect(text).toContain('Drink Potion');
  });

  it('shows scenes and widgets, and keeps going after typos', async () => {
    const text = await session(['open', 'join al sword', 'start wandering-merchant', 'view al', 'spwan slime', 'use al atack', 'state']);
    expect(text).toContain('▶ A shop opens');
    expect(text).toContain('$ Shop (you have 0 gold)');
    expect(text).toContain("! Unknown command 'spwan'. Type help for the list.");
    expect(text).toContain("! Unknown ability 'atack'");
    expect(text).toContain('Phase: encounter');
  });

  it('--save writes the game and a replayable script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-'));
    const file = join(dir, 'game.json');
    const typed = ['open', 'join al sword', 'spawn slime', 'use al attack', 'wait 20s', 'quit'];
    const text = await session(typed, { save: file });
    expect(existsSync(file)).toBe(true);
    const script = readFileSync(`${file}.script.jsonl`, 'utf8').trim().split('\n');
    expect(script).toHaveLength(5);
    const replay = runLines(script, { engine: await setup({}), seed: 3 });
    for (const line of replay) expect(text).toContain(line);
    expect(JSON.parse(readFileSync(file, 'utf8')).clock).toBe(20000);
  });

  it('--json prints only JSON lines', async () => {
    const text = await session(['open', 'join al sword', 'bogus'], { json: true });
    for (const line of text.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
  });
});
