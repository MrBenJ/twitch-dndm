# Project 2b, Plan B: Twitch Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the server to Twitch for viewers: Twitch config, extension JWTs, a Twitch client with a fake for tests, a per-channel pacing gate, the snapshot format, a Broadcaster per Room that sends snapshots through Extension PubSub, and the `/ext` routes. It ends with the criterion 1 and criterion 2 tests passing through `/ext`.

**Architecture:** A `TwitchLayer` owns the Twitch client, the pacing gate, per-channel caches and the set of channels that have had a Broadcaster since the process started. The `RoomManager` calls it when a Twitch channel's Room loads (`attach`) and unloads (`detach`). Each `Broadcaster` ticks once a second on the server clock. When the Room's `inputs` counter moved, keys are waiting or an `rf` is due, it calls `room.broadcastState()` (Plan A), builds a snapshot with the pure `buildSnapshot()`, and sends it through the gate. The `/ext` routes authenticate with the extension JWT and drive the same Rooms as 2a's routes.

**Tech Stack:** As in 2a. `node:crypto` for JWTs and keys, built-in `fetch` for Twitch. No new dependencies (README decision 5).

**Spec:** `docs/superpowers/specs/2026-10-17-twitch-layer-design.md` (rev 16): §1.1 criteria 1–3, §2.2, §4.1, §4.2, §5.1, §5.3–§5.6, §6, §7.2, §7.4 step 3, §8, §9. Flagged decisions: `docs/superpowers/plans/2026-10-23-project-2b-README.md`.

**Prerequisite:** Plan A complete.

## Global Constraints

- "Twitch is configured" means `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_EXTENSION_SECRET`, `TWITCH_OWNER_ID` and `DNDM_PUBLIC_URL` are all set. Some but not all: refuse to start and name what's missing. None: no `/ext` routes and no Broadcasters (§7.2).
- The Room never waits on Twitch. PubSub sends run outside the Room's queue (§8).
- Snapshot: at most 5 KB (`5 * 1024` bytes, measured after `JSON.stringify` as UTF-8). Never contains an event, an encounter panel or an overlay scene (§5.1).
- Keys: the first 10 characters of base64url(HMAC-SHA256(k, channelId + ":" + characterId)), with k derived from `DNDM_SECRET` under its own label (§5.1).
- Pacing per channel Twitch ID: at most one send per second; a 429 waits until Twitch's `Ratelimit-Reset`; failures back off 1 s, doubling, at most 30 s (§5.3, §6.3, §8).
- `rw`: changed list → `clamp(keys × 10, 1000, 30000)` ms; `rf` → 30 000 ms (§5.5).
- Backlog cap: more than 3 000 waiting keys makes the send an `rf` (§5.3). A successful `rf` of any kind clears every waiting key.
- A due `rf` (first Broadcaster for the channel since the process started, dropped keys, config change) is built on the first tick after it becomes due and always sent. It skips the bare form's 30 s limit (§5.3, §5.4).
- The bare form goes out at most once every 30 s, and only when something changed since the last one (§5.4).
- Unload: the last `broadcastState()` runs through the Room's queue before the Room closes. The last send retries in the background for up to 30 s, and on final failure the gate records dropped keys (§5.3). Shutdown waits at most 10 s for last sends, then abandons them (§7.4).
- JWT: HS256 only, key = base64-decoded extension secret (current or previous), `exp` with 60 s leeway; any failure is `unauthorized` 401 (§4.1).
- New error codes `identity-required` (403) and `twitch-unavailable` (503) (§8).
- Viewer rate limit 5 per second, counted per character ID, or per `opaque_user_id` without `user_id` (§4.1).
- CORS: only `https://<TWITCH_CLIENT_ID>.ext-twitch.tv`, with `Authorization` and `Content-Type` (§4.1).

## Review Focus

1. **A PubSub send that hangs** (Twitch accepts the connection and never answers): a person expects the Broadcaster to give up on that send after the client timeout and carry its keys, not stop broadcasting for the channel. Test in Task 2 (the client times out) and Task 5 (the Broadcaster carries the keys).
2. **A Room that unloads and reloads within a second**: a person expects the new Broadcaster's first send to wait behind the old one's last send on the same gate, so Twitch never sees two sends in one second. Test in Task 6.
3. **A JWT whose `channel_id` belongs to a channel whose Room failed to load at boot**: a person expects the route to try loading it again, not answer `unknown-channel`. Test in Task 7.
4. **Two `join`s for the same new viewer at once while Get Users is slow**: a person expects one character, named once, not a crash or a duplicate. Test in Task 7.
5. **A party of 3 000 with a long monster name**: a person expects every snapshot to stay under 5 KB, the party to be trimmed before keys are held back, and `pt` to give the real size. Test in Task 4.

---

## File map (this plan)

```
apps/server/src/
  config.ts             TwitchConfig, readTwitchConfig
  twitch/jwt.ts         verifyExtensionJwt, signJwt, pubsubJwt
  twitch/api.ts         TwitchClient, HttpTwitchClient, TwitchError
  twitch/gate.ts        PacingGate
  twitch/snapshot.ts    keyFor, refreshWindow, buildSnapshot
  twitch/broadcaster.ts Broadcaster
  twitch/layer.ts       TwitchLayer (attach/detach, caches, shutdown)
  ext.ts                registerExt (/ext routes, CORS)
  crypto.ts             + Secrets.derive
  store.ts              + ChannelRow.twitchId, channelByTwitchId, createChannel twitchId
  room-manager.ts       + RoomHooks
  server.ts             + ServerOpts.twitch / twitchClient, wiring, shutdown step 3
packages/protocol/src/index.ts   + identity-required, twitch-unavailable
apps/cli/src/server.ts           start reads Twitch env
apps/server/test/
  helpers/fake-twitch.ts
  helpers/twitch.ts     twitchSetup()
  helpers/golden.ts     shared golden-script helpers (moved from e2e-golden.test.ts)
  config.test.ts  jwt.test.ts  twitch-api.test.ts  gate.test.ts  snapshot.test.ts
  broadcaster.test.ts  layer.test.ts  ext.test.ts  ext-golden.test.ts
```

