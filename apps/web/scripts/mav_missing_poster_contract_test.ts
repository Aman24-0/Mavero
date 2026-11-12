/**
 * Task 5 regression (2026-10-15) — poster visibility in the Missing Media
 * linking wizard.
 *
 * Reported production problem: opening the Link File / Add File wizard
 * from Missing Media for a series episode or movie showed NO poster in
 * the selected-title summary (the neutral placeholder), while the same
 * title selected through the normal Media Library Add File flow showed
 * one.
 *
 * Root cause: the demand row carries no poster, and the Missing Media
 * page built `preselectedMediaItem` WITHOUT the poster field — the wizard
 * (which fully supports `PreselectedMediaItem.poster`) never received it.
 *
 * Fix under test (the SHARED data contract, no hardcoding):
 *   - Server: the missing-page loader enriches demand rows with
 *     poster_path from the canonical media_items row (ONE batched
 *     top-level lookup; exact (tmdb_id, content_type) match).
 *   - Client: the page passes the enriched poster into the wizard's
 *     preselectedMediaItem.
 *   - Wizard: episodic preselections backfill the PARENT poster from the
 *     SAME seasons response loadSeasons() already fetches (zero extra
 *     requests); poster-less movie preselections fetch the detail ONCE
 *     by id (never a title search).
 *
 *   §A  enrichment matcher (behavioral — the real helper)
 *         A1  movie demand + movie row with poster → poster attached
 *         A2  TV series demand → parent series poster
 *         A3  anime demand → anime parent poster
 *         A4  episode demand (series + season/episode) → PARENT poster
 *         A5  no canonical row → null (placeholder; never invented)
 *         A6  no cross-content-type leakage
 *         A7  posterless row → null
 *   §B  the shared contract end-to-end (source)
 *         B1  page server batches the lookup + calls the helper
 *         B2  page passes poster into preselectedMediaItem
 *         B3  wizard renders selectedTmdb.poster in the summary
 *   §C  wizard backfill (source)
 *         C1  loadSeasons backfills the parent poster (zero extra fetch)
 *         C2  movie preselections fetch detail once by id
 *   §D  no duplicate URL prefixing + persistence
 *         D1  posterUrl guards startsWith('http')
 *         D2  relativePosterPath extracts /t/p/<size> suffixes
 *         D3  saveLink persists the RELATIVE poster path
 *         D4  fallback = neutral placeholder (ImageIcon)
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_missing_poster_contract_test.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { attachPosterPathsToDemands } from '../src/lib/server/hosting/demand/poster-enrichment';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL ${passed + failed} - ${label}`); }
}

const missingServer = read('src/routes/admin/media/missing/+page.server.ts');
const missingPage = read('src/routes/admin/media/missing/+page.svelte');
const wizard = read('src/lib/components/admin2/AdminAddFileWizard.svelte');

// ===========================================================================
console.log('§A — enrichment matcher (the real helper)');
// ===========================================================================

// A1 — movie demand picks up the movie row's poster.
{
  const demands = [{ tmdb_id: '438631', content_type: 'movie', title_snapshot: 'Dune' }];
  attachPosterPathsToDemands(demands, [
    { tmdb_id: '438631', content_type: 'movie', poster_path: '/dune.jpg' },
  ]);
  ok(demands[0].poster_path === '/dune.jpg', 'A1a. movie demand → movie row poster (/dune.jpg)');
}

// A2 — TV series demand → parent series poster.
{
  const demands = [{ tmdb_id: '46648', content_type: 'series', title_snapshot: 'Dark' }];
  attachPosterPathsToDemands(demands, [
    { tmdb_id: '46648', content_type: 'series', poster_path: '/dark.jpg' },
  ]);
  ok(demands[0].poster_path === '/dark.jpg', 'A2a. series demand → parent series poster');
}

// A3 — anime demand → anime parent poster.
{
  const demands = [{ tmdb_id: '94605', content_type: 'anime', title_snapshot: 'Arcane' }];
  attachPosterPathsToDemands(demands, [
    { tmdb_id: '94605', content_type: 'anime', poster_path: '/arcane.jpg' },
  ]);
  ok(demands[0].poster_path === '/arcane.jpg', 'A3a. anime demand → anime parent poster');
}

// A4 — an EPISODE demand (series + season/episode) resolves the PARENT
// poster: the demand's content_type matches the parent row's (top-level
// lookup by tmdb_id) — the episode's parent series poster is what shows.
{
  const demands = [{ tmdb_id: '46648', content_type: 'series', season: 1, episode: 4, title_snapshot: 'Dark' }];
  attachPosterPathsToDemands(demands, [
    { tmdb_id: '46648', content_type: 'series', poster_path: '/dark-parent.jpg' },
  ]);
  ok(demands[0].poster_path === '/dark-parent.jpg', 'A4a. episode demand retains its PARENT series poster');
}

// A5 — no canonical row → null (never invented).
{
  const demands = [{ tmdb_id: '999999', content_type: 'movie', title_snapshot: 'Never Linked' }];
  attachPosterPathsToDemands(demands, [
    { tmdb_id: '438631', content_type: 'movie', poster_path: '/dune.jpg' },
  ]);
  ok(demands[0].poster_path === null, 'A5a. no matching row → poster_path null (placeholder path)');
}

// A6 — no cross-content-type leakage.
{
  const demands = [{ tmdb_id: '46648', content_type: 'series' }];
  attachPosterPathsToDemands(demands, [
    { tmdb_id: '46648', content_type: 'anime', poster_path: '/wrong-type.jpg' },
  ]);
  ok(demands[0].poster_path === null, 'A6a. a series demand does NOT pick up an anime row poster');
  const demands2 = [{ tmdb_id: '46648', content_type: 'anime' }];
  attachPosterPathsToDemands(demands2, [
    { tmdb_id: '46648', content_type: 'series', poster_path: '/wrong-type.jpg' },
  ]);
  ok(demands2[0].poster_path === null, 'A6b. an anime demand does NOT pick up a series row poster');
}

// A7 — a posterless canonical row → null.
{
  const demands = [{ tmdb_id: '438631', content_type: 'movie' }];
  attachPosterPathsToDemands(demands, [
    { tmdb_id: '438631', content_type: 'movie', poster_path: null },
  ]);
  ok(demands[0].poster_path === null, 'A7a. posterless row → null');
}

// ===========================================================================
console.log('§B — the shared contract end-to-end (source)');
// ===========================================================================
ok(/attachPosterPathsToDemands/.test(missingServer), 'B1a. page server uses the shared enrichment helper');
ok(/\.in\('tmdb_id', tmdbIds\)/.test(missingServer) && /\.is\('season', null\)/.test(missingServer), 'B1b. ONE batched top-level lookup (no N+1)');
ok(/poster: posterPath,/.test(missingPage) && /req\.poster_path/.test(missingPage), 'B2a. the page passes the enriched poster into preselectedMediaItem');
ok(/poster\?: string \| null;/.test(wizard), 'B3a. PreselectedMediaItem.poster remains part of the shared contract');
ok(/poster: preselected\.poster \?\? undefined/.test(wizard), 'B3b. preselection flows into selectedTmdb.poster');
ok(/posterUrl\(selectedTmdb\.poster\)/.test(wizard), 'B3c. the selected-title summary renders the poster');

// ===========================================================================
console.log('§C — wizard backfill (source)');
// ===========================================================================
ok(/if \(selectedTmdb && !selectedTmdb\.poster && json\?\.item\?\.poster\)/.test(wizard), 'C1a. loadSeasons backfills the parent poster from the SAME response (zero extra requests)');
ok(/ensurePreselectedPoster/.test(wizard), 'C2a. poster-less preselections resolve via ensurePreselectedPoster');
ok(/\/api\/content\/movie\/movie-\$\{encodeURIComponent\(selectedTmdb\.tmdbId\)\}/.test(wizard), 'C2b. movie backfill fetches the detail ONCE by id (never a title search)');
ok(/if \(!selectedTmdb \|\| selectedTmdb\.poster\) return;/.test(wizard), 'C2c. no fetch when a poster is already present (reuse)');
ok(/kindMeta\(kind\)\.episodic\) return; \/\/ covered by loadSeasons backfill/.test(wizard), 'C2d. episodic preselections skip the movie fetch entirely');

// ===========================================================================
console.log('§D — no duplicate URL prefixing + persistence');
// ===========================================================================
ok(/function posterUrl\(path\?: string\): string \| null \{[\s\S]*?if \(!path\) return null;[\s\S]*?if \(path\.startsWith\('http'\)\) return path;[\s\S]*?return `\$\{TMDB_IMAGE_BASE\}\$\{path\}`;/.test(wizard), 'D1a. posterUrl prefixes ONLY relative paths (full URLs pass through — no double prefix)');
ok(/function relativePosterPath\(url\?: string\): string \| null \{[\s\S]*?if \(!url\) return null;[\s\S]*?if \(url\.startsWith\('\/'\)\) return url;[\s\S]*?return match \? match\[1\] : null;/.test(wizard), 'D2a. relativePosterPath accepts relative paths AND extracts /t/p/<size> suffixes');
ok(/const posterPath = relativePosterPath\(selectedTmdb\.poster\);[\s\S]*?if \(posterPath\) body\.posterPath = posterPath;/.test(wizard), 'D3a. saveLink persists the RELATIVE poster path (media_items.poster_path convention)');
ok(/<ImageIcon size=\{14\} \/>/.test(wizard), 'D4a. missing poster falls back to the neutral placeholder icon');

console.log(`\nmav_missing_poster_contract_test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
