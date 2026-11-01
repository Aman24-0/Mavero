// ============================================================================
// Mavero — Standalone Indian Proxy for the Jio IPTV playlist.
//
// WHY THIS EXISTS
// ---------------
// Jio's CDN answers `451 Unavailable For Legal Reasons` to every request from
// a non-Indian egress IP. That is an IP-classification decision: the
// Cloudflare Worker (Cloudflare IPs) and Netlify are blocked AT THE NETWORK
// LEVEL — no Referer/Origin/Cookie spoofing can fix it. Deep audit of the
// playlist (2026-11):
//
//   * 1635 channels (1267 DASH, 367 HLS — counts rotate ±5 between syncs)
//   * 1353 channels need a `#EXTHTTP` Cookie (the `__hdnea__` Akamai token)
//   * 1576 channels need a `#EXTVLCOPT` User-Agent
//   * 1181 channels carry ClearKey DRM (`#KODIPROP` license_key = kid:key)
//   * The cookies EXPIRE EVERY 6 HOURS → the playlist is re-synced every 5
//     hours (plus a BACKGROUND re-sync — 5s cooldown, never blocking a
//     request — the moment an upstream answers 401/403/451).
//
// This service deploys on an INDIAN VPS (or any host Jio does not block —
// e.g. Render.com) and becomes the single egress for every Live TV stream:
//
//   1. PLAYLIST SYNC — fetches the M3U every SYNC_INTERVAL_HOURS, parses each
//      channel's URL + Cookie + User-Agent + Referer + ClearKey keys into an
//      in-memory Map (no database needed).
//   2. MANIFEST REWRITER — `/api/ch/...` fetches the ORIGINAL Jio manifest
//      with the STORED credentials and rewrites every segment reference back
//      onto THIS proxy:
//        * DASH  → <BaseURL> + SegmentTemplate media/initialization +
//                  SegmentURL/Initialization sourceURL; Widevine/PlayReady
//                  <ContentProtection> tags are STRIPPED (playback uses the
//                  ClearKey keys the app already holds; the generic
//                  urn:mpeg:dash:mp4protection:2011 tag is KEPT so the player
//                  still knows the content is CENC-encrypted).
//        * HLS   → variant URIs, media segments, EXT-X-KEY / EXT-X-MAP /
//                  EXT-X-MEDIA / I-frame URIs.
//   3. SEGMENT PROXY — streams every segment byte-for-byte (never buffered)
//      with the channel's stored Cookie + User-Agent.
//
// URL SCHEME (all segment references stay ABSOLUTE so any player works):
//   ${BASE}/api/ch/by-url/manifest[.mpd|.m3u8]?u=<encodeURIComponent(url)>
//       The APP's primary contract — resolves the channel by its EXACT
//       playlist URL. Unknown URLs fall through to the generic passthrough
//       (below) so every Live TV stream keeps working through this proxy.
//   ${BASE}/api/ch/:id/manifest[.mpd|.m3u8]
//       Same, addressed by the stable channel id (sha256(url) first 16 hex).
//   ${BASE}/api/ch/:id/u/<base64url(absolute segment url)>
//   ${BASE}/api/ch/:id/dash/<base64url(prefix)>/<rest…>   ($ tokens survive)
//   ${BASE}/api/ch/:id/seg/<path…>                        (manifest-dir join)
//       Segment shapes produced by the DASH/HLS rewriter (:id = channel).
//   ${BASE}/api/g/u/<b64>  ·  ${BASE}/api/g/dash/<b64dir>/<rest>
//       The GENERIC (no-channel) shapes used when a URL is not in the
//       synced playlist (e.g. the app's fresh-signed builtin streams).
//   ${BASE}/api/fetch?u=<enc>
//       Generic passthrough: fetches with the host's required headers and —
//       when the response IS a manifest — rewrites it with the /api/g scheme.
//
// SECURITY
//   * Every proxied URL must be http(s) and must NOT point at a private/
//     loopback/link-local address or a bare IP literal (SSRF guard).
//   * Host policy is UNIVERSAL by default: SEGMENT_HOST_ALLOWLIST defaults
//     to `*` — any public DNS host may be proxied (Jio, Sony, Hotstar,
//     Akindi, …). Set the env var to explicit suffixes to restrict it; the
//     SSRF guard keeps this from ever becoming an internal-network relay.
//   * Client-supplied Cookie/X-Livetv-Cookie headers are IGNORED — the proxy
//     injects its own freshly-synced credentials (the app's DB cookie can be
//     up to 6h stale; this one never is).
//
// ENV
//   PORT                    default 8080
//   PLAYLIST_URL            default https://plugxvipplaylist.lovable.app/api/playlist
//   SYNC_INTERVAL_HOURS     default 5 (cookies expire every 6h)
//   PUBLIC_BASE_URL         optional — public https base (Render injects the
//                           real host per request; set only behind a fixed domain)
//   SEGMENT_HOST_ALLOWLIST  default jio.com,jiocinema.com
//   DEFAULT_JIO_REFERER     default https://jioplus2plugx.lovable.app/
//   UPSTREAM_TIMEOUT_MS     default 15000
//
// Node.js >= 18 (global fetch). Only dependency: express@4.
// ============================================================================

