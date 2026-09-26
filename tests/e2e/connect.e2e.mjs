// End to end, the way a person connects their phone to their desktop: two
// real Holli Bot Computers linked to the account (the server that comes with the
// plan, and GOAT, the desktop), GOAT's own page open on the desktop, and
// Holli Bot on a phone. The account's backend (Convex) is a stand-in in the
// browser; everything else is the real app.
//
//   1. Signed in on both: only the phone offers Connect; the desktop says to
//      tap it on the phone.
//   2. Connect on the phone: it's confirmed on the phone and on the desktop.
//   3. After that, the phone connects to GOAT by itself.
//   4. A computer the account lists as on, whose address only gets
//      Cloudflare's error page (what Safari called "Load failed"), isn't
//      offered, and picking it says why.
//   5. When GOAT stops, the phone moves to the plan's server by itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { chromium, devices } from 'playwright';
import { main } from '../../computer/src/main.mjs';
import { CONVEX_URL } from '../../src/account/config.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const SHOTS = process.env.SHOTS_DIR || new URL('../../test-results/shots', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const USER = 'j57user0account';
const NS = CONVEX_URL.replace(/[^a-zA-Z0-9]/g, '');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A session for the account (the app only reads who it's for and when it ends). */
const JWT = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub: `${USER}|session1`, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86_400 })}.signature`;

let dir;
let site; // the phone's copy of the app
let cloudflare; // what Cloudflare answers for a tunnel that isn't connected
let serverPc; // the plan's server
let goat; // the desktop
let browser;
let phone;
let desktop;
const errors = [];
/** Convex calls the app made: { path, args }. */
const calls = [];
/** The account's computers, as devices:list gives them. */
const devicesById = new Map();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serveSite() {
  return createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    try {
      if (!file.startsWith(ROOT) || !statSync(file).isFile()) throw new Error('no');
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** A real Holli Bot Computer named `name`, linked to the account as far as the
 * app can tell (its bots stay in its own folder in this test). */
async function computer(name, { server = false, port = 0 } = {}) {
  const data = join(dir, name, 'data');
  const again = port !== 0;
  mkdirSync(data, { recursive: true });
  if (!again) writeFileSync(join(data, 'config.json'), JSON.stringify({ name }));
  const holly = await main(['--port', String(port), '--data', data, '--workspace', join(dir, name, 'ws'), '--no-open', '--no-tunnel', '--allow-sleep']);
  holly.home.status = () => ({ linked: true, userId: USER, ...(server ? { server: true } : {}) });
  holly.base = `http://127.0.0.1:${holly.server.address().port}`;
  // An account that's set up: its Chief Coordinator is there (no first-run page).
  if (!again) await holly.app.createAgent({ name: 'Chief', role: 'chief', greet: false });
  return holly;
}

async function stopComputer(holly) {
  holly.app.stopScheduler();
  holly.server.close();
  holly.server.closeAllConnections?.();
  await holly.computer.close();
  holly.db.close?.();
}

function setDevice(id, fields) {
  devicesById.set(id, { ...devicesById.get(id), ...fields });
}

/** Holli Bot's backend, as far as this app needs it. */
function convex(path, args) {
  switch (path) {
    case 'account:viewer': return { name: 'Sam', email: 'sam@example.com' };
    case 'billing:status': return { active: true, pastDue: false, exempt: true, ready: true, check: false, plans: [], subscription: null, server: null };
    case 'devices:list': return [...devicesById.values()].map((d) => ({ ...d, seenAt: d.stoppedAt ? d.seenAt : Date.now() }));
    case 'devices:pair':
      if (devicesById.has(args.id)) setDevice(args.id, { paired: true });
      return null;
    case 'connectors:list': return [];
    case 'credits:mine': return null;
    default: return new Error(`Could not find public function for '${path}'`);
  }
}

async function backend(route) {
  const req = route.request();
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization, convex-client', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const { path, args } = req.postDataJSON();
  calls.push({ path, args: args?.[0] });
  const value = convex(path, args?.[0] || {});
  const body = value instanceof Error ? { status: 'error', errorMessage: value.message, logLines: [] } : { status: 'success', value: value ?? null, logLines: [] };
  return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
}

