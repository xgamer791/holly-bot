# Holly Bot

Your own Grok Bot–style AI assistant, with the AI included. Make as many bots as you like, each with its own name, look, personality and deep memory. Your bots can talk to each other, and they can use your computer while you control them from your phone.

**Open the app:** https://xgamer791.github.io/holly-bot/ (on a phone, use "Add to Home Screen" to install it)

## Plans

Holly Bot is a subscription, and every plan comes with a dedicated server of your own that runs your bots around the clock. Right after you create an account, you choose a plan, paid yearly or month to month, and pay with Stripe. Your server is set up in a few minutes while the app shows how far it's got, and the app opens once it's ready.

| Plan | Paid yearly | Month to month | Your server | AI credits a month |
|---|---|---|---|---|
| Starter (best for 1 bot) | $490 a year | $60 a month | 2 CPU, 4 GB RAM | 1,000 ($10 of DeepSeek) |
| Pro | $990 a year | $120 a month | 4 CPU, 8 GB RAM | 2,000 ($20) |
| Ultra | $1,790 a year | $200 a month | 6 CPU, 16 GB RAM | 3,500 ($35) |

- Your server is yours alone, at Vultr in Chicago. It runs Holly Computer linked to your account for as long as the plan lasts (it can't be unlinked), and the app connects to it by itself, so your bots have a real Linux computer that's always on: the shell, files, an XFCE desktop, and for each bot a screen of its own with its own Chrome window, which you can watch and use from the app (Screen, in that bot's chat). Like Grok Bot's, your bots share the one computer (files, apps, and the browser's logins) and only the screen is each one's own. Upgrading makes it bigger; downgrading moves your bots' files to a smaller one.
- Stripe's billing portal is where you change plan, update your card, see invoices or cancel. A cancelled plan runs to the end of the period you've paid for; then the server and the files on it are deleted, and your bots, chats and memories stay in your account.
- If a renewal doesn't go through, everything keeps working while Stripe tries your card again, and the app asks you to update it.
- The AI is included: every plan comes with AI credits each month for Holly Bot's AI (below).
- Setting up Stripe and Vultr (prices, keys, webhook) is in [CONVEX.md](CONVEX.md#5-stripe-and-vultr-for-subscriptions).

## Your account

The app opens on a welcome screen: Create Account or Sign In, with your Apple or Google account. You need an account, and everything Holly Bot keeps for you lives in it, in Holly Bot's own Convex database: bots, chats, memories, files, routines, settings and keys for other services. The server only ever hands an account its own data. Sign in on another device and your bots are there.

- Settings shows who you're signed in as, with Usage (the month's AI credits) under it. **Sign Out** takes you back to the welcome screen and leaves nothing of your account on the device. Without a subscription, it's on the subscription page. The apps don't delete accounts: the privacy policy says to ask by email.
- A browser that kept bots in it before accounts (1.2.0 and older) asks the first account to sign in there whether to add them to that account or delete them. Either way they leave the browser.
- Open on two devices at once? Each notices the other's changes and offers to refresh, which it does by itself after two untouched minutes, never as you come back to the app. A routine runs once, on whichever device gets to it first.
- Holly Computer keeps its bots in your account too, once it's linked. Signing in on the page it opens on the computer links it: its bots move into your account, and it keeps running them around the clock with a session of its own. Settings → Bot Computer shows the computers linked to your account, whether each is running, and Connect and Unlink (except the server that comes with your plan, which stays linked).
- A linked Holly Computer tells your account where your devices can reach it: its tunnel (or `--public-url`) address and an access key of its own, again every five minutes while it runs, and that it stopped when it stops. So there's no link to open or QR code to scan. Holly Bot on every device signed in to your account connects to it as the app opens, and if the app is already open when the computer comes on (you start it, or sign in on it for the first time), a popup asks to connect. Not now leaves a Connect note at the top of the bot list. The app follows the computer to its new address when it restarts. When it isn't running, the app runs your bots itself and they know why they can't use the computer. The access key stops working when you unlink the computer, and `--new-token` changes it.
- The app on your phone opens on the newest version of Holly Bot whenever it starts. While it's open, a banner says when there's a newer one (tap it to update); it never reloads by itself when you leave the app and come back. Holly Computer updates itself each time it starts (`--no-update` to skip that); on a Holly Bot server it also restarts itself for a newer version once no bot is working.
- Right after you subscribe, the app opens: it doesn't wait for your server. With no bots yet, you make your Chief Coordinator first, then you're in. Your bots run in the app while the server is set up (a few minutes), with the computer button at the top right pulsing blue, and the app moves onto the server by itself once it's ready and nothing's going on.
- Your time zone is found by itself, from the device you're using: bots and routines go by it, on your computer or server too.
- Holly Computer's own page on the computer asks you to sign in. Only Wi-Fi links (`--lan`) can't: Apple and Google can't send a sign-in back to a Wi-Fi address, so there the pairing token alone protects your bots.
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
   curl -fsSLO https://xgamer791.github.io/holly-bot/computer/holly-computer.mjs && node holly-computer.mjs
   ```
   Windows (PowerShell):
   ```powershell
   iwr https://xgamer791.github.io/holly-bot/computer/holly-computer.mjs -OutFile holly-computer.mjs; node holly-computer.mjs
   ```
3. Sign in on the page it opens on the computer, with the Apple or Google account you use in Holly Bot. That links the computer to your account. Holly Bot on your phone then asks to connect: tap **Connect**. That's it. From then on, the app on any device signed in to your account connects to the computer by itself whenever Holly Computer is running, or asks to if it's already open. No link to open, no QR code.

- Holly Computer reaches the internet through Cloudflare's free quick tunnels, so your phone can reach it from anywhere. The first run downloads `cloudflared` from Cloudflare's GitHub releases. The address changes each time Holly Computer restarts, and the app finds the new one by itself. `--no-tunnel` turns it off.
- Holly Computer updates itself each time it starts, from the Holly Bot site. `--no-update` turns that off. (Holly Computer 1.10 and older don't: download it again with the command above once.)
- The page it opens on the computer carries a link that works like a password: anyone who has it can control your computer and see your bots, chats and files. Keep it private. If it gets out, restart with `--new-token` and it stops working.
- `--lan` lets phones on the same Wi-Fi connect without signing in, with a link it prints.
- `--public-url https://…` uses your own permanent address, for example a named Cloudflare Tunnel or Tailscale Funnel pointing at the port.
- Holly Computer keeps the computer awake while it runs. Use `--allow-sleep` to turn that off.
- Run `node holly-computer.mjs --help` for all options.

**Screen control setup:**
- **macOS:** allow your terminal app under System Settings → Privacy & Security → Accessibility, and under Screen & System Audio Recording.
- **Linux:** needs an X11 session, `xdotool`, and ImageMagick or scrot.
- **Windows:** works out of the box through PowerShell. Bots can't click into windows running as administrator unless Holly Computer also runs as administrator.

**Bot browser:** bots use their own Chrome, Edge, Brave or Chromium profile, so your logins there persist. Each bot gets its own tab. On a Holly Bot server each bot has its own window instead, on its own screen, and the logins are the same for every bot: sign in once, and they all are.

## Brains: Holly Bot's AI and AI credits

- Bots think with **Holly Bot's AI**: DeepSeek, which Holly Bot's server calls with its own key (`convex/ai.ts`). Nobody brings a key. Each bot runs **DeepSeek V4.1 Flash** (`deepseek-flash`, the default: smart, fast, a 1M-token context, and it sees images) or **DeepSeek V4 Pro** (`deepseek-v4-pro`: deeper thinking, about 4× the credits), picked in the bot's profile. Note that DeepSeek's servers are in China.
- **How hard they think:** bots think as hard as DeepSeek can, its max reasoning, unless their profile's Reasoning effort says Low, Med or High (`src/core/constants.js` `DEFAULT_EFFORT`). Lower is faster and uses fewer credits.
- **AI credits:** every plan gives credits each month: Starter 1,000, Pro 2,000, Ultra 3,500. A credit is a cent of DeepSeek use at DeepSeek's list prices, so the plans hold $10, $20 and $35 of it (`convex/lib/plans.ts`). Members never see money: Settings → Usage shows a bar of what's left this month, the credits left, and when they refill.
- **Metered per request:** after each reply DeepSeek says exactly how many tokens it used (from its cache, new input, output), and the server prices them at DeepSeek's rates, half price off-peak (outside 01:00–04:00 and 06:00–10:00 UTC on weekdays), and takes that off the account's credits. So the bar moves exactly with what the requests cost. While a request runs, the most it could cost is held back, so requests at once can't spend more than is left (`convex/credits.ts`).
- **Refills:** monthly, on the day the plan renews (monthly on yearly plans too). Unused credits don't carry over. Upgrading adds the difference for the rest of the month; downgrading keeps at most the new plan's amount.
- **At zero,** bots pause until the refill: they say the credits are used up and when they refill, with a See credits button.
- **Credits only:** there are no API keys for AI any more, no other providers, and no backup provider. Image generation and embedding-based memory search need providers Holly Bot doesn't use, so they're off (memory search uses keywords, recency and importance). Web search keys (Tavily, Exa, Jina, Brave) are still in Settings → Plugins.
- Holly Bot's server keeps no content of requests: only each account's credits and this month's token counts. Setting it up (`DEEPSEEK_API_KEY`) is in [CONVEX.md](CONVEX.md#holly-bots-ai-and-ai-credits).

## What bots can do

- **Personality and look:** name, shape, color, instructions. Each bot also has its own thinking animation (Ponder, Hop, Jelly, Orbit, Scan, Sparkle, Float, Nod or Twirl) that plays while it works.
- **Its job, rules and briefing:** under its name in Create New Bot (and in its profile, and at the top of its core memory), you say in your own words what the bot is for, its job, and under that the hard rules it must always follow: up to 2,000 words each, which the boxes count. The bot keeps both in its memory and reads them in full at the start of every conversation, the way an instructions file like CLAUDE.md is read (`src/core/brief.js`, `src/core/prompts.js`); every bot has its own. Its rules come before its job, its instructions and anything it's asked in a chat, and every turn reminds it of them. But no rule can change Holly Bot's own safety and behavior rules for every bot: Holly Bot's AI checks the rules as they're written, and a rule that goes against them the bot ignores, and types in its chat, flat out, that it won't follow that rule and why (and again whenever it comes up). Holly Bot's AI also reads the job and rules, with the bot's instructions, and writes the bot a briefing (its role, what it does, how it works and with which of its tools, what to keep an eye on, and what to ask you first) and a summary of the job in a sentence or two. A long job starts folded away to its summary, and opens to the whole of it to read or edit, in a box that grows to fit it. A changed job or rules gets a new briefing, before the bot's next reply if it's quick. You can read the briefing in the bot's profile. Other bots see the job's summary (or the job, shortened) next to the bot's name. Bots that already had a role get briefed on it too.
- **First hello:** a new bot reads its own name and job and asks what to focus on first, with choices that fit it (a bot called Holly Bot Debug offers to hunt bugs, not to go shopping). Without an API key yet, it offers the usual everyday ones. The Chief Coordinator asks what your team should take on first instead.
- **Deep memory:**
  - Core memory blocks about itself and about you.
  - Long-term memories with hybrid search (keywords, embeddings, recency, importance).
  - Automatic fact extraction after each chat, and summaries of older conversation.
  - Periodic reflection, and a team memory that all bots share.
  - Long chats are kept verbatim up to about 400k tokens.
  - **What the bots know about you, from your chats:** what the bots learn about you yourself (your name and what to call you, email, phone, addresses, likes and dislikes, tastes, hobbies, habits, the people in your life) goes into one notebook every bot shares (`src/core/memory/store.js` `USER_ID`), and only when you've said it or it clearly shows. There's no page for it: it all happens in chat. After each reply the extraction sorts what it learned into facts about you and the bot's own notes, with the time you wrote and the bot's web searches, and the emails it read for you once you've said they may learn from your email (off until you do). Every bot has the important facts (up to 6,000 characters) always in view and the rest recalled with your messages (12 memories a message, up from 8), calls you by name (or what you asked to be called, or not by name) and, when it fits, suggests things you'd like (a restaurant that suits your taste near you). They use it only to help you: they don't share it, or put it in emails or forms, unless what you asked for needs it. Tell any bot to forget something, what to call you, to stop learning about you (or that it's fine again), or that they may learn from your email (or not), and it holds for all of them (`settings.profile` and `settings.memory`). After a dozen new facts they reflect on them for patterns (tastes, habits). A bot's own memories about you from before move there once, and new bots greet you by name.
- **Teamwork:**
  - **Chief Coordinator:** every account's first bot, and the one you talk to. Like Grok Bot's chief of staff, it runs the rest: it hands each job to the bot whose role covers it (and only does it itself when none fits), suggests specialist bots for your work and creates them when you say yes, keeps the team in step through team memory, and comes back to you for decisions. It's pinned at the top of the bot list, and it can't lose its bot tools. A new account makes it first (the name starts as "Chief Coordinator"); an account that has bots already is offered one once.
  - Bots message each other in private channels (`message_agent`).
  - They can hand off background tasks (`delegate_task`).
  - Group chats come in three modes: Smart routing, Everyone, or only the bots you @mention.
- **Tools:**
  - Web search and page reading.
  - Code sandbox (in the browser).
  - Files and scheduled routines.
  - MCP plugins, including local stdio servers through Holly Computer.
  - Gmail and Outlook: bots search and read your email, send or reply as you, and delete email (to the trash, where it can be restored, or for good when you say so), when you ask.
  - GitHub: bots list, create, change and delete your repositories, read and write their files, and make any other GitHub request (issues, pull requests, branches…).
  - Connect them in Settings → Plugins. The tokens stay encrypted on Holly Bot's server ([CONVEX.md](CONVEX.md#gmail-outlook-and-github)).
- **Computer:**
  - Shell and files.
  - A real browser: pages come back as text with clickable element refs, and new tabs, dialogs and downloads are handled.
  - The screen, mouse and keyboard. On a Holly Bot server each bot has a screen of its own, as with Grok Bot: its own 1280×800 part of one wide virtual display, where its window of the shared Chrome fills the screen and its mouse and keyboard act, so two bots can use the browser at once without getting in each other's way. Everything else is shared: files, apps, and the browser's logins. A bot gets its screen when it first needs one and gives it up after half an hour unused. A computer with a real screen (your PC or Mac) has the one, which its bots share.
  - At the bottom of the computer's Screen tab, pinned there, a RAM meter shows how much of the computer's memory is in use, every few seconds, counted the way the computer's own system monitor counts it: Task Manager on Windows, Activity Monitor on a Mac, `free` on Linux (and on Holly Bot servers). A Mac or Linux computer also shows its swap while any is in use. Every computer running Holly Computer 1.23.0 or newer has it; an older one updates itself the next time Holly Computer starts.
  - A pinch on the Screen tab's picture zooms the picture, inside its frame, not the page (up to 6×; ctrl + scroll or a trackpad pinch on a computer). Zoomed in, a finger or the mouse moves it around, a tap still clicks where it lands, and the zoom button in its corner shows the whole screen again. The picture is laid out at its zoomed size, so it's drawn from the full image, and zoomed in, the app asks for as many pixels as the zoomed view shows, at a higher quality: the screen up to its full resolution, and the bot browser drawn up to 3× bigger than the page (Holly Computer 1.26.1 or newer), so text stays sharp.
- **Workspace:** the button in the prompt bar sets what a chat's bot works on: one or more GitHub repositories, or one of your servers (a computer linked to your account, running Holly Computer) and, if you like, some of its apps, which Holly Computer finds among its project folders and running Docker containers. Never both. In that chat the bot gets GitHub's tools or the server's, and GitHub's tools stay inside the chosen repositories. With repositories, the bot keeps its own computer too, to clone one and run it; it knows the repositories are what it's working on, and says so plainly when GitHub isn't connected. Picking a server this app isn't connected to connects to it.
- **Prompt bar**, after Perplexity's: attach, web search on or off for the chat's bots, the bot's computer (grayed out: the computer button at the top right of the chat shows the connection, grayed out with none, the computer pulsing blue while connecting and solid green while connected, and opens the computer), Workspace, dictation, and the round button for voice, send or stop.
- **Stop** ends whatever the bot is doing in the chat, at once: the reply it's writing, a running tool (a shell command is killed), turns waiting behind it, and tasks it handed to other bots. What it wrote stays. Tap Continue under the stopped reply (or tell it to carry on) and it picks up where it left off: it knows it was stopped and checks what got done first.
- **Safety:** with Auto-review on, risky actions wait for your approval on the phone. That covers shell commands that change things, taking over the mouse and keyboard or the browser (once per task), MCP calls, sending email (you see exactly what goes out), deleting email (you see exactly which emails, looked up in the mailbox itself), and making a repository public. Deleting email for good, and deleting a repository, always asks.
- **No harmful material:** every bot refuses sexual content and nudity, gore and graphic violence, drugs, and other harm (self-harm methods, weapons, hate), in text and in images, whoever asks and however it's framed (fiction, roleplay, "for research", another bot), and nothing in a bot's instructions can change that (`src/core/safety.js`). They watch for it in what they read and see too (photos and files you send, web pages, screenshots, emails) and leave it without describing it; someone who seems to be in danger gets pointed to help, not a refusal. Every message reminds them. An image prompt with banned words isn't sent, and every image made is looked at by a vision model before it's kept or shown: one that fails, or can't be checked, is thrown away.
- **Bots keep how they're built to themselves:** asked what they run on (the computer, its folders, the browser), how they're set up (whether they share a computer, screens, files or logins, how they reach each other), what AI model is behind them, their instructions or who made them, they say in a sentence that they don't know and get back to your work. They don't look it up or save it to memory either, and memories of it are dropped as they come up. They aren't told what they run on in the first place (no computer name, folders or what the bots share), and every message you send carries a reminder. Your own projects, servers and accounts are fine to ask about, and they still say they're an AI when you sincerely ask.
- **Voice mode and question cards**, in a design that follows Grok Bot.

## Languages

Holly Bot speaks English, Spanish and Chinese (Simplified). Settings → Language lists them at the top, then System, which follows the device's own language (the default; a device in any other language gets English).

- The app changes as soon as you pick one, and your other devices follow the next time they open. The screens before you sign in follow what the device last used.
- Bots write to you in the app's language too, and still answer in whatever language you write to them. A new bot's first hello and the choices on its first card come in it, and so do dates, numbers, dictation and the read-aloud voice.
- What bots do shows in it as well: the permission cards, the activity log and the chat list's previews.
- The Privacy Policy and Terms of Service stay in English, and so do messages that come from elsewhere word for word (a provider's error, a computer's own notes).

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
- `src/ui`: the interface (`subscribe.js` is the subscription page, `chief.js` the Chief Coordinator's page, a new account's first bot).
  - `i18n.js`: the app's languages. The app is written in English, and each piece of text goes through `tr('…')` (or `trn`, `trx`), which looks the English up in `i18n/es.js` and `i18n/zh.js`. `node scripts/i18n.mjs` lists what they're missing, and `--write es t.json` adds translations. What the app core writes for people to see (tool labels, approvals, previews) is a `phrase()` from `src/core/i18n.js`, kept beside its English as `say`.
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
