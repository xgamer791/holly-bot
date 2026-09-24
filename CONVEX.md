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
- `convex/connectors.ts`: Gmail, Outlook and GitHub connected to an account for its bots (below), with `convex/lib/oauth.ts`, `mail.ts`, `github.ts` and `seal.ts`.
- `convex/billing.ts`: subscriptions through Stripe (below), with `convex/lib/plans.ts` (the plans and their prices), `convex/lib/stripe.ts` (Stripe's API and webhook signatures) and `convex/lib/subscription.ts` (whether an account's subscription is active). Stripe's webhook is `https://impressive-ferret-800.convex.site/stripe/webhook`.

The browser side is `src/account/account.js` (the sign-in protocol, sessions in `localStorage`), `src/account/cloud-db.js` (the app's storage) and `src/ui/welcome.js` (the welcome, Sign In and Create Account screens).

## The app's data

Everything the app keeps (bots, chats, messages, memories, files, routines, tasks, activity, settings and API keys) is one `records` row per record, owned by an account. The app core runs on `src/account/cloud-db.js`, which has the same interface as the IndexedDB wrapper it used before (`src/core/db.js`).

- **Isolation.** Every function in `convex/data.ts` gets the account from the verified session (`requireUserId` in `convex/lib/auth.ts`, through `requireSubscriber`; the session must still exist, so signing out or deleting the account cuts off its tokens at once) and reads and writes only through indexes that start with that account.
- **Subscribers only.** The same functions work only while the account's subscription is active (`requireSubscriber` in `convex/lib/subscription.ts`). Without one they refuse with "Holly Bot needs an active subscription", and the app and Holly Computer keep unsaved changes on the device until it's active again. The client never names an account. Uploads are claimed by the account whose record first refers to them (`blobs`), and only that account can get a download URL.
- **Records** hold the app's JSON as a string (`data`), plus `group` and `sort` so the app can load one chat's messages or one bot's memories at a time, newest first. A record over ~800 KB of JSON goes to file storage (`overflow`), as do files' contents and long texts.
- **Uploads** that no record claims within a day (the app closed mid-save, or an upload URL used for nothing) are deleted by a daily sweep (`convex/uploads.ts`, scheduled in `convex/crons.ts`).
- **Writes** go through `data:apply`, in order and in batches, from an outbox the app keeps on the device (IndexedDB `holly-outbox-<userId>`) until the server has them, so nothing is lost offline or when the app closes.
- **Several devices.** `heads` counts each account's writes. A device that sees the count move without its own writes knows another device changed the account and reloads when nothing would be lost (`src/main.js`). `claims` makes a routine's scheduled run happen on one device only.
- **Deleting.** `account:deleteAccount` removes the account's records and uploads, counters, claims, linked computers, subscription (its Stripe customer is deleted, which cancels it), sessions and sign-in links, then the user, in batches the app repeats until done. Settings → Data & Backup → Erase all data empties the account but keeps it (`data:clearStore`).
- **Before accounts** (1.2.0 and older) the app kept everything in the browser's IndexedDB (`holly`), shared by whoever used the browser. The first account to sign in on such a browser is asked to add it to the account or delete it (`src/account/device-data.js`); either way it leaves the browser.

## Holly Computer on the account

A linked Holly Computer keeps its bots in the account with the same storage the app uses, and runs them (`computer/src/home.mjs`). Until it's linked it keeps them in its data folder (`computer/src/node-db.mjs`).

- **Linking.** The signed-in app makes a random code, sends only its SHA-256 to `devices:createLink` (one code per account, ten minutes), and hands the code to the computer over their paired connection (`account.link`). The computer signs in with it through the `device` provider in `convex/auth.ts`, which spends the code (`devices:redeem`) and opens a session of the computer's own, a year long. The computer keeps it in `<data>/account.json` (mode 600) and renews it after 300 days.
- **Moving in.** Linking copies everything in the computer's folder into the account (the account's own settings win; API keys and plugins only the computer had are added), waits until the server has all of it, and only then runs from the account. The old folder is set aside as `<data>/data-before-account-<time>`.
- **Unlinking.** Settings → Bot Computer: from the computer itself (it ends its session and forgets the account's files) or from any signed-in device (`devices:unlink` ends the computer's session; the computer notices within a minute). Deleting the account ends it too. The bots stay in the account either way.
- **Routines.** While a computer is linked, it runs the routines and the app doesn't.

