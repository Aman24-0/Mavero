import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = new URL('../', import.meta.url).pathname;

const adultPolicy = await readFile(path.join(repoRoot, 'src/lib/server/content/adult-policy.ts'), 'utf8');
const adultAuthz = await readFile(path.join(repoRoot, 'src/lib/server/content/adult-authz.ts'), 'utf8');
const adultCookie = await readFile(path.join(repoRoot, 'src/lib/server/content/adult-cookie.ts'), 'utf8');
const adultProviders = await readFile(path.join(repoRoot, 'src/lib/server/content/adult-providers.ts'), 'utf8');
const tmdb = await readFile(path.join(repoRoot, 'src/lib/server/content/adapters/tmdb.ts'), 'utf8');
const service = await readFile(path.join(repoRoot, 'src/lib/server/content/service.ts'), 'utf8');
const searchClassify = await readFile(path.join(repoRoot, 'src/lib/server/content/search-classify.ts'), 'utf8');
const listClassify = await readFile(path.join(repoRoot, 'src/lib/server/content/list-classify.ts'), 'utf8');
const watchPageServer = await readFile(path.join(repoRoot, 'src/routes/watch/[type]/[id]/+page.server.ts'), 'utf8');
const seasonEndpoint = await readFile(path.join(repoRoot, 'src/routes/api/content/series/[id]/season/[season]/+server.ts'), 'utf8');
const upcomingSource = await readFile(path.join(repoRoot, 'src/lib/server/content/upcoming.ts'), 'utf8');
const railEndpoint = await readFile(path.join(repoRoot, 'src/routes/api/discover/rail/+server.ts'), 'utf8');
const searchEndpoint = await readFile(path.join(repoRoot, 'src/routes/api/content/search/+server.ts'), 'utf8');
const adultModeApi = await readFile(path.join(repoRoot, 'src/routes/api/settings/adult-mode/+server.ts'), 'utf8');
const adultProvidersApi = await readFile(path.join(repoRoot, 'src/routes/api/discover/adult-providers/+server.ts'), 'utf8');
const adminAdultApi = await readFile(path.join(repoRoot, 'src/routes/api/admin/adult-mode/+server.ts'), 'utf8');
const adultDiscoverModule = await readFile(path.join(repoRoot, 'src/lib/server/content/adult-discover.ts'), 'utf8');
const adultDiscoverEndpoint = await readFile(path.join(repoRoot, 'src/routes/api/content/adult-discover/+server.ts'), 'utf8');
const migration = await readFile(path.join(repoRoot, 'supabase/migrations/20260913000000_adult_mode.sql'), 'utf8');
const types = await readFile(path.join(repoRoot, 'src/lib/server/content/types.ts'), 'utf8');
const discoverPage = await readFile(path.join(repoRoot, 'src/lib/components/DiscoverPage.svelte'), 'utf8');
const adminDefaults = await readFile(path.join(repoRoot, 'src/routes/admin/defaults/+page.svelte'), 'utf8');
const settingsPage = await readFile(path.join(repoRoot, 'src/routes/settings/+page.svelte'), 'utf8');

// ============================================================================
// A. Provider registry — no fabricated IDs, runtime verification, aliases.
// ============================================================================
{
  // All provider IDs must be 0 (unresolved at startup — resolved at runtime).
  assert.match(adultProviders, /tmdbProviderId: 0/, 'all adult provider IDs start at 0 (unresolved)');
  // No hardcoded sequential IDs (375, 376, 377, etc.).
  assert.doesNotMatch(adultProviders, /tmdbProviderId: [1-9]\d*/, 'no hardcoded TMDB provider IDs');
  // Registry contains provider NAMES, not IDs.
  assert.match(adultProviders, /name: 'Ullu'/, 'Ullu provider name present');
  assert.match(adultProviders, /name: 'ALTT'/, 'ALTT provider name present');
  assert.match(adultProviders, /name: 'Rabbit Movies'/, 'Rabbit Movies provider name present');
  // Aliases are present for providers with alternate names.
  assert.match(adultProviders, /aliases: \['ALTBalaji'\]/, 'ALTT has ALTBalaji alias');
  assert.match(adultProviders, /aliases: \['Rabbit'\]/, 'Rabbit Movies has Rabbit alias');
  // Runtime resolution function exists.
  assert.match(adultProviders, /export function resolveAdultProviders/, 'resolveAdultProviders function exists');
  assert.match(adultProviders, /export function getAdultProviderIds/, 'getAdultProviderIds function exists');
  assert.match(adultProviders, /export function isAdultProvider/, 'isAdultProvider function exists');
  // Unknown providers are omitted (the matching logic uses find/filter, not direct ID access).
  assert.match(adultProviders, /indiaProviders\.find/, 'provider matching uses find against live TMDB list');
}

// ============================================================================
// B. Admin policy — globally enabled/disabled, server-side.
// ============================================================================
{
  assert.match(adultPolicy, /export async function getAdultAccessContext/, 'getAdultAccessContext exists');
  assert.match(adultPolicy, /export async function canAccessAdultContent/, 'canAccessAdultContent exists');
  assert.match(adultPolicy, /export async function updateAdminAdultPolicy/, 'updateAdminAdultPolicy exists');
  assert.match(adultPolicy, /export async function updateUserAdultPreference/, 'updateUserAdultPreference exists');
  // Phase 5: NO process-local policy cache — Supabase app_settings is
  // authoritative on every authorization evaluation (multi-instance safe).
  assert.doesNotMatch(adultPolicy, /POLICY_TTL_MS|cachedPolicy|invalidateAdultPolicyCache/, 'no process-local admin policy cache (removed in Phase 5)');
  assert.match(adultPolicy, /async function getAdminPolicy/, 'admin policy reader exists');
  assert.match(adultPolicy, /return adminPolicyFromRead\(data, error\);/, 'admin policy is mapped fresh from the Supabase read (per request)');
  // Default: OFF for everyone (fail-closed mapping lives in adult-authz.ts).
  assert.match(adultAuthz, /allowLoggedIn: false, allowGuest: false/, 'default policy is OFF (fail-closed read mapping)');
  // Server-side enforcement: admin policy overrides user preference.
  assert.match(adultPolicy, /if \(!adminGateAllows\)/, 'admin gate checked before user preference');
  assert.match(adultAuthz, /if \(!adminAllows\)/, 'matrix denies inside the single evaluation function');
  // User preference is forced to false when admin disables.
  assert.match(adultPolicy, /enabled = false/, 'preference forced false when admin disallows');
}

// ============================================================================
// C. User preference — default OFF, server-enforced.
// ============================================================================
{
  assert.match(migration, /adult_mode_enabled boolean not null default false/, 'user preference defaults to false');
  // RLS: users can only read/write their own preferences.
  assert.match(migration, /user_preferences_select_own/, 'RLS: users read own preferences');
  assert.match(migration, /user_preferences_update_own/, 'RLS: users update own preferences');
  assert.match(migration, /user_preferences_insert_own/, 'RLS: users insert own preferences');
  // Admin can read all for audit.
  assert.match(migration, /user_preferences_select_admin/, 'RLS: admin can read all');
}

