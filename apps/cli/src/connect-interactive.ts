import { createInterface } from 'node:readline';
import { STEPPED, type ConnectOpts, type Session } from './connect';
import type { Output } from './driver';
import { CliError } from './ids';
import { HELP, parseLine } from './parse';
import { renderState, renderView } from './render';

export async function interactive(s: Session, o: ConnectOpts, write: (o: Output) => void, writeLine: (line: string) => void): Promise<number> {
  const json = !!o.json;
  const desc = await s.client.describe(await s.token(o.dock ? 'streamer' : o.viewer!));
  const tty = !json && 'isTTY' in o.input && !!(o.input as { isTTY?: boolean }).isTTY;
  const note = (text: string) => writeLine(json ? JSON.stringify({ kind: 'error', text }) : `! ${text}`);
  if (!json) writeLine('dndm connect: live. Type help for commands. Time runs on its own; use pause <duration|events> to wait.');
  const rl = createInterface({ input: o.input, ...(tty ? { output: o.output, terminal: true } : {}) });
  if (tty) { rl.setPrompt('> '); rl.prompt(); }

  for await (const text of rl) {
    let quit = false;
    try {
      s.check();
      const trimmed = text.trim();
      if (trimmed.startsWith('pause')) {
        const arg = trimmed.split(/\s+/)[1];
        if (!arg) throw new CliError('Usage: pause <duration|events>');
        await s.pause(arg);
      } else {
        const action = parseLine(text, desc);
        if (action) {
          switch (action.kind) {
            case 'quit': quit = true; break;
            case 'help': if (!json) writeLine(`${HELP}\n  pause <duration|events>    wait in real time (wait and next don't work live)`); break;
            case 'describe': writeLine(JSON.stringify(desc, null, json ? undefined : 2)); break;
            case 'state': {
              const v = await s.client.view(await s.token(o.dock ? 'streamer' : o.viewer!));
              if (json) writeLine(JSON.stringify({ kind: 'state', ...v })); else renderState(v).forEach(writeLine);
              break;
            }
            case 'view': {
              const v = await s.client.view(await s.token(action.id));
              if (json) writeLine(JSON.stringify({ kind: 'view', ...v })); else renderView(v).forEach(writeLine);
              break;
            }
            case 'script': {
              const line = action.line;
              if ('wait' in line || 'next' in line) throw new CliError(STEPPED);
              await s.send(line.as, line.command as Record<string, unknown> & { type: string });
              await new Promise((r) => setTimeout(r, 50));
              break;
            }
          }
        }
      }
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      note(e.message);
      if (s.dropped) { rl.close(); return 1; }
    }
    if (quit) break;
    if (tty) rl.prompt();
  }
  rl.close();
  return 0;
}
