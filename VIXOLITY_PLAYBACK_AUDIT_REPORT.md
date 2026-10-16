# Vixolity HLS Playback — Evidence-Based Audit & Targeted Fix Report

Task: fix Vixolity playback based on the supplied Termux HTTP/HLS evidence — without
re-enabling anything blindly, without rewriting the player, and without any production
deployment or live-Supabase mutation.
Status: **audit complete, zero production-code changes required** — the client-side
routing is already correct; the confirmed hls.js blocker is upstream (provider CORS);
the CSP entries were already correct at HEAD and are live for static assets; one
deployment-layer CSP delivery gap is documented for review. New routing tests pin the
contract; browser-level evidence captured as far as the environment permits.

---

## 1. Baseline commit and working-tree state

- Branch `main` @ **0894a243e8073a895460c1faffe7bb13a4f13538** ("fix(providers,admin):
  production fix round — VidStuck .cc migration + event.source defense, …").
- `origin/main` in sync (fetched 2026-10-16; 0 ahead / 0 behind); working tree clean
  before this round's changes (mode-bit noise suppressed via `core.fileMode false`).
- **Deployment state (do-not-assume check, verified live):** production IS on Netlify
  (`server: Netlify`) and its static assets carry the current CSP **including
  `https://ha.vixolity.com`** in `media-src`/`connect-src` (verified on
  `/favicon.ico` and `/_app/immutable/entry/start.YLaxaVsM.js`) → the deployed
  netlify.toml includes commit `3f9a49d` (the commit that added the Vixolity CSP
  entries). `git diff 3f9a49d..0894a24 -- src/lib/components/player src/lib/client/player`
  touches only embed-path files (vidstuck adapter / post-message utils / PlayerShell
  resolver registration) — **the direct-HLS player code that serves Vixolity is
  byte-identical between the deployed build and HEAD**, so a browser test against
  production exercises HEAD's exact playback path.
- Read-only Supabase eligibility (verified 2026-10-16, prior round, unchanged since —
  no mutations performed in this round): Vixolity provider + source rows enabled and
  the URL contract verified end-to-end through the real resolver against the live
  config.

## 2. Root cause(s) — confirmed findings vs remaining hypotheses

### Confirmed finding A — upstream playlist CORS (provider-side; the hls.js blocker)

Independently re-verified from this environment (read-only GET, `Origin:
https://maveroweb.space`), matching the supplied Termux evidence exactly:

| Resource | Status | Content-Type | `Access-Control-Allow-Origin` |
|---|---|---|---|
| Master `https://ha.vixolity.com/vs/tt0903747/s1/e02` | 200 | `application/x-mpegURL` | **ABSENT** (`Vary: Origin` + `Access-Control-Allow-Methods` present) |
| 1080p variant `…/main_1080/index-v1-a1.gif` | 200 | `application/x-mpegURL` | **ABSENT** |
| Segment `https://hs1.nodedatastream.top/img/…/thumbnail-1-v1-a1.jpg` | 200 (plain) / 206 (Range) | `image/jpeg` (misleading) | `*` |
| Segment `https://hs1.storagegridlink.top/img/…/thumbnail-4-v1-a1.jpg` | 206 | `image/jpeg` | `*` |
| `OPTIONS` preflight on the master | 204 | — | **ABSENT** |

- First bytes of a "`.jpg`" segment: `47 40 00 10 …` — the MPEG-TS sync byte `0x47`;
  138,744 bytes downloaded. The `.jpg` name and `image/jpeg` type are camouflage; the
  payload is MPEG-TS (the user's "do not assume extension/content type establishes the
  format" note is confirmed).
- Consequence: **hls.js fails at its FIRST playlist request on every browser** — a
  CORS-mode fetch cannot read a response without ACAO. This is a provider-side
  requirement; no CSP entry, and no Mavero code change short of a forbidden proxy,
  can repair it.

### Confirmed finding B — CSP delivery gap (deployment layer; documented, NOT fixed this round)

- `netlify.toml` is the ONLY CSP source in the repo (no `_headers` file; no
  security-header emission anywhere in `src/` — `hooks.server.ts` sets none).
- Verified live on production: `netlify.toml` header rules apply to **static assets**
  (favicon + immutable JS bundles carry the full CSP) but **NOT to SvelteKit SSR
  responses** — `/`, `/discover?zz=<cache-buster>` and `/settings` return **no
  `Content-Security-Policy`** (and none of the other `/*` toml headers —
  Referrer-Policy/X-Frame-Options/Permissions-Policy), only Netlify's platform-default
  short HSTS. Probes were cache-busted (`fwd=miss`).
- Consequences, stated plainly:
  1. CSP is **not** what blocks Vixolity today — there is no browser-enforced document
     CSP on production pages at all (the browser run in §5 captured **zero** CSP
     violations).
  2. The intended CSP protections (including the Vixolity and Blue Velvet entries)
     never govern the actual pages until headers are emitted for SSR responses
     (e.g. from `hooks.server.ts`). That is a security-posture change touching every
     page — deliberately **not** bundled into this playback round; listed in §10 for
     approval.
  3. The netlify.toml comments citing live CSP-violation verifications describe
     behavior that is no longer observable for SSR documents on today's deploy.

### Confirmed finding C — client routing is already correct (no fix needed)

`PlayerViewport.wireHlsEngine` → `resolveDirectPlaybackMode(currentSource, url, video)`
→ `isHlsMediaSource` priority 1: `metadata.protocol === 'hls'` (stamped by the
Vixolity server adapter) → `supportsNativeHls(video) ? 'native' : 'hls-js'`. The
`<video>` element carries **no `crossorigin` attribute** (verified in the live DOM),
so native HLS loads are no-cors requests — the missing upstream ACAO does not apply to
them. A Vixolity-specific native preference would change nothing and was **not**
added; no global mode reordering was made (both pinned by tests, §8).

### Side-finding (out of scope, one line)

`api.theintrodb.org` (Skip Intro lookup) is CORS-blocked on production (browser
console error captured during the same run) — the upstream does not return ACAO for
the deployed origin. Separate upstream issue; not touched here.

### Remaining hypotheses (explicitly unverified)

- Whether Android Chrome's platform HLS player accepts the masked `image/jpeg`
  segment Content-Type — plausible YES (platform players follow the playlist's
  `CODECS`/structure and probe TS payloads, not segment MIME types; the 206 +
  `acao:*` serving is already confirmed), but **unverified on a real device**.
- Why the headless player element unmounts mid-observation (§5) — headless UI timing;
  no error surface, no bearing on real devices.

## 3. Exact files changed and why

| File | Change | Why |
|---|---|---|
| `scripts/vixolity_playback_routing_test.ts` | **NEW** (19 checks) | The HLS mode-selection contract had zero direct coverage: pins Vixolity → native on native-capable browsers / hls.js elsewhere, pins that the extensionless URL is classified ONLY via `metadata.protocol`, and pins NO global native preference (Blue Velvet + generic `.m3u8` still route hls.js on non-native browsers). |
| `package.json` | 1 line: the new suite registered in the `test` chain after `vixolity_provider_test` | Regression protection lives in the chain, not in ad-hoc runs. |
| `scripts/vixolity_browser_playback_verification.mjs` | **NEW** (evidence script, deliberately NOT in the `pnpm test` chain — needs internet + browser) | Reproduces the real browser playback path on the production watch page with the resolver response replaced by the documented resolver contract (no production endpoint hit, nothing written anywhere); captures mode selection, network, and console evidence. |
| `VIXOLITY_PLAYBACK_AUDIT_REPORT.md` | **NEW** (this report) | The evidence base the review needs. |

**Zero changes to `src/`, `netlify.toml`, or migrations.** The smallest safe fix for
Vixolity was: no code change — plus tests that make the routing contract immovable.

## 4. CSP changes — exact directives affected

**None this round — because the required state already exists at HEAD** (added in
`3f9a49d`, verified live on static assets). The exact directives carrying the Vixolity
origin:

- `media-src 'self' https://zcdn.bluevelvet.space https://ha.vixolity.com` — required
  for the native-HLS `<video src>` load (the path Android Chromium/Safari use).
- `connect-src 'self' https://*.supabase.co https://image.tmdb.org
  https://zcdn.bluevelvet.space https://ha.vixolity.com https://sub.vdrk.site
  https://api.theintrodb.org` — required for the hls.js XHR route.

No wildcards added; no existing entry removed; the existing
`vixolity_provider_test` §9 pins all of this (119 checks, green). The **deployment
delivery gap** for SSR documents is finding B (§2) — reported, not patched.

## 5. Native HLS or hls.js on the tested path? — browser-level evidence

Environment: headless desktop Chromium (Playwright) against the REAL production watch
page `https://maveroweb.space/watch/tv-show/1396/1/2` (Breaking Bad S1E2; page 200,
"Watching Breaking Bad — Mavero"). The resolver response was intercepted and fulfilled
with the EXACT SourceResult contract the real Vixolity resolver returns for this
episode (`https://ha.vixolity.com/vs/tt0903747/s1/e02`, `metadata.protocol: 'hls'`;
shape per `player-guards.isPlayablePlayerSource`) — the production resolve endpoint
was never reached (also avoids any demand-tracking write). Script:
`scripts/vixolity_browser_playback_verification.mjs`; raw JSON:
`.cache/vixolity_browser_evidence.json` (gitignored).

**Which path is selected:** on THIS build, `canPlayType('application/vnd.apple.mpegurl')`
returns `"maybe"` → **NATIVE mode** — observed structurally: the `<video>` element
carried `src="https://ha.vixolity.com/vs/tt0903747/s1/e02"` with **no `crossorigin`
attribute**, and the stream requests were media-element requests **without an `Origin`
header** (no-cors), chained master → 1080p variant → segments on BOTH segment hosts
(`206`, `acao:*`). On real desktop Chrome/Firefox (`canPlayType` returns `''`) the same
source routes to hls.js; on Android Chromium/Safari it routes native — all three cases
pinned by the new routing suite.

**Observed in the browser (Run A — Vixolity):**

- The native media path fetched and buffered the REAL stream: master 200 →
  `main_1080/index-v1-a1.gif` 200 → segments `206` from `hs1.nodedatastream.top` AND
  `hs1.storagegridlink.top`; the video element reached **`readyState=4`
  (HAVE_ENOUGH_DATA) at ~1.5 s** with the Vixolity manifest bound.
- **CORS-mode fetches were blocked with the exact console error:**
  `Access to fetch at 'https://ha.vixolity.com/vs/tt0903747/s1/e02' from origin
  'https://maveroweb.space' has been blocked by CORS policy: No
  'Access-Control-Allow-Origin' header is present on the requested resource.` —
  emitted by the cast-reachability probe (`probeMediaCastability`, `mode:'cors'`;
  cast is correctly disabled for this source). The identical blocking applies to the
  hls.js route on desktop browsers — same CORS-mode fetch, same missing header.
- **Zero CSP errors** on the page (consistent with finding B).
- `currentTime` did NOT advance (element paused; headless autoplay gate + the player
  element unmounting mid-observation).

**Positive control (Run B — CORS-open Mux test stream through the same real pipeline):**
master → variant → segments all fetched (`206`, `acao:*`), `readyState=4` observed in
the first run, **zero CORS/CSP errors** — the Mavero client pipeline (classification →
mode routing → media element) demonstrably loads a well-behaved HLS stream end-to-end
at the request level.

**Honest limits:** actual playback (advancing `currentTime`) was not observed in this
environment even for the positive control (headless autoplay + element timing), and
**Android verification remains pending** — no Android device exists here. What IS
proven at the browser level: the mode selection, the no-cors native request chain
pulling Vixolity's real media, the exact CORS console failure for any CORS-mode fetch,
and zero CSP interference.

### Manual Android Chrome checklist (the evidence still required)

1. Android Chrome → `https://maveroweb.space/watch/tv-show/1396/1/2`.
2. DevTools (remote debugging): confirm the resolver POST returns the Vixolity URL
   `https://ha.vixolity.com/vs/tt0903747/s1/e02` (after the admin re-enables the
   source if it is disabled).
3. Confirm `<video>` has `src=<manifest>` and NO `crossorigin` attribute (native mode).
4. Network tab: master + variant requests carry NO `Origin` header (media element);
   segments from `hs1.*` return 200/206.
5. Console: expect ZERO CSP violations and ZERO CORS violations on this path.
6. Start playback: `video.currentTime` must advance ≥ a few seconds; audio track
   (en/tr) and quality switches exercise the manifest's renditions.
7. Compare with the direct URL in the same browser (`…/vs/tt0903747/s1/e02`) — if the
   direct URL plays and the in-app path does not, capture the exact console/network
   difference.
8. Record any `media-src` CSP violation separately from CORS/decode errors (would
   indicate a policy override not seen in this audit).

## 6. Termux evidence and its limitations

The supplied Termux/curl matrix was **independently reproduced from this environment**
(§2 table) and treated as valid evidence for: reachability, playlist validity
(`#EXTM3U`, 1080p/480p variants, en/tr audio, subtitles), redirect-free serving, the
missing ACAO on both playlist hosts, the CORS-open segment hosts, and the TS-behind-
`.jpg` masking. **Its limitation — stated in the task and confirmed here — is that
curl does not enforce CORS:** the browser-level failure was therefore separately
reproduced (the console CORS error in §5), and curl's permissive segment results do
not by themselves prove playback. Termux evidence also cannot speak to native-HLS
device behavior — that stays with the §5 checklist.

## 7. Test commands and pass/fail results

| Command | Result | vs baseline |
|---|---|---|
| `pnpm check` | **0 errors / 5 warnings** | identical to baseline |
| `pnpm build` | **exit 0** (adapter-netlify) | identical to baseline |
| `pnpm test` (full chain) | green through every suite; stops at `mav_task2_episode_sheet_dom_qa.mjs` (Playwright strict-mode `.bulk-btn` ambiguity + its A2 assertion) | **pre-existing** — documented identical at baseline `219b058` and clean `3f9a49d` in the previous round; no `src/` file changed this round, so it cannot be new |
| post-chain `mav_phase1_season_chip_contract_test.mjs` | 32/32 | matches baseline protocol |
| NEW `vixolity_playback_routing_test` | **19/19** (runs inside the chain) | new |
| `vixolity_provider_test` | 119/119 (URL resolution movie+episode, eligibility, CSP pins) | unchanged, green |
| `bluevelvet_provider_test` | 128/128 | no Blue Velvet regression |

No test was deleted, weakened, or skipped; no unrelated test modified.

## 8. Remaining upstream CORS requirements

For **hls.js browsers** (desktop Chrome/Firefox and any browser without native HLS),
the provider must return on `ha.vixolity.com` (playlist + variant requests):

```
Access-Control-Allow-Origin: https://maveroweb.space   (or echo the Origin / use *)
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
```

until then hls.js fails at the master playlist with the captured console error and the
player's designed error/retry/switch-source screen is the correct degradation. The
segment hosts already serve `acao: *`. CSP permission (already present) does NOT
create these upstream headers. No proxy may be used to paper over this (house rule).

## 9. Deployment / data boundaries honored

- No production deploy was performed or requested.
- No live Supabase change: the browser harness intercepts the resolve request before
  it leaves the page (no demand-tracking write path is ever triggered); all other
  probes were read-only GETs/HEADs.
- No migration created (none needed).

## 10. Changes awaiting approval

1. `scripts/vixolity_playback_routing_test.ts` + its one-line `package.json`
   registration — the only functional change (test-only).
2. `scripts/vixolity_browser_playback_verification.mjs` — evidence harness (not in the
   test chain).
3. This report file.
4. **Decision requested (not implemented):** emit the CSP (and the other `/*`
   security headers) for SSR responses from the app (e.g. `hooks.server.ts`) — today
   `netlify.toml` header rules never reach SSR pages, so the intended CSP — including
   the Vixolity and Blue Velvet entries — is not enforced on any document. This is a
   site-wide security-posture change and deserves its own reviewed round.
5. **External action (provider):** the §8 CORS allowlist on `ha.vixolity.com` for
   hls.js browsers; plus real-device verification per the §5 checklist.