// ============================================================================
// D. Guest — can access adult content via signed cookie when admin allows.
// ============================================================================
{
  // The adult mode API PUT now supports both authenticated and guest.
  // Guest preference is stored in a signed HttpOnly cookie.
  assert.match(adultModeApi, /if \(user\)/, 'PUT adult-mode handles authenticated users');
  assert.match(adultModeApi, /updateGuestAdultPreference/, 'PUT adult-mode supports guest via cookie');
  // Guest cookie helpers exist (Phase 5: HMAC-SHA256 construction lives in
  // adult-cookie.ts; adult-policy.ts wires the private secret + Secure flag).
  assert.match(adultCookie, /export const GUEST_COOKIE_NAME/, 'guest cookie name defined (adult-cookie.ts)');
  assert.match(adultPolicy, /export function getGuestCookieHeader/, 'guest cookie header function exists');
  assert.match(adultCookie, /export function verifyAdultCookieValue/, 'guest cookie HMAC verifier exists (adult-cookie.ts)');
  assert.match(adultCookie, /createHmac\('sha256', secret\)/, 'guest cookie uses HMAC-SHA256');
  assert.match(adultPolicy, /export function getGuestCookieHeader[\s\S]{0,200}?assertAdultCookieSecret/, 'cookie issuance requires the configured secret (fail-closed)');
  assert.match(adultCookie, /'HttpOnly'/, 'guest cookie is HttpOnly');
  assert.match(adultCookie, /'SameSite=Lax'/, 'guest cookie is SameSite=Lax');
  assert.match(adultPolicy, /!dev/, 'guest cookie Secure flag is environment-aware (production only)');
  // getAdultAccessContext accepts cookies parameter.
  assert.match(adultPolicy, /cookies\?: \{ get: \(name: string\) => string \| undefined \}/, 'getAdultAccessContext accepts cookies');
  // Guest preference is read from cookie.
  assert.match(adultPolicy, /getGuestPreferenceFromCookies\(cookies\)/, 'guest preference read from cookie');
  // canAccessAdultContent accepts cookies.
  assert.match(adultPolicy, /export async function canAccessAdultContent\([\s\S]*?cookies\?/, 'canAccessAdultContent accepts cookies');
  // updateGuestAdultPreference enforces admin policy.
  assert.match(adultPolicy, /updateGuestAdultPreference[\s\S]*?if \(!policy\.allowGuest\)/, 'guest preference enforces admin allowGuest');
  // Admin allows check for guest (gate-first wiring; the matrix itself lives
  // in evaluateAdultAccess — adult-authz.ts).
  assert.match(adultPolicy, /adminGateAllows = isAuthenticated \? policy\.allowLoggedIn : policy\.allowGuest/, 'guest uses allowGuest');
  assert.match(adultAuthz, /adminAllows = isAuthenticated \? policy\.allowLoggedIn : policy\.allowGuest/, 'matrix maps guests to allowGuest');
}

// ============================================================================
// D2. Provider resolution — ensureAdultProvidersResolved.
// ============================================================================
{
  assert.match(adultProviders, /export async function ensureAdultProvidersResolved/, 'ensureAdultProvidersResolved exists');
  assert.match(adultProviders, /fetchIndiaProviders: \(\) => Promise/, 'accepts fetchIndiaProviders callback');
  assert.match(adultProviders, /const cached = getCachedAdultProviders\(\)/, 'checks cache first');
  assert.match(adultProviders, /if \(cached\) return/, 'returns early if cache is fresh');
  assert.match(adultProviders, /const indiaProviders = await fetchIndiaProviders\(\)/, 'fetches live providers if cache stale');
  assert.match(adultProviders, /resolveAdultProviders\(indiaProviders\)/, 'resolves adult providers against live list');
  // TMDB adapter uses getResolvedAdultProviderIds in all adult-sensitive functions.
  assert.match(tmdb, /async function getResolvedAdultProviderIds/, 'TMDB adapter has getResolvedAdultProviderIds helper');
  assert.match(tmdb, /await ensureAdultProvidersResolved\(\(\) => getTmdbIndiaProviders\(\)\)/, 'helper calls ensureAdultProvidersResolved');
  // All adult-sensitive functions use the helper — EXCEPT the Phase 6
  // classification-based rails: trending + legacy popular endpoints support
  // no provider filters and classify candidates instead (see section S6).
  const discoverFnD = tmdb.match(/export async function getTmdbDiscover[\s\S]*?^}/m)?.[0] ?? '';
  assert.match(discoverFnD, /filterAdultFromListPage/, 'getTmdbDiscover classifies + filters candidates (Phase 6)');
  assert.doesNotMatch(discoverFnD, /getResolvedAdultProviderIds/, 'getTmdbDiscover needs no provider resolution');
  const popularFnD = tmdb.match(/export async function getTmdbPopular\([\s\S]*?^}/m)?.[0] ?? '';
  assert.match(popularFnD, /filterAdultFromListPage/, 'getTmdbPopular classifies + filters candidates (Phase 6)');
  assert.doesNotMatch(popularFnD, /getResolvedAdultProviderIds/, 'getTmdbPopular needs no provider resolution');
  assert.match(tmdb, /getTmdbCollection[\s\S]*?await getResolvedAdultProviderIds/, 'getTmdbCollection uses resolved IDs');
  assert.match(tmdb, /getTmdbTrendingMoviesByLanguage[\s\S]*?await getResolvedAdultProviderIds/, 'getTmdbTrendingMoviesByLanguage uses resolved IDs');
  // service.search also ensures providers are resolved.
  assert.match(service, /await ensureAdultProvidersResolved\(\(\) => getTmdbIndiaProviders\(\)\)/, 'service.search ensures providers resolved');
}

// ============================================================================
// E. Normal rails — adult excluded (Phase 3: TV via networks, movies transitional).
// ============================================================================
{
  // Phase 3: TV rails exclude VERIFIED adult NETWORKS (canonical identity).
  assert.match(tmdb, /getTmdbPopularByLanguage[\s\S]*?without_networks: networkExclusion/, 'popular TV excludes adult networks');
  assert.match(tmdb, /getTmdbTopRated[\s\S]*?without_networks: networkExclusion/, 'top-rated TV excludes adult networks');
  assert.match(tmdb, /getTmdbNewOnOtt[\s\S]*?without_networks: networkExclusion/, 'new-ott TV excludes adult networks');
  // Movie halves keep the documented TRANSITIONAL watch-provider exclusion
  // (/discover/movie has no network filter — worklog Phase 3 endpoint matrix).
  assert.match(tmdb, /getTmdbPopularByLanguage[\s\S]*?'without_watch_providers': providerExclusion/, 'popular movies keep transitional provider exclusion');
  assert.match(tmdb, /getTmdbTopRated[\s\S]*?'without_watch_providers': providerExclusion/, 'top-rated movies keep transitional provider exclusion');
  assert.match(tmdb, /getTmdbNewOnOtt[\s\S]*?'without_watch_providers': providerExclusion/, 'new-ott movies keep transitional provider exclusion');
  // Genre rail is movie-only — transitional provider exclusion (its
  // missing watch_region is a known bug fixed in Phase 6, not here).
  assert.match(tmdb, /getTmdbGenreByLanguage[\s\S]*?without_watch_providers.*adultExclusion/, 'genre (movie) keeps transitional provider exclusion');
  // Cache keys include the adult exclusion dimension.
  assert.match(tmdb, /adultExclusion \?\? 'no-adult'/, 'cache key includes adult exclusion dimension');
}

// ============================================================================
// F. Popular TV — OTT filtering, India region, flatrate, no adult injection.
// ============================================================================
{
  const popularFn = tmdb.match(/export async function getTmdbPopularByLanguage[\s\S]*?^}/m);
  assert.ok(popularFn, 'getTmdbPopularByLanguage function body found');
  // Uses /discover/tv (not /tv/popular).
  assert.match(popularFn![0], /\/discover\/tv/, 'popular TV uses /discover/tv');
  // OTT-oriented: watch_region=IN + flatrate for series.
  assert.match(popularFn![0], /type === 'series' \? \{ watch_region: 'IN', with_watch_monetization_types: 'flatrate' \}/, 'series has OTT filter');
  // No adult injection (include_adult: false).
  assert.match(popularFn![0], /include_adult: false/, 'popular uses include_adult: false');
  // Phase 3: TV excludes adult NETWORKS; movies keep transitional providers.
  assert.match(popularFn![0], /without_networks: networkExclusion/, 'popular TV excludes adult networks');
  assert.match(popularFn![0], /'without_watch_providers': providerExclusion/, 'popular movies keep transitional provider exclusion');
}

// ============================================================================
// G. Adult rail — Phase 3: TV by with_networks (no JustWatch prerequisites),
//    movies transitional by providers; 10 items, dedupe, verified-only.
// ============================================================================
{
  assert.match(tmdb, /export async function getTmdbAdultShows/, 'adult shows query function exists');
  // TV half: with_networks from the registry via adult-catalog.ts.
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?getVerifiedAdultNetworkIdForKey\(providerKey\)/, 'adult TV narrows via the VERIFIED network key lookup');
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?withAdultNetworksParams\(selectedNetworkId\)/, 'adult TV uses the verified network inclusion builder');
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?\.\.\.networkInclusion/, 'adult TV params include with_networks');
  // TV params block has NO watch-provider prerequisites.
  const adultFnBody = tmdb.match(/export async function getTmdbAdultShows[\s\S]*?^}/m)?.[0] ?? '';
  const adultTvParams = adultFnBody.match(/const tvParams[\s\S]*?};/m)?.[0] ?? '';
  assert.ok(adultTvParams, 'adult shows tvParams block found');
  assert.doesNotMatch(adultTvParams, /with_watch_providers|watch_region|with_watch_monetization_types/, 'adult TV query drops JustWatch/flatrate/region prerequisites');
  assert.match(adultTvParams, /include_adult: true/, 'adult TV keeps include_adult: true');
  // Movie half: documented TRANSITIONAL provider query (unchanged semantics).
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?with_watch_providers: watchProviders/, 'adult movies keep transitional with_watch_providers');
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?watch_region: 'IN'/, 'adult movie query uses watch_region=IN');
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?with_watch_monetization_types: 'flatrate'/, 'adult movie query uses flatrate');
  // Verified providers only (movie half).
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?getCachedAdultProviders/, 'adult shows uses verified providers only (movie half)');
  // Nothing verified in either id space -> empty result (no fabrication).
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?if \(!hasTvQuery && !hasMovieQuery\)/, 'adult shows returns empty when nothing is verified in either id space');
  // Cache key embeds the network inclusion dimension.
  assert.match(tmdb, /key = `tmdb:adult-shows:.*:\$\{networkInclusion\.with_networks \?\? 'no-networks'\}`/, 'adult shows cache key embeds the network dimension');
  // Rail endpoint enforces adult access.
  assert.match(railEndpoint, /sectionParam === 'adult-shows'/, 'rail endpoint checks for adult-shows section');
  assert.match(railEndpoint, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'rail endpoint evaluates adult policy with cookies');
  // Defense in depth: discoverRail also checks canAccessAdult.
  assert.match(service, /case 'adult-shows'[\s\S]*?if \(!canAccessAdult\)/, 'discoverRail defense-in-depth check');
}

