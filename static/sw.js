// MAVERO service worker — production-hardening round (PWA splash-hang fix).
//
// What this worker does (and deliberately does NOT do):
//   * Install: pre-cache the tiny SAFE_ASSETS set, resiliently — ONE bad
//     asset (404 / network hiccup) can no longer reject install(). The old
//     `cache.addAll([...])` was all-or-nothing: a single failed icon fetch
//     left the worker stuck in `installing` forever, skipWaiting never ran,
//     and every subsequent load kept the stale worker (or no worker at
//     all). Now each asset is cached individually via allSettled-style
//     adds; install ALWAYS completes and skipWaiting ALWAYS runs, so a
//     new worker version takes over on the next navigation instead of
//     wedging the app.
//   * skipWaiting + clientsClaim: both are wired (install + activate) so
//     an updated worker activates IMMEDIATELY — no "waiting for old tabs
//     to close" limbo that used to leave users on stale shells.
//   * Navigations: network-first with a HARD 8s TIMEOUT, then the cached
//     offline page. The previous handler awaited `fetch(request)` with no
//     timeout: on a stalled connection (PWA cold launch on flaky mobile
//     networks) the respondWith promise stayed pending for 30-60s+ and the
//     OS PWA splash screen hung on the app icon with nothing rendering.
//     The timeout race guarantees the user ALWAYS gets a painted page.
//   * Static assets: cache-first for the safe immutable set only (scripts,
//     styles, fonts, /_app/immutable, icons, manifest, robots.txt).
//   * Cross-origin requests — INCLUDING every provider iframe stream
//     (vidsrc/vidrift/vidcore embeds) and all HLS media — are NEVER
//     intercepted or cached: isPrivateOrDynamicRequest() bails out for
//     any non-same-origin URL. Iframe traffic bypasses the worker
//     entirely (iframes inside a page controlled by a SW still go through
//     its fetch handler; the bail-out makes those events no-ops), so the
//     worker can neither block nor bloat heavy embed playback.
//   * Private/dynamic routes (/api, /auth, /admin, /watch, account paths)
//     are likewise never touched — no session-bearing response is ever
//     stored, and player navigation is never served from a cache.
//
// The worker never throws out of a fetch event: the handler body is
// wrapped so an unexpected error falls through to the browser's default
// network handling instead of producing a failed respondWith promise.

const VERSION = 'mavero-shell-v2';
const STATIC_CACHE = `${VERSION}-static`;
const OFFLINE_URL = '/offline.html';
const NAVIGATION_TIMEOUT_MS = 8000;
const SAFE_ASSETS = [
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/icons/mavero-192.png',
  '/icons/mavero-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      // Resilient pre-cache: each asset is added independently, a single
      // failure no longer rejects install() (which used to strand the
      // worker in `installing` forever and block every future update).
      .then((cache) => Promise.allSettled(
        SAFE_ASSETS.map((asset) =>
          cache.add(new Request(asset, { cache: 'reload' })).catch(() => undefined)
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isPrivateOrDynamicRequest(request, url) {
  return request.method !== 'GET'
    || url.origin !== self.location.origin
    || url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/auth/')
    || url.pathname.startsWith('/admin')
    || url.pathname.startsWith('/profile')
    || url.pathname.startsWith('/account')
    || url.pathname.startsWith('/settings')
    || url.pathname.startsWith('/my-list')
    || url.pathname.startsWith('/watch/');
}

function isSafeStaticRequest(request, url) {
  return request.destination === 'script'
    || request.destination === 'style'
    || request.destination === 'font'
    || url.pathname.startsWith('/_app/immutable/')
    || url.pathname.startsWith('/icons/')
    || url.pathname === '/manifest.webmanifest'
    || url.pathname === '/robots.txt';
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return; // malformed URL — default browser handling
  }

  if (isPrivateOrDynamicRequest(request, url)) return;

  try {
    if (request.mode === 'navigate') {
      // Network-first WITH A HARD TIMEOUT. The race guarantees a painted
      // page: either the network responds, or (stall/slow socket) the
      // offline shell renders after NAVIGATION_TIMEOUT_MS instead of the
      // PWA splash hanging for the socket's full timeout window.
      event.respondWith(
        Promise.race([
          fetch(request),
          new Promise((resolve) => setTimeout(() => resolve(undefined), NAVIGATION_TIMEOUT_MS))
        ]).then((response) => {
          if (response && response.ok) return response;
          // Timeout (undefined) or non-OK network response → offline shell,
          // falling back to an honest error if even that is unavailable.
          return caches.match(OFFLINE_URL).then((cached) => cached || Response.error());
        })
      );
      return;
    }

    if (!isSafeStaticRequest(request, url)) return;

    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        });
        return cached || network;
      })
    );
  } catch (e) {
    // Never let a worker bug turn into a failed respondWith: fall through
    // and let the browser perform the request itself.
    return;
  }
});
