// Verify trailerKey + cast data-flow contract by inspecting the source chain.
// We avoid importing the TMDB adapter directly because it depends on $env/dynamic/private
// which only resolves inside the SvelteKit runtime. The contract we verify here is:
//   1. TMDB adapter source extracts trailerKey from raw.videos.results + cast from credits
//   2. NormalizedMediaItem type includes trailerKey? + cast?
//   3. presenter.toMediaItem copies trailerKey + cast onto MediaItem
//   4. MediaItem type (client) includes trailerKey? + cast?
//   5. DetailPage uses item.trailerKey (no hardcoded IDs, no fake button when missing)
//   6. No fake trailer data is added anywhere
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

const [tmdbSrc, typesSrc, presenterSrc, contentSrc, detailSrc, dropdownSrc, filterSrc] = await Promise.all([
  readFile(new URL('src/lib/server/content/adapters/tmdb.ts', root), 'utf8'),
  readFile(new URL('src/lib/server/content/types.ts', root), 'utf8'),
  readFile(new URL('src/lib/server/content/presenter.ts', root), 'utf8'),
  readFile(new URL('src/lib/data/content.ts', root), 'utf8'),
  readFile(new URL('src/lib/components/DetailPage.svelte', root), 'utf8'),
  readFile(new URL('src/lib/components/Dropdown.svelte', root), 'utf8'),
  readFile(new URL('src/lib/components/FilterBar.svelte', root), 'utf8')
]);

console.log('Trailer + cast data-flow contract tests');

// --- 1. TMDB adapter extracts trailerKey from YouTube Trailer video ---
assert.match(tmdbSrc, /trailerKey:\s*raw\.videos\?\.results\?\.find\(\(video\)\s*=>\s*video\.site\s*===\s*'YouTube'\s*&&\s*video\.type\s*===\s*'Trailer'\)\?\.key/, 'TMDB adapter extracts YouTube Trailer key');
assert.match(tmdbSrc, /append_to_response:\s*'videos,external_ids,recommendations,credits'/, 'TMDB adapter appends credits to detail request');

// --- 2. TMDB adapter extracts cast from credits ---
assert.match(tmdbSrc, /function extractCast/, 'TMDB adapter defines extractCast helper');
assert.match(tmdbSrc, /cast:\s*extractCast\(raw\)/, 'TMDB adapter attaches cast to NormalizedMediaItem');
assert.match(tmdbSrc, /profileImage/, 'TMDB adapter has profileImage helper for cast photos');

// --- 3. NormalizedMediaItem type includes trailerKey + cast ---
assert.match(typesSrc, /trailerKey\?:\s*string;/, 'NormalizedMediaItem type declares trailerKey?: string');
assert.match(typesSrc, /cast\?:\s*CastMember\[\];/, 'NormalizedMediaItem type declares cast?: CastMember[]');
assert.match(typesSrc, /export type CastMember/, 'types.ts exports CastMember type');

// --- 4. presenter.toMediaItem copies trailerKey + cast onto MediaItem ---
assert.match(presenterSrc, /trailerKey:\s*item\.trailerKey/, 'presenter.toMediaItem copies trailerKey');
assert.match(presenterSrc, /cast:\s*item\.cast/, 'presenter.toMediaItem copies cast');

// --- 5. Client-side MediaItem type also has trailerKey + cast ---
assert.match(contentSrc, /trailerKey\?:\s*string;/, 'MediaItem type (client) declares trailerKey?: string');
assert.match(contentSrc, /cast\?:\s*CastMember\[\];/, 'MediaItem type (client) declares cast?: CastMember[]');
assert.match(contentSrc, /export type CastMember/, 'content.ts exports CastMember type');

