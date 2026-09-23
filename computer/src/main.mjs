#!/usr/bin/env node
// Holly Computer — run your Holly bots on this computer, 24/7, and control them
// from your phone. Bots can use this machine: shell, files, a real Chrome
// browser, the screen/mouse/keyboard, and local MCP plugins.
//
//   node holly-computer.mjs [--port 8787] [--tunnel] [--lan] [--workspace ~/Holly]
//                           [--data ~/.holly] [--no-open] [--headless-browser] [--new-token]

import os from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeDB } from './node-db.mjs';
import { LocalComputer, VERSION, defaultWorkspace } from './local-computer.mjs';
import { createHollyServer } from './server.mjs';
import { startQuickTunnel, hasCloudflared, qrText } from './tunnel.mjs';
import { App } from '../../src/core/app.js';

const PAGES_URL = 'https://xgamer791.github.io/holly-bot/';

function parseArgs(argv) {
  const out = { port: 8787, host: '127.0.0.1', tunnel: false, open: true, headlessBrowser: false, newToken: false };
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
    return (path) => (embedded[path] ? { type: typeOf(path), body: Buffer.from(embedded[path], 'base64') } : null);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  return (path) => {
    if (path.includes('..') || !/^(index\.html|styles\.css|manifest\.webmanifest|sw\.js|icons\/|vendor\/|src\/)/.test(path)) return null;
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
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 8).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
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
  const db = await NodeDB.open(join(dataDir, 'data'));
  const app = await App.create({ db, computer, host: 'computer' });
  await app.start();
  app.startScheduler();

  const serverInfo = { name: cfg.name, hostname: os.hostname(), version: VERSION, platform: process.platform };
  const server = createHollyServer({ app, computer, token: cfg.token, assets: assetLoader(), serverInfo });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(args.port, args.host, ok);
  });

  const local = `http://localhost:${args.port}/`;
  const caps = computer.info.capabilities;
  console.log(`  Workspace: ${workspace}`);
  console.log(`  Data:      ${dataDir}`);
  console.log(`  Can use:   shell ✓  files ✓  web ✓  screen ${caps.screenshot ? '✓' : '✗'}  mouse/keyboard ${caps.desktop ? '✓' : '✗'}  Chrome ${caps.browser ? '✓' : '✗'}  plugins ✓`);
  for (const note of computer.info.notes || []) console.log(`             ${note}`);
  console.log(`\n  On this computer, open:\n    ${link(local, '', cfg.token)}\n`);

  let publicUrl = null;
  if (args.tunnel) {
    if (!hasCloudflared()) {
      console.log('  --tunnel needs cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
    } else {
      try {
        const t = await startQuickTunnel(args.port);
        publicUrl = t.url;
        process.on('exit', () => t.stop());
      } catch (err) {
        console.log(`  Tunnel failed: ${err.message}`);
      }
    }
  }
  const lan = args.host === '0.0.0.0' ? lanAddress() : null;
  const phoneBase = publicUrl ? `${publicUrl}/` : lan ? `http://${lan}:${args.port}/` : null;
  if (phoneBase) {
    const phone = link(phoneBase, '', cfg.token);
    console.log(`  On your phone, scan or open:\n    ${phone}\n`);
    console.log(qrText(phone).split('\n').map((l) => `    ${l}`).join('\n'));
    if (publicUrl) console.log(`\n  (Or use the installed app: ${link(PAGES_URL, publicUrl, cfg.token)})`);
  } else {
    console.log('  To control your bots from your phone, restart with --tunnel (needs cloudflared) or --lan (same Wi-Fi).');
  }
  console.log('\n  Keep this window open. Press Ctrl+C to stop.\n');
  if (args.open) openBrowser(link(local, '', cfg.token));

  const shutdown = async () => {
    console.log('\n  Stopping Holly Computer…');
    app.runtime.stopAll();
    app.stopScheduler();
    server.close();
    await computer.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { app, server, computer, db, token: cfg.token, url: local };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked || globalThis.__HOLLY_BUNDLE__) {
  main().catch((err) => {
    console.error(`\n  Holly Computer failed to start: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
