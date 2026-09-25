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
- `convex/account.ts`: `account:viewer` (who is signed in), `account:signInOptions` (which sign-in buttons are set up, so the app can say what's missing) and `account:deleteAccount` (deleting an account on request; the apps don't offer it).
- `convex/data.ts`: the app's storage, below.
- `convex/schema.ts`: Convex Auth's tables (`users`, `authAccounts`, `authSessions`, …), `records`, `blobs`, `heads`, `claims` and `meta`.
- `convex/health.ts`: `health:ping`, and `health:upsertMeta` (internal: dashboard or `npx convex run` only).
- `convex/uploads.ts` and `convex/crons.ts`: the daily sweep of unclaimed uploads.
- `convex/devices.ts`: linking Holly Computer to an account (below).
- `convex/connectors.ts`: Gmail, Outlook, GitHub and Higgsfield connected to an account for its bots (below), with `convex/lib/oauth.ts`, `mail.ts`, `github.ts`, `higgsfield.ts` and `seal.ts`.
- `convex/billing.ts`: subscriptions through Stripe (below), with `convex/lib/plans.ts` (the plans, their prices and their servers: the one place they're set), `convex/lib/stripe.ts` (Stripe's API and webhook signatures) and `convex/lib/subscription.ts` (whether an account's subscription lets it in). Stripe's webhook is `https://impressive-ferret-800.convex.site/stripe/webhook`.
- `convex/servers.ts`: each subscriber's dedicated server at Vultr (below), with `convex/lib/vultr.ts` (Vultr's API) and `convex/lib/cloudinit.ts` (the script that sets a server up). Servers report in at `https://impressive-ferret-800.convex.site/servers/ready`.
- `convex/ai.ts` and `convex/credits.ts`: Holly Bot's AI, DeepSeek on Holly Bot's key at `https://impressive-ferret-800.convex.site/ai/chat/completions`, and each account's monthly AI credits for it (below), with `convex/lib/credits.ts` (DeepSeek's prices, what a request costs, the months of credits).