// ============================================================================
// H. Search — adult excluded when unavailable (Phase 4: server-side classification).
// ============================================================================
{
  assert.match(searchEndpoint, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'search endpoint evaluates adult policy with cookies');
  assert.match(service, /export async function search\(query.*canAccessAdult = false/, 'search accepts canAccessAdult parameter');
  // Phase 4: service passes the authorization decision to searchTmdb —
  // classification + filtering happen server-side in the content layer.
  assert.match(service, /searchTmdb\(normalized, 'series', page, filters, canAccessAdult\)/, 'service passes canAccessAdult to searchTmdb for anime');
  assert.match(service, /searchTmdb\(normalized, type, page, filters, canAccessAdult\)/, 'service passes canAccessAdult to searchTmdb for typed search');
  assert.match(service, /searchTmdb\(normalized, 'movie', page, filters, canAccessAdult\)/, 'service passes canAccessAdult to searchTmdb for the merged search');
  // No client-side bypass parameter (the endpoint must not accept ?adult=true as a query param).
  assert.doesNotMatch(searchEndpoint, /url\.searchParams\.get\('adult'\)/, 'search endpoint does NOT accept adult query param');
  assert.doesNotMatch(searchEndpoint, /url\.searchParams\.get\('userId'\)/, 'search endpoint does NOT accept userId query param');
  // SSR parity: the search page evaluates the same policy server-side.
  const searchPageServer = await readFile(path.join(repoRoot, 'src/routes/search/+page.server.ts'), 'utf8');
  assert.match(searchPageServer, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'SSR search page evaluates the adult policy server-side');
  assert.match(searchPageServer, /search\(query, type, 1, \{\}, canAccessAdult\)/, 'SSR search page passes the authorization decision down');
}

// ============================================================================
// I. Direct access — unauthorized adult blocked.
// ============================================================================
{
  // The rail endpoint checks adult access before returning adult section data.
  assert.match(railEndpoint, /if \(!canAccessAdult\) \{[\s\S]*?return json\(\{ ok: true, items: \[\]/, 'rail returns empty for unauthorized adult');
}

// ============================================================================
// J. Cache isolation — adult response cannot satisfy normal request.
// ============================================================================
{
  // Cache keys include the adult exclusion dimension.
  assert.match(tmdb, /adultExclusion \?\? 'no-adult'/, 'cache key includes adult exclusion');
  // Adult section has its own cache namespace.
  assert.match(tmdb, /key = `tmdb:adult-shows:/, 'adult shows has separate cache namespace');
  // Phase 5: authorization is NEVER cached in process memory (globally or
  // otherwise) — admin policy and user preference are both read fresh.
  assert.doesNotMatch(adultPolicy, /cachedPolicy|POLICY_TTL/, 'no admin policy cached globally (Phase 5)');
  assert.match(adultPolicy, /async function getUserPreference[\s\S]*?return userPreferenceFromRead\(data, error\);/, 'user preference read fresh (not cached)');
}

// ============================================================================
// K. SSR/hydration — no unauthorized adult payload.
// ============================================================================
{
  // DiscoverPage fetches adult settings client-side (not SSR).
  assert.match(discoverPage, /loadAdultModeSettings/, 'DiscoverPage fetches adult settings client-side');
  // Phase 8 lockstep: the Adult surface is now the dedicated
  // AdultDiscoverSection component (Phase 7 API-backed), still rendered
  // ONLY on the server-reported authorization state — the condition stays
  // server-driven (equal strength: the state comes from
  // /api/settings/adult-mode, and the component itself is asserted in
  // section AC + the Phase 8 suite).
  assert.match(discoverPage, /\{#if adultCanAccess\}/, 'adult section conditionally rendered on the server-reported state');
  assert.match(discoverPage, /<AdultDiscoverSection/, 'the Adult surface is the dedicated Phase 7-backed component');
  // The server load (discover-load.ts) does NOT load adult data.
  const discoverLoad = await readFile(path.join(repoRoot, 'src/lib/server/content/discover-load.ts'), 'utf8');
  assert.doesNotMatch(discoverLoad, /adult/, 'SSR load does NOT fetch adult data');
}

// ============================================================================
// L. Anime regression — anime not classified as adult.
// ============================================================================
{
  // Anime detection is based on genre 16 + ja, not on adult metadata.
  assert.match(tmdb, /isAnime = genreIds\.includes\(16\) && originalLanguage === 'ja'/, 'anime detection unchanged');
  // Adult classification is based on the central isAdultContent classifier
  // (which checks tags + provider IDs + TMDB adult flag), not on isAnime.
  assert.match(service, /import \{ isAdultContent.*\} from '\.\/adult-providers'/, 'service imports isAdultContent from adult-providers');
  assert.match(service, /return isAdultContent\(item\.tags, undefined, undefined, item\.isAnime, item\.networks\)/, 'isAdultItem delegates to isAdultContent');
  // Anime sections do NOT use adult exclusion (anime is separate from adult).
  const animeFn = tmdb.match(/export async function getTmdbAnimeMerged[\s\S]*?^}/m);
  assert.ok(animeFn, 'getTmdbAnimeMerged found');
  assert.doesNotMatch(animeFn![0], /without_watch_providers/, 'anime section does NOT exclude adult providers');
}

// ============================================================================
// M. Existing regression — playback/resolver/progress/navigation untouched.
// ============================================================================
{
  // No changes to player files.
  const changedFiles = ['src/lib/server/content/adult-policy.ts', 'src/lib/server/content/adult-providers.ts', 'src/lib/server/content/adapters/tmdb.ts', 'src/lib/server/content/service.ts', 'src/lib/server/content/types.ts', 'src/routes/api/discover/rail/+server.ts', 'src/routes/api/settings/adult-mode/+server.ts', 'src/routes/api/discover/adult-providers/+server.ts', 'src/routes/api/admin/adult-mode/+server.ts', 'src/routes/api/content/search/+server.ts', 'src/lib/components/DiscoverPage.svelte', 'src/routes/admin/defaults/+page.svelte', 'src/routes/settings/+page.svelte', 'src/lib/server/supabase/database.types.ts', 'supabase/migrations/20260913000000_adult_mode.sql'];
  // Verify the test does NOT import from player/resolver/watch.
  assert.doesNotMatch(adultPolicy, /from.*player/, 'adult policy does not import player');
  assert.doesNotMatch(adultPolicy, /from.*resolver/, 'adult policy does not import resolver');
  assert.doesNotMatch(adultProviders, /from.*player/, 'adult providers does not import player');
  assert.doesNotMatch(adultProviders, /from.*resolver/, 'adult providers does not import resolver');
  assert.doesNotMatch(railEndpoint, /from.*player/, 'rail endpoint does not import player');
  assert.doesNotMatch(railEndpoint, /from.*resolver/, 'rail endpoint does not import resolver');
  assert.doesNotMatch(searchEndpoint, /from.*player/, 'search endpoint does not import player');
  assert.doesNotMatch(searchEndpoint, /from.*resolver/, 'search endpoint does not import resolver');
}

// ============================================================================
// N. Migration correctness.
// ============================================================================
{
  assert.match(migration, /create table if not exists public\.app_settings/, 'app_settings table created');
  assert.match(migration, /create table if not exists public\.user_preferences/, 'user_preferences table created');
  assert.match(migration, /adult_mode_allow_logged_in boolean not null default false/, 'admin policy defaults OFF');
  assert.match(migration, /adult_mode_allow_guest boolean not null default false/, 'guest policy defaults OFF');
  assert.match(migration, /adult_mode_enabled boolean not null default false/, 'user preference defaults OFF');
  assert.match(migration, /references auth\.users\(id\) on delete cascade/, 'user_preferences cascades on user delete');
  assert.match(migration, /enable row level security/, 'RLS enabled');
  assert.match(migration, /app_settings_select_all/, 'app_settings public read policy');
  assert.match(migration, /app_settings_update_admin/, 'app_settings admin write policy');
  assert.match(migration, /user_preferences_select_own/, 'user_preferences self-read policy');
  assert.match(migration, /user_preferences_update_own/, 'user_preferences self-write policy');
  assert.match(migration, /user_preferences_insert_own/, 'user_preferences self-insert policy');
  assert.match(migration, /app_settings_set_updated_at/, 'app_settings updated_at trigger');
  assert.match(migration, /user_preferences_set_updated_at/, 'user_preferences updated_at trigger');
}

// ============================================================================
// O. Admin UI — toggle controls present.
// ============================================================================
{
  assert.match(adminDefaults, /loadAdultPolicy/, 'admin page loads adult policy');
  assert.match(adminDefaults, /toggleAdultPolicy/, 'admin page can toggle adult policy');
  assert.match(adminDefaults, /allowLoggedIn/, 'admin page has allowLoggedIn toggle');
  assert.match(adminDefaults, /allowGuest/, 'admin page has allowGuest toggle');
  assert.match(adminDefaults, /api\/admin\/adult-mode/, 'admin page calls adult mode API');
  assert.match(adminAdultApi, /requireAdmin/, 'admin adult API requires admin');
}

// ============================================================================
// P. Profile/Settings UI — adult mode toggle.
// ============================================================================
{
  assert.match(settingsPage, /loadAdultMode/, 'settings page loads adult mode');
  assert.match(settingsPage, /toggleAdultMode/, 'settings page can toggle adult mode');
  assert.match(settingsPage, /adultAvailable/, 'settings page has adultAvailable state');
  assert.match(settingsPage, /\{#if adultAvailable\}/, 'settings page conditionally renders adult toggle');
  assert.match(settingsPage, /api\/settings\/adult-mode/, 'settings page calls adult mode API');
  // No localStorage trust for adult authorization (no localStorage.setItem/getItem for adult).
  assert.doesNotMatch(settingsPage, /localStorage\.(setItem|getItem)\(.*adult/, 'settings page does NOT use localStorage for adult auth');
}

// ============================================================================
// Q. BUG 1 — Direct detail classification via watch/providers.
// ============================================================================
{
  // getTmdbDetail must append_to_response watch/providers so it can
  // classify adult content without a separate N+1 API call.
  assert.match(tmdb, /append_to_response: 'videos,external_ids,recommendations,credits,watch\/providers'/, 'detail fetches watch/providers via append_to_response');
  // isAdultContent is called in getTmdbDetail.
  assert.match(tmdb, /getTmdbDetail[\s\S]*?isAdultContent\(item\.tags, providerIds, tmdbAdult, item\.isAnime, networks\)/, 'detail calls isAdultContent');
  // If adult, the 'Adult' tag is added to the item.
  assert.match(tmdb, /if \(isAdultContent[\s\S]*?item\.tags = \[\.\.\.\(item\.tags \?\? \[\]\), 'Adult'\]/, 'detail adds Adult tag when classified');
  // The SSR routes check tags?.includes('Adult').
  const movieSsr = await readFile(path.join(repoRoot, 'src/routes/movie/[id]/+page.server.ts'), 'utf8');
  const seriesSsr = await readFile(path.join(repoRoot, 'src/routes/series/[id]/+page.server.ts'), 'utf8');
  const animeSsr = await readFile(path.join(repoRoot, 'src/routes/anime/[id]/+page.server.ts'), 'utf8');
  const contentApi = await readFile(path.join(repoRoot, 'src/routes/api/content/[type]/[id]/+server.ts'), 'utf8');
  assert.match(movieSsr, /tags\?\.includes\('Adult'\)/, 'movie SSR checks Adult tag');
  assert.match(seriesSsr, /tags\?\.includes\('Adult'\)/, 'series SSR checks Adult tag');
  assert.match(animeSsr, /tags\?\.includes\('Adult'\)/, 'anime SSR checks Adult tag');
  // Phase 6: the content API reads the classification through the canonical
  // central verdict reader (detailVerdict — the same central-classifier tag,
  // behaviorally tested in the Phase 6 suite).
  assert.match(contentApi, /detailVerdict\(result\.tags\) === 'adult'/, 'content API checks the central classifier verdict');
}

// ============================================================================
// R. BUG 2 — Search cache key separates authorized from unauthorized results
// (Phase 4: auth dimension + classification stays content-keyed).
// ============================================================================
{
  // searchTmdb cache key carries the authorization dimension — an authorized
  // (adult-allowed) response can never be served to an unauthorized context.
  // Phase 6: the key is built by the PURE buildSearchCacheKey (structural,
  // behaviorally-tested isolation in scripts/adult_phase6_enforcement_test.ts).
  assert.match(tmdb, /const key = buildSearchCacheKey\(\{ type, query: normalized, page, ott: filters\.ott, genre: filters\.genre, sort: filters\.sort, canAccessAdult \}\)/, 'search cache key built by the pure auth-dimension key builder');
  assert.match(searchClassify, /export function buildSearchCacheKey/, 'buildSearchCacheKey exported from the pure classification module');
  assert.match(searchClassify, /SEARCH_CACHE_AUTH_DIMENSIONS = \{[\s\S]*?allowed: 'adult-allowed',[\s\S]*?excluded: 'adult-excluded'/, 'auth dimension values are fixed structural literals');
  // searchTmdb receives the authorization decision (not a precomputed exclusion value).
  assert.match(tmdb, /export async function searchTmdb\(query: string, type: Exclude<ContentType, 'anime'>, page = 1, filters: SearchFilters = \{\}, canAccessAdult = false\)/, 'searchTmdb accepts the canAccessAdult decision');
  // The classification cache stays content-keyed: the detail path used by
  // search classification has NO authorization dimension (J asserts the
  // tmdb:detail key; Phase 2/4 behavioral suites prove the semantics).
  assert.match(tmdb, /const detail = await getTmdbDetail\('series', String\(item\.id\)\)/, 'search TV classification flows through the cached detail path');
}

// ============================================================================
// S. BUG 3 — Generic catalog paths exclude adult content (Phase 3 shape).
// ============================================================================
{
  // Phase 6: getTmdbDiscover (legacy trending) now CLASSIFIES every
  // candidate (movies: flag path; TV: cached-detail path) and drops adult
  // AND uncertain candidates unconditionally — the old provider-gated
  // post-filter was a no-op. Endpoint supports no query filters.
  const discoverFn = tmdb.match(/export async function getTmdbDiscover[\s\S]*?^}/m)?.[0] ?? '';
  assert.ok(discoverFn, 'getTmdbDiscover function body found');
  assert.match(discoverFn, /filterAdultFromListPage/, 'getTmdbDiscover runs the central classification filter');
  assert.doesNotMatch(discoverFn, /adultExclusion/, 'getTmdbDiscover no longer keys on the obsolete provider dimension');
  assert.match(discoverFn, /key = `tmdb:discover:\$\{type\}:\$\{page\}`/, 'getTmdbDiscover cache key is content-only (filter is a content fact)');
  // getTmdbCollection: TV via networks + transitional movie providers.
  assert.match(tmdb, /getTmdbCollection[\s\S]*?without_networks: networkExclusion/, 'getTmdbCollection TV excludes adult networks');
  assert.match(tmdb, /getTmdbCollection[\s\S]*?'without_watch_providers': providerExclusion/, 'getTmdbCollection movies keep transitional provider exclusion');
  // getTmdbPopular (legacy list endpoints): Phase 6 classification contract.
  const popularFn = tmdb.match(/export async function getTmdbPopular\([\s\S]*?^}/m)?.[0] ?? '';
  assert.ok(popularFn, 'getTmdbPopular function body found');
  assert.match(popularFn, /filterAdultFromListPage/, 'getTmdbPopular runs the central classification filter');
  assert.doesNotMatch(popularFn, /adultExclusion/, 'getTmdbPopular no longer keys on the obsolete provider dimension');
  // getTmdbTrendingMoviesByLanguage (movie-only): transitional providers.
  assert.match(tmdb, /getTmdbTrendingMoviesByLanguage[\s\S]*?adultExclusion/, 'getTmdbTrendingMoviesByLanguage computes adultExclusion');
}

// ============================================================================
// T. BUG 4 — Central classifier (isAdultContent).
// ============================================================================
{
  // isAdultContent function exists in adult-providers.ts.
  assert.match(adultProviders, /export function isAdultContent\(/, 'isAdultContent exported from adult-providers');
  // Checks tags.
  assert.match(adultProviders, /tags\?\.includes\('Adult'\)/, 'isAdultContent checks tags');
  // Checks provider IDs (when available).
  assert.match(adultProviders, /providerIds && providerIds\.length > 0/, 'isAdultContent checks provider IDs');
  // Checks TMDB adult flag (non-anime only).
  assert.match(adultProviders, /tmdbAdult === true && isAnime !== true/, 'isAdultContent checks TMDB adult flag for non-anime');
  // service.ts delegates to isAdultContent.
  assert.match(service, /import \{ isAdultContent.*\} from '\.\/adult-providers'/, 'service imports isAdultContent from adult-providers');
  assert.match(service, /return isAdultContent\(item\.tags, undefined, undefined, item\.isAnime, item\.networks\)/, 'service isAdultItem delegates to isAdultContent');
}

// ============================================================================
// W. Phase 2 — network-aware classifier foundation (Adult Mode rebuild).
// ============================================================================
{
  // Registry module exists with the verified/unverified verification model.
  const adultNetworks = await readFile(path.join(repoRoot, 'src/lib/server/content/adult-networks.ts'), 'utf8');
  assert.match(adultNetworks, /export type AdultNetwork/, 'AdultNetwork type exported');
  assert.match(adultNetworks, /'verified' \| 'unverified'/, 'verification label model exists');
  assert.match(adultNetworks, /export function getAdultNetworks/, 'getAdultNetworks exists');
  assert.match(adultNetworks, /export function getVerifiedAdultNetworks/, 'getVerifiedAdultNetworks exists');
  assert.match(adultNetworks, /export function getAdultNetworkIds/, 'getAdultNetworkIds exists');
  assert.match(adultNetworks, /export function isKnownAdultNetwork/, 'isKnownAdultNetwork exists');
  assert.match(adultNetworks, /export function getAdultNetworkById/, 'getAdultNetworkById exists');
  // Verified entries carry live-confirmed network IDs (2026-09-07 live TMDB check).
  assert.match(adultNetworks, /tmdbNetworkId: 2902/, 'Ullu network ID 2902 registered');
  assert.match(adultNetworks, /tmdbNetworkId: 4573/, 'Kooku network ID 4573 registered');
  assert.match(adultNetworks, /tmdbNetworkId: 7355/, 'Atrangii network ID 7355 registered');
  // Unverified entries must keep tmdbNetworkId 0 (no guessed IDs). Checked
  // per entry line (comments excluded) so the check cannot span boundaries.
  const unverifiedLines = adultNetworks
    .split('\n')
    .filter((line) => line.includes("verification: 'unverified'") && !line.trim().startsWith('//') && !line.trim().startsWith('*'));
  assert.ok(unverifiedLines.length >= 10, `unverified entries present in registry (${unverifiedLines.length})`);
  for (const line of unverifiedLines) {
    assert.match(line, /tmdbNetworkId: 0/, `unverified entry pairs label with id 0: ${line.trim()}`);
    assert.doesNotMatch(line, /tmdbNetworkId: [1-9]/, `unverified entry carries no nonzero id: ${line.trim()}`);
  }
  // Verified-only gating: the verified accessor filters by verification label.
  assert.match(adultNetworks, /entry\.verification === 'verified'/, 'verified accessor checks verification label');
  // Classifier imports the network registry (single central classifier).
  assert.match(adultProviders, /import \{ isKnownAdultNetwork \} from '\.\/adult-networks'/, 'classifier imports network registry');
  assert.match(adultProviders, /isKnownAdultNetwork\(network\)/, 'classifier consults isKnownAdultNetwork');
  assert.match(adultProviders, /networks\?: Array<\{ id\?: number \| null; name\?: string \| null \}> \| undefined/, 'isAdultContent accepts TV networks');
  // TMDB adapter carries TV networks through the detail path.
  assert.match(tmdb, /networks\?: TmdbNetwork\[\]/, 'TmdbTv type declares networks');
  assert.match(tmdb, /function extractTvNetworks/, 'extractTvNetworks helper exists');
  assert.match(tmdb, /networks: isMovie \? undefined : extractTvNetworks\(tv\)/, 'mapTmdb maps TV networks');
  assert.match(tmdb, /const networks = type === 'series' \? extractTvNetworks\(raw as TmdbTv\) : undefined/, 'detail extracts TV networks');
  // NormalizedMediaItem gains the additive networks metadata.
  const contentTypes = await readFile(path.join(repoRoot, 'src/lib/server/content/types.ts'), 'utf8');
  assert.match(contentTypes, /networks\?: Array<\{ id: number; name: string \}>/, 'NormalizedMediaItem has additive networks metadata');
  // Anime invariant is intact: anime detection unchanged and the TMDB adult
  // flag exemption still gates signal 4 only (asserted in L/T/V above).
}

// ============================================================================
// U. BUG 5 — Provider name matching (exact only, no substring).
// ============================================================================
{
  // Matching uses namesToTry.includes(providerName) — exact match only.
  assert.match(adultProviders, /namesToTry\.includes\(providerName\)/, 'provider matching uses exact includes (no substring)');
  // No .includes() bidirectional matching.
  assert.doesNotMatch(adultProviders, /providerName\.includes\(n\) \|\| n\.includes\(providerName\)/, 'no substring bidirectional matching');
}

// ============================================================================
// V. Anime — not classified as adult merely because it's anime.
// ============================================================================
{
  // isAdultContent skips TMDB adult flag when isAnime is true.
  assert.match(adultProviders, /tmdbAdult === true && isAnime !== true/, 'isAdultContent ignores TMDB adult flag for anime');
  // The isAnime check in mapTmdb is unchanged (genre 16 + ja).
  assert.match(tmdb, /isAnime = genreIds\.includes\(16\) && originalLanguage === 'ja'/, 'anime detection unchanged');
  // getTmdbAnimeMerged does NOT use without_watch_providers.
  const animeFn = tmdb.match(/export async function getTmdbAnimeMerged[\s\S]*?^}/m);
  assert.ok(animeFn, 'getTmdbAnimeMerged found');
  assert.doesNotMatch(animeFn![0], /without_watch_providers/, 'anime section does NOT exclude adult providers');
  assert.doesNotMatch(animeFn![0], /without_networks|with_networks/, 'anime section does NOT use network filters (Phase 3 invariant)');
}

// ============================================================================
// X. Phase 3 — network-based TMDB catalog migration (Adult Mode rebuild).
// ============================================================================
{
  // adult-catalog.ts bridge module exists and is registry-driven only.
  const adultCatalog = await readFile(path.join(repoRoot, 'src/lib/server/content/adult-catalog.ts'), 'utf8');
  assert.match(adultCatalog, /export function adultNetworkExclusionValue/, 'exclusion value builder exists');
  assert.match(adultCatalog, /export function withoutAdultNetworksParams/, 'without_networks builder exists');
  assert.match(adultCatalog, /export function withAdultNetworksParams/, 'with_networks builder exists');
  assert.match(adultCatalog, /export function getVerifiedAdultNetworkIdForKey/, 'verified key lookup exists');
  assert.match(adultCatalog, /import \{ getAdultNetworkIds, getVerifiedAdultNetworks \} from '\.\/adult-networks'/, 'bridge imports ONLY the registry (single source of truth)');
  assert.doesNotMatch(adultCatalog, /\b(2902|4573|7355)\b/, 'bridge contains no hardcoded network ids');
  // Adapter consumes the bridge; no network ids hardcoded in the adapter.
  assert.match(tmdb, /import \{ adultNetworkExclusionValue, withAdultNetworksParams, getVerifiedAdultNetworkIdForKey \} from '\.\.\/adult-catalog'/, 'adapter imports the adult-catalog bridge');
  assert.doesNotMatch(tmdb, /\b(2902|4573|7355)\b/, 'adapter contains no hardcoded network ids');
  // New-ott cache key embeds BOTH exclusion dimensions (TV networks + movie providers).
  assert.match(tmdb, /key = `tmdb:new-ott:.*:\$\{networkExclusion \?\? 'no-nets'\}:\$\{providerExclusion \?\? 'no-providers'\}`/, 'new-ott cache key embeds both exclusion dimensions');
}

// ============================================================================
// Y. Phase 4 — adult-aware search with bounded N+1 classification.
// ============================================================================
{
  // Pure search-classification module exists and is registry/classifier-driven only.
  const searchClassify = await readFile(path.join(repoRoot, 'src/lib/server/content/search-classify.ts'), 'utf8');
  assert.match(searchClassify, /export async function collectSafeSearchPage/, 'page-continuation orchestrator exists');
  assert.match(searchClassify, /export function movieRowVerdict/, 'movie-row cheap verdict exists');
  assert.match(searchClassify, /export function detailVerdict/, 'detail verdict reader exists');
  assert.match(searchClassify, /export function searchFilterMode/, 'authorization-aware mode decision exists');
  assert.match(searchClassify, /import \{ isAdultContent \} from '\.\/adult-providers'/, 'verdicts delegate to the ONE central classifier (no second classifier)');
  assert.match(searchClassify, /import \{ mapWithConcurrency \} from '\.\/concurrency'/, 'orchestrator uses the shared bounded-concurrency helper');
  assert.doesNotMatch(searchClassify, /\b(2902|4573|7355)\b/, 'search classification contains no hardcoded network ids');
  assert.doesNotMatch(searchClassify, /\$env/, 'search classification is env-free (tsx-testable)');
  // Fail-closed: the orchestrator drops uncertain candidates when filtering.
  assert.match(searchClassify, /if \(excludeUncertain\) continue/, 'uncertain candidates fail CLOSED for unauthorized search');
  // Shared concurrency helper exists once.
  const concurrencyModule = await readFile(path.join(repoRoot, 'src/lib/server/content/concurrency.ts'), 'utf8');
  assert.match(concurrencyModule, /export async function mapWithConcurrency/, 'shared bounded-concurrency helper exists');
  assert.doesNotMatch(tmdb, /async function mapWithConcurrency/, 'adapter no longer carries a duplicated concurrency helper');
  // Adapter wiring: constants, orchestrator use, mode branch.
  assert.match(tmdb, /const SEARCH_CLASSIFY_CONCURRENCY = 4/, 'search detail classification is bounded at 4 (spec: 4-6)');
  assert.match(tmdb, /const SEARCH_MAX_UPSTREAM_PAGES = 3/, 'upstream page walking is hard-capped');
  assert.match(tmdb, /collectSafeSearchPage<SearchCandidateRow>/, 'searchTmdb runs the classification orchestrator when filtering');
  assert.match(tmdb, /searchFilterMode\(canAccessAdult\) === 'authorized-passthrough'/, 'authorized branch decided by the pure mode function');
  // Search NEVER pretends TMDB supports provider/network filters on /search.
  const searchFn = tmdb.match(/export async function searchTmdb[\s\S]*?^}/m);
  assert.ok(searchFn, 'searchTmdb function body found');
  assert.doesNotMatch(searchFn![0], /without_watch_providers|without_networks|with_networks|with_watch_providers/, 'search requests carry NO unsupported TMDB filter params');
  assert.match(searchFn![0], /include_adult: false/, 'search keeps include_adult: false (untrusted first-pass filter)');
  // Fail-closed wiring: detail classification failure -> 'uncertain' (never "not adult").
  const classifyFn = tmdb.match(/async function classifySearchRow[\s\S]*?^}/m);
  assert.ok(classifyFn, 'classifySearchRow exists');
  assert.match(classifyFn![0], /catch \{\s*return 'uncertain';/, 'detail classification failure returns uncertain (fail-closed)');
  assert.match(classifyFn![0], /movieRowVerdict\(\{ adult: rawAdult, isAnime: item\.isAnime \}\)/, 'movie rows use the central-classifier cheap verdict');
}

// ============================================================================
// Z. Phase 5 — authorization security hardening (static wiring assertions).
//    Behavioral coverage for the same contracts lives in
//    scripts/adult_authorization_test.ts (real HMAC/timing-safe/matrix
//    execution). Static checks here prove the WIRING cannot regress.
// ============================================================================
{
  // Secret source: dedicated private server-only variable, never a public
  // value, never a fallback literal.
  assert.match(adultPolicy, /env\.MAVERO_ADULT_COOKIE_SECRET/, 'cookie secret comes from MAVERO_ADULT_COOKIE_SECRET');
  assert.doesNotMatch(adultPolicy, /PUBLIC_SUPABASE_URL|fallback-secret|mavero-guest-fallback/, 'no public value / fallback literal used as cookie secret');
  assert.doesNotMatch(adultCookie, /\$env|process\.env/, 'pure cookie module has NO env access (secret is an explicit parameter)');
  // The old forgeable construction is gone (no XOR-rolled hash, no
  // value-independent signature).
  assert.doesNotMatch(adultCookie, /hash << 5/, 'old XOR-rolled signature construction removed');
  assert.doesNotMatch(adultCookie, /charCodeAt/, 'no character-sum hash in the cookie module');
  // Timing-safe verification: crypto.timingSafeEqual is the security
  // decision; plain equality must not decide signature validity.
  assert.match(adultCookie, /timingSafeEqual\(/, 'signature comparison uses crypto.timingSafeEqual');
  const verifyFn = adultCookie.match(/export function verifyAdultCookieValue[\s\S]*?^}/m);
  assert.ok(verifyFn, 'verifyAdultCookieValue found');
  assert.match(verifyFn![0], /timingSafeStringEqual\(expected, sig\)/, 'signature verdict goes through the timing-safe comparison');
  assert.doesNotMatch(verifyFn![0], /sig === expected|expected === sig/, 'no plain-equality signature decision');
  // Fail-closed secret handling in the pure module.
  assert.match(adultCookie, /export function assertAdultCookieSecret/, 'issuance-secret assertion exists');
  const assertFn = adultCookie.match(/export function assertAdultCookieSecret[\s\S]*?^}/m);
  assert.ok(assertFn, 'assertAdultCookieSecret found');
  assert.match(assertFn![0], /throw new Error\(/, 'missing secret refuses ISSUANCE (fail-closed)');
  assert.match(adultCookie, /if \(typeof secret !== 'string' \|\| secret\.length === 0\) return false; \/\/ fail closed/, 'missing secret fails VERIFICATION closed (guest OFF)');
  // Canonical payload: only "1"/"0" are ever signed or accepted.
  assert.match(adultCookie, /export function canonicalAdultCookieValue/, 'canonical payload mapper exists');
  assert.match(adultCookie, /if \(value !== '1' && value !== '0'\) return false/, 'verification accepts canonical values only');
  // Matrix single-source: adult-policy delegates to evaluateAdultAccess and
  // keeps the verified admin-gate-first flow.
  assert.match(adultPolicy, /import \{[^}]*evaluateAdultAccess[^}]*\} from '\.\/adult-authz'/, 'adult-policy delegates the matrix to the single evaluation function');
  assert.match(adultPolicy, /getAdultAccessContext[\s\S]*?const adminGateAllows = isAuthenticated \? policy\.allowLoggedIn : policy\.allowGuest;/, 'admin gate-first flow preserved');
  // Authorization results are never cached in module/global memory: the
  // pure authz layer holds no mutable state and no cache structures.
  assert.doesNotMatch(adultAuthz, /new Map|cachedPolicy|POLICY_TTL/, 'no module-level authorization cache in the pure authz layer');
}

// ============================================================================
// AA. Phase 6 — direct enforcement, unsupported catalog paths + cache
//     isolation (static wiring assertions). Behavioral coverage for the
//     pure contracts lives in scripts/adult_phase6_enforcement_test.ts.
// ============================================================================
{
  // ---- Direct watch route guard ----
  assert.match(watchPageServer, /import \{ canAccessAdultContent \} from '\$lib\/server\/content\/adult-policy'/, 'watch route uses the Phase 5 authorization function');
  assert.match(watchPageServer, /detailVerdict\(item\.tags\) === 'adult'/, 'watch route classifies via the central classifier verdict');
  assert.match(watchPageServer, /await canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'watch route evaluates authorization per request');
  assert.match(watchPageServer, /throw error\(404, 'Title not found'\)/, 'unauthorized adult watch requests get the non-disclosing 404');
  // Guard runs BEFORE episodes + streaming config are fetched.
  const watchGuardIdx = watchPageServer.indexOf("detailVerdict(item.tags) === 'adult'");
  const watchEpisodesIdx = watchPageServer.indexOf('let episodes');
  assert.ok(watchGuardIdx > -1 && watchEpisodesIdx > watchGuardIdx, 'watch guard evaluates before episode/streaming data is fetched');

  // ---- Season endpoint guard ----
  assert.match(seasonEndpoint, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'season endpoint evaluates authorization per request');
  assert.match(seasonEndpoint, /detailVerdict\(parent\.tags\) === 'adult'/, 'season endpoint classifies the PARENT title via the central classifier');
  assert.match(seasonEndpoint, /status: 404/, 'season endpoint answers unauthorized adult requests with a non-disclosing 404');
  // Fail-closed: classification failure -> 404 (never unclassified episode data).
  assert.match(seasonEndpoint, /catch \{[\s\S]*?status: 404/, 'season endpoint fails CLOSED when the parent cannot be classified');

  // ---- List-rail classification module (pure, single-classifier) ----
  assert.match(listClassify, /import \{ movieRowVerdict, detailVerdict.* \} from '\.\/search-classify'/, 'list classification reuses the Phase 4 verdict helpers (no second classifier)');
  assert.doesNotMatch(listClassify, /\$env|process\.env/, 'list classification is env-free (tsx-testable)');
  assert.doesNotMatch(listClassify, /\b(2902|4573|7355)\b/, 'list classification contains no hardcoded network ids');
  assert.doesNotMatch(listClassify, /from '\.\/adult-policy'|from '\.\/adult-authz'/, 'list classification imports NO authorization layer (normal rails are always adult-free)');
  assert.match(listClassify, /export async function filterSafeRailItems/, 'bounded rail filter exists');
  assert.match(listClassify, /export function shouldFilterDetailRecommendations/, 'recommendation-filter decision exists');
  assert.match(listClassify, /mapWithConcurrency/, 'rail classification is bounded by the shared concurrency helper');

  // ---- Adapter wiring: trending + legacy popular + theatre + genre ----
  assert.match(tmdb, /const RAIL_CLASSIFY_CONCURRENCY = 4/, 'unsupported-rail classification is bounded at 4');
  assert.match(tmdb, /const railDetailVerdictLoader: DetailVerdictLoader/, 'rail TV candidates classify through the cached detail path');
  assert.match(tmdb, /getTmdbNowPlaying[\s\S]*?filterAdultFromListPage/, 'theatre rail classifies candidates (Phase 6)');
  assert.match(tmdb, /getTmdbGenreByLanguage[\s\S]*?watch_region: 'IN'/, 'genre rail provider exclusion is region-corrected (Phase 6 bug fix)');
  assert.match(tmdb, /getTmdbGenreByLanguage[\s\S]*?filterAdultFromListPage/, 'genre rail classifies candidates (Phase 6)');

  // ---- Detail recommendations leak fix ----
  assert.match(service, /export async function getDetailWithSafeRecommendations/, 'consumer detail path filters recommendations');
  assert.match(service, /shouldFilterDetailRecommendations\(detail\.tags\)/, 'recommendation filtering is decided by the parent CLASSIFICATION (content fact)');
  const detailPages = [
    'src/routes/movie/[id]/+page.server.ts',
    'src/routes/series/[id]/+page.server.ts',
    'src/routes/anime/[id]/+page.server.ts',
    'src/routes/api/content/[type]/[id]/+server.ts'
  ];
  for (const rel of detailPages) {
    const src = await readFile(path.join(repoRoot, rel), 'utf8');
    assert.match(src, /getDetailWithSafeRecommendations/, `${rel} uses the rec-safe consumer detail path`);
  }
  // Playback resolver keeps the raw path (protected area untouched).
  const resolverService = await readFile(path.join(repoRoot, 'src/lib/server/resolver/service.ts'), 'utf8');
  assert.match(resolverService, /await getDetail\(/, 'resolver keeps the raw getDetail path (no playback regression)');

  // ---- Upcoming module enforcement ----
  assert.match(upcomingSource, /loadUpcomingMovies[\s\S]*?include_adult: false/, 'upcoming movies send include_adult: false');
  assert.match(upcomingSource, /loadUpcomingMovies[\s\S]*?'without_watch_providers': providerExclusion, watch_region: region/, 'upcoming movies apply the transitional provider exclusion WITH region');
  assert.match(upcomingSource, /loadUpcomingSeries[\s\S]*?without_networks: networkExclusion/, 'upcoming series excludes verified adult networks (canonical)');
  assert.match(upcomingSource, /loadUpcomingAnime[\s\S]*?without_networks: networkExclusion/, 'upcoming anime excludes verified adult networks (flag exemption preserved)');
  assert.match(upcomingSource, /isAdultContent\(undefined, undefined, undefined, isAnimeCandidate, detail\.networks\)/, 'upcoming series classification uses the ONE central classifier over detail networks');
  assert.match(upcomingSource, /movieRowVerdict\(\{[\s\S]*?adult: m\.adult/, 'upcoming movie rows classify through the central-classifier flag path');

  // ---- Cache isolation (structural) ----
  // Normal-rail caches and the adult-rail cache live in DISJOINT namespaces;
  // the authorization decision is part of the search key (behavioral proof
  // in the Phase 6 suite). The adult-shows cache key carries no consumer
  // authorization dimension because NO unauthorized request can reach it.
  assert.match(tmdb, /key = `tmdb:adult-shows:/, 'adult-rail responses live in their own cache namespace');
  assert.match(listClassify, /NO authorization parameter in this module/, 'rail filtering keeps authorization out (documented structural contract)');
}


// ============================================================================
// AB. Phase 7 — dedicated Adult Discover catalog (static wiring assertions).
//     Behavioral coverage for the pure contracts lives in
//     scripts/adult_discover_test.ts.
// ============================================================================
{
  // ---- Pure contract module (adult-discover.ts) ----
  assert.match(adultDiscoverModule, /export async function collectConfirmedAdultPage/, 'the fail-closed page collector exists');
  assert.match(adultDiscoverModule, /export async function classifyAdultDiscoverRow/, 'the candidate classifier exists');
  assert.match(adultDiscoverModule, /export function buildAdultDiscoverCacheKey/, 'the isolated cache-key builder exists');
  assert.match(adultDiscoverModule, /export function emptyAdultDiscoverResult/, 'the empty non-disclosing result exists');
  assert.match(adultDiscoverModule, /export function parseAdultDiscoverPage/, 'page clamping exists');
  assert.match(adultDiscoverModule, /export const ADULT_DISCOVER_CACHE_NAMESPACE = 'tmdb:adult-discover'/, 'the Adult Discover cache namespace is its own prefix');
  assert.match(adultDiscoverModule, /export const ADULT_DISCOVER_MAX_UPSTREAM_PAGES = 3/, 'page walking is hard-capped at 3 upstream pages');
  assert.match(adultDiscoverModule, /export const ADULT_DISCOVER_CLASSIFY_CONCURRENCY = 4/, 'classification concurrency is bounded at 4');
  assert.match(adultDiscoverModule, /export const ADULT_DISCOVER_PAGE_SIZE = 10/, 'the visible page size matches the Discover convention');
  // Single classifier: the module reuses the Phase 4 verdict helpers and
  // imports NO authorization layer and NO env (pure, tsx-testable).
  assert.match(adultDiscoverModule, /import \{ movieRowVerdict, type CandidateVerdict, type UpstreamSearchPage \} from '\.\/search-classify'/, 'the contract reuses the ONE central classifier verdict helpers');
  assert.doesNotMatch(adultDiscoverModule, /from '\.\/adult-policy'|from '\.\/adult-authz'/, 'the Adult Discover contract imports NO authorization layer (the decision is injected per request)');
  assert.doesNotMatch(adultDiscoverModule, /\$env|process\.env/, 'the Adult Discover contract is env-free');
  assert.doesNotMatch(adultDiscoverModule, /\b(2902|4573|7355)\b/, 'the Adult Discover contract contains no hardcoded network ids');
  assert.doesNotMatch(adultDiscoverModule, /fixturesFor|\$data\/content/, 'the Adult Discover contract has NO fixture/normal-catalog fallback');
  // Fail-closed semantics are structural: only 'adult' verdicts are
  // collected; 'safe' anomalies and 'uncertain' failures are dropped.
  assert.match(adultDiscoverModule, /if \(verdict === 'adult'\)/, 'the collector collects ONLY confirmed Adult candidates');
  assert.match(adultDiscoverModule, /if \(verdict === 'uncertain'\)[\s\S]*?continue/, 'uncertain candidates fail CLOSED (dropped, never mapped to adult)');
  assert.match(adultDiscoverModule, /excludedNotAdult \+= 1/, 'non-adult anomalies are dropped (never silently presented as Adult)');
  assert.match(adultDiscoverModule, /catch \{[\s\S]*?return 'uncertain';/, 'a failed classification maps to uncertain (never adult)');
  assert.match(adultDiscoverModule, /mapWithConcurrency/, 'classification runs through the shared bounded-concurrency helper');

  // ---- Endpoint (authorization-first, strict validation, no client flags) ----
  assert.match(adultDiscoverEndpoint, /import \{ canAccessAdultContent \} from '\$lib\/server\/content\/adult-policy'/, 'the endpoint uses the Phase 5 authorization function');
  assert.match(adultDiscoverEndpoint, /await canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'authorization is evaluated per request');
  const authIdx = adultDiscoverEndpoint.indexOf('await canAccessAdultContent');
  const validationIdx = adultDiscoverEndpoint.indexOf('isAdultDiscoverType(typeParam)');
  const serviceIdx = adultDiscoverEndpoint.indexOf('await adultDiscover(');
  assert.ok(authIdx > -1 && validationIdx > authIdx && serviceIdx > validationIdx, 'authorization runs FIRST, before validation and before the catalog service');
  assert.match(adultDiscoverEndpoint, /status: 404/, 'unauthorized requests get the non-disclosing 404');
  assert.match(adultDiscoverEndpoint, /isAdultDiscoverType/, 'type is validated against the closed union');
  assert.match(adultDiscoverEndpoint, /isAdultDiscoverLanguage/, 'language is validated against the closed union');
  assert.match(adultDiscoverEndpoint, /isAdultDiscoverSort/, 'sort is validated against the closed union');
  assert.match(adultDiscoverEndpoint, /parseAdultDiscoverPage/, 'pagination is clamped');
  // No client-supplied adult flag can act as authorization (no adult /
  // include_adult query parameter is ever read).
  assert.doesNotMatch(adultDiscoverEndpoint, /searchParams\.get\(['"](include_)?adult['"]\)/, 'no client adult flag is read as authorization');
  assert.doesNotMatch(adultDiscoverEndpoint, /with_networks/, 'no network filter is client-controllable');
  assert.match(adultDiscoverEndpoint, /contentErrorResponse/, 'upstream failures surface as errors (never a normal-catalog fallback)');

  // ---- Service wrapper (defense-in-depth, no fixture fallback) ----
  assert.match(service, /export async function adultDiscover\(filters: AdultDiscoverFilters, canAccessAdult = false\)/, 'the dedicated Adult Discover service entry exists');
  const adultDiscoverFn = service.match(/export async function adultDiscover\([\s\S]*?^}/m);
  assert.ok(adultDiscoverFn, 'adultDiscover function found');
  assert.match(adultDiscoverFn![0], /if \(!canAccessAdult\)[\s\S]*?return emptyAdultDiscoverResult/, 'the service re-checks authorization (defense-in-depth empty result)');
  assert.doesNotMatch(adultDiscoverFn![0], /fixturesFor/, 'the Adult Discover service NEVER falls back to fixtures/normal content');
  assert.match(service, /getTmdbAdultDiscover \} from '\.\/adapters\/tmdb'/, 'the service delegates to the dedicated adapter function');

  // ---- Adapter (server-controlled source + isolated cache + classifier) ----
  assert.match(tmdb, /export async function getTmdbAdultDiscover/, 'the dedicated Adult Discover adapter function exists');
  const adultDiscoverAdapter = tmdb.match(/export async function getTmdbAdultDiscover[\s\S]*?^}/m);
  assert.ok(adultDiscoverAdapter, 'getTmdbAdultDiscover found');
  // Post-release fix: the TV source is still the VERIFIED adult network
  // registry — 'all' (or absent) keeps the full verified set; an optional
  // closed-union provider key narrows to that single verified id via
  // withAdultNetworksParams(selectedNetworkId) (verified-only builder).
  assert.match(adultDiscoverAdapter![0], /withAdultNetworksParams\(selectedNetworkId\)/, 'the TV source is the VERIFIED adult network registry (optionally narrowed to a verified provider id)');
  assert.match(adultDiscoverAdapter![0], /getVerifiedAdultNetworkIdForKey\(selectedProviderKey\)/, 'the provider key resolves through the verified registry (never a client id)');
  assert.match(adultDiscoverAdapter![0], /getAdultProviderIds\(\)/, 'the movie source is the resolved transitional provider set');
  assert.match(adultDiscoverAdapter![0], /include_adult: true/, 'the Adult surface queries with include_adult: true');
  assert.match(adultDiscoverAdapter![0], /buildAdultDiscoverCacheKey/, 'responses cache under the isolated adult-discover namespace');
  assert.match(adultDiscoverAdapter![0], /collectConfirmedAdultPage/, 'candidates pass the fail-closed classification defense');
  assert.match(adultDiscoverAdapter![0], /emptyAdultDiscoverResult/, 'a missing verified source yields the empty result (no fabricated ids)');
  // Classification flows through the shared cached detail path (content facts only).
  assert.match(tmdb, /const adultDiscoverDetailVerdictLoader: AdultDiscoverDetailVerdictLoader = async \(mediaType, tmdbId\) => \{[\s\S]*?await getTmdbDetail\(mediaType, tmdbId\)/, 'the verdict loader reads the central classification from the cached detail path');
  assert.match(adultDiscoverAdapter![0], /adultDiscoverDetailVerdictLoader/, 'Adult Discover candidates classify through the cached-detail verdict loader');
  // The TV half must carry NO JustWatch prerequisites (region/flatrate/providers):
  // the movie branch is the region-scoped transitional provider query, and the
  // TV branch spreads ONLY the network inclusion.
  assert.match(adultDiscoverAdapter![0], /\? \{ watch_region: 'IN', with_watch_monetization_types: 'flatrate', with_watch_providers: providerInclusion \}/, 'the movie source is the transitional provider query (region-scoped)');
  assert.match(adultDiscoverAdapter![0], /: \{ \.\.\.networkInclusion \}/, 'the TV params spread ONLY the network inclusion (no JustWatch prerequisites)');

  // ---- Normal Discover isolation: the shared rail path is untouched ----
  assert.match(railEndpoint, /sectionParam === 'adult-shows'/, 'the normal rail endpoint still gates its adult-shows section separately');
  assert.doesNotMatch(adultDiscoverEndpoint, /discoverRail/, 'the Adult Discover endpoint does NOT reuse the shared rail path (dedicated contract)');
  assert.match(service, /import \{ isDiscoverLanguageValue \} from '\.\/types'/, 'the language guard has a single shared source (no drift between surfaces)');
}


// ============================================================================
// AC. Phase 8 — Popular TV cleanup + Adult Discover UI integration (static
//     wiring assertions). Behavioral coverage lives in
//     scripts/adult_phase8_ui_test.ts.
// ============================================================================
{
  // ---- Popular TV: the unconditional generic-genre exclusion ----
  assert.match(types, /export const POPULAR_TV_WITHOUT_GENRES = '10764\|10766\|10767'/, 'the Popular TV genre exclusion constant is the exact Soap/News/Talk id set');
  const popularByLang = tmdb.match(/export async function getTmdbPopularByLanguage[\s\S]*?^}/m);
  assert.ok(popularByLang, 'getTmdbPopularByLanguage found');
  assert.match(popularByLang![0], /without_genres: genreExclusion/, 'Popular TV TV-half sends without_genres');
  assert.match(popularByLang![0], /const genreExclusion = type === 'series' \? POPULAR_TV_WITHOUT_GENRES : undefined/, 'the genre exclusion applies ONLY to the TV half (movies untouched)');
  assert.match(popularByLang![0], /\$\{genreExclusion \?\? 'no-genre-exclusion'\}/, 'the popular cache key embeds the genre-exclusion dimension');
  // The exclusion is UNCONDITIONAL: no Adult Mode branch can remove it.
  assert.doesNotMatch(popularByLang![0], /if \(adult|canAccessAdult/, 'no Adult Mode conditional around the normal Popular TV query');
  // The genre filter is additional — the adult exclusion and classifier stay.
  assert.match(popularByLang![0], /without_networks: networkExclusion/, 'verified adult network exclusion retained on Popular TV');
  assert.match(popularByLang![0], /include_adult: false/, 'include_adult=false retained on Popular TV');

  // ---- Adult Discover UI: the dedicated, endpoint-only rail component ----
  const adultSection = await readFile(path.join(repoRoot, 'src/lib/components/AdultDiscoverSection.svelte'), 'utf8');
  assert.match(adultSection, /\/api\/content\/adult-discover/, 'the Adult rail component calls ONLY the Phase 7 endpoint');
  // Every fetch in the component routes through the dedicated URL builder —
  // the legacy rail endpoint can never be called (code-shape assertion; the
  // module doc comment may reference the old endpoint as documentation).
  const acFetches = [...adultSection.matchAll(/fetch\((.{0,40})/g)];
  assert.ok(acFetches.length >= 2, 'the Adult rail has first-load and show-more fetches');
  // Post-release fix: the CATALOG fetches route through discoverUrl (the
  // Phase 7 endpoint builder); the provider OPTIONS fetch goes to the
  // policy-gated verified-registry endpoint (display-only, never the
  // catalog). Assert both contracts separately.
  const catalogFetches = acFetches.filter((call) => !/adult-providers/.test(call[1]));
  assert.ok(catalogFetches.length >= 2, 'catalog first-load and show-more fetches route through discoverUrl');
  for (const call of catalogFetches) {
    assert.match(call[1], /discoverUrl\(/, 'every Adult rail CATALOG fetch routes through discoverUrl (the Phase 7 endpoint builder)');
  }
  assert.match(adultSection, /fetch\('\/api\/discover\/adult-providers'\)/, 'provider options come from the policy-gated verified-registry endpoint');
  assert.doesNotMatch(adultSection, /with_networks|watch_providers|include_adult/, 'the Adult rail sends no source/authorization parameters');
  assert.match(adultSection, /import MediaCard from '\$components\/MediaCard\.svelte'/, 'the Adult rail reuses the existing card component (no duplication)');
  assert.match(adultSection, /status === 404/, 'the Adult rail treats the non-disclosing 404 as section-hidden (never as data)');

  // ---- DiscoverPage migration: legacy dropdown gone, server-driven visibility ----
  assert.doesNotMatch(discoverPage, /section="adult-shows"/, 'DiscoverPage no longer renders the legacy adult-shows rail');
  assert.doesNotMatch(discoverPage, /adult-providers/, 'DiscoverPage no longer fetches the legacy provider dropdown');
  assert.match(discoverPage, /\{#if adultCanAccess\}/, 'the Adult surface renders only on the server-reported state');
  assert.match(discoverPage, /<AdultDiscoverSection/, 'DiscoverPage mounts the dedicated Adult Discover component');

  // ---- Legacy endpoints retained but still protected ----
  assert.match(railEndpoint, /sectionParam === 'adult-shows'/, 'the legacy rail endpoint remains special-cased');
  assert.match(railEndpoint, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'the legacy rail endpoint still evaluates the policy per request');
  assert.match(adultProvidersApi, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'the legacy provider dropdown endpoint still evaluates the policy per request');
  assert.match(adultProvidersApi, /providers: \[\]/, 'the legacy dropdown endpoint still answers unauthorized requests with an empty list');
}


console.log('Adult mode tests passed: provider registry (A); admin policy (B); user preference (C); guest cookie (D); provider resolution (D2); normal rail exclusion (E); popular TV OTT (F); adult rail (G); search filtering (H); direct access (I); cache isolation (J); SSR/hydration (K); anime safety (L); scope regression (M); migration (N); admin UI (O); profile/settings UI (P); direct detail classification (Q); search cache key (R); generic catalog exclusion (S); central classifier (T); provider matching (U); anime safety detailed (V); network-aware classifier foundation (W); network-based catalog migration (X); adult-aware search classification (Y); authorization hardening wiring (Z); direct enforcement + unsupported paths + cache isolation (AA); dedicated Adult Discover catalog (AB); popular TV cleanup + Adult Discover UI integration (AC).');
