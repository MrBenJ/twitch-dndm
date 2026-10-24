import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TwitchConfig } from '../config';

export interface ExtClaims { channel_id: string; opaque_user_id: string; user_id?: string; role: string; exp: number }

const LEEWAY_S = 60;
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const mac = (data: string, secretB64: string) => createHmac('sha256', Buffer.from(secretB64, 'base64')).update(data).digest();

export function signJwt(payload: Record<string, unknown>, secretB64: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${b64url(mac(`${head}.${body}`, secretB64))}`;
}

const parse = (part: string): unknown => {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks an extension JWT against each secret (current first) and the expiry (60 s leeway). */
export function verifyExtensionJwt(token: string, secrets: string[], nowMs: number): ExtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = parse(h);
  if (!isObj(header) || header.alg !== 'HS256') return null;
  const sig = Buffer.from(s, 'base64url');
  const ok = secrets.some((secret) => {
    const want = mac(`${h}.${p}`, secret);
    return sig.length === want.length && timingSafeEqual(sig, want);
  });
  if (!ok) return null;
  const c = parse(p);
  if (!isObj(c) || typeof c.channel_id !== 'string' || typeof c.opaque_user_id !== 'string' || typeof c.exp !== 'number') return null;
  if (c.exp < nowMs / 1000 - LEEWAY_S) return null;
  return {
    channel_id: c.channel_id, opaque_user_id: c.opaque_user_id, role: typeof c.role === 'string' ? c.role : '', exp: c.exp,
    ...(typeof c.user_id === 'string' ? { user_id: c.user_id } : {}),
  };
}

/** A 60-second token for posting to one channel's PubSub broadcast topic. */
export function pubsubJwt(cfg: TwitchConfig, channelTwitchId: string, nowMs: number): string {
  return signJwt({
    exp: Math.floor(nowMs / 1000) + 60, user_id: cfg.ownerId, role: 'external', channel_id: channelTwitchId,
    pubsub_perms: { send: ['broadcast'] },
  }, cfg.extensionSecret);
}
