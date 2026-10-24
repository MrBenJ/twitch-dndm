import type { TwitchConfig } from './config';
import { join } from 'node:path';
import { createEngine, type PackBundle } from '@dndm/engine';
import { listPackDirs, loadChannel, loadPacks, repoRoot } from '@dndm/pack-loader';
import { hashToken, newToken, Secrets } from './crypto';
import { STATE_VERSION } from './room';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { registerExt } from './ext';
import { Cookies } from './session';
import { registerSignup, type SignupMode } from './signup';
import { RateLimiter } from './auth';
import { type Clock, realClock } from './clock';
import { Hub } from './hub';
import { RoomManager } from './room-manager';
import { type ChannelRow, Store } from './store';
import { HttpTwitchClient, type TwitchClient } from './twitch/api';
import { TwitchLayer } from './twitch/layer';

/** Shutdown step 3's budget (spec 2b §7.4). */
const LAYER_SHUTDOWN_MS = 10_000;
/** How long shutdown waits for the HTTP server once its connections are cut, at least. */
const LAST_CLOSE_MS = 1000;

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
  twitchId?: string;
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
    ...(o.twitchId !== undefined ? { twitchId: o.twitchId } : {}),
  });
  return { id, dockToken, overlayToken };
}

export interface ServerOpts {
  databaseUrl: string; secret: string; dev?: boolean; port?: number; host?: string;
  clock?: Clock; rateLimits?: boolean; bundles?: PackBundle[];
  /** How long close() waits for in-flight Room inputs before giving up (default 15 000). */
  idleTimeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Twitch extension settings; without them there is no Twitch layer and no Broadcasters. */
  twitch?: TwitchConfig;
  /** Replaces the HTTP Twitch client (tests). */
  twitchClient?: TwitchClient;
  /** Who may sign up with Twitch (spec 2b §4.3): allowlisted accounts only (the default), or anyone. */
  signup?: SignupMode;
}
export interface RunningServer {
  app: FastifyInstance; manager: RoomManager; hub: Hub; store: Store; secrets: Secrets; url: string;
  /** The Twitch layer, or null when Twitch isn't configured. */
  layer: TwitchLayer | null;
  close(): Promise<void>;
}

/** Spec 2a §6.4 and §6.6: take the lock, load Rooms that need running, then listen. */
export async function startServer(opts: ServerOpts): Promise<RunningServer> {
  const store = Store.open(opts.databaseUrl);
  if (!(await store.tryLock())) {
    await store.close();
    throw new Error('Another dndm server is already running against this database');
  }
  let app: FastifyInstance | undefined;
  try {
    const clock = opts.clock ?? realClock;
    const secrets = new Secrets(opts.secret);
    const bundles = opts.bundles ?? (await officialBundles());
    const client = opts.twitch ? opts.twitchClient ?? new HttpTwitchClient(opts.twitch, clock) : null;
    const layer = opts.twitch && client
      ? new TwitchLayer({ config: opts.twitch, client, clock, secrets, ...(opts.log ? { log: opts.log } : {}) })
      : null;
    const manager = new RoomManager(
      { store, clock, secrets, bundles, log: opts.log, ...(layer ? { broadcast: (c: ChannelRow) => layer.wantsBroadcast(c) } : {}) },
      layer ?? undefined,
    );
    const hub = new Hub();
    const health: { ready: boolean; closing?: boolean } = { ready: false };
    const limiter = new RateLimiter(clock, opts.rateLimits ?? true);
    app = await buildApp({ manager, hub, secrets, limiter, dev: !!opts.dev, health, log: opts.log });
    if (opts.twitch && layer && client) {
      registerExt(app, { manager, layer, store, limiter, config: opts.twitch, client, clock, ...(opts.log ? { log: opts.log } : {}) });
      registerSignup(app, {
        store, manager, secrets, cookies: new Cookies(secrets), client, config: opts.twitch, signup: opts.signup ?? 'allowlist', bundles,
        clock, ...(opts.log ? { log: opts.log } : {}),
      });
    }
    const running = app;
    const url = opts.port !== undefined ? await app.listen({ port: opts.port, host: opts.host ?? '127.0.0.1' }) : '';
    await manager.boot();
    manager.startSweeper();
    health.ready = true;
    const idleTimeoutMs = opts.idleTimeoutMs ?? 15_000;
    const log = opts.log;

    async function shutdown(): Promise<void> {
      health.ready = false;
      health.closing = true;
      const deadline = performance.now() + idleTimeoutMs;
      const until = (ms: number) => {
        let timer: NodeJS.Timeout | undefined;
        const p = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), Math.max(0, ms)); });
        return { p, cancel: () => clearTimeout(timer) };
      };
      try {
        // 1. Stop accepting requests. Requests in flight carry on; their responses close their connections.
        const appClosed = running.close();
        appClosed.catch(() => {});
        // 2. Let inputs already in a Room queue finish, but not forever.
        const idleWait = until(idleTimeoutMs);
        const idle = await Promise.race([manager.idle().then(() => 'idle' as const), idleWait.p]);
        idleWait.cancel();
        if (idle === 'timeout') log?.('shutdown: rooms still busy after idle timeout', { idleTimeoutMs });
        // In-flight responses get the rest of the budget, then any connection still open is cut.
        const rest = until(deadline - performance.now());
        try { await Promise.race([appClosed, rest.p]); } finally { rest.cancel(); }
        running.server.closeAllConnections();
        // Cut connections let app.close() finish; don't let it hold up the rest of shutdown if it doesn't.
        const last = until(Math.max(LAST_CLOSE_MS, deadline - performance.now()));
        try {
          if ((await Promise.race([appClosed.then(() => 'closed' as const), last.p])) === 'timeout') log?.('shutdown: HTTP server still closing');
        } finally { last.cancel(); }
      } finally {
        // 3. Each Broadcaster's last tick, waiting at most 10 s more (spec 2b §7.4). Runs even if closing the HTTP app
        // failed; its own failure mustn't keep the Rooms or the database open.
        if (layer) {
          try { await layer.shutdown(LAYER_SHUTDOWN_MS); } catch (e) { log?.('shutdown: Twitch layer failed', { error: String(e) }); }
        }
        // 4. Unload the Rooms, then close the database, which releases the lock.
        manager.close();
        await store.close();
      }
    }

    let closing: Promise<void> | null = null;
    return {
      app: running, manager, hub, store, secrets, url, layer,
      close() {
        closing ??= shutdown();
        return closing;
      },
    };
  } catch (e) {
    await app?.close().catch(() => {});
    await store.close();
    throw e;
  }
}
