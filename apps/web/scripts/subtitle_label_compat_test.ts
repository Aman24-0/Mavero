import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseVdrkEntries,
  vdrkFileToProxyPath,
} from '$lib/client/player/subtitles/external-subtitles';
import {
  buildUpstreamVttUrl,
  fetchUpstreamVttText,
  validateLabelParam,
  clearVttCacheForTests,
} from '$lib/server/subtitles/vdrk';
import { sanitizeSubtitleDisplayLabel, validateSubtitleLabel } from '$lib/shared/subtitles';

// ============================================================================
// Player UI V2 — Part 2, PART A regression suite: VDRK subtitle-label
// compatibility. The Part 1 label pattern rejected spaces and parentheses,
// so real API entries ("Portuguese (BR)2", "English Hi3",
// "Chinese (simplified)") were silently dropped from the subtitle menu.
//
// Live evidence 2026-10-12 (probed during this task):
//   * /v1/tv/1396/1/1 → "Portuguese (BR)".."(BR)5" with file URLs carrying a
//     LITERAL space: https://cache.vdrk.site/v1/vtt/tv/1396/1/1/Portuguese (BR)2.vtt
//   * /v1/movie/550 → "English Hi3", /v1/movie/1396 → "Chinese (simplified)"
//   * fully percent-encoded upstream fetches return 200 text/vtt
//     (Portuguese%20%28BR%292.vtt → 200, 40011 B; Chinese%20%28simplified%29 → 200)
//   * label character inventory across ~850 entries: A-Za-z0-9 space ( ) . -
//     with a max length of 23.
//
// §1 shared canonical label validator
// §2 client: file-URL → proxy-path rewriting (real API shapes + attacks)
// §3 client: list parsing (display labels, duplicates, variants)
// §4 server: decoded route-param validation + upstream rebuild round-trip
// §5 failed VTT fetch degrades without playback impact (route contract)
// ============================================================================

let checks = 0;
function ok(condition: boolean, label: string) {
  assert.ok(condition, label);
  checks += 1;
}

// ============================================================
// §1 — shared canonical label validator
// ============================================================

// 1a. The Part-A confirmed set: spaces and parentheses are labels now.
for (const label of ['English', 'English2', 'English3', 'Brazilian4', 'Portuguese (BR)', 'Portuguese (BR)2', 'English Hi3', 'Chinese (simplified)', 'Chinese (simplified) Hi', 'Chinese bilingual']) {
  ok(validateSubtitleLabel(label) === label, `1a. "${label}" accepted by the canonical validator`);
}
ok(validateSubtitleLabel('Portuguese (BR)2') === 'Portuguese (BR)2', '1a. the confirmed regression label "Portuguese (BR)2" is accepted');
ok(sanitizeSubtitleDisplayLabel('Portuguese (BR)2') === 'Portuguese (BR)2', '1a. display sanitization preserves spaces/parentheses verbatim');

// 1b. Security rejections — separators, traversal, percent, controls, length.
const rejected = [
  '../etc/passwd', // traversal
  '..', // bare dot-dot (first char not alnum)
  'a/b', // slash
  'a\\b', // backslash
  '..%2Fetc', // percent in any position
  'a%20b', // encoded space must NOT arrive here (decoded first) — % means double-encoding
  '%2e%2e%2f', // fully encoded traversal
  'Portuguese (BR)\u0000', // control character
  '\u001fX', // leading control
  'a\u007fb', // DEL
  'label?query=1', // URL metacharacter
  'label#frag', // URL fragment
  'label&x=1', // query separator
  'https://evil.example/x.vtt', // URL-like value
  'javascript:alert(1)', // scheme-like value
  '', // empty
  ' ', // whitespace-only
  ' leading-space', // leading space (labels start alphanumeric)
  'trailing-space ', // trailing space
  '('.repeat(5), // parens-only (first char not alnum)
  'a'.repeat(65), // overlong (cap 64; observed max 23)
  'Ünïcödé', // non-ASCII
  '字幕', // CJK
];
for (const value of rejected) {
  ok(validateSubtitleLabel(value) === null, `1b. hostile/invalid label rejected: ${JSON.stringify(value.length > 24 ? value.slice(0, 24) + '…' : value)}`);
}
ok(validateSubtitleLabel('a'.repeat(64)) === 'a'.repeat(64), '1b. a 64-char label is still within the cap');
ok(sanitizeSubtitleDisplayLabel('x'.repeat(81)) === '', '1b. display sanitizer drops overlong labels entirely');
ok(sanitizeSubtitleDisplayLabel('bad\u0000label') === 'badlabel', '1b. display sanitizer strips control characters');

