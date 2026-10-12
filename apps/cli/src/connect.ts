import { readFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { type GameEvent, parseDuration } from '@dndm/engine';
import type { Answer, ServerMessage } from '@dndm/protocol';
import { Client, type Live } from './client';
import { formatOutput, type Output } from './driver';
import { CliError } from './ids';

export type ConnectLine = { pause: string | number } | { as: string; command: Record<string, unknown> & { type: string } };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const STEPPED = '`wait` and `next` move the stepped clock in `dndm run`; a live server\'s clock can\'t be moved. Use {"pause":"5s"} or {"pause":"events"}';

/** Spec 2a §8.2: `dndm run`'s lines, with real-time pauses instead of stepped waits. */
export function parseConnectLine(text: string, lineNo: number): ConnectLine {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { throw new CliError(`line ${lineNo}: not JSON (${(e as Error).message})`); }
  if (isObj(v) && ('wait' in v || 'next' in v)) throw new CliError(`line ${lineNo}: ${STEPPED}`);
  if (isObj(v) && 'pause' in v && (typeof v.pause === 'string' || typeof v.pause === 'number')) {
    if (v.pause !== 'events') {
      try { parseDuration(v.pause); } catch (e) { throw new CliError(`line ${lineNo}: ${(e as Error).message}`); }
    }
    return { pause: v.pause };
  }
  if (isObj(v) && typeof v.as === 'string' && isObj(v.command) && typeof v.command.type === 'string') {
    return { as: v.as, command: v.command as Record<string, unknown> & { type: string } };
  }
  throw new CliError(`line ${lineNo}: expected {"pause"} or {"as", "command"}`);
}

export interface ConnectOpts {
  url: string; channel?: string; dock?: string; viewer?: string; script?: string; json?: boolean;
  timeoutMs?: number; input: Readable; output: Writable;
}

/** One connection's identities: the dock token for "streamer", and dev logins for viewer names. */
export class Session {
  private tokens = new Map<string, string>();
  live: Live | null = null;
  /** Set when the live connection closes or the server reports an error; the session must stop. */
  dropped: string | null = null;

  constructor(readonly client: Client, readonly o: ConnectOpts, private readonly write: (o: Output) => void) {
    if (o.dock) this.tokens.set('streamer', o.dock);
  }

  async token(as: string): Promise<string> {
    const known = this.tokens.get(as);
    if (known) return known;
    if (as === 'streamer') throw new CliError('streamer lines need --dock <token>');
    const t = await this.client.login(as);
    this.tokens.set(as, t);
    return t;
  }

  /** Watches as the streamer when there's a dock token (it sees every event), else as --viewer. */
  async open(): Promise<void> {
    const who = this.o.dock ? 'streamer' : this.o.viewer;
    if (!who) throw new CliError('give --dock <token> or --viewer <name>');
    this.live = await this.client.live(await this.token(who));
    this.live.on((m: ServerMessage) => {
      if (m.type === 'events') for (const e of m.events) this.write(eventOut(e));
      if (m.type === 'config-changed') this.write({ kind: 'note', at: 0, text: `Config changed (version ${m.configVersion})` });
      if (m.type === 'error') this.dropped ??= m.message;
    });
  }

  /** Throws once the live connection is gone, so a session never carries on blind. */
  check(): void {
    if (this.dropped) throw new CliError(this.dropped);
  }

  async send(as: string, command: Record<string, unknown> & { type: string }): Promise<Answer> {
    const { character: _ignored, ...rest } = command;
    const a = await this.client.command(await this.token(as), as === 'streamer' ? command : rest);
    if (!a.ok) this.write({ kind: 'rejected', at: 0, as, code: a.error.code, text: a.error.message });
    return a;
  }

  async pause(p: string | number): Promise<void> {
    if (p === 'events') {
      const got = await this.live!.nextEvents(this.o.timeoutMs ?? 30_000);
      if (!got) this.write({ kind: 'note', at: 0, text: 'No events arrived before the timeout' });
      return;
    }
    await new Promise((r) => setTimeout(r, parseDuration(p)));
  }

  close(): void {
    this.live?.close();
  }
}

const eventOut = (e: GameEvent): Output => ({ kind: 'event', at: e.at, text: e.text, event: e });

export async function connect(o: ConnectOpts): Promise<number> {
  if (!o.channel) throw new CliError('give --channel <id>');
  const writeLine = (line: string) => o.output.write(`${line}\n`);
  const write = (x: Output) => writeLine(formatOutput(x, !!o.json));
  const s = new Session(new Client(o.url, o.channel), o, write);
  try {
    if (!o.script) {
      const { interactive } = await import('./connect-interactive');
      await s.open();
      return await interactive(s, o, write, writeLine);
    }
    let text: string;
    try { text = readFileSync(o.script, 'utf8'); } catch { throw new CliError(`can't read ${o.script}`); }
    const lines = text.split('\n').map((l, i) => [l, i + 1] as const).filter(([l]) => l.trim());
    const parsed = lines.map(([l, n]) => parseConnectLine(l, n));
    await s.open();
    for (const line of parsed) {
      s.check();
      if ('pause' in line) await s.pause(line.pause);
      else await s.send(line.as, line.command);
    }
    await new Promise((r) => setTimeout(r, 100));
    s.check();
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      writeLine(o.json ? JSON.stringify({ kind: 'error', text: e.message }) : `error: ${e.message}`);
      return 1;
    }
    throw e;
  } finally {
    s.close();
  }
}