'use strict';

const express = require('express');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const PLAYLIST_URL = process.env.PLAYLIST_URL || 'https://plugxvipplaylist.lovable.app/api/playlist';
const SYNC_INTERVAL_HOURS = Number.parseFloat(process.env.SYNC_INTERVAL_HOURS || '5');
const UPSTREAM_TIMEOUT_MS = Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS || '15000', 10);
const DEFAULT_JIO_REFERER = process.env.DEFAULT_JIO_REFERER || 'https://jioplus2plugx.lovable.app/';
/**
 * 2026-11 round 37 — UNIVERSAL by default: `*` lets ANY public DNS host be
 * proxied (Jio, Sony, Hotstar, Akindi, …), so one deployment serves every
 * geo-blocked playlist. SSRF protection is UNCHANGED (no private/loopback/
 * link-local targets, no bare IP literals). Set SEGMENT_HOST_ALLOWLIST to
 * explicit suffixes (e.g. `jio.com,hotstar.com`) to restrict the proxy.
 */
const HOST_ALLOWLIST = (process.env.SEGMENT_HOST_ALLOWLIST || '*')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const ALLOW_ANY_HOST = HOST_ALLOWLIST.includes('*');
/** Background re-sync cooldown after an upstream auth failure (round 37). */
const AUTO_RESYNC_COOLDOWN_MS = 5_000;
/** Upstream statuses that mean the playlist credentials went stale. */
const AUTH_FAILURE_STATUSES = new Set([401, 403, 451]);

/** A Jio app User-Agent (the playlist's own EXTVLCOPT value, as fallback). */
const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';

/**
 * Per-CDN Referer the upstream requires (mirrors the app's live-tv map).
 * Unknown hosts get NO Referer/Origin at all — a wrong Referer breaks more
 * providers than a missing one (round 37: the old code fell back to the
 * Jio referer for EVERY host, which hotstar/sonyliv servers reject).
 */
const REFERER_BY_HOST = [
  { suffix: 'jio.com', referer: DEFAULT_JIO_REFERER },
  { suffix: 'jiocinema.com', referer: 'https://www.jiocinema.com/' },
  { suffix: 'hotstar.com', referer: 'https://www.hotstar.com/' },
  { suffix: 'slivcdn.com', referer: 'https://www.sonyliv.com/' },
  { suffix: 'premiumplugx.com', referer: 'https://premiumplugx.com/' },
  { suffix: 'akindi.lovable.app', referer: 'https://akindi.lovable.app/' }
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const b64u = {
  enc: (s) => Buffer.from(s, 'utf8').toString('base64url'),
  dec: (s) => {
    try {
      const out = Buffer.from(String(s), 'base64url').toString('utf8');
      return out ? out : null;
    } catch {
      return null;
    }
  }
};

function refererForHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  for (const entry of REFERER_BY_HOST) {
    if (host === entry.suffix || host.endsWith('.' + entry.suffix)) return entry.referer;
  }
  return null;
}

/** The playlist URL is stored WITHOUT its `|…` player-options pipe section. */
function normalizePlaylistUrl(raw) {
  const pipeIndex = String(raw || '').indexOf('|');
  const url = (pipeIndex >= 0 ? raw.slice(0, pipeIndex) : raw).trim();
  return url || null;
}

function safeHostOf(urlStr) {
  try {
    return new URL(urlStr).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // any bare IPv4 is refused
  if (h.includes(':')) return true; // any bare IPv6 literal is refused (round 37)
  return false;
}

function hostAllowed(urlStr, entry) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  if (isPrivateHost(host)) return false;
  if (entry && safeHostOf(entry.url) === host) return true; // the channel's own CDN
  // Round 37 — universal mode: any public DNS host is proxied (the SSRF
  // guards above are the control). An explicit suffix list restricts it.
  if (ALLOW_ANY_HOST) return true;
  return HOST_ALLOWLIST.some((sfx) => host === sfx || host.endsWith('.' + sfx));
}

