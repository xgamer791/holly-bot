import { html, render } from '../vendor/preact.js';
import { App } from './core/app.js';
import { DB } from './core/db.js';
import { Root } from './ui/app.js';
import {
  RemoteApp, addressOf, chooseComputer, computerConnection, computerState, declineComputer, declined, deviceKind, holdConnection, isPaired, markPaired,
  probeComputer, reachComputer, runsHere, sameComputer, savedConnection, saveConnection, takeConnectLink, takeHeldConnection, useConnectionsOf,
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
import { deviceTimeZone } from './core/routines.js';
import { deviceChoice, language, setLanguage, tr } from './ui/i18n.js';

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
// account controls it with no link to open. The first time, the phone asks
// (Connect: watchComputers), and says it's connected, as does the computer's
// own page; after that, the account's devices connect to it by themselves,
// as they open (openComputer) and while they're open. Its Wi-Fi address can't
// sign in (convex/auth.ts); there the pairing token alone protects it.

const root = document.getElementById('app');
/** A Holly Computer link opened just before this sign-in. */
let adopted = null;
/** What to say once the app opens (how connecting a service went). */
let notice = null;
/** The computers linked to the account as the app opened, each with what it
 * was doing ({ id, name, state }: stateOf). */
let computers = [];
/** What to say about the linked computer when the bots run here instead. */
let computerNotice = null;
/** The account's computers, as last listed (convex/devices.ts list). */
let linkedNow = null;
/** Whether each computer answered at its address when this app last tried
 * (addressOf → { ok, at }): a computer can say it's on while its address is
 * dead, and this app keeps away from one that didn't answer until it does. */
const reach = new Map();

async function boot() {
  const link = takeConnectLink() || takeLegacyPairLink();
  if (handOverToSite(link)) return;
  // The language this device last used, until the account says (mount).
  await setLanguage(deviceChoice());
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
  return plan ? tr('Welcome to Holly Bot {plan}.', { plan: plan.name }) : tr('Welcome to Holly Bot.');
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
  const button = banner(tr("Your payment didn't go through · Update it"), async () => {
    button.disabled = true;
    try {
      location.assign(await account.authed('action', 'billing:portal', { returnTo: `${location.origin}${location.pathname}` }));
    } catch (err) {
      console.warn('billing', err);
      button.textContent = tr("Couldn't open billing · Tap to try again");
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
    db = await CloudDB.open({
      userId,
      call: (kind, name, args) => account.authed(kind, name, args, { as: userId }),
      token: (o) => account.tokenOf(userId, o),
    });
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
  linkedNow = linked;
  const mine = saved ? linked?.find((device) => sameComputer(device, saved)) : null;
  // A saved computer that was linked to the account and isn't any more (a
  // subscriber's server replaced by a smaller one) counts as none saved.
  const gone = !!(saved?.device && linked && !mine);
  // The saved computer first, and where the account says it is now if it
  // moved, unless it's the server that comes with a plan and wasn't just
  // chosen. Then the running computers this app connects to by itself: your
  // own that a device connected to before (the first time, the app asks:
  // watchComputers), then the plan's server; none this device was told to
  // leave alone (Not now, Disconnect this device, or moving away from it).
  // A saved computer that isn't linked to the account is the only one tried:
  // its bots may be only there.
  const tries = [];
  const add = (conn) => {
    if (!conn || tries.some((t) => t.url === conn.url && t.token === conn.token)) return;
    // Just chosen: what to say once connected goes with it, at whichever address it answers.
    const chosen = saved?.hello && ((saved.url === conn.url && saved.token === conn.token) || (saved.device && saved.device === conn.device));
    tries.push(chosen ? { ...conn, hello: saved.hello } : conn);
  };
  const others = runsHere() ? [] : preferred(linked || []).filter((device) => !declined(device) && isPaired(device));
  if (saved && !gone && !mine) add(saved);
  else {
    if (saved && !gone && (!mine.server || saved.hello)) {
      add(saved);
      add(computerConnection(mine));
    }
    for (const device of others) add(computerConnection(device));
    if (saved && !gone) {
      add(saved);
      add(computerConnection(mine));
    }
  }
  let problem = null;
  for (const conn of tries) {
    const app = new RemoteApp(conn);
    try {
      await app.connect({ timeoutMs: 8000 });
    } catch (err) {
      problem ||= err;
      const id = conn.device || mine?.id;
      if (id) reach.set(addressOf({ id, url: conn.url }), { ok: false, at: Date.now() });
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
  computerNotice = { list: computers, devices: linked || [] };
  return false;
}

/** What a computer linked to the account is doing, as far as this app can
 * tell: computerState, or 'unreachable' when it says it's running but didn't
 * answer here, and for one running without an address, why: 'starting'
 * (opening its tunnel) or 'blocked' (its network blocks the tunnel). */
function stateOf(device) {
  const state = computerState(device);
  if (state === 'running') return cantReach(device) ? 'unreachable' : state;
  if (state === 'hidden' && ['starting', 'blocked'].includes(device.tunnel)) return device.tunnel;
  return state;
}

/** What each computer linked to the account is doing (stateOf): for the
 * bots (src/core/prompts.js) and the note in the bot list. */
function statesOf(list) {
  return preferred(list || []).map((device) => ({ id: device.id, name: device.name, state: stateOf(device) }));
}

/** Whether `device` didn't answer at its address when this app last tried. */
function cantReach(device) {
  const tried = reach.get(addressOf(device));
  return !!tried && !tried.ok;
}

/** Whether `device` answers at its address: asked again after a minute,
 * or a quarter of one when it didn't answer (it may have just started). */
async function answers(device) {
  const key = addressOf(device);
  const tried = reach.get(key);
  if (tried && Date.now() - tried.at < (tried.ok ? 60_000 : 15_000)) return tried.ok;
  const ok = await probeComputer(device.url);
  reach.set(key, { ok, at: Date.now() });
  return ok;
}

/** Your own computers first, then the server that comes with a plan. */
function preferred(list) {
  return [...list].sort((a, b) => Number(!!a.server) - Number(!!b.server));
}

/**
 * Connects this app to a linked computer, once it's clear it answers: the
 * app opens again as its remote control and says so, and so does the
 * computer (`how`: 'first' after Connect, 'auto' when this app did it by
 * itself: controlComputer). `from`: the computer the person chose to leave
 * for it (chooseComputer). Fails with a message to show when it doesn't answer.
 */
async function connectTo(device, how = 'first', from = null) {
  const conn = await reachComputer(device, { latest: async () => (await linkedComputers())?.find((d) => d.id === device.id) });
  if (how === 'auto') saveConnection({ ...conn, hello: how });
  else chooseComputer(conn, { from, hello: how });
  location.reload();
}

/** The note in the bot list for a computer that's on, which this app isn't using. */
function connectNotice(app, device) {
  return {
    key: `${addressOf(device)}:on`,
    offer: device.id,
    text: tr('{name} is on. Connect so your bots can use it.', { name: device.name }),
    action: { label: tr('Connect'), onClick: () => connecting(app, device) },
  };
}

/** Connect, tapped: says it's connecting, and why not when it can't. */
function connecting(app, device) {
  app.emit('toast', { text: tr('Connecting to {name}…', { name: device.name }) });
  const here = app.remote ? linkedNow?.find((d) => sameComputer(d, whereIs(app))) : null;
  connectTo(device, 'first', here).catch((err) => {
    reach.set(addressOf(device), { ok: false, at: Date.now() });
    app.emit('toast', { text: err.message, error: true });
  });
}

/** Changes the note in the bot list (src/ui/home.js), when there's something new to say. */
function showNotice(app, next) {
  if ((app.computerNotice?.text || null) === (next?.text || null)) return;
  app.computerNotice = next;
  app.emit('computers');
}

/** Where the computer `app` controls is, to find it among the account's. */
function whereIs(app) {
  return { device: app.device, name: app.server?.name, url: app.base };
}

/** Whether this page is open on the computer itself (not a phone that
 * opened its Wi-Fi link, which Holly Computer serves too). */
const onThisComputer = () => location.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

/** Whether this is Holly Computer's own page, on the computer it controls. */
function ownPage(app) {
  try {
    return !!app.remote && onThisComputer() && new URL(app.base).origin === location.origin;
  } catch {
    return false;
  }
}

/** Whether Holly Computer serves this page on the computer itself, even
 * when the bots run in the page for a moment: it answers /v1/health here.
 * The site doesn't, and nor does a development server. */
async function servedByComputer() {
  if (!onThisComputer()) return false;
  try {
    const res = await fetch(new URL('v1/health', location.origin), { cache: 'no-store' });
    return res.ok && (await res.json())?.app === 'holly-computer';
  } catch {
    return false;
  }
}

/**
 * While the app is open, the account's computers come and go: one starts, or
 * someone signs in on it for the first time. Every ten seconds while the app
 * is in front, and as it comes back, this asks the account which are running
 * and, once one answers at its address, connects to it: by itself when a
 * device connected to it before (or it's the server that comes with a plan
 * and this app runs the bots itself), as soon as nothing's going on here; the
 * first time, by asking (Connect, src/ui/app.js), which is said on the
 * computer too. Not now leaves a note in the bot list instead. When the
 * computer this app uses has stopped, it moves onto another it connects to
 * by itself. It keeps the note, and what the bots here are told about the
 * computer (src/core/prompts.js), up to date too. On Holly Computer's own page
 * there's nothing to connect to: it says to tap Connect on the phone, until
 * a phone has.
 */
async function watchComputers(app) {
  const own = ownPage(app) || await servedByComputer();
  let checking = false;
  let asking = false;
  let moving = false;
  let lastInput = Date.now();
  for (const type of ['pointerdown', 'keydown', 'input']) {
    addEventListener(type, () => { lastInput = Date.now(); }, { capture: true, passive: true });
  }
  // Moving to another computer reloads the app: not while something's going on.
  const idle = () => !busyHere(app) && Date.now() - lastInput > 5000;
  const move = async (device) => {
    moving = true;
    try {
      await connectTo(device, 'auto');
    } catch {
      reach.set(addressOf(device), { ok: false, at: Date.now() });
      moving = false;
    }
  };
  // A phone connected to this computer (its own page): no need to say to any more.
  app.on('hello', () => {
    if (!own) return;
    const here = linkedNow?.find((device) => sameComputer(device, whereIs(app)));
    if (here) markPaired(here);
    showNotice(app, null);
  });
  const check = async () => {
    if (checking || asking || moving || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      const list = await linkedComputers();
      if (!list) return;
      linkedNow = list;
      const here = app.remote ? list.find((device) => sameComputer(device, whereIs(app))) : null;
      if (own) {
        showNotice(app, here && !here.server && !isPaired(here) && app.server?.account?.linked ? waitingNotice(here) : null);
        return;
      }
      if (app.remote) {
        // An offer left in the list goes once that computer is off again.
        const left = app.computerNotice?.offer;
        if (left && !computerConnection(list.find((device) => device.id === left))) showNotice(app, null);
      } else {
        app.linkedComputers = statesOf(list);
        // Nothing to say while the plan's server is on its way: the app moves onto it by itself.
        showNotice(app, app.awaitingServer ? null : noticeAbout(app, app.linkedComputers, list));
      }
      // The computer this app uses hasn't answered for a while (it stopped, or
      // its connection did): another it connects to by itself, if one answers.
      if (here && !app.reachable && Date.now() - (app.unreachableSince || Date.now()) > 120_000) {
        const next = runsHere() ? null : preferred(list).find((device) => device !== here && isPaired(device) && computerConnection(device) && !declined(device));
        if (next && idle() && await answers(next)) {
          await move(next);
          return;
        }
      }
      // A server just set up isn't offered: the app moves onto it by itself (watchServerSetup).
      const offer = preferred(list).find((device) => device !== here && (!device.server || (!app.remote && !app.awaitingServer))
        && computerConnection(device) && !declined(device));
      if (!offer) {
        if (app.remote && app.computerNotice?.unreachable) showNotice(app, null);
        return;
      }
      if (!(await answers(offer))) {
        // On, but its address doesn't answer (yet): a word, and a new try in a minute.
        if (app.remote && !app.computerNotice?.offer) showNotice(app, unreachableNotice(offer));
        else if (!app.remote) showNotice(app, noticeAbout(app, app.linkedComputers = statesOf(list), list));
        return;
      }
      if (app.computerNotice?.unreachable) showNotice(app, null);
      // Connected to before: by itself, unless this app is on another of your
      // own computers, or runs the bots itself because it was told to.
      const onServer = !!here?.server;
      if (isPaired(offer) && (!app.remote || onServer) && !runsHere()) {
        if (idle()) await move(offer);
        return;
      }
      if (!app.events.map.get('computer-offer')?.size) return;
      asking = true;
      app.emit('computer-offer', {
        name: offer.name,
        accept: () => connectTo(offer, 'first', here).catch((err) => {
          asking = false;
          reach.set(addressOf(offer), { ok: false, at: Date.now() });
          throw err;
        }),
        decline: () => {
          declineComputer(offer);
          asking = false;
          if (!app.computerNotice) showNotice(app, connectNotice(app, offer));
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

/** The note on Holly Computer's own page until a phone has connected to it. */
function waitingNotice(device) {
  return { key: `${device.id}:waiting`, text: tr('Open Holly Bot on your phone and tap Connect to use {name} from it.', { name: device.name }) };
}

/** The note for a computer that says it's on, whose address doesn't answer here. */
function unreachableNotice(device) {
  return { key: `${addressOf(device)}:unreachable`, unreachable: true, text: tr("{name} is on, but this app can't reach it yet. It keeps trying.", { name: device.name }) };
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
        banner(tr('New version of Holly Bot · Tap to update'), () => location.reload());
      }
    } catch { /* offline: next time */ } finally {
      checking = false;
    }
  };
  document.addEventListener('visibilitychange', check);
  setInterval(check, 30 * 60_000);
}

/** How to set up, update or start Holly Computer (the README). */
const howToComputer = () => ({ label: tr('How'), onClick: () => window.open('https://github.com/xgamer791/holly-bot#put-your-bots-on-your-computer', '_blank', 'noopener') });

/** A word for the bots running here although the account has a computer,
 * when there's something to do about it (a computer that's off needs none),
 * shown at the top of the bot list (src/ui/home.js). `key` names a notice
 * that, once put away, stays away; a computer out of reach can come back. */
function noticeAbout(app, list, devices) {
  const find = (state) => list.find((c) => c.state === state);
  let pc = find('unreachable');
  if (pc) return { unreachable: true, text: tr("Can't reach {name}, so your bots run in this app for now.", { name: pc.name }), action: { label: tr('Retry'), onClick: () => location.reload() } };
  pc = find('running');
  const device = pc && devices.find((d) => d.id === pc.id);
  if (device) return connectNotice(app, device);
  pc = find('starting');
  if (pc) return { text: tr('{name} is on and opening its connection. Your bots can use it in a moment.', { name: pc.name }) };
  pc = find('blocked');
  if (pc) return { key: `${pc.id}:blocked`, text: tr("{name} is on, but its network blocks the secure tunnel Holly Computer uses (Cloudflare, port 7844), so this app can't reach it.", { name: pc.name }), action: howToComputer() };
  pc = find('old');
  if (pc) return { key: `${pc.id}:old`, text: tr('Update Holly Computer on {name} so your bots can use it.', { name: pc.name }), action: howToComputer() };
  pc = find('hidden');
  if (pc) return { key: `${pc.id}:hidden`, text: tr('Start Holly Computer on {name} with --tunnel so your bots can use it.', { name: pc.name }), action: howToComputer() };
  return null;
}

/** Runs this app as the remote control of Holly Computer (`app`, connected
 * at `conn`). A computer linked to the account is followed to its new
 * address when it restarts. */
function controlComputer(app, conn) {
  window.holly = app;
  const { hello, ...keep } = conn;
  saveConnection({ ...keep, name: app.server?.name || conn.name || '' });
  if (computerAccountStep(app, conn)) return;
  if (signInWorksHere() && account.signedIn && app.server?.account?.linked) app.relocate = () => newAddress(app);
  app.ownPage = ownPage(app);
  if (!app.ownPage && signInWorksHere() && account.signedIn) connected(app, hello);
  mount(app);
}

/**
 * This app has connected to a linked computer (not from the computer's own
 * page): from now on the account's devices connect to it by themselves
 * (convex/devices.ts pair). Just after Connect, or after connecting by itself
 * while the app was open (`how`: 'first' or 'auto'), it says so here, and
 * the computer says so on its own page and in its window.
 */
function connected(app, how) {
  const device = app.device ? linkedNow?.find((d) => d.id === app.device) : null;
  if (app.device && !device?.server) {
    if (!device?.paired) account.authed('mutation', 'devices:pair', { id: app.device }).catch((err) => console.warn('pair', err));
    markPaired(device || { id: app.device });
  }
  if (!how) return;
  const name = app.server?.name || tr('your computer');
  notice ||= { text: how === 'first' ? tr('Connected to {name}. Your bots run there now.', { name }) : tr('Connected to {name}.', { name }) };
  app.rpc('devices.hello', { kind: deviceKind(), first: how === 'first' }).catch(() => {});
}

/** Where the account says the computer `app` controls is now, when that
 * changed (it restarted: a quick tunnel's address changes each time), saved
 * for next time. Null when it didn't. */
async function newAddress(app) {
  const conn = computerConnection((await linkedComputers())?.find((device) => sameComputer(device, whereIs(app))));
  if (!conn || (conn.url === app.base && conn.token === app.token)) return null;
  saveConnection(conn);
  return conn;
}

function loadError(err) {
  if (/could not find public function/i.test(err?.message || '')) return tr("Holly Bot's server is being updated. Try again in a minute.");
  const message = friendlyError(err);
  return message === tr('Something went wrong signing in. Please try again.') ? tr("Holly Bot's server had a problem loading your account. Please try again.") : message;
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
      <h2>${tr("Holly Bot can't start")}</h2><p>${tr('This browser blocked local storage (IndexedDB), which Holly Bot needs here. Private browsing modes often do this — open the page in a normal window.')}</p><p style="color:#888">${String(err?.message || err).replace(/</g, '&lt;')}</p></div>`;
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
    app.computerNotice = { key: `${app.server?.name || conn.name || conn.url}:no-account`, text: tr('Update Holly Computer to keep its bots in your account.'), action: howToComputer() };
    return false;
  }
  if (link.linked && link.userId === account.userId) return false;
  app.close();
  const name = app.server?.name || conn.name || tr('your computer');
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
    app.computerNotice = computerNotice && noticeAbout(app, computerNotice.list, computerNotice.devices);
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
    banner(tr('Changed on another device · Tap to refresh'), () => location.reload());
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
  const label = SERVICES[url.searchParams.get('service')] || tr('That service');
  for (const name of ['connect', 'connect_error', 'service']) url.searchParams.delete(name);
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  const page = 'plugins';
  if (failed === 'cancelled') return { page, text: tr("{service} wasn't connected.", { service: label }) };
  if (failed === 'permissions') return { page, error: true, text: tr("{service} wasn't connected: bots need every permission it asked for. Connect again and leave them all ticked.", { service: label }) };
  if (failed) return { page, error: true, text: tr("Connecting {service} didn't work. Try again.", { service: label }) };
  try {
    const done = await account.authed('mutation', 'connectors:claim', { claim });
    if (done.error) return { page, error: true, text: tr(done.error) };
    return { page, text: SERVICES[done.service] ? tr('{service} is connected: {account}', { service: SERVICES[done.service], account: done.account }) : tr('It is connected: {account}', { account: done.account }) };
  } catch (err) {
    return { page, error: true, text: typeof err?.data === 'string' ? tr(err.data) : tr("Couldn't finish connecting. Try again.") };
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

/** Opens the app on `app`, in the account's language: first the Chief
 * Coordinator's page when the account doesn't have one yet (wantsChief). */
async function mount(app, { chiefDone = false } = {}) {
  await setLanguage(app.settings?.language || 'system');
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
  keepDeviceSettings(app);
  if (signInWorksHere() && account.signedIn) {
    if (billing?.pastDue) paymentBanner();
    watchSubscription();
    watchComputers(app).catch((err) => console.warn('computers', err));
    watchServerSetup(app);
  }
  if (signInWorksHere()) watchUpdates();
}

/** What bots need to know of this device, kept in the settings as the app
 * opens (only when it changed, while what the app holds of the settings is
 * fresh). The time zone is found, not set: the one this device is in. Bots
 * running here use it as it is, and bots on a computer go by it
 * (src/core/app.js timeZone()), whose own clock may be set to another zone,
 * as a server's often is. And the language the app is shown in, which bots
 * write in (settings.uiLanguage, src/core/prompts.js). */
function keepDeviceSettings(app) {
  const patch = {};
  const tz = deviceTimeZone();
  if (tz && app.settings?.timeZone !== tz) patch.timeZone = tz;
  if (app.settings?.uiLanguage !== language()) patch.uiLanguage = language();
  if (!Object.keys(patch).length) return;
  Promise.resolve(app.saveSettings(patch)).catch((err) => console.warn('settings', err));
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
 * If it fails, the button goes gray.
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
        if (!['ready', 'resizing'].includes(status.server?.status)) return stop(); // it failed
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
