# Project 2b, Plan C: Sign-up, Allowlist and Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an allowlisted streamer sign in with Twitch, get a channel and see their dock and overlay URLs; give the owner `dndm server allow / disallow / allowlist`; and ship the server to Fly.io against Neon with a Dockerfile, `fly.toml`, a CI image build and a runbook.

**Architecture:** Server-rendered HTML pages in `signup.ts`, signed cookies in `session.ts`, both registered only when Twitch is configured. Sign-up reuses Plan B's Twitch client (OAuth plus Get Users with the user token) and 2a's `createChannel`. Regenerate runs the Room's existing server commands as the dock. Deploy files are plain config, guarded by a small test that reads them.

**Tech Stack:** As in Plans A and B. No new dependencies: cookies and form bodies are parsed by hand (README decision 5).

**Spec:** `docs/superpowers/specs/2026-10-17-twitch-layer-design.md` (rev 16): §1.1 criteria 4 and 5, §3, §4.3–§4.5, §6.4, §7.1, §7.2 (`DNDM_SIGNUP`), §7.5–§7.7, §8 (sign-up failures), §10. Flagged decisions: `docs/superpowers/plans/2026-10-23-project-2b-README.md`.

**Prerequisite:** Plan B complete.

## Global Constraints

- Sign-up exists only when Twitch is configured (§4.3). Without it there are no `/signup`, `/setup`, `/dock` or `/overlay` routes (§7.2).
- OAuth asks for **no scopes**. The user token is revoked (best effort) and nothing from it is kept (§4.3).
- `state`: random, in the URL and in a signed `HttpOnly` cookie that lasts 10 minutes (§4.3).
- `dndm_session`: signed with a key derived from `DNDM_SECRET` under its own label. It holds the channel ID, the Twitch ID and an expiry 7 days away, and is `HttpOnly`, `Secure`, `SameSite=Lax`. Sessions aren't stored (§4.3).
- `DNDM_SIGNUP`: `allowlist` (default) or `open` (§7.2).
- One Twitch account has at most one channel (`channels.twitch_id` is unique) (§3).
- Tokens appear only in URL fragments: `<DNDM_PUBLIC_URL>/dock#<token>`, `<DNDM_PUBLIC_URL>/overlay#<token>` (§4.4).
- Setup buttons are POST forms with a CSRF token tied to the sign-in session (§4.4).
- Taking someone off the allowlist stops new sign-ins only (§4.3).
- Fly: one machine, `auto_stop_machines = "off"`, `min_machines_running = 1`, `release_command` runs `dndm server migrate`, `strategy = "rolling"` (never `bluegreen` or `canary`), health check `GET /health`, `kill_timeout` 30 s, app name with a random suffix (§7.5).
- `DATABASE_URL` is Neon's **direct** connection string with `sslmode=require` (§7.2).

## Review Focus

1. **Two sign-in callbacks for the same new Twitch account at once** (a double click on "Authorize"): a person expects one channel and both browsers signed in to it, not a 500 from the unique index. Test in Task 3.
2. **A sign-in session cookie whose channel no longer has that Twitch ID** (or no longer exists): a person expects to be sent back to `/signup`, not shown someone else's URLs. Test in Task 4.
3. **A streamer's display name with HTML in it** (`<b>`, `&`): a person expects it shown as text on `/setup`, not rendered. Test in Task 4.
4. **The Twitch callback with `error=access_denied` and no `state` cookie** (the streamer cancelled after their cookie expired): a person expects the "you cancelled" page, not "bad state". Test in Task 3.
5. **`dndm server disallow` for a streamer who renamed their Twitch account**: a person expects the entry removed by its stored login when the old login no longer resolves. Test in Task 1.

---

## File map (this plan)

