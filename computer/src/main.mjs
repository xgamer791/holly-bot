#!/usr/bin/env node
// Holli Bot Computer — run your Holli bots on this computer, 24/7, and control them
// from your phone. Bots can use this machine: shell, files, a real Chrome
// browser, the screen/mouse/keyboard, and local MCP plugins.

import os from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './node-db.mjs'; // IDBKeyRange for the app core
import { LocalComputer, VERSION, defaultWorkspace } from './local-computer.mjs';
import { createHollyServer } from './server.mjs';
import { TunnelKeeper, ensureCloudflared, qrText } from './tunnel.mjs';
import { keepAwake } from './awake.mjs';
import { AccountLink } from './account.mjs';
import { BotHome } from './home.mjs';
import { latestVersion, newerVersion, runLatest } from './update.mjs';
import { updateFirstDesktopApp } from './desktop-update.mjs';

/** How often a Holli Bot server looks for a newer Holli Bot Computer. */
const UPDATE_EVERY = 5 * 60_000;

/**
 * Holli Bot for Windows (desktop/) runs this file itself, with a channel
 * to it (HOLLY_DESKTOP=1 and Node's IPC). It updates the file before starting
 * it, shows how things stand here in its window (tellDesktop), and says when
 * to stop (it quits or restarts, or Windows signs out), so the account still
 * hears that this computer stopped.
 */
const DESKTOP = process.env.HOLLY_DESKTOP === '1' && typeof process.send === 'function';

function tellDesktop(message) {
  if (!DESKTOP || !process.connected) return;
  try {
    process.send(message);
  } catch { /* the app is gone: 'disconnect' stops this one */ }
}

const USAGE = `Holli Bot Computer — your Holli bots live on this computer; control them from your phone.

Usage: node holly-computer.mjs [options]

Sign in on the page it opens, with the Apple or Google account you use in Holli
Bot. Holli Bot on your phone then connects to this computer by itself.

  --no-tunnel         Don't open a Cloudflare tunnel (then your phone can't reach this
                      computer, unless you give it --public-url)
  --public-url <url>  Your own permanent https address for this computer (e.g. a named
                      Cloudflare Tunnel or Tailscale Funnel pointing at this port)
  --lan               Allow phones on the same Wi-Fi, without signing in (prints a link)
  --port <n>          Port to listen on (default 8787)
  --workspace <dir>   Folder the bots work in (default ~/Holly)
  --data <dir>        Holli Bot Computer's own files (default ~/.holly). Until this computer is
                      linked to your Holli Bot account, its bots are kept here too
  --headless-browser  Run the bots' Chrome without a window
  --allow-sleep       Let the computer sleep while Holli Bot Computer runs
  --new-token         New keys for this computer: every device has to find it again
  --no-open           Don't open the sign-in page in a browser here
  --no-update         Don't update Holli Bot Computer as it starts
  -h, --help          Show this help`;

function parseArgs(argv) {
  const out = { port: 8787, host: '127.0.0.1', tunnel: true, open: true, update: true, headlessBrowser: false, newToken: false, awake: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') out.port = Number(next());
    else if (a === '--tunnel') out.tunnel = true;
    else if (a === '--no-tunnel') out.tunnel = false;
    else if (a === '--no-update') out.update = false;
    else if (a === '--lan') out.host = '0.0.0.0';
    else if (a === '--host') out.host = next();
    else if (a === '--workspace') out.workspace = next();
    else if (a === '--data') out.data = next();
    else if (a === '--no-open') out.open = false;
    else if (a === '--headless-browser') out.headlessBrowser = true;
    else if (a === '--new-token') out.newToken = true;
    else if (a === '--allow-sleep') out.awake = false;
    else if (a === '--public-url') out.publicUrl = next();
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const expand = (p) => (p && p.startsWith('~') ? join(os.homedir(), p.slice(1)) : p);

function loadConfig(dataDir, newToken) {
  const file = join(dataDir, 'config.json');
  let cfg = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, 'utf8'));
    } catch { /* regenerate */ }
  }
  if (!cfg.token || newToken) cfg.token = randomBytes(24).toString('base64url');
  // A plan's server was called Holly Server before the app was Holli Bot
  // (convex/lib/plans.ts SERVERS.name; its account says the same: devices.report).
  if (cfg.name === 'Holly Server') cfg.name = 'Holli Server';
  cfg.name ||= os.hostname();
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  return cfg;
}

