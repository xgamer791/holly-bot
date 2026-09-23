# Holly Bot

Your own Grok Bot–style AI assistant, with bring-your-own-key. Make as many bots as you like, each with its own name, look, personality and deep memory. Your bots can talk to each other, and they can use your computer while you control them from your phone.

**Open the app:** https://xgamer791.github.io/holly-bot/ (on a phone, use "Add to Home Screen" to install it)

## Two ways to run your bots

| | In the browser | On your computer (Holly Computer) |
|---|---|---|
| Where bots run | This browser tab | Your PC, Mac or Linux box, around the clock |
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
3. Scan the QR code it prints with your phone. That's it.

- `--tunnel` gives you a private https address that works from anywhere, through Cloudflare's free quick tunnels. The first run downloads `cloudflared` from Cloudflare's GitHub releases. The address changes each time Holly Computer restarts; scan the new QR code when it does.
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
  - Browser mode: only in your browser.
  - Holly Computer: only on the computer. They are never sent back to your phone.
  - Requests go straight to the provider. There is no Holly server.

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
- **Computer:**
  - Shell and files.
  - A real browser: pages come back as text with clickable element refs, and new tabs, dialogs and downloads are handled.
  - The screen, mouse and keyboard.
- **Safety:** with Auto-review on, risky actions wait for your approval on the phone. That covers shell commands that change things, taking over the mouse and keyboard or the browser (once per task), and MCP calls.
- **Voice mode, question cards and an activity drawer**, in a design that follows Grok Bot.

## Development

No build step for the app: it's a static PWA (Preact + htm, vendored ES modules, IndexedDB).

```sh
npm install
npm run serve            # http://localhost:8080
npm test                 # unit and integration tests (includes a real Chromium and an Xvfb desktop when available)
npm run test:e2e         # browser walkthroughs: xAI, DeepSeek, and the remote-control flow against Holly Computer
npm run computer -- --no-open   # run Holly Computer from source
npm run build:computer   # rebuild computer/holly-computer.mjs (commit the result)
npm run check            # syntax check everything and confirm the bundle is current
```

Layout:
- `src/core`: the app core that bots run on (runtime, memory, providers, tools). It runs in the browser and inside Holly Computer.
- `src/ui`: the interface.
- `src/remote`: the phone-side remote-control client.
- `computer/src`: Holly Computer.
  - `server.mjs`: HTTP API and long-poll events.
  - `desktop.mjs`: screen, mouse and keyboard.
  - `browser-cdp.mjs`: the Chrome DevTools Protocol browser.
  - `tunnel.mjs`: the Cloudflare quick tunnel.

GitHub Pages serves the `main` branch root.