```
apps/server/src/
  db/schema.ts        + allowlist table
  store.ts            + allow, disallowById, disallowByLogin, allowlist, isAllowed
  session.ts          cookies: session, state, CSRF; parseCookies
  signup.ts           registerSignup: /signup, /signup/start, /signup/callback, /setup, /setup/regenerate, /signout, /dock, /overlay
  server.ts           + ServerOpts.signup; register signup with Twitch
apps/server/drizzle/0001_allowlist.sql (generated)
apps/cli/src/server.ts   + allow, disallow, allowlist; start reads DNDM_SIGNUP
Dockerfile  .dockerignore  fly.toml  .github/workflows/ci.yml  docs/deploy.md
apps/server/test/
  allowlist.test.ts  session.test.ts  signup.test.ts  setup.test.ts  deploy-files.test.ts
apps/cli/test/server.test.ts
```

---

### Task 1: The allowlist (migration, store, CLI)

**Files:**
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/store.ts`, `apps/cli/src/server.ts`
- Create: `apps/server/drizzle/0001_allowlist.sql` (generated)
- Test: `apps/server/test/allowlist.test.ts`, `apps/cli/test/server.test.ts`

**Interfaces:**
- Produces:
  - table `allowlist { twitch_id text primary key, login text not null, added_at timestamptz not null default now() }`
  - `Store.allow(twitchId: string, login: string): Promise<void>` (upsert; refreshes `login`)
  - `Store.disallowById(twitchId: string): Promise<boolean>`, `Store.disallowByLogin(login: string): Promise<boolean>` (true when a row was removed)
  - `Store.allowlist(): Promise<{ twitchId: string; login: string; addedAt: Date }[]>` (by `added_at`)
  - `Store.isAllowed(twitchId: string): Promise<boolean>`
  - CLI: `dndm server allow <login>`, `dndm server disallow <login>`, `dndm server allowlist`. They need `DATABASE_URL`, `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` (README decision 12). Logins are lowercased. `ServerCliOpts.twitchClient?: TwitchClient` lets tests inject the fake.

`disallow` (§4.5): resolve the login with Get Users. If it resolves and that ID was on the list, remove it. Otherwise remove the entry whose stored login matches. If neither matches, error `<login> isn't on the allowlist`. `allow` with an unknown login errors `No Twitch account is called <login>`.

- [ ] **Step 1: Write the failing tests**

`allowlist.test.ts` (fresh database):

```ts
it('allow, isAllowed, allowlist and disallow by ID or login', async () => {
  await store.allow('42', 'streamer'); await store.allow('42', 'renamed');
  expect(await store.isAllowed('42')).toBe(true);
  expect(await store.allowlist()).toEqual([{ twitchId: '42', login: 'renamed', addedAt: expect.any(Date) }]);
  expect(await store.disallowByLogin('nobody')).toBe(false);
  expect(await store.disallowById('42')).toBe(true);
  expect(await store.isAllowed('42')).toBe(false);
});
```

`apps/cli/test/server.test.ts` (fake Twitch client with user `{ id: '42', login: 'streamer', displayName: 'Streamer' }`):

```ts
it('allow resolves the login and adds it; an unknown login is an error', async () => { /* allow Streamer → row ('42','streamer'); allow ghost → CliError "No Twitch account is called ghost" */ });
it('disallow falls back to the stored login when the login no longer resolves', async () => { /* allow streamer; rename the fake user's login; disallow streamer → removed */ });
it('disallow of a login that is not listed is an error', async () => { /* "ghost isn't on the allowlist" */ });
it('allowlist prints the entries', async () => { /* one line per entry with login and ID */ });
it('allow without Twitch client settings explains what to set', async () => { /* CliError naming TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/test/allowlist.test.ts apps/cli/test/server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the table to `schema.ts` and generate the migration**

Run: `pnpm --filter @dndm/server exec drizzle-kit generate --name allowlist`
Expected: `apps/server/drizzle/0001_allowlist.sql` containing `CREATE TABLE "allowlist"`.

- [ ] **Step 4: Implement the store methods and the three CLI commands**

The CLI builds an `HttpTwitchClient` from a config with only `clientId`, `clientSecret` and the default base URLs.

- [ ] **Step 5: Run them and see them pass**

Run: the Step 2 command. Expected: PASS. `schema.test.ts` still passes with the new migration.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/store.ts apps/server/drizzle apps/cli apps/server/test/allowlist.test.ts
git commit -m "feat: allowlist table and dndm server allow/disallow/allowlist"
```

