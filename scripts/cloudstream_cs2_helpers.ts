/**
 * CS-2 test helpers: deterministic mock fetch/DNS infrastructure.
 *
 * NO test in the CloudStream suites ever touches the real network: every
 * fetch goes through an injectable fetcher that serves fixture documents.
 * The mock fetcher is SIGNAL-AWARE (rejects with AbortError when the abort
 * signal fires) so deadline/timeout tests exercise the real abort paths.
 */

import { resetDynamicUrlsCacheForTests } from '$lib/server/cloudstream/runtime/dynamic-urls';

export type MockRoute = {
  status?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Simulated redirect (only honored for no-redirect probes). */
  location?: string;
};

export type MockResponder = (url: string, init?: RequestInit) => Promise<MockRoute>;

/** Public DNS resolver mock (SSRF tests override with private addresses). */
export const PUBLIC_DNS: (hostname: string) => Promise<Array<{ address: string; family: number }>> =
  async () => [{ address: '93.184.216.34', family: 4 }];

/** Private DNS resolver mock (every hostname resolves into 10.0.0.0/8). */
export const PRIVATE_DNS: (hostname: string) => Promise<Array<{ address: string; family: number }>> =
  async () => [{ address: '10.0.0.5', family: 4 }];

/**
 * Builds a signal-aware mock fetcher from a responder. Aborts reject with
 * a DOMException AbortError — the same observable contract as global fetch.
 */
export function createMockFetcher(responder: MockResponder): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const respond = responder(url, init).then((route) => {
      const status = route.status ?? 200;
      const headers = new Headers({
        'content-type': route.contentType ?? 'text/html; charset=utf-8',
        ...(route.headers ?? {}),
        ...(route.location !== undefined ? { location: route.location } : {}),
      });
      // 3xx responses keep the body empty (redirect semantics).
      if (status >= 300 && status < 400) {
        return new Response('', { status, headers });
      }
      return new Response(route.body ?? '', { status, headers });
    });
    const signal = init?.signal;
    if (!signal) return respond;
    return Promise.race([
      respond,
      new Promise<Response>((_, reject) => {
        const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  };
}

/** Builds a fetcher that never resolves (timeout tests) — still abortable. */
export function createHangingFetcher(): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((_, reject) => {
      const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      // No resolution path — only abort or process kill.
    });
  };
}

/** URL-keyed route table responder; unknown URLs → 404. */
export function routeTable(routes: Record<string, MockRoute>): MockResponder {
  return async (url) => routes[url] ?? { status: 404, body: 'not found' };
}

/** The shared urls.json document URL (must match dynamic-urls.ts). */
export const DYNAMIC_URLS_URL = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';

/** Standard urls.json fixture (public test domains). */
export const TEST_DYNAMIC_URLS: Record<string, string> = {
  bollyflix: 'https://bollyflix.test',
  moviesdrive: 'https://moviesdrive.test',
  vegamovies: 'https://vegamovies.test',
  gdflix: 'https://gdflix.test',
  hubcloud: 'https://hubcloud.test',
  vcloud: 'https://vcloud.test',
};

/** json content-type for JSON fixtures. */
export const JSON_ROUTE = 'application/json; charset=utf-8';
export const HTML_ROUTE = 'text/html; charset=utf-8';

/** Resets the dynamic-urls in-process cache (call at each section start). */
export function resetCaches(): void {
  resetDynamicUrlsCacheForTests();
}