The browser side is `src/account/account.js` (the sign-in protocol, sessions in `localStorage`), `src/account/cloud-db.js` (the app's storage) and `src/ui/welcome.js` (the welcome, Sign In and Create Account screens).

## The app's data

Everything the app keeps (bots, chats, messages, memories, files, routines, tasks, activity, settings and API keys) is one `records` row per record, owned by an account. The app core runs on `src/account/cloud-db.js`, which has the same interface as the IndexedDB wrapper it used before (`src/core/db.js`).

- **Isolation.** Every function in `convex/data.ts` gets the account from the verified session (`requireUserId` in `convex/lib/auth.ts`, through `requireSubscriber`; the session must still exist, so signing out or deleting the account cuts off its tokens at once) and reads and writes only through indexes that start with that account.
- **Subscribers only.** The same functions work only while the account's subscription is active or past due (`requireSubscriber` in `convex/lib/subscription.ts`). Without one they refuse with "Holly Bot needs an active subscription", and the app and Holly Computer keep unsaved changes on the device until it's active again. The client never names an account. Uploads are claimed by the account whose record first refers to them (`blobs`), and only that account can get a download URL.
- **Records** hold the app's JSON as a string (`data`), plus `group` and `sort` so the app can load one chat's messages or one bot's memories at a time, newest first. A record over ~800 KB of JSON goes to file storage (`overflow`), as do files' contents and long texts.
- **Uploads** that no record claims within a day (the app closed mid-save, or an upload URL used for nothing) are deleted by a daily sweep (`convex/uploads.ts`, scheduled in `convex/crons.ts`).
- **Writes** go through `data:apply`, in order and in batches, from an outbox the app keeps on the device (IndexedDB `holly-outbox-<userId>`) until the server has them, so nothing is lost offline or when the app closes.
- **Several devices.** `heads` counts each account's writes. A device that sees the count move without its own writes knows another device changed the account and reloads when nothing would be lost (`src/main.js`). `claims` makes a routine's scheduled run happen on one device only.
- **Deleting.** `account:deleteAccount` removes the account's records and uploads, counters, claims, linked computers, subscription (its Stripe customer is deleted, which cancels it) and servers, sessions and sign-in links, then the user, in batches the app repeats until done. Settings → Data & Backup → Erase all data empties the account but keeps it (`data:clearStore`).
- **Before accounts** (1.2.0 and older) the app kept everything in the browser's IndexedDB (`holly`), shared by whoever used the browser. The first account to sign in on such a browser is asked to add it to the account or delete it (`src/account/device-data.js`); either way it leaves the browser.

## Holly Computer on the account

A linked Holly Computer keeps its bots in the account with the same storage the app uses, and runs them (`computer/src/home.mjs`). Until it's linked it keeps them in its data folder (`computer/src/node-db.mjs`).

- **Linking.** The signed-in app makes a random code, sends only its SHA-256 to `devices:createLink` (one code per account, ten minutes), and hands the code to the computer over their paired connection (`account.link`). The computer signs in with it through the `device` provider in `convex/auth.ts`, which spends the code (`devices:redeem`) and opens a session of the computer's own, a year long. The computer keeps it in `<data>/account.json` (mode 600) and renews it after 300 days.
- **Moving in.** Linking copies everything in the computer's folder into the account (the account's own settings win; API keys and plugins only the computer had are added), waits until the server has all of it, and only then runs from the account. The old folder is set aside as `<data>/data-before-account-<time>`.
- **Unlinking.** Settings → Bot Computer: from the computer itself (it ends its session and forgets the account's files) or from any signed-in device (`devices:unlink` ends the computer's session; the computer notices within a minute). Deleting the account ends it too. The bots stay in the account either way. The server that comes with a plan can't be unlinked: `devices:unlink` refuses it, and so does Holly Computer on it, which `devices:report` tells whether it's the plan's server.
- **Linking by signing in.** Signing in on Holly Computer's own page (localhost) links it straight away, with no button to tap (`computerAccountStep` in `src/main.js`): the person is at the computer. That page never offers Connect: until a phone has connected, it says to tap Connect on the phone.
- **Pairing.** The first time, a phone signed in to the account asks to connect to a computer (Connect, `watchComputers` in `src/main.js`). Once it has connected, it calls `devices:pair`, which sets `pairedAt` on the computer's row (a computer renewing its own link keeps it), and says hello to the computer (`devices.hello`, `computer/src/server.mjs`), which says so in its window and on its own page (`src/ui/app.js`). `devices:list` gives `paired`, and from then on every device signed in to the account connects to that computer by itself. The server that comes with a plan counts as paired. The phone also keeps what it paired on the device, for while the backend can't say.
- **Finding it.** While it runs, a linked computer tells the account where the account's devices can reach it (`devices:report`, from its own session and only for itself): its public https address (its tunnel, on by default, or `--public-url`) and an access key of its own, as it starts, whenever that changes, every five minutes, and as it stops (`stopping`, also when its window closes). A quick tunnel's address is told only once `cloudflared` has connected and the address answers `/v1/health` as this run of Holly Computer (`instance`); it's checked every half minute, and when it stops answering the computer reports no address and opens a new tunnel (`TunnelKeeper` in `computer/src/tunnel.mjs`). With no address, `tunnel` says why: `off`, `starting` or `blocked` (its network blocks Cloudflare Tunnel). `devices:list` hands them to the account's signed-in devices, and the app connects with them by itself when it opens (`openComputer` in `src/main.js`) to paired computers, and again when the computer stops answering because it restarted at a new address. While the app is open it asks `devices:list` every ten seconds (in front only), checks that a computer that came on answers at its address (`probeComputer`), and then connects to it by itself if it's paired, or offers Connect if it isn't (`watchComputers`): your own computer whenever this app isn't using it or is on the plan's server, the plan's server only when the app runs the bots itself. Not now, and moving to another computer on purpose, are kept on the device for that address (twelve hours at most). When the computer the app uses hasn't answered for two minutes, it moves to another paired one that does. A computer not heard from for twelve minutes counts as off. The access key isn't the pairing token in the QR code: the computer makes it when it's linked (kept in `<data>/account.json`), accepts it as well as the pairing token, and forgets it when it's unlinked, so a device that got it from the account can't reach the computer after that. `--new-token` changes both.
- **Routines.** While a computer is linked, it runs the routines and the app doesn't.

## Gmail, Outlook and GitHub

