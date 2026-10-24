import type { Clock } from '../clock';
import type { TwitchConfig } from '../config';
import { pubsubJwt } from './jwt';

export interface TwitchUser { id: string; login: string; displayName: string }
export type PubSubResult = { ok: true } | { ok: false; status: number; retryAt: number | null };

/** A network failure, a timeout, or an unexpected status on any call but PubSub. */
export class TwitchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TwitchError';
  }
}

export interface TwitchClient {
  usersById(ids: string[]): Promise<TwitchUser[]>;
  usersByLogin(logins: string[]): Promise<TwitchUser[]>;
  tokenOwner(userToken: string): Promise<TwitchUser>;
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<string>;
  revoke(userToken: string): Promise<void>;
  sendPubSub(broadcasterId: string, message: string): Promise<PubSubResult>;
}

const REFRESH_WITHIN_MS = 10 * 60_000;

interface RawUser { id: string; login: string; display_name: string }
const toUser = (u: RawUser): TwitchUser => ({ id: u.id, login: u.login, displayName: u.display_name });

export class HttpTwitchClient implements TwitchClient {
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly cfg: TwitchConfig, private readonly clock: Clock, private readonly timeoutMs = 10_000) {}

  private async fetchRaw(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new TwitchError(`Twitch request failed: ${init.method ?? 'GET'} ${new URL(url).pathname}`, { cause: e });
    }
  }

  private form(url: string, fields: Record<string, string>): Promise<Response> {
    return this.fetchRaw(url, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
    });
  }

  private async appToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - this.clock.now() >= REFRESH_WITHIN_MS) return this.token.value;
    // One request at a time; a caller that arrives during a refresh shares it.
    this.refreshing ??= this.fetchAppToken().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async fetchAppToken(): Promise<string> {
    const res = await this.form(`${this.cfg.authBase}/token`, {
      client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: 'client_credentials',
    });
    if (!res.ok) throw new TwitchError(`Twitch app token request returned ${res.status}`);
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (!body || typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') throw new TwitchError('Twitch app token response malformed');
    this.token = { value: body.access_token, expiresAt: this.clock.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private helix(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchRaw(`${this.cfg.apiBase}${path}`, {
      ...init, headers: { ...init.headers, 'client-id': this.cfg.clientId, authorization: `Bearer ${token}` },
    });
  }

  /** GET with the app token; a 401 refreshes the token once and retries once. */
  private async appGet(path: string): Promise<Response> {
    let res = await this.helix(path, await this.appToken());
    if (res.status === 401) res = await this.helix(path, await this.appToken(true));
    return res;
  }

  private async users(query: URLSearchParams): Promise<TwitchUser[]> {
    const res = await this.appGet(`/users?${query}`);
    if (!res.ok) throw new TwitchError(`Twitch Get Users returned ${res.status}`);
    return parseUsers(await res.json().catch(() => null));
  }

  usersById(ids: string[]): Promise<TwitchUser[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.users(new URLSearchParams(ids.map((id): [string, string] => ['id', id])));
  }

  usersByLogin(logins: string[]): Promise<TwitchUser[]> {
    if (!logins.length) return Promise.resolve([]);
    return this.users(new URLSearchParams(logins.map((l): [string, string] => ['login', l])));
  }

  async tokenOwner(userToken: string): Promise<TwitchUser> {
    const res = await this.helix('/users', userToken);
    if (!res.ok) throw new TwitchError(`Twitch Get Users (token owner) returned ${res.status}`);
    const [user] = parseUsers(await res.json().catch(() => null));
    if (!user) throw new TwitchError('Twitch returned no user for the token');
    return user;
  }

  authorizeUrl(state: string): string {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId, redirect_uri: `${this.cfg.publicUrl}/signup/callback`, response_type: 'code', scope: '', state,
    });
    return `${this.cfg.authBase}/authorize?${q}`;
  }

  async exchangeCode(code: string): Promise<string> {
    const res = await this.form(`${this.cfg.authBase}/token`, {
      client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code, grant_type: 'authorization_code',
      redirect_uri: `${this.cfg.publicUrl}/signup/callback`,
    });
    if (!res.ok) throw new TwitchError(`Twitch code exchange returned ${res.status}`);
    const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
    if (!body || typeof body.access_token !== 'string') throw new TwitchError('Twitch code exchange response malformed');
    return body.access_token;
  }

  async revoke(userToken: string): Promise<void> {
    const res = await this.form(`${this.cfg.authBase}/revoke`, { client_id: this.cfg.clientId, token: userToken });
    if (!res.ok) throw new TwitchError(`Twitch revoke returned ${res.status}`);
  }

  async sendPubSub(broadcasterId: string, message: string): Promise<PubSubResult> {
    let res: Response;
    try {
      res = await this.helix('/extensions/pubsub', pubsubJwt(this.cfg, broadcasterId, this.clock.now()), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: ['broadcast'], broadcaster_id: broadcasterId, message }),
      });
    } catch {
      return { ok: false, status: 0, retryAt: null };
    }
    if (res.status === 204) return { ok: true };
    let retryAt: number | null = null;
    if (res.status === 429) {
      const reset = Number(res.headers.get('ratelimit-reset'));
      if (res.headers.get('ratelimit-reset') && Number.isFinite(reset)) retryAt = reset * 1000;
    }
    await res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status, retryAt };
  }
}

function parseUsers(body: unknown): TwitchUser[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new TwitchError('Twitch Get Users response malformed');
  return (data as RawUser[]).map(toUser);
}