/** Resolve a (possibly relative) URI against a base — null when unsafe. */
function resolveAgainst(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Playlist parsing + in-memory store
// ---------------------------------------------------------------------------

/**
 * One synced channel:
 *   id       stable sha256(url)[:16]
 *   url      the https manifest URL (pipe section stripped)
 *   name/logo/group/tvgId    display metadata (for /playlist.m3u)
 *   cookie   #EXTHTTP {"cookie": …}       — null when absent
 *   ua       #EXTVLCOPT http-user-agent   — null → DEFAULT_UA
 *   referer  #EXTVLCOPT http-referrer     — null → refererForHost(url)
 *   keys     ClearKey pairs from #KODIPROP license_key (kid:key,…)
 */
function parsePlaylist(text) {
  const lines = String(text || '').split(/\r?\n/);
  const channels = [];

  let pending = null;
  const flush = () => {
    if (pending && pending.url) channels.push(pending);
    pending = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      flush();
      const commaIndex = line.indexOf(',');
      const attrPart = commaIndex >= 0 ? line.slice(0, commaIndex) : line;
      const title = commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : '';
      const attrs = {};
      const attrRe = /([\w-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRe.exec(attrPart)) !== null) attrs[m[1]] = m[2];
      pending = {
        url: null,
        name: title || attrs['tvg-name'] || '',
        logo: attrs['tvg-logo'] || null,
        group: attrs['group-title'] || null,
        tvgId: attrs['tvg-id'] || null,
        cookie: null,
        ua: null,
        referer: null,
        keys: []
      };
      continue;
    }
    if (!pending) continue;

    if (line.startsWith('#KODIPROP:')) {
      const body = line.slice('#KODIPROP:'.length);
      const eq = body.indexOf('=');
      if (eq > 0) {
        const name = body.slice(0, eq).trim();
        const value = body.slice(eq + 1).trim();
        if (name === 'inputstream.adaptive.license_key') {
          // kid:key,kid:key,… — KEEP EVERY PAIR (video + audio representations
          // carry DIFFERENT keys; decrypting only the first kills audio).
          for (const pair of value.split(',')) {
            const colon = pair.indexOf(':');
            if (colon > 0) {
              const keyId = pair.slice(0, colon).trim();
              const key = pair.slice(colon + 1).trim();
              if (keyId && key) pending.keys.push({ keyId, key });
            }
          }
        }
      }
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      const body = line.slice('#EXTVLCOPT:'.length);
      const eq = body.indexOf('=');
      if (eq > 0) {
        const name = body.slice(0, eq).trim().toLowerCase();
        const value = body.slice(eq + 1).trim();
        if (name === 'http-user-agent' && value) pending.ua = value;
        else if (name === 'http-referrer' && value) pending.referer = value;
      }
      continue;
    }
    if (line.startsWith('#EXTHTTP:')) {
      const body = line.slice('#EXTHTTP:'.length);
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed.cookie === 'string' && parsed.cookie.trim()) {
          pending.cookie = parsed.cookie.trim();
        }
      } catch {
        /* malformed EXTHTTP — the channel plays cookie-less (honest best effort) */
      }
      continue;
    }
    if (line.startsWith('#')) continue; // every other directive is ignored

    // A non-comment line: the stream URL for the pending entry.
    const url = normalizePlaylistUrl(line);
    if (url && /^https?:\/\//i.test(url)) pending.url = url;
    else flush();
  }
  flush();

  const byUrl = new Map();
  const byId = new Map();
  let dash = 0;
  let hls = 0;
  for (const ch of channels) {
    if (byUrl.has(ch.url)) continue; // first listing wins (identical URLs)
    const entry = {
      ...ch,
      id: crypto.createHash('sha256').update(ch.url).digest('hex').slice(0, 16)
    };
    byUrl.set(entry.url, entry);
    byId.set(entry.id, entry);
    if (/\.mpd($|\?)/i.test(entry.url)) dash += 1;
    else if (/\.m3u8($|\?)/i.test(entry.url)) hls += 1;
  }
  return { byUrl, byId, dash, hls, total: byUrl.size };
}

const store = {
  byUrl: new Map(),
  byId: new Map(),
  total: 0,
  dash: 0,
  hls: 0,
  lastSyncAt: null,
  lastSyncOk: false,
  lastError: null,
  syncing: null, // in-flight sync promise (mutex)
  lastAutoResyncAt: 0
};