async function newContext(options) {
  const ctx = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block', ...options });
  await ctx.route(`${CONVEX_URL}/api/**`, backend);
  return ctx;
}

/** Signs `page` in to the account on `origin` (the session lives in its storage), and saves `connection`. */
async function signIn(page, origin, connection = null) {
  await page.goto(`${origin}/not-the-app`);
  await page.evaluate(({ ns, jwt, user, connection: conn }) => {
    localStorage.setItem(`__convexAuthJWT_${ns}`, jwt);
    localStorage.setItem(`__convexAuthRefreshToken_${ns}`, 'refresh-token');
    localStorage.setItem('holly.account', JSON.stringify({ name: 'Sam', email: 'sam@example.com' }));
    if (conn) localStorage.setItem(`holly.connection:${user}`, JSON.stringify(conn));
  }, { ns: NS, jwt: JWT, user: USER, connection });
}

function watch(page, who) {
  page.on('pageerror', (e) => errors.push(`${who} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // A dead address, and this test's site, which has no /v1/health: expected.
    if (/Failed to load resource|CORS|net::ERR|Access-Control/i.test(m.text())) return;
    errors.push(`${who} console: ${m.text()}`);
  });
}

const dialog = (page, title) => page.locator('.dialog', { has: page.locator('h3', { hasText: title }) });
const toast = (page, text) => page.locator('.toast', { hasText: text });
const note = (page, text) => page.locator('.list-notice', { hasText: text });
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/connect-${name}.png` });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'holly-connect-e2e-'));
  site = serveSite();
  const sitePort = await listen(site);
  site.origin = `http://localhost:${sitePort}`;
  // Cloudflare's page for a quick tunnel that isn't connected: error 1033,
  // status 530, no CORS headers, so a browser's fetch just fails.
  cloudflare = createServer((req, res) => {
    res.writeHead(530, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><title>Cloudflare Tunnel error</title><h1>Error 1033</h1>');
  });
  cloudflare.origin = `http://127.0.0.1:${await listen(cloudflare)}`;

  serverPc = await computer('Holli Server', { server: true });
  goat = await computer('GOAT');
  setDevice('devServer', { id: 'devServer', name: 'Holli Server', linkedAt: 1, url: serverPc.base, access: serverPc.token, server: true, paired: false });
  setDevice('devGoat', { id: 'devGoat', name: 'GOAT', linkedAt: 2, url: goat.base, access: goat.token, server: false, paired: false });

  browser = await chromium.launch();
  const phoneCtx = await newContext({ ...devices['iPhone 13'] });
  phone = await phoneCtx.newPage();
  watch(phone, 'phone');
  const desktopCtx = await newContext({ viewport: { width: 1280, height: 800 } });
  desktop = await desktopCtx.newPage();
  watch(desktop, 'desktop');
});

