# Holly Bot — Convex

Team: `chris-4b19d` (Mango Marketeers)  
Project: `holly-bot`  
Dashboard: https://dashboard.convex.dev/t/chris-4b19d/holly-bot

## Deployments

| Kind | Name | Cloud URL | Dashboard |
|------|------|-----------|-----------|
| Production | `impressive-ferret-800` | https://impressive-ferret-800.convex.cloud | https://dashboard.convex.dev/t/chris-4b19d/holly-bot/impressive-ferret-800 |
| Development | `useful-wildebeest-212` (`dev/chris`) | https://useful-wildebeest-212.convex.cloud | https://dashboard.convex.dev/t/chris-4b19d/holly-bot/useful-wildebeest-212 |

The app talks to production (`CONVEX_URL` in `src/account/account.js`).

Do not point Forge (`polished-ram-883` / `zealous-partridge-60`) or Macronaut at Holly Bot, or Holly Bot at them. The deploy workflow refuses any key that isn't for `impressive-ferret-800`.

## What's on it

Accounts: [Convex Auth](https://labs.convex.dev/auth) with Sign in with Apple and Sign in with Google.

- `convex/auth.ts`: the two providers, and the allow-list of places a sign-in may return to (the live site and `http://localhost`).
- `convex/http.ts`: the OAuth routes, `/api/auth/signin/*` and `/api/auth/callback/*`, on `https://impressive-ferret-800.convex.site`.
- `convex/account.ts`: `account:viewer` (who is signed in) and `account:signInOptions` (which sign-in buttons are set up, so the app can say what's missing).
- `convex/schema.ts`: Convex Auth's tables (`users`, `authAccounts`, `authSessions`, …) and the `meta` table.
- `convex/health.ts`: `health:ping` and `health:upsertMeta`, from the scaffold.

The account holds a name and an email from Apple or Google, nothing else. Bots, chats, memories and API keys stay in the browser or on Holly Computer.

The browser side is `src/account/account.js` (the sign-in protocol, sessions in `localStorage`) and `src/ui/welcome.js` (the welcome, Sign In and Create Account screens).

## Setting up sign-in (once)

### 1. Let GitHub deploy the backend

`.github/workflows/convex.yml` runs on every push to `main` that touches `convex/` (or by hand from the Actions tab). It:

- sets `SITE_URL` to `https://xgamer791.github.io/holly-bot`,
- creates the session signing keys `JWT_PRIVATE_KEY` and `JWKS` if the deployment has none (`scripts/convex-auth-keys.mjs`),
- copies `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_APPLE_ID` and `AUTH_APPLE_SECRET` from repository secrets, when they exist there,
- runs `npx convex deploy`.

It needs one repository secret, **`CONVEX_DEPLOY_KEY`**: in the Convex dashboard open the holly-bot production deployment → Settings and generate a production deploy key. Add it under GitHub → Settings → Secrets and variables → Actions, then run the workflow.

### 2. Google

In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create an OAuth client ID of type **Web application** (in a project whose consent screen says Holly Bot; a Macronaut client would show Macronaut's name):

- Authorized redirect URI: `https://impressive-ferret-800.convex.site/api/auth/callback/google`

Then set `AUTH_GOOGLE_ID` (the client ID) and `AUTH_GOOGLE_SECRET` (the client secret) as repository secrets. The workflow copies them to the deployment on every run, over any value set in the Convex dashboard, so the repository secrets are the ones to change.

### 3. Apple

In the [Apple Developer portal](https://developer.apple.com/account/resources/identifiers/list) you need an App ID with **Sign in with Apple**, a Services ID for the web, and a Sign in with Apple key. The [Convex Auth Apple guide](https://labs.convex.dev/auth/config/oauth/apple) walks through the screens. Holly Bot's values:

| Thing | Value |
|-------|-------|
| Services ID → Domains | `impressive-ferret-800.convex.site` |
| Services ID → Return URLs | `https://impressive-ferret-800.convex.site/api/auth/callback/apple` |

Then set `AUTH_APPLE_ID` (the Services ID) and `AUTH_APPLE_SECRET` as repository secrets, like Google's. The secret is not the `.p8` key: it's a JWT signed with it (the guide has a generator). Apple caps it at six months, so twice a year make a new one, update the repository secret and run Deploy Convex; Apple sign-in stops working when it lapses.

### 4. Check

Open https://xgamer791.github.io/holly-bot/ and tap Sign In. A button that isn't ready says so ("Apple sign-in isn't set up yet"). While neither works, the screen offers "Continue without an account", so nobody is locked out of their bots during setup.

Sessions last 30 days (Convex Auth's default). `node scripts/convex-auth-keys.mjs` with a deploy key for the deployment rotates the signing keys, which signs everyone out.

## Where the app asks you to sign in

On the Holly Bot site. Holly Computer's links skip it: Google and Apple can only send you back to the Holly Bot site or localhost, and the tunnel and LAN links are protected by the pairing token anyway. Holly Computer's own page on the computer and local development (`npm run serve`) skip it too, unless the URL has `?signin` (for working on the sign-in screens: `http://localhost:8080/?signin`).

## Local wiring

1. Copy `.env.example` → `.env.local` (or use deploy keys from the owner’s secret store).
2. `npm install`
3. Dev push: `npm run convex:once` (or `npx convex dev`)
4. Prod push: `npx convex deploy` (or let the workflow do it)

Deploy keys live in box secrets (not in this repo):
- `/home/box/.secrets/holly-bot-convex-prod.env`
- `/home/box/.secrets/holly-bot-convex-dev.env`

`SITE_URL` stays `https://xgamer791.github.io/holly-bot` on both deployments, also while developing locally. Never set it to a local address: `http://localhost` is always allowed as a return address (`convex/auth.ts`), and prod was once set to `http://localhost:8080` by mistake, which broke sign-in. The app always signs in against production; to try sign-in against dev, point `CONVEX_URL` in `src/account/account.js` at `useful-wildebeest-212` locally.
