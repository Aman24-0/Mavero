/**
 * VidBox (stream.hls.lol mbox API) resolver adapter — round 42 (2026-11);
 * display-renamed VidFlix → VidBox in round 45 (the former VidPlay/ThugTV
 * group that carried the VidBox name was deleted in round 45, freeing it).
 *
 * FIFTH DirectStream server group (after Vidsrc, Vidstream/Rivestream and
 * VidVelvet/ThugTV media). Calls the mbox API SERVER-SIDE ONLY through the
 * Cloudflare Worker as ?e=<base64url(url)> — the API URL is never exposed
 * to the browser, and the per-track MPD URLs are wrapped through the SAME
 * Worker so the browser only ever talks to the Worker origin.
 *
 * API (server-side only, stream.hls.lol):
 *   movie: https://stream.hls.lol/mbox?tmdbId=<id>&type=movie
 *   tv   : https://stream.hls.lol/mbox?tmdbId=<id>&type=tv&season=<s>&episode=<e>
 *
 * Response: { expiresAt, server, subtitles: [{url, lang, label}],
 *             tracks: [{ id, url, kind: "dash", quality, lang, mode }] }
 *
 * DESIGN (round 42, row-dedupe fix round 43, union-merge round 45):
 *   * Each `tracks[]` entry is a SEPARATE DASH (.mpd) manifest carrying its
 *     own audio. ONE ROW PER TRACK is exposed inside the VidBox tab of the
 *     server sheet; the row label is the track's audio language
 *     (lang || mode || quality). Rows are DEDUPED BY NORMALISED TRACK URL —
 *     every distinct https URL yields exactly one row (round 43: several
 *     tracks can share one audio label such as "Original" while carrying
 *     DIFFERENT MPDs, so the old label dedupe dropped every track after
 *     the first). Duplicate labels are DISAMBIGUATED, never dropped: the
 *     first keeps the plain label, later ones become
 *     "<label> · <quality | id | 1-based row index>" — a language name is
 *     never invented. Capped at 12 rows. server = 'VidBox',
 *     protocol = 'dash'.
 *   * The Quality menu ALWAYS comes from the MPD's real levels — NO
 *     `qualities` array is ever set (the VOD DASH engine (round 42) reads
 *     getVariantTracks() from the manifest). The .mpd tracks are NEVER
 *     dropped here.
 *   * Round 45 — MERGE TRACKS ACROSS RETRIES: the API returns a DIFFERENT
 *     SUBSET of tracks per request (observed: the browser got
 *     Original/Esla/Hindi for one title while the server-side fetch got
 *     2 tracks both labelled "Original"). After a successful fetch, if
 *     fewer than 2 DISTINCT track URLs came back, OR the tracks carry
 *     fewer than 2 distinct audio labels, the API is fetched AGAIN (max
 *     3 passes total, 400ms apart) and the track lists are MERGED by
 *     normalised URL (union, first-seen order preserved) — one pass is
 *     not enough to see the full audio roster.
 *   * Round 49 — PREFER A NON-DECOY CDN VARIANT: stream.hls.lol hands out
 *     tracks whose MPD lives on one of two CDNs — sacdn/cacdn.
 *     hakunaymatata.com (REAL) or schooling.cfd/edge-<id>/hm-decoy/... (a
 *     DECOY that plays an "atlantic.bz / disable Cloudflare Warp VPN"
 *     video instead of the movie — the CDN serves it to traffic it
 *     classifies as VPN, and the Worker's egress qualifies). After each
 *     successful pass the FIRST track of that pass's FRESH batch is
 *     PROBED through the same ?e= Worker proxy the player uses (XML/DASH
 *     accept header; 8s timeout; at most 4 KB of the body read): DECOY
 *     when the head carries 'hm-decoy' or '/decoy/' or the <BaseURL>
 *     host (the ?u=-decoded original behind the Worker's rewrite) is
 *     not sacdn/cacdn; a probe failure (timeout / non-200) is UNKNOWN
 *     and treated as REAL — never drop on doubt. A DECOY probe triggers
 *     one more API re-fetch (same budget: max 3 API calls total, 400ms
 *     apart; the union is kept across attempts so no track is lost)
 *     because the API hands out a DIFFERENT track/CDN set per call.
 *     Rows are then ordered probed REAL/UNKNOWN first, unprobed next,
 *     probed DECOY last, so rows[0] (the default playback URL) is a REAL
 *     variant whenever one was found. A decoy-ONLY outcome is still
 *     served (the group is never failed) and is cached for 15s at most
 *     so a later request retries sooner.
 *   * Subtitles are .srt (not VTT). Each {url, lang, label} is mapped to
 *     the SAME-ORIGIN converting proxy /api/content/subtitles/vtt/proxy
 *     (strict cacdn.hakunaymatata.com host allowlist, SRT→VTT conversion,
 *     bounded fetch — see that route). Capped at 40 tracks. The subtitle
 *     origin stays the INTERNAL key 'vidflix' (the app_config gate column
 *     direct_stream_vidflix_enabled is unchanged too — display-only rename).
 *   * No NEW audio-selector UI: VidVelvet's single-URL-multi-audio behaviour
 *     is untouched; for VidBox the language choice IS the row choice.
 *
 * RELIABILITY — same conventions as vidstart.ts (rounds 39-42):
 *   1. BOUNDED retry loop PER PASS — up to 2 attempts (backoff 500ms after
 *      attempt 1, a fresh 10s AbortController per attempt). Retried: a
 *      thrown fetch (network error / an abort that is NOT our own
 *      timeout), HTTP 403/408/425/429/500/502/503/504. NOT retried: 404
 *      and any other 4xx, our own timeout abort (a hung upstream must not
 *      hold the composite resolve for 2 × 10s), or a 200 whose body is
 *      not JSON (logged, then omitted). A 200 whose tracks array is empty
 *      is NOT retried by the HTTP loop — the round 45 variety passes cover
 *      the "thin subset" case, and a title with genuinely no tracks simply
 *      has no VidBox group.
 *   2. SHORT-LIVED SUCCESS CACHE — a payload that yields at least one row
 *      is cached for 60s (a decoy-ONLY outcome for 15s at most — round 49;
 *      the upstream mints per-request URLs with an expiresAt, so a 60s
 *      window is safe). The cached payload carries the MERGED track union
 *      in the PREFERRED (non-decoy-first) order, so a cache hit replays the
 *      SAME roster. Failures are never cached.
 */

