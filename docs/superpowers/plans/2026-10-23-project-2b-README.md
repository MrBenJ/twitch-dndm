# Project 2b implementation plans: index

Project 2b (the Twitch layer) is split into three plans. Run them in order: each depends on the ones before it, and each ends with working, tested software.

| Plan | File | Delivers |
|---|---|---|
| A | `2026-10-23-p2b-a-engine-and-room.md` | Reaction audiences and party `level`/`statuses` (engine), the comparison view, `room.broadcastState()` and the sweep hold (Room), `GET /health`, shutdown that drains Room queues. No Twitch code. |
| B | `2026-10-23-p2b-b-twitch-layer.md` | Twitch config, extension JWTs, the Twitch client and a fake Twitch, the per-channel pacing gate, snapshots, the Broadcaster and `TwitchLayer`, the `/ext` routes, criteria 1 and 2 through `/ext` |
| C | `2026-10-23-p2b-c-signup-and-deploy.md` | The allowlist (table and CLI), signed cookies, sign-up with Twitch, the setup page, `Dockerfile`, `fly.toml`, the CI image build, `docs/deploy.md` with the live check |

**Spec:** `docs/superpowers/specs/2026-10-17-twitch-layer-design.md` (rev 16, approved). It builds on `2026-10-11-server-core-design.md` (2a) and `2026-10-11-engine-and-packs-design.md`.

## Running tests

As for 2a:

```bash
docker compose up -d postgres
export DATABASE_URL=postgres://dndm:dndm@localhost:5455/dndm
pnpm test
```

Tests that need Twitch use the fake Twitch (`apps/server/test/helpers/fake-twitch.ts`), a local Fastify app. No test talks to real Twitch. Real Twitch is checked only by the live check in `docs/deploy.md`.

## Decisions the plans make that the spec leaves open

These are implementation choices, flagged so the owner can overrule them:

1. **The comparison view compares the stored cooldown end time, not the view's `readyAt`.** The view's `readyAt` turns `null` the moment a cooldown passes, so comparing it would make "a cooldown running out" a change, which §5.2 says it isn't. The engine never deletes cooldown entries, so the stored end time changes only when the ability is used. `ready` and `reason` come from a view of a copy with that character's cooldowns cleared.
2. **A reaction's audience is the one its encounter's handling point gives its own events.** The audience is computed when that point (start, `respond`, wake-up, end) finishes, for the jobs it queued, since reactions run only later in `settle`. §5.7 says "worked out when it is queued". This is the same moment as far as any other code can see.
3. **`inputs` counts saves from commands, timers and config changes**, not from regenerating a URL, which changes no game state.
4. **One PubSub send in flight per Broadcaster.** A tick that comes while a send is still waiting on the gate or on Twitch does nothing. Changes keep accumulating in the Room and go in the next send.
5. **No new dependencies.** CORS headers, cookies and form bodies are handled by a few lines each instead of `@fastify/cors`, `@fastify/cookie` and `@fastify/formbody`.
6. **Twitch's base URLs are `TwitchConfig` fields with fixed defaults**, set by tests through `ServerOpts`. They aren't environment variables, so the §7.2 table is unchanged.
7. **A non-`rf` snapshot always carries `ch`**, as `[]` when no keys are sent, so a client never has to guess.
8. **Every `/ext` answer carries `ok`**, like 2a's answers: `/ext/roster` is `{ ok: true, rv, members }`.
9. **The extension golden test uses each script viewer's name as their Twitch user ID** (`twitch:alice`), so events match `dndm run` once the `twitch:` prefix is stripped (§1.1 criterion 2).
10. **The server listens before it boots**, so `GET /health` can answer 503 while Rooms load.
11. **Sign-up routes and failure pages.** The button links to `/signup/start`, which sets the `state` cookie and redirects to Twitch. Failure pages answer 200 (cancelled), 400 (bad `state`), 502 (Twitch didn't answer) and 403 (not on the allowlist).
12. **The allowlist commands need only `DATABASE_URL`, `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`** (for the app token), not the full Twitch config. Logins are stored lowercase.
13. **The install link is `https://dashboard.twitch.tv/extensions/<TWITCH_CLIENT_ID>`.** The live check confirms it opens the extension's page. If it doesn't, the owner gives the right URL.
14. **`fly.toml` sets `kill_signal = "SIGTERM"`.** Fly's default is SIGINT. The CLI handles both, but §7.4 describes SIGTERM.
15. **Cookie formats.** `dndm_session` is `<base64url JSON {c, t, x}>.<HMAC>` with key `derive('session')`. `dndm_state` signs the state with `derive('state')`. The CSRF token is an HMAC of the session cookie with `derive('csrf')`. `/setup` is served with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, because it shows tokens.
16. **Rate-limit keys for Twitch viewers** are `viewer:<channelId>:twitch:<user_id>`, or `viewer:<channelId>:opaque:<opaque_user_id>` without identity.
17. **`BroadcasterDeps.backlogCap`** exists only so a test can use a cap of 3 instead of 3 000.
18. **`engine.ownViews(game, ids, now, { ignoreCooldowns })`** gives many characters' character, panel and abilities (without targets or the party) on one copy of the game, with `ready`/`reason` worked out as if their cooldowns were cleared. Comparison views (§5.2) use it, because two `engine.view` calls per character cloned the whole game and built the full party each time, making every `broadcastState()` pass O(N²) (about 1 s at 300 loaded characters, 10 s at 1 000).
