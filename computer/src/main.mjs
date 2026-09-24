#!/usr/bin/env node
// Holly Computer — run your Holly bots on this computer, 24/7, and control them
// from your phone. Bots can use this machine: shell, files, a real Chrome
// browser, the screen/mouse/keyboard, and local MCP plugins.

import os from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './node-db.mjs'; // IDBKeyRange for the app core
import { LocalComputer, VERSION, defaultWorkspace } from './local-computer.mjs';
import { createHollyServer } from './server.mjs';
import { startQuickTunnel, ensureCloudflared, qrText } from './tunnel.mjs';
import { keepAwake } from './awake.mjs';
import { AccountLink } from './account.mjs';
import { BotHome } from './home.mjs';

const PAGES_URL = 'https://xgamer791.github.io/holly-bot/';

const USAGE = `Holly Computer — your Holly bots live on this computer; control them from your phone.

Usage: node holly-computer.mjs [options]

  --tunnel            Reach this computer from anywhere (Cloudflare quick tunnel; prints a QR code)
  --lan               Allow phones on the same Wi-Fi
  --public-url <url>  Your own permanent address for this computer (e.g. a named Cloudflare
                      Tunnel or Tailscale Funnel pointing at this port) — used in the phone link
  --port <n>          Port to listen on (default 8787)
  --workspace <dir>   Folder the bots work in (default ~/Holly)
  --data <dir>        Holly Computer's own files (default ~/.holly). Until this computer is
                      linked to your Holly Bot account, its bots are kept here too
  --headless-browser  Run the bots' Chrome without a window
  --allow-sleep       Let the computer sleep while Holly Computer runs
  --new-token         Make a new pairing link (old links stop working)
  --no-open           Don't open the app in a browser here
  -h, --help          Show this help`;

function parseArgs(argv) {
  const out = { port: 8787, host: '127.0.0.1', tunnel: false, open: true, headlessBrowser: false, newToken: false, awake: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') out.port = Number(next());
    else if (a === '--tunnel') out.tunnel = true;
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
  const dataDir = resolve(expand(args.data || join(os.homedir(), '.holly')));
  const workspace = resolve(expand(args.workspace || defaultWorkspace()));
  mkdirSync(dataDir, { recursive: true });
  const cfg = loadConfig(dataDir, args.newToken);

  console.log(`\n  Holly Computer ${VERSION} — ${os.hostname()}\n`);
  const computer = new LocalComputer({ workspace, dataDir, headlessBrowser: args.headlessBrowser, name: cfg.name });
  await computer.start();
  // Linked to a Holly Bot account, the bots are kept in the account; until
  // then, in the data folder (computer/src/home.mjs).
  const account = new AccountLink(join(dataDir, 'account.json'), { name: cfg.name });
  const home = new BotHome({ dataDir, account, computer });
  const app = await home.open();

  const serverInfo = {
    name: cfg.name,
    hostname: os.hostname(),
    version: VERSION,
    platform: process.platform,
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

  const port = server.address().port;
  const local = `http://localhost:${port}/`;
  const caps = computer.info.capabilities;
  console.log(`  Workspace: ${workspace}`);
  console.log(`  Data:      ${dataDir}`);
  console.log(account.linked
    ? '  Bots:      kept in your Holly Bot account'
    : '  Bots:      kept on this computer until you link it to your Holly Bot account (open the link below and sign in)');
  console.log(`  Can use:   shell ✓  files ✓  web ✓  screen ${caps.screenshot ? '✓' : '✗'}  mouse/keyboard ${caps.desktop ? '✓' : '✗'}  Chrome ${caps.browser ? '✓' : '✗'}  plugins ✓`);
  for (const note of computer.info.notes || []) console.log(`             ${note}`);
  console.log(`\n  On this computer, open:\n    ${link(local, '', cfg.token)}\n`);

  let publicUrl = args.publicUrl ? args.publicUrl.replace(/\/+$/, '') : null;
  if (args.tunnel && !publicUrl) {
    try {
      const bin = await ensureCloudflared(dataDir);
      console.log('  Opening a secure tunnel…');
      const t = await startQuickTunnel(port, { bin });
      publicUrl = t.url;
      process.on('exit', () => t.stop());
      if (!t.connected) console.log('  The tunnel is slow to connect. If your phone can\'t open the link, this network may block Cloudflare Tunnel — try --lan on the same Wi-Fi.');
    } catch (err) {
      console.log(`  Tunnel failed: ${err.message}`);
    }
  }
  const lan = args.host === '0.0.0.0' ? lanAddress() : null;
  // A public address opens the Holly Bot site (always the current build, with
  // sign-in), connected to this computer. A Wi-Fi address is opened directly,
  // and Apple and Google can't send a sign-in back to it, so it goes without.
  const phone = publicUrl ? link(PAGES_URL, publicUrl, cfg.token) : lan ? link(`http://${lan}:${port}/`, '', cfg.token) : null;
  if (phone) {
    console.log(`  On your phone, scan or open:\n    ${phone}\n`);
    console.log(qrText(phone).split('\n').map((l) => `    ${l}`).join('\n'));
    if (!publicUrl) console.log('\n  Wi-Fi links skip Holly Bot sign-in; start with --tunnel to sign in on your phone.');
  } else {
    console.log('  To control your bots from your phone, restart with --tunnel (from anywhere) or --lan (same Wi-Fi).');
  }
  const awake = args.awake && args.port !== 0 ? keepAwake() : null;
  if (awake?.active) console.log('\n  Keeping this computer awake while Holly Computer runs (start with --allow-sleep to turn that off).');
  console.log('\n  Keep this window open. Press Ctrl+C to stop.\n');
  if (args.open) openBrowser(link(local, '', cfg.token));

  const shutdown = async () => {
    console.log('\n  Stopping Holly Computer…');
    awake?.stop();
    server.close();
    await home.close();
    await computer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { app, home, server, computer, db: app.db, token: cfg.token, url: local };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked || globalThis.__HOLLY_BUNDLE__) {
  main().catch((err) => {
    console.error(`\n  Holly Computer failed to start: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