import type { ProviderAdapter, AdapterResult, ResolverContext } from './types';
import { env as publicEnv } from '$env/dynamic/public';

export const VIDBOX_ADAPTER_ID = 'vidbox';

const VIDBOX_API = 'https://stream.hls.lol/mbox';
const API_TIMEOUT_MS = 10_000;
/** Bounded retry per pass — 2 attempts keep the worst-case failure cost low
 *  (one retry + 500ms backoff), same tuning as vidstart.ts. */
const MAX_ATTEMPTS = 2;
/** Backoff BETWEEN attempts of one pass: 500ms after attempt 1. */
const RETRY_BACKOFF_MS = [500] as const;
/** Round 45 — MAX VARIETY PASSES: the first fetch plus up to 2 re-fetches
 *  (3 network passes total) when the union still shows fewer than 2
 *  distinct track URLs or fewer than 2 distinct audio labels. */
const MAX_VARIETY_PASSES = 3;
/** Round 45 — gap BETWEEN variety passes: 400ms. */
const VARIETY_PASS_DELAY_MS = 400;
/** Short-lived SUCCESS cache — only payloads that yield at least one row
 *  are cached, for 60s: the upstream mints per-request MPD URLs with an
 *  expiresAt, so a 60s window is safe (the cached URLs stay playable).
 *  Failures are NEVER cached. */
const CACHE_TTL_MS = 60_000;
/** Round 49 — a DECOY-ONLY outcome (every probed attempt came back DECOY)
 *  is cached for 15s at most, so a later request retries the API sooner —
 *  the next call may hand out the sacdn REAL variant. Normal outcomes keep
 *  the 60s TTL above. */
