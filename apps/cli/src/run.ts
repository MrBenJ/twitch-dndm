import { readFileSync } from 'node:fs';
import type { Engine } from '@dndm/engine';
import { Driver, formatOutput, parseScriptLine } from './driver';
import { CliError } from './ids';
import { setup, type SetupOpts } from './setup';

export function runLines(lines: string[], opts: { engine: Engine; seed: number; json?: boolean }): string[] {
  const driver = new Driver(opts.engine, opts.seed);
  const out: string[] = [];
  lines.forEach((text, i) => {
    if (!text.trim()) return;
    const line = parseScriptLine(text, i + 1);
    for (const o of driver.exec(line)) out.push(formatOutput(o, !!opts.json));
  });
  return out;
}

export async function runFile(file: string, opts: SetupOpts & { seed: number; json?: boolean; write: (line: string) => void }): Promise<number> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const why = code === 'ENOENT' ? 'no such file' : code === 'EACCES' ? 'permission denied' : code === 'EISDIR' ? 'it is a folder' : 'unreadable';
    opts.write(opts.json ? JSON.stringify({ kind: 'error', text: `can't read ${file} (${why})` }) : `error: can't read ${file} (${why})`);
    return 1;
  }
  const engine = await setup(opts);
  const lines = text.split('\n');
  try {
    for (const l of runLines(lines, { engine, seed: opts.seed, json: opts.json })) opts.write(l);
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      opts.write(opts.json ? JSON.stringify({ kind: 'error', text: e.message }) : `error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