async function syncPlaylist() {
  if (store.syncing) return store.syncing; // collapse concurrent calls
  store.syncing = (async () => {
    try {
      const res = await fetchWithTimeout(PLAYLIST_URL, {
        headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*' }
      });
      if (!res.ok) throw new Error(`playlist fetch HTTP ${res.status}`);
      const text = await res.text();
      if (!text.includes('#EXTM3U')) throw new Error('playlist body is not an M3U');
      const parsed = parsePlaylist(text);
      if (parsed.total === 0) throw new Error('parsed zero channels — refusing to swap');
      store.byUrl = parsed.byUrl;
      store.byId = parsed.byId;
      store.total = parsed.total;
      store.dash = parsed.dash;
      store.hls = parsed.hls;
      store.lastSyncAt = new Date().toISOString();
      store.lastSyncOk = true;
      store.lastError = null;
      console.log(`[sync] OK ${parsed.total} channels (${parsed.dash} dash, ${parsed.hls} hls)`);
      return { ok: true, total: parsed.total, dash: parsed.dash, hls: parsed.hls };
    } catch (err) {
      store.lastSyncOk = false;
      store.lastError = String((err && err.message) || err);
      console.error('[sync] FAILED:', store.lastError, '— keeping the previous snapshot');
      return { ok: false, error: store.lastError };
    } finally {
      store.syncing = null;
    }
  })();
  return store.syncing;
}

/**
 * 2026-11 round 37 — FIRE-AND-FORGET background re-sync when an upstream
 * auth failure (401/403/451) is observed. NEVER awaited by a request
 * handler: the previous code `await`ed the full playlist re-sync INSIDE the
 * failing request — blocking the player's manifest/segment fetch for
 * seconds while the whole M3U was downloaded + parsed, which timed the
 * player out. Now the request is answered IMMEDIATELY (403 + retryable) and
 * the client player retries after a short delay — by then the background
 * re-sync has usually swapped in fresh cookies. The cooldown (5s) stops a
 * dead channel from spamming the playlist host.
 */
function scheduleAuthResync(reason) {
  const now = Date.now();
  if (now - store.lastAutoResyncAt < AUTO_RESYNC_COOLDOWN_MS) return;
  store.lastAutoResyncAt = now;
  console.log(`[sync] upstream auth failure (${reason}) — background re-sync scheduled`);
  syncPlaylist().catch(() => {});
}

// ---------------------------------------------------------------------------
// Upstream fetch with the channel's STORED credentials
// ---------------------------------------------------------------------------

function upstreamHeaders(entry, extra) {
  const host = safeHostOf(entry ? entry.url : '');
  // Round 37 — the referer map decides; an UNKNOWN host gets NO Referer/
  // Origin at all (spoofing the Jio origin at hotstar/sonyliv breaks them).
  const referer = (entry && entry.referer) || refererForHost(host);
  const headers = {
    'User-Agent': (entry && entry.ua) || DEFAULT_UA,
    Accept: '*/*',
    ...extra
  };
  if (referer) {
    headers.Referer = referer;
    headers.Origin = referer.replace(/\/$/, '');
  }
  // The proxy ALWAYS uses its own synced cookie — client-supplied cookies
  // (up to 6h stale in the app DB) are never forwarded.
  if (entry && entry.cookie) headers.Cookie = entry.cookie;
  return headers;
}

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal, redirect: 'follow' })
    .finally(() => clearTimeout(timer));
}

/**
 * Fetch an upstream URL with the channel's STORED credentials.
 *
 * 2026-11 round 37 — on an auth failure (401/403/451) the request is NOT
 * retried here and NO synchronous re-sync runs (that blocked the player for
 * seconds and timed it out). The response is returned AS-IS with the
 * `authFailure` marker; the caller answers 403 + retryable immediately and
 * the background re-sync (5s cooldown, fire-and-forget) refreshes the
 * cookies — the client player's own retry then gets the fresh credentials.
 */
async function fetchUpstream(url, entry) {
  const res = await fetchWithTimeout(url, { headers: upstreamHeaders(entry) });
  if (AUTH_FAILURE_STATUSES.has(res.status)) {
    scheduleAuthResync(`HTTP ${res.status} from ${safeHostOf(url) || 'unknown'}`);
    res.authFailure = true;
  }
  // Redirect safety: a hop off the allowed host set is refused.
  if (res.url && res.url !== url && !hostAllowed(res.url, entry)) {
    throw new Error(`upstream redirected to a non-allowlisted host: ${safeHostOf(res.url)}`);
  }
  return res;
}

/**
 * Answer an upstream auth failure FAST: 403 + a retryable hint. The client
 * player retries after a short delay; the background re-sync (5s cooldown)
 * has fresh cookies ready by then.
 */
function authFailureResponse(res, upstream) {
  res.status(403).json({
    error: 'upstream_auth_failure',
    upstreamStatus: upstream.status,
    retryable: true,
    retryAfterMs: AUTO_RESYNC_COOLDOWN_MS
  });
}

// ---------------------------------------------------------------------------
// Manifest rewriting
// ---------------------------------------------------------------------------