// ============================================================
// §2 — client: file-URL → proxy-path rewriting
// ============================================================

// 2a. REAL API shapes (live-captured 2026-10-12) now rewrite correctly.
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/tv/1396/1/1/Portuguese (BR)2.vtt') === '/api/content/subtitles/vtt/tv/1396/1/1/Portuguese%20(BR)2', '2a. literal-space TV file URL ("Portuguese (BR)2") → proxy path');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/550/English Hi3.vtt') === '/api/content/subtitles/vtt/movie/550/English%20Hi3', '2a. literal-space movie file URL ("English Hi3") → proxy path');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/1396/Chinese (simplified).vtt') === '/api/content/subtitles/vtt/movie/1396/Chinese%20(simplified)', '2a. parentheses+space label ("Chinese (simplified)") → proxy path');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/278/Brazilian4.vtt') === '/api/content/subtitles/vtt/movie/278/Brazilian4', '2a. plain variant labels still rewrite');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/278/English2.vtt') === '/api/content/subtitles/vtt/movie/278/English2', '2a. "English2" still rewrites (Part 1 behavior preserved)');

// 2b. Pre-encoded upstream shapes are equivalent after decode.
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/tv/1396/1/1/Portuguese%20(BR)2.vtt') === '/api/content/subtitles/vtt/tv/1396/1/1/Portuguese%20(BR)2', '2b. %20-encoded file URL decodes to the same proxy path');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/tv/1396/1/1/Portuguese%20%28BR%292.vtt') === '/api/content/subtitles/vtt/tv/1396/1/1/Portuguese%20(BR)2', '2b. fully-encoded %28%29 file URL decodes to the same proxy path');

// 2c. Attacks through the label segment must still drop the entry.
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/278/%2E%2E%2Fetc%2Fpasswd.vtt') === null, '2c. encoded traversal "../etc/passwd" rejected');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/278/a%2Fb.vtt') === null, '2c. encoded separator "%2F" rejected (decoded label is not a label)');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/278/a%5Cb.vtt') === null, '2c. encoded backslash rejected');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/278/%zz.vtt') === null, '2c. malformed percent-encoding rejected');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/278/https%3A%2F%2Fevil.example.vtt') === null, '2c. encoded URL-like label rejected');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/278/..%2F..%2Fetc%2Fpasswd.vtt') === null, '2c. "..%2F.." traversal rejected');
// URL normalization folds dot segments before the regex ever sees them:
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/278/../../etc/passwd.vtt') === null, '2c. literal dot-segment traversal never matches the fixed path shape');

// 2d. Structural constraints unchanged.
ok(vdrkFileToProxyPath('http://cache.vdrk.site/v1/vtt/tv/1396/1/1/Portuguese (BR)2.vtt') === null, '2d. plain-http still rejected');
ok(vdrkFileToProxyPath('https://evil.example/v1/vtt/tv/1396/1/1/Portuguese (BR)2.vtt') === null, '2d. foreign hosts still rejected');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/tv/1396/1/1/Portuguese (BR)2.vtt?x=1') === null, '2d. query strings still rejected');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/0278/Portuguese (BR)2.vtt') === null, '2d. non-canonical tmdb (leading zero) still rejected');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/tv/1396/0/1/Portuguese (BR)2.vtt') === null, '2d. zero season still rejected');
ok(vdrkFileToProxyPath('not a url') === null, '2d. garbage still rejected');

// ============================================================
// §3 — client: list parsing (display label + dedupe + variants)
// ============================================================

