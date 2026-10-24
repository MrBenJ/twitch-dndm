import { type Answer, commandRequestSchema, httpStatus } from '@dndm/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RateLimiter } from './auth';
import type { Clock } from './clock';
import type { TwitchConfig } from './config';
import { type Room, RoomClosedError, type Sender } from './room';
import type { RoomManager } from './room-manager';
import type { Store } from './store';
import { type TwitchClient, TwitchError } from './twitch/api';
import { verifyExtensionJwt } from './twitch/jwt';
import type { TwitchLayer } from './twitch/layer';

export interface ExtDeps {
  manager: RoomManager; layer: TwitchLayer; store: Store; limiter: RateLimiter; config: TwitchConfig; client: TwitchClient;
  clock: Clock;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

type Body = Answer | ({ ok: true } & Record<string, unknown>) | ({ ok: false; error: { code: string; message: string } } & Record<string, unknown>);

const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message } });
const send = (res: FastifyReply, body: Body) => res.code(body.ok ? 200 : httpStatus(body.error.code)).send(body);
const bearer = (req: FastifyRequest) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];

/** Who is calling, worked out from the extension JWT (spec 2b §4.1). */
interface Caller {
  channelId: string;
  /** The viewer `twitch:<user_id>` when identity is shared, else null. */
  sender: (Sender & { role: 'viewer' }) | null;
}

/**
 * The extension's routes (spec 2b §4.1, §4.2, §5.6). Only extension JWTs work here; the channel comes from the JWT.
 * Registered in their own scope, so their CORS and error handling don't touch the 2a routes.
 */
