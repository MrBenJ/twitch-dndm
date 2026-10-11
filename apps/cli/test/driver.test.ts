import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Engine } from '@dndm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { Driver, formatOutput, parseScriptLine } from '../src/driver';
import { runFile, runLines } from '../src/run';
import { setup } from '../src/setup';

let engine: Engine;
beforeAll(async () => { engine = await setup({}); });

describe('Driver', () => {
  it('fills character from as for viewer commands, and formats events', () => {
    const d = new Driver(engine, 1);
    d.exec({ as: 'streamer', command: { type: 'openSession' } });
    const out = d.exec({ as: 'al', command: { type: 'join', name: 'Al', pick: 'starter:sword' } });
    expect(out.map((o) => formatOutput(o, false))).toEqual(['[    0.0s] Al joins the party']);
    expect(d.game.session!.party).toEqual(['al']);
  });

  it('formats rejections and JSON', () => {
    const d = new Driver(engine, 1);
    const [rej] = d.exec({ as: 'al', command: { type: 'leave' } });
    expect(formatOutput(rej!, false)).toBe('[    0.0s] ✗ al: Unknown character (unknown-character)');
    expect(JSON.parse(formatOutput(rej!, true))).toEqual({ kind: 'rejected', at: 0, as: 'al', code: 'unknown-character', text: 'Unknown character' });
    const [ev] = d.exec({ as: 'streamer', command: { type: 'openSession' } });
    expect(JSON.parse(formatOutput(ev!, true))).toEqual({ kind: 'event', type: 'core:session-opened', at: 0, text: 'A new session begins', data: {} });
  });

  it('a viewer can only send viewer commands; streamer commands are refused', () => {
    const d = new Driver(engine, 1);
    d.exec({ as: 'streamer', command: { type: 'openSession' } });
    d.exec({ as: 'al', command: { type: 'join', name: 'Al', pick: 'starter:sword' } });
    const out = d.exec({ as: 'al', command: { type: 'giveGold', target: 'al', amount: 10 } });
    expect(out.map((o) => formatOutput(o, false))).toEqual(["[    0.0s] ✗ al: Only the streamer can do that (streamer-only)"]);
    expect(d.game.characters.al!.gold).toBe(0);
  });

  it('a viewer line always acts as that viewer, whatever character it names', () => {
    const d = new Driver(engine, 1);
    d.exec({ as: 'streamer', command: { type: 'openSession' } });
    d.exec({ as: 'al', command: { type: 'join', name: 'Al', pick: 'starter:sword', character: 'bo' } });
    expect(d.game.session!.party).toEqual(['al']);
  });

  it('wait and next move time; next with nothing scheduled says so', () => {
    const d = new Driver(engine, 1);
    expect(d.exec({ next: true }).map((o) => formatOutput(o, false))).toEqual(['[    0.0s] · Nothing is scheduled']);
    d.exec({ as: 'streamer', command: { type: 'openSession' } });
    d.exec({ as: 'al', command: { type: 'join', name: 'Al', pick: 'starter:sword' } });
    d.exec({ as: 'streamer', command: { type: 'spawnMonster', monster: 'starter:slime' } });
    d.exec({ next: true });
    expect(d.now).toBe(15000);
    d.exec({ wait: '2s' });
    expect(d.now).toBe(17000);
    expect(d.script).toHaveLength(6);
  });
});

describe('scripts', () => {
  it('parses the three line shapes and rejects anything else with the line number', () => {
    expect(parseScriptLine('{"wait":"3s"}', 1)).toEqual({ wait: '3s' });
    expect(parseScriptLine('{"next":true}', 1)).toEqual({ next: true });
    expect(parseScriptLine('{"as":"streamer","command":{"type":"go"}}', 1)).toEqual({ as: 'streamer', command: { type: 'go' } });
    expect(() => parseScriptLine('{"wait":"soon"}', 4)).toThrow("line 4: Invalid duration 'soon' (use 500ms, 8s, 2m or 1h)");
    expect(() => parseScriptLine('{"as":"al"}', 5)).toThrow('line 5: expected {"wait"}, {"next"} or {"as", "command"}');
    expect(() => parseScriptLine('nope', 6)).toThrow(/line 6: not JSON/);
  });

  it('runLines prints every event; runFile returns 1 on a bad line', async () => {
    const out = runLines([
      '{"as":"streamer","command":{"type":"openSession"}}',
      '{"as":"al","command":{"type":"join","name":"Al","pick":"starter:sword"}}',
      '',
      '{"as":"streamer","command":{"type":"spawnMonster","monster":"starter:slime"}}',
      '{"wait":"15s"}',
    ], { engine, seed: 1 });
    expect(out[0]).toBe('[    0.0s] A new session begins');
    expect(out.some((l) => l.includes('Slime uses Club Swing'))).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'run-'));
    writeFileSync(join(dir, 'bad.jsonl'), '{"as":"streamer","command":{"type":"openSession"}}\n{"wait":"x"}\n');
    const lines: string[] = [];
    expect(await runFile(join(dir, 'bad.jsonl'), { seed: 1, write: (l) => lines.push(l) })).toBe(1);
    expect(lines.at(-1)).toBe("error: line 2: Invalid duration 'x' (use 500ms, 8s, 2m or 1h)");
  });
});
