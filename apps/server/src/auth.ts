import type { ErrorBody, Role } from '@dndm/protocol';
import type { Clock } from './clock';
import { hashToken, isViewerToken, type Secrets } from './crypto';
import type { Room, Sender } from './room';

export type Authed = Sender & { tokenHash: string | null };

/** Spec 2a §4.3. A token only works for its own channel. */
export function authenticate(room: Room, token: string | undefined, secrets: Secrets): Authed | ErrorBody {
  if (!token) return { code: 'unauthorized', message: 'Send a token' };
  if (isViewerToken(token)) {
    const claim = secrets.verifyViewer(token);
    if (!claim) return { code: 'unauthorized', message: "That viewer token isn't valid" };
    if (claim.channel !== room.channel.id) return { code: 'forbidden', message: 'That viewer token is for another channel' };
    return { role: 'viewer', character: claim.character, tokenHash: null };
  }
  const hash = hashToken(token);
  if (hash === room.channel.dockTokenHash) return { role: 'dock', tokenHash: hash };
  if (hash === room.channel.overlayTokenHash) return { role: 'overlay', tokenHash: hash };
  return { code: 'unauthorized', message: "That token isn't valid for this channel" };
}

export const LIMITS: Record<Role, number> = { viewer: 5, overlay: 5, dock: 20 };

/** Requests per second per sender (spec 2a §4.4). Measured on the server's clock. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly clock: Clock, private readonly enabled = true, private readonly limits: Record<Role, number> = LIMITS) {}

  take(role: Role, key: string): boolean {
    if (!this.enabled) return true;
    const now = this.clock.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 1000);
    const ok = recent.length < this.limits[role];
    if (ok) recent.push(now);
    if (recent.length) this.hits.set(key, recent);
    else this.hits.delete(key);
    return ok;
  }
}

export const limitKey = (room: Room, who: Authed): string =>
  who.role === 'viewer' ? `viewer:${room.channel.id}:${who.character}` : `${who.role}:${who.tokenHash}`;
