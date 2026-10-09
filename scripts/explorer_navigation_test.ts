import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Explorer redesign navigation + search + detail contracts
// (approved changes 2, 3, 4, 5, 6).
//
//   CHANGE 2 — (MAV-21 superseded) My List + Settings Back controls
//              REMOVED — global navigation is the single provider on
//              both pages (mobile pill + topbar ≤1024px, desktop
//              sidebar ≥1025px).
//   CHANGE 3 — phone/browser Back from /my-list or /settings returns
//              to /discover (no Account/My List/Settings history
//              loop) via replace-state navigation in the account
//              surfaces — no global history hacks.
//   CHANGE 4 — the Search page gains ONLY a Recent Searches row
//              (horizontal, re-runnable, individually removable,
//              hidden when empty); every other search contract is
//              unchanged.
//   CHANGE 5 — detail page mobile top spacing reduced ~15-20px so
//              the action buttons are visible sooner.
//   CHANGE 6 — "Streaming on" renamed to "Available on" (copy only;
//              provider cards/behavior unchanged).

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const myList = read('../src/routes/my-list/+page.svelte');
const settings = read('../src/routes/settings/+page.svelte');
const accountSheet = read('../src/lib/components/AccountSheet.svelte');
const searchPage = read('../src/routes/search/+page.svelte');
const recentSearches = read('../src/lib/client/recent-searches.ts');
const detailPage = read('../src/lib/components/DetailPage.svelte');

