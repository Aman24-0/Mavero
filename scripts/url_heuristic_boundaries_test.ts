/**
 * Phase 3 3-F (repository-cleanup plan §5 group 3-F) — URL-sniffing
 * heuristic BOUNDARY pin.
 *
 * The Phase 0 audit (§3.4) listed the cloudstream / stremio / fourk
 * sniffing heuristics as "re-implemented" duplication and suggested
 * consolidating them behind one shared module. The fresh 3-F evidence sweep
 * DISPROVED the duplication premise: the same-named functions are separate
 * DISPLAY CONTRACTS with deliberately different vocabularies, caps, input
 * shapes, and label taxonomies (e.g. the same `.ts` filename displays as
 * 'MPEG' in the cloudstream pipeline but 'TS' in the stremio pipeline; the
 * cloudstream lexicon matches abbreviations + the 'dual audio' rule while
 * the stremio lexicon is full-words-only and capped at two). Merging them
 * would change one side's user-visible output — a behavior change, which
 * Phase 3 forbids.
 *
 * Disposition: REJECT the merge; pin the boundary so a future session
 * cannot "dedup" these naively. This suite asserts the exact divergence
 * pairs documented in REPOSITORY_CLEANUP_PLAN.md §5 group 3-F.
 *
 * Deterministic: pure-function imports only.
 */

import assert from 'node:assert/strict';

import { detectContainer as csContainer, detectAudioLanguages as csLanguages } from '$lib/server/cloudstream/normalize/links';
import { detectContainer as stremioContainer, detectAudioLanguages as stremioLanguages, extractQuality as stremioQuality } from '$lib/server/streaming/stremio/stream-normalize';
import { extractQuality as fourkQuality } from '$lib/server/downloader/fourk-service';

let checks = 0;
function ok(condition: boolean, label: string) {
  assert.ok(condition, label);
  checks += 1;
}

// --- container taxonomy divergence -------------------------------------------

ok(csContainer('movie.ts') === 'MPEG', "3-F: cloudstream groups .ts → 'MPEG' (regex-table taxonomy)");
ok(stremioContainer('movie.ts', 'https://host/movie.ts') === 'TS', "3-F: stremio displays .ts → 'TS' (extension-map taxonomy) — deliberately DIFFERENT label");
ok(csContainer('movie.m4v') === 'MP4', "3-F: cloudstream folds .m4v → 'MP4'");
ok(stremioContainer('movie.m4v', 'https://host/movie.m4v') === 'M4V', "3-F: stremio keeps .m4v distinct → 'M4V'");
ok(csContainer('movie.mkv') === 'MKV' && stremioContainer('movie.mkv', 'https://host/movie.mkv') === 'MKV',
  "3-F: .mkv agrees on 'MKV' (the overlap that made the audit suspect duplication)");

// --- audio-language lexicon divergence ---------------------------------------

ok(csLanguages('eng dub movie')?.includes('English') === true, "3-F: cloudstream matches ABBREVIATIONS ('eng')");
ok(stremioLanguages(['eng dub movie']) === undefined, "3-F: stremio lexicon is full-words-only — 'eng' matches NOTHING (deliberate)");
ok((csLanguages('hindi tamil telugu movie') ?? []).length === 3, '3-F: cloudstream is UNCAPPED (3 languages returned)');
ok((stremioLanguages(['hindi tamil telugu movie']) ?? []).length === 2, '3-F: stremio is CAPPED at 2 (MAX_AUDIO_LANGUAGES)');

// --- quality return-type divergence -------------------------------------------

ok(fourkQuality('Movie [4K] [16.62 GB]') === '2160p', "3-F: fourk extractQuality returns a plain STRING ('2160p' from 4K)");
ok(stremioQuality('Movie 4K', undefined, undefined).label === '2160p' && stremioQuality('Movie 4K', undefined, undefined).height === 2160,
  '3-F: stremio extractQuality returns the TYPED {label, height} shape');
ok(stremioQuality('no quality here', undefined, undefined).label === 'Auto' && fourkQuality('no quality here') === undefined,
  "3-F: no-quality fallbacks differ ('Auto' label vs undefined) — not mergeable");

console.log(`ok - url_heuristic_boundaries: ${checks} checks passed (cloudstream/stremio/fourk sniffing contracts stay separate by design)`);
if (checks !== 12) {
  throw new Error(`expected 12 checks, saw ${checks}`);
}
