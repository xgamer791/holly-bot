import { html, render } from '../vendor/preact.js';
import { App } from './core/app.js';
import { DB } from './core/db.js';
import { Root } from './ui/app.js';
import {
  RemoteApp, addressOf, computerConnection, computerState, declineComputer, declined, holdConnection, runsHere, sameComputer,
  savedConnection, saveConnection, takeConnectLink, takeHeldConnection, useConnectionsOf,
} from './remote/remote-app.js';
import { ConnectProblem } from './ui/connect.js';
import {
  DeviceDataScreen, LinkComputerScreen, OtherAccountScreen, ProblemScreen, WelcomeFlow, screenFromHash,
} from './ui/welcome.js';
import { SubscribeScreen } from './ui/subscribe.js';
import { ChiefScreen } from './ui/chief.js';
import { chiefOf } from './core/chief.js';
import {
  account, friendlyError, signInWorksHere, SITE,
} from './account/account.js';
import { CloudDB, inactive } from './account/cloud-db.js';
import { makeLinkCode } from './account/device-link.js';
import { deviceData, forgetDeviceData, moveDeviceDataInto } from './account/device-data.js';
import { APP_VERSION } from './core/constants.js';

// Boot. Holly Bot needs an account (Sign in with Apple or Google) with an
// active subscription: until it has one, the subscription page stands in for
// the app (src/ui/subscribe.js). What it keeps lives in that account on Holly
// Bot's server (src/account/cloud-db.js), never in the browser where the next
// person to sign in could see it. Then two ways to run:
//  • Your computer (recommended): bots live on Holly Computer and this app is the remote control.
//  • This app: bots run here, call your AI provider directly and keep everything in your account.
// Holly Computer linked to the account keeps its bots there too, and runs
// them (computer/src/home.mjs). Signing in on its own page links it. It tells
// the account where it can be reached, so every device signed in to the
// account controls it with no link to open: the app connects as it opens
// (openComputer), or asks to while it's open (watchComputers). Its Wi-Fi
// address can't sign in (convex/auth.ts); there the pairing token alone
// protects it.

const root = document.getElementById('app');
/** A Holly Computer link opened just before this sign-in. */
let adopted = null;
/** What to say once the app opens (how connecting a service went). */
let notice = null;
/** The computers linked to the account as the app opened, each with what it
 * was doing ({ id, name, state }: computerState, or 'unreachable'). */
let computers = [];
/** What to say about the linked computer when the bots run here instead. */
let computerNotice = null;
/** Computers this app tried and couldn't reach as it opened (addressOf). */
const unreachable = new Set();