/** Simple pass counter + assert wrapper (repository convention). */
export function createCounter() {
  let passed = 0;
  return {
    ok(condition: unknown, label: string, assertFn: (condition: unknown, label: string) => void) {
      assertFn(condition, label);
      passed += 1;
    },
    bump() {
      passed += 1;
    },
    get value() {
      return passed;
    },
    summary(name: string): string {
      return `${name}: ${passed} checks PASSED`;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared HTML fixtures (faithful to the REAL provider page shapes verified
// during source inspection)
// ---------------------------------------------------------------------------

export const BOLLYFLIX_SEARCH_HTML = `
<html><body><div class="post-cards">
  <article><a title="Download Inception (2010) BluRay 1080p" href="https://bollyflix.test/inception-2010/"><img src="/poster.jpg"/></a></article>
  <article><a title="Download Inception BluRay 720p" href="https://bollyflix.test/inception-720/"><img src="/p2.jpg"/></a></article>
  <article><a title="Download Something Else (2019)" href="https://bollyflix.test/other/"><img src="/p3.jpg"/></a></article>
</div></body></html>`;

export const BOLLYFLIX_MOVIE_HTML = `
<html><head><title>Download Inception (2010) BluRay 1080p 720p</title></head><body>
  <span id="summary">A thief who steals corporate secrets.</span>
  <a class="dl" href="https://web.sidexfee.com/?id=QUJDREVG">1080p</a>
  <a class="dl" href="https://fastdlserver.test/f/inception-1080">720p</a>
</body></html>`;

export const BOLLYFLIX_SERIES_HTML = `
<html><head><title>Download Dark Series Complete S01</title></head><body>
  <div><h2>Season 1</h2><p><a class="maxbutton-download-links" href="https://bollyflix.test/season1/">Download</a></p></div>
</body></html>`;

export const BOLLYFLIX_SEASON_PAGE_HTML = `
<html><body>
  <h3><a href="https://gdflix.test/file/ep1">Episode 1</a></h3>
  <h3><a href="https://gdflix.test/file/ep2">Episode 2</a></h3>
  <h3><a href="https://bollyflix.test/zip/">Zip File</a></h3>
  <h3><a href="https://gdflix.test/file/ep3">Episode 3</a></h3>
</body></html>`;

/** base64('https://gdflix.test/file/inception-1080') — sidexfee bypass payload. */
export const SIDEXFEE_PAYLOAD = Buffer.from('https://gdflix.test/file/inception-1080').toString('base64');
export const SIDEXFEE_HTML = `{"link":"${SIDEXFEE_PAYLOAD}"}`;

export const GDFLIX_PAGE_HTML = `
<html><body>
  <ul class="list-group">
    <li class="list-group-item">Name : Inception.2010.1080p.BluRay.x264.mkv</li>
    <li class="list-group-item">Size : 2.4 GB</li>
  </ul>
  <div class="text-center">
    <a href="https://gdflix.test/dl/fsl/abc">FSL V2</a>
    <a href="https://gdflix.test/dl/direct/abc">DIRECT DL</a>
    <a href="/cf-index">GD Index</a>
    <a href="/fast-cloud">FAST CLOUD</a>
    <a href="https://pixeldrain.com/u/abc123">pixeldrain</a>
    <a href="https://gdflix.test/instant/xyz">Instant DL</a>
  </div>
</body></html>`;

export const GDFLIX_CF_PAGE_HTML = `
<html><body><a class="btn-success" href="https://cf1.gdflix.test/real/file">CF link</a></body></html>`;

export const GDFLIX_FASTCLOUD_PAGE_HTML = `
<html><body><div class="card-body"><a href="https://fastcloud.gdflix.test/file">FAST CLOUD file</a></div></body></html>`;

export const MOVIESDRIVE_SEARCH_JSON = JSON.stringify({
  hits: [
    { document: { permalink: '/inception-2010/', post_thumbnail: 'https://img.test/p.jpg', post_title: 'Inception (2010) BluRay [Hindi & English] 4K 1080p 720p Dual Audio' } },
    { document: { permalink: '/inception-720/', post_thumbnail: 'https://img.test/p2.jpg', post_title: 'Inception (2010) 720p' } },
  ],
});

export const MOVIESDRIVE_MOVIE_HTML = `
<html><head><title>Download Inception (2010) BluRay 1080p</title></head><body>
  <h5><a href="https://moviesdrive.test/dl1/">1080p x264</a></h5>
  <h5><a href="https://moviesdrive.test/dl2/">720p</a></h5>
</body></html>`;

export const MOVIESDRIVE_DL1_HTML = `
<html><body>
  <a href="https://gdflix.test/file/inception-1080">GDFlix</a>
  <a href="https://hubcloud.test/dl/hub-1080">HubCloud</a>
  <a href="https://example.test/other">Other</a>
</body></html>`;

export const HUBCLOUD_PAGE_HTML = `
<html><body>
  <script>var url = '/download/abc';</script>
</body></html>`;

export const HUBCLOUD_CARD_HTML = `
<html><body>
  <div class="card-header">Inception 2010 1080p BluRay x264</div>
  <i id="size">2.4 GB</i>
  <h2><a class="btn" href="https://fsl.hubcloud.test/file1">FSL Server</a></h2>
  <h2><a class="btn" href="https://hubcloud.test/dl/file2">Download File</a></h2>
  <h2><a class="btn" href="https://buzz.hubcloud.test/b1">BuzzServer</a></h2>
</body></html>`;

export const VEGAMOVIES_SEARCH_JSON = JSON.stringify({
  hits: [
    { document: { permalink: '/inception-2010-hd/', post_title: 'Download Inception (2010) Dual Audio 480p 720p 1080p', post_thumbnail: 'https://img.test/v.jpg' } },
  ],
});

export const VEGAMOVIES_MOVIE_HTML = `
<html><head><title>Download Inception (2010) Dual Audio 1080p</title></head><body>
  <a href="https://vegamovies.test/get/1080p/"><button class="dwd-button">1080p</button></a>
  <a href="https://vegamovies.test/get/720p/"><button class="dwd-button">720p</button></a>
</body></html>`;

export const VEGAMOVIES_GET_PAGE_HTML = `
<html><body>
  <a href="https://vcloud.test/file/vc-1080">V-Cloud</a>
  <a href="https://example.test/x">Other</a>
</body></html>`;

export const VEGAMOVIES_SERIES_HTML = `
<html><head><title>Download Dark (2017) S01 Hindi 1080p</title></head><body><main>
  <h3>Series Info</h3>
  <h3>Download Dark 2017 {Season 1} 1080p</h3>
  <p><a href="https://vegamovies.test/ep-pack/s1/">Episode 1-10</a> <a href="https://vegamovies.test/gd/s1/">G-Direct</a></p>
</main></body></html>`;

export const VEGAMOVIES_EPISODE_PAGE_HTML = `
<html><body>
  <p><a href="https://vcloud.test/file/dark-s1e1">V-Cloud E1</a></p>
  <p><a href="https://vcloud.test/file/dark-s1e2">V-Cloud E2</a></p>
</body></html>`;

export const VCLOUD_PAGE_HTML = `
<html><body>
  <script>var url = atob(atob('${Buffer.from(Buffer.from('/download/vc-abc', 'utf8').toString('base64'), 'utf8').toString('base64')}'));</script>
</body></html>`;
