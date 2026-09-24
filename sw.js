// Holly Bot service worker: offline app shell and notification clicks. API
// calls are never cached.
// Network first, so every open runs the current build, from old links and
// installed home-screen apps too. The saved copy is for when the network fails
// or stalls. Requests skip the browser's HTTP cache (GitHub Pages lets it keep
// a file for 10 minutes), so the server always gets asked.

const CACHE = 'holly-v6';
const WAIT_MS = 8000;
// Only the app's own files are cached. Everything else — notably Holly
// Computer's /api and /v1 calls when the app is served by it — goes straight
// to the network.
const APP_FILE = /(\/|\/index\.html|\/(privacy|terms)\.html|\/styles\.css|\/manifest\.webmanifest|\/(src|vendor|icons)\/[^?#]+)$/;
const SHELL = ['./', './index.html', './privacy.html', './terms.html', './styles.css', './manifest.webmanifest', './vendor/preact.js', './vendor/markdown.js', './vendor/convex.js', './src/main.js', './icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
    .catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode !== 'navigate' && !APP_FILE.test(url.pathname)) return;
  if (/\/(api|v1)\//.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Pages are saved without their query, so a sign-in return (?code=…) isn't kept.
    const key = req.mode === 'navigate' ? `${url.origin}${url.pathname}` : req;
    const network = fetch(req, { cache: 'no-cache' }).catch(() => fetch(req)).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(key, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    const fresh = await Promise.race([network, new Promise((resolve) => setTimeout(resolve, WAIT_MS, null))]);
    if (fresh?.ok || fresh?.type === 'opaqueredirect') return fresh;
    const saved = await cache.match(key);
    if (saved) {
      event.waitUntil(network);
      return saved;
    }
    const late = fresh || (await network);
    if (late) return late;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const threadId = event.notification.data?.threadId;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all[0];
    if (client) {
      await client.focus();
      if (threadId) client.postMessage({ type: 'open-thread', threadId });
      return;
    }
    await self.clients.openWindow(`./#/chat/${threadId || ''}`);
  })());
});