---

### Task 1: Twitch config, JWTs and error codes

**Files:**
- Create: `apps/server/src/config.ts`, `apps/server/src/twitch/jwt.ts`
- Modify: `packages/protocol/src/index.ts`, `apps/server/src/server.ts` (`ServerOpts.twitch`), `apps/cli/src/server.ts` (`start`)
- Test: `apps/server/test/config.test.ts`, `apps/server/test/jwt.test.ts`, `apps/cli/test/server.test.ts`

**Interfaces:**
- Produces:
  - `interface TwitchConfig { clientId: string; clientSecret: string; extensionSecret: string; extensionSecretPrevious: string | null; ownerId: string; publicUrl: string; apiBase: string; authBase: string }`
  - `const TWITCH_API_BASE = 'https://api.twitch.tv/helix'`, `const TWITCH_AUTH_BASE = 'https://id.twitch.tv/oauth2'`
  - `readTwitchConfig(env: NodeJS.ProcessEnv): TwitchConfig | null`: `null` when none of the five are set; throws `Error('Twitch is partly configured; missing: <NAMES, comma-separated, in §7.2 table order>')` when some are; `publicUrl` loses any trailing `/`. The base URLs are never read from env (README decision 6).
  - `interface ExtClaims { channel_id: string; opaque_user_id: string; user_id?: string; role: string; exp: number }`
  - `verifyExtensionJwt(token: string, secrets: string[], nowMs: number): ExtClaims | null` (`secrets` are base64 strings, current first)
  - `signJwt(payload: Record<string, unknown>, secretB64: string): string` (header `{"alg":"HS256","typ":"JWT"}`)
  - `pubsubJwt(cfg: TwitchConfig, channelTwitchId: string, nowMs: number): string`, with payload `{ exp: floor(now/1000) + 60, user_id: cfg.ownerId, role: 'external', channel_id, pubsub_perms: { send: ['broadcast'] } }`
  - protocol `STATUS`: `'identity-required': 403`, `'twitch-unavailable': 503`
  - `ServerOpts.twitch?: TwitchConfig` (used from Task 6)

- [ ] **Step 1: Write the failing tests**

`jwt.test.ts` (secret `Buffer.from('test-ext-secret').toString('base64')`, now `1_800_000_000_000`):

```ts
it('accepts a valid token', () => expect(verifyExtensionJwt(signJwt(claims, S), [S], now)).toMatchObject({ channel_id: '1001', user_id: '42' }));
it('accepts an expired token within 60 s of leeway and refuses one past it', () => {
  expect(verifyExtensionJwt(signJwt({ ...claims, exp: now / 1000 - 59 }, S), [S], now)).not.toBeNull();
  expect(verifyExtensionJwt(signJwt({ ...claims, exp: now / 1000 - 61 }, S), [S], now)).toBeNull();
});
it('refuses the wrong secret', () => expect(verifyExtensionJwt(signJwt(claims, OTHER), [S], now)).toBeNull());
it('accepts the previous secret', () => expect(verifyExtensionJwt(signJwt(claims, OLD), [S, OLD], now)).not.toBeNull());
it('refuses alg other than HS256', () => { /* hand-build header {"alg":"none"} with an empty signature, and one with "HS512": both null */ });
it('reads a token without user_id', () => expect(verifyExtensionJwt(signJwt({ ...claims, user_id: undefined }, S), [S], now)!.user_id).toBeUndefined());
it('pubsubJwt carries the send permission', () => { /* decode the payload: role external, pubsub_perms.send ['broadcast'], exp = now/1000 + 60 */ });
```

`config.test.ts`:

```ts
it('none set is null', () => expect(readTwitchConfig({})).toBeNull());
it('partial names what is missing', () => expect(() => readTwitchConfig({ TWITCH_CLIENT_ID: 'x' }))
  .toThrow('Twitch is partly configured; missing: DNDM_PUBLIC_URL, TWITCH_CLIENT_SECRET, TWITCH_EXTENSION_SECRET, TWITCH_OWNER_ID'));
it('the previous secret is optional and not part of the check', () => expect(readTwitchConfig(FULL)!.extensionSecretPrevious).toBeNull());
```

In `apps/cli/test/server.test.ts`: `start` with a partial Twitch env exits with that message, and `start` with full Twitch env and `DNDM_DEV=1` writes a line containing `DNDM_DEV=1 with Twitch configured`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/test/jwt.test.ts apps/server/test/config.test.ts apps/cli/test/server.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

Compare the signature with `timingSafeEqual` after a length check. Refuse three-part tokens whose header doesn't parse, whose `alg` isn't `HS256`, or whose payload lacks a string `channel_id` or `opaque_user_id` or a numeric `exp`. In the CLI, `start` calls `readTwitchConfig(o.env)`, turns its error into a `CliError`, and passes the result as `twitch`. With Twitch configured and `DNDM_DEV=1`, it writes `say('warning', 'DNDM_DEV=1 with Twitch configured: dev login is on')` every boot.

