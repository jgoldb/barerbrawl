// Barer Brawl service worker — keeps returning players on the freshly deployed
// build instead of a stale, browser-cached one.
//
// Strategy: NETWORK-FIRST for every same-origin GET. On each load we fetch the
// real file from the network with `cache: 'reload'`, which bypasses the browser's
// HTTP disk cache. So the moment a new version is deployed, the next page load
// picks it up — no more running last visit's `main.js` against this visit's
// `director.js`. We still mirror successful responses into Cache Storage, so once
// the game has loaded it keeps working even if the network drops.
//
// GitHub Pages sends `Cache-Control: max-age=600`, so without this a returning
// player could run up to ~10 minutes of stale code; this closes that window.

const CACHE_NAME = 'barer-brawl-v1';

self.addEventListener('install', () => {
  // Don't wait for every other tab to close before this worker takes over.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from any previous CACHE_NAME so nothing stale can linger.
    const names = await caches.keys();
    await Promise.all(names.map((n) => (n === CACHE_NAME ? null : caches.delete(n))));
    // Control already-open pages immediately (so their next fetch is network-first).
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let cross-origin go straight to the network

  event.respondWith((async () => {
    try {
      // `reload` forces a network fetch that ignores (and refreshes) the HTTP cache.
      const fresh = await fetch(req, { cache: 'reload' });
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      // Offline / network error: fall back to the last copy we cached, if any.
      const cached = await caches.match(req);
      if (cached) return cached;
      throw err;
    }
  })());
});
