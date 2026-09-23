import { html, render } from '../vendor/preact.js';
import { App } from './core/app.js';
import { Root } from './ui/app.js';
import { RemoteApp, savedConnection, saveConnection, takeConnectLink } from './remote/remote-app.js';
import { ConnectProblem } from './ui/connect.js';

// Boot. Two ways to run:
//  • Your computer (recommended): bots live on Holly Computer and this app is the remote control.
//  • This browser: bots live here (IndexedDB) and call your AI provider directly.

const root = document.getElementById('app');

async function boot() {
  const link = takeConnectLink() || takeLegacyPairLink();
  if (link) saveConnection(link);
  const conn = savedConnection();
  if (conn) return bootRemote(conn);
  return bootLocal();
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
