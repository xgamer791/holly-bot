import { html, render } from '../vendor/preact.js';
import { App } from './core/app.js';
import { DB } from './core/db.js';
import { Root } from './ui/app.js';
import {
  RemoteApp, holdConnection, savedConnection, saveConnection, takeConnectLink, takeHeldConnection, useConnectionsOf,
} from './remote/remote-app.js';
import { ConnectProblem } from './ui/connect.js';
import { DeviceDataScreen, ProblemScreen, WelcomeFlow, screenFromHash } from './ui/welcome.js';
import { account, friendlyError, signInWorksHere, SITE, takeNotice } from './account/account.js';
import { CloudDB } from './account/cloud-db.js';
import { deviceData, forgetDeviceData, moveDeviceDataInto } from './account/device-data.js';

// Boot. Holly Bot needs an account (Sign in with Apple or Google), and what it
// keeps lives in that account on Holly Bot's server (src/account/cloud-db.js),
// never in the browser where the next person to sign in could see it. Then
// two ways to run:
//  • Your computer (recommended): bots live on Holly Computer and this app is the remote control.
//  • This app: bots run here, call your AI provider directly and keep everything in your account.
// Holly Computer's Wi-Fi address can't sign in (convex/auth.ts); there the
// pairing token protects the app and the bots live on the computer.

const root = document.getElementById('app');
/** A Holly Computer link opened just before this sign-in. */
let adopted = null;

async function boot() {
  const link = takeConnectLink() || takeLegacyPairLink();
  if (handOverToSite(link)) return;
  if (!signInWorksHere()) return bootWithoutAccount(link);
  if (link) holdConnection(link); // for whoever signs in
  const unfinished = await account.finishSignIn();
  if (!account.signedIn) return welcome(unfinished?.from, unfinished?.error || takeNotice());
  // Signing out or in as someone else, here or in another tab, or a session
  // that ends, starts again from the top.
  const me = account.userId;
  account.on(() => account.userId !== me && location.reload());
  account.refreshUser().catch((err) => console.warn('account', err));
  useConnectionsOf(me);
  adopted = takeHeldConnection();
  if (adopted) saveConnection(adopted);
  registerServiceWorker();
  return startAccount();
}

/** Opens the signed-in account: first anything this device kept from before
 * accounts, then the bots, wherever they live. */
async function startAccount() {
  const found = await deviceData().catch((err) => {
    console.warn('device data', err);
    return null;
  });
  const conn = savedConnection();
  if (conn && !found) return bootRemote(conn);
  let db;
  try {
    db = await CloudDB.open();
  } catch (err) {
    console.error('account storage', err);
    if (!account.signedIn) return location.reload();
    show(html`<${ProblemScreen} message=${loadError(err)} onRetry=${startAccount} onSignOut=${() => signOut()} />`);
    return;
  }
  if (!found) return runAccount(db);
  show(html`<${DeviceDataScreen} found=${found}
    onAdd=${async () => {
      await moveDeviceDataInto(db);
      await runAccount(db);
    }}
    onDelete=${async () => {
      await forgetDeviceData();
      await runAccount(db);
    }}
    onSignOut=${() => signOut(db)} />`);
}

function runAccount(db) {
  const conn = savedConnection();
  if (!conn) return bootLocal(db);
  db.close();
  return bootRemote(conn);
}

function loadError(err) {
  if (/could not find public function/i.test(err?.message || '')) return "Holly Bot's server is being updated. Try again in a minute.";
  const message = friendlyError(err);
  return /signing in/.test(message) ? "Holly Bot's server had a problem loading your account. Please try again." : message;
}

/** Signs out before the app opens, leaving nothing of the account here. A
 * Holly Computer link opened for this sign-in waits for the next one. */
async function signOut(db) {
  await db?.close({ forget: true });
  saveConnection(null);
  if (adopted) holdConnection(adopted);
  await account.signOut(); // the listener in boot() reloads into the welcome screen
}

/** Holly Computer's Wi-Fi address (http://192.168…), where Google and Apple
 * can't send anyone back, and browser automation: no account. On Wi-Fi the
 * pairing token protects the app and the bots live on the computer. */
async function bootWithoutAccount(link) {
  if (link) saveConnection(link);
  const conn = savedConnection();
  if (conn) return bootRemote(conn);
  let db;
  try {
    db = await DB.open();
  } catch (err) {
    root.innerHTML = `<div style="padding:40px 24px;color:#ddd;font:16px -apple-system,system-ui,sans-serif;line-height:1.5">
      <h2>Holly Bot can't start</h2><p>This browser blocked local storage (IndexedDB), which Holly Bot needs here.
      Private browsing modes often do this — open the page in a normal window.</p><p style="color:#888">${String(err?.message || err).replace(/</g, '&lt;')}</p></div>`;
    return;
  }
  return bootLocal(db);
}

