import { html, render } from '../vendor/preact.js';
import { App } from './core/app.js';
import { Root } from './ui/app.js';
import { RemoteApp, savedConnection, saveConnection, takeConnectLink } from './remote/remote-app.js';
import { ConnectProblem } from './ui/connect.js';
import { WelcomeFlow, screenFromHash } from './ui/welcome.js';
import { account, signInWorksHere, SITE } from './account/account.js';

// Boot. First your Holly Bot account: signed out, you get the welcome screens
// (Sign in with Apple or Google). Then two ways to run:
//  • Your computer (recommended): bots live on Holly Computer and this app is the remote control.
//  • This browser: bots live here (IndexedDB) and call your AI provider directly.

const root = document.getElementById('app');

async function boot() {
  const link = takeConnectLink() || takeLegacyPairLink();
  if (link) saveConnection(link);
  if (handOverToSite()) return;
  if (signInWorksHere()) {
    const unfinished = await account.finishSignIn();
    if (!account.signedIn) await welcome(unfinished?.from, unfinished?.error);
    // Signing in or out in another tab, or a session that ran out, reloads into the right screen.
    const signedIn = account.signedIn;
    account.on(() => account.signedIn !== signedIn && location.reload());
    if (signedIn) account.refreshUser().catch((err) => console.warn('account', err));
  }
  const conn = savedConnection();
  if (conn) return bootRemote(conn);
  return bootLocal();
}

/** A Holly Computer tunnel (or --public-url) address serves the build that
 * Holly Computer was started with, and Google and Apple can't send anyone back
 * to it. So it hands over to the Holly Bot site: always the current build,
 * with sign-in, connected to the same computer. The pairing token rides in
 * the #fragment, which browsers never send to GitHub. */
function handOverToSite() {
  if (location.protocol !== 'https:' || signInWorksHere()) return false;
  const conn = savedConnection();
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
 * comes back through boot(). Resolves only if the person carries on without an
 * account, which is offered while sign-in can't work (not set up, or offline). */
function welcome(start, notice) {
  const screen = start || screenFromHash();
  history.replaceState(null, '', `${location.pathname}${location.search}#/${screen}`);
  document.documentElement.classList.add('signed-out');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#ffffff');
  registerServiceWorker();
  return new Promise((resolve) => {
    const off = account.on(() => account.signedIn && location.reload());
    const skip = () => {
      off();
      render(null, root);
      document.documentElement.classList.remove('signed-out');
      history.replaceState(null, '', `${location.pathname}${location.search}#/`);
      resolve();
    };
    render(html`<${WelcomeFlow} start=${screen} notice=${notice} onSkip=${skip} />`, root);
    document.getElementById('boot')?.remove();
  });
}

async function bootRemote(conn) {
  const app = new RemoteApp(conn);
  try {
    await app.connect();
  } catch (err) {
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

async function bootLocal() {
  let app;
  try {
    app = await App.create();
  } catch (err) {
    root.innerHTML = `<div style="padding:40px 24px;color:#ddd;font:16px -apple-system,system-ui,sans-serif;line-height:1.5">
      <h2>Holly Bot can't start</h2><p>This browser blocked local storage (IndexedDB), which Holly Bot needs to keep your bots and keys on your device.
      Private browsing modes often do this — open the page in a normal window.</p><p style="color:#888">${String(err?.message || err).replace(/</g, '&lt;')}</p></div>`;
    return;
  }
  window.holly = app;
  mount(app);
  app.start().catch((err) => console.warn('startup services', err));
}

function mount(app) {
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
