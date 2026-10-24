import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { formatIssue, ValidationError } from '@dndm/engine';
import { loadChannel } from '@dndm/pack-loader';
import {
  createChannel, defaultConfig, HttpTwitchClient, migrate, officialBundles, readTwitchConfig, realClock, Secrets, startServer, Store,
  TWITCH_API_BASE, TWITCH_AUTH_BASE, TwitchError, type TwitchClient,
} from '@dndm/server';
import { CliError } from './ids';

export interface ServerCliOpts {
  env: NodeJS.ProcessEnv; json?: boolean; port?: string; host?: string; config?: string; seed?: number;
  write: (line: string) => void;
  /** Resolves when `start` should stop. Defaults to SIGINT or SIGTERM. */
  until?: Promise<void>;
  /** For tests: stands in for the Twitch API in allow and disallow. */
  twitchClient?: TwitchClient;
}

function need(env: NodeJS.ProcessEnv, name: 'DATABASE_URL' | 'DNDM_SECRET'): string {
  const v = env[name];
  if (!v) throw new CliError(name === 'DNDM_SECRET' ? 'set DNDM_SECRET (16+ characters)' : 'set DATABASE_URL (for example postgres://dndm:dndm@localhost:5455/dndm)');
  if (name === 'DNDM_SECRET' && v.length < 16) throw new CliError('DNDM_SECRET must be at least 16 characters');
  return v;
}

function twitchFor(o: ServerCliOpts): TwitchClient {
  if (o.twitchClient) return o.twitchClient;
  const clientId = o.env.TWITCH_CLIENT_ID, clientSecret = o.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new CliError('set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET (from your Twitch developer console) to look up Twitch accounts');
  return new HttpTwitchClient({
    clientId, clientSecret, extensionSecret: '', extensionSecretPrevious: null, ownerId: '', publicUrl: '',
    apiBase: TWITCH_API_BASE, authBase: TWITCH_AUTH_BASE,
  }, realClock);
}

async function lookup(twitch: TwitchClient, login: string) {
  try { return (await twitch.usersByLogin([login]))[0] ?? null; } catch (e) {
    if (e instanceof TwitchError) throw new CliError(`Twitch lookup failed: ${e.message}`);
    throw e;
  }
}

const stopSignal = () => new Promise<void>((done) => {
  process.once('SIGINT', () => done());
  process.once('SIGTERM', () => done());
});

/** `dndm server <migrate|create-channel|start>` (spec 2a §8.1). */
export async function serverCli(sub: string | undefined, args: string[], o: ServerCliOpts): Promise<number> {
  const say = (kind: string, text: string, extra: Record<string, unknown> = {}) =>
    o.write(o.json ? JSON.stringify({ kind, text, ...extra }) : text);

  switch (sub) {
    case 'migrate': {
      await migrate(need(o.env, 'DATABASE_URL'));
      say('note', 'Migrations applied.');
      return 0;
    }
    case 'create-channel': {
      const name = args[0];
      if (!name) throw new CliError('Usage: dndm server create-channel <name> [--config file] [--seed n]');
      const url = need(o.env, 'DATABASE_URL');
      const secrets = new Secrets(need(o.env, 'DNDM_SECRET'));
      const config = (o.config ? loadChannel(resolve(o.config)) : defaultConfig()) as Record<string, unknown>;
      const store = Store.open(url);
      try {
        const seed = o.seed ?? randomInt(0, 2 ** 31);
        const made = await createChannel({ store, secrets, bundles: await officialBundles(), name, config, seed });
        if (o.json) {
          o.write(JSON.stringify({ kind: 'channel', name, ...made, seed }));
        } else {
          o.write(`Channel ${name} created (seed ${seed}).`);
          o.write(`  channel: ${made.id}`);
          o.write(`  dock token (keep it secret, it runs the game): ${made.dockToken}`);
          o.write(`  overlay token: ${made.overlayToken}`);
          o.write(`Connect as the streamer: dndm connect http://127.0.0.1:8787 --channel ${made.id} --dock ${made.dockToken}`);
        }
        return 0;
      } catch (e) {
        if (e instanceof ValidationError) { e.issues.forEach((i) => o.write(formatIssue(i))); return 1; }
        throw e;
      } finally {
        await store.close();
      }
    }
    case 'start': {
      const port = o.port !== undefined ? Number(o.port) : 8787;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError('--port must be a whole number from 0 to 65535');
      const dev = o.env.DNDM_DEV === '1';
      let twitch: ReturnType<typeof readTwitchConfig>;
      try { twitch = readTwitchConfig(o.env); } catch (e) { throw new CliError((e as Error).message); }
      if (twitch && dev) say('warning', 'DNDM_DEV=1 with Twitch configured: dev login is on');
      const srv = await startServer({
        databaseUrl: need(o.env, 'DATABASE_URL'), secret: need(o.env, 'DNDM_SECRET'), dev, port, host: o.host, twitch: twitch ?? undefined,
        log: (msg, extra) => o.write(JSON.stringify({ kind: 'log', text: msg, ...extra })),
      });
      say('note', `dndm server listening on ${srv.url}${dev ? ' (dev login on)' : ''}`, { url: srv.url });
      await (o.until ?? stopSignal());
      await srv.close();
      return 0;
    }
    case 'allow': {
      const login = args[0]?.toLowerCase();
      if (!login) throw new CliError('Usage: dndm server allow <login>');
      const url = need(o.env, 'DATABASE_URL');
      const user = await lookup(twitchFor(o), login);
      if (!user) throw new CliError(`No Twitch account is called ${login}`);
      const store = Store.open(url);
      try { await store.allow(user.id, user.login); } finally { await store.close(); }
      say('note', `${user.login} (${user.id}) may now sign up.`, { twitchId: user.id, login: user.login });
      return 0;
    }
    case 'disallow': {
      const login = args[0]?.toLowerCase();
      if (!login) throw new CliError('Usage: dndm server disallow <login>');
      const url = need(o.env, 'DATABASE_URL');
      const user = await lookup(twitchFor(o), login);
      const store = Store.open(url);
      try {
        const removed = (user && await store.disallowById(user.id)) || await store.disallowByLogin(login);
        if (!removed) throw new CliError(`${login} isn't on the allowlist`);
      } finally { await store.close(); }
      say('note', `${login} removed from the allowlist.`);
      return 0;
    }
    case 'allowlist': {
      const store = Store.open(need(o.env, 'DATABASE_URL'));
      try {
        const rows = await store.allowlist();
        if (o.json) rows.forEach((r) => o.write(JSON.stringify({ kind: 'allowed', ...r })));
        else if (!rows.length) o.write('The allowlist is empty.');
        else rows.forEach((r) => o.write(`${r.login}  ${r.twitchId}  added ${r.addedAt.toISOString()}`));
      } finally { await store.close(); }
      return 0;
    }
    default:
      throw new CliError('Usage: dndm server <migrate | create-channel <name> | start [--port n] | allow <login> | disallow <login> | allowlist>');
  }
}