const DECOY_CACHE_TTL_MS = 15_000;
/** Cache cap — on write, entries older than the TTL are evicted first,
 *  then the OLDEST entries are dropped so the Map never exceeds this. */
const CACHE_MAX_ENTRIES = 50;
/** Server rows cap — one row per DISTINCT track URL (round 43: 8 → 12). */
const MAX_ROWS = 12;
/** Subtitle tracks cap. */
const MAX_SUBTITLES = 40;
const payloadCache = new Map<string, { at: number; ttl?: number; payload: VidBoxPayload }>();
/** Retriable statuses — the usual timeout / rate-limit / server classes.
 *  404 and other 4xx are NOT retried. */
const RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
/** Round 49 — probe: the FIRST candidate track's MPD is probed through the
 *  SAME ?e= Worker proxy the player uses, with a fresh 8s AbortController
 *  and an XML/DASH accept header. */
const PROBE_TIMEOUT_MS = 8_000;
/** Round 49 — probe body read cap: 4 KB. The <BaseURL> the classifier needs
 *  sits at the top of the manifest — the whole MPD is never pulled. */
const PROBE_READ_LIMIT_BYTES = 4_096;
/** Round 49 — the hosts that serve REAL VidBox content. Everything else —
 *  notably schooling.cfd/edge-<id>/hm-decoy/... — is the decoy video the CDN
 *  serves traffic it classifies as VPN (the Worker's egress qualifies). */
const REAL_BASE_HOSTS = new Set(['sacdn.hakunaymatata.com', 'cacdn.hakunaymatata.com']);

interface VidBoxTrack {
  id?: string | number;
  url?: string;
  kind?: string;
  quality?: string;
  lang?: string;
  mode?: string;
}

interface VidBoxSubtitle {
  url?: string;
  lang?: string;
  label?: string;
}

interface VidBoxPayload {
  expiresAt?: string;
  server?: string;
  subtitles?: VidBoxSubtitle[];
  tracks?: VidBoxTrack[];
  /** Defensive nested unwrap — same convention as vidstart.ts. */
  data?: { expiresAt?: string; server?: string; subtitles?: VidBoxSubtitle[]; tracks?: VidBoxTrack[] };
}

/** Base64url-encode a UTF-8 string (for the ?e= Worker param and the
 *  subtitle proxy's ?u= param). Matches the Worker's decodeBase64Url:
 *  base64 → replace + with -, / with _, strip = padding. Uses Node.js
 *  Buffer (server-side only). Local copy of the vidstart.ts helper —
 *  kept local on purpose. */
function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Wrap a CDN URL through the Worker proxy using the opaque ?e= param.
 *  Local copy of the vidstart.ts helper — kept local on purpose. */
function proxyUrl(rawUrl: string, workerProxyUrl: string): string {
  const encoded = encodeBase64Url(rawUrl);
  return `${workerProxyUrl}/?e=${encoded}`;
}

/** Normalise an API-provided URL: trim, and unescape &amp; → & (same
 *  defensive normalisation as vidstart.ts — an escaped query string breaks
 *  CDN signatures). These tracks ARE .mpd — they are never dropped here. */
function normalizeUrl(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/&amp;/g, '&') : '';
}

/** The row's base audio label (lang → mode → quality → 'VidBox') — same
 *  derivation as the row mapping below; a language name is NEVER invented
 *  (only the track's own metadata is used). Also drives the round 45
 *  variety check (the union needs at least 2 distinct audio labels). */
function trackBaseLabel(track: VidBoxTrack): string {
  return (typeof track?.lang === 'string' && track.lang.trim())
    || (typeof track?.mode === 'string' && track.mode.trim())
    || (typeof track?.quality === 'string' && track.quality.trim())
    || 'VidBox';
}

/** Defensive nested unwrap — the API has been observed returning both a
 *  NESTED `{ data: … }` and a FLAT shape. */
function payloadBody(payload: VidBoxPayload | null): Partial<VidBoxPayload> {
  return (payload?.data ?? payload) ?? {};
}

/** Round 49 — probe classification: REAL (sacdn/cacdn BaseURL host, no
 *  decoy marker), DECOY ('hm-decoy' / '/decoy/' marker or an off-allowlist
 *  BaseURL host) or UNKNOWN (probe failure — treated as REAL, never drop
 *  on doubt). */
