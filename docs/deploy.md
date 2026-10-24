This is the owner's runbook for the official server. It isn't a self-hosting guide.

It takes you from nothing to a running server on Fly with a Neon database, then through the live check that proves it works against real Twitch. You need a Twitch developer account, a Fly account with `flyctl` installed, and a Neon account.

## 1. The Twitch developer console

1. Register the extension.
2. Set the OAuth redirect URL to `<DNDM_PUBLIC_URL>/signup/callback`. `DNDM_PUBLIC_URL` is `https://<app>.fly.dev`, where `<app>` is the Fly app name you pick in step 3.
3. Add the public domain (`<app>.fly.dev`) to the extension's URL fetching allowlist.
4. Copy these four values for step 3:
   - the client ID (`TWITCH_CLIENT_ID`)
   - the API client secret (`TWITCH_CLIENT_SECRET`)
   - the extension secret (`TWITCH_EXTENSION_SECRET`). This is the base64 secret from the developer console, pasted as is. The server refuses one that isn't base64 of at least 32 bytes.
   - your own Twitch user ID (`TWITCH_OWNER_ID`)

## 2. Neon

1. Create the project.
2. Copy the **direct** connection string, with `sslmode=require`. Don't use the pooled one: the server holds a Postgres advisory lock, and pooling breaks it.
3. Optional: to try a risky migration first, create a Neon branch, point `DATABASE_URL` at it, run `dndm server migrate`, and delete the branch afterwards.

## 3. Fly

1. Pick the app name. Twitch policy 2.13 says it can't be guessable from the extension, so use random characters:

   ```
   echo dndm-$(openssl rand -hex 3)
   ```

2. Put the name and your region in `fly.toml` (`app` and `primary_region`), then:

   ```
   fly launch --no-deploy
   ```

   Say yes to using the existing `fly.toml`, and no to a database.

3. Set the secrets. First generate `DNDM_SECRET` (any random string of 16 or more characters) and store it in your password manager. It is the token encryption key, and Fly can't show a secret again once it is set. If you lose it, you have to regenerate every channel's URLs.

   ```
   openssl rand -hex 32
   ```

   Then put everything in a temporary file, import it, and delete the file. Quote every value:

   ```
   cat > /tmp/dndm.env <<'EOF'
   DATABASE_URL='postgres://…?sslmode=require'
   DNDM_SECRET='<the value from your password manager>'
   DNDM_PUBLIC_URL='https://<app>.fly.dev'
   TWITCH_CLIENT_ID='…'
   TWITCH_CLIENT_SECRET='…'
   TWITCH_EXTENSION_SECRET='…'
   TWITCH_OWNER_ID='…'
   EOF
   fly secrets import < /tmp/dndm.env
   rm /tmp/dndm.env
   ```

   `DNDM_SIGNUP` defaults to `allowlist`, so only people you allow can sign up. Leave it unset.

4. Deploy:

   ```
   fly deploy --ha=false
   ```

   Use `--ha=false` on the first deploy. Fly's docs list `--ha` ("Create spare machines that increases app availability", default true, see the [deploy reference](https://docs.fly.io/flyctl/deploy)), so without it Fly starts two machines. The server needs exactly one: a second copy can't get the Postgres advisory lock and restart-loops. Later plain `fly deploy` runs keep the single machine.

   Then check that only one machine exists:

   ```
   fly machine list
   ```

   If it shows two, run `fly scale count 1`.

   The release command runs `dndm server migrate` before the new machine starts. A deploy means a few seconds of downtime: there is one machine, and `strategy = "rolling"` takes it down and replaces it.

   Note on Fly's docs: for `rolling` they say "One by one, each running Machine is taken down and replaced" ([configuration reference](https://docs.fly.io/reference/configuration)). They describe `bluegreen` as booting a new machine alongside the old one, which `rolling` doesn't do. They don't spell out the single-machine ordering, so watch the first redeploy to confirm it. Don't switch to `bluegreen` or `canary`: the server must not run two copies at once.

The app stops on SIGTERM and gets 30 seconds to finish (`kill_timeout = 30`).

## 4. First use

Allow yourself against production, then sign up in a browser:

```
fly ssh console -C "/app/node_modules/.bin/tsx /app/apps/cli/src/main.ts server allow <login>"
```

Or, from a checkout of the repo on your laptop, run `pnpm dndm server allow <login>` with `DATABASE_URL`, `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` set to the production values. That puts production credentials on the laptop, so prefer the `fly ssh` command. There is no `dndm` binary: it is always `pnpm dndm` from a checkout.

Then open `https://<app>.fly.dev/signup` (there is no page at `/`) and sign in with Twitch.

## 5. Rotating secrets

**Extension secret.**
1. `fly secrets set TWITCH_EXTENSION_SECRET_PREVIOUS=<the old secret>`
2. Rotate the secret in the Twitch developer console.
3. `fly secrets set TWITCH_EXTENSION_SECRET=<the new secret>`, then `fly deploy` if it didn't restart.
4. Later, once old tokens have expired, `fly secrets unset TWITCH_EXTENSION_SECRET_PREVIOUS`.

**`DNDM_SECRET`.** This changes the token encryption key. Stored tokens can no longer be decrypted, so `/setup` shows "This URL can't be shown because the server's key changed. Regenerate it." in place of each URL, and the streamer regenerates from `/setup` (or the dock). Sessions signed with the old key are invalid, so streamers sign in again first.

Rotation does not revoke anything by itself: the lookup hash of a token is unkeyed, so the old dock and overlay URLs keep working until each one is regenerated. If you rotated because of a leak, the rotation is incomplete until every channel has regenerated both URLs.

## 6. The live check

This is the final acceptance test. It needs the real Twitch console and your Fly account, so only you can run it.

1. `GET https://<app>.fly.dev/health` returns 200.
2. `fly ssh console -C "/app/node_modules/.bin/tsx /app/apps/cli/src/main.ts server allow <owner-login>"` (or `pnpm dndm server allow <owner-login>` from a checkout, see step 4) resolves through the real Get Users call.
3. The owner signs up through real Twitch and sees both URLs on `/setup`. The install link opens the extension's page.
4. Install the extension on the owner's channel (the install link from step 3), then from a checkout run `pnpm dndm connect <url> --channel <id> --dock <token>` and send `openSession`. The proof is in `fly logs`: a JSON line with the message `pubsub send delivered` and `"status":204`.
