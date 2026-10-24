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

3. Set the secrets. `DNDM_SECRET` is any random string of 16 or more characters; keep a copy somewhere safe.

   ```
   fly secrets set \
     DATABASE_URL='postgres://…?sslmode=require' \
     DNDM_SECRET="$(openssl rand -hex 32)" \
     DNDM_PUBLIC_URL=https://<app>.fly.dev \
     TWITCH_CLIENT_ID=… \
     TWITCH_CLIENT_SECRET=… \
     TWITCH_EXTENSION_SECRET=… \
     TWITCH_OWNER_ID=…
   ```

   `DNDM_SIGNUP` defaults to `allowlist`, so only people you allow can sign up. Leave it unset.

4. Deploy:

   ```
   fly deploy
   ```

   The release command runs `dndm server migrate` before the new machine starts. A deploy means a few seconds of downtime: there is one machine, and `strategy = "rolling"` takes it down and replaces it.

   What I checked in Fly's docs: for `rolling` they say "One by one, each running Machine is taken down and replaced" ([configuration reference](https://docs.fly.io/reference/configuration)). They describe `bluegreen` as booting a new machine alongside the old one, which `rolling` doesn't do. They do not spell out the single-machine ordering. I could not confirm it more explicitly than that, so watch the first redeploy to see it happen. Don't switch to `bluegreen` or `canary`: the server must not run two copies at once.

The app stops on SIGTERM and gets 30 seconds to finish (`kill_timeout = 30`).

## 4. First use

Allow yourself against production, then sign up in a browser:

```
fly ssh console -C "node_modules/.bin/tsx apps/cli/src/main.ts server allow <login>"
```

Or run `dndm server allow <login>` locally with `DATABASE_URL` set to the production string. Then open `https://<app>.fly.dev` and sign up with Twitch.

## 5. Rotating secrets

**Extension secret.**
1. `fly secrets set TWITCH_EXTENSION_SECRET_PREVIOUS=<the old secret>`
2. Rotate the secret in the Twitch developer console.
3. `fly secrets set TWITCH_EXTENSION_SECRET=<the new secret>`, then `fly deploy` if it didn't restart.
4. Later, once old tokens have expired, `fly secrets unset TWITCH_EXTENSION_SECRET_PREVIOUS`.

**`DNDM_SECRET`.** This changes the token encryption key, so every existing channel URL stops working. After changing it, each streamer must regenerate their URLs from `/setup`.

## 6. The live check

This is the final acceptance test. It needs the real Twitch console and your Fly account, so only you can run it.

1. `GET https://<app>.fly.dev/health` returns 200.
2. `dndm server allow <owner-login>` resolves through the real Get Users call.
3. The owner signs up through real Twitch and sees both URLs on `/setup`. The install link opens the extension's page.
4. `dndm connect <url> --channel <id> --dock <token>`, then `openSession`, produces a logged PubSub send answered 204.