type ProbeClass = 'REAL' | 'DECOY' | 'UNKNOWN';
interface ProbeOutcome {
  cls: ProbeClass;
  /** The <BaseURL> host of the probed manifest ('n/a' when unknown). */
  host: string;
}

/** Round 49 — read at most `limitBytes` of a response body (the Worker may
 *  serve a large manifest; the classifier only needs its head). */
async function readBodyHead(response: Response, limitBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      received += value.length;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  let head = '';
  for (const chunk of chunks) head += decoder.decode(chunk, { stream: true });
  head += decoder.decode();
  return head.slice(0, limitBytes);
}

/** Round 49 — classify a (possibly Worker-REWRITTEN) MPD head. The Worker
 *  rewrites <BaseURL> back through itself as ?u=<encoded original>, so the
 *  ORIGINAL segment host is recovered by decoding the u param; a raw
 *  (unrewritten) absolute BaseURL is used as-is. DECOY when the head
 *  carries a decoy marker ('hm-decoy' or '/decoy/') or the BaseURL host is
 *  not sacdn/cacdn.hakunaymatata.com; otherwise REAL. */
function classifyManifestHead(head: string): ProbeOutcome {
  const baseMatch = head.match(/<BaseURL>\s*([^<]+?)\s*<\/BaseURL>/);
  let host = 'n/a';
  if (baseMatch?.[1]) {
    try {
      const parsed = new URL(baseMatch[1].trim());
      const inner = parsed.searchParams.get('u');
      host = new URL(inner ?? parsed.toString()).hostname;
    } catch {
      host = 'n/a';
    }
  }
  const isDecoy = /hm-decoy/i.test(head) || head.includes('/decoy/') || !REAL_BASE_HOSTS.has(host);
  return { cls: isDecoy ? 'DECOY' : 'REAL', host };
}

/** Round 49 — probe ONE candidate MPD through the SAME ?e= Worker proxy
 *  the player uses. A timeout, a network error or a non-200 is UNKNOWN —
 *  treated as REAL (never drop on doubt). Never throws. */
async function probeManifest(trackUrl: string, workerProxyUrl: string): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(proxyUrl(trackUrl, workerProxyUrl), {
      signal: controller.signal,
      headers: { accept: 'application/xml, application/dash+xml, */*' }
    });
    if (!response.ok) return { cls: 'UNKNOWN', host: 'n/a' };
    return classifyManifestHead(await readBodyHead(response, PROBE_READ_LIMIT_BYTES));
  } catch {
    return { cls: 'UNKNOWN', host: 'n/a' };
  } finally {
    clearTimeout(timeout);
  }
}