async function boot() {
  const link = takeConnectLink() || takeLegacyPairLink();
  if (handOverToSite(link)) return;
  if (!signInWorksHere()) return bootWithoutAccount(link);
  if (link) holdConnection(link); // for whoever signs in
  const unfinished = await account.finishSignIn();
  if (!account.signedIn) return welcome(unfinished?.from, unfinished?.error);
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

/** Past the subscription page and the computer's setup: finishes connecting
 * a service if that's what brought the person back, then opens the account,
 * as the remote control of the subscriber's computer (openComputer: it's a
 * Holly Computer linked to the account, like any other). */
async function openApp() {
  whitePages(false);
  if (/^#\/(subscribe|setup|chief)\b/.test(location.hash)) history.replaceState(null, '', `${location.pathname}${location.search}#/`);
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
 * (convex/billing.ts). Anyone without one gets the subscription page instead;
 * the address can't get around it, since the app and its routes open only
 * from here. A new subscriber's computer takes a few minutes to set up
 * (convex/servers.ts), and the app doesn't wait for it: it opens with the bots
 * running here and the computer button pulsing blue, and moves onto the
 * computer once it's ready (watchServerSetup). Back from Stripe (Checkout or
 * the billing portal), or when a paid period should have ended, Stripe is
 * asked first, so a subscription just paid for opens the app straight away.
 * True when the app may open; otherwise a page has taken over.
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
  return true;
}

function showSubscribe(status, back) {
  whitePages(true);
  history.replaceState(null, '', `${location.pathname}${location.search}#/subscribe`);
  show(html`<${SubscribeScreen} status=${status} back=${back}
    onActive=${(next) => {
      billing = next;
      notice = { text: welcomeText(next) };
      openApp();
    }}
    onSignOut=${() => signOut()} />`);
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
 * While the app is open, its subscription can change. It's checked each time
 * the app comes back to the front and every ten minutes: once it has ended,
 * the app reloads, which lands on the subscription page (changes not yet
 * saved wait on the device); a renewal that didn't go through shows a banner
 * asking for a new card; and when the computer it controls was replaced (a
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
      // The computer this app controls was replaced (a smaller one after a
      // downgrade) or unlinked: start again, which finds the one linked now.
      const app = window.holly;
      if (app?.remote && app.device && !(await linkedComputers())?.some((device) => device.id === app.device)) location.reload();
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
 * accounts, then the bots, wherever they run. */
async function startAccount() {
  const found = await deviceData().catch((err) => {
    console.warn('device data', err);
    return null;
  });
  if (!found && await openComputer()) return;
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
  if (!found) return bootLocal(db);
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

/** After the question about this device's data from before accounts: the
 * computer this device controls, or the bots here. */
async function runAccount(db) {
  if (!(await openComputer())) return bootLocal(db);
  db.close();
}

/**
 * Opens this app as the remote control of the Holly Computer this device
 * uses: the one it saved (from a link Holly Computer showed, or Settings →
 * Bot Computer), or else one linked to the account, where it told the
 * account it can be reached (computer/src/home.mjs). So every device signed
 * in to the account uses the linked computer, even one that never opened its
 * link (on iPhone, the Home Screen app keeps its own storage apart from
 * Safari's), and finds it at its new address after it restarts. True when the
 * app opened as its remote control or a screen took over; false to run the
 * bots here, with a word about the linked computer when there is one to say.
 */
async function openComputer() {
  const saved = savedConnection();
  const linked = await linkedComputers(); // null: couldn't tell
  const mine = saved ? linked?.find((device) => sameComputer(device, saved)) : null;
  // A saved computer that was linked to the account and isn't any more (a
  // subscriber's server replaced by a smaller one) counts as none saved.
  const gone = !!(saved?.device && linked && !mine);
  // The saved computer first, and where the account says it is now if it
  // moved. Then, with none saved, or when the saved one is linked to the
  // account but can't be reached, any running, your own computer before the
  // server that comes with a plan, and none this device was told to leave
  // alone (Not now, Disconnect this device). A saved computer that isn't
  // linked to the account is the only one tried: its bots may be only there.
  const tries = [];
  const add = (conn) => {
    if (conn && !tries.some((t) => t.url === conn.url && t.token === conn.token)) tries.push(conn);
  };
  if (saved && !gone) add(saved);
  const others = runsHere() ? [] : preferred(linked || []).filter((device) => !declined(device));
  for (const device of saved && !gone ? [mine, ...(mine ? others : [])] : others) add(computerConnection(device));
  let problem = null;
  for (const conn of tries) {
    const app = new RemoteApp(conn);
    try {
      await app.connect({ timeoutMs: 8000 });
    } catch (err) {
      problem ||= err;
      unreachable.add(addressOf(conn.device ? { id: conn.device, url: conn.url } : mine && { id: mine.id, url: conn.url }));
      continue;
    }
    controlComputer(app, conn);
    return true;
  }
  if (saved && !mine) {
    if (!linked || !saved.device) {
      // Not a computer linked to the account (or the account couldn't say):
      // its bots may be only there.
      showConnectProblem(saved, problem?.message || '');
      return true;
    }
    saveConnection(null); // found through the account, and unlinked since
  }
  computers = statesOf(linked);
  computerNotice = noticeAbout(computers, linked || []);
  return false;
}

/** What each computer linked to the account is doing (computerState), or
 * 'unreachable' when it says it's running but this app couldn't reach it
 * there: for the bots (src/core/prompts.js) and the note in the bot list. */
function statesOf(list) {
  return preferred(list || []).map((device) => {
    const state = computerState(device);
    return { id: device.id, name: device.name, state: state === 'running' && unreachable.has(addressOf(device)) ? 'unreachable' : state };
  });
}

/** Your own computers first, then the server that comes with a plan. */
function preferred(list) {
  return [...list].sort((a, b) => Number(!!a.server) - Number(!!b.server));
}

/** Connects this app to a linked computer: it opens again as its remote control. */
function connectTo(device) {
  const conn = computerConnection(device);
  if (!conn) return;
  saveConnection(conn);
  location.reload();
}

/** The note in the bot list for a computer that's on, which this app isn't using. */
function connectNotice(device) {
  return { key: `${addressOf(device)}:on`, offer: device.id, text: `${device.name} is on. Connect so your bots can use it.`, action: { label: 'Connect', onClick: () => connectTo(device) } };
}

/** Changes the note in the bot list (src/ui/home.js), when there's something new to say. */
function showNotice(app, next) {
  if ((app.computerNotice?.text || null) === (next?.text || null)) return;
  app.computerNotice = next;
  app.emit('computers');
}

/**
 * While the app is open, the account's computers come and go: one starts, or
 * someone signs in on it for the first time. Every ten seconds while the app
 * is in front, and as it comes back, this asks the account which are running
 * and offers to connect to one this app isn't using (src/ui/app.js asks): your
 * own computer whenever it comes on, and the server that comes with a plan
 * when this app runs the bots itself. Not now leaves a note in the bot list
 * instead. It keeps that note, and what the bots here are told about the
 * computer (src/core/prompts.js), up to date too.
 */
function watchComputers(app) {
  let checking = false;
  let asking = false;
  const check = async () => {
    if (checking || asking || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      const list = await linkedComputers();
      if (!list) return;
      const here = app.remote ? list.find((device) => sameComputer(device, { device: app.device, name: app.server?.name, url: app.base })) : null;
      if (app.remote) {
        // An offer left in the list goes once that computer is off again.
        const left = app.computerNotice?.offer;
        if (left && !computerConnection(list.find((device) => device.id === left))) showNotice(app, null);
      } else {
        app.linkedComputers = statesOf(list);
        // Nothing to say while the plan's server is on its way: the app moves onto it by itself.
        showNotice(app, app.awaitingServer ? null : noticeAbout(app.linkedComputers, list));
      }
      // A server just set up isn't offered: the app moves onto it by itself (watchServerSetup).
      const offer = preferred(list).find((device) => device !== here && (!device.server || (!app.remote && !app.awaitingServer))
        && computerConnection(device) && !declined(device) && !unreachable.has(addressOf(device)));
      if (!offer || !app.events.map.get('computer-offer')?.size) return;
      asking = true;
      app.emit('computer-offer', {
        name: offer.name,
        accept: () => connectTo(offer),
        decline: () => {
          declineComputer(offer);
          asking = false;
          if (!app.computerNotice) showNotice(app, connectNotice(offer));
        },
        later: () => {
          asking = false;
        },
      });
    } finally {
      checking = false;
    }
  };
  document.addEventListener('visibilitychange', check);
  setInterval(check, 10_000);
  check();
}

/** Whether version `a` is newer than `b` (both x.y.z). */
function newerVersion(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * The app runs the latest build each time it opens, but iPhone keeps a Home
 * Screen app running in the background, so a phone can go on running an old
 * one for days. As the app comes back to the front, and every half hour, this
 * asks the site which version it serves, and when that's newer, a banner
 * offers it. It never reloads by itself: leaving the app and coming back
 * shouldn't land on the loading screen.
 */
function watchUpdates() {
  let checking = false;
  let offered = false;
  const check = async () => {
    if (offered || checking || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      const res = await fetch(new URL('./src/core/constants.js', location.href), { cache: 'no-cache' });
      const latest = /APP_VERSION = '(\d+\.\d+\.\d+)'/.exec(res.ok ? await res.text() : '')?.[1];
      if (latest && newerVersion(latest, APP_VERSION)) {
        offered = true;
        banner('New version of Holly Bot · Tap to update', () => location.reload());
      }
    } catch { /* offline: next time */ } finally {
      checking = false;
    }
  };
  document.addEventListener('visibilitychange', check);
  setInterval(check, 30 * 60_000);
}

/** How to set up, update or start Holly Computer (the README). */
const howToComputer = { label: 'How', onClick: () => window.open('https://github.com/xgamer791/holly-bot#put-your-bots-on-your-computer', '_blank', 'noopener') };

/** A word for the bots running here although the account has a computer,
 * when there's something to do about it (a computer that's off needs none),
 * shown at the top of the bot list (src/ui/home.js). `key` names a notice
 * that, once put away, stays away; a computer out of reach can come back. */
function noticeAbout(list, devices) {
  const find = (state) => list.find((c) => c.state === state);
  let pc = find('unreachable');
  if (pc) return { text: `Can't reach ${pc.name}, so your bots run in this app for now.`, action: { label: 'Retry', onClick: () => location.reload() } };
  pc = find('running');
  const device = pc && devices.find((d) => d.id === pc.id);
  if (device) return connectNotice(device);
  pc = find('old');
  if (pc) return { key: `${pc.id}:old`, text: `Update Holly Computer on ${pc.name} so your bots can use it.`, action: howToComputer };
  pc = find('hidden');
  if (pc) return { key: `${pc.id}:hidden`, text: `Start Holly Computer on ${pc.name} with --tunnel so your bots can use it.`, action: howToComputer };
  return null;
}

/** Runs this app as the remote control of Holly Computer (`app`, connected
 * at `conn`). A computer linked to the account is followed to its new
 * address when it restarts. */
function controlComputer(app, conn) {
  window.holly = app;
  saveConnection({ ...conn, name: app.server?.name || conn.name || '' });
  if (computerAccountStep(app, conn)) return;
  if (signInWorksHere() && account.signedIn && app.server?.account?.linked) app.relocate = () => newAddress(app);
  mount(app);
}

/** Where the account says the computer `app` controls is now, when that
 * changed (it restarted: a quick tunnel's address changes each time), saved
 * for next time. Null when it didn't. */
async function newAddress(app) {
  const here = { device: app.device, name: app.server?.name, url: app.base };
  const conn = computerConnection((await linkedComputers())?.find((device) => sameComputer(device, here)));
  if (!conn || (conn.url === app.base && conn.token === app.token)) return null;
  saveConnection(conn);
  return conn;
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
    showConnectProblem(conn, err.message);
    return;
  }
  controlComputer(app, conn);
}

/** The Holly Computer this device controls can't be reached. */
function showConnectProblem(conn, error) {
  render(null, root);
  document.documentElement.classList.remove('signed-out');
  render(html`<${ConnectProblem} conn=${conn} error=${error} onRetry=${async () => {
    render(null, root);
    await bootRemote(savedConnection() || conn);
  }} />`, root);
  document.getElementById('boot')?.remove();
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
    app.computerNotice = { key: `${app.server?.name || conn.name || conn.url}:no-account`, text: 'Update Holly Computer to keep its bots in your account.', action: howToComputer };
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
  // Signed in on the computer's own page, the person is at the computer: it
  // links to their account straight away, and Holly Bot on their phone asks
  // to connect to it (watchComputers). Anywhere else (an old QR link) it asks.
  const atComputer = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && conn.url.replace(/\/+$/, '') === location.origin;
  show(html`<${LinkComputerScreen} name=${name} auto=${atComputer} onSignOut=${switchAccount} onDisconnect=${disconnect} onLink=${async () => {
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
    // A computer linked to the account runs the routines, so this app
    // doesn't, and its bots know the computer is there (src/core/prompts.js).
    app.linkedComputers = computers;
    app.computerNotice = computerNotice;
  }
  mount(app);
  app.start().catch((err) => console.warn('startup services', err));
}

/**
 * Another device changed this account after it loaded here, so what this one
 * shows is out of date. A banner offers to reload now, and it reloads by
 * itself once the app has sat open and untouched for two minutes. Never in
 * the background or as the app comes back to the front (that would land on
 * the loading screen), and never while a bot is replying, changes are waiting
 * to be saved, or something is being typed.
 */
function watchOtherDevices(app, db) {
  db.onStale = () => {
    let lastInput = Date.now();
    for (const type of ['pointerdown', 'keydown', 'input']) {
      addEventListener(type, () => { lastInput = Date.now(); }, { capture: true, passive: true });
    }
    // Coming back to the front counts as a touch.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') lastInput = Date.now();
    });
    const reloadIfQuiet = () => {
      if (document.visibilityState !== 'visible') return;
      if (!busyHere(app) && Date.now() - lastInput > 120_000) location.reload();
    };
    banner('Changed on another device · Tap to refresh', () => location.reload());
    setInterval(reloadIfQuiet, 5000);
  };
  if (db.stale) db.onStale();
}

/** The computers linked to the account, with where each can be reached
 * (convex/devices.ts); null if that can't be told quickly. */
async function linkedComputers() {
  try {
    return await Promise.race([account.authed('query', 'devices:list'), new Promise((resolve) => setTimeout(resolve, 4000, null))]);
  } catch {
    return null;
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

/** Opens the app on `app`: first the Chief Coordinator's page when the account
 * doesn't have one yet (wantsChief). */
function mount(app, { chiefDone = false } = {}) {
  if (!chiefDone && wantsChief(app)) {
    showChief(app);
    return;
  }
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
    watchComputers(app);
    watchServerSetup(app);
  }
  if (signInWorksHere()) watchUpdates();
}

const CHIEF_LATER = 'holly.chiefLater';

/** Whether to show the Chief Coordinator's page (src/ui/chief.js) as the app
 * opens: on the Holly Bot site, signed in, for an account without one, when
 * it has no bots at all (it's the first) or it wasn't put away on this device
 * (Not now). */
function wantsChief(app) {
  if (!signInWorksHere() || !account.signedIn || chiefOf(app)) return false;
  if (!app.listAgents().length) return true;
  try {
    return !localStorage.getItem(CHIEF_LATER);
  } catch {
    return false;
  }
}

function showChief(app) {
  history.replaceState(null, '', `${location.pathname}${location.search}#/chief`);
  document.getElementById('boot')?.remove();
  registerServiceWorker();
  // Straight on to the bot list, the dashboard.
  const open = () => {
    history.replaceState(null, '', `${location.pathname}${location.search}#/`);
    mount(app, { chiefDone: true });
  };
  show(html`<${ChiefScreen} app=${app} canSkip=${app.listAgents().length > 0} onDone=${open}
    onSkip=${() => {
      try {
        localStorage.setItem(CHIEF_LATER, '1');
      } catch { /* storage blocked: it asks again next time */ }
      open();
    }}
    onSignOut=${() => signOut(app.db?.cloud ? app.db : undefined)} />`);
}

/** What billing:status says about a server still being set up. */
const SETTING_UP = ['none', 'provisioning', 'deleting'];

/** Whether the subscription's server is still being set up. */
function settingUp(status) {
  return !!status?.active && !status.exempt && SETTING_UP.includes(status.server?.status || 'none');
}

/**
 * The app opens while a new subscriber's server is still being set up
 * (convex/servers.ts takes a few minutes): the bots run here meanwhile, and
 * the computer button pulses blue (app.awaitingServer,
 * src/ui/computer-button.js). This follows the setup (billing:status every ten
 * seconds while the app is in front) and, once the server is ready, moves onto
 * it as soon as nothing's going on here. Setup that hasn't started after a
 * minute and a half (Stripe's word didn't come) is started (servers:retry).
 * If it fails, the button goes gray, and Settings says why and offers to try
 * again.
 */
function watchServerSetup(app) {
  if (!settingUp(billing)) return;
  const stop = () => {
    clearInterval(timer);
    app.awaitingServer = false;
    app.emit('computer');
  };
  app.awaitingServer = true;
  app.emit('computer');
  const since = Date.now();
  let nudged = false;
  let ready = false;
  let checking = false;
  let lastInput = Date.now();
  for (const type of ['pointerdown', 'keydown', 'input']) {
    addEventListener(type, () => { lastInput = Date.now(); }, { capture: true, passive: true });
  }
  const timer = setInterval(async () => {
    if (checking || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      if (!ready) {
        const status = await account.authed('query', 'billing:status');
        billing = status;
        if (settingUp(status)) {
          if (!nudged && (status.server?.status || 'none') === 'none' && Date.now() - since > 90_000) {
            nudged = true;
            await account.authed('mutation', 'servers:retry').catch(() => {});
          }
          return;
        }
        if (!['ready', 'resizing'].includes(status.server?.status)) return stop(); // it failed: Settings says why
        ready = true;
      }
      const list = await linkedComputers();
      if (!list) return;
      // On a computer that's still linked (your own): the bots stay there. One
      // that's gone (the server this one replaced) is left for the new one.
      if (app.remote && (!app.device || list.some((d) => d.id === app.device))) return stop();
      const device = list.find((d) => d.server && computerConnection(d));
      if (!device || busyHere(app) || Date.now() - lastInput < 5000) return;
      clearInterval(timer);
      connectTo(device);
    } catch { /* offline, or the server is busy: next time */ } finally {
      checking = false;
    }
    return undefined;
  }, 10_000);
}

/** Whether reloading now would cut something short here: a bot replying,
 * something being typed, changes waiting to be saved. */
function busyHere(app) {
  const field = document.activeElement;
  const typing = !!(field?.matches?.('input, textarea') ? field.value?.trim() : field?.isContentEditable && field.textContent.trim())
    || [...(app.drafts?.values() || [])].some((text) => text?.trim());
  return typing || app.runtime.activeRuns().length > 0 || (app.db?.pending?.length || 0) > 0;
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
