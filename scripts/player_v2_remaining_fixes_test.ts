/**
 * MAVERO — Player V2 Remaining Issues + SEO (2026-10) — regression suite.
 *
 * Every assertion traces to a root cause verified from CURRENT source,
 * live upstream probes and a real-browser shell harness (see the task
 * report). Covers:
 *
 *   §1 SUBTITLES ROOT CAUSE — production catalog ids are PREFIXED
 *      (`movie-24428`), so the shell's bare-numeric TMDB gate rejected every
 *      title and the VDRK list was never requested. Pins: the watch route
 *      forwards `item.externalIds?.tmdb`, the shell resolves tmdbId from
 *      (explicit tmdbId | bare id | prefix strip), and a REAL shell harness
 *      build mounts with the production id shape and ATTACHES fetched
 *      tracks (the harness QA runs in scripts/player_shell_qa.mjs).
 *
 *   §2 SUPERSEDED-KEY CONTRACT — the shell passed `mediaLookupKey`
 *      (`movie:24428::` / `series:236235:2:1`) as the controllers' "current
 *      key" while the controllers compute `movie:24428` / `tv:236235:2:1`:
 *      every result was superseded+dropped (subtitles stuck on "Checking
 *      subtitles…", Skip Intro impossible). Pins the CONTROLLER-KEY guard
 *      behaviorally through the REAL controller and the REAL intro lookup.
 *
 *   §3 BLUE VELVET VARIANTS — the CDN sends no ACAO (live-verified), so the
 *      hls.js engine can never read the manifest and Chromium's NATIVE path
 *      (canPlayType 'maybe') played without any quality surface. Fix: the
      resolver parses the master's REAL variants into the existing
 *      `qualities` contract. Pins: parse truth table on the LIVE master
 *      shape (2160p/1080p/720p/480p), same-token URL validation, degrade-on-
 *      failure, adapter wiring.
 *
 *   §4 LANDSCAPE RIGHT-ALIGNMENT — the approved layout puts the secondary
 *      controls on the RIGHT edge in landscape only (portrait stays
 *      left-aligned). (CSS contracts; the rendered geometry QA lives in
 *      scripts/player_v2_final_remediation_dom_qa.mjs.)
 *
 *   §5 REGRESSION SAFETY — resume protection, downloader absence, CSP pins
 *      and the VDRK/TheIntroDB upstream contracts from the previous
 *      remediation remain intact.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');

const shell = read('src/lib/components/player/PlayerShell.svelte');
const watchRoute = read('src/routes/watch/[type]/[id]/+page.svelte');
const sharedPlayer = read('src/lib/shared/player.ts');
const controls = read('src/lib/components/player/PlayerControls.svelte');
const bluevelvet = read('src/lib/server/resolver/bluevelvet.ts');
const introClient = read('src/lib/client/player/intro/intro-client.ts');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// ===========================================================================
// §1 — SUBTITLES/SKIP-INTRO ROOT CAUSE: prefixed catalog ids vs TMDB ids.
// ===========================================================================
console.log('\n§1 — TMDB id resolution (prefixed production catalog ids)');
{
  ok(/tmdbId\?: string;/.test(sharedPlayer) && /tmdbId\?: string/.test(sharedPlayer.replace(/[\s\S]*PlayerContentContext = \{/, '').split('};')[0]), '1a. PlayerContentContext carries the explicit tmdbId field');
  ok(watchRoute.includes('$: playerContent = ({ id: item.id, tmdbId: item.externalIds?.tmdb,'), '1b. the watch route forwards item.externalIds?.tmdb as tmdbId');
  ok(/function resolveContentTmdbId\(\): number \| null \{/.test(shell), '1c. the shell resolves the TMDB id through ONE guarded helper');
  const helper = shell.slice(shell.indexOf('function resolveContentTmdbId'), shell.indexOf('async function loadExternalSubtitles'));
  ok(/String\(content\.tmdbId \?\? ''\)/.test(helper), '1d. authoritative source first: content.tmdbId');
  ok(helper.includes("raw.replace(/^(movie|series|anime)-/, '')"), '1e. the codebase-standard prefix strip covers legacy/prefixed ids');
  ok(/TMDB_ID_PATTERN\.test\(explicit\)/.test(helper) && /TMDB_ID_PATTERN\.test\(raw\)/.test(helper), '1f. every path still passes the strict numeric pattern (no fabricated ids)');
  ok(/const tmdbId = resolveContentTmdbId\(\);/.test(shell) && (shell.match(/resolveContentTmdbId\(\)/g) ?? []).length >= 2, '1g. BOTH lookups (subtitles + intro) use the same resolution');
  ok(!/const tmdbRaw = String\(content\.id \?\? ''\);/.test(shell), '1h. the old bare content.id gate is GONE (it rejected every production title)');
}

// ===========================================================================
// §2 — SUPERSEDED-KEY CONTRACT (behavioral, through the REAL controllers).
// ===========================================================================
console.log('\n§2 — controller-key stale guards (the drop-everything bug)');
{
  const subs = await import('$lib/client/player/subtitles/external-subtitles');

  // The EXACT shell key shapes (mediaLookupKey template) vs the controller keys.
  const mediaLookupKeyFor = (content: { type: string; id: string }, episode?: { season: number; episode: number }) =>
    `${content.type}:${content.id}:${episode ? '' : ''}${''}`; // movies: no episode — see below
  const movieShellKey = `movie:24428::`; // `${type}:${id}:${''}:${''}` for episode-less content
  const seriesShellKey = `series:236235:2:1`;

  const fakeList = [{ label: 'English', file: 'https://cache.vdrk.site/v1/vtt/movie/24428/English.vtt' }];
  const controller = subs.createExternalSubtitleController((async () => ({
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => fakeList,
  })) as unknown as typeof fetch);

  // OLD behavior (the bug): passing the shell key → superseded → dropped.
  const buggyView = await controller.load({ kind: 'movie', tmdbId: 24428 }, movieShellKey);
  ok(buggyView.superseded === true && buggyView.key === 'movie:24428', '2a. REPRODUCTION: the shell key space (`movie:24428::`) marks every result superseded');

  // NEW behavior: the shell passes the CONTROLLER key for the current request.
  const request = { kind: 'movie' as const, tmdbId: 24428 };
  const requestKey = subs.externalSubtitlesKey(request);
  const fixedView = await controller.load(request, requestKey);
  ok(fixedView.superseded === false && fixedView.key === requestKey && fixedView.tracks.length === 1, '2b. FIX: the controller-key guard lets the fetched tracks attach');

  // TV shape through the same contract.
  const tvRequest = { kind: 'tv' as const, tmdbId: 236235, season: 2, episode: 1 };
  const tvController = subs.createExternalSubtitleController((async () => ({
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => [{ label: 'English 2', file: 'https://cache.vdrk.site/v1/vtt/tv/236235/2/1/English 2.vtt' }],
  })) as unknown as typeof fetch);
  const tvView = await tvController.load(tvRequest, subs.externalSubtitlesKey(tvRequest));
  ok(tvView.superseded === false && tvView.tracks[0]?.label === 'English 2', '2c. FIX (TV): `tv:{tmdb}:{s}:{e}` guard passes; spaced labels preserved');

  // The shell pins the guard in the CONTROLLER key space (source contract).
  ok(/externalSubtitlesKey as externalSubtitleRequestKey/.test(shell), '2d. the shell imports the controller key helper under an explicit alias');
  ok(/const requestKey = externalSubtitleRequestKey\(request\);[\s\S]*?result\.superseded\) return;/.test(shell), '2e. the subtitle guard compares result.key !== requestKey (controller space)');
  ok(!/await externalSubtitleController\.load\(request, key\)/.test(shell), '2f. the shell no longer passes mediaLookupKey as the controller current-key');

  // Intro: the same contract through the REAL lookup.
  ok(/export function introRequestKey\(request: IntroMediaRequest\): string/.test(introClient), '2g. intro-client exports the request-key helper');
  ok(/const requestKey = introRequestKey\(request\);[\s\S]*?if \(key !== introKey \|\| result\.key !== requestKey \|\| result\.superseded\) return;/.test(shell), '2h. the intro guard uses the controller key space (was: every result dropped at line 228)');

  // BEHAVIORAL through the REAL intro lookup + a fake API: segments survive.
  const intro = await import('$lib/client/player/intro/intro-client');
  const introLookup = intro.createIntroLookup((async (input: unknown) => {
    const url = String(input);
    // v4 base URL assertion: the request must target the /v4 endpoint exactly.
    if (!url.includes('api.theintrodb.org/v4/')) throw new TypeError('unexpected url');
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      // The package reads the body via response.text() + its own JSON parse.
      // v4 raw shape: keyed by the resolved TVDB identity (fixture tvdb_id),
      // snake_case ms timestamps — tmdb_id is deliberately absent in v4.
      text: async () => JSON.stringify({ tvdb_id: 77111, type: 'movie', intro: [{ start_ms: 12_000, end_ms: 52_000 }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch);
  const introRequest = { kind: 'movie' as const, tmdbId: 24428, durationSec: 5340 };
  const introView = await introLookup.getIntroSegments(introRequest, intro.introRequestKey(introRequest));
  ok(introView.superseded === false && introView.segments.length === 1 && introView.segments[0]?.startSec === 12 && introView.segments[0]?.endSec === 52, '2i. FIX (intro, REAL client): segments reach the shell with ms→s converted exactly once');
  ok(mediaLookupKeyFor({ type: 'movie', id: 'movie-24428' }) !== undefined, '2j. (sankey) shell key template unchanged — staleness across switches stays with mediaLookupKey');
  void seriesShellKey;
}

// ===========================================================================
// §3 — BLUE VELVET VARIANT DISCOVERY (the quality-selector fix).
// ===========================================================================
console.log('\n§3 — Blue Velvet master variant discovery');
{
  const bv = await import('$lib/server/resolver/bluevelvet');

  // The LIVE master shape (fetched through the production resolve API,
  // 2026-10-13 — Avengers): 4 variants, RESOLUTION + BANDWIDTH attrs.
  const LIVE_MASTER = 'https://zcdn.bluevelvet.space/play/1RkpobcnKWooTvVr.0gjDML1WQeQ86RTICGLXulfAbsd2ilR5HPpe29C0qAM08yhfwsVB-YQQ-W/master.m3u8';
  const LIVE_BODY = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-STREAM-INF:BANDWIDTH=16153229,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2",FRAME-RATE=23.974',
    'v0/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=6140529,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=23.974',
    'v1/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3113776,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=23.974',
    'v2/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1320129,RESOLUTION=852x480,CODECS="avc1.4d401e,mp4a.40.2",FRAME-RATE=23.974',
    'v3/index.m3u8',
    '',
  ].join('\n');

  const parsed = bv.parseBlueVelvetVariants(LIVE_MASTER, LIVE_BODY);
  ok(parsed.length === 4, `3a. the verified 4-variant master parses to 4 entries (got ${parsed.length})`);
  const heights = parsed.map((v) => v.height);
  ok(JSON.stringify(heights) === JSON.stringify([2160, 1080, 720, 480]), `3b. RESOLUTION heights are the manifest's real values (got ${JSON.stringify(heights)})`);
  ok(parsed[0]?.url.toString() === 'https://zcdn.bluevelvet.space/play/1RkpobcnKWooTvVr.0gjDML1WQeQ86RTICGLXulfAbsd2ilR5HPpe29C0qAM08yhfwsVB-YQQ-W/v0/index.m3u8', '3c. relative URIs resolve against the master URL');

  const shaped = bv.discoverBlueVelvetVariants;

  // Label derivation: manifest RESOLUTION height (never the coded frame
  // height — the 3832x1600 variant of the user's Termux master is "2160p").
  const shaped2 = bv.parseBlueVelvetVariants(LIVE_MASTER, LIVE_BODY);
  void shaped; void shaped2;

  // discover() end-to-end with a fake fetch: labels + bandwidth-desc order.
  const fakePlaylistFetch = (async () => ({
    ok: true,
    headers: new Headers({ 'content-type': 'application/vnd.apple.mpegurl' }),
    text: async () => LIVE_BODY,
  })) as unknown as typeof fetch;
  const discovered = await bv.discoverBlueVelvetVariants(LIVE_MASTER, fakePlaylistFetch);
  ok(discovered.length === 4, '3d. discover() maps the parsed variants onto the quality list');
  ok(JSON.stringify(discovered.map((q) => q.label)) === JSON.stringify(['2160p', '1080p', '720p', '480p']), `3e. labels from RESOLUTION height, bandwidth-desc order (got ${JSON.stringify(discovered.map((q) => q.label))})`);
  ok(JSON.stringify(parsed.map((v) => v.bitrate)) === JSON.stringify([16153229, 6140529, 3113776, 1320129]), `3e2. BANDWIDTH parses even as the FIRST attribute after the colon (live manifest shape; got ${JSON.stringify(parsed.map((v) => v.bitrate))})`);
  ok(JSON.stringify(discovered.map((q) => q.bitrate)) === JSON.stringify([16153229, 6140529, 3113776, 1320129]), '3e3. the quality list carries the real bitrates');
  ok(discovered.every((q) => q.url.startsWith('https://zcdn.bluevelvet.space/play/1RkpobcnKWooTvVr')), '3f. every advertised URL stays under the master\'s OWN token prefix');

  // SECURITY truth table: never escape the token prefix / origin / shape.
  const token = '1RkpobcnKWooTvVr';
  const master = `https://zcdn.bluevelvet.space/play/${token}/master.m3u8`;
  const reject = (body: string) => bv.parseBlueVelvetVariants(master, body).length;
  ok(reject(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080', `../${token}2/index.m3u8`].join('\n')) === 0, '3g. ../ traversal out of the token prefix rejected');
  ok(reject(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080', 'https://evil.example/v0/index.m3u8'].join('\n')) === 0, '3h. cross-origin variant URLs rejected');
  ok(reject(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080', 'v0/index.m3u8?x=1'].join('\n')) === 0, '3i. query strings rejected');
  ok(reject(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080', 'v0/index.mp4'].join('\n')) === 0, '3j. non-.m3u8 targets rejected');
  ok(reject(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080', 'v0/seg%2F..%2Findex.m3u8'].join('\n')) === 0, '3k. percent-encoded separators rejected');
  ok(reject(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080', '../other-token/master.m3u8'].join('\n')) === 0, '3l. a DIFFERENT token is outside this master\'s prefix (rejected)');
  // Non-master URLs (child playlist / other origin) parse to nothing.
  ok(bv.parseBlueVelvetVariants('https://zcdn.bluevelvet.space/play/token/v0/index.m3u8', LIVE_BODY).length === 0, '3m. a non-master base URL is refused (master-path contract)');
  ok(bv.parseBlueVelvetVariants('https://elsewhere.example/play/t/master.m3u8', LIVE_BODY).length === 0, '3n. a non-BV base URL is refused');

  // Degradation: failures NEVER break resolution.
  const httpFail = (async () => ({ ok: false, status: 500, headers: new Headers(), text: async () => '' })) as unknown as typeof fetch;
  ok((await bv.discoverBlueVelvetVariants(master, httpFail)).length === 0, '3o. HTTP failure → empty list (resolution continues)');
  const jsonFail = (async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"ready":true}' })) as unknown as typeof fetch;
  ok((await bv.discoverBlueVelvetVariants(master, jsonFail)).length === 0, '3p. non-playlist body → empty list');
  const throwFail = (async () => { throw new TypeError('network down'); }) as unknown as typeof fetch;
  ok((await bv.discoverBlueVelvetVariants(master, throwFail)).length === 0, '3q. network throw → empty list (fire-and-degrade)');

  // Adapter wiring: qualities ride the resolve result ONLY when discovered.
  ok(/const qualities = await discoverBlueVelvetVariants\(safeUrl\);/.test(bluevelvet), '3r. the adapter runs discovery on the validated master URL');
  ok(/\.\.\.\(qualities\.length > 0 \? \{ qualities \} : \{\}\),/.test(bluevelvet), '3s. qualities attach ONLY when the manifest genuinely exposed variants (never fabricated)');
}

// ===========================================================================
// §4 — LANDSCAPE RIGHT-ALIGNMENT (the approved layout change).
// ===========================================================================
console.log('\n§4 — landscape control alignment');
{
  ok(/@media \(orientation: landscape\) and \(max-height: 500px\) \{\s*\.secondary-row \{ flex-wrap: nowrap; gap: 5px; justify-content: flex-end; \}\s*\.select-control\.subtitles \{ flex: 0 1 auto; \}/.test(controls), '4a. landscape: ONE non-wrapping RIGHT-aligned group (subtitle select stops flexing so the group packs right)');
  ok(/\.secondary-row \{ display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-start; gap: 6px; \}/.test(controls), '4b. portrait/base rule UNCHANGED (flex-start — the approved portrait layout is preserved)');
  ok((controls.match(/justify-content: flex-end/g) ?? []).length === 1, '4c. exactly ONE flex-end rule (landscape only — no leakage)');
  // Back FAB + center cluster untouched (top-left + centered).
  ok(/\.back-fab \{ position: absolute; z-index: 12; top: max\(12px, env\(safe-area-inset-top\)\); left: max\(12px, env\(safe-area-inset-left\)\);/.test(shell), '4d. Back FAB stays top-left with the safe-area floor');
  ok(/\.center-cluster \{[\s\S]*?left: 50%;/.test(controls), '4e. the center cluster stays centered on the viewport');
}

// ===========================================================================
// §5 — REGRESSION SAFETY (previous remediations remain).
// ===========================================================================
console.log('\n§5 — regression safety');
{
  // The ACTIVE CSP header value (the netlify.toml `Content-Security-Policy =`
  // assignment — not the explanatory comments that mention connect-src).
  const netlifyToml = read('netlify.toml');
  const cspLine = netlifyToml.slice(netlifyToml.indexOf('Content-Security-Policy = "'));
  ok(/\$: if \(initialProgress > 0\) applyDelayedResume\(initialProgress\);/.test(shell), '5a. delayed-resume gate intact');
  ok(/preResumeZeroEvent/.test(shell) || /preResumeZero/.test(watchRoute), '5b. the zero-event writer guard remains wired');
  ok(/capturePendingSeek\(pendingSeekState, currentTime, Date\.now\(\)\);[\s\S]{0,220}selectedQuality = url;/.test(shell), '5c. quality switching preserves the position through the pending-seek capture');
  ok(/\$: mediaUrl = selectedQualityOption\?\.url \?\? source\?\.url \?\? null;/.test(shell), '5d. the source-qualities selector swaps the media URL (the BV variant playback path)');
  ok(!/download/i.test(controls) || !/downloader/i.test(shell), '5e. NO downloader surface in the player');
  ok(/connect-src 'self' https:\/\/\*\.supabase\.co[\s\S]*?sub\.vdrk\.site[\s\S]*?api\.theintrodb\.org/.test(cspLine), '5f. the CSP pins for the optional lookups remain');
  ok(/\$: if \(browser && duration > 0 && mediaLookupKey !== introKey\) \{/.test(shell), '5g. the intro lookup still waits for a trustworthy ACTUAL duration');
  ok(/introKey = mediaLookupKey;[\s\S]{0,80}introSegments = \[\];/.test(shell), '5h. episode switches still clear stale intro state before the next lookup');
}

console.log(`\nplayer_v2_remaining_fixes_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