export function registerExt(app: FastifyInstance, deps: ExtDeps): void {
  const extOrigin = `https://${deps.config.clientId}.ext-twitch.tv`;
  const secrets = [deps.config.extensionSecret, ...(deps.config.extensionSecretPrevious ? [deps.config.extensionSecretPrevious] : [])];
  /** Twitch ID → channel ID, once found. A miss isn't kept: the streamer may sign up any time. */
  const channels = new Map<string, string>();

  void app.register(async (scope) => {
    scope.addHook('onSend', async (req, res, payload) => {
      if (req.headers.origin === extOrigin) {
        res.header('access-control-allow-origin', extOrigin);
        res.header('vary', 'Origin');
      }
      return payload;
    });

    // Every answer carries `ok` (README decision 8), unexpected errors included.
    scope.setErrorHandler(async (err: { statusCode?: number; message?: string }, req, res) => {
      const status = err.statusCode ?? 500;
      if (status < 500) return res.code(status).send(fail('bad-command', err.message ?? 'Bad request'));
      deps.log?.('ext route failed', { url: req.url, error: String(err) });
      return res.code(500).send(fail('internal', 'Something went wrong on the server'));
    });

    scope.options('/ext/*', async (req, res) => {
      if (req.headers.origin === extOrigin) {
        res.header('access-control-allow-headers', 'Authorization, Content-Type');
        res.header('access-control-allow-methods', 'GET, POST');
      }
      return res.code(204).send();
    });

    /** Checks the JWT, finds the channel and takes from the rate limit. Sends the failure and returns null. */
    async function caller(req: FastifyRequest, res: FastifyReply): Promise<Caller | null> {
      const token = bearer(req);
      const claims = token ? verifyExtensionJwt(token, secrets, deps.clock.now()) : null;
      if (!claims) { send(res, fail('unauthorized', "That extension token isn't valid")); return null; }
      let channelId = channels.get(claims.channel_id);
      if (!channelId) {
        const row = await deps.store.channelByTwitchId(claims.channel_id);
        if (!row) { send(res, fail('unknown-channel', "This streamer hasn't set up the game yet.")); return null; }
        channelId = row.id;
        channels.set(claims.channel_id, channelId);
      }
      const who = claims.user_id !== undefined ? `twitch:${claims.user_id}` : `opaque:${claims.opaque_user_id}`;
      if (!deps.limiter.take('viewer', `viewer:${channelId}:${who}`)) { send(res, fail('rate-limited', 'Too many requests; slow down')); return null; }
      return { channelId, sender: claims.user_id !== undefined ? { role: 'viewer', character: `twitch:${claims.user_id}` } : null };
    }

    /**
     * Runs `fn` on the channel's Room. A handle that went stale in between is asked for again once (as app.ts's
     * liveRoom), and so is one that closes under `fn`. Null when the channel has no Room.
     */
    async function withRoom<T>(channelId: string, fn: (room: Room) => Promise<T>): Promise<T | null> {
      let room = await deps.manager.get(channelId);
      if (room?.closed) room = await deps.manager.get(channelId);
      if (!room) return null;
      try {
        return await fn(room);
      } catch (e) {
        if (!(e instanceof RoomClosedError)) throw e;
        const fresh = await deps.manager.get(channelId);
        return fresh ? fn(fresh) : null;
      }
    }

    const noRoom = () => fail('unknown-channel', "This streamer hasn't set up the game yet.");

    scope.get('/ext/view', async (req, res) => {
      const c = await caller(req, res);
      if (!c) return res;
      const sender = c.sender;
      const body = await withRoom(c.channelId, async (room) => (sender
        ? { ok: true as const, view: await room.view(sender), key: deps.layer.keyOf(c.channelId, sender.character) }
        : { ok: true as const, view: await deps.layer.publicView(room) }));
      return send(res, body ?? noRoom());
    });

    scope.post('/ext/commands', async (req, res) => {
      const c = await caller(req, res);
      if (!c) return res;
      const parsed = commandRequestSchema.safeParse(req.body);
      if (!parsed.success) return send(res, fail('bad-command', parsed.error.issues[0]?.message ?? 'Bad request'));
      const sender = c.sender;
      if (!sender) return send(res, fail('identity-required', 'Share your Twitch identity with the extension to play'));
      const { id: requestId } = parsed.data;
      let command: Record<string, unknown> & { type: string } = parsed.data.command;

      if (command.type === 'join') {
        // Spec 2b §4.2: the display name comes from Twitch, never from the client. Looked up before the Room's queue.
        const { name: _ignored, ...rest } = command;
        command = rest;
        const userId = sender.character.slice('twitch:'.length);
        let displayName: string | null = null;
        try {
          displayName = (await deps.client.usersById([userId])).find((u) => u.id === userId)?.displayName ?? null;
        } catch (e) {
          if (!(e instanceof TwitchError)) throw e;
          deps.log?.('Get Users failed on join', { channel: c.channelId, error: String(e) });
        }
        if (displayName !== null) {
          command = { ...command, name: displayName };
        } else if (!(await deps.store.characters(c.channelId, [sender.character])).length) {
          // A character that already exists keeps their stored name (no `name` sent); a new one can't be named.
          return send(res, fail('twitch-unavailable', "Twitch didn't answer; try joining again in a moment"));
        }
      }

      const body = await withRoom(c.channelId, async (room) => {
        const answer = await room.command(sender, requestId, command);
        // Successes and engine rejections carry the caller's fresh view and key; server errors don't.
        if (!answer.ok && httpStatus(answer.error.code) !== 200) return answer;
        return { ...answer, view: await room.view(sender), key: deps.layer.keyOf(c.channelId, sender.character) };
      });
      return send(res, body ?? noRoom());
    });

    scope.get('/ext/describe', async (req, res) => {
      const c = await caller(req, res);
      if (!c) return res;
      const body = await withRoom(c.channelId, async (room) => ({ ok: true as const, describe: deps.layer.describe(room) }));
      return send(res, body ?? noRoom());
    });

    scope.get('/ext/roster', async (req, res) => {
      const c = await caller(req, res);
      if (!c) return res;
      const body = await withRoom(c.channelId, async (room) => {
        const roster = deps.layer.roster(c.channelId);
        if (roster) return { ok: true as const, ...roster };
        // The Room is unloading (its Broadcaster has stopped): once it closes, the next one has a Broadcaster.
        await room.idle();
        throw new RoomClosedError();
      });
      return send(res, body ?? noRoom());
    });

    scope.get('/ext/party', async (req, res) => {
      const c = await caller(req, res);
      if (!c) return res;
      const body = await withRoom(c.channelId, async (room) => ({
        ok: true as const,
        members: (await room.view({ role: 'overlay' })).party.map((m) => ({
          key: deps.layer.keyOf(c.channelId, m.id), id: m.id, name: m.name, class: m.class, level: m.level,
          hp: m.hp, maxHp: m.maxHp, knockedOut: m.knockedOut, statuses: m.statuses,
        })),
      }));
      return send(res, body ?? noRoom());
    });
  });
}