/** Absolute proxy base for a request (PUBLIC_BASE_URL wins when set). */
function requestBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function stripWidevinePlayready(xml) {
  // The uuid ContentProtection tags make players demand the Widevine/PlayReady
  // CDM. Playback here is ClearKey (the app configures Shaka's clearKeys from
  // the playlist's #KODIPROP keys), so the vendor tags are stripped while the
  // generic mp4protection tag is KEPT (the player must still see CENC).
  const uuids = [
    'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', // Widevine
    '9a04f079-9840-4286-ab92-e65be0885f95' // PlayReady
  ];
  let out = xml;
  for (const uuid of uuids) {
    out = out.replace(
      new RegExp(`<ContentProtection\\b[^>]*${uuid}[^>]*>[\\s\\S]*?</ContentProtection>`, 'gi'),
      ''
    );
    out = out.replace(new RegExp(`<ContentProtection\\b[^>]*${uuid}[^>]*/>`, 'gi'), '');
  }
  return out;
}

/** Everything up to and including the last '/'. */
function directoryOf(abs) {
  const i = abs.lastIndexOf('/');
  return i >= 0 ? abs.slice(0, i + 1) : abs;
}

/**
 * The DIRECTORY prefix a DASH template resolves against, for concat-replay by
 * the segment handler: storedPrefix + (token-substituted tail) must equal the
 * original RFC-3986 resolution. An empty static prefix means the manifest's
 * own directory; a non-empty one resolves against the manifest URL.
 */
function dashDirFor(rawPrefix, manifestUrl) {
  if (rawPrefix === '') return directoryOf(manifestUrl);
  const abs = resolveAgainst(rawPrefix, manifestUrl);
  return abs ? directoryOf(abs) : null;
}

/**
 * DASH rewriter.
 *  - <BaseURL>        → ${BASE}/…/dash/<b64(directory of the resolved base)>/
 *  - SegmentTemplate media/initialization, SegmentURL media,
 *    SegmentList/Initialization sourceURL
 *      · values WITH $…$ tokens → the resolved DIRECTORY prefix is b64'd and
 *        the token tail stays PLAIN TEXT after it
 *        (${BASE}/…/dash/<b64dir>/$RepresentationID$/seg.m4s) — the player
 *        substitutes the tokens first, then the proxy concatenates dir+tail.
 *        A static filename prefix ('video$Rep$.m4s') is kept in the tail.
 *      · static values → ${BASE}/…/u/<b64(absolute url)>
 */
function rewriteMpd(xml, entry, base, segBase) {
  const manifestUrl = entry.url;
  const chBase = segBase || `${base}/api/ch/${entry.id}`;

  const segmentUrl = (raw) => {
    const abs = resolveAgainst(raw, manifestUrl);
    if (!abs) return null;
    return `${chBase}/u/${b64u.enc(abs)}`;
  };

  // 1. BaseURL elements.
  let out = xml.replace(/<BaseURL(\s[^>]*)?>([\s\S]*?)<\/BaseURL>/gi, (m, attrs, content) => {
    const dir = dashDirFor(content.trim(), manifestUrl);
    return dir ? `<BaseURL${attrs || ''}>${chBase}/dash/${b64u.enc(dir)}/</BaseURL>` : m;
  });

  // 2. Segment-reference attributes inside the DASH segment elements.
  out = out.replace(
    /<(SegmentTemplate|SegmentURL|SegmentList|Initialization)\b([^>]*)>/gi,
    (m, tag, attrs) => {
      const rewritten = attrs.replace(
        /\b(media|initialization|sourceURL)="([^"]*)"/gi,
        (am, name, value) => {
          if (!value) return am;
          const dollar = value.indexOf('$');
          if (dollar >= 0) {
            const prefix = value.slice(0, dollar);
            const dir = dashDirFor(prefix, manifestUrl);
            if (!dir) return am;
            // A static FILENAME prefix (no trailing '/') rides in the tail:
            // resolve('video$Rep$.m4s') = dir + 'video' + substituted tail.
            const namePrefix = prefix === ''
              ? ''
              : (resolveAgainst(prefix, manifestUrl) || '').slice(dir.length);
            return `${name}="${chBase}/dash/${b64u.enc(dir)}/${namePrefix}${value.slice(dollar)}"`;
          }
          const proxied = segmentUrl(value);
          return proxied ? `${name}="${proxied}"` : am;
        }
      );
      return `<${tag}${rewritten}>`;
    }
  );

  return stripWidevinePlayready(out);
}

/** HLS rewriter — variant/segment lines + URI="…" attributes. */
function rewriteHls(body, entry, base, segBase) {
  const chBase = segBase || `${base}/api/ch/${entry.id}`;
  const segmentUrl = (raw) => {
    const abs = resolveAgainst(raw, entry.url);
    if (!abs) return null;
    return `${chBase}/u/${b64u.enc(abs)}`;
  };
  return body
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        // EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA / I-FRAME-STREAM-INF URIs.
        return line.replace(/URI="([^"]+)"/g, (m, uri) => {
          const proxied = segmentUrl(uri);
          return proxied ? `URI="${proxied}"` : m;
        });
      }
      // A bare URI line (media segment or variant playlist).
      const proxied = segmentUrl(t);
      return proxied || line;
    })
    .join('\n');
}

