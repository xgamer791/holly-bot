# Holly Bot

Your own Grok Bot–style AI assistant, with bring-your-own-key. Make as many bots as you like, each with its own name, look, personality and deep memory. Your bots can talk to each other, and they can use your computer while you control them from your phone.

**Open the app:** https://xgamer791.github.io/holly-bot/ (on a phone, use "Add to Home Screen" to install it)

## Plans

Holly Bot is a subscription, and every plan comes with a dedicated server of your own that runs your bots around the clock. Right after you create an account, you choose a plan, paid yearly or month to month, and pay with Stripe. Your server is set up in a few minutes while the app shows how far it's got, and the app opens once it's ready.

| Plan | Paid yearly | Month to month | Your server |
|---|---|---|---|
| Starter (best for 1 bot) | $49 a month ($588 a year) | $58.80 a month | 2 CPU, 4 GB RAM |
| Pro | $99 a month ($1,188 a year) | $118.80 a month | 4 CPU, 8 GB RAM |
| Ultra | $179 a month ($2,148 a year) | $214.80 a month | 6 CPU, 16 GB RAM |

- Your server is yours alone, at Vultr in Chicago. It runs Holly Computer linked to your account, and the app connects to it by itself, so your bots have a real Linux computer (shell, files, a Chrome browser) that's always on. Upgrading makes it bigger; downgrading moves your bots' files to a smaller one.
- Settings → Subscription opens Stripe's billing portal: change plan, update your card, see invoices or cancel. A cancelled plan runs to the end of the period you've paid for; then the server and the files on it are deleted, and your bots, chats and memories stay in your account.
- If a renewal doesn't go through, everything keeps working while Stripe tries your card again, and the app asks you to update it.
- Bring your own key still applies: bots call AI providers with your own keys (below), so AI isn't part of the price.
- Setting up Stripe and Vultr (prices, keys, webhook) is in [CONVEX.md](CONVEX.md#5-stripe-and-vultr-for-subscriptions).

## Your account

The app opens on a welcome screen: Create Account or Sign In, with your Apple or Google account. You need an account, and everything Holly Bot keeps for you lives in it, in Holly Bot's own Convex database: bots, chats, memories, files, routines, settings and API keys. The server only ever hands an account its own data. Sign in on another device and your bots are there.

- Settings shows who you're signed in as. **Sign Out** takes you back to the welcome screen and leaves nothing of your account on the device. **Delete Account** erases the account and everything in it, and cancels the subscription. Without a subscription, both are on the subscription page.
- A browser that kept bots in it before accounts (1.2.0 and older) asks the first account to sign in there whether to add them to that account or delete them. Either way they leave the browser.
- Open on two devices at once? Each notices the other's changes and reloads when nothing would be lost. A routine runs once, on whichever device gets to it first.
- Holly Computer keeps its bots in your account too, once it's linked. The first time you open it signed in, the app asks to link it: its bots move into your account, and it keeps running them around the clock with a session of its own. Settings → Bot Computer shows the computers linked to your account, whether each is running, Connect and Unlink, and deleting your account unlinks them.
- A linked Holly Computer tells your account where your devices can reach it: its `--tunnel` (or `--public-url`) address and an access key of its own, again every five minutes while it runs, and that it stopped when it stops. So Holly Bot on every device signed in to your account connects to it by itself, including the Home Screen app on iPhone, which doesn't share Safari's storage, and follows it to its new address when it restarts. When it isn't running, the app runs your bots itself and they know why they can't use the computer. The access key stops working when you unlink the computer, and `--new-token` changes it along with the QR code.
- Holly Computer's QR code opens the Holly Bot site, connected to your computer, so you sign in there and always get the current build. Its own page on the computer asks you to sign in too. Only Wi-Fi links (`--lan`) can't: Apple and Google can't send a sign-in back to a Wi-Fi address, so there the pairing token alone protects your bots.
- [Privacy Policy](https://xgamer791.github.io/holly-bot/privacy.html) and [Terms of Service](https://xgamer791.github.io/holly-bot/terms.html) (`privacy.html`, `terms.html`), linked from the sign-in screens and Settings.
- Setup for the backend (deploy key, Google and Apple credentials) is in [CONVEX.md](CONVEX.md).

## Two ways to run your bots

| | In the app | On your computer (Holly Computer) |
|---|---|---|
| Where bots run | The app, while it's open | Your PC, Mac or Linux box, around the clock |
| Where they're kept | Your Holly Bot account | Your Holly Bot account, once the computer is linked to it |
| What they can use | Web search and page reading (with a search key), a Python/JavaScript sandbox, their own drive, memory | Everything on the left, plus the shell, your files, a real Chrome browser, and the screen, mouse and keyboard |
| Your phone | Is the app | Is the remote control: chat, approve actions, watch and tap the live screen |

### Put your bots on your computer

1. Install [Node.js 22 or newer](https://nodejs.org).
2. Run Holly Computer. It's a single file, and the app is inside it.

   Mac or Linux:
   ```sh
   curl -fsSLO https://xgamer791.github.io/holly-bot/computer/holly-computer.mjs && node holly-computer.mjs --tunnel
   ```
   Windows (PowerShell):
   ```powershell
   iwr https://xgamer791.github.io/holly-bot/computer/holly-computer.mjs -OutFile holly-computer.mjs; node holly-computer.mjs --tunnel
   ```
3. Scan the QR code it prints with your phone, sign in, and tap **Add to My Account** to link the computer. That's it. The code opens the Holly Bot site connected to your computer, so your phone always runs the current app. From then on Holly Bot on any device signed in to your account connects to the computer by itself while Holly Computer runs, with no QR code. (Holly Computer 1.7 and older don't tell the account where they are: run the command above again to update.)

- The link and QR code work like a password: anyone who has them can control your computer and see your bots, chats and files, and a Wi-Fi link opens it without signing in. Keep them private. If one gets out, restart with `--new-token` and the old links stop working. The app says so where you link the computer and in Settings → Bot Computer.
- `--tunnel` gives you a private https address that works from anywhere, through Cloudflare's free quick tunnels. The first run downloads `cloudflared` from Cloudflare's GitHub releases. The address changes each time Holly Computer restarts. Once the computer is linked to your account, the app finds the new address by itself; before that, scan the new QR code.
- `--lan` lets phones on the same Wi-Fi connect instead.
- `--public-url https://…` uses your own permanent address, for example a named Cloudflare Tunnel or Tailscale Funnel pointing at the port.
- Holly Computer keeps the computer awake while it runs. Use `--allow-sleep` to turn that off.
- Run `node holly-computer.mjs --help` for all options.

**Screen control setup:**
- **macOS:** allow your terminal app under System Settings → Privacy & Security → Accessibility, and under Screen & System Audio Recording.
- **Linux:** needs an X11 session, `xdotool`, and ImageMagick or scrot.
- **Windows:** works out of the box through PowerShell. Bots can't click into windows running as administrator unless Holly Computer also runs as administrator.

**Bot browser:** bots use their own Chrome, Edge, Brave or Chromium profile, so your logins there persist. Each bot gets its own tab.

## Brains (bring your own key)

- **DeepSeek V4.1 Flash** (`deepseek-flash`) is the default for every bot. It's smart and very cheap, has a 1M-token context, and can see images. DeepSeek bills half price off-peak (outside 01:00–04:00 and 06:00–10:00 UTC on weekdays). Note that DeepSeek's servers are in China.
- Also supported: DeepSeek V4 Pro, Anthropic Claude, OpenAI, xAI Grok (with live web and X search), Google Gemini, OpenRouter, Groq, Mistral, Ollama and any OpenAI-compatible endpoint. Each bot can use a different model.
- **Backup if it fails:** choose a second provider in Settings → API Keys. When the main one is down, rate limited or out of credit, the reply is retried once on the backup.
- Where keys live:
  - In your Holly Bot account, so they're on every device you sign in on and on your linked Holly Computer. A Holly Computer that isn't linked keeps them on the computer.
  - Holly Computer never sends keys back to the phone it's controlled from.
  - Requests go straight from the app (or the computer) to the provider. Holly Bot's server stores your keys but never calls a provider with them.

## What bots can do

- **Personality and look:** name, shape, color, instructions. Each bot also has its own thinking animation (Ponder, Hop, Jelly, Orbit, Scan, Sparkle, Float, Nod or Twirl) that plays while it works.
- **Deep memory:**
  - Core memory blocks about itself and about you.
  - Long-term memories with hybrid search (keywords, embeddings, recency, importance).
  - Automatic fact extraction after each chat, and summaries of older conversation.
  - Periodic reflection, and a team memory that all bots share.
  - Long chats are kept verbatim up to about 400k tokens.
- **Teamwork:**
  - Bots message each other in private channels (`message_agent`).
  - They can hand off background tasks (`delegate_task`).
  - Group chats come in three modes: Smart routing, Everyone, or only the bots you @mention.
- **Tools:**
  - Web search and page reading.
  - Code sandbox (in the browser).
  - Files, image generation and scheduled routines.
  - MCP plugins, including local stdio servers through Holly Computer.
  - Gmail and Outlook: bots search and read your email, send or reply as you, and delete email (to the trash, where it can be restored, or for good when you say so), when you ask.
  - GitHub: bots list, create, change and delete your repositories, read and write their files, and make any other GitHub request (issues, pull requests, branches…).
  - Connect them in Settings → Plugins. The tokens stay encrypted on Holly Bot's server ([CONVEX.md](CONVEX.md#gmail-outlook-and-github)).
- **Computer:**
  - Shell and files.
  - A real browser: pages come back as text with clickable element refs, and new tabs, dialogs and downloads are handled.
  - The screen, mouse and keyboard.
- **Safety:** with Auto-review on, risky actions wait for your approval on the phone. That covers shell commands that change things, taking over the mouse and keyboard or the browser (once per task), MCP calls, sending email (you see exactly what goes out), deleting email (you see exactly which emails, looked up in the mailbox itself), and making a repository public. Deleting email for good, and deleting a repository, always asks.
- **Voice mode, question cards and an activity drawer**, in a design that follows Grok Bot.

## Development

No build step for the app: it's a static PWA (Preact + htm, vendored ES modules), keeping its data in the account on Convex.

```sh
npm install
npm run serve            # http://localhost:8080
npm test                 # unit and integration tests (includes a real Chromium and an Xvfb desktop when available)
npm run test:convex      # the Convex functions on convex-test (connecting Gmail, Outlook and GitHub)
npm run test:e2e         # browser walkthroughs: xAI, DeepSeek, connecting accounts, and the remote-control flow against Holly Computer
npm run computer -- --no-open   # run Holly Computer from source
npm run build:computer   # rebuild computer/holly-computer.mjs (commit the result)
npm run check            # syntax check everything and confirm the bundle is current
```

Layout:
- `src/core`: the app core that bots run on (runtime, memory, providers, tools). It runs in the browser and inside Holly Computer.
- `src/ui`: the interface (`subscribe.js` is the subscription page, `setup.js` the computer being set up).
- `src/remote`: the phone-side remote-control client.
- `src/account`: Sign in with Apple and Google against Holly Bot's Convex backend (`account.js`), and the app's storage in the account (`cloud-db.js`).
- `convex`: that backend (accounts and everything in them, subscriptions through Stripe in `billing.ts`, and each subscriber's Vultr server in `servers.ts`). `.github/workflows/convex.yml` deploys it.
- `computer/src`: Holly Computer.
  - `home.mjs`, `account.mjs`, `outbox.mjs`: where its bots are kept, its session on your account, and changes waiting to be saved.
  - `server.mjs`: HTTP API and long-poll events.
  - `desktop.mjs`: screen, mouse and keyboard.
  - `browser-cdp.mjs`: the Chrome DevTools Protocol browser.
  - `tunnel.mjs`: the Cloudflare quick tunnel.

GitHub Pages serves the `main` branch root.

## Convex backend

Separate Convex project `holly-bot` (not Forge). It holds accounts (Sign in with Apple and Google, through Convex Auth) and everything in them. A push to `main` that changes `convex/` deploys it to production.

- Prod: `https://impressive-ferret-800.convex.cloud`
- Dev: `https://useful-wildebeest-212.convex.cloud`
- Details: see [CONVEX.md](CONVEX.md)
