import { join } from 'node:path';
import { createEngine, type PackBundle } from '@dndm/engine';
import { listPackDirs, loadChannel, loadPacks, repoRoot } from '@dndm/pack-loader';
import { hashToken, newToken, Secrets } from './crypto';
import { STATE_VERSION } from './room';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { RateLimiter } from './auth';
import { type Clock, realClock } from './clock';
import { Hub } from './hub';
import { RoomManager } from './room-manager';
import { Store } from './store';

/** Every official pack, code included: any channel may enable any of them (spec 2a §2.2). */
export function officialBundles(): Promise<PackBundle[]> {
  return loadPacks(listPackDirs());
}

export function defaultConfig(): Record<string, unknown> {
  return loadChannel(join(repoRoot(), 'channels', 'default.yaml')) as Record<string, unknown>;
}

/** Spec 2a §8.1: validates the config, creates the channel and its room, returns the tokens. */
export async function createChannel(o: {
  store: Store; secrets: Secrets; bundles: PackBundle[]; name: string; config: Record<string, unknown>; seed: number;
}): Promise<{ id: string; dockToken: string; overlayToken: string }> {
  const engine = createEngine({ packs: o.bundles, channel: o.config });
  const g = engine.newGame({ seed: o.seed });
  if (g.version !== STATE_VERSION) throw new Error(`The engine's game version ${g.version} isn't supported by this server`);
  const dockToken = newToken();
  const overlayToken = newToken();
  const id = await o.store.createChannel({
    name: o.name, config: o.config,
    room: { stateVersion: g.version, clock: g.clock, rng: g.rng, seq: g.seq, session: g.session, recentRequests: [] },
    dock: { hash: hashToken(dockToken), enc: o.secrets.encrypt(dockToken) },
    overlay: { hash: hashToken(overlayToken), enc: o.secrets.encrypt(overlayToken) },
  });
  return { id, dockToken, overlayToken };
}

export interface ServerOpts {
  databaseUrl: string; secret: string; dev?: boolean; port?: number; host?: string;
  clock?: Clock; rateLimits?: boolean; bundles?: PackBundle[];
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}
export interface RunningServer {
  app: FastifyInstance; manager: RoomManager; hub: Hub; store: Store; secrets: Secrets; url: string;
  close(): Promise<void>;
}

/** Spec 2a §6.4 and §6.6: take the lock, load Rooms that need running, then listen. */
export async function startServer(opts: ServerOpts): Promise<RunningServer> {
  const store = Store.open(opts.databaseUrl);
  if (!(await store.tryLock())) {
    await store.close();
    throw new Error('Another dndm server is already running against this database');
  }
  try {
    const clock = opts.clock ?? realClock;
    const secrets = new Secrets(opts.secret);
    const bundles = opts.bundles ?? (await officialBundles());
    const manager = new RoomManager({ store, clock, secrets, bundles, log: opts.log });
    await manager.boot();
    manager.startSweeper();
    const hub = new Hub();
    const app = await buildApp({ manager, hub, secrets, limiter: new RateLimiter(clock, opts.rateLimits ?? true), dev: !!opts.dev });
    const url = opts.port !== undefined ? await app.listen({ port: opts.port, host: opts.host ?? '127.0.0.1' }) : '';
    return {
      app, manager, hub, store, secrets, url,
      async close() {
        await app.close();
        manager.close();
        await store.close();
      },
    };
  } catch (e) {
    await store.close();
    throw e;
  }
}