// 3a. The EXACT live payload shape of the confirmed regression case.
const liveGoT = [
  { label: 'English', file: 'https://cache.vdrk.site/v1/vtt/tv/1396/1/1/English.vtt' },
  { label: 'English2', file: 'https://cache.vdrk.site/v1/vtt/tv/1396/1/1/English2.vtt' },
  { label: 'Portuguese (BR)', file: 'https://cache.vdrk.site/v1/vtt/tv/1396/1/1/Portuguese (BR).vtt' },
  { label: 'Portuguese (BR)2', file: 'https://cache.vdrk.site/v1/vtt/tv/1396/1/1/Portuguese (BR)2.vtt' },
  { label: 'Portuguese (BR)3', file: 'https://cache.vdrk.site/v1/vtt/tv/1396/1/1/Portuguese (BR)3.vtt' },
];
const parsedGoT = parseVdrkEntries(liveGoT);
ok(parsedGoT.length === 5, '3a. ALL live entries survive (Part 1 dropped the 3 Portuguese (BR) ones)');
ok(parsedGoT.some((t) => t.label === 'Portuguese (BR)2' && t.url === '/api/content/subtitles/vtt/tv/1396/1/1/Portuguese%20(BR)2'), '3a. "Portuguese (BR)2" is selectable with its original display label');
ok(parsedGoT.filter((t) => t.label.startsWith('Portuguese (BR)')).length === 3, '3a. individual Portuguese (BR) variants stay separately selectable');
ok(parsedGoT.every((t) => t.url.startsWith('/api/content/subtitles/vtt/')), '3a. every track rides the same-origin proxy');

// 3b. Duplicates collapse; distinct variants never do.
const duped = parseVdrkEntries([
  { label: 'English2', file: 'https://cache.vdrk.site/v1/vtt/movie/278/English2.vtt' },
  { label: 'English2', file: 'https://cache.vdrk.site/v1/vtt/movie/278/English2.vtt' },
  { label: 'English2', file: 'https://cache.vdrk.site/v1/vtt/movie/278/English2.vtt' },
]);
ok(duped.length === 1, '3b. duplicate label+file entries collapse to one track');
const sameLabelDiffFile = parseVdrkEntries([
  { label: 'Same', file: 'https://cache.vdrk.site/v1/vtt/movie/278/Same.vtt' },
  { label: 'Same', file: 'https://cache.vdrk.site/v1/vtt/movie/278/Same.vtt' },
]);
ok(sameLabelDiffFile.length === 1, '3b. same-label duplicates dedupe by proxy URL');

// 3c. Empty, overlong, hostile DISPLAY labels drop; spacing preserved.
ok(parseVdrkEntries([{ label: '', file: 'https://cache.vdrk.site/v1/vtt/movie/278/X.vtt' }]).length === 0, '3c. empty display labels dropped');
ok(parseVdrkEntries([{ label: 'x'.repeat(81), file: 'https://cache.vdrk.site/v1/vtt/movie/278/X.vtt' }]).length === 0, '3c. overlong display labels dropped');
ok(parseVdrkEntries([{ label: 'bad\u0000label', file: 'https://cache.vdrk.site/v1/vtt/movie/278/Bad.vtt' }])[0]?.label === 'badlabel', '3c. control characters stripped from display labels (no raw injection into the menu)');

// ============================================================
// §4 — server: decoded param validation + upstream round-trip
// ============================================================

// 4a. SvelteKit delivers the param percent-DECODED: validate as a label.
ok(validateLabelParam('Portuguese (BR)2') === 'Portuguese (BR)2', '4a. decoded label param with space+parens accepted');
ok(validateLabelParam('English Hi3') === 'English Hi3', '4a. decoded label param with space accepted');
ok(validateLabelParam('English2') === 'English2' && validateLabelParam('Brazilian4') === 'Brazilian4', '4a. Part 1 label shapes still accepted');
ok(validateLabelParam('%20') === null, '4a. a raw % in the DECODED param is double-encoding — rejected');
ok(validateLabelParam('../etc') === null && validateLabelParam('a/b') === null && validateLabelParam('a\\b') === null, '4a. traversal/separators rejected');
ok(validateLabelParam('Portuguese (BR)\u0000') === null, '4a. control characters rejected');
ok(validateLabelParam('x'.repeat(65)) === null, '4a. overlong labels rejected');
ok(validateLabelParam('') === null, '4a. empty labels rejected');