People connect them in Settings → Plugins, and bots use them through tools (`src/core/tools/connector-tools.js`) that call `connectors:run`. The tokens never leave the server.

- **Connecting.** `connectors:start` saves a one-time state and PKCE verifier (ten minutes) and returns the service's consent screen. The service sends the person back to `https://impressive-ferret-800.convex.site/connectors/<service>/callback`, which trades the code for tokens at once and holds them as a claim (ten minutes) for the account that started it. It then sends the browser back to the app with `?connect=<claim>`, and the app claims it (`connectors:claim`, `src/main.js`) as the signed-in account. A consent screen someone else sent you to can't put your mailbox in their account: their claim goes to your browser, and your account can't claim theirs. A refused, stale or unfinished claim is thrown away with its tokens, and an hourly sweep clears the rest (`convex/crons.ts`).
- **GitHub without an app.** `connectors:connectToken` takes a personal access token, checks it with GitHub, and keeps it the same way. It works as soon as `CONNECTORS_KEY` exists.
- **Higgsfield, with nothing to set up.** Its sign-in (`clerk.higgsfield.ai`) lets apps register themselves (RFC 7591), so `connectors:start` registers a public client for each connection, with its callback, and the person signs in to Higgsfield with PKCE; the tokens are for Higgsfield's MCP server (`https://mcp.higgsfield.ai/mcp`, the `resource`) and carry the client they were issued to, for renewing and revoking. It works as soon as `CONNECTORS_KEY` exists. `connectors:run` then lists Higgsfield's tools (`tools`) and runs one (`call`), each in an MCP session of its own (`convex/lib/higgsfield.ts`): that server turns browsers away, so the app can't call it itself. Generations use the person's own Higgsfield credits.
- **Connected before deleting.** Gmail and Outlook connections made with 1.5 (read and send only) keep reading and sending. `connectors:list` marks them `outdated`, Settings offers to connect them again, and `delete` and `restore` ask for that.
- **At rest.** Tokens are sealed with AES-256-GCM under `CONNECTORS_KEY` and bound to the account and service (`convex/lib/seal.ts`), so a sealed value copied to another row won't open. Only actions open them. Nothing a browser can call returns them: `connectors:list` gives the service, the account's address or username, and when it was connected.
- **Using them.** `connectors:run` runs one operation for the signed-in account (Gmail and Outlook: search, read, send, peek, delete, restore; GitHub: repositories, files, and any REST call). Deleting email moves it to Trash or Deleted Items, or with `forever` deletes it for good. Before a delete asks for approval, the app `peek`s at exactly which emails it reaches, and the approved delete takes those ids and no others. It renews Google and Microsoft tokens a minute before they run out, and once more if the service turns one down. A connection that can't be renewed asks the person to connect again.
- **Disconnecting** (`connectors:disconnect`) deletes the row and asks Google to revoke its grant, or GitHub or Higgsfield its token. Microsoft has no endpoint for that: its refresh token just stops being used. A GitHub token the person made is theirs to delete. `account:deleteAccount` does the same for every connection.
- **Tests.** `npm run test:convex` runs these functions on convex-test with Google, Microsoft and GitHub stood in (`tests/convex`). `npm test` covers the API code and the bot tools, and `tests/e2e/connectors.e2e.mjs` covers the screens.

## Subscriptions

Holly Bot opens only for an account with an active subscription. Right after an account is created, and whenever its subscription isn't active, the app shows the subscription page instead of the app (`subscribed()` in `src/main.js`, `src/ui/subscribe.js`); once paid, it opens straight away, without waiting for the computer: an account with no bots makes its first one, the Chief Coordinator (`src/ui/chief.js`), the bots run in the app meanwhile with the computer button pulsing blue, and the app moves onto the computer once it's ready (`watchServerSetup` in `src/main.js`). The server enforces the subscription too, so a copy of the app with the check taken out gets nowhere.

| Plan | Paid yearly | Month to month | Dedicated server (Vultr) |
|------|-------------|----------------|--------------------------|
| Starter (best for 1 bot) | $490 a year | $60 a month | `vc2-2c-4gb`: 2 CPU, 4 GB RAM |
| Pro | $990 a year | $120 a month | `vc2-4c-8gb`: 4 CPU, 8 GB RAM |
| Ultra | $1,790 a year | $200 a month | `vc2-6c-16gb`: 6 CPU, 16 GB RAM |