## Gmail, Outlook and GitHub

People connect them in Settings → Plugins, and bots use them through tools (`src/core/tools/connector-tools.js`) that call `connectors:run`. The tokens never leave the server.

- **Connecting.** `connectors:start` saves a one-time state and PKCE verifier (ten minutes) and returns the service's consent screen. The service sends the person back to `https://impressive-ferret-800.convex.site/connectors/<service>/callback`, which trades the code for tokens at once and holds them as a claim (ten minutes) for the account that started it. It then sends the browser back to the app with `?connect=<claim>`, and the app claims it (`connectors:claim`, `src/main.js`) as the signed-in account. A consent screen someone else sent you to can't put your mailbox in their account: their claim goes to your browser, and your account can't claim theirs. A refused, stale or unfinished claim is thrown away with its tokens, and an hourly sweep clears the rest (`convex/crons.ts`).
- **GitHub without an app.** `connectors:connectToken` takes a personal access token, checks it with GitHub, and keeps it the same way. It works as soon as `CONNECTORS_KEY` exists.
- **Connected before deleting.** Gmail and Outlook connections made with 1.5 (read and send only) keep reading and sending. `connectors:list` marks them `outdated`, Settings offers to connect them again, and `delete` and `restore` ask for that.
- **At rest.** Tokens are sealed with AES-256-GCM under `CONNECTORS_KEY` and bound to the account and service (`convex/lib/seal.ts`), so a sealed value copied to another row won't open. Only actions open them. Nothing a browser can call returns them: `connectors:list` gives the service, the account's address or username, and when it was connected.
- **Using them.** `connectors:run` runs one operation for the signed-in account (Gmail and Outlook: search, read, send, peek, delete, restore; GitHub: repositories, files, and any REST call). Deleting email moves it to Trash or Deleted Items, or with `forever` deletes it for good. Before a delete asks for approval, the app `peek`s at exactly which emails it reaches, and the approved delete takes those ids and no others. It renews Google and Microsoft tokens a minute before they run out, and once more if the service turns one down. A connection that can't be renewed asks the person to connect again.
- **Disconnecting** (`connectors:disconnect`) deletes the row and asks Google to revoke its grant or GitHub its token. Microsoft has no endpoint for that: its refresh token just stops being used. A GitHub token the person made is theirs to delete. `account:deleteAccount` does the same for every connection.
- **Tests.** `npm run test:convex` runs these functions on convex-test with Google, Microsoft and GitHub stood in (`tests/convex`). `npm test` covers the API code and the bot tools, and `tests/e2e/connectors.e2e.mjs` covers the screens.

## Subscriptions

Holly Bot opens only for an account with an active subscription. Right after an account is created, and whenever its subscription isn't active, the app shows the subscription page instead of the app (`subscribed()` in `src/main.js`, `src/ui/subscribe.js`). The server enforces it too, so a copy of the app with the check taken out gets nowhere.

| Plan | Monthly | Yearly | Dedicated server |
|------|---------|--------|------------------|
| Starter (best for 1 bot) | $49 | $490 | 2 CPU, 4 GB RAM |
| Pro | $99 | $990 | 4 CPU, 8 GB RAM |
| Ultra | $179 | $1,790 | 6 CPU, 16 GB RAM |

