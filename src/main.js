import { html, render } from '../vendor/preact.js';
import { App } from './core/app.js';
import { DB } from './core/db.js';
import { Root } from './ui/app.js';
import {
  RemoteApp, holdConnection, savedConnection, saveConnection, takeConnectLink, takeHeldConnection, useConnectionsOf,
} from './remote/remote-app.js';
import { ConnectProblem } from './ui/connect.js';
import {
  DeviceDataScreen, LinkComputerScreen, OtherAccountScreen, ProblemScreen, WelcomeFlow, screenFromHash,
} from './ui/welcome.js';
import { SubscribeScreen } from './ui/subscribe.js';
import { SetupScreen } from './ui/setup.js';
import {
  account, friendlyError, noticeAfterReload, signInWorksHere, SITE, takeNotice,
} from './account/account.js';
import { CloudDB, inactive } from './account/cloud-db.js';
import { makeLinkCode } from './account/device-link.js';
import { deviceData, forgetDeviceData, moveDeviceDataInto } from './account/device-data.js';

// Boot. Holly Bot needs an account (Sign in with Apple or Google) with an
// active subscription: until it has one, the subscription page stands in for
// the app (src/ui/subscribe.js). What it keeps lives in that account on Holly
// Bot's server (src/account/cloud-db.js), never in the browser where the next
// person to sign in could see it. Then two ways to run:
//  • Your computer (recommended): bots live on Holly Computer and this app is the remote control.
//  • This app: bots run here, call your AI provider directly and keep everything in your account.
// Holly Computer linked to the account keeps its bots there too, and runs
// them (computer/src/home.mjs); opening one that isn't linked yet offers the
// link. Its Wi-Fi address can't sign in (convex/auth.ts); there the pairing
// token alone protects it.

const root = document.getElementById('app');
/** A Holly Computer link opened just before this sign-in. */
let adopted = null;
/** What to say once the app opens (how connecting a service went). */
let notice = null;

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
  if (await subscribed()) await openApp();
}

/** Past the subscription page and the computer's setup: connects to the
 * subscriber's computer, finishes connecting a service if that's what brought
 * the person back, then opens the account. */
