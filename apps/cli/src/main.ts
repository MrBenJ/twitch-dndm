import type { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { ValidationError, formatIssue } from '@dndm/engine';
import { LoadError } from '@dndm/pack-loader';
import { validate } from './validate';

const USAGE = `Usage: dndm <command> [options]

Commands:
  validate [--packs dirs] [--channel file]                         check packs and a channel config
  play [--packs dirs] [--channel file] [--seed n] [--save file]    play in the terminal (stepped time)
  run <script.jsonl> [--packs dirs] [--channel file] [--seed n]    run a script and print every event
  sim --party <classes> --vs <monster> [--runs n] [--seed n] [--reaction 1s-3s] [--max-time 30m]

Every command takes --json (one JSON object per line).`;

export async function main(argv: string[], io: { stdout: Writable; stdin: Readable } = { stdout: process.stdout, stdin: process.stdin }): Promise<number> {
  const out = (line: string) => io.stdout.write(`${line}\n`);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true,
      options: {
        packs: { type: 'string', multiple: true }, channel: { type: 'string' }, seed: { type: 'string' },
        json: { type: 'boolean' }, save: { type: 'string' }, party: { type: 'string' }, vs: { type: 'string' },
        runs: { type: 'string' }, reaction: { type: 'string' }, 'max-time': { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    out((e as Error).message);
    out(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const [cmd, ...rest] = positionals;
  const common = { packs: values.packs, channel: values.channel, json: values.json };
  const seed = values.seed !== undefined ? Number(values.seed) : 1;
  try {
    switch (cmd) {
      case 'validate': {
        const r = await validate(common);
        r.lines.forEach(out);
        return r.ok ? 0 : 1;
      }
      case 'play': {
        const { play } = await import('./play');
        await play({ ...common, seed, save: values.save, input: io.stdin, output: io.stdout });
        return 0;
      }
      case 'run': {
        if (!rest[0]) { out('Usage: dndm run <script.jsonl>'); return 2; }
        const { runFile } = await import('./run');
        return await runFile(rest[0], { ...common, seed, write: out });
      }
      case 'sim': {
        const { simCommand } = await import('./sim');
        return await simCommand({ ...common, seed, party: values.party, vs: values.vs, runs: values.runs, reaction: values.reaction, maxTime: values['max-time'], write: out });
      }
      default:
        out(USAGE);
        return cmd === undefined || values.help ? 0 : 2;
    }
  } catch (e) {
    if (e instanceof ValidationError) { e.issues.forEach((i) => out(formatIssue(i))); return 1; }
    if (e instanceof LoadError) { out(`error: ${e.message}`); return 1; }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