- [ ] **Step 4: Run them and see them pass**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/twitch/jwt.ts apps/server/src/server.ts packages/protocol apps/cli apps/server/test
git commit -m "feat(server): Twitch config, extension JWTs and new error codes"
```

---

### Task 2: The Twitch client and the fake Twitch

**Files:**
- Create: `apps/server/src/twitch/api.ts`, `apps/server/test/helpers/fake-twitch.ts`
- Test: `apps/server/test/twitch-api.test.ts`

**Interfaces:**
- Consumes: Task 1's `TwitchConfig`, `pubsubJwt`.
- Produces:
  - `interface TwitchUser { id: string; login: string; displayName: string }`
  - `type PubSubResult = { ok: true } | { ok: false; status: number; retryAt: number | null }` (`retryAt` in ms, from `Ratelimit-Reset` × 1000 on a 429)
  - `class TwitchError extends Error {}` (network failure, timeout, or an unexpected status on any call but PubSub)
  - `interface TwitchClient { usersById(ids: string[]): Promise<TwitchUser[]>; usersByLogin(logins: string[]): Promise<TwitchUser[]>; tokenOwner(userToken: string): Promise<TwitchUser>; authorizeUrl(state: string): string; exchangeCode(code: string): Promise<string>; revoke(userToken: string): Promise<void>; sendPubSub(broadcasterId: string, message: string): Promise<PubSubResult> }`
  - `class HttpTwitchClient implements TwitchClient { constructor(cfg: TwitchConfig, clock: Clock, timeoutMs?: number /* 10 000 */) }`
  - `fakeTwitch(): Promise<FakeTwitch>`, where `FakeTwitch = { apiBase: string; authBase: string; requests: { method: string; path: string; headers: Record<string, string>; body: unknown }[]; addUser(u: TwitchUser): void; codeFor(userId: string): string; pubsub(): { broadcasterId: string; message: unknown }[]; failNext(kind: 'pubsub' | 'users' | 'token' | 'revoke', times?: number): void; rateLimitNext(resetSec: number): void; hangNext(kind: 'pubsub' | 'users'): void; close(): Promise<void> }`

What the client sends (§6):
- App token: `POST {authBase}/token` form `client_id, client_secret, grant_type=client_credentials`. Kept in memory and refreshed when less than 10 minutes of `expires_in` remain (on `clock`). On any 401 from Helix it is refreshed once and the call retried once.
- Helix calls send `Client-Id` and `Authorization: Bearer <token>`. `usersById`/`usersByLogin`: `GET {apiBase}/users?id=…&id=…` or `?login=…` with the app token. `tokenOwner`: `GET {apiBase}/users` with the user token. Map `display_name` to `displayName`.
- `authorizeUrl`: `{authBase}/authorize?client_id=…&redirect_uri={publicUrl}/signup/callback&response_type=code&scope=&state=…`.
- `exchangeCode`: `POST {authBase}/token` form `client_id, client_secret, code, grant_type=authorization_code, redirect_uri`. Returns `access_token`.
- `revoke`: `POST {authBase}/revoke` form `client_id, token`.
- `sendPubSub`: `POST {apiBase}/extensions/pubsub` with `Authorization: Bearer <pubsubJwt>`, `Client-Id`, JSON body `{ target: ['broadcast'], broadcaster_id, message }`. 204 is `{ ok: true }`. A network error or timeout is `{ ok: false, status: 0, retryAt: null }`.
- Every call aborts after `timeoutMs` (`AbortSignal.timeout`).

The fake is a Fastify app on `127.0.0.1:0`. It serves those paths under `/oauth2` and `/helix`, records every request, checks `Client-Id`, issues `app-<n>` tokens, maps `codeFor(userId)` codes to user tokens, and answers `tokenOwner` for them. On PubSub it answers 204, or what `failNext`, `rateLimitNext` or `hangNext` asked for.

- [ ] **Step 1: Write the failing tests**

```ts
it('gets an app token once and reuses it', async () => { await c.usersById(['1']); await c.usersById(['1']); expect(fake.requests.filter((r) => r.path === '/oauth2/token')).toHaveLength(1); });
it('refreshes the app token when less than 10 minutes remain', async () => { /* fake expires_in 900; advance clock 6 min; next call gets a new token */ });
it('refreshes once on a 401 and retries', async () => { /* fake revokes app-1; usersById still answers; two token requests */ });
it('looks users up by login and the token owner by user token', async () => { /* addUser; codeFor; exchangeCode; tokenOwner returns that user */ });
it('sendPubSub posts the broadcast body with a pubsub JWT', async () => {
  expect(await c.sendPubSub('1001', '{"v":1}')).toEqual({ ok: true });
  expect(fake.pubsub()).toEqual([{ broadcasterId: '1001', message: { v: 1 } }]);
  // decode the Authorization JWT: channel_id '1001', role 'external'
});
it('a 429 reports retryAt from Ratelimit-Reset', async () => { fake.rateLimitNext(1_800_000_100); expect(await c.sendPubSub('1001', '{}')).toEqual({ ok: false, status: 429, retryAt: 1_800_000_100_000 }); });
it('a hung PubSub send times out as a failure', async () => { /* client with timeoutMs 50; hangNext('pubsub'); { ok: false, status: 0, retryAt: null } */ });
it('a failed Get Users throws TwitchError', async () => { fake.failNext('users'); await expect(c.usersById(['1'])).rejects.toBeInstanceOf(TwitchError); });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/test/twitch-api.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `HttpTwitchClient` and `fakeTwitch` as described above**

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm vitest run apps/server/test/twitch-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/twitch/api.ts apps/server/test/helpers/fake-twitch.ts apps/server/test/twitch-api.test.ts
git commit -m "feat(server): Twitch client and fake Twitch"
```

---

### Task 3: The per-channel pacing gate

**Files:**
- Create: `apps/server/src/twitch/gate.ts`
- Test: `apps/server/test/gate.test.ts`

**Interfaces:**
- Consumes: Task 2's `PubSubResult`; Plan 2a's `Clock`.
- Produces:
  - `class PacingGate { constructor(clock: Clock) }`
  - `send(twitchId: string, attempt: () => Promise<PubSubResult>, opts?: { retryUntil?: number }): Promise<boolean>`. Sends for one channel queue in call order. Each attempt waits until all of: 1 000 ms after the channel's last attempt, the channel's 429 `retryAt`, and the channel's backoff (`min(1000 × 2^(failures−1), 30 000)` after a failure; reset on success). Without `retryUntil` it makes one attempt and resolves `true` or `false`. With it, it keeps attempting until success or until the next attempt would start after `retryUntil`.
  - `markDropped(twitchId: string): void`, `hasDropped(twitchId: string): boolean`, `clearDropped(twitchId: string): void`
  - `idle(): Promise<void>` (resolves when no send is queued or running)

State is per Twitch ID and lives as long as the gate (one per process), so it outlives Broadcasters (§5.3).

- [ ] **Step 1: Write the failing tests** (FakeClock; `attempt` records `clock.now()`)

```ts
it('spaces sends for one channel at least 1 s apart, in order', async () => { /* three sends at t=0 → attempts at 0, 1000, 2000 */ });
it('does not space different channels against each other', async () => { /* '1' and '2' at t=0 → both attempt at 0 */ });
it('a 429 waits until retryAt', async () => { /* first answers { ok:false, status:429, retryAt: 5000 }; next attempt at 5000 */ });
it('failures back off 1 s, doubling, at most 30 s, and reset on success', async () => { /* attempts at 0, 1000, 3000, 7000, … capped gaps of 30000; after a success the gap is 1000 again */ });
it('retryUntil retries until the deadline, then resolves false', async () => { /* always fails; retryUntil 30000; resolves false; no attempt after 30000 */ });
it('dropped keys are remembered until cleared', () => { g.markDropped('1'); expect(g.hasDropped('1')).toBe(true); g.clearDropped('1'); expect(g.hasDropped('1')).toBe(false); });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/test/gate.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `PacingGate`**: one promise chain per Twitch ID; waits use `clock.setTimer`.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm vitest run apps/server/test/gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/twitch/gate.ts apps/server/test/gate.test.ts
git commit -m "feat(server): per-channel PubSub pacing gate"
```

---

### Task 4: Keys, the snapshot format, size and `rw`

**Files:**
- Create: `apps/server/src/twitch/snapshot.ts`
- Modify: `apps/server/src/crypto.ts` (`Secrets.derive`)
- Test: `apps/server/test/snapshot.test.ts`

**Interfaces:**
- Consumes: Plan A's `View` (party `level`, `statuses`).
- Produces:
  - `Secrets.derive(label: string): Buffer` (the existing `derive(label, secret)`, made public; labels used in 2b: `'snapshot-key'`, `'session'`, `'state'`, `'csrf'`)
  - `MAX_BYTES = 5120`, `BACKLOG_CAP = 3000`, `RF_WINDOW = 30_000`
  - `keyFor(k: Buffer, channelId: string, characterId: string): string`
  - `refreshWindow(keys: number, rf: boolean): number`
  - `interface SnapshotInput { e: string; t: number; publicView: View; keyOf: (characterId: string) => string; rv: number; cv: number; waiting: string[]; rf: boolean }` (`waiting` = keys, longest-waiting first)
  - `interface Built { message: string; content: string; sentKeys: string[]; rf: boolean; bare: boolean }`
  - `buildSnapshot(i: SnapshotInput): Built`

Field mapping (§5.1): `v: 1`; `e`; `t`; `ph = phase`; `adv = adventure`; `f = fight && { n: monster.name, img: monster.image, hp, mx: maxHp, st: statuses.map(s => s.status), sub: sub === 'fighting' ? 'f' : 'w', held, nt: nextTurnAt }`, or `null`; `p = party.map(m => [keyOf(m.id), m.class, maxHp > 0 ? Math.round(100 × hp / maxHp) : 0, m.knockedOut ? 1 : 0])`; `rv`; `ch` = the keys sent (always present, possibly `[]`) or, for an `rf`, `rf: true` and no `ch`; `rw = refreshWindow(sentKeys.length, rf)`; `cv`. `content` is `JSON.stringify` of the message without `t` and `rw`.

Size (§5.4), checked in this order: the full message → trim `p` to the longest prefix that fits and add `pt` (the full party size) → with `p` empty, keep the longest prefix of `waiting` that fits in `ch` → with `ch` empty too, the bare form `{ v, e, t, rf: true, rw: 30000, cv }`, with `bare: true`. An `rf` input skips the `ch` step. `sentKeys` is what went into `ch`, or every waiting key for an `rf` (which clears them).

- [ ] **Step 1: Write the failing tests**

```ts
it('keys are 10 base64url characters, stable, and differ by channel', () => { /* keyFor(k,'c1','twitch:1') twice equal, length 10, /^[A-Za-z0-9_-]{10}$/; keyFor(k,'c2','twitch:1') differs; 'dev:al' also length 10 */ });
it('rw', () => { expect(refreshWindow(0, false)).toBe(1000); expect(refreshWindow(250, false)).toBe(2500); expect(refreshWindow(5000, false)).toBe(30000); expect(refreshWindow(3, true)).toBe(30000); });
it('maps the public view, with no events, panel or overlay', () => {
  const b = buildSnapshot(input);
  const m = JSON.parse(b.message);
  expect(m).toEqual({ v: 1, e: 'q7Lw2k', t: 5, ph: 'fight', adv: null, f: { n: 'Slime', img: null, hp: 140, mx: 200, st: [], sub: 'f', held: false, nt: 9000 },
    p: [[K('twitch:1'), 'starter:fighter', 80, 0], [K('twitch:2'), 'starter:healer', 0, 1]], rv: 7, ch: [K('twitch:1')], rw: 1000, cv: 3 });
  expect(JSON.parse(b.content)).not.toHaveProperty('t');
  expect(JSON.parse(b.content)).not.toHaveProperty('rw');
});
it('a party too big for 5 KB is trimmed by join order and pt gives the full size', () => { /* 3000 members; bytes ≤ 5120; p is a prefix; pt 3000 */ });
it('keys that do not fit after p is empty are held back, longest-waiting first', () => { /* long monster name so p empties; ch is a prefix of waiting; sentKeys equals it */ });
it('an rf sends rf: true with no ch and claims every waiting key', () => { /* rf input → m.rf true, m.ch undefined, rw 30000, sentKeys = waiting */ });
it('a snapshot that does not fit with p and ch empty becomes the bare form', () => {
  const m = JSON.parse(buildSnapshot({ ...input, publicView: withMonsterName('x'.repeat(6000)) }).message);
  expect(Object.keys(m).sort()).toEqual(['cv', 'e', 'rf', 'rw', 't', 'v']);
  expect(m.rw).toBe(30000);
});
it('every built message is at most 5 KB', () => { /* run all cases above, Buffer.byteLength(message) ≤ 5120 */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/test/snapshot.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `keyFor`, `refreshWindow`, `buildSnapshot` and `Secrets.derive`**

Trim `p` and `ch` with a binary search on prefix length.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm vitest run apps/server/test/snapshot.test.ts apps/server/test/crypto.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/twitch/snapshot.ts apps/server/src/crypto.ts apps/server/test/snapshot.test.ts
git commit -m "feat(server): snapshot keys, format, size fallbacks and rw"
```

---

### Task 5: The Broadcaster

**Files:**
- Create: `apps/server/src/twitch/broadcaster.ts`
- Test: `apps/server/test/broadcaster.test.ts`

**Interfaces:**
- Consumes: Plan A's `Room.broadcastState()`, `Room.inputs`, `Room.channel.configVersion`; Tasks 2–4.
- Produces:
  - `interface RosterMember { id: string; key: string; name: string; class: string | null; level: number }`
  - `interface BroadcasterDeps { room: Room; twitchId: string; client: TwitchClient; gate: PacingGate; clock: Clock; keyOf: (characterId: string) => string; firstSinceStart: boolean; backlogCap?: number /* BACKLOG_CAP; tests lower it */; log?: (msg: string, extra?: Record<string, unknown>) => void }`
  - `class Broadcaster { readonly epoch: string; rv: number; roster: RosterMember[]; constructor(d: BroadcasterDeps); start(): Promise<void>; tick(): Promise<void>; final(): Promise<(retryUntil: number | null) => Promise<boolean>>; stop(): void; idle(): Promise<void> }`

Behaviour (§5.3, §5.4):
- `epoch`: 6 random base64url characters.
- `start()` queues `broadcastState()` first, then records the result as "last sent" (the `content` of a non-`rf` snapshot with `ch: []`), records `inputs` and `cv`, computes the roster (`rv = 1`), and arms a 1 000 ms repeating timer on `clock` that calls `tick()`.
- `tick()` does nothing while a send is in flight (README decision 4). Otherwise it calls `broadcastState()` only if `room.inputs` moved, keys are waiting, or an `rf` is due:
  - **Due:** `firstSinceStart` not yet sent, `gate.hasDropped(twitchId)`, or `cv` moved.
  - **The backlog** (`waiting.size > BACKLOG_CAP`) also makes the snapshot an `rf`.
- With the result, `tick()`:
  - adds `keyOf(id)` for each changed ID to `waiting` (an insertion-ordered set: a key already waiting keeps its place);
  - recomputes the roster from `publicView.party` (id, name, class, level, in order) and raises `rv` when it differs;
  - builds the snapshot.
- It sends when any of these hold: the snapshot is an `rf` and not bare; a due `rf` is bare; `content` differs from last sent; `sentKeys` is non-empty.
- **The bare throttle:** a non-due bare `rf` sends only when 30 s have passed since the last bare send and `inputs` moved or keys are waiting since then.
- **On success:** record `content` as last sent. If it was an `rf`, clear `waiting` and the due flags (`gate.clearDropped`). Otherwise remove `sentKeys` from `waiting`.
- **On failure:** keep everything. The gate holds the backoff.
- `final()` stops the timer, queues the last `broadcastState()`, builds the last snapshot with the same rules, and returns a function that sends it through the gate with the given `retryUntil`. The function resolves `true` when there was nothing to send.
- `idle()` resolves when no tick or send is running.

- [ ] **Step 1: Write the failing tests**

Use `roomSetup({ broadcast: true })` (Plan A), a `fakeTwitch()` behind `HttpTwitchClient`, a `PacingGate` on the same `FakeClock`, and `keyOf = (id) => keyFor(k, channelId, id)`. `advance(ms)` settles with `room.idle()` and `b.idle()`. `sent()` parses `fake.pubsub()` messages.

```ts
it('first since start: an rf goes out on the first tick even though nothing changed', async () => { /* firstSinceStart true; start; advance 1000; one message, rf true, rw 30000 */ });
it('an ordinary load sends nothing until something changes, then a join is sent', async () => { /* firstSinceStart false; advance 5000 → none; join; advance 1000 → one message with ch [key(al)], and its e is b.epoch */ });
it('at most one send per second', async () => { /* commands in five consecutive 200 ms steps; ≤ 1 message per 1000 ms window */ });
it('no send when nothing changed', async () => { /* after the first send, advance 10 s with no input → no more messages */ });
it('failed sends and 429s keep their keys', async () => { /* fake.failNext('pubsub'); join al; tick fails; join bo; next successful message ch has both keys */ });
it('a hung send is given up after the client timeout and its keys carried', async () => { /* hangNext; client timeoutMs 50; the next send carries the key */ });
it('dropped keys make the next send an rf, even with nothing changed', async () => { /* gate.markDropped('1001'); advance 1000; rf; gate.hasDropped false after */ });
it('a config change moves cv and sends an rf', async () => { /* updateConfig through the dock; next message cv 2, rf true */ });
it('rv bumps on roster changes only', async () => { /* join → rv 2; an attack → rv stays 2; level up or class change → rv 3 */ });
it('a public change puts nobody in ch', async () => { /* held fight, al attacks: ch is [key(al)] and never key(bo) */ });
it('a fight starting puts members whose readiness flips in ch, a cooldown ending alone does not', async () => { /* … */ });
it('more waiting keys than the cap makes the send an rf, and an rf clears waiting keys', async () => { /* backlogCap 3; failNext('pubsub', 4) while four viewers join, one per second, so their keys wait; the next successful send is rf; the tick after has ch [] */ });
it('while snapshots never fit, the bare rf goes out at most once per 30 s and only after a change; a config change still goes out', async () => { /* monster name 6000 chars; changes every second for 60 s → bare messages ≥ 30 s apart; updateConfig inside the window → bare rf sent at once */ });
it('a secret shop never puts its content in a snapshot', async () => {
  // party of al and bo; dock startEncounter { 'starter:shop': { secret: true, … } } as packs/starter/content/encounters.yaml defines it;
  // al buys an item that grants a class; al equips it while the shop is still open
  for (const m of sent()) expect(JSON.stringify(m)).not.toMatch(/shop-list|price|entries|events/);
  // and al's p entry changes class after the equip, with rv raised (criterion 3);
  // the shop's own events and reactions carry an audience, while the equip's events (from the Room's output) have none (§5.1, §5.7)
});
it('a restricted encounter that heals keeps its events restricted while p shows the new HP', async () => {
  // roomSetup with an extra test bundle (a kind like Plan A Task 1's hush, whose respond heals); al hurt, then responds;
  // the heal events have audience; the next message's p entry for al has the higher hpPercent
});
it('final() runs the last broadcastState through the queue before the Room closes', async () => { /* change; send = await b.final(); room.close(); await send(null) → message carries the change */ });
```

Write each test out in full from its comment.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/test/broadcaster.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `Broadcaster` as described above**

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm vitest run apps/server/test/broadcaster.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/twitch/broadcaster.ts apps/server/test/broadcaster.test.ts
git commit -m "feat(server): the Broadcaster"
```

---

### Task 6: `TwitchLayer`, RoomManager hooks, the store and shutdown

**Files:**
- Create: `apps/server/src/twitch/layer.ts`
- Modify: `apps/server/src/room-manager.ts`, `apps/server/src/store.ts`, `apps/server/src/server.ts`, `apps/server/src/index.ts`
- Test: `apps/server/test/layer.test.ts`, `apps/server/test/helpers/twitch.ts`, `apps/server/test/store.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `ChannelRow.twitchId: string | null`; `Store.channelByTwitchId(twitchId: string): Promise<ChannelRow | null>`; `Store.createChannel({ …, twitchId?: string })`; `createChannel({ …, twitchId?: string })` in `server.ts`
  - `interface RoomHooks { attach(room: Room): Promise<void>; detach(room: Room): Promise<void> }`. `detach` runs the last `broadcastState()`, calls `room.close()`, starts the background last send, and resolves once the Room is closed.
  - `new RoomManager(deps, hooks?: RoomHooks)`: `get()` awaits `hooks.attach(room)` for a broadcasting Room before it resolves or caches it; `sweep()` calls `hooks.detach(room)` instead of `room.close()` for one.
  - `class TwitchLayer implements RoomHooks { constructor(o: { config: TwitchConfig; client: TwitchClient; clock: Clock; secrets: Secrets; log?: … }); readonly gate: PacingGate; wantsBroadcast(c: ChannelRow): boolean; keyOf(channelId: string, characterId: string): string; broadcaster(channelId: string): Broadcaster | undefined; shutdown(timeoutMs: number): Promise<void>; idle(): Promise<void> }`
  - `ServerOpts.twitchClient?: TwitchClient`; `RunningServer.layer: TwitchLayer | null`

`TwitchLayer`:
- `wantsBroadcast(c)` is `c.twitchId !== null`. `keyOf` uses `keyFor(secrets.derive('snapshot-key'), …)`.
- `attach` creates and starts a `Broadcaster`. `firstSinceStart` is `true` the first time a channel is attached in this process (a `Set` of channel IDs).
- `detach(room)` calls `const send = await b.final()`, then `room.close()`, then, in the background, `send(clock.now() + 30_000)`. A `false` result calls `gate.markDropped(twitchId)`.
- `shutdown(timeoutMs)` calls `final()` on every Broadcaster, then waits for the sends (each with `retryUntil: null`) raced against `timeoutMs`. Whatever is left is abandoned.

`startServer` with `opts.twitch`:
- creates `client = opts.twitchClient ?? new HttpTwitchClient(opts.twitch, clock)` and the layer;
- passes `broadcast: (c) => layer.wantsBroadcast(c)` in `RoomDeps` and the layer as hooks;
- calls `close()` in this order: `app.close()`, then `manager.idle()` (15 s), then `layer.shutdown(10_000)`, then `manager.close()`, then `store.close()`.

`twitchSetup(o?: { serverOpts?: Partial<ServerOpts> })` in `helpers/twitch.ts` (Plan C passes `{ serverOpts: { signup: ... } }`) returns `{ t, fake, srv, clock, channelId, twitchId: '1001', dockToken, jwt(o: { user?: string; opaque?: string; exp?: number; channel?: string }): string, ext(method: 'GET' | 'POST', path: string, o: { jwt?: string; body?: unknown; origin?: string }): Promise<LightMyRequest.Response>, dock(command): Promise<Answer>, advance(ms: number): Promise<void>, snapshots(): Snapshot[], close(): Promise<void> }`. It builds a fresh database, a fake Twitch, a channel created with `twitchId: '1001'`, and a server with Twitch config pointing at the fake, a `FakeClock` and rate limits on. `advance` settles with `srv.manager.idle()` and `srv.layer!.idle()`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a Twitch channel gets a Broadcaster when its Room loads; a channel without twitch_id does not', async () => { /* manager.get(twitch) → layer.broadcaster(id) defined; plain channel → undefined and room.broadcasting false */ });
it('the first Broadcaster for a channel after a restart sends rf, at boot or on a later load', async () => { /* close server; start again on the same db; get → first send rf. Then unload (sweep after 31 idle min) and load again in the same process → first send is not rf */ });
it('e is new with every Broadcaster', async () => { /* unload and reload → different epoch in the next message */ });
it('the unload runs the last broadcastState before the Room closes and sends it', async () => { /* change, then sweep; the change arrives in a message after the Room is closed */ });
it('a reload within a second queues its first send behind the old last send', async () => { /* unload then get within 200 ms; two messages ≥ 1000 ms apart */ });
it('an unload last send that fails for 30 s records dropped keys, and the next Broadcaster sends rf', async () => { /* failNext('pubsub', 100); sweep; advance 31 s; reload → rf */ });
it('keys dropped while a newer Broadcaster already runs make its next send an rf', async () => { /* old last send failing in the background while the new one runs; after 30 s the new one sends rf */ });
it('shutdown runs each last tick and waits at most 10 s', async () => { /* hangNext pubsub; close() resolves within 10 s of FakeClock time plus idle */ });
it('no Twitch settings: no layer, no Broadcasters', async () => { /* startServer without twitch → srv.layer null */ });
```

`store.test.ts`: `channelByTwitchId` finds the channel created with `twitchId`, and returns `null` otherwise.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/test/layer.test.ts apps/server/test/store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the store additions, `RoomHooks`, `TwitchLayer` and the server wiring**

- [ ] **Step 4: Run every test**

Run: `pnpm test`
Expected: PASS. 2a tests run without Twitch, so they are unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src apps/server/test
git commit -m "feat(server): TwitchLayer, Broadcaster lifecycle and shutdown step 3"
```

---

### Task 7: The `/ext` routes

**Files:**
- Create: `apps/server/src/ext.ts`
- Modify: `apps/server/src/server.ts` (register when Twitch is configured), `apps/server/src/twitch/layer.ts` (caches)
- Test: `apps/server/test/ext.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:
  - `registerExt(app: FastifyInstance, deps: { manager: RoomManager; layer: TwitchLayer; store: Store; limiter: RateLimiter; config: TwitchConfig; client: TwitchClient; clock: Clock; log?: … }): void`
  - Caches on `TwitchLayer`: `publicView(room: Room): Promise<View>` (one copy per Room `inputs` value), `describe(room: Room): Description` (one per `configVersion`), `roster(channelId: string): { rv: number; members: [string, string, string, string | null, number][] }` (from the channel's Broadcaster, so one copy per (`e`, `rv`)).

Every route (§4.1, §5.6):
- `Authorization: Bearer <jwt>`, checked by `verifyExtensionJwt` against `[extensionSecret, extensionSecretPrevious]` and `clock.now()`. Failure is 401 `unauthorized`.
- The channel comes from `store.channelByTwitchId(claims.channel_id)`, cached in memory once found. No match is 404 `unknown-channel` "This streamer hasn't set up the game yet."
- The Room comes from `manager.get(channel.id)`, asked again once if it was closed in between, as `app.ts`'s `liveRoom` does.
- The rate limit is `limiter.take('viewer', 'viewer:<channelId>:twitch:<user_id>')`, or `'viewer:<channelId>:opaque:<opaque_user_id>'` without `user_id`.
- With identity, the sender is `{ role: 'viewer', character: 'twitch:<user_id>' }`. A `broadcaster` or `moderator` role changes nothing.
- CORS: when `Origin` is `https://<clientId>.ext-twitch.tv`, answers carry `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`. `OPTIONS /ext/*` answers 204 with `Access-Control-Allow-Headers: Authorization, Content-Type` and `Access-Control-Allow-Methods: GET, POST`. Other origins get no CORS headers.

Answers (README decision 8: every answer carries `ok`):
- `GET /ext/view`: with identity, `{ ok: true, view: await room.view(sender), key }`. Without, `{ ok: true, view: await layer.publicView(room) }`.
- `POST /ext/commands`, body `commandRequestSchema`:
  - Without identity: 403 `identity-required`.
  - On `join`: `client.usersById([user_id])` sets `command.name = displayName`, ignoring any client `name`. On `TwitchError`, a character already stored (`store.characters(channelId, [id])`) joins with its stored name. A new one gets 503 `twitch-unavailable`.
  - Then `room.command(sender, id, command)`. On `ok: true` and on engine rejections (`!ok` and `httpStatus(code) === 200`), the answer adds `view: await room.view(sender)` and `key`. A replayed request ID gets the same fresh `view` and `key`.
- `GET /ext/describe`: `{ ok: true, describe: layer.describe(room) }`.
- `GET /ext/roster`: `{ ok: true, ...layer.roster(channelId) }`, members `[key, id, name, class, level]`.
- `GET /ext/party`: `{ ok: true, members: (await room.view({ role: 'overlay' })).party.map(m => ({ key, id, name, class, level, hp, maxHp, knockedOut, statuses })) }`.

- [ ] **Step 1: Write the failing tests** (`twitchSetup()`)

```ts
it('each route answers', async () => { /* view (own, with key), commands join, describe, roster after a tick, party after join */ });
it('without user_id, view is the public view and commands answer identity-required', async () => {
  const j = s.jwt({ opaque: 'U-anon' });
  expect((await s.ext('GET', '/ext/view', { jwt: j })).json().view.character).toBeNull();
  const r = await s.ext('POST', '/ext/commands', { jwt: j, body: { id: 'a', command: { type: 'join', pick: 'starter:sword' } } });
  expect(r.statusCode).toBe(403); expect(r.json().error.code).toBe('identity-required');
});
it('roster, party and describe answer a JWT without user_id', async () => { /* all 200 */ });
it('a viewer acts only as themselves', async () => { /* command { character: 'twitch:999' } runs as twitch:42 */ });
it('the rate limit is 5 per second per viewer', async () => { /* 6th GET in the same ms → 429 rate-limited */ });
it('CORS for the extension origin only', async () => { /* origin https://<clientId>.ext-twitch.tv → header; https://evil.example → none; OPTIONS → 204 with allow headers */ });
it('command answers carry view and key, on success and on engine rejection', async () => { /* join → view.character.inParty true, key; second join → rejection still with view and key */ });
it('a client name is ignored on join', async () => { /* addUser { id: '42', displayName: 'Real Name' }; join with name 'Fake' → view.character.name 'Real Name' */ });
it('Get Users failing on join: an existing character joins with their stored name, a new one gets twitch-unavailable', async () => { /* … 503 for new */ });
it('a replayed /ext/commands request gets a fresh view and key', async () => { /* same id twice; second answer's view reflects a change made in between */ });
it('a key from /ext/view matches p, ch and /ext/roster', async () => { /* join; advance 1000; key in snapshot p[0][0], ch, roster members[0][0] */ });
it('an unsigned-up channel_id is unknown-channel with the setup message', async () => { /* jwt({ channel: '9999' }) → 404, message "This streamer hasn't set up the game yet." */ });
it('a channel whose Room failed to load is tried again', async () => { /* make the first manager.get throw once (Room.load spy); the next /ext/view succeeds */ });
it('two joins for the same new viewer at once while Get Users is slow make one character', async () => { /* hangNext('users') briefly; two parallel joins with different request IDs; one ok, one engine rejection; store has one twitch:42 */ });
it('roster and describe are served from a cache', async () => { /* spy on room.describe: called once for two describe requests at the same cv */ });
it('without Twitch settings there are no /ext routes', async () => { /* startServer without twitch; GET /ext/view → 404 */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/test/ext.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `registerExt` and the caches as described above**

- [ ] **Step 4: Run every test**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/ext.ts apps/server/src/server.ts apps/server/src/twitch/layer.ts apps/server/test/ext.test.ts
git commit -m "feat(server): /ext routes with extension JWT auth"
```

---

### Task 8: Criteria 1 and 2 through `/ext`

**Files:**
- Create: `apps/server/test/helpers/golden.ts` (move `Line`, `Out`, `read`, `direct`, `undev` out of `e2e-golden.test.ts`), `apps/server/test/ext-golden.test.ts`
- Modify: `apps/server/test/e2e-golden.test.ts` (import from the helper; behaviour unchanged)

**Interfaces:**
- Consumes: `twitchSetup()` (Task 6), the golden scripts in `apps/cli/test/golden/*.jsonl`.

Criterion 2: replay each script with streamer lines through `POST /channels/:id/commands` with the dock token, and viewer lines through `POST /ext/commands` with a JWT whose `user_id` is the script's viewer name (README decision 9). `wait` and `next` lines move the `FakeClock` as `e2e-golden.test.ts` does. Before replaying, `fake.addUser({ id: name, login: name, displayName })` for each viewer, where `displayName` is the `name` the script's `join` line uses. Collect events from the `/ext/commands` and dock answers in the same order as the 2a test, and strip `twitch:` the way `undev` strips `dev:`. Compare with `direct(lines)`.

Criterion 1: one test through `/ext` only, with the streamer's side through the dock routes. A viewer reads their view, joins, fights (`spawnMonster` by the dock, attack by the viewer), and sees their state change in the `/ext/commands` answer and in a snapshot sent to the fake Twitch whose `ch` holds their key.

- [ ] **Step 1: Move the helpers, run the 2a golden test**

Run: `pnpm vitest run apps/server/test/e2e-golden.test.ts`
Expected: PASS (unchanged behaviour).

- [ ] **Step 2: Write `ext-golden.test.ts`**

```ts
describe.each(scripts)('extension golden script %s (criterion 2)', (name) => {
  it('gives the same events as dndm run', async () => expect(await viaExt(read(name))).toEqual(await direct(read(name))));
});
it('criterion 1: read, join, fight and see state change through /ext and snapshots', async () => { /* as described above */ });
```

- [ ] **Step 3: Run it**

Run: `pnpm vitest run apps/server/test/ext-golden.test.ts`
Expected: PASS. If a script fails, compare the first differing event. The likely causes are a display name or a request order, not the engine.

- [ ] **Step 4: Run every test**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/test
git commit -m "test(server): golden scripts and criterion 1 through /ext"
```
