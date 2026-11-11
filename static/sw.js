// MAVERO service worker — v4 (false-offline navigation fallback fix).
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
//   * Navigations: pure network-first, NO timeout race. The fetch is
//     awaited for as long as it takes and ANY response the network
//     produces (200, 304 revalidation, 4xx/5xx) is passed through
//     untouched — the server answered, so the user is online. The cached
//     offline page is served ONLY when fetch() actually THROWS a network
//     error (TypeError "Failed to fetch" / ERR_INTERNET_DISCONNECTED /
//     refused socket — true offline), never because a timer fired or a
//     response was merely non-OK.
//     History: v2/v3 raced the fetch against a hard 8s timer and routed
//     BOTH the timer branch AND every non-OK response to the offline
//     shell. That produced the false "You're offline" regression: a
//     slow-but-healthy connection (>8s) or a conditional-request 304
//     revalidation (Netlify serves HTML with max-age=0, must-revalidate)
//     landed on the offline page, and "Try again" instantly "worked"
//     because the retry re-navigated onto a now-warm network. v4 removed
//     the race entirely: a genuinely stalled navigation now keeps the OS
//     splash / boot screen visible until the socket resolves or errors —
//     the honest UX instead of force-faking an offline state.
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

// v4: bump forces every client to discard the v3 worker (whose 8s
// navigation timeout race caused the false offline fallback) on the next
// navigation — skipWaiting + clientsClaim make it active immediately.
const VERSION = 'mavero-shell-v4';
const STATIC_CACHE = `${VERSION}-static`;
const OFFLINE_URL = '/offline.html';
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
      // Pure network-first (v4 false-offline fix). NO timeout race: a slow
      // network keeps the OS splash / boot screen visible until the page
      // actually arrives, instead of being force-shown the offline shell.
      // ANY response the network produces is passed through untouched —
      // including 304 revalidations (Netlify HTML is max-age=0,
      // must-revalidate, so navigations legitimately revalidate) and
      // 4xx/5xx from the origin (the server ANSWERED, so the user is
      // online; SvelteKit renders its own error pages for those).
      // The cached offline shell is served ONLY when fetch() THROWS —
      // TypeError "Failed to fetch", ERR_INTERNET_DISCONNECTED, refused
      // socket, DNS failure — i.e. a true network error, never a timer.
      // If even the offline shell is missing from the cache, fall through
      // to Response.error() for an honest browser error page.
      event.respondWith(
        fetch(request).catch(() =>
          caches.match(OFFLINE_URL).then((cached) => cached || Response.error())
        )
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
