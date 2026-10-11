import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { Driver, formatOutput } from './driver';
import { CliError } from './ids';
import { HELP, parseLine } from './parse';
import { renderScene, renderState, renderView } from './render';
import { setup, type SetupOpts } from './setup';

function save(file: string, driver: Driver): void {
  writeFileSync(file, `${JSON.stringify(driver.game, null, 2)}\n`);
  writeFileSync(`${file}.script.jsonl`, driver.script.map((l) => JSON.stringify(l)).join('\n') + (driver.script.length ? '\n' : ''));
}

export async function play(opts: SetupOpts & { seed: number; json?: boolean; save?: string; input: Readable; output: Writable }): Promise<void> {
  const engine = await setup(opts);
  const desc = engine.describe();
  const driver = new Driver(engine, opts.seed);
  const json = !!opts.json;
  const interactive = !json && 'isTTY' in opts.input && !!(opts.input as { isTTY?: boolean }).isTTY;
  const write = (line: string) => opts.output.write(`${line}\n`);
  const note = (text: string) => write(json ? JSON.stringify({ kind: 'error', text }) : `! ${text}`);

  if (!json) write(`dndm play: ${desc.packs.map((p) => p.name).join(', ')}. Type help for commands. Time only moves with wait or next.`);
  const rl = createInterface({ input: opts.input, ...(interactive ? { output: opts.output, terminal: true } : {}) });
  let lastScene = '';
  if (interactive) { rl.setPrompt('> '); rl.prompt(); }

  for await (const text of rl) {
    let quit = false;
    try {
      const action = parseLine(text, desc);
      if (action) {
        switch (action.kind) {
          case 'quit': quit = true; break;
          case 'help': if (!json) write(HELP); break;
          case 'describe': write(JSON.stringify(desc, json ? undefined : null, json ? undefined : 2)); break;
          case 'state': {
            const v = engine.view(driver.game, null, driver.now);
            if (json) write(JSON.stringify({ kind: 'state', ...v }));
            else renderState(v).forEach(write);
            break;
          }
          case 'view': {
            const v = engine.view(driver.game, action.id, driver.now);
            if (json) write(JSON.stringify({ kind: 'view', ...v }));
            else renderView(v).forEach(write);
            break;
          }
          case 'script': {
            for (const o of driver.exec(action.line)) write(formatOutput(o, json));
            if (!json) {
              const scene = engine.view(driver.game, null, driver.now).overlay;
              const key = JSON.stringify(scene);
              if (scene && key !== lastScene) renderScene(scene).forEach(write);
              lastScene = key;
            }
            break;
          }
        }
      }
    } catch (e) {
      if (e instanceof CliError) note(e.message);
      else throw e;
    }
    if (opts.save) save(opts.save, driver);
    if (quit) break;
    if (interactive) rl.prompt();
  }
  rl.close();
}
