import { randomUUID } from 'node:crypto';
import type { Description, View } from '@dndm/engine';
import type { Answer, ServerMessage } from '@dndm/protocol';
import { CliError } from './ids';

export interface Live {
  welcome: ServerMessage;
  on(fn: (m: ServerMessage) => void): () => void;
  /** Resolves true when the next `events` message arrives, false after timeoutMs. */
  nextEvents(timeoutMs: number): Promise<boolean>;
  close(): void;
}

/** A small HTTP + WebSocket client for one channel (spec 2a §4, §5). */
export class Client {
  constructor(readonly base: string, readonly channel: string) {}

  private async call(path: string, init: { method: string; token?: string; body?: unknown }): Promise<{ status: number; body: any }> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.base), {
        method: init.method,
        headers: {
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new CliError(`can't reach the server at ${this.base}`);
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  async login(viewer: string): Promise<string> {
    const r = await this.call('/dev/login', { method: 'POST', body: { channel: this.channel, viewer } });
    // Without dev mode the route doesn't exist, so Fastify answers its own 404 (no `ok` field).
    if (r.status === 404 && r.body?.ok === undefined) throw new CliError('dev login is off on this server (start it with DNDM_DEV=1)');
    if (!r.body?.ok) throw new CliError(`dev login for ${viewer} failed: ${r.body?.error?.message ?? r.status}`);
    return r.body.token as string;
  }

  async command(token: string, command: Record<string, unknown>, id: string = randomUUID()): Promise<Answer> {
    const r = await this.call(`/channels/${this.channel}/commands`, { method: 'POST', token, body: { id, command } });
    if (!r.body) throw new CliError(`the server answered ${r.status} with no body`);
    return r.body as Answer;
  }

  async view(token: string): Promise<View> {
    const r = await this.call(`/channels/${this.channel}/view`, { method: 'GET', token });
    if (!r.body?.ok) throw new CliError(r.body?.error?.message ?? `view failed (${r.status})`);
    return r.body.view as View;
  }

  async describe(token: string): Promise<Description> {
    const r = await this.call(`/channels/${this.channel}/describe`, { method: 'GET', token });
    if (!r.body?.ok) throw new CliError(r.body?.error?.message ?? `describe failed (${r.status})`);
    return r.body.describe as Description;
  }

  live(token: string): Promise<Live> {
    const url = new URL(`/channels/${this.channel}/live`, this.base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { reject(new CliError(`can't reach the server at ${this.base}`)); return; }
      const listeners = new Set<(m: ServerMessage) => void>();
      let welcomed = false;
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token })));
      ws.addEventListener('error', () => { if (!welcomed) reject(new CliError(`can't reach the server at ${this.base}`)); });
      ws.addEventListener('close', (ev) => {
        if (!welcomed) { reject(new CliError(`the server refused the live connection (${ev.code} ${ev.reason})`)); return; }
        // After the welcome, a close ends the session (README decision 12): tell the listeners.
        const m: ServerMessage = { type: 'error', code: 'disconnected', message: `the live connection closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})` };
        for (const fn of listeners) fn(m);
      });
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data)) as ServerMessage;
        if (!welcomed && m.type === 'welcome') {
          welcomed = true;
          resolve({
            welcome: m,
            on: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
            nextEvents: (timeoutMs) => new Promise((done) => {
              const fn = (x: ServerMessage) => {
                if (x.type !== 'events') return;
                clearTimeout(timer);
                listeners.delete(fn);
                done(true);
              };
              const timer = setTimeout(() => { listeners.delete(fn); done(false); }, timeoutMs);
              listeners.add(fn);
            }),
            close: () => ws.close(),
          });
          return;
        }
        for (const fn of listeners) fn(m);
      });
    });
  }
}
