#!/usr/bin/env node
// Holly Computer — run your Holly bots on this computer, 24/7, and control them
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

/** How often a Holly Bot server looks for a newer Holly Computer. */
const UPDATE_EVERY = 5 * 60_000;

const USAGE = `Holly Computer — your Holly bots live on this computer; control them from your phone.

Usage: node holly-computer.mjs [options]

Sign in on the page it opens, with the Apple or Google account you use in Holly
Bot. Holly Bot on your phone then connects to this computer by itself.

  --no-tunnel         Don't open a Cloudflare tunnel (then your phone can't reach this
                      computer, unless you give it --public-url)
  --public-url <url>  Your own permanent https address for this computer (e.g. a named
                      Cloudflare Tunnel or Tailscale Funnel pointing at this port)
  --lan               Allow phones on the same Wi-Fi, without signing in (prints a link)
  --port <n>          Port to listen on (default 8787)
  --workspace <dir>   Folder the bots work in (default ~/Holly)
  --data <dir>        Holly Computer's own files (default ~/.holly). Until this computer is
                      linked to your Holly Bot account, its bots are kept here too
  --headless-browser  Run the bots' Chrome without a window
  --allow-sleep       Let the computer sleep while Holly Computer runs
  --new-token         New keys for this computer: every device has to find it again
  --no-open           Don't open the sign-in page in a browser here
  --no-update         Don't update Holly Computer as it starts
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
  cfg.name ||= os.hostname();
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  return cfg;
}

/** Web app files: embedded in the single-file build, or read from the repo in development. */
function assetLoader() {
  const embedded = globalThis.__HOLLY_ASSETS__;
  const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', webmanifest: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png' };
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
 * A server Holly Bot set up for a subscriber (convex/lib/cloudinit.ts) comes
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
      console.log('  Linked to the Holly Bot account this server was set up for.');
      break;
    } catch (err) {
      // A code that was refused (used, or too old) won't work on a second try.
      if (/didn't work/i.test(err.message) || attempt >= 5) {
        console.log(`  Couldn't link to the Holly Bot account: ${err.message}`);
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
    console.error(`Holly Computer needs Node.js 22 or newer (you have ${process.version}). Get it at https://nodejs.org`);
    process.exit(1);
  }
  // The single-file build runs the latest one (computer/src/update.mjs).
  if (args.update && globalThis.__HOLLY_BUNDLE__ && await runLatest({ file: fileURLToPath(import.meta.url), argv })) return null;
  const dataDir = resolve(expand(args.data || join(os.homedir(), '.holly')));
  const workspace = resolve(expand(args.workspace || defaultWorkspace()));
  mkdirSync(dataDir, { recursive: true });
  const cfg = loadConfig(dataDir, args.newToken);

  console.log(`\n  Holly Computer ${VERSION} — ${os.hostname()}\n`);
  const computer = new LocalComputer({ workspace, dataDir, headlessBrowser: args.headlessBrowser, name: cfg.name });
  await computer.start();
  // Linked to a Holly Bot account, the bots are kept in the account; until
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
    // Which run of Holly Computer this is, so the tunnel can tell it's this
    // one answering at its address (computer/src/tunnel.mjs).
    instance: randomUUID(),
    get account() {
      return home.status();
    },
  };
  const server = createHollyServer({ app, home, computer, token: cfg.token, assets: assetLoader(), serverInfo });
  home.onSwap = (next) => server.setApp(next);
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(args.port, args.host, ok);
  });
  await linkWithCode(home, join(dataDir, 'link-code'));

  const port = server.address().port;
  const local = `http://localhost:${port}/`;
  const caps = computer.info.capabilities;
  console.log(`  Workspace: ${workspace}`);
  console.log(`  Data:      ${dataDir}`);
  console.log(account.linked
    ? '  Bots:      kept in your Holly Bot account'
    : '  Bots:      kept on this computer until you sign in to your Holly Bot account here');
  console.log(`  Can use:   shell ✓  files ✓  web ✓  screen ${caps.screenshot ? '✓' : '✗'}  mouse/keyboard ${caps.desktop ? '✓' : '✗'}  Chrome ${caps.browser ? '✓' : '✗'}  plugins ✓`);
  for (const note of computer.info.notes || []) console.log(`             ${note}`);
  console.log('');

  // Linked, it tells the account where the account's devices can reach it,
  // so Holly Bot on each of them connects by itself (or asks to, the first
  // time): no link to open or QR code to scan. A quick tunnel's address is
  // told only while it works, and a new tunnel opens when it stops working
  // (computer/src/tunnel.mjs); without one, the account hears why.
  let publicUrl = args.publicUrl ? args.publicUrl.replace(/\/+$/, '') : null;
  let tunnel = null;
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
      },
    });
    process.on('exit', () => tunnel.stop());
    console.log('  Opening a secure tunnel so your phone can reach this computer…');
    // Straight away, so an address from before (a run that ended without
    // saying so) isn't tried meanwhile.
    home.setAddress(null, { tunnel: 'starting' });
    publicUrl = await tunnel.start({ waitMs: 90_000 });
    started = true;
  } else {
    home.setAddress(publicUrl, { tunnel: 'off' });
  }
  const name = cfg.name;
  const signIn = link(local, '', cfg.token);
  if (!account.linked) {
    // Signed in on its own page, the computer links itself to that account
    // (src/main.js), and the phone signed in to the same one asks to connect.
    console.log(args.open
      ? `  Sign in on the page that just opened, with the Apple or Google account you use in Holly Bot.`
      : `  On this computer, open this page and sign in with the Apple or Google account you use in Holly Bot:\n    ${signIn}`);
    console.log(`  Then open Holly Bot on your phone and tap Connect. After that it connects to ${name} by itself.`);
  } else if (publicUrl) {
    console.log(`  Ready. Open Holly Bot on your phone, signed in to your account. It connects to ${name} by itself,`);
    console.log('  or asks you to tap Connect the first time.');
  }
  if (!publicUrl && !tunnel) console.log(`\n  Your phone can't reach ${name} without a public address: start without --no-tunnel, or give it --public-url.`);
  else if (!publicUrl && tunnel.state !== 'blocked') console.log('  The secure tunnel is taking a while. Your phone can connect as soon as it\'s open.');
  const lan = args.host === '0.0.0.0' ? lanAddress() : null;
  if (lan) {
    // A Wi-Fi address can't sign in (Apple and Google can't send a sign-in
    // back to it), so it goes by this link alone.
    const wifi = link(`http://${lan}:${port}/`, '', cfg.token);
    console.log(`\n  On a phone on the same Wi-Fi, without signing in, scan or open:\n    ${wifi}\n`);
    console.log(qrText(wifi).split('\n').map((l) => `    ${l}`).join('\n'));
  }
  if (lan || (!account.linked && !args.open)) {
    console.log('\n  Keep that link private, like a password: anyone who has it can control this computer and see your');
    console.log('  bots, chats and files. If it gets out, restart with --new-token and it stops working.');
  }
  const awake = args.awake && args.port !== 0 ? keepAwake() : null;
  if (awake?.active) console.log('\n  Keeping this computer awake while Holly Computer runs (start with --allow-sleep to turn that off).');
  console.log('\n  Keep this window open. Press Ctrl+C to stop.\n');
  if (args.open && !account.linked) openBrowser(signIn);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\n  Stopping Holly Computer…');
    tunnel?.stop();
    awake?.stop();
    server.close();
    await home.close();
    await computer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Its terminal window closed: the account still hears it stopped, so the
  // phone doesn't try to reach it (Windows allows a few seconds for this).
  process.on('SIGHUP', shutdown);
  // Run by systemd (a Holly Bot server: convex/lib/cloudinit.ts), which starts
  // it again with the latest build: once a newer one is out and no bot is
  // working, it stops for that, so a fix reaches servers without waiting for
  // one to restart. Elsewhere it updates as it starts (runLatest).
  if (args.update && globalThis.__HOLLY_BUNDLE__ && process.env.INVOCATION_ID) {
    setInterval(async () => {
      const latest = await latestVersion();
      if (!latest || !newerVersion(latest, VERSION) || home.app?.runtime.activeRuns().length) return;
      console.log(`\n  Holly Computer ${latest} is out: restarting to run it.`);
      shutdown();
    }, UPDATE_EVERY).unref();
  }
  return { app, home, server, computer, tunnel, db: app.db, token: cfg.token, url: local };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked || globalThis.__HOLLY_BUNDLE__) {
  // One slip in a background task mustn't take the bots, and the phone's way
  // in, down with it: it's said, and Holly Computer keeps running.
  process.on('unhandledRejection', (err) => {
    console.warn(`  Something went wrong in the background: ${err?.stack || err?.message || err}`);
  });
  main().catch((err) => {
    console.error(`\n  Holly Computer failed to start: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
