import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { formatIssue, ValidationError } from '@dndm/engine';
import { loadChannel } from '@dndm/pack-loader';
import { createChannel, defaultConfig, migrate, officialBundles, Secrets, startServer, Store } from '@dndm/server';
import { CliError } from './ids';

export interface ServerCliOpts {
  env: NodeJS.ProcessEnv; json?: boolean; port?: string; host?: string; config?: string; seed?: number;
  write: (line: string) => void;
  /** Resolves when `start` should stop. Defaults to SIGINT or SIGTERM. */
  until?: Promise<void>;
}

function need(env: NodeJS.ProcessEnv, name: 'DATABASE_URL' | 'DNDM_SECRET'): string {
  const v = env[name];
  if (!v) throw new CliError(name === 'DNDM_SECRET' ? 'set DNDM_SECRET (16+ characters)' : 'set DATABASE_URL (for example postgres://dndm:dndm@localhost:5455/dndm)');
  if (name === 'DNDM_SECRET' && v.length < 16) throw new CliError('DNDM_SECRET must be at least 16 characters');
  return v;
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
      const srv = await startServer({
        databaseUrl: need(o.env, 'DATABASE_URL'), secret: need(o.env, 'DNDM_SECRET'), dev, port, host: o.host,
        log: (msg, extra) => o.write(JSON.stringify({ kind: 'log', text: msg, ...extra })),
      });
      say('note', `dndm server listening on ${srv.url}${dev ? ' (dev login on)' : ''}`, { url: srv.url });
      await (o.until ?? stopSignal());
      await srv.close();
      return 0;
    }
    default:
      throw new CliError('Usage: dndm server <migrate | create-channel <name> | start [--port n]>');
  }
}