---

### Task 2: Signed cookies and CSRF

**Files:**
- Create: `apps/server/src/session.ts`
- Test: `apps/server/test/session.test.ts`

**Interfaces:**
- Consumes: Plan B's `Secrets.derive`.
- Produces:
  - `interface SignInSession { channelId: string; twitchId: string; expiresAt: number }`
  - `SESSION_COOKIE = 'dndm_session'`, `STATE_COOKIE = 'dndm_state'`, `SESSION_MS = 7 * 24 * 3600_000`, `STATE_MS = 600_000`
  - `class Cookies { constructor(secrets: Secrets) }` with:
    - `session(s: SignInSession): string` (a full `Set-Cookie` value: `dndm_session=<v>; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`)
    - `readSession(header: string | undefined, nowMs: number): SignInSession | null`
    - `clearSession(): string`
    - `state(value: string): string` (`dndm_state=<v>; Path=/signup; Max-Age=600; HttpOnly; Secure; SameSite=Lax`)
    - `readState(header: string | undefined): string | null`
    - `csrf(header: string | undefined): string | null` (`base64url(HMAC(derive('csrf'), raw session cookie value))`, or `null` without one)
    - `checkCsrf(header: string | undefined, token: unknown): boolean`
  - `parseCookies(header: string | undefined): Record<string, string>`

