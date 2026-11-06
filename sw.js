// Offline support: keeps a copy of the app's files so it opens with no signal.
//
// Each version's files are downloaded together into their own cache when the new
// version installs; if any file fails, the install fails and the old version keeps
// running untouched. Pages are always answered from one version's cache, so old and
// new files never mix. Bump CACHE whenever any app file changes, or phones keep the
// old copy.
//
// The Fare meter, Pay stub and Poster looks use Google Fonts. Those are saved the
// first time a look is used online, in a separate cache that app updates leave alone,
// so the look keeps its fonts offline afterwards.

const CACHE = 'gig-meter-v21';
const FONT_CACHE = 'gig-meter-fonts';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const FILES = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/meter.js',
  'js/view.js',
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
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== FONT_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function fontResponse(request) {
  const cache = await caches.open(FONT_CACHE);
  const saved = await cache.match(request);
  if (saved) return saved;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(fontResponse(request));
    return;
  }
  if (url.origin !== self.location.origin) return;

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
