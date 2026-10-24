import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { PackBundle } from '@dndm/engine';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Clock } from './clock';
import type { TwitchConfig } from './config';
import type { Secrets } from './crypto';
import type { RoomManager } from './room-manager';
import { type Room, RoomClosedError } from './room';
import { createChannel, defaultConfig } from './server';
import { type Cookies, SESSION_MS } from './session';
import type { Store } from './store';
import { type TwitchClient, TwitchError, type TwitchUser } from './twitch/api';

export type SignupMode = 'allowlist' | 'open';

export interface SignupDeps {
  store: Store; manager: RoomManager; secrets: Secrets; cookies: Cookies; client: TwitchClient; config: TwitchConfig;
  signup: SignupMode; bundles: PackBundle[]; clock: Clock;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML element content and quoted attribute values. */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** A bare server-rendered page (spec 2b §1.2). `bodyHtml` is trusted HTML; escape anything interpolated into it. */
export function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body>
${bodyHtml}
</body>
</html>
`;
}

const html = (res: FastifyReply, status: number, title: string, bodyHtml: string, headers: Record<string, string> = {}) =>
  res.code(status).headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }).send(page(title, bodyHtml));

/** A sign-up failure page (spec 2b §8): the message and a link back to `/signup`. */
const failure = (res: FastifyReply, status: number, message: string) =>
  html(res, status, 'Sign-up', `<p>${esc(message)}</p>\n<p><a href="/signup">Back to sign-up</a></p>`);

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null;
  return (err?.code ?? err?.cause?.code) === '23505';
};

/** Streamer sign-up with Twitch (spec 2b §4.3, §6.4, §8). Registered only when Twitch is configured. */
export function registerSignup(root: FastifyInstance, deps: SignupDeps): void {
  // Encapsulated so the url-encoded parser serves only these pages' forms; 2a routes keep answering 415 to it.
  root.register(async (app) => signupRoutes(app, deps));
}

function signupRoutes(app: FastifyInstance, deps: SignupDeps): void {
  // HTML forms post url-encoded bodies (the setup page's forms).
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get('/signup', async (_req, res) =>
    html(res, 200, 'Sign up', '<h1>dndm</h1>\n<p><a href="/signup/start">Sign in with Twitch</a></p>'));

  app.get('/signup/start', async (_req, res) => {
    const state = randomBytes(16).toString('base64url');
    return res.header('set-cookie', deps.cookies.state(state)).header('cache-control', 'no-store')
      .redirect(deps.client.authorizeUrl(state), 302);
  });

  app.get('/signup/callback', async (req, res) => {
    const q = req.query as Record<string, unknown>;
    if (q.error !== undefined) return failure(res, 200, 'You cancelled at Twitch.');

    const expected = deps.cookies.readState(req.headers.cookie);
    if (typeof q.state !== 'string' || !q.state || expected === null || q.state !== expected) {
      return failure(res, 400, 'That sign-in link has expired or was tampered with.');
    }

    let user: TwitchUser;
    try {
      const token = await deps.client.exchangeCode(typeof q.code === 'string' ? q.code : '');
      try {
        user = await deps.client.tokenOwner(token);
      } finally {
        // Best effort: nothing is kept from the token either way.
        await deps.client.revoke(token).catch((e: unknown) => deps.log?.('signup: revoke failed', { error: String(e) }));
      }
    } catch (e) {
      if (!(e instanceof TwitchError)) throw e;
      deps.log?.('signup: Twitch failed', { error: e.message });
      return failure(res, 502, "Twitch didn't answer; try again.");
    }

    if (deps.signup === 'allowlist' && !(await deps.store.isAllowed(user.id))) {
      return failure(res, 403, "The game isn't open for sign-ups yet.");
    }

    const channelId = await channelFor(deps, user);
    return res
      .header('set-cookie', [
        deps.cookies.session({ channelId, twitchId: user.id, expiresAt: deps.clock.now() + SESSION_MS }),
        deps.cookies.clearState(),
      ])
      .redirect('/setup', 303);
  });

  /** The signed-in session, if its channel still exists and still belongs to the same Twitch account. */
  const sessionChannel = async (cookie: string | undefined) => {
    const sess = deps.cookies.readSession(cookie, deps.clock.now());
    if (!sess) return null;
    const channel = await deps.store.channel(sess.channelId);
    return channel && channel.twitchId === sess.twitchId ? channel : null;
  };

  const signedOut = (res: FastifyReply) =>
    res.header('set-cookie', deps.cookies.clearSession()).header('cache-control', 'no-store').redirect('/signup', 303);

  app.get('/setup', async (req, res) => {
    const channel = await sessionChannel(req.headers.cookie);
    if (!channel) return signedOut(res);
    const base = deps.config.publicUrl;
    // After a DNDM_SECRET rotation the stored tokens can't be decrypted; the streamer regenerates them.
    const reveal = (enc: string): string | null => {
      try {
        return deps.secrets.decrypt(enc);
      } catch (e) {
        deps.log?.('setup: token decrypt failed', { channelId: channel.id, error: String(e) });
        return null;
      }
    };
    const dock = reveal(channel.dockTokenEnc);
    const overlay = reveal(channel.overlayTokenEnc);
    const lost = "This URL can't be shown because the server's key changed. Regenerate it.";
    const csrf = esc(deps.cookies.csrf(req.headers.cookie) ?? '');
    const form = (action: string, which: string | null, label: string) =>
      `<form method="post" action="${action}">${which ? `<input type="hidden" name="which" value="${which}">` : ''}`
      + `<input type="hidden" name="csrf" value="${csrf}"><button type="submit">${label}</button></form>`;
    return html(res, 200, 'Setup', [
      `<h1>${esc(channel.name)}</h1>`,
      dock === null ? `<p>Dock URL: ${esc(lost)}</p>` : `<p>Dock URL: <code>${esc(`${base}/dock#${dock}`)}</code></p>`,
      form('/setup/regenerate', 'dock', 'Regenerate dock URL'),
      overlay === null ? `<p>Overlay URL: ${esc(lost)}</p>` : `<p>Overlay URL: <code>${esc(`${base}/overlay#${overlay}`)}</code></p>`,
      form('/setup/regenerate', 'overlay', 'Regenerate overlay URL'),
      dock === null ? `<p>Connect the CLI: ${esc(lost)}</p>` : `<p>Connect the CLI: <code>${esc(`dndm connect ${base} --channel ${channel.id} --dock ${dock}`)}</code></p>`,
      `<p><a href="${esc(`https://dashboard.twitch.tv/extensions/${deps.config.clientId}`)}">Install the extension</a></p>`,
      form('/signout', null, 'Sign out'),
    ].join('\n'), { 'referrer-policy': 'no-referrer' });
  });

  app.post('/setup/regenerate', async (req, res) => {
    const channel = await sessionChannel(req.headers.cookie);
    if (!channel) return signedOut(res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!deps.cookies.checkCsrf(req.headers.cookie, body.csrf)) {
      return html(res, 403, 'Setup', '<p>That form has expired. Reload the page and try again.</p>\n<p><a href="/setup">Back to setup</a></p>');
    }
    const which = body.which;
    if (which !== 'dock' && which !== 'overlay') {
      return html(res, 400, 'Setup', '<p>Unknown token.</p>\n<p><a href="/setup">Back to setup</a></p>');
    }
    const command = { type: which === 'dock' ? 'regenerateDockUrl' : 'regenerateOverlayUrl' } as const;
    const id = `setup:${randomUUID()}`;
    let room: Room | null = await deps.manager.get(channel.id);
    if (!room) return signedOut(res);
    let answer;
    try {
      answer = await room.command({ role: 'dock' }, id, command);
    } catch (e) {
      if (!(e instanceof RoomClosedError)) throw e;
      room = await deps.manager.get(channel.id);
      if (!room) return signedOut(res);
      answer = await room.command({ role: 'dock' }, id, command);
    }
    if (answer.ok) return res.header('cache-control', 'no-store').redirect('/setup', 303);
    return html(res, 500, 'Setup', `<p>${esc(answer.error.message)}</p>\n<p><a href="/setup">Back to setup</a></p>`);
  });

  app.post('/signout', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!deps.cookies.checkCsrf(req.headers.cookie, body.csrf)) {
      return html(res, 403, 'Sign out', '<p>That form has expired. Reload the page and try again.</p>\n<p><a href="/setup">Back to setup</a></p>');
    }
    return signedOut(res);
  });

  const placeholder = (name: string) => async (_req: unknown, res: FastifyReply) =>
    html(res, 200, name, `<p>The ${name.toLowerCase()} screen is coming in Project 3.</p>`);
  app.get('/dock', placeholder('Dock'));
  app.get('/overlay', placeholder('Overlay'));
}

/** The account's channel, created on first sign-in. A concurrent sign-in that created it first wins. */
async function channelFor(deps: SignupDeps, user: TwitchUser): Promise<string> {
  const existing = await deps.store.channelByTwitchId(user.id);
  if (existing) return existing.id;
  try {
    const made = await createChannel({
      store: deps.store, secrets: deps.secrets, bundles: deps.bundles, name: user.displayName, config: defaultConfig(),
      seed: randomInt(0, 2 ** 31), twitchId: user.id,
    });
    deps.log?.('signup: channel created', { channelId: made.id, twitchId: user.id });
    return made.id;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const raced = await deps.store.channelByTwitchId(user.id);
    if (!raced) throw e;
    return raced.id;
  }
}