async function openApp() {
  whitePages(false);
  if (/^#\/(subscribe|setup)\b/.test(location.hash)) history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  await useServer();
  const connected = await finishConnecting();
  if (connected) notice = connected;
  return startAccount();
}

/** Marks the next launch as one of the white pages' (the subscription page,
 * or the computer's setup), so index.html starts it on white instead of the
 * app's dark splash. */
function whitePages(on) {
  try {
    if (on) localStorage.setItem('holly.subscribePage', '1');
    else localStorage.removeItem('holly.subscribePage');
  } catch { /* storage blocked */ }
}

/** The latest billing:status (convex/billing.ts). */
let billing = null;
let watchingSubscription = false;

/**
 * Holly Bot opens only for an account with an active subscription
 * (convex/billing.ts) whose computer is ready (convex/servers.ts). Anyone
 * without a subscription gets the subscription page instead, and a subscriber
 * whose computer is still being set up gets its progress (src/ui/setup.js);
 * the address can't get around either, since the app and its routes open only
 * from here. Back from Stripe (Checkout or the billing portal), or when a paid
 * period should have ended, Stripe is asked first, so a subscription just paid
 * for goes straight on to its computer. True when the app may open; otherwise
 * a page has taken over, and opens it when it's time.
 */
async function subscribed() {
  const back = takeBillingReturn();
  let status;
  try {
    status = back === 'paid' || back === 'billing'
      ? await account.authed('action', 'billing:sync')
      : await account.authed('query', 'billing:status');
    if (status.check) status = await account.authed('action', 'billing:sync');
  } catch (err) {
    console.error('subscription', err);
    if (!account.signedIn) {
      location.reload();
      return false;
    }
    show(html`<${ProblemScreen} message=${loadError(err)} onRetry=${() => location.reload()} onSignOut=${() => signOut()} />`);
    return false;
  }
  billing = status;
  if (!status.active) {
    showSubscribe(status, back);
    return false;
  }
  if (back === 'paid') notice = { text: welcomeText(status) };
  if (usable(status)) return true;
  showSetup(status);
  return false;
}

/** Whether the app can open: the subscriber's computer is ready (or being
 * resized), or they're past due, keeping what they have while Stripe tries
 * their card again. */
function usable(status) {
  return status.pastDue || ['ready', 'resizing'].includes(status.server?.status);
}

function showSubscribe(status, back) {
  whitePages(true);
  history.replaceState(null, '', `${location.pathname}${location.search}#/subscribe`);
  show(html`<${SubscribeScreen} status=${status} back=${back}
    onActive=${(next) => {
      billing = next;
      notice = { text: welcomeText(next) };
      if (usable(next)) openApp();
      else showSetup(next);
    }}
    onSignOut=${() => signOut()}
    onDeleteAccount=${deleteFromSubscribePage} />`);
}

function showSetup(status) {
  whitePages(true);
  history.replaceState(null, '', `${location.pathname}${location.search}#/setup`);
  show(html`<${SetupScreen} status=${status}
    onReady=${(next) => {
      billing = next;
      openApp();
    }}
    onSignOut=${() => signOut()}
    onDeleteAccount=${deleteFromSubscribePage} />`);
}

/**
 * The subscriber's own computer (convex/servers.ts) is where their bots run,
 * so this app becomes its remote control, the way it does for a Holly
 * Computer opened from its link. It's set up once per computer: choosing
 * "Use bots in this app instead" sticks until the computer changes (a
 * smaller one after a downgrade), and a Holly Computer of the person's own
 * that this app is already connected to stays.
 */
async function useServer() {
  let server = null;
  try {
    server = await account.authed('query', 'servers:connection');
  } catch (err) {
    console.warn('server', err);
  }
  if (!server) return;
  const saved = savedConnection();
  const offered = `holly.serverOffered:${account.userId}`;
  let last = null;
  try {
    last = localStorage.getItem(offered);
  } catch { /* storage blocked */ }
  const replaced = saved?.managed && (saved.url !== server.url || saved.token !== server.token);
  if (!replaced && (saved || last === server.url)) return;
  saveConnection({ url: server.url, token: server.token, name: server.name, managed: true });
  try {
    localStorage.setItem(offered, server.url);
  } catch { /* storage blocked */ }
}

function welcomeText(status) {
  const plan = status.plans?.find((p) => p.id === status.subscription?.plan);
  return plan ? `Welcome to Holly Bot ${plan.name}.` : 'Welcome to Holly Bot.';
}

/** Back from Stripe: ?checkout=done or ?checkout=cancelled (Checkout), or
 * ?billing=done (the billing portal). Takes it off the address and says
 * which: 'paid', 'cancelled' or 'billing'. */
function takeBillingReturn() {
  const url = new URL(location.href);
  const checkout = url.searchParams.get('checkout');
  const billing = url.searchParams.get('billing');
  if (!checkout && !billing) return null;
  url.searchParams.delete('checkout');
  url.searchParams.delete('billing');
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  if (checkout) return checkout === 'done' ? 'paid' : 'cancelled';
  return 'billing';
}

/**
 * Delete Account on the subscription page, for someone who'd rather not
 * subscribe (Settings, where it usually is, is part of the app). Like
 * Settings → Delete Account, it leaves nothing of the account on the device.
 */
async function deleteFromSubscribePage() {
  const conn = savedConnection();
  saveConnection(null);
  try {
    indexedDB.deleteDatabase(CloudDB.outboxName(account.userId));
  } catch { /* no IndexedDB here */ }
  noticeAfterReload('Your account and everything in it have been deleted.');
  try {
    await account.deleteAccount(); // the listener in boot() reloads into the welcome screen
  } catch (err) {
    takeNotice();
    if (conn) saveConnection(conn);
    throw err;
  }
}

/**
 * While the app is open, its subscription can change. It's checked each time
 * the app comes back to the front and every ten minutes: once it has ended,
 * the app reloads, which lands on the subscription page (changes not yet
 * saved wait on the device); a renewal that didn't go through shows a banner
 * asking for a new card; and when the subscriber's computer was replaced (a
 * smaller one after a downgrade), the app reloads to connect to the new one.
 */
function watchSubscription() {
  if (watchingSubscription) return;
  watchingSubscription = true;
  let checking = false;
  const check = async () => {
    if (checking || document.visibilityState !== 'visible' || !account.signedIn) return;
    checking = true;
    try {
      let status = await account.authed('query', 'billing:status');
      if (status.check) status = await account.authed('action', 'billing:sync');
      billing = status;
      if (!status.active) return location.reload();
      if (status.pastDue) paymentBanner();
      const saved = savedConnection();
      if (saved?.managed) {
        const server = await account.authed('query', 'servers:connection');
        if (server && server.url !== saved.url) location.reload();
      }
    } catch { /* offline, or the server is busy: next time */ } finally {
      checking = false;
    }
    return undefined;
  };
  document.addEventListener('visibilitychange', check);
  setInterval(check, 10 * 60_000);
}

let paymentBannerShown = false;

/** Past due: Holly Bot keeps working while Stripe tries the card again, and
 * this asks for a new one, in Stripe's billing portal. */
function paymentBanner() {
  if (paymentBannerShown) return;
  paymentBannerShown = true;
  const button = banner("Your payment didn't go through · Update it", async () => {
    button.disabled = true;
    try {
      location.assign(await account.authed('action', 'billing:portal', { returnTo: `${location.origin}${location.pathname}` }));
    } catch (err) {
      console.warn('billing', err);
      button.textContent = "Couldn't open billing · Tap to try again";
      button.disabled = false;
    }
  }, 'warn');
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
    const userId = account.userId;
    db = await CloudDB.open({ userId, call: (kind, name, args) => account.authed(kind, name, args, { as: userId }) });
  } catch (err) {
    console.error('account storage', err);
    // Signed out meanwhile, or the subscription just ended (the reload lands
    // on the subscription page).
    if (!account.signedIn || inactive(err)) return location.reload();
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
 * Holly Computer link opened for this sign-in (or `hold`) waits for the next one. */
async function signOut(db, { hold = adopted } = {}) {
  await db?.close({ forget: true });
  saveConnection(null);
  if (hold) holdConnection(hold);
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
  if (computerAccountStep(app, conn)) return;
  mount(app);
}

/**
 * Signed in, a Holly Computer keeps its bots in the account. One that isn't
 * linked yet is offered the link; one linked to another account isn't opened
 * here. True when a screen took over instead of the app.
 */
function computerAccountStep(app, conn) {
  if (!signInWorksHere() || !account.signedIn) return false;
  const link = app.server?.account;
  if (!link) {
    banner('Update Holly Computer to keep its bots in your account', () => window.open('https://github.com/xgamer791/holly-bot#put-your-bots-on-your-computer', '_blank', 'noopener'));
    return false;
  }
  if (link.linked && link.userId === account.userId) return false;
  app.close();
  const name = app.server?.name || conn.name || 'your computer';
  const disconnect = () => {
    saveConnection(null);
    location.reload();
  };
  const switchAccount = () => signOut(null, { hold: savedConnection() || conn });
  if (link.linked) {
    show(html`<${OtherAccountScreen} name=${name} onSignOut=${switchAccount} onDisconnect=${disconnect} />`);
    return true;
  }
  show(html`<${LinkComputerScreen} name=${name} onSignOut=${switchAccount} onDisconnect=${disconnect} onLink=${async () => {
    const { code, hash } = await makeLinkCode();
    await account.authed('mutation', 'devices:createLink', { codeHash: hash });
    await app.rpc('account.link', code);
    await bootRemote(savedConnection() || conn);
  }} />`);
  return true;
}

async function bootLocal(db) {
  let app;
  try {
    app = await App.create({ db });
  } catch (err) {
    console.error('startup', err);
    if (db.cloud && inactive(err)) return location.reload(); // the subscription just ended
    show(html`<${ProblemScreen} message=${db.cloud ? loadError(err) : String(err?.message || err)} onRetry=${() => location.reload()} onSignOut=${db.cloud ? () => signOut(db) : null} />`);
    return;
  }
  window.holly = app;
  if (db.cloud) {
    watchOtherDevices(app, db);
    // A computer linked to the account runs the routines; this app doesn't too.
    app.routinesOnComputer = await linkedComputers();
  }
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
    banner('Changed on another device · Tap to refresh', () => location.reload());
    document.addEventListener('visibilitychange', reloadIfQuiet);
    setInterval(reloadIfQuiet, 5000);
    reloadIfQuiet();
  };
  if (db.stale) db.onStale();
}

/** The names of the computers linked to the account ([] if that can't be told quickly). */
async function linkedComputers() {
  try {
    const list = await Promise.race([account.authed('query', 'devices:list'), new Promise((resolve) => setTimeout(resolve, 4000, []))]);
    return (list || []).map((device) => device.name);
  } catch {
    return [];
  }
}

const SERVICES = { gmail: 'Gmail', outlook: 'Outlook', github: 'GitHub' };

/**
 * Back from Gmail, Outlook or GitHub after Connect in Settings → Plugins: the
 * service sent the person here with ?connect=<claim>, and the connection it
 * approved joins this account only now, as this app claims it
 * (convex/connectors.ts). ?connect_error says why it didn't happen. Either
 * way the address is cleaned up, and the result is shown once the app opens.
 */
async function finishConnecting() {
  const url = new URL(location.href);
  const claim = url.searchParams.get('connect');
  const failed = url.searchParams.get('connect_error');
  if (!claim && !failed) return null;
  const label = SERVICES[url.searchParams.get('service')] || 'That service';
  for (const name of ['connect', 'connect_error', 'service']) url.searchParams.delete(name);
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  const page = 'plugins';
  if (failed === 'cancelled') return { page, text: `${label} wasn't connected.` };
  if (failed === 'permissions') return { page, error: true, text: `${label} wasn't connected: bots need every permission it asked for. Connect again and leave them all ticked.` };
  if (failed) return { page, error: true, text: `Connecting ${label} didn't work. Try again.` };
  try {
    const done = await account.authed('mutation', 'connectors:claim', { claim });
    if (done.error) return { page, error: true, text: done.error };
    return { page, text: `${SERVICES[done.service] || 'It'} is connected: ${done.account}` };
  } catch (err) {
    return { page, error: true, text: typeof err?.data === 'string' ? err.data : "Couldn't finish connecting. Try again." };
  }
}

/** A small notice at the top of the app that does something when tapped.
 * Several stack. */
function banner(text, onClick, tone = '') {
  let box = document.getElementById('banners');
  if (!box) {
    box = document.createElement('div');
    box.id = 'banners';
    box.className = 'banners';
    document.body.append(box);
  }
  const button = document.createElement('button');
  button.className = `stale-banner${tone ? ` ${tone}` : ''}`;
  button.textContent = text;
  button.onclick = onClick;
  box.append(button);
  return button;
}

function mount(app) {
  app.startupNotice = notice;
  notice = null;
  render(null, root);
  document.documentElement.classList.remove('signed-out');
  render(html`<${Root} app=${app} />`, root);
  document.getElementById('boot')?.remove();
  registerServiceWorker();
  if (signInWorksHere() && account.signedIn) {
    if (billing?.pastDue) paymentBanner();
    watchSubscription();
  }
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
