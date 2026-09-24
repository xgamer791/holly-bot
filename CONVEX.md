# Holly Bot — Convex

Team: `chris-4b19d` (Mango Marketeers)  
Project: `holly-bot`  
Dashboard: https://dashboard.convex.dev/t/chris-4b19d/holly-bot

## Deployments

| Kind | Name | Cloud URL | Dashboard |
|------|------|-----------|-----------|
| Production | `impressive-ferret-800` | https://impressive-ferret-800.convex.cloud | https://dashboard.convex.dev/t/chris-4b19d/holly-bot/impressive-ferret-800 |
| Development | `useful-wildebeest-212` (`dev/chris`) | https://useful-wildebeest-212.convex.cloud | https://dashboard.convex.dev/t/chris-4b19d/holly-bot/useful-wildebeest-212 |

The app and Holly Computer talk to production (`CONVEX_URL` in `src/account/config.js`).

Do not point Forge (`polished-ram-883` / `zealous-partridge-60`) or Macronaut at Holly Bot, or Holly Bot at them. The deploy workflow refuses any key that isn't for `impressive-ferret-800`.

## What's on it

Accounts, through [Convex Auth](https://labs.convex.dev/auth) with Sign in with Apple and Sign in with Google, and everything the app keeps for each account.

- `convex/auth.ts`: the two providers, and the allow-list of places a sign-in may return to (the live site and `http://localhost`).
- `convex/http.ts`: the OAuth routes, `/api/auth/signin/*` and `/api/auth/callback/*`, on `https://impressive-ferret-800.convex.site`.
- `convex/account.ts`: `account:viewer` (who is signed in), `account:signInOptions` (which sign-in buttons are set up, so the app can say what's missing) and `account:deleteAccount` (Settings → Delete Account).
- `convex/data.ts`: the app's storage, below.
- `convex/schema.ts`: Convex Auth's tables (`users`, `authAccounts`, `authSessions`, …), `records`, `blobs`, `heads`, `claims` and `meta`.
- `convex/health.ts`: `health:ping`, and `health:upsertMeta` (internal: dashboard or `npx convex run` only).
- `convex/uploads.ts` and `convex/crons.ts`: the daily sweep of unclaimed uploads.
- `convex/devices.ts`: linking Holly Computer to an account (below).

The browser side is `src/account/account.js` (the sign-in protocol, sessions in `localStorage`), `src/account/cloud-db.js` (the app's storage) and `src/ui/welcome.js` (the welcome, Sign In and Create Account screens).

## The app's data

Everything the app keeps (bots, chats, messages, memories, files, routines, tasks, activity, settings and API keys) is one `records` row per record, owned by an account. The app core runs on `src/account/cloud-db.js`, which has the same interface as the IndexedDB wrapper it used before (`src/core/db.js`).

- **Isolation.** Every function in `convex/data.ts` gets the account from the verified session (`requireUserId` in `convex/lib/auth.ts`; the session must still exist, so signing out or deleting the account cuts off its tokens at once) and reads and writes only through indexes that start with that account. The client never names an account. Uploads are claimed by the account whose record first refers to them (`blobs`), and only that account can get a download URL.
- **Records** hold the app's JSON as a string (`data`), plus `group` and `sort` so the app can load one chat's messages or one bot's memories at a time, newest first. A record over ~800 KB of JSON goes to file storage (`overflow`), as do files' contents and long texts.
- **Uploads** that no record claims within a day (the app closed mid-save, or an upload URL used for nothing) are deleted by a daily sweep (`convex/uploads.ts`, scheduled in `convex/crons.ts`).
- **Writes** go through `data:apply`, in order and in batches, from an outbox the app keeps on the device (IndexedDB `holly-outbox-<userId>`) until the server has them, so nothing is lost offline or when the app closes.
- **Several devices.** `heads` counts each account's writes. A device that sees the count move without its own writes knows another device changed the account and reloads when nothing would be lost (`src/main.js`). `claims` makes a routine's scheduled run happen on one device only.
- **Deleting.** `account:deleteAccount` removes the account's records and uploads, counters, claims, linked computers, sessions and sign-in links, then the user, in batches the app repeats until done. Settings → Data & Backup → Erase all data empties the account but keeps it (`data:clearStore`).
- **Before accounts** (1.2.0 and older) the app kept everything in the browser's IndexedDB (`holly`), shared by whoever used the browser. The first account to sign in on such a browser is asked to add it to the account or delete it (`src/account/device-data.js`); either way it leaves the browser.

## Holly Computer on the account

A linked Holly Computer keeps its bots in the account with the same storage the app uses, and runs them (`computer/src/home.mjs`). Until it's linked it keeps them in its data folder (`computer/src/node-db.mjs`).

- **Linking.** The signed-in app makes a random code, sends only its SHA-256 to `devices:createLink` (one code per account, ten minutes), and hands the code to the computer over their paired connection (`account.link`). The computer signs in with it through the `device` provider in `convex/auth.ts`, which spends the code (`devices:redeem`) and opens a session of the computer's own, a year long. The computer keeps it in `<data>/account.json` (mode 600) and renews it after 300 days.
- **Moving in.** Linking copies everything in the computer's folder into the account (the account's own settings win; API keys and plugins only the computer had are added), waits until the server has all of it, and only then runs from the account. The old folder is set aside as `<data>/data-before-account-<time>`.
- **Unlinking.** Settings → Bot Computer: from the computer itself (it ends its session and forgets the account's files) or from any signed-in device (`devices:unlink` ends the computer's session; the computer notices within a minute). Deleting the account ends it too. The bots stay in the account either way.
- **Routines.** While a computer is linked, it runs the routines and the app doesn't.

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

Open https://xgamer791.github.io/holly-bot/ and tap Sign In. A button that isn't ready says so ("Apple sign-in isn't set up yet"). The app needs an account, so there's no way past the sign-in screen until one works.

Sessions last 30 days (Convex Auth's default). `node scripts/convex-auth-keys.mjs` with a deploy key for the deployment rotates the signing keys, which signs everyone out.

## Where the app asks you to sign in

On the Holly Bot site and on `http://localhost` (Holly Computer's own page on the computer, `npm run serve`): the only places Google and Apple can send you back to.

- Holly Computer's QR code for a tunnel or `--public-url` address is a link to the site with the pairing in the `#connect=` fragment, so the phone signs in there and runs the current build. An older link to the tunnel address itself hands over to the site the same way (`handOverToSite` in `src/main.js`).
- Wi-Fi (`--lan`) links can't sign in, because a sign-in can't come back to a LAN address and the site can't call plain-http addresses. The pairing token alone protects them.
- Browser automation on localhost (the e2e scripts) skips sign-in unless the URL has `?signin`.

## Local wiring

1. Copy `.env.example` → `.env.local` (or use deploy keys from the owner’s secret store).
2. `npm install`
3. Dev push: `npm run convex:once` (or `npx convex dev`)
4. Prod push: `npx convex deploy` (or let the workflow do it)

Deploy keys live in box secrets (not in this repo):
- `/home/box/.secrets/holly-bot-convex-prod.env`
- `/home/box/.secrets/holly-bot-convex-dev.env`

`SITE_URL` stays `https://xgamer791.github.io/holly-bot` on both deployments, also while developing locally. Never set it to a local address: `http://localhost` is always allowed as a return address (`convex/auth.ts`), and prod was once set to `http://localhost:8080` by mistake, which broke sign-in. The app always signs in against production; to try sign-in against dev, point `CONVEX_URL` in `src/account/account.js` at `useful-wildebeest-212` locally.