function manifestFormatFor(url, body) {
  if (/\.mpd($|\?)/i.test(url)) return 'dash';
  if (/\.m3u8($|\?)/i.test(url)) return 'hls';
  const head = String(body || '').slice(0, 256);
  if (/^\s*<\?xml|<MPD\b/i.test(head)) return 'dash';
  if (/^\s*#EXTM3U/.test(head)) return 'hls';
  return null;
}

// ---------------------------------------------------------------------------
// Streaming segment delivery
// ---------------------------------------------------------------------------

async function streamUpstream(req, res, url, entry) {
  if (!hostAllowed(url, entry)) {
    res.status(403).json({ error: 'host_not_allowed' });
    return;
  }
  let upstream;
  try {
    upstream = await fetchUpstream(url, entry);
  } catch (err) {
    console.error(`[segment] fetch failed: ${safeHostOf(url)} — ${String((err && err.message) || err)}`);
    if (!res.headersSent) res.status(502).json({ error: 'upstream_fetch_failed' });
    return;
  }
  if (!upstream.ok && upstream.status !== 206) {
    if (!res.headersSent) {
      // Round 37 — auth failures answer FAST (403 + retryable, the client
      // player retries after a short delay; the background re-sync has
      // fresh cookies ready by then). Never block on a re-sync here.
      if (upstream.authFailure) authFailureResponse(res, upstream);
      else res.status(upstream.status).json({ error: 'upstream_error', status: upstream.status });
    }
    return;
  }
  sendUpstreamResponse(res, upstream);
}

/** Pipe an ALREADY-FETCHED upstream response to the client (never buffered). */
function sendUpstreamResponse(res, upstream) {
  const headers = {};
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  headers['Access-Control-Allow-Origin'] = '*';
  headers['Cache-Control'] = 'public, max-age=5';
  res.status(upstream.status === 206 ? 206 : 200);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (!upstream.body) {
    res.end();
    return;
  }
  // STREAM — never buffer a whole segment. `pipeline` (round 37) tears the
  // stream down properly on EITHER side's error/premature close, where a
  // bare .pipe() could leak the upstream socket.
  const reader = Readable.fromWeb(upstream.body);
  pipeline(reader, res, () => {
    /* ended, errored, or the client went away — the sockets are cleaned up */
  });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Origin, Referer, X-Livetv-Cookie');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.get('/', (req, res) => {
  res.type('text/plain').send(
    `Mavero Indian Proxy — ${store.total || 'syncing…'} channels\n` +
      `playlist: ${PLAYLIST_URL}\n` +
      `last sync: ${store.lastSyncAt || 'never'} (${store.lastSyncOk ? 'ok' : `failed: ${store.lastError}`})\n`
  );
});

app.get('/health', (req, res) => {
  res.json({
    ok: store.lastSyncOk,
    channels: store.total,
    dash: store.dash,
    hls: store.hls,
    lastSyncAt: store.lastSyncAt,
    lastError: store.lastError,
    playlistUrl: PLAYLIST_URL,
    syncIntervalHours: SYNC_INTERVAL_HOURS
  });
});

async function syncHandler(req, res) {
  const result = await syncPlaylist();
  res.status(result.ok ? 200 : 502).json(result);
}
app.get('/sync', syncHandler);
app.post('/sync', syncHandler);

/** Rewritten M3U for EXTERNAL players (VLC/TiviMate) — ids are stable. */
app.get('/playlist.m3u', (req, res) => {
  if (store.total === 0) {
    res.status(503).json({ error: 'playlist_not_synced_yet' });
    return;
  }
  const base = requestBase(req);
  const lines = ['#EXTM3U'];
  for (const entry of store.byUrl.values()) {
    const ext = /\.mpd($|\?)/i.test(entry.url) ? '.mpd' : '.m3u8';
    const attrs =
      ` tvg-id="${entry.tvgId || ''}"` +
      ` tvg-name="${entry.name || ''}"` +
      ` tvg-logo="${entry.logo || ''}"` +
      ` group-title="${entry.group || ''}"`;
    lines.push(`#EXTINF:-1${attrs},${entry.name || entry.id}`);
    // ClearKey pairs survive (external players decrypt locally); Cookie/UA
    // are intentionally DROPPED — this proxy injects its own fresh ones.
    if (entry.keys.length > 0) {
      lines.push('#KODIPROP:inputstream.adaptive.license_type=clearkey');
      lines.push(`#KODIPROP:inputstream.adaptive.license_key=${entry.keys.map((k) => `${k.keyId}:${k.key}`).join(',')}`);
    }
    lines.push(`${base}/api/ch/${entry.id}/manifest${ext}`);
  }
  res.type('audio/x-mpegurl').send(lines.join('\n') + '\n');
});

