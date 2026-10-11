import { type Command, type Engine, type GameEvent, type GameState, parseDuration } from '@dndm/engine';
import { CliError } from './ids';
import type { ScriptLine } from './parse';

export type { ScriptLine } from './parse';

const VIEWER = new Set(['join', 'leave', 'use', 'equip', 'unequip', 'respond']);

export interface Output {
  kind: 'event' | 'rejected' | 'note';
  at: number;
  text: string;
  event?: GameEvent;
  as?: string;
  code?: string;
}

const fromEvent = (e: GameEvent): Output => ({ kind: 'event', at: e.at, text: e.text, event: e });

export class Driver {
  game: GameState;
  now = 0;
  readonly script: ScriptLine[] = [];

  constructor(readonly engine: Engine, seed: number) {
    this.game = engine.newGame({ seed });
  }

  exec(line: ScriptLine): Output[] {
    this.script.push(line);
    if ('wait' in line) {
      this.now += parseDuration(line.wait);
      return this.advance();
    }
    if ('next' in line) {
      const t = this.engine.nextWakeTime(this.game);
      if (t === null) return [{ kind: 'note', at: this.now, text: 'Nothing is scheduled' }];
      this.now = Math.max(this.now, t);
      return this.advance();
    }
    const command = (line.as !== 'streamer' && VIEWER.has(String(line.command.type))
      ? { ...line.command, character: line.as }
      : line.command) as unknown as Command;
    const r = this.engine.apply(this.game, command, this.now);
    if (!r.ok) return [{ kind: 'rejected', at: this.now, as: line.as, code: r.error.code, text: r.error.message }];
    this.game = r.game;
    return r.events.map(fromEvent);
  }

  private advance(): Output[] {
    const r = this.engine.advance(this.game, this.now);
    this.game = r.game;
    return r.events.map(fromEvent);
  }
}

export function formatOutput(o: Output, json: boolean): string {
  if (json) {
    if (o.kind === 'event') return JSON.stringify({ kind: 'event', ...o.event });
    return JSON.stringify({ kind: o.kind, at: o.at, ...(o.as ? { as: o.as } : {}), ...(o.code ? { code: o.code } : {}), text: o.text });
  }
  const t = `[${(o.at / 1000).toFixed(1).padStart(7)}s]`;
  if (o.kind === 'rejected') return `${t} ✗ ${o.as}: ${o.text} (${o.code})`;
  if (o.kind === 'note') return `${t} · ${o.text}`;
  return `${t} ${o.text}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseScriptLine(text: string, lineNo: number): ScriptLine {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { throw new CliError(`line ${lineNo}: not JSON (${(e as Error).message})`); }
  if (isObj(v) && 'wait' in v && (typeof v.wait === 'string' || typeof v.wait === 'number')) {
    try { parseDuration(v.wait); } catch (e) { throw new CliError(`line ${lineNo}: ${(e as Error).message}`); }
    return { wait: v.wait };
  }
  if (isObj(v) && v.next === true) return { next: true };
  if (isObj(v) && typeof v.as === 'string' && isObj(v.command) && typeof v.command.type === 'string') return { as: v.as, command: v.command };
  throw new CliError(`line ${lineNo}: expected {"wait"}, {"next"} or {"as", "command"}`);
}