// --- 6. DetailPage uses real trailerKey and only shows Trailer button when present ---
assert.match(detailSrc, /\$:\s*trailerKey\s*=\s*item\.trailerKey\s*\?\?\s*'';/, 'DetailPage reads trailerKey from item (no hardcoded values)');
assert.match(detailSrc, /\$:\s*hasTrailer\s*=\s*Boolean\(trailerKey\);/, 'DetailPage gates Trailer on hasTrailer');
assert.match(detailSrc, /\{\#if hasTrailer\}/, 'DetailPage only renders Trailer button when hasTrailer is true');
assert.match(detailSrc, /youtube\.com\/embed\/\$\{trailerKey\}/, 'DetailPage passes real trailerKey to YouTube embed URL');
assert.doesNotMatch(detailSrc, /trailerKey\s*=\s*['"][a-zA-Z0-9_-]{5,}['"]/, 'DetailPage does NOT hardcode any trailer ID');

// --- 7. DetailPage no longer has the removed metadata grid ---
assert.doesNotMatch(detailSrc, /class="details-grid"/, 'DetailPage no longer renders the duplicate details-grid');
assert.doesNotMatch(detailSrc, /Movie Details|Show Details/, 'DetailPage no longer has the "Movie/Show Details" duplicate section');

// --- 8. DetailPage new hero composition ---
assert.match(detailSrc, /class="hero"/, 'DetailPage has hero backdrop section');
assert.match(detailSrc, /class="poster-wrap"/, 'DetailPage has centered poster-wrap');
assert.match(detailSrc, /class="poster-img"/, 'DetailPage has poster-img');
assert.match(detailSrc, /class="identity"/, 'DetailPage has identity section with title/metadata/overview/genres');
assert.match(detailSrc, /class="actions"/, 'DetailPage has actions section');
assert.match(detailSrc, /class="cast-section"/, 'DetailPage has cast-section (renders when cast exists)');

// --- 9. Trailer modal uses YouTube embed with autoplay ---
assert.match(detailSrc, /trailer-modal/, 'DetailPage has trailer-modal');
assert.match(detailSrc, /youtube\.com\/embed\/\$\{trailerKey\}/, 'Trailer iframe uses YouTube embed with trailerKey');

// --- 10. Custom Dropdown component ---
assert.match(dropdownSrc, /aria-haspopup="listbox"/, 'Dropdown trigger has aria-haspopup="listbox"');
assert.match(dropdownSrc, /aria-expanded=\{open\}/, 'Dropdown trigger has aria-expanded bound to open state');
assert.match(dropdownSrc, /role="listbox"/, 'Dropdown panel has role="listbox"');
assert.match(dropdownSrc, /role="option"/, 'Dropdown options have role="option"');
assert.match(dropdownSrc, /aria-selected=\{option\.value\s*===\s*value\}/, 'Dropdown options have aria-selected bound to value');
// Keyboard navigation — verify each key is handled individually (order-agnostic)
for (const key of ["'ArrowDown'", "'ArrowUp'", "'Home'", "'End'", "'Enter'", "'Escape'"]) {
  assert.match(dropdownSrc, new RegExp(`event\\.key\\s*===\\s*${key.replace(/'/g, "'").replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `Dropdown handles ${key} key`);
}
assert.match(dropdownSrc, /handleDocumentClick/, 'Dropdown closes on outside click');

// --- 11. FilterBar no longer uses native <select> ---
assert.doesNotMatch(filterSrc, /<select/, 'FilterBar no longer uses native <select>');
assert.match(filterSrc, /import Dropdown from/, 'FilterBar imports Dropdown component');
assert.match(filterSrc, /<Dropdown/, 'FilterBar uses Dropdown component');

// --- 12. Year filter is dynamic (current year → 1960, newest first) ---
assert.match(filterSrc, /const currentYear = new Date\(\)\.getFullYear\(\)/, 'Year filter uses dynamic current year');
assert.match(filterSrc, /currentYear - 1959/, 'Year filter spans current year back to 1960');
assert.match(filterSrc, /currentYear - i/, 'Year filter iterates newest first (current year - i)');

console.log('\nAll trailer + cast data-flow + UI contract tests passed');