- **Plans** live in `convex/lib/plans.ts`: names, prices, server sizes, the region (`ord`, Chicago) and the operating system (Ubuntu 24.04). The page shows them as `billing:status` hands them out.
- **Prices at Stripe** are the ones you make, named by six variables: `STRIPE_PRICE_STARTER_MONTHLY`, `STRIPE_PRICE_STARTER_YEARLY`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY`, `STRIPE_PRICE_ULTRA_MONTHLY` and `STRIPE_PRICE_ULTRA_YEARLY`. Checkout reads the price from Stripe first and refuses one that isn't exactly what `convex/lib/plans.ts` says (amount, USD, every month or year), and the log says which variable is off, so nobody is charged a different amount than the page shows. A subscription's plan is found from its price id.
- **Subscribing.** `billing:checkout` makes the account's Stripe customer the first time (kept on its row in `subscribers`) and opens Stripe Checkout with `mode=subscription`, where a promotion code made in Stripe's dashboard (Product catalog → Coupons) can be entered. Stripe sends the person back with `?checkout=done` (or `cancelled`), and the app asks Stripe straight away (`billing:sync`).
- **The webhook** (`/stripe/webhook`) checks every event's signature (`STRIPE_WEBHOOK_SECRET`) and refuses anything else, and handles each event once: its id goes in `stripeEvents` in the same transaction as the change, and a repeat is skipped. Each event reads the subscription it's about from Stripe again, so events that arrive late or out of order can't undo a newer change.
  - `checkout.session.completed`: keeps the Stripe ids and plan, marks the subscription active, schedules the server.
  - `customer.subscription.created` and `.updated`: keep status, plan and period end in step. A bigger plan resizes the server; a smaller one moves it to a smaller server.
  - `invoice.payment_failed`: past due. Holly Bot keeps working and the server keeps running, and the app shows a "Your payment didn't go through" banner that opens the billing portal.
  - `customer.subscription.deleted`: canceled. The server is deleted, and the app goes back to the subscription page.
- **Who gets in:** Stripe's status `active` or `trialing`, or `past_due` while Stripe tries the card again. Anything else (`unpaid`, `paused`, `canceled`…) gets the subscription page, which leads to the billing portal rather than to a second subscription; `billing:checkout` refuses one while the account has a subscription that isn't over.
- **Exempt accounts** (`EXEMPT` in `convex/lib/subscription.ts`): an account listed there needs no subscription (the owner's, while they test Holly Bot without one). It's listed by the SHA-256 of its verified email address, so the address isn't in the code (`printf %s you@example.com | sha256sum`). It skips the subscription page and keeps its data like a subscriber's, but gets no server; delete or comment out its line to put it back behind the subscription.
- **Staying in step without the webhook.** The app asks Stripe itself (`billing:sync`) when it comes back from Checkout or the portal, and when a paid period should have ended; a period that ended more than three days ago with no word from Stripe no longer counts. `sync` never touches servers: only the webhook, the scheduler and the nightly reconcile do.
- **Managing.** Stripe's billing portal (`billing:portal`): change plan, update the card, see invoices, cancel. The app opens it from the banner about a payment that didn't go through. `servers:retry` sets a computer up again after it failed.
- **What still works without a subscription:** signing in and out, the subscription itself, deleting the account (on the subscription page too), unlinking a computer and disconnecting a service. `data:*` and connecting or using Gmail, Outlook and GitHub need one.
- **Test and live.** A subscriber's row remembers which Stripe mode made it, and only the mode of the current `STRIPE_SECRET_KEY` counts, so a test subscription never opens Holly Bot once the key is live (and the nightly reconcile then deletes its server).
- **Deleting the account** deletes its Stripe customer, which cancels the subscription at once (`billing:forget`, retried for most of a day), and its servers.
- The AI is included: each plan comes with monthly AI credits for Holly Bot's AI (below).

## Holly Bot's AI and AI credits

Bots think with DeepSeek on Holly Bot's own key, `DEEPSEEK_API_KEY`, which only the deployment holds. Each plan gives the account AI credits every month (`credits` in `convex/lib/plans.ts`: Starter $10, Pro $20, Ultra $35 of DeepSeek use at DeepSeek's list prices, which the app shows as 1,000, 2,000 and 3,500 credits). There are no API keys for AI in the app any more.

- **Requests.** The app and Holly Computer send each bot request, OpenAI-style, to `POST /ai/chat/completions` (`convex/ai.ts`) with the account's session JWT as the bearer token (`sessionToken` on `src/account/cloud-db.js`, used by `src/core/providers/index.js`). The route checks the session is still open and the subscription lets the account in (as `requireSubscriber` does), takes only DeepSeek's chat parameters and the models `deepseek-flash` and `deepseek-v4-pro` (and `glm-flash`, Flash's name in 1.25.0, which runs as `deepseek-flash`), caps the output at 65,536 tokens, and passes it to `https://api.deepseek.com/chat/completions`. Streamed answers go back to the app as DeepSeek sends them. Nothing of a request or answer is kept.
- **Metering.** DeepSeek's last event says what the request used: tokens from its cache, new input, output. `credits:charge` prices them (`PRICES` in `convex/lib/credits.ts`, half price outside DeepSeek's peak hours) and takes that off the account's balance, in millionths of a dollar. Keep `PRICES` in step with DeepSeek's pricing page. A request the app cut off before that last event is charged an estimate: its input split the way the account's own was cached that month, and what was streamed.
- **Holds.** Before a request goes to DeepSeek, `credits:admit` holds back the most it could cost (all its input new, all the output it may ask for), or what's left when that's less, and `charge` gives the hold back as it charges. So requests at once can't spend more than is left, and an account never goes more than one request's worth below zero.
- **Months.** An account's credits (`credits` table) count months from the day its paid period renews, so a monthly plan's refill as it's billed, and a yearly plan's refill monthly on that day. A new month sets the balance to the plan's allowance; nothing carries over. A plan changed during the month adds the difference (bigger) or caps what's left (smaller). All of it happens as the account's credits are next read or used, with no cron.
- **At zero,** `/ai/chat/completions` answers 402 with `code: "no_credits"` and when they refill; the app shows that on the bot's reply, with a See credits button, and the bot pauses until then. Exempt accounts get the biggest plan's credits.
- **The app** reads `credits:mine` for Settings → Usage: a bar of what's left, the credits left and the refill date. It also says `ready` (whether `DEEPSEEK_API_KEY` is set); until it is, bots keep using a DeepSeek key an account had saved before credits, and accounts without one can't run bots.
- **DeepSeek's balance** pays for everyone. When DeepSeek turns Holly Bot's key down (out of balance, or a wrong key), members see "Holly Bot's AI is unavailable right now", and the deployment's logs say `DeepSeek refused Holly Bot's key` with the reason. Keep the DeepSeek account topped up: at most, a month costs the sum of every subscriber's allowance.

## Subscribers' servers

Every subscriber gets their own dedicated Vultr server running Holly Computer, linked to their account, so their bots run there around the clock (`convex/servers.ts`). Like any linked Holly Computer, it tells the account where it can be reached (`devices:report`), so the app on every device the subscriber signs in on becomes its remote control (`openComputer()` in `src/main.js`). It's made when they subscribe, resized when they upgrade, moved to a smaller one when they downgrade, and deleted when the subscription ends, with no manual steps. Only Stripe's webhook, the scheduler and the nightly cron make or delete servers: every function that calls Vultr is internal. The app can only ask for a failed setup to start again (`servers:retry`, at most once a minute), which schedules the same work.

A subscriber's row in `subscribers` holds `serverId` (the Vultr instance), `serverIp`, `serverPlan`, `serverStatus` (`none`, `provisioning`, `ready`, `resizing`, `deleting` or `error`), `serverReadyToken` (a hash of the one-time token), `serverCreatedAt` and `serverError`, next to `stripeCustomerId`, `stripeSubscriptionId`, `plan`, `billingInterval`, `subscriptionStatus` and `currentPeriodEnd`.

- **Making one** (`provision`, run by the scheduler). Nothing happens if the subscriber already has a server or one is being made. It refuses while the Vultr account has 28 or more `holly-customer` servers (Vultr caps an account at 30 servers and $1,000 a month) and logs a warning to ask Vultr for more; the subscriber sees that setup can't happen right now, and the nightly reconcile tries again. It looks up Ubuntu 24.04's `os_id` (`GET /v2/os`), then `POST /v2/instances` in `ord` at the plan's size, labelled `holly-<userId>`, tagged `holly-customer`, without backups, with the setup script as `user_data`. The id is kept at once (status `provisioning`), and Vultr is asked every 10 seconds until the server has an address.
- **Setting it up** (`convex/lib/cloudinit.ts`, cloud-init, as root at first boot): Caddy from its apt repository, Node.js 22 from nodejs.org (checked against its checksums), a desktop (XFCE on an Xvfb virtual display at 1280×800, as the `holly-display` and `holly-desktop` services, with xdotool and scrot so Holly Computer can see and control it; without it the bots just have no screen), Google Chrome for the bots' browser (it opens on that desktop), and Holly Computer from the site as a service (each start fetches the latest build, and every five minutes it looks for a newer one and, once no bot is working, stops so systemd starts the new one). On the server each bot gets a screen of its own, the way Grok Bot does it: Holly Computer runs one wide virtual display for the bots (Xvfb, :10 or the first free one after) and gives each bot a 1280×800 part of it, where its window of the one shared Chrome (so the logins are the same for every bot) fills its screen and its mouse and keyboard act; a bot gives its screen up after half an hour unused (`computer/src/screens.mjs`). How many fit at once depends on the server's memory. Caddy serves HTTP/1.1 and HTTP/2 only (HTTP/3 would need UDP 443, which the firewall keeps closed). apt steps are tried a few times, since Ubuntu's own daily apt run can hold apt at first boot. Holly Computer links itself to the subscriber's account with a one-time code (two hours), and Caddy serves it over HTTPS at `https://<ip with dashes>.sslip.io` with a Let's Encrypt certificate. Once it answers over HTTPS, the script calls `POST /servers/ready` with the user id, the one-time ready token, the address and the pairing token; on a failure it sends what went wrong instead. The log is `/var/log/holly-setup.log` on the server (Vultr's web console).
- **Ready.** A valid token makes the server `ready`; the token is then spent. The address and pairing token it reports are kept for a downgrade, when the smaller server copies the bots' files from this one. Not ready 15 minutes after it started, it's `error` with the reason (never made, no address, or Holly didn't finish). The app shows the error with Try Again, which deletes what was left and starts over.
- **Vultr errors** (network, rate limits, 5xx) are tried again up to three times with backoff. Making a server is checked first so a lost answer can't make a second one: a server labelled for the account that the record doesn't know is deleted before a new one is made.
- **Upgrade** (`resize`): `PATCH /v2/instances/{id}` with the bigger plan, status `resizing` until Vultr reports it active on that plan, then `ready`.
- **Downgrade** (`migrate`): Vultr can't make a server smaller, so a new server is made at the smaller size. While it sets up it copies the bots' files from the old one (its workspace, browser profile and plugins, through Holly Computer's `/v1/export`); their bots, chats and memories are in the account already. When it reports ready it takes over and the old one is deleted. If it fails, it's deleted instead, the subscriber keeps the old one, and the reconcile tries again the next night.
- **Deleting** (`remove`): `DELETE /v2/instances/{id}`, where a 404 counts as already deleted; the server fields are cleared (`none`), and the server's Holly Computer session ends. No snapshots or backups are taken: they cost extra.
- **Nightly reconcile** (`reconcile`, 08:07 UTC, `convex/crons.ts`): lists every `holly-customer` server at Vultr; deletes one whose subscriber has no active or past-due subscription, or that no account uses; sets one up for a paid subscriber without one; finishes a plan change that didn't happen, and a deletion or upgrade that stalled; and logs what it changed.
- **Dry run.** With `VULTR_DRY_RUN=true`, nothing is sent to Vultr: every call is logged instead (the setup script only by its length, since it carries one-time tokens), made-up servers get an id like `dry-…` and an address from the documentation range, and they "report ready" 15 seconds later, so the whole flow can be tried with Stripe test mode, end to end, on the phone. The app then opens in its usual mode, since there's no server to connect to.
- **Variables:** `VULTR_API_KEY` (Vultr → Account → API; under Access Control, allow all IPv4 and IPv6 addresses, since Convex doesn't call from fixed ones) and, while trying things out, `VULTR_DRY_RUN=true`.

## Setting up sign-in (once)

### 1. Let GitHub deploy the backend

`.github/workflows/convex.yml` runs on every push to `main` that touches `convex/` (or by hand from the Actions tab). It:

- sets `SITE_URL` to `https://xgamer791.github.io/holly-bot`,
- creates the session signing keys `JWT_PRIVATE_KEY` and `JWKS` if the deployment has none (`scripts/convex-auth-keys.mjs`),
- copies `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_APPLE_ID` and `AUTH_APPLE_SECRET` from repository secrets, when they exist there,
- copies the connector apps' secrets, the Stripe and Vultr variables, and the DeepSeek key, the same way (steps 4 to 6),
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

### 5. Stripe and Vultr, for subscriptions

Nobody gets past the subscription page until this is done, you included; until then, it says subscriptions aren't set up yet. Start with Stripe's test mode (test cards like `4242 4242 4242 4242` pay for nothing) and `VULTR_DRY_RUN=true` (no servers are made), then switch each to the real thing.

1. **Prices.** In Stripe, Product catalog → Add product, one for each plan (Holly Bot Starter, Pro, Ultra), each with two recurring prices in USD: yearly and monthly, exactly as in the table under Subscriptions (Starter: $490 every year and $60 every month; Pro: $990 and $120; Ultra: $1,790 and $200). Put each price's id (`price_…`) in its variable: `STRIPE_PRICE_STARTER_YEARLY`, `STRIPE_PRICE_STARTER_MONTHLY`, and so on.
2. **Secret key.** Developers → API keys → Secret key (`sk_test_…`) as `STRIPE_SECRET_KEY`. A restricted key works too, if it can write Customers, Checkout Sessions, Customer portal and Subscriptions and read Prices.
3. **Webhook.** Developers → Webhooks → Add endpoint:
   - URL `https://impressive-ferret-800.convex.site/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
   - Its signing secret (`whsec_…`) as `STRIPE_WEBHOOK_SECRET`.
4. **Billing portal.** Settings → Billing → Customer portal: turn on updating payment methods, invoice history, cancelling (at the end of the billing period, as the Terms say) and switching plans between the three products, and save. Stripe won't open the portal until it's saved, in test and live mode each.
5. **Vultr.** Account → API: enable the API, copy the key as `VULTR_API_KEY`, and under Access Control allow all IPv4 and IPv6 addresses. Set `VULTR_DRY_RUN=true` to try everything without making servers, and remove it (or set it to `false`) when you're ready for real ones.
6. Set the variables in the Convex dashboard (Settings → Environment Variables), or as repository secrets with the same names and run **Deploy Convex**, which copies them over.
7. Subscribe from the app with a test card. It should go straight to setting up the computer, then open the app, and Settings → Bot Computer should show the computer.
8. **Going live.** Switch Stripe to live mode and repeat steps 1 to 4 there (live mode has its own products, prices, key and webhook signing secret), update the variables, and take `VULTR_DRY_RUN` off. Test subscriptions stop counting as soon as the key is live.

If Subscribe, the webhook or a server fails, the deployment's logs in the Convex dashboard say why (Stripe's and Vultr's own messages, and which variable is off). Stripe Tax is off: turn it on in Stripe and add `automatic_tax` to `billing:checkout` if you need to charge tax.

### 6. Holly Bot's AI

Bots run on Holly Bot's DeepSeek key and the account's AI credits (above). In the [DeepSeek platform](https://platform.deepseek.com/api_keys), make an API key for Holly Bot and top up the balance, then set it as the repository secret **`DEEPSEEK_API_KEY`** (or in the Convex dashboard) and run Deploy Convex. Until it's set, the app says Holly Bot's AI isn't set up yet, and bots only work for accounts that saved their own DeepSeek key before credits.

### 7. Check

Open https://xgamer791.github.io/holly-bot/ and tap Sign In. A button that isn't ready says so ("Apple sign-in isn't set up yet"). The app needs an account, so there's no way past the sign-in screen until one works, and a subscription, so there's no way past the subscription page until Stripe and Vultr are set up (step 5).

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
