import websocket from '@fastify/websocket';
import {
  type Answer, clientMessageSchema, commandRequestSchema, devLoginSchema, httpStatus, type ServerMessage, WS_CLOSE,
} from '@dndm/protocol';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { authenticate, limitKey, type RateLimiter } from './auth';
import { hashToken, isViewerToken, type Secrets } from './crypto';
import type { Conn, Hub } from './hub';
import { type Room, RoomClosedError } from './room';
import type { RoomManager } from './room-manager';

export interface AppDeps {
  manager: RoomManager; hub: Hub; secrets: Secrets; limiter: RateLimiter; dev: boolean;
  /** `/health` answers 503 until `ready` turns true (set once boot has finished). Omitted means always ready. */
  health?: { ready: boolean };
  /** How long a WebSocket may stay silent before its hello (README decision 7). */
  helloTimeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

type ChannelReq = FastifyRequest<{ Params: { channel: string } }>;
const fail = (code: string, message: string): Answer => ({ ok: false, error: { code, message } });
const bearer = (req: FastifyRequest) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
const reply = (res: FastifyReply, body: Answer | ({ ok: true } & Record<string, unknown>)) =>
  res.code(body.ok ? 200 : httpStatus(body.error.code)).send(body);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // A hello is tiny; refuse anything big before anyone has authenticated.
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  /** A Room handle can go stale if it's unloaded in between; ask again once (final review #3). */
  async function liveRoom(id: string): Promise<Room | null> {
    const room = await deps.manager.get(id);
    return room?.closed ? deps.manager.get(id) : room;
  }

  async function roomAndSender(req: ChannelReq, res: FastifyReply) {
    const room = await liveRoom(req.params.channel);
    if (!room) { reply(res, fail('unknown-channel', 'No such channel')); return null; }
    const who = authenticate(room, bearer(req), deps.secrets);
    if ('code' in who) return { room, who: null, error: who };
    if (!deps.limiter.take(who.role, limitKey(room, who))) { reply(res, fail('rate-limited', 'Too many requests; slow down')); return null; }
    return { room, who, error: null };
  }

  // No token and no rate limit: load balancers and uptime checks call this.
  app.get('/health', async (_req, res) => {
    const ready = deps.health?.ready ?? true;
    return res.code(ready ? 200 : 503).send({ ok: ready });
  });

  app.post('/channels/:channel/commands', async (req: ChannelReq, res) => {
    const body = commandRequestSchema.safeParse(req.body);
    if (!body.success) return reply(res, fail('bad-command', body.error.issues[0]?.message ?? 'Bad request'));
    const r = await roomAndSender(req, res);
    if (!r) return res;
    if (!r.who) {
      const token = bearer(req);
      if (token && !isViewerToken(token)) {
        const replay = await r.room.replayRevoked(hashToken(token), body.data.id);
        if (replay) return reply(res, replay);
      }
      return reply(res, fail(r.error!.code, r.error!.message));
    }
    try {
      return reply(res, await r.room.command(r.who, body.data.id, body.data.command));
    } catch (e) {
      if (!(e instanceof RoomClosedError)) throw e;
      const fresh = await deps.manager.get(req.params.channel);
      if (!fresh) return reply(res, fail('unknown-channel', 'No such channel'));
      return reply(res, await fresh.command(r.who, body.data.id, body.data.command));
    }
  });

  app.get('/channels/:channel/view', async (req: ChannelReq, res) => {
    const r = await roomAndSender(req, res);
    if (!r) return res;
    if (!r.who) return reply(res, fail(r.error!.code, r.error!.message));
    try {
      return reply(res, { ok: true, view: await r.room.view(r.who) });
    } catch (e) {
      if (!(e instanceof RoomClosedError)) throw e;
      const fresh = await deps.manager.get(req.params.channel);
      if (!fresh) return reply(res, fail('unknown-channel', 'No such channel'));
      return reply(res, { ok: true, view: await fresh.view(r.who) });
    }
  });

  app.get('/channels/:channel/describe', async (req: ChannelReq, res) => {
    const r = await roomAndSender(req, res);
    if (!r) return res;
    if (!r.who) return reply(res, fail(r.error!.code, r.error!.message));
    return reply(res, { ok: true, describe: r.room.describe() });
  });

  app.get('/channels/:channel/live', { websocket: true }, (socket, req) => {
    const channelId = (req.params as { channel: string }).channel;
    let room: Room | null = null;
    let conn: Conn | null = null;
    let greeted = false;
    let closed = false;
    const send = (m: ServerMessage) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m)); };
    const refuse = (code: number, error: string, message: string) => { send({ type: 'error', code: error, message }); socket.close(code, message); };
    const timer = setTimeout(() => refuse(WS_CLOSE.unauthorized, 'unauthorized', 'Say hello first'), deps.helloTimeoutMs ?? 5000);
    socket.on('message', async (raw) => {
      if (greeted) return;
      greeted = true;
      clearTimeout(timer);
      let token: string;
      try {
        token = clientMessageSchema.parse(JSON.parse(String(raw))).token;
      } catch {
        return refuse(WS_CLOSE.unauthorized, 'unauthorized', 'The first message must be a hello with a token');
      }
      try {
        room = await liveRoom(channelId);
        if (closed) return;
        if (!room) return refuse(WS_CLOSE.unauthorized, 'unknown-channel', 'No such channel');
        const who = authenticate(room, token, deps.secrets);
        if ('code' in who) return refuse(WS_CLOSE.unauthorized, who.code, who.message);
        if (!deps.limiter.take(who.role, limitKey(room, who))) return refuse(WS_CLOSE.rateLimited, 'rate-limited', 'Too many connections; slow down');
        conn = {
          role: who.role, character: who.role === 'viewer' ? who.character : null, tokenHash: who.tokenHash,
          send, close: (code, reason) => socket.close(code, reason),
        };
        await deps.hub.add(room, conn);
      } catch (e) {
        // Never let one connection's failure become an unhandled rejection (final review #1).
        if (room && conn) deps.hub.remove(room, conn);
        deps.log?.('live connection failed', { channel: channelId, error: String(e) });
        if (!closed) refuse(1011, 'internal', 'Something went wrong on the server');
      }
    });
    socket.on('close', () => {
      closed = true;
      clearTimeout(timer);
      if (room && conn) deps.hub.remove(room, conn);
    });
  });

  if (deps.dev) {
    app.post('/dev/login', async (req, res) => {
      const body = devLoginSchema.safeParse(req.body);
      if (!body.success) return reply(res, fail('bad-command', body.error.issues[0]?.message ?? 'Bad request'));
      const room = await deps.manager.get(body.data.channel);
      if (!room) return reply(res, fail('unknown-channel', 'No such channel'));
      const character = `dev:${body.data.viewer.toLowerCase()}`;
      return reply(res, { ok: true, token: deps.secrets.signViewer({ channel: room.channel.id, character }), character });
    });
  }

  return app;
}