/** Resolve `:id`- or `?u=`-addressed channels into a playlist entry. */
function resolveEntry(req) {
  const byUrlParam = typeof req.query.u === 'string' ? normalizePlaylistUrl(req.query.u) : null;
  if (byUrlParam) {
    const hit = store.byUrl.get(byUrlParam);
    if (hit) return { entry: hit, mode: 'channel' };
    // Unknown URL → GENERIC mode: still proxied (host-allowlisted) with the
    // host's mapped referer — the fresh-signed builtin streams land here.
    return { entry: { url: byUrlParam, id: 'g', keys: [], cookie: null, ua: null, referer: null }, mode: 'generic' };
  }
  const id = String(req.params.id || '');
  const entry = store.byId.get(id);
  if (entry) return { entry, mode: 'channel' };
  return { entry: null, mode: 'unknown' };
}

for (const path of ['/api/ch/by-url/manifest', '/api/ch/by-url/manifest.mpd', '/api/ch/by-url/manifest.m3u8']) {
  app.get(path, handleManifest);
}
app.get('/api/ch/:id/manifest', handleManifest);
app.get('/api/ch/:id/manifest.mpd', handleManifest);
app.get('/api/ch/:id/manifest.m3u8', handleManifest);

async function handleManifest(req, res) {
  if (store.total === 0) await syncPlaylist(); // first-request bootstrap
  const { entry, mode } = resolveEntry(req);
  if (!entry) {
    res.status(404).json({ error: 'channel_not_found', hint: 'wait for the next playlist sync or POST /sync' });
    return;
  }
  const wantsHls = req.path.endsWith('.m3u8');
  const wantsDash = req.path.endsWith('.mpd');

  let upstream;
  try {
    upstream = await fetchUpstream(entry.url, mode === 'channel' ? entry : null);
  } catch (err) {
    console.error(`[manifest] fetch failed: ${safeHostOf(entry.url)} — ${String((err && err.message) || err)}`);
    res.status(502).json({ error: 'upstream_fetch_failed' });
    return;
  }
  if (!upstream.ok) {
    // Round 37 — fast 403 + retryable on stale credentials (no blocking
    // re-sync inside the request; see fetchUpstream).
    if (upstream.authFailure) authFailureResponse(res, upstream);
    else res.status(upstream.status).json({ error: 'upstream_error', status: upstream.status });
    return;
  }
  const body = await upstream.text();
  const format = wantsDash ? 'dash' : wantsHls ? 'hls' : manifestFormatFor(entry.url, body);
  if (!format) {
    res.status(502).json({ error: 'not_a_manifest' });
    return;
  }
  const base = requestBase(req);
  // GENERIC mode (URL not in the synced playlist) rewrites onto the /api/g
  // scheme — the channel-scoped /api/ch/:id/… shapes need a synced entry.
  const segBase = mode === 'channel' ? null : `${base}/api/g`;
  const rewritten = format === 'dash' ? rewriteMpd(body, entry, base, segBase) : rewriteHls(body, entry, base, segBase);
  res.setHeader('Content-Type', format === 'dash' ? 'application/dash+xml' : 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store'); // manifests carry rotating tokens
  res.send(rewritten);
}

// --- Segments: channel-scoped ------------------------------------------------

/** /api/ch/:id/u/<b64(absolute url)> */
app.get('/api/ch/:id/u/:b64', async (req, res) => {
  const entry = store.byId.get(String(req.params.id || ''));
  if (!entry) {
    res.status(404).json({ error: 'channel_not_found' });
    return;
  }
  const url = b64u.dec(req.params.b64);
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: 'bad_segment_ref' });
    return;
  }
  await streamUpstream(req, res, url, entry);
});

/**
 * /api/ch/:id/dash/<b64dir>/<rest…> — the DASH shape. When the first path
 * piece is NOT a b64dir, the whole tail joins the manifest's directory
 * (plain-file form: /api/ch/:id/dash/vid0/ch-1.m4s).
 */
