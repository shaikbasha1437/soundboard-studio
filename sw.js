/* SoundBoard Studio service worker: network-first, per-file cache, offline fallback. */
const CACHE = 'soundboard-studio-v1';
const ASSETS = ['./', './index.html', './styles.css', './core.js', './presets.js', './synth.js', './app.js', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  // Cache each file on its own so one failed request can't break install.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(ASSETS.map((a) => c.add(new Request(a, { cache: 'reload' })).catch(() => {})))));
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('soundboard-studio-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
// Network-first: always try the fresh file; use the cache only when offline.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res && res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })
    .then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html').then((i) => i || caches.match('./')) : undefined))
    .then((r) => r || Response.error())));
});
