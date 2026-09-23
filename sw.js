// Holly Bot service worker: offline app shell (stale-while-revalidate for this
// site's own files) and notification clicks. API calls to AI providers are
// never cached.

const CACHE = 'holly-v1';
const SHELL = ['./', './index.html', './styles.css', './manifest.webmanifest', './vendor/preact.js', './vendor/markdown.js', './src/main.js', './icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
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
  if (url.pathname.endsWith('/computer/holly-computer.mjs')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    const res = await network;
    if (res) return res;
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