// ============================================================
// 1. MAV-21 WORKSTREAMS C+D — page-specific Back controls REMOVED
//    from My List + Settings; global navigation (AppShell) is the
//    single navigation provider on both pages at every breakpoint.
// ============================================================
const rootLayout = read('../src/routes/+layout.svelte');
const appShell = read('../src/lib/components/AppShell.svelte');
for (const [name, src] of [['My List', myList], ['Settings', settings]] as const) {
  assert.doesNotMatch(src, /back-to-discover/, `${name} has NO page-specific back control (MAV-21 C/D)`);
  assert.doesNotMatch(src, /aria-label="Back to Discover"/, `${name} has no Back-to-Discover accessibility label`);
  assert.doesNotMatch(src, /ArrowLeft/, `${name} no longer imports/renders the back arrow icon`);
  assert.doesNotMatch(src, /class="back-row"/, `${name} has NO standalone full-width back row`);
  // The pages keep their header identity + functionality.
}
assert.match(myList, /MAVERO \/ My List/, 'My List keeps its page identity header');
assert.match(myList, /toggleSelectionMode/, 'My List keeps selection mode');
assert.match(settings, /MAVERO \/ Settings/, 'Settings keeps its page identity header');
assert.match(settings, /loadSessions/, 'Settings keeps Devices & Sessions');
// Global navigation is rendered unconditionally by the shell — no page
// can suppress it (the former /settings opt-out is gone).
assert.doesNotMatch(rootLayout, /showMobileNav/, 'the root layout no longer suppresses mobile navigation on any route');
assert.doesNotMatch(appShell, /showMobileNav/, 'AppShell has no navigation opt-out prop — global nav is unconditional');
assert.match(appShell, /<nav class="mobile-nav" aria-label="Mobile navigation">/, 'AppShell renders the mobile bottom nav');
// My List keeps goto only for its remaining in-page navigation.
assert.doesNotMatch(settings, /goto\('\/discover'/, 'Settings no longer performs replace-state navigation to /discover');
ok('1. MAV-21 C+D: page Back controls removed from My List + Settings; global navigation unconditional');

// ============================================================
// 2. CHANGE 3 — history fix via replace-state on account surfaces
// ============================================================
assert.match(accountSheet, /const ACCOUNT_SURFACES = \['\/upcoming', '\/my-list', '\/settings'\]/, 'the account sheet knows the three account surfaces (Upcoming joins via LT-1)');
assert.match(accountSheet, /ACCOUNT_SURFACES\.includes\(page\.url\.pathname\)/, 'the sheet checks the CURRENT route before choosing push vs replace');
assert.match(accountSheet, /event\.preventDefault\(\);\s*\n?\s*void goto\(href, \{ replaceState: true \}\)/, 'sheet navigation from an account surface REPLACES the history entry');
// Discover → Account → My List → Back = Discover is satisfied by the
// normal anchor (push) path — asserted via the unchanged hrefs.
assert.match(accountSheet, /href="\/my-list"/, 'the My List sheet entry keeps its normal anchor (push from non-account surfaces)');
assert.match(accountSheet, /href="\/settings"/, 'the Settings sheet entry keeps its normal anchor (push from non-account surfaces)');
// No global history manipulation.
assert.doesNotMatch(accountSheet, /history\.(back|forward|pushState|replaceState)/, 'the sheet performs NO raw history manipulation');
assert.doesNotMatch(myList + settings, /history\.(back|forward|pushState|replaceState)/, 'the pages perform NO raw history manipulation');
assert.doesNotMatch(accountSheet, /popstate|beforeunload/, 'no global popstate/beforeunload interception');
// Detail/watch/search navigation must be untouched by this change.
assert.match(detailPage, /function goBack\(/, 'detail page back behavior is untouched');
ok('2. Change 3: sheet replace-navigation on account surfaces; Discover→Account→My List→Account→Settings→Back = Discover; no global history hacks');

// ============================================================
// 3. CHANGE 4 — Recent Searches (the ONLY search page addition)
// ============================================================
assert.match(recentSearches, /export function getRecentSearches\(/, 'the recent-searches store exists (the first history system — none existed)');
assert.match(recentSearches, /export function recordRecentSearch\(/, 'recording API exists');
assert.match(recentSearches, /export function removeRecentSearch\(/, 'per-entry removal API exists');
assert.match(recentSearches, /MAX_RECENT_SEARCHES = 8/, 'the list is bounded (8 entries)');
assert.match(recentSearches, /entry !== normalized/, 're-running a query deduplicates (moves to front)');
assert.match(recentSearches, /typeof localStorage === 'undefined'/, 'storage access is SSR/private-mode safe');
assert.match(recentSearches, /mavero:recent-searches/, 'localStorage key follows the mavero: convention');
// The row itself.
assert.match(searchPage, /class="recent-searches" aria-label="Recent searches"/, 'the recent searches row renders with an accessible name');
assert.match(searchPage, /getRecentSearches, recordRecentSearch, removeRecentSearch/, 'the page wires the store');
assert.match(searchPage, /showRecentSearches = \$derived\(!query\.trim\(\) && !loading && recentSearches\.length > 0\)/, 'the row is hidden when empty (no ugly empty row)');
assert.match(searchPage, /aria-label=\{`Search again for \$\{entry\}`\}/, 'each entry is a labeled re-run control');
assert.match(searchPage, /aria-label=\{`Remove recent search \$\{entry\}`\}/, 'each entry has its own accessible remove control');
assert.match(searchPage, /function dropRecentSearch\(entry: string\)/, 'individual removal is wired');
assert.match(searchPage, /function runRecentSearch\(entry: string\)/, 're-running a recent search is wired');
assert.match(searchPage, /\.recent-scroll \{[\s\S]*overflow-x: auto/, 'the row scrolls horizontally (contained)');
assert.match(searchPage, /\.recent-scroll::-webkit-scrollbar \{ display: none; \}/, 'the row hides its scrollbar');
assert.match(searchPage, /\.recent-run:focus-visible, \.recent-remove:focus-visible \{ outline: 2px solid var\(--color-focus\)/, 'recent controls keep focus-visible states');
// Recording happens on successful search execution.
assert.match(searchPage, /recentSearches = recordRecentSearch\(normalized\);/, 'successful searches record the query');
// SCOPE RESTRICTION — the existing search contracts are unchanged.
assert.match(searchPage, /export const snapshot = \{/, 'the page snapshot mechanism is unchanged');
assert.match(searchPage, /scheduleSearch\(\)\s*\{\s*\n?\s*if \(timer\) clearTimeout\(timer\);\s*\n?\s*timer = setTimeout\(runSearch, 340\)/, 'the 340ms debounce contract is unchanged');
assert.match(searchPage, /\/api\/content\/search\?\$\{params\.toString\(\)\}/, 'the search API call is unchanged');
assert.match(searchPage, /typeOptions: \{ value: TypeFilter; label: string \}\[\] = \[\s*\{ value: 'All', label: 'All' \},\s*\{ value: 'Movie', label: 'Movie' \},\s*\{ value: 'TV Show', label: 'TV Show' \}\s*\]/, 'the All/Movie/TV Show filter set is unchanged');
assert.match(searchPage, /placeholder="Search movies, shows, or anime"/, 'the search input is unchanged');
// Scope restriction: no Explorer filter architecture (chips/feed/taxonomy)
// leaked into the search page.
assert.doesNotMatch(searchPage, /EXPLORER_GENRES|EXPLORER_LANGUAGES|explorer-taxonomy|\/api\/explplorer|api\/explorer/, 'no Explorer filter architecture leaked into search');
ok('3. Change 4: recent-searches row only — storage module, a11y, horizontal scroll, individual removal; search behavior untouched');

// ============================================================
// 4. CHANGE 5 (superseded by MAV-21 Detail 2.0) — the mobile hero is
//    now POSTER-FREE with identity + actions bottom-anchored, so the
//    dominant Play action and the Watching/Share/Trailer row land in
//    the first 390×844 viewport by design (the original intent of the
//    spacing patches — solved structurally instead of by nudges).
// ============================================================
// Touch surfaces (≤1024px) render NO poster in the hero.
assert.match(detailPage, /\.poster-wrap \{ display: none; \}/, 'the base poster-wrap is hidden (touch surfaces are poster-free)');
assert.match(detailPage, /@media \(max-width: 640px\)[\s\S]*?\.poster-wrap \{ display: none; \}/, 'the mobile hero explicitly hides the poster-wrap');
assert.match(detailPage, /@media \(min-width: 1025px\)[\s\S]*?\.poster-wrap \{ display: flex; justify-content: flex-start; \}/, 'the desktop composition restores the poster');
// Identity + actions are bottom-anchored (flex align-items: flex-end).
assert.match(detailPage, /\.hero \{[\s\S]*?display: flex;\s*align-items: flex-end;/, 'the hero bottom-anchors its composition');
// The action pipeline is untouched.
assert.match(detailPage, /class="play-btn"/, 'Play/Resume action untouched');
assert.match(detailPage, /class="download-btn"/, 'Download action untouched');
assert.match(detailPage, /openStatusSheet/, 'Watching status action untouched');
assert.match(detailPage, /shareItem/, 'Share action untouched');
assert.match(detailPage, /openTrailer/, 'Trailer action untouched');
// Breakpoints + reserved hero space.
assert.match(detailPage, /@media \(min-width: 1025px\)[\s\S]*?padding-top: clamp\(96px, 14vh, 160px\)/, 'desktop hero spacing untouched');
assert.match(detailPage, /min-height: clamp\(440px, 78vh, 760px\)/, 'hero min-height (backdrop composition) untouched');
// Title clamping keeps long titles from pushing the actions away.
assert.match(detailPage, /\.detail-title \{[\s\S]*?-webkit-line-clamp: 3/, 'the hero title is line-clamped (long titles cannot push actions out of the viewport)');
ok('4. MAV-21 Detail 2.0: poster-free touch hero, bottom-anchored identity + actions, clamped title; action pipeline + breakpoints intact');

// ============================================================
// 5. CHANGE 6 — "Available on" rename (copy only)
// ============================================================
assert.match(detailPage, /<h2 class="section-h" id="streaming-heading">Available on<\/h2>/, 'the provider section heading reads "Available on"');
assert.doesNotMatch(detailPage, />Streaming on</, 'no "Streaming on" heading remains');
assert.match(detailPage, /aria-labelledby="streaming-heading"/, 'the provider section semantics are unchanged');
assert.match(detailPage, /item\.streamingProviders && item\.streamingProviders\.length > 0/, 'the provider rendering condition is unchanged');
assert.match(detailPage, /class="streaming-provider" role="listitem"/, 'the provider card structure is unchanged');
assert.match(detailPage, /class="streaming-logo"/, 'provider logos still render');
ok('5. Change 6: "Streaming on" → "Available on"; provider functionality unchanged');

console.log(`\nExplorer navigation/search/detail tests passed (${passed} check groups).`);