export const vidboxAdapter: ProviderAdapter = {
  integrationType: 'api',
  adapterId: VIDBOX_ADAPTER_ID,

  async resolve(context: ResolverContext): Promise<AdapterResult | null> {
    // IMPORTANT: Vite does NOT replace a dynamic `import.meta.env` OBJECT
    // access in the SSR bundle (only literal `import.meta.env.PUBLIC_FOO`
    // lookups are statically replaced). The `$env/dynamic/public` module
    // is the documented SvelteKit pattern for reading public env at
    // runtime and is what every other adapter in this folder uses.
    const workerProxyUrl = (publicEnv.PUBLIC_STREAM_PROXY_URL ?? '').replace(/\/+$/, '');
    if (!workerProxyUrl) {
      // Without the Worker the API call would go straight from Netlify to
      // stream.hls.lol and the browser could not fetch the MPDs (CORS) —
      // fail closed and surface the misconfiguration in the Netlify log.
      console.warn('[vidbox] PUBLIC_STREAM_PROXY_URL missing');
      return null;
    }

    // NormalizedMediaItem.id is the content ID (e.g. "movie-278" → strip prefix).
    const rawId = context.content.id.replace(/^(movie|series|anime)-/, '');
    const mediaType = context.content.type;
    const season = context.request.season;
    const episode = context.request.episode;

    // Build the API URL — server-side only.
    let apiUrl: URL;
    if (mediaType === 'movie') {
      apiUrl = new URL(`${VIDBOX_API}?tmdbId=${rawId}&type=movie`);
    } else if (season && episode) {
      apiUrl = new URL(`${VIDBOX_API}?tmdbId=${rawId}&type=tv&season=${season}&episode=${episode}`);
    } else {
      // TV without season/episode has nothing to resolve — omit the
      // VidBox group (never block the other groups).
      console.warn('[vidbox] tv resolve without season/episode — skipping', rawId);
      return null;
    }
    console.info('[vidbox] API URL', apiUrl.toString());

    // Short-lived SUCCESS cache (60s TTL — see CACHE_TTL_MS): a fresh hit
    // skips the network ENTIRELY (the cached payload already carries the
    // round 45 MERGED track union — a hit replays the SAME roster). Only
    // the fetch is short-circuited — the cached tracks still flow through
    // the SAME row/subtitle mapping below, so the returned shape is
    // unchanged. The entry is NOT refreshed on a hit: the TTL runs from
    // the NETWORK success, keeping the served URLs well inside the
    // upstream's expiresAt window.
    const cacheKey = `${mediaType}:${rawId}:${season ?? ''}:${episode ?? ''}`;
    const cached = payloadCache.get(cacheKey);

    // Round 45 — the track UNION across ALL successful passes of this
    // resolve (the mbox API hands out a different subset per request).
    // MERGED BY NORMALISED URL, first-seen order preserved: every distinct
    // https MPD the API handed us in the pass window becomes a row.
    const tracks: VidBoxTrack[] = [];
    const seenTrackUrls = new Set<string>();
    const ingestTracks = (list: unknown): void => {
      if (!Array.isArray(list)) return;
      for (const entry of list) {
        const track = entry as VidBoxTrack;
        const trackUrl = normalizeUrl(track?.url);
        if (!trackUrl || !trackUrl.startsWith('https://')) continue; // never invented
        if (seenTrackUrls.has(trackUrl)) continue; // union — one entry per distinct URL
        seenTrackUrls.add(trackUrl);
        tracks.push(track);
      }
    };
    // Round 45 — the variety predicate: enough variety means at least 2
    // DISTINCT track URLs AND at least 2 distinct audio labels in the union.
    const unionHasEnoughVariety = (): boolean => {
      if (tracks.length < 2) return false;
      const labels = new Set<string>();
      for (const track of tracks) labels.add(trackBaseLabel(track));
      return labels.size >= 2;
    };

    // One NETWORK pass: the round 43 bounded attempt loop (up to 2
    // attempts — backoff 500ms after attempt 1, a fresh 10s
    // AbortController per attempt; retriable statuses, timeout and
    // non-JSON rules unchanged). Returns the parsed payload on success,
    // null on give-up.
    const fetchPass = async (): Promise<VidBoxPayload | null> => {
      let lastStatus = 0;
      let lastContentType = '';
      let lastBodyHead = '';
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, API_TIMEOUT_MS);
        // How this attempt ended — decides retry vs give up.
        let outcome: 'ok' | 'retry' | 'fatal' = 'ok';
        try {
          const encoded = encodeBase64Url(apiUrl.toString());
          const fetchUrl = `${workerProxyUrl}/?e=${encoded}`;
          const response = await fetch(fetchUrl, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          });
          lastStatus = response.status;
          lastContentType = response.headers.get('content-type') ?? '';
          if (!response.ok) {
            // Read the body ONCE, truncated to 200 chars — enough to
            // identify an error page / contract change in the Netlify log.
            const text = await response.text();
            lastBodyHead = text.slice(0, 200);
            console.warn('[vidbox] attempt', attempt, 'HTTP', response.status, 'body', lastBodyHead);
            outcome = RETRYABLE_STATUSES.has(response.status) ? 'retry' : 'fatal';
          } else {
            const text = await response.text();
            lastBodyHead = text.slice(0, 200);
            try {
              return JSON.parse(text) as VidBoxPayload;
            } catch {
              // Never fail silently — surface enough of the body to identify
              // an HTML error page / contract change in the Netlify log.
              console.warn('[vidbox] non-JSON response — HTTP', lastStatus, 'type', lastContentType, 'body', JSON.stringify(lastBodyHead));
              return null;
            }
          }
        } catch (error) {
          if (timedOut && (error as { name?: string } | null | undefined)?.name === 'AbortError') {
            // Our OWN 10s timeout — NOT retried: a hung upstream must not
            // hold the composite resolve for MAX_ATTEMPTS × 10s.
            console.warn('[vidbox] attempt', attempt, 'timed out after', API_TIMEOUT_MS, 'ms —', error instanceof Error ? error.message : String(error));
            outcome = 'fatal';
          } else {
            // Network error / an abort that is not our timeout — retryable.
            console.warn('[vidbox] attempt', attempt, 'fetch failed —', error instanceof Error ? error.message : String(error));
            outcome = 'retry';
          }
        } finally {
          clearTimeout(timeout);
        }
        if (outcome === 'fatal') break;
        if (outcome === 'retry') {
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt - 1]!));
          }
          continue;
        }
      }
      // Bounded give-up for this pass.
      console.warn('[vidbox] pass failed after HTTP', lastStatus);
      return null;
    };

    // PRIMARY pass + the round 45 variety re-fetches + the round 49 decoy
    // re-fetches. The LAST successful payload owns the subtitles/expiresAt;
    // the TRACK lists of every successful pass are merged into the union
    // above (kept across attempts so no track is lost).
    let payload: VidBoxPayload | null = null;
    let succeeded = false;
    let servedFromCache = false;
    // Round 49 — probe bookkeeping: the classification per normalised track
    // URL (a repeated URL is reused, not re-fetched), the per-attempt probe
    // classes and the LATEST attempt's class (drives the decoy re-fetch).
    const probeByTrackUrl = new Map<string, ProbeOutcome>();
    const attemptProbes: ProbeClass[] = [];
    let lastProbeCls: ProbeClass | null = null;
    // Round 49 — probe the FIRST track of THIS pass's FRESH batch (the API
    // hands out a DIFFERENT track/CDN set per call — the current batch is
    // the variant a re-fetch is trying to replace). One probe per attempt,
    // logged as one line. Nothing to probe (empty batch / no https URL)
    // leaves the previous attempt's classification standing.
    const probeFirstCandidate = async (batch: unknown, pass: number): Promise<void> => {
      const first = Array.isArray(batch) ? ((batch as VidBoxTrack[])[0] ?? null) : null;
      const trackUrl = normalizeUrl(first?.url);
      if (!trackUrl || !trackUrl.startsWith('https://')) return; // nothing to probe
      let outcome = probeByTrackUrl.get(trackUrl);
      if (!outcome) {
        outcome = await probeManifest(trackUrl, workerProxyUrl);
        probeByTrackUrl.set(trackUrl, outcome);
      }
      console.info('[vidbox] attempt', pass, 'probe', outcome.cls, 'host', outcome.host || 'n/a');
      lastProbeCls = outcome.cls;
      attemptProbes.push(outcome.cls);
    };
    if (cached && Date.now() - cached.at < (cached.ttl ?? CACHE_TTL_MS)) {
      console.info('[vidbox] cache hit', cacheKey);
      payload = cached.payload;
      succeeded = true;
      servedFromCache = true;
      ingestTracks(payloadBody(payload).tracks);
    } else {
      payload = await fetchPass();
      if (payload) {
        succeeded = true;
        const firstBody = payloadBody(payload);
        ingestTracks(firstBody.tracks);
        await probeFirstCandidate(firstBody.tracks, 1);
        // Round 45 — a successful pass whose union still shows fewer than
        // 2 distinct URLs or fewer than 2 distinct audio labels is a THIN
        // SUBSET, and round 49 adds: a pass whose LAST probe came back DECOY
        // is a decoy variant. Either way re-fetch (max MAX_VARIETY_PASSES
        // total, 400ms apart) and merge. A failed re-fetch is NON-FATAL —
        // the union collected so far keeps the group alive. A probe UNKNOWN
        // never triggers a re-fetch (treated as REAL — never drop on doubt).
        for (let pass = 2; pass <= MAX_VARIETY_PASSES; pass++) {
          if (unionHasEnoughVariety() && lastProbeCls !== 'DECOY') break;
          await new Promise((resolve) => setTimeout(resolve, VARIETY_PASS_DELAY_MS));
          const next = await fetchPass();
          if (!next) {
            console.warn('[vidbox] variety pass', pass, 'failed — keeping', tracks.length, 'tracks');
            break;
          }
          payload = next;
          const nextBody = payloadBody(next);
          ingestTracks(nextBody.tracks);
          await probeFirstCandidate(nextBody.tracks, pass);
        }
      }
    }

    if (!succeeded) {
      // Bounded give-up, exactly one summary line, then omit the VidBox
      // group (never block the other groups, never throw).
      console.warn('[vidbox] API resolve failed — HTTP 0/no usable response');
      return null;
    }

    // Round 45 — received-metadata diagnostic: the MERGED track roster
    // (id/quality/lang/mode per track) so the Netlify log shows exactly
    // what the API handed out across the passes.
    console.info('[vidbox] tracks', tracks.length, tracks.map(t => `${t.id}/${t.quality}/${t.lang}/${t.mode}`));

    // Round 49 — every probed attempt came back DECOY: serve the rows
    // anyway (the group is NEVER failed on a decoy), but say so in the log
    // and keep the cache entry short (15s — see the write below) so a later
    // request retries the API sooner.
    const decoyOnly = attemptProbes.length > 0 && attemptProbes.every((cls) => cls === 'DECOY');
    if (decoyOnly) {
      console.warn('[vidbox] all variants are decoy — serving anyway');
    }

    // Round 49 — PREFER THE NON-DECOY VARIANT: rows are ordered probed
    // REAL/UNKNOWN first, unprobed next, probed DECOY last (a stable sort —
    // first-seen order is kept inside each tier), so rows[0] (the DEFAULT
    // playback URL) is a REAL variant whenever one was found. NO row is
    // dropped — a decoy-only roster is served (see above), just last.
    const trackTier = (track: VidBoxTrack): number => {
      const cls = probeByTrackUrl.get(normalizeUrl(track?.url))?.cls;
      if (cls === 'REAL' || cls === 'UNKNOWN') return 0;
      return cls === 'DECOY' ? 2 : 1;
    };
    const orderedTracks = [...tracks].sort((a, b) => trackTier(a) - trackTier(b));

    // ONE ROW PER DISTINCT TRACK URL (round 43), capped at MAX_ROWS. Each
    // row carries its own MPD URL (Worker-proxied), protocol 'dash' and NO
    // qualities — the VOD DASH engine reads the MPD's real levels for the
    // Quality menu. The union above already deduped by URL (never by label
    // — the API can return several tracks that all say "Original");
    // duplicate labels are DISAMBIGUATED with a suffix instead of
    // dropping the row.
    const rows: Array<{
      url: string;
      label: string;
      server: string;
      protocol: 'dash';
      qualities: undefined; // the VOD DASH engine reads the MPD levels — never a hand-built list
    }> = [];
    const takenLabels = new Set<string>();
    for (const track of orderedTracks) {
      if (rows.length >= MAX_ROWS) break;
      const trackUrl = normalizeUrl(track?.url);
      if (!trackUrl || !trackUrl.startsWith('https://')) continue; // never invented
      const baseLabel = trackBaseLabel(track);
      // Round 43 — a label already taken by an earlier row is
      // DISAMBIGUATED, never dropped: "Original", "Original · 1080p", …
      // A language name is NEVER invented — the suffix is the track's own
      // quality, else its id, else the 1-based row index.
      let label = baseLabel;
      if (takenLabels.has(baseLabel)) {
        const qualityText = typeof track?.quality === 'string' ? track.quality.trim() : '';
        const idText = track?.id !== undefined && track?.id !== null ? String(track.id).trim() : '';
        const suffix = qualityText || idText || String(rows.length + 1);
        label = `${baseLabel} · ${suffix}`;
        // Pathological collision (same base label AND same suffix twice):
        // keep appending until unique — a distinct URL is never dropped.
        let bump = 2;
        while (takenLabels.has(label)) {
          label = `${baseLabel} · ${suffix} · ${bump}`;
          bump += 1;
        }
      }
      takenLabels.add(label);
      rows.push({
        url: proxyUrl(trackUrl, workerProxyUrl),
        label,
        server: 'VidBox',
        protocol: 'dash',
        qualities: undefined, // the VOD DASH engine reads the MPD levels — never a hand-built list
      });
    }

    // Empty tracks → omit the VidBox group entirely (never block the
    // other groups).
    if (rows.length === 0) {
      console.warn('[vidbox] no usable tracks — dropping (tracks', tracks.length, ')');
      return null;
    }

    // Subtitles: .srt files → the SAME-ORIGIN converting proxy (strict
    // cacdn.hakunaymatata.com allowlist + SRT→VTT conversion + bounded
    // fetch — see /api/content/subtitles/vtt/proxy). Capped at 40.
    // The LAST successful payload owns the subtitle list (the tracks are
    // union-merged; the subtitles are the pass's own set).
    const body = payloadBody(payload);
    const subs: Array<{ url: string; language: string; label: string; origin: string }> = [];
    for (const subtitle of Array.isArray(body?.subtitles) ? body!.subtitles! : []) {
      if (subs.length >= MAX_SUBTITLES) break;
      const rawUrl = normalizeUrl(subtitle?.url);
      if (!rawUrl || !rawUrl.startsWith('https://')) continue; // never invented
      const display = (typeof subtitle?.label === 'string' && subtitle.label.trim())
        || (typeof subtitle?.lang === 'string' && subtitle.lang.trim())
        || 'Unknown';
      subs.push({
        url: `/api/content/subtitles/vtt/proxy?u=${encodeBase64Url(rawUrl)}`,
        language: display,
        label: display,
        origin: 'vidflix',
      });
    }
    // Round 43 — subtitle diagnostics: the API can omit `subtitles`
    // entirely (or serve non-https URLs that get filtered out). Log the
    // API-side count next to the MAPPED count so the Netlify log tells
    // "the API provided none" apart from "none survived the mapping".
    console.info('[vidbox] subtitles api', body?.subtitles?.length ?? 0, 'mapped', subs.length);

    // Success → store in the short-lived cache, WITH the merged track union
    // in the PREFERRED (non-decoy-first) order (a cache hit replays the SAME
    // roster in the same order). Failures never reach this point (they
    // return above), so they are never cached. Evict entries older than
    // their own TTL (a decoy-only entry lives 15s), then enforce the cap by
    // dropping the OLDEST inserted entries (Map iteration order). A cache
    // hit does NOT rewrite the entry — `at` always marks the network
    // success.
    if (!servedFromCache && payload) {
      const mergedPayload = payload.data
        ? { ...payload, data: { ...payload.data, tracks: orderedTracks } }
        : { ...payload, tracks: orderedTracks };
      const now = Date.now();
      for (const [staleKey, entry] of payloadCache) {
        if (now - entry.at >= (entry.ttl ?? CACHE_TTL_MS)) payloadCache.delete(staleKey);
      }
      while (payloadCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = payloadCache.keys().next().value;
        if (oldestKey === undefined) break;
        payloadCache.delete(oldestKey);
      }
      // Round 49 — a decoy-ONLY outcome is cached for 15s at most so a later
      // request retries the API sooner (the next call may hand out the
      // sacdn REAL variant); every other outcome keeps the usual 60s TTL.
      payloadCache.set(cacheKey, {
        at: now,
        payload: mergedPayload,
        ...(decoyOnly ? { ttl: DECOY_CACHE_TTL_MS } : {})
      });
    }

    console.info('[vidbox] rows', rows.length, 'subs', subs.length);

    return {
      type: 'direct',
      url: rows[0]!.url,
      protocol: 'dash',
      ...(subs.length > 0 ? { subtitles: subs } : {}),
      metadata: {
        adapterId: VIDBOX_ADAPTER_ID,
        servers: rows,
      },
    };
  },
};