after(async () => {
  await browser?.close();
  for (const holly of [serverPc, goat]) if (holly) await stopComputer(holly).catch(() => {});
  site?.close();
  cloudflare?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('signed in on the desktop: its own page never offers Connect, and says to tap it on the phone', async () => {
  const goatOrigin = `http://localhost:${goat.server.address().port}`;
  await signIn(desktop, goatOrigin);
  const link = Buffer.from(JSON.stringify({ url: '', token: goat.token })).toString('base64url');
  await desktop.goto(`${goatOrigin}/?signin#connect=${link}`);
  await note(desktop, 'Open Holli Bot on your phone and tap Connect to use GOAT from it.').waitFor({ timeout: 20_000 });
  assert.equal(await desktop.locator('.dialog').count(), 0, 'no Connect question on the desktop');
  await shot(desktop, 'desktop-waiting');
});

test('the phone, on the plan\'s server, offers Connect once the desktop answers; Connect is confirmed on both', async () => {
  await signIn(phone, site.origin, { url: serverPc.base, token: serverPc.token, name: 'Holli Server', device: 'devServer' });
  await phone.goto(`${site.origin}/?signin`);
  await phone.waitForFunction(() => window.holly?.remote && window.holly.server?.name === 'Holli Server', null, { timeout: 20_000 });
  const ask = dialog(phone, 'Connect to GOAT?');
  await ask.waitFor({ timeout: 20_000 });
  await shot(phone, 'phone-offer');
  await ask.getByRole('button', { name: 'Connect', exact: true }).click();

  // The phone reloads onto GOAT and says so.
  await toast(phone, 'Connected to GOAT. Your bots run there now.').waitFor({ timeout: 20_000 });
  assert.equal(await phone.evaluate(() => window.holly.server?.name), 'GOAT');
  await shot(phone, 'phone-connected');
  assert.ok(calls.some((c) => c.path === 'devices:pair' && c.args.id === 'devGoat'), 'the account keeps that the phone connected');
  assert.equal(devicesById.get('devGoat').paired, true);

  // The desktop confirms it too, and stops asking for the phone.
  const confirm = dialog(desktop, 'Connected to your iPhone');
  await confirm.waitFor({ timeout: 20_000 });
  assert.match(await confirm.textContent(), /Holli Bot on your iPhone is connected to GOAT\. Your bots run here, and you can use them from your iPhone\./);
  await shot(desktop, 'desktop-confirmed');
  await confirm.getByRole('button', { name: 'OK' }).click();
  await note(desktop, 'tap Connect').waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await desktop.locator('.dialog', { hasText: 'Connect to' }).count(), 0);
});

test('after that, the phone connects to the desktop by itself: as it opens, and while it\'s open', async () => {
  // As it opens, on the plan's server: straight onto GOAT, no question.
  await phone.evaluate(({ user, conn }) => localStorage.setItem(`holly.connection:${user}`, JSON.stringify(conn)), { user: USER, conn: { url: serverPc.base, token: serverPc.token, name: 'Holli Server', device: 'devServer' } });
  await phone.reload();
  await phone.waitForFunction(() => window.holly?.server?.name === 'GOAT', null, { timeout: 20_000 });
  assert.equal(await phone.locator('.dialog').count(), 0);

  // GOAT off: the phone opens on the plan's server.
  const port = goat.server.address().port;
  await stopComputer(goat);
  setDevice('devGoat', { url: undefined, access: undefined, stoppedAt: Date.now(), seenAt: Date.now() });
  await phone.reload();
  await phone.waitForFunction(() => window.holly?.server?.name === 'Holli Server', null, { timeout: 30_000 });
  // GOAT starts again while the phone is open: it moves over by itself, once nothing's going on.
  goat = await computer('GOAT', { port });
  setDevice('devGoat', { url: goat.base, access: goat.token, stoppedAt: undefined });
  await toast(phone, 'Connected to GOAT.').waitFor({ timeout: 60_000 });
  assert.equal(await phone.evaluate(() => window.holly.server?.name), 'GOAT');
  assert.equal(await dialog(phone, 'Connect to GOAT?').count(), 0, 'not asked again');
  // The desktop says so, quietly this time.
  await toast(desktop, 'Holli Bot on your iPhone connected to GOAT.').waitFor({ timeout: 20_000 });
  assert.equal(await dialog(desktop, 'Connected to your iPhone').count(), 0);
});

test('a computer listed as on, whose address only gets Cloudflare\'s error page, isn\'t offered; picking it says why', async () => {
  setDevice('devLaptop', { id: 'devLaptop', name: 'LAPTOP', linkedAt: 3, url: cloudflare.origin, access: 'x'.repeat(43), server: false, paired: false });
  await note(phone, "LAPTOP is on, but this app can't reach it yet. It keeps trying.").waitFor({ timeout: 25_000 });
  assert.equal(await dialog(phone, 'Connect to LAPTOP?').count(), 0, 'never offered while it doesn\'t answer');

  // The Workspace sheet (where "Load failed" showed): its status, and why picking it doesn't work.
  const bot = await goat.app.createAgent({ name: 'Holli Bot Debug', greet: false });
  await phone.locator('.row-bot', { hasText: 'Holli Bot Debug' }).click();
  await phone.getByRole('button', { name: 'Workspace' }).click();
  await phone.getByRole('tab', { name: 'Server' }).click();
  const laptopRow = phone.locator('.ws-row', { hasText: 'LAPTOP' });
  await laptopRow.locator('.ws-sub', { hasText: "On, but this app can't reach it" }).waitFor({ timeout: 15_000 });
  await phone.locator('.ws-row', { hasText: 'GOAT' }).locator('.ws-sub', { hasText: 'Connected' }).waitFor();
  await shot(phone, 'phone-workspace');
  await laptopRow.click();
  await dialog(phone, 'Connect to LAPTOP?').getByRole('button', { name: 'Connect', exact: true }).click();
  await toast(phone, "LAPTOP didn't answer at its address. Make sure it's on and Holli Bot Computer is running there.").waitFor({ timeout: 20_000 });
  assert.equal(await phone.getByText(/Load failed|Failed to fetch/).count(), 0);
  assert.equal(await phone.evaluate(() => window.holly.server?.name), 'GOAT', 'still on GOAT');
  await shot(phone, 'phone-workspace-error');
  await phone.keyboard.press('Escape');
  await phone.goto(`${site.origin}/?signin#/`);
  await phone.waitForFunction(() => window.holly?.server?.name === 'GOAT', null, { timeout: 20_000 });

  // Its tunnel is replaced and the new address answers: now it's offered.
  setDevice('devLaptop', { url: serverPc.base, access: serverPc.token });
  const ask = dialog(phone, 'Connect to LAPTOP?');
  await ask.waitFor({ timeout: 25_000 });
  await ask.getByRole('button', { name: 'Not now' }).click();
  await note(phone, 'LAPTOP is on. Connect so your bots can use it.').waitFor({ timeout: 5000 });
  devicesById.delete('devLaptop');
  await goat.app.deleteAgent(bot.id);
});

test('when the desktop stops, the phone moves to the plan\'s server by itself', async () => {
  // Two minutes pass on a fake clock; what the phone says is noted as it
  // shows, since a jump in time can take a toast away before it's seen.
  await phone.clock.install();
  await phone.addInitScript(() => {
    new MutationObserver(() => {
      const said = JSON.parse(sessionStorage.getItem('toasts') || '[]');
      for (const t of document.querySelectorAll('.toast span')) if (!said.includes(t.textContent)) said.push(t.textContent);
      sessionStorage.setItem('toasts', JSON.stringify(said));
    }).observe(document, { childList: true, subtree: true });
  });
  await phone.reload();
  await phone.waitForFunction(() => window.holly?.server?.name === 'GOAT' && window.holly.reachable, null, { timeout: 20_000 });
  await stopComputer(goat);
  goat = null;
  setDevice('devGoat', { url: undefined, access: undefined, stoppedAt: Date.now() });
  await phone.waitForFunction(() => window.holly.reachable === false, null, { timeout: 60_000 });
  const heard = [];
  const log = console.log;
  console.log = (...args) => {
    heard.push(args.join(' '));
    log(...args);
  };
  try {
    // Two minutes on, still no GOAT: the phone moves by itself, and says so.
    await phone.clock.fastForward('02:10');
    await phone.waitForFunction(() => window.holly?.server?.name === 'Holli Server' && JSON.parse(sessionStorage.getItem('toasts') || '[]').includes('Connected to Holli Server.'), null, { timeout: 40_000 });
    // And the plan's server heard it: a phone connected, by itself this time.
    const end = Date.now() + 10_000;
    while (!heard.some((line) => /Holli Bot on your iPhone connected\./.test(line)) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.ok(heard.some((line) => /Holli Bot on your iPhone connected\./.test(line)), heard.join('\n'));
  } finally {
    console.log = log;
  }
});

test('no page errors', () => {
  assert.deepEqual(errors, []);
});
