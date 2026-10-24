import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Secrets } from './crypto';

export interface SignInSession { channelId: string; twitchId: string; expiresAt: number }

export const SESSION_COOKIE = 'dndm_session';
export const STATE_COOKIE = 'dndm_state';
export const SESSION_MS = 7 * 24 * 3600_000;
export const STATE_MS = 600_000;

const ATTRS = 'HttpOnly; Secure; SameSite=Lax';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

const mac = (key: Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** The body of `<body>.<mac>` when the MAC verifies under `key`, else null. */
function open(key: Buffer, value: string | undefined): string | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  const body = value.slice(0, dot);
  const got = Buffer.from(value.slice(dot + 1), 'base64url');
  const want = mac(key, body);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return body;
}

const seal = (key: Buffer, body: string): string => `${body}.${mac(key, body).toString('base64url')}`;

/** Signed sign-in session, OAuth state and CSRF cookies (spec 2b §4.3, §4.4). */
export class Cookies {
  private readonly sessionKey: Buffer;
  private readonly stateKey: Buffer;
  private readonly csrfKey: Buffer;

  constructor(secrets: Secrets) {
    this.sessionKey = secrets.derive('session');
    this.stateKey = secrets.derive('state');
    this.csrfKey = secrets.derive('csrf');
  }

  session(s: SignInSession): string {
    const body = Buffer.from(JSON.stringify({ c: s.channelId, t: s.twitchId, x: s.expiresAt })).toString('base64url');
    return `${SESSION_COOKIE}=${seal(this.sessionKey, body)}; Path=/; Max-Age=${SESSION_MS / 1000}; ${ATTRS}`;
  }

  readSession(header: string | undefined, nowMs: number): SignInSession | null {
    const body = open(this.sessionKey, parseCookies(header)[SESSION_COOKIE]);
    if (body === null) return null;
    try {
      const j = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { c?: unknown; t?: unknown; x?: unknown };
      if (typeof j.c !== 'string' || typeof j.t !== 'string' || typeof j.x !== 'number') return null;
      if (nowMs > j.x) return null;
      return { channelId: j.c, twitchId: j.t, expiresAt: j.x };
    } catch {
      return null;
    }
  }

  clearSession(): string {
    return `${SESSION_COOKIE}=; Path=/; Max-Age=0; ${ATTRS}`;
  }

  state(value: string): string {
    const body = Buffer.from(value, 'utf8').toString('base64url');
    return `${STATE_COOKIE}=${seal(this.stateKey, body)}; Path=/signup; Max-Age=${STATE_MS / 1000}; ${ATTRS}`;
  }

  readState(header: string | undefined): string | null {
    const body = open(this.stateKey, parseCookies(header)[STATE_COOKIE]);
    return body === null ? null : Buffer.from(body, 'base64url').toString('utf8');
  }

  clearState(): string {
    return `${STATE_COOKIE}=; Path=/signup; Max-Age=0; ${ATTRS}`;
  }

  /** A token tied to the raw session cookie, or null when there is none. */
  csrf(header: string | undefined): string | null {
    const raw = parseCookies(header)[SESSION_COOKIE];
    return raw ? mac(this.csrfKey, raw).toString('base64url') : null;
  }

  checkCsrf(header: string | undefined, token: unknown): boolean {
    const want = this.csrf(header);
    if (want === null || typeof token !== 'string') return false;
    const a = Buffer.from(want);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
