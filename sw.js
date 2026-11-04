// Offline support: keeps a copy of the app's files so it opens with no signal.
//
// Each version's files are downloaded together into their own cache when the new
// version installs; if any file fails, the install fails and the old version keeps
// running untouched. Pages are always answered from one version's cache, so old and
// new files never mix. Bump CACHE whenever any app file changes, or phones keep the
// old copy.

const CACHE = 'gig-meter-v5';
const FILES = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/meter.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const saved = await cache.match(request, { ignoreSearch: true });
      if (saved) return saved;
      try {
        return await fetch(request);
      } catch {
        if (request.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
        return Response.error();
      }
    }),
  );
});