Values are `<base64url(JSON)>.<base64url(HMAC-SHA256(key, body))>`: the session key is `derive('session')` with JSON `{ c, t, x }`; the state key is `derive('state')` over the state string. Compare MACs with `timingSafeEqual`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a session round-trips and expires after 7 days', () => { /* readSession(cookie, now) equals; at now + 7 d + 1 → null */ });
it('a tampered or foreign-secret session is refused', () => { /* flip one char; Cookies(new Secrets(OTHER)) → null */ });
it('the state cookie round-trips and is refused when tampered', () => { /* … */ });
it('session and state keys differ', () => { /* a state value pasted as dndm_session is refused */ });
it('cookie attributes', () => { expect(c.session(s)).toMatch(/HttpOnly; Secure; SameSite=Lax/); expect(c.state('x')).toMatch(/Max-Age=600/); });
it('CSRF is tied to the session', () => { /* checkCsrf(sameCookie, csrf(sameCookie)) true; with another session's cookie false; missing token false */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/test/session.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `session.ts` as described above**

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm vitest run apps/server/test/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/session.ts apps/server/test/session.test.ts
git commit -m "feat(server): signed session, state and CSRF cookies"
```

---

### Task 3: Sign-up with Twitch

**Files:**
- Create: `apps/server/src/signup.ts`
- Modify: `apps/server/src/server.ts` (`ServerOpts.signup`, register with Twitch), `apps/cli/src/server.ts` (`start` reads `DNDM_SIGNUP`; any value other than `allowlist` or `open` is a `CliError`)
- Test: `apps/server/test/signup.test.ts`

**Interfaces:**
- Consumes: Plan B's `TwitchClient`, `TwitchError`, `createChannel({ twitchId })`, `Store.channelByTwitchId`; Task 1's `isAllowed`; Task 2's `Cookies`.
- Produces:
  - `ServerOpts.signup?: 'allowlist' | 'open'` (default `'allowlist'`)
  - `registerSignup(app: FastifyInstance, deps: { store: Store; manager: RoomManager; secrets: Secrets; cookies: Cookies; client: TwitchClient; config: TwitchConfig; signup: 'allowlist' | 'open'; bundles: PackBundle[]; clock: Clock; log?: … }): void`
  - `page(title: string, bodyHtml: string): string` and `esc(text: string): string` (HTML escaping), exported for Task 4

Routes (§4.3, §8):
- `GET /signup`: a page with a "Sign in with Twitch" link to `/signup/start`.
- `GET /signup/start`: a new `state` (16 random bytes, base64url), `Set-Cookie: cookies.state(state)`, then a 302 to `client.authorizeUrl(state)`.
- `GET /signup/callback`, checked in this order:
  1. `error` in the query → the "You cancelled at Twitch" page (200).
  2. `state` missing or not equal to `cookies.readState(...)` → the "That sign-in link has expired or was tampered with" page (400).
  3. `exchangeCode`, `tokenOwner`, then `revoke` (best effort: a revoke failure is logged and ignored). A `TwitchError` from either of the first two → the "Twitch didn't answer; try again" page (502).
  4. `signup === 'allowlist'` and `!isAllowed(user.id)` → "The game isn't open for sign-ups yet." (403).
  5. The channel is `channelByTwitchId(user.id)`, or else `createChannel({ name: user.displayName, config: defaultConfig(), seed: randomInt(0, 2 ** 31), twitchId: user.id, … })`. When the insert fails on the unique `twitch_id` (Postgres `23505`), load it with `channelByTwitchId`.
  6. `Set-Cookie: cookies.session({ channelId, twitchId: user.id, expiresAt: now + SESSION_MS })` and the state cookie cleared, then a 303 to `/setup`.
- Every failure page links back to `/signup` (README decision 11 lists the status codes).

- [ ] **Step 1: Write the failing tests** (`twitchSetup()` from Plan B, plus `signup` option; `fake.addUser({ id: '77', login: 'newbie', displayName: 'Newbie' })`)

```ts
async function signIn(s, user = '77') {
  const start = await s.srv.app.inject('/signup/start');
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const cookie = (start.headers['set-cookie'] as string).split(';')[0];
  return s.srv.app.inject({ url: `/signup/callback?code=${s.fake.codeFor(user)}&state=${state}`, headers: { cookie } });
}
it('/signup/start redirects to Twitch with no scopes and a state cookie', async () => { /* location starts with fake authBase /authorize, scope= empty, redirect_uri = publicUrl/signup/callback; Set-Cookie dndm_state HttpOnly Max-Age=600 */ });
it('an account not on the allowlist is turned away, and open mode lets it in', async () => { /* 403 body contains "The game isn't open for sign-ups yet."; with signup 'open' → 303 /setup */ });
it('the first sign-in creates a channel named after the display name, and a second reaches the same one', async () => { /* allow '77'; signIn twice → one channel with twitch_id '77', name 'Newbie'; both 303 /setup with a dndm_session cookie */ });
it('two callbacks for the same new account at once make one channel', async () => { /* Promise.all of two signIn → both 303; one channel */ });
it('the user token is revoked and a revoke failure is ignored', async () => { /* fake.requests has POST /oauth2/revoke; failNext('revoke') → still 303 */ });
it('a bad state is refused', async () => { /* state=wrong → 400; no state cookie → 400 */ });
it('cancelling at Twitch shows the cancelled page even without a state cookie', async () => { /* /signup/callback?error=access_denied → 200 "You cancelled at Twitch", link to /signup */ });
it('Twitch not answering shows the try-again page', async () => { /* failNext('token') after the app token exists → 502 */ });
it('without Twitch settings there is no sign-up', async () => { /* plain startServer → /signup 404 */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/test/signup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `registerSignup` (the sign-up routes, a form-body parser for later tasks, and the server and CLI wiring)**

Register `application/x-www-form-urlencoded` with `app.addContentTypeParser(..., { parseAs: 'string' }, ...)` → `Object.fromEntries(new URLSearchParams(body))`.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm vitest run apps/server/test/signup.test.ts apps/cli/test/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/signup.ts apps/server/src/server.ts apps/cli/src/server.ts apps/server/test/signup.test.ts
git commit -m "feat(server): streamer sign-up with Twitch behind the allowlist"
```

---

### Task 4: The setup page, regenerate, sign out and placeholders

**Files:**
- Modify: `apps/server/src/signup.ts`
- Test: `apps/server/test/setup.test.ts`

**Interfaces:**
- Consumes: Task 3's `page`, `esc`, `registerSignup`; 2a's `Room.command` server commands `regenerateDockUrl` and `regenerateOverlayUrl`.

Routes (§4.4):
- `GET /setup`: needs `readSession` to give a session whose channel exists and whose `twitchId` matches. Otherwise it clears the cookie and sends a 303 to `/signup`. The page shows:
  - the dock URL `<publicUrl>/dock#<decrypted dock token>` and the overlay URL `<publicUrl>/overlay#<decrypted overlay token>`;
  - `dndm connect <publicUrl> --channel <id> --dock <dock token>`;
  - an "Install the extension" link to `https://dashboard.twitch.tv/extensions/<clientId>` (README decision 13);
  - two Regenerate forms (`POST /setup/regenerate`, hidden `which` = `dock` or `overlay`, hidden `csrf`) and a Sign out form (`POST /signout`, hidden `csrf`).

  The channel name and every value go through `esc`. Headers: `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- `POST /setup/regenerate`: needs a session and `checkCsrf`. A failed check is 403 with a page. On success it runs `room.command({ role: 'dock' }, 'setup:' + randomUUID(), { type: which === 'dock' ? 'regenerateDockUrl' : 'regenerateOverlayUrl' })`. An `ok` answer sends a 303 to `/setup`. Otherwise it shows an error page with the answer's message.
- `POST /signout`: needs `checkCsrf`, then clears the cookie and sends a 303 to `/signup`.
- `GET /dock` and `GET /overlay`: a short page saying the screen is coming in Project 3.

- [ ] **Step 1: Write the failing tests** (signed in as in Task 3)

```ts
it('/setup without a session redirects to /signup', async () => { /* 303 location /signup */ });
it('/setup shows both URLs with tokens in the fragment, the connect line and the install link', async () => {
  /* body contains `${publicUrl}/dock#${dockToken}` and `/overlay#`, `dndm connect ${publicUrl} --channel ${id} --dock ${dockToken}`,
     `dashboard.twitch.tv/extensions/${clientId}`; Cache-Control no-store */
});
it('a session for a channel whose twitch_id changed is sent back to /signup', async () => { /* update channels.twitch_id directly; 303 /signup; cookie cleared */ });
it('a display name with HTML is shown as text', async () => { /* user displayName '<b>Bo & Co</b>' → body has &lt;b&gt;Bo &amp; Co&lt;/b&gt; */ });
it('CSRF is required on regenerate', async () => { /* no csrf → 403; another session's csrf → 403 */ });
it('regenerate gives a new dock URL and closes open dock WebSockets', async () => {
  /* open a /channels/:id/live socket with the old dock token (as app.test.ts does), POST regenerate dock with csrf → 303;
     /setup now shows a different token; the socket closed with WS_CLOSE.revoked */
});
it('sign out clears the cookie', async () => { /* POST /signout with csrf → 303 /signup, Set-Cookie dndm_session=; Max-Age=0 */ });
it('/dock and /overlay answer the Project 3 placeholder', async () => { /* 200, body mentions Project 3 */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/test/setup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the routes as described above**

- [ ] **Step 4: Run every test**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/signup.ts apps/server/test/setup.test.ts
git commit -m "feat(server): setup page, regenerate, sign out and screen placeholders"
```

---

### Task 5: Docker, Fly, CI and the runbook

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `fly.toml`, `docs/deploy.md`, `apps/server/test/deploy-files.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the CLI (`dndm server start / migrate / allow`).

`Dockerfile` (§7.1): two stages on `node:24-slim`. The build stage runs `corepack enable`, copies the repository and runs `pnpm install --frozen-lockfile`. The runtime stage copies `/app`, runs as `USER node`, `EXPOSE 8080`, and starts with `CMD ["node_modules/.bin/tsx", "apps/cli/src/main.ts", "server", "start", "--host", "0.0.0.0", "--port", "8080"]`. Official packs ship because `packs/` is part of the copy. `.dockerignore`: `node_modules`, `.git`, `**/node_modules`, `docs`, `.github`.

`fly.toml` (§7.5):

```toml
app = "dndm-CHANGEME"        # the runbook replaces this with dndm-<6 random hex characters>
primary_region = "CHANGEME"
kill_signal = "SIGTERM"
kill_timeout = 30

[deploy]
  release_command = "node_modules/.bin/tsx apps/cli/src/main.ts server migrate"
  strategy = "rolling"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = false
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    path = "/health"
    interval = "10s"
    timeout = "5s"
    grace_period = "30s"
```

CI: a second job `image` that runs `docker build -t dndm .` on every push.

`docs/deploy.md` (§7.7, §10) opens with: "This is the owner's runbook for the official server. It isn't a self-hosting guide." Then, step by step:
- **The Twitch developer console:** register the extension; set the OAuth redirect URL to `<DNDM_PUBLIC_URL>/signup/callback`; add the public domain to the URL fetching allowlist; copy the client ID, API client secret, extension secret and the owner's user ID.
- **Neon:** create the project and copy the **direct** connection string with `sslmode=require` (not the pooled one, because of the advisory lock); optionally use a Neon branch to try a risky migration.
- **Fly:** pick `dndm-$(openssl rand -hex 3)` as the app name (Twitch policy 2.13); `fly launch --no-deploy` with the repository's `fly.toml`; `fly secrets set DATABASE_URL=… DNDM_SECRET=… DNDM_PUBLIC_URL=https://<app>.fly.dev TWITCH_CLIENT_ID=… TWITCH_CLIENT_SECRET=… TWITCH_EXTENSION_SECRET=… TWITCH_OWNER_ID=…`; `fly deploy`. A deploy means a few seconds of downtime.
- **First use:** `dndm server allow <login>` against production, then sign up in a browser.
- **Rotating** the extension secret (set `TWITCH_EXTENSION_SECRET_PREVIOUS` to the old one, rotate in the console, deploy, remove the previous one later) and `DNDM_SECRET` (changes the token encryption key, so regenerate every channel's URLs).
- **The live check (§10):** `GET /health` is 200; `dndm server allow <owner-login>` resolves through real Get Users; the owner signs up through real Twitch and sees both URLs on `/setup`, and the install link opens the extension's page; `dndm connect <url> --channel <id> --dock <token>` then `openSession` produces a logged PubSub send answered 204.

- [ ] **Step 1: Write the failing test**

`deploy-files.test.ts` reads the files from the repository root:

```ts
it('fly.toml keeps one always-on machine, rolling deploys, migrations and the health check', () => {
  for (const line of ['strategy = "rolling"', 'auto_stop_machines = "off"', 'min_machines_running = 1', 'path = "/health"', 'kill_timeout = 30', 'kill_signal = "SIGTERM"', 'server migrate'])
    expect(fly).toContain(line);
  expect(fly).not.toMatch(/bluegreen|canary/);
});
it('the Dockerfile builds on node:24-slim, runs as non-root and starts on 0.0.0.0:8080', () => {
  expect(docker.match(/FROM node:24-slim/g)).toHaveLength(2);
  expect(docker).toContain('pnpm install --frozen-lockfile');
  expect(docker).toContain('USER node');
  expect(docker).toContain('"--host", "0.0.0.0", "--port", "8080"');
});
it('the runbook says it is not a self-hosting guide', () => expect(runbook).toContain("It isn't a self-hosting guide."));
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run apps/server/test/deploy-files.test.ts`
Expected: FAIL (files missing).

- [ ] **Step 3: Write the files as described above**

Before writing the strategy line, confirm in Fly's documentation (`fly.io/docs/reference/configuration/#deploy`) that `rolling` on a single machine stops the old one before the new one starts. Put the link and what it says in the runbook's Fly section.

- [ ] **Step 4: Run the test and build the image**

Run: `pnpm vitest run apps/server/test/deploy-files.test.ts && docker build -t dndm .`
Expected: PASS, and the image builds. If Docker isn't available locally, say so in the task report and rely on the CI job.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore fly.toml docs/deploy.md .github/workflows/ci.yml apps/server/test/deploy-files.test.ts
git commit -m "chore: Dockerfile, fly.toml, CI image build and deploy runbook"
```

---

## After this plan: the live check

Once every task passes and CI is green, the owner deploys with `docs/deploy.md` and runs its live check section (spec §10, criterion 5). It needs the owner's Twitch developer console and Fly account, so no agent runs it.