- **Plans** live in `convex/lib/plans.ts`, and the page shows them as `billing:status` hands them out, so prices are set in one place. Nothing provisions the dedicated servers yet: the plan is kept on the subscription (`subscriptions.plan`) for when something does.
- **Subscribing.** `billing:checkout` makes the account's Stripe customer the first time (its id kept in `billingCustomers`), and opens Stripe Checkout with `mode=subscription` for the plan's monthly or yearly price. Stripe sends the person back with `?checkout=done` (or `cancelled`).
- **Products and prices** are made at Stripe the first time someone subscribes to each: products `holly_bot_starter`, `holly_bot_pro` and `holly_bot_ultra`, and prices found by the lookup keys `holly_bot_<plan>_month` and `_year`. To change a price, change `convex/lib/plans.ts`: the next checkout makes the new price and moves the lookup key to it. People already subscribed keep what they pay until you move them in Stripe.
- **Staying in step.** Stripe's webhook (`/stripe/webhook`, signed with `STRIPE_WEBHOOK_SECRET`) reports every change, and each event reads the subscription from Stripe again (`subscriptions`), so late or out-of-order events can't undo a newer change. The app also asks Stripe itself (`billing:sync`) when it comes back from Checkout or the billing portal, and when a paid period should have ended, so a subscription opens the app the moment it's paid for, and a missed webhook can't keep one open or shut for long. A period that ended more than three days ago with no word from Stripe no longer counts.
- **Active** means Stripe's status is `active` or `trialing`. A renewal that didn't go through (`past_due`, `unpaid`) shuts the app until the card is updated; the subscription page leads to Stripe's billing portal for that, not to a second subscription. `billing:checkout` refuses to start one while the account has a subscription that isn't over.
- **Managing.** Settings → Subscription opens Stripe's billing portal (`billing:portal`): change plan, update the card, see invoices, cancel. Coming back (`?billing=done`) the app asks Stripe again.
- **While the app is open** it checks when it comes back to the front and every ten minutes, and reloads onto the subscription page once the subscription has ended.
- **What still works without one:** signing in and out, the subscription itself, deleting the account (on the subscription page too), unlinking a computer and disconnecting a service. `account:viewer` and `devices:*` don't need a subscription; `data:*` and connecting or using Gmail, Outlook and GitHub do.
- **Test and live.** Customers and subscriptions remember which Stripe mode made them, and only the mode of the current `STRIPE_SECRET_KEY` counts, so switching from test keys to live ones never lets a test subscription open Holly Bot.
- **Deleting the account** deletes its Stripe customer, which cancels the subscription at once (`billing:forget`, retried for most of a day if Stripe can't be reached).
- Bring your own key is unchanged: bots still call AI providers with the account's own keys, so a plan's price doesn't include AI.

## Setting up sign-in (once)

### 1. Let GitHub deploy the backend

`.github/workflows/convex.yml` runs on every push to `main` that touches `convex/` (or by hand from the Actions tab). It:

- sets `SITE_URL` to `https://xgamer791.github.io/holly-bot`,
- creates the session signing keys `JWT_PRIVATE_KEY` and `JWKS` if the deployment has none (`scripts/convex-auth-keys.mjs`),
- copies `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_APPLE_ID` and `AUTH_APPLE_SECRET` from repository secrets, when they exist there,
- copies the connector apps' secrets and `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` the same way (steps 4 and 5),
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

### 4. Gmail, Outlook and GitHub for bots

The deploy workflow creates `CONNECTORS_KEY` the first time (`scripts/convex-connectors-key.mjs --if-missing`). From then on, GitHub can be connected with a personal access token. Leave the key alone: a new one disconnects everyone. For the Connect buttons, set up each service's OAuth app, then add its two repository secrets. The workflow copies them to the deployment like the sign-in ones. A service without them shows as "Not set up on Holly Bot's server yet".

**Gmail** (`CONNECT_GOOGLE_ID`, `CONNECT_GOOGLE_SECRET`), in the Google Cloud project that has Holly Bot's consent screen:

1. APIs & Services → Library: enable the **Gmail API**.
2. Google Auth Platform → Data access: add the scope `https://mail.google.com/` (full Gmail access: reading, sending, and deleting, including for good). It replaces `gmail.readonly` and `gmail.send`, which can go. It's the only scope that can delete email for good, and verification will ask why the app needs that: bots delete email when people ask them to, including for good (“empty my trash”).
3. Credentials: open the sign-in Web client (or make a second one) and add the authorized redirect URI `https://impressive-ferret-800.convex.site/connectors/gmail/callback`.
4. Set the two secrets to that client's ID and secret. They can be the same values as `AUTH_GOOGLE_*`. Setting them is what turns on Connect: the sign-in client alone doesn't, so the button never leads to a Google error page.
5. While the app's publishing status is **Testing**, only the test users listed there (up to 100) can connect, and Google ends their connections after 7 days. For everyone, publish the app and pass Google's verification. `https://mail.google.com/` is a restricted scope, so it also needs a yearly security assessment (CASA). Allow a few weeks. The privacy policy already has the Limited Use statement Google asks for.

**Outlook** (`CONNECT_MICROSOFT_ID`, `CONNECT_MICROSOFT_SECRET`), in the [Microsoft Entra admin center](https://entra.microsoft.com) → App registrations → New registration:

1. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**. Redirect URI (Web): `https://impressive-ferret-800.convex.site/connectors/outlook/callback`.
2. API permissions → Microsoft Graph → Delegated: `offline_access`, `User.Read`, `Mail.ReadWrite` (reading, and deleting or moving email) and `Mail.Send`. Personal accounts need no admin consent. A work or school tenant may need its admin to allow Holly Bot.
3. Certificates & secrets → New client secret. Set `CONNECT_MICROSOFT_ID` to the Application (client) ID and `CONNECT_MICROSOFT_SECRET` to the secret's **Value**. Client secrets expire (24 months at most), so renew it and the repository secret before then.
4. Branding → publisher verification removes the "unverified" label people see when they connect.

**GitHub** (`CONNECT_GITHUB_ID`, `CONNECT_GITHUB_SECRET`: GitHub doesn't allow secret names that start with `GITHUB_`), under GitHub → Settings → Developer settings → OAuth Apps → New OAuth App:

1. Homepage URL `https://xgamer791.github.io/holly-bot/`, Authorization callback URL `https://impressive-ferret-800.convex.site/connectors/github/callback`.
2. Generate a client secret and set the two secrets.
3. Organizations that restrict OAuth apps have to approve Holly Bot before bots can reach their repositories.

Then run Deploy Convex from the Actions tab (or push a change under `convex/`). The buttons turn on as soon as it finishes.

### 5. Stripe, for subscriptions

Nobody gets past the subscription page until this is done, you included; until then, it says subscriptions aren't set up yet. Start in test mode (the Test mode switch in the Stripe dashboard), where test cards like `4242 4242 4242 4242` pay for nothing.

1. **Secret key.** Developers → API keys → Secret key (`sk_test_…`). Add it as the repository secret `STRIPE_SECRET_KEY`. A restricted key works too, if it can write Customers, Products, Prices, Checkout Sessions, Customer portal and Subscriptions.
2. **Webhook.** Developers → Webhooks → Add endpoint:
   - URL `https://impressive-ferret-800.convex.site/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Add its signing secret (`whsec_…`) as the repository secret `STRIPE_WEBHOOK_SECRET`.
3. **Billing portal.** Settings → Billing → Customer portal: turn on updating payment methods, invoice history and cancelling, with cancellations **at the end of the billing period** (the Terms say so), and save. Stripe won't open the portal until it's saved, in test and live mode each. After the first subscriptions have made Holly Bot's products, you can also let people switch plans there.
4. **Branding** (optional). Settings → Branding: Holly Bot's icon and colors on Checkout, the portal and receipts. Settings → Customer emails can send receipts.
5. Run **Deploy Convex** from the Actions tab. It copies both secrets to the deployment like the others (or set them in the Convex dashboard).
6. Subscribe from the app with a test card. It should open the app straight away, and Settings → Subscription should show the plan.
7. **Going live.** Switch the dashboard to live mode, repeat steps 1 to 3 with the live key (`sk_live_…`) and a live webhook endpoint (it has its own signing secret), update both repository secrets and run Deploy Convex. Test subscriptions stop counting as soon as the key is live.

If Subscribe or Manage fails, the deployment's logs in the Convex dashboard have Stripe's own message. Stripe Tax is off: turn it on in Stripe and add `automatic_tax` to `billing:checkout` if you need to charge tax.

### 6. Check

Open https://xgamer791.github.io/holly-bot/ and tap Sign In. A button that isn't ready says so ("Apple sign-in isn't set up yet"). The app needs an account, so there's no way past the sign-in screen until one works, and a subscription, so there's no way past the subscription page until Stripe is set up (step 5).

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