// 4b. Round-trip: proxy URL label → decoded param → upstream URL equals the
// VERIFIED upstream shape for the same file. A label can NEVER alter the
// fixed host or the /v1/vtt/{kind}/{tmdb}[/{s}/{e}]/{label}.vtt structure.
for (const [kind, tmdb, season, episode, label] of [
  ['movie', 1396, undefined, undefined, 'Portuguese (BR)2'],
  ['movie', 550, undefined, undefined, 'English Hi3'],
  ['tv', 1396, 1, 1, 'Portuguese (BR)2'],
  ['tv', 278, 2, 30, 'Chinese (simplified) Hi'],
] as const) {
  const upstream = buildUpstreamVttUrl(kind, tmdb, label, season, episode);
  ok(upstream.startsWith('https://cache.vdrk.site/v1/vtt/'), `4b. upstream for "${label}" keeps the fixed host+path prefix`);
  const encoded = encodeURIComponent(label);
  const expected = kind === 'movie'
    ? `https://cache.vdrk.site/v1/vtt/movie/${tmdb}/${encoded}.vtt`
    : `https://cache.vdrk.site/v1/vtt/tv/${tmdb}/${season}/${episode}/${encoded}.vtt`;
  ok(upstream === expected, `4b. upstream for "${label}" is rebuilt from validated parts`);
  ok(!upstream.includes(' ') && !upstream.includes('..') && (upstream.match(/\//g) ?? []).length === (kind === 'movie' ? 7 : 9), `4b. no raw separators/traversal can survive for "${label}"`);
}
ok(buildUpstreamVttUrl('movie', 1396, 'Portuguese (BR)2') === 'https://cache.vdrk.site/v1/vtt/movie/1396/Portuguese%20(BR)2.vtt', '4b. upstream URL encodes the space (encodeURIComponent keeps () literal — this exact form live-verified 200 text/vtt)');
ok(buildUpstreamVttUrl('tv', 1396, 'Portuguese (BR)2', 1, 1) === 'https://cache.vdrk.site/v1/vtt/tv/1396/1/1/Portuguese%20(BR)2.vtt', '4b. tv upstream keeps season/episode distinct from the label');

// 4c. Route files still enforce the full contract (unchanged by Part A).
const movieRoute = readFileSync(resolve('src/routes/api/content/subtitles/vtt/movie/[tmdbId]/[label]/+server.ts'), 'utf-8');
const tvRoute = readFileSync(resolve('src/routes/api/content/subtitles/vtt/tv/[tmdbId]/[season]/[episode]/[label]/+server.ts'), 'utf-8');
ok(/validateLabelParam\(params\.label/.test(movieRoute) && /validateLabelParam\(params\.label/.test(tvRoute), '4c. both routes still validate the label param');
ok(!movieRoute.includes('url.searchParams') && !tvRoute.includes('url.searchParams'), '4c. neither route became a generic proxy');
ok(/Invalid subtitle request/.test(movieRoute) && /Invalid subtitle request/.test(tvRoute), '4c. invalid segments still fail closed with 400');
// The shared canonical pattern is genuinely wired in (no pattern drift).
ok(readFileSync(resolve('src/lib/server/subtitles/vdrk.ts'), 'utf-8').includes("from '$lib/shared/subtitles'"), '4c. the server module validates via the shared canonical pattern');
ok(readFileSync(resolve('src/lib/client/player/subtitles/external-subtitles.ts'), 'utf-8').includes("from '$lib/shared/subtitles'"), '4c. the client module validates via the shared canonical pattern');

// ============================================================
// §5 — a failed VTT fetch degrades without playback impact
// ============================================================

{
  // The upstream build for a spaced label + upstream failure → typed 502
  // result; nothing throws, playback is untouched (the route maps this to
  // "Subtitle unavailable" and the player keeps playing without that track).
  clearVttCacheForTests();
  const upstream = buildUpstreamVttUrl('tv', 1396, 'Portuguese (BR)2', 1, 1);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 404, headers: new Headers() })) as unknown as typeof fetch;
  try {
    const failed = await fetchUpstreamVttText(upstream);
    ok(!failed.ok && failed.status === 502, '5. a failed VTT request for a spaced label resolves to a typed failure (no throw, playback unaffected)');
  } finally {
    globalThis.fetch = original;
  }
  clearVttCacheForTests();
}

console.log(`subtitle_label_compat_test: ${checks} checks passed`);