/** A Holly Computer tunnel (or --public-url) address serves the build that
 * Holly Computer was started with, and Google and Apple can't send anyone back
 * to it. So it hands over to the Holly Bot site: always the current build,
 * with sign-in, connected to the same computer. The pairing token rides in
 * the #fragment, which browsers never send to GitHub. */
function handOverToSite(link) {
  if (location.protocol !== 'https:' || signInWorksHere()) return false;
  const conn = link || savedConnection();
  const target = new URL(SITE);
  if (conn?.token) {
    const payload = JSON.stringify({ url: conn.url || location.origin, token: conn.token, name: conn.name || '' });
    let bytes = '';
    for (const byte of new TextEncoder().encode(payload)) bytes += String.fromCharCode(byte);
    target.hash = `connect=${btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  }
  location.replace(target.href);
  return true;
}

/** The welcome screens, on white. Signing in leaves for Google or Apple and
 * comes back through boot(), and so does signing in from another tab. */
function welcome(start, notice) {
  const screen = start || screenFromHash();
  history.replaceState(null, '', `${location.pathname}${location.search}#/${screen}`);
  account.on(() => account.signedIn && location.reload());
  registerServiceWorker();
  show(html`<${WelcomeFlow} start=${screen} notice=${notice} />`);
}

/** One of the white screens: welcome, sign-in, and the ones on the way into
 * an account. */
function show(view) {
  document.documentElement.classList.add('signed-out');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#ffffff');
  render(view, root);
  document.getElementById('boot')?.remove();
}

async function bootRemote(conn) {
  const app = new RemoteApp(conn);
  try {
    await app.connect();
  } catch (err) {
    render(null, root);
    document.documentElement.classList.remove('signed-out');
    render(html`<${ConnectProblem} conn=${conn} error=${err.message} onRetry=${async () => {
      render(null, root);
      await bootRemote(savedConnection() || conn);
    }} />`, root);
    document.getElementById('boot')?.remove();
    return;
  }
  window.holly = app;
  if (app.server?.name && app.server.name !== conn.name) saveConnection({ ...conn, name: app.server.name });
  mount(app);
}

async function bootLocal(db) {
  let app;
  try {
    app = await App.create({ db });
  } catch (err) {
    console.error('startup', err);
    show(html`<${ProblemScreen} message=${db.cloud ? loadError(err) : String(err?.message || err)} onRetry=${() => location.reload()} onSignOut=${db.cloud ? () => signOut(db) : null} />`);
    return;
  }
  window.holly = app;
  if (db.cloud) watchOtherDevices(app, db);
  mount(app);
  app.start().catch((err) => console.warn('startup services', err));
}

/**
 * Another device changed this account after it loaded here, so what this one
 * shows is out of date. It reloads as soon as that loses nothing: straight
 * away while the app is in the background, otherwise after two quiet minutes,
 * and a banner offers to do it now. Never while a bot is replying, changes are
 * waiting to be saved, or something is being typed.
 */
function watchOtherDevices(app, db) {
  db.onStale = () => {
    let lastInput = Date.now();
    for (const type of ['pointerdown', 'keydown', 'input']) {
      addEventListener(type, () => { lastInput = Date.now(); }, { capture: true, passive: true });
    }
    const reloadIfQuiet = () => {
      const field = document.activeElement;
      const typing = !!(field?.matches?.('input, textarea') ? field.value?.trim() : field?.isContentEditable && field.textContent.trim())
        || [...(app.drafts?.values() || [])].some((text) => text?.trim());
      const busy = typing || app.runtime.activeRuns().length > 0 || db.pending.length > 0;
      const away = document.visibilityState === 'hidden';
      if (!busy && (away || Date.now() - lastInput > 120_000)) location.reload();
    };
    const banner = document.createElement('button');
    banner.className = 'stale-banner';
    banner.textContent = 'Changed on another device · Tap to refresh';
    banner.onclick = () => location.reload();
    document.body.append(banner);
    document.addEventListener('visibilitychange', reloadIfQuiet);
    setInterval(reloadIfQuiet, 5000);
    reloadIfQuiet();
  };
  if (db.stale) db.onStale();
}

function mount(app) {
  render(null, root);
  document.documentElement.classList.remove('signed-out');
  render(html`<${Root} app=${app} />`, root);
  document.getElementById('boot')?.remove();
  registerServiceWorker();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !/[?&]nosw\b/.test(location.search)) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('service worker', err));
  }
}

/** Older links: #pair=<base64 {url, token}> */
function takeLegacyPairLink() {
  const m = location.hash.match(/[#&]pair=([^&]+)/);
  if (!m) return null;
  try {
    const json = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
    history.replaceState(null, '', `${location.pathname}${location.search}#/`);
    return json.url && json.token ? { url: json.url, token: json.token } : null;
  } catch {
    return null;
  }
}

boot();