/** Web app files: embedded in the single-file build, or read from the repo in development. */
function assetLoader() {
  const embedded = globalThis.__HOLLY_ASSETS__;
  const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', webmanifest: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8' };
  const typeOf = (p) => TYPES[p.split('.').pop()] || 'application/octet-stream';
  if (embedded) {
    return (path) => {
      const v = embedded[path];
      if (v == null) return null;
      return { type: typeOf(path), body: v.startsWith('base64:') ? Buffer.from(v.slice(7), 'base64') : Buffer.from(v, 'utf8') };
    };
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  return (path) => {
    if (path.includes('..') || !/^(index\.html|privacy\.html|terms\.html|styles\.css|manifest\.webmanifest|sw\.js|icons\/|vendor\/|src\/)/.test(path)) return null;
    const file = join(root, path);
    return existsSync(file) ? { type: typeOf(path), body: readFileSync(file) } : null;
  };
}

/**
 * A server Holli Bot set up for a subscriber (convex/lib/cloudinit.ts) comes
 * with a one-time code in the data folder, `link-code`, that links it to the
 * subscriber's account. It's tried a few times through network trouble, then
 * deleted either way.
 */
async function linkWithCode(home, file) {
  let code;
  try {
    code = readFileSync(file, 'utf8').trim();
  } catch {
    return;
  }
  for (let attempt = 1; code && !home.account.linked; attempt++) {
    try {
      await home.link(code);
      console.log('  Linked to the Holli Bot account this server was set up for.');
      break;
    } catch (err) {
      // A code that was refused (used, or too old) won't work on a second try.
      if (/didn't work/i.test(err.message) || attempt >= 5) {
        console.log(`  Couldn't link to the Holli Bot account: ${err.message}`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
  rmSync(file, { force: true });
}

function link(base, url, token) {
  const payload = Buffer.from(JSON.stringify({ url, token })).toString('base64url');
  return `${base}#connect=${payload}`;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* no browser */ }
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return null;
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    console.error(`Holli Bot Computer needs Node.js 22 or newer (you have ${process.version}). Get it at https://nodejs.org`);
    process.exit(1);
  }
  // The single-file build runs the latest one (computer/src/update.mjs).
  // Holli Bot for Windows has already fetched it.
  if (args.update && globalThis.__HOLLY_BUNDLE__ && !DESKTOP && await runLatest({ file: fileURLToPath(import.meta.url), argv })) return null;
  const dataDir = resolve(expand(args.data || join(os.homedir(), '.holly')));
  const workspace = resolve(expand(args.workspace || defaultWorkspace()));
  mkdirSync(dataDir, { recursive: true });
  const cfg = loadConfig(dataDir, args.newToken);

  console.log(`\n  Holli Bot Computer ${VERSION} — ${os.hostname()}\n`);
  const computer = new LocalComputer({ workspace, dataDir, headlessBrowser: args.headlessBrowser, name: cfg.name });
  await computer.start();
  // Linked to a Holli Bot account, the bots are kept in the account; until
  // then, in the data folder (computer/src/home.mjs). The key the account's
  // devices reach this computer with changes with the pairing token.
  const account = new AccountLink(join(dataDir, 'account.json'), { name: cfg.name });
  await account.keepAccessKey({ renew: args.newToken });
  const home = new BotHome({ dataDir, account, computer });
  // A working bot's own screen stays up (computer/src/screens.mjs).
  computer.isBusy = (owner) => !!home.app?.runtime.isAgentBusy(owner);
  const app = await home.open();

  const serverInfo = {
    name: cfg.name,
    hostname: os.hostname(),
    version: VERSION,
    platform: process.platform,
    // Which run of Holli Bot Computer this is, so the tunnel can tell it's this
    // one answering at its address (computer/src/tunnel.mjs).
    instance: randomUUID(),
    get account() {
      return home.status();
    },
  };
  const server = createHollyServer({ app, home, computer, token: cfg.token, assets: assetLoader(), serverInfo });
  // What Holli Bot for Windows shows of how things stand here (below).
  let tellState = () => {};
  home.onSwap = (next) => {
    server.setApp(next);
    // Linked or unlinked.
    tellState();
  };
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(args.port, args.host, ok);
  });
  await linkWithCode(home, join(dataDir, 'link-code'));

  const port = server.address().port;
  const local = `http://localhost:${port}/`;
  const signIn = link(local, '', cfg.token);
  // A Wi-Fi address can't sign in (Apple and Google can't send a sign-in back
  // to it), so it goes by this link alone.
  const lan = args.host === '0.0.0.0' ? lanAddress() : null;
  const wifi = lan ? link(`http://${lan}:${port}/`, '', cfg.token) : null;
  const caps = computer.info.capabilities;
  console.log(`  Workspace: ${workspace}`);
  console.log(`  Data:      ${dataDir}`);
  console.log(account.linked
    ? '  Bots:      kept in your Holli Bot account'
    : '  Bots:      kept on this computer until you sign in to your Holli Bot account here');
  console.log(`  Can use:   shell ✓  files ✓  web ✓  screen ${caps.screenshot ? '✓' : '✗'}  mouse/keyboard ${caps.desktop ? '✓' : '✗'}  Chrome ${caps.browser ? '✓' : '✗'}  plugins ✓`);
  for (const note of computer.info.notes || []) console.log(`             ${note}`);
  console.log('');

  let publicUrl = args.publicUrl ? args.publicUrl.replace(/\/+$/, '') : null;
  let tunnel = null;
  let awake = null;
  let stopping = false;
  /** Once it has stopped, just before it exits (the newer Windows app's installer, below). */
  let lastly = null;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\n  Stopping Holli Bot Computer…');
    tunnel?.stop();
    awake?.stop();
    server.close();
    await home.close();
    await computer.close();
    lastly?.();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Its terminal window closed: the account still hears it stopped, so the
  // phone doesn't try to reach it (Windows allows a few seconds for this).
  process.on('SIGHUP', shutdown);
  // Holli Bot for Windows has a newer Holli Bot Computer ready
  // (below), or a newer version of itself: this one stops for it once no bot
  // is working, and the app starts again.
  let restartTimer = null;
  const restartWhenIdle = () => {
    clearTimeout(restartTimer);
    if (home.app?.runtime.activeRuns().length) {
      restartTimer = setTimeout(restartWhenIdle, 30_000);
      return;
    }
    console.log('\n  Restarting for an update.');
    shutdown();
  };
  if (DESKTOP) {
    process.on('message', (message) => {
      if (message?.type === 'stop') shutdown();
      else if (message?.type === 'restart') restartWhenIdle();
    });
    // The app is gone (it quit, or something went wrong there): so is this.
    process.on('disconnect', shutdown);
  }

  // Holli Bot for Windows hears how things stand here as they change:
  // its page (with the pairing token, which it keeps to itself), whether
  // this computer is linked, where the account's devices can reach it (the
  // tunnel's state: 'starting', 'up' or 'blocked'; 'own' for --public-url;
  // 'off' for none), the Wi-Fi link, and what bots can use here.
  tellState = () => tellDesktop({
    type: 'state',
    version: VERSION,
    name: cfg.name,
    page: signIn,
    port,
    workspace,
    dataDir,
    linked: account.linked,
    tunnel: tunnel ? tunnel.state : publicUrl ? 'own' : 'off',
    address: tunnel ? tunnel.url : publicUrl,
    wifi,
    can: computer.info.capabilities,
    notes: computer.info.notes || [],
  });
  // Linked, it tells the account where the account's devices can reach it,
  // so Holli Bot on each of them connects by itself (or asks to, the first
  // time): no link to open or QR code to scan. A quick tunnel's address is
  // told only while it works, and a new tunnel opens when it stops working
  // (computer/src/tunnel.mjs); without one, the account hears why.
  if (args.tunnel && !publicUrl) {
    let started = false;
    tunnel = new TunnelKeeper({
      port,
      host: args.host,
      instance: serverInfo.instance,
      bin: () => ensureCloudflared(dataDir),
      ownBin: () => ensureCloudflared(dataDir, { own: true }),
      onChange: ({ url, state }) => {
        if (state === 'stopped') return;
        home.setAddress(url, { tunnel: state });
        // Once it's started, what changes is said here too.
        if (url && started) console.log('  The secure tunnel is open: your phone can reach this computer.');
        tellState();
      },
    });
    process.on('exit', () => tunnel.stop());
    console.log('  Opening a secure tunnel so your phone can reach this computer…');
    // Straight away, so an address from before (a run that ended without
    // saying so) isn't tried meanwhile.
    home.setAddress(null, { tunnel: 'starting' });
    tellState();
    publicUrl = await tunnel.start({ waitMs: 90_000 });
    started = true;
    // Asked to stop meanwhile (Holli Bot for Windows quitting).
    if (stopping) return null;
  } else {
    home.setAddress(publicUrl, { tunnel: 'off' });
  }
  const name = cfg.name;
  if (!account.linked) {
    // Signed in on its own page, the computer links itself to that account
    // (src/main.js), and the phone signed in to the same one asks to connect.
    // Holli Bot for Windows opens that page in a window of its own.
    console.log(DESKTOP
      ? '  Sign in on the Holli Bot window, with the Apple or Google account you use in Holli Bot.'
      : args.open
        ? `  Sign in on the page that just opened, with the Apple or Google account you use in Holli Bot.`
        : `  On this computer, open this page and sign in with the Apple or Google account you use in Holli Bot:\n    ${signIn}`);
    console.log(`  Then open Holli Bot on your phone and tap Connect. After that it connects to ${name} by itself.`);
  } else if (publicUrl) {
    console.log(`  Ready. Open Holli Bot on your phone, signed in to your account. It connects to ${name} by itself,`);
    console.log('  or asks you to tap Connect the first time.');
  }
  if (!publicUrl && !tunnel) console.log(`\n  Your phone can't reach ${name} without a public address: start without --no-tunnel, or give it --public-url.`);
  else if (!publicUrl && tunnel.state !== 'blocked') console.log('  The secure tunnel is taking a while. Your phone can connect as soon as it\'s open.');
  if (wifi) {
    console.log(`\n  On a phone on the same Wi-Fi, without signing in, scan or open:\n    ${wifi}\n`);
    // Holli Bot for Windows shows the code in its window.
    if (!DESKTOP) console.log(qrText(wifi).split('\n').map((l) => `    ${l}`).join('\n'));
  }
  if (wifi || (!account.linked && !args.open && !DESKTOP)) {
    console.log('\n  Keep that link private, like a password: anyone who has it can control this computer and see your');
    console.log('  bots, chats and files. If it gets out, restart with --new-token and it stops working.');
  }
  awake = args.awake && args.port !== 0 ? keepAwake() : null;
  if (awake?.active) console.log(`\n  Keeping this computer awake while Holli Bot Computer runs (${DESKTOP ? 'its settings turn that off' : 'start with --allow-sleep to turn that off'}).`);
  if (!DESKTOP) console.log('\n  Keep this window open. Press Ctrl+C to stop.\n');
  if (args.open && !account.linked) openBrowser(signIn);

  // Run by systemd (a Holli Bot server: convex/lib/cloudinit.ts), which starts
  // it again with the latest build: once a newer one is out and no bot is
  // working, it stops for that, so a fix reaches servers without waiting for
  // one to restart. Run by Holli Bot for Windows, which runs around the
  // clock too, it tells the app, which fetches that one and then has this
  // one restart (restartWhenIdle). Elsewhere it updates as it starts
  // (runLatest).
  if (args.update && globalThis.__HOLLY_BUNDLE__ && (process.env.INVOCATION_ID || DESKTOP)) {
    setInterval(async () => {
      const latest = await latestVersion();
      if (!latest || !newerVersion(latest, VERSION) || home.app?.runtime.activeRuns().length) return;
      if (DESKTOP) {
        tellDesktop({ type: 'update', version: latest });
        return;
      }
      console.log(`\n  Holli Bot Computer ${latest} is out: restarting to run it.`);
      shutdown();
    }, UPDATE_EVERY).unref();
  }
  // The first Holli Bot for Windows can't install a newer version of
  // itself without someone at the computer: this does, once no bot is working
  // (computer/src/desktop-update.mjs).
  if (args.update && globalThis.__HOLLY_BUNDLE__ && DESKTOP) {
    updateFirstDesktopApp({
      busy: () => stopping || !!home.app?.runtime.activeRuns().length,
      install: (run, version) => {
        console.log(`\n  Restarting to update Holli Bot for Windows to ${version}.`);
        lastly = run;
        shutdown();
      },
    });
  }
  tellState();
  return { app, home, server, computer, tunnel, db: app.db, token: cfg.token, url: local };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked || globalThis.__HOLLY_BUNDLE__) {
  // One slip in a background task mustn't take the bots, and the phone's way
  // in, down with it: it's said, and Holli Bot Computer keeps running.
  process.on('unhandledRejection', (err) => {
    console.warn(`  Something went wrong in the background: ${err?.stack || err?.message || err}`);
  });
  main().catch((err) => {
    console.error(`\n  Holli Bot Computer failed to start: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
