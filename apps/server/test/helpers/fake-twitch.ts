import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import type { TwitchUser } from '../../src/twitch/api';

type Kind = 'pubsub' | 'users' | 'token' | 'revoke';

export interface FakeRequest {
  method: string; path: string; headers: Record<string, string>; body: unknown;
  query: Record<string, string | string[]>;
}

export interface FakeTwitch {
  apiBase: string; authBase: string;
  /** The Client-Id the fake accepts. */
  clientId: string;
  requests: FakeRequest[];
  addUser(u: TwitchUser): void;
  codeFor(userId: string): string;
  pubsub(): { broadcasterId: string; message: unknown }[];
  failNext(kind: Kind, times?: number): void;
  /** The next PubSub send (or Get Users, with `kind`) answers 429 with this Ratelimit-Reset, in Unix seconds. */
  rateLimitNext(resetSec: number, kind?: 'pubsub' | 'users'): void;
  hangNext(kind: 'pubsub' | 'users'): void;
  /** Makes every issued app token fail with 401; `always` keeps failing tokens issued from now on too. */
  revokeAppTokens(opts?: { always?: boolean }): void;
  close(): Promise<void>;
}

export interface FakeTwitchOptions { clientId?: string; appTokenTtlSec?: number }

export async function fakeTwitch(opts: FakeTwitchOptions = {}): Promise<FakeTwitch> {
  const clientId = opts.clientId ?? 'fake-client-id';
  const ttl = opts.appTokenTtlSec ?? 3600;
  const app = Fastify();
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const requests: FakeRequest[] = [];
  const users = new Map<string, TwitchUser>();
  const userTokens = new Map<string, string>(); // token -> user id
  const codes = new Map<string, string>(); // code -> user id
  const appTokens = new Set<string>();
  let nextApp = 1;
  let revokeAlways = false;
  const failures = new Map<Kind, number>();
  const rateLimits = new Map<'pubsub' | 'users', number>();
  const hangs: ('pubsub' | 'users')[] = [];
  const pubsubLog: { broadcasterId: string; message: unknown }[] = [];
  const releases = new Set<() => void>();

  const takeFailure = (k: Kind) => {
    const n = failures.get(k) ?? 0;
    if (n <= 0) return false;
    failures.set(k, n - 1);
    return true;
  };
  const takeHang = (k: 'pubsub' | 'users') => {
    const i = hangs.indexOf(k);
    if (i < 0) return false;
    hangs.splice(i, 1);
    return true;
  };
  const takeRateLimit = (k: 'pubsub' | 'users') => {
    const reset = rateLimits.get(k);
    rateLimits.delete(k);
    return reset;
  };
  const hold = () => new Promise<void>((resolve) => { releases.add(resolve); });

  app.addHook('preHandler', async (req) => {
    requests.push({
      method: req.method, path: req.url.split('?')[0]!, headers: { ...req.headers } as Record<string, string>,
      body: req.body, query: { ...(req.query as Record<string, string | string[]>) },
    });
  });

  const bearer = (h: string | undefined) => h?.replace(/^Bearer /, '') ?? '';
  const clientOk = (h: unknown) => h === clientId;
  const asUser = (u: TwitchUser) => ({ id: u.id, login: u.login, display_name: u.displayName });

  app.post('/oauth2/token', async (req, reply) => {
    if (takeFailure('token')) return reply.code(500).send({ message: 'boom' });
    const b = req.body as Record<string, string>;
    if (b.client_id !== clientId) return reply.code(400).send({ message: 'invalid client' });
    if (b.grant_type === 'client_credentials') {
      const token = `app-${nextApp++}`;
      if (!revokeAlways) appTokens.add(token);
      return { access_token: token, expires_in: ttl, token_type: 'bearer' };
    }
    if (b.grant_type === 'authorization_code') {
      const userId = codes.get(b.code ?? '');
      if (!userId) return reply.code(400).send({ message: 'invalid code' });
      codes.delete(b.code!);
      const token = `user-${userId}-${userTokens.size + 1}`;
      userTokens.set(token, userId);
      return { access_token: token, token_type: 'bearer' };
    }
    return reply.code(400).send({ message: 'bad grant_type' });
  });

  app.post('/oauth2/revoke', async (req, reply) => {
    if (takeFailure('revoke')) return reply.code(500).send({ message: 'boom' });
    const b = req.body as Record<string, string>;
    userTokens.delete(b.token ?? '');
    return reply.code(200).send();
  });

  app.get('/helix/users', async (req, reply) => {
    if (takeHang('users')) { await hold(); return reply; }
    const reset = takeRateLimit('users');
    if (reset !== undefined) return reply.code(429).header('ratelimit-reset', String(reset)).send({ message: 'rate limited' });
    if (takeFailure('users')) return reply.code(500).send({ message: 'boom' });
    if (!clientOk(req.headers['client-id'])) return reply.code(401).send({ message: 'bad client id' });
    const token = bearer(req.headers.authorization);
    const q = req.query as Record<string, string | string[]>;
    const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    if (appTokens.has(token)) {
      const ids = list(q.id);
      const logins = list(q.login);
      if (!ids.length && !logins.length) return reply.code(400).send({ message: 'missing id or login' });
      const found = [...users.values()].filter((u) => ids.includes(u.id) || logins.includes(u.login));
      return { data: found.map(asUser) };
    }
    const owner = userTokens.get(token);
    if (owner) {
      const u = users.get(owner);
      return { data: u ? [asUser(u)] : [] };
    }
    return reply.code(401).send({ message: 'invalid token' });
  });

  app.post('/helix/extensions/pubsub', async (req, reply) => {
    if (takeHang('pubsub')) { await hold(); return reply; }
    const reset = takeRateLimit('pubsub');
    if (reset !== undefined) {
      return reply.code(429).header('ratelimit-reset', String(reset)).send({ message: 'rate limited' });
    }
    if (takeFailure('pubsub')) return reply.code(500).send({ message: 'boom' });
    if (!clientOk(req.headers['client-id'])) return reply.code(401).send({ message: 'bad client id' });
    if (!bearer(req.headers.authorization)) return reply.code(401).send({ message: 'missing jwt' });
    const b = req.body as { broadcaster_id: string; message: string };
    pubsubLog.push({ broadcasterId: b.broadcaster_id, message: JSON.parse(b.message) });
    return reply.code(204).send();
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let closing: Promise<void> | null = null;

  return {
    apiBase: `${base}/helix`, authBase: `${base}/oauth2`, clientId, requests,
    addUser: (u) => { users.set(u.id, u); },
    codeFor(userId) {
      const code = `code-${userId}-${codes.size + 1}`;
      codes.set(code, userId);
      return code;
    },
    pubsub: () => pubsubLog,
    failNext: (kind, times = 1) => { failures.set(kind, (failures.get(kind) ?? 0) + times); },
    rateLimitNext: (resetSec, kind = 'pubsub') => { rateLimits.set(kind, resetSec); },
    hangNext: (kind) => { hangs.push(kind); },
    revokeAppTokens(o) { appTokens.clear(); if (o?.always) revokeAlways = true; },
    close() {
      closing ??= (async () => {
        for (const r of releases) r();
        releases.clear();
        app.server.closeAllConnections();
        await app.close();
      })();
      return closing;
    },
  };
}