app.get('/api/ch/:id/dash/*', async (req, res) => {
  const entry = store.byId.get(String(req.params.id || ''));
  if (!entry) {
    res.status(404).json({ error: 'channel_not_found' });
    return;
  }
  const tail = req.params[0] || '';
  const slash = tail.indexOf('/');
  let url = null;
  if (slash > 0) {
    const prefix = b64u.dec(tail.slice(0, slash));
    if (prefix && /^https?:\/\//i.test(prefix)) url = prefix + tail.slice(slash + 1);
  }
  if (!url) url = resolveAgainst(tail, entry.url);
  if (!url) {
    res.status(400).json({ error: 'bad_segment_ref' });
    return;
  }
  await streamUpstream(req, res, url, entry);
});

/** /api/ch/:id/seg/<path…> and /api/ch/:id/<quality>/<seg.ts> — manifest-dir join. */
async function channelPathSegment(req, res) {
  const entry = store.byId.get(String(req.params.id || ''));
  if (!entry) {
    res.status(404).json({ error: 'channel_not_found' });
    return;
  }
  const tail = req.params[0] || '';
  const url = resolveAgainst(tail, entry.url);
  if (!url) {
    res.status(400).json({ error: 'bad_segment_ref' });
    return;
  }
  await streamUpstream(req, res, url, entry);
}
app.get('/api/ch/:id/seg/*', channelPathSegment);
// Registered LAST among channel routes: any other /api/ch/:id/… path is the
// spec's plain /:quality/:seg.ts form.
app.get(['/api/ch/:id/*', '/api/ch/:id'], channelPathSegment);

// --- Segments: generic (fresh-signed / unknown-URL) shapes -------------------

app.get('/api/g/u/:b64', async (req, res) => {
  const url = b64u.dec(req.params.b64);
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: 'bad_segment_ref' });
    return;
  }
  await streamUpstream(req, res, url, null);
});

app.get('/api/g/dash/*', async (req, res) => {
  const tail = req.params[0] || '';
  const slash = tail.indexOf('/');
  if (slash <= 0) {
    res.status(400).json({ error: 'bad_segment_ref' });
    return;
  }
  const prefix = b64u.dec(tail.slice(0, slash));
  if (!prefix || !/^https?:\/\//i.test(prefix)) {
    res.status(400).json({ error: 'bad_segment_ref' });
    return;
  }
  await streamUpstream(req, res, prefix + tail.slice(slash + 1), null);
});

/**
 * Generic passthrough — fetches the URL with the host's mapped credentials.
 * When the response IS a manifest it is REWRITTEN onto the /api/g scheme
 * (this is the app's fresh-signed builtin stream contract).
 */
app.get('/api/fetch', async (req, res) => {
  const url = normalizePlaylistUrl(String(req.query.u || ''));
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: 'bad_url' });
    return;
  }
  if (!hostAllowed(url, null)) {
    res.status(403).json({ error: 'host_not_allowed' });
    return;
  }
  let upstream;
  try {
    upstream = await fetchUpstream(url, null);
  } catch (err) {
    console.error(`[fetch] failed: ${safeHostOf(url)} — ${String((err && err.message) || err)}`);
    res.status(502).json({ error: 'upstream_fetch_failed' });
    return;
  }
  if (!upstream.ok) {
    // Round 37 — fast 403 + retryable on stale credentials.
    if (upstream.authFailure) authFailureResponse(res, upstream);
    else res.status(upstream.status).json({ error: 'upstream_error', status: upstream.status });
    return;
  }
  const contentType = String(upstream.headers.get('content-type') || '');
  const body = await upstream.text();
  // Extension first, then body sniff; a manifest content-type on an
  // unparseable body still lands here as a generic byte stream.
  const format = manifestFormatFor(url, body);
  if (!format && !/dash\+xml|mpegurl/i.test(contentType)) {
    // Not a manifest — stream the ALREADY-FETCHED bytes (no second fetch).
    sendUpstreamResponse(res, upstream);
    return;
  }
  if (!format) {
    res.status(502).json({ error: 'not_a_manifest' });
    return;
  }
  const base = requestBase(req);
  const entry = { url, id: 'g', keys: [], cookie: null, ua: null, referer: null };
  const rewritten = format === 'dash' ? rewriteMpd(body, entry, base, `${base}/api/g`) : rewriteHls(body, entry, base, `${base}/api/g`);
  res.setHeader('Content-Type', format === 'dash' ? 'application/dash+xml' : 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  res.send(rewritten);
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[indian-proxy] listening on :${PORT}`);
    console.log(`[indian-proxy] playlist: ${PLAYLIST_URL} (every ${SYNC_INTERVAL_HOURS}h)`);
    console.log(
      `[indian-proxy] hosts: ${ALLOW_ANY_HOST ? '* (any public DNS host — universal proxy)' : HOST_ALLOWLIST.join(', ')}`
    );
    syncPlaylist().then(() => {
      setInterval(() => {
        syncPlaylist();
      }, Math.max(SYNC_INTERVAL_HOURS, 0.5) * 3600_000).unref();
    });
  });
}

module.exports = { parsePlaylist, rewriteMpd, rewriteHls, manifestFormatFor, normalizePlaylistUrl, b64u, hostAllowed, upstreamHeaders };
