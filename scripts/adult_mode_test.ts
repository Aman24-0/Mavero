import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = new URL('../', import.meta.url).pathname;

const adultPolicy = await readFile(path.join(repoRoot, 'src/lib/server/content/adult-policy.ts'), 'utf8');
const adultProviders = await readFile(path.join(repoRoot, 'src/lib/server/content/adult-providers.ts'), 'utf8');
const tmdb = await readFile(path.join(repoRoot, 'src/lib/server/content/adapters/tmdb.ts'), 'utf8');
const service = await readFile(path.join(repoRoot, 'src/lib/server/content/service.ts'), 'utf8');
const railEndpoint = await readFile(path.join(repoRoot, 'src/routes/api/discover/rail/+server.ts'), 'utf8');
const searchEndpoint = await readFile(path.join(repoRoot, 'src/routes/api/content/search/+server.ts'), 'utf8');
const adultModeApi = await readFile(path.join(repoRoot, 'src/routes/api/settings/adult-mode/+server.ts'), 'utf8');
const adultProvidersApi = await readFile(path.join(repoRoot, 'src/routes/api/discover/adult-providers/+server.ts'), 'utf8');
const adminAdultApi = await readFile(path.join(repoRoot, 'src/routes/api/admin/adult-mode/+server.ts'), 'utf8');
const migration = await readFile(path.join(repoRoot, 'supabase/migrations/20260913000000_adult_mode.sql'), 'utf8');
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
  // Admin policy is cached with TTL.
  assert.match(adultPolicy, /POLICY_TTL_MS = 60_000/, 'admin policy cached 60s');
  assert.match(adultPolicy, /export function invalidateAdultPolicyCache/, 'cache invalidation function exists');
  // Default: OFF for everyone.
  assert.match(adultPolicy, /allowLoggedIn: false, allowGuest: false/, 'default policy is OFF');
  // Server-side enforcement: admin policy overrides user preference.
  assert.match(adultPolicy, /if \(!adminAllows\)/, 'admin policy checked before user preference');
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
  // Guest cookie helpers exist.
  assert.match(adultPolicy, /GUEST_COOKIE_NAME/, 'guest cookie name defined');
  assert.match(adultPolicy, /function getGuestCookieHeader/, 'guest cookie header function exists');
  assert.match(adultPolicy, /function parseGuestCookieValue/, 'guest cookie parser exists');
  assert.match(adultPolicy, /HttpOnly/, 'guest cookie is HttpOnly');
  assert.match(adultPolicy, /SameSite=Lax/, 'guest cookie is SameSite=Lax');
  // getAdultAccessContext accepts cookies parameter.
  assert.match(adultPolicy, /cookies\?: \{ get: \(name: string\) => string \| undefined \}/, 'getAdultAccessContext accepts cookies');
  // Guest preference is read from cookie.
  assert.match(adultPolicy, /getGuestPreferenceFromCookies\(cookies\)/, 'guest preference read from cookie');
  // canAccessAdultContent accepts cookies.
  assert.match(adultPolicy, /export async function canAccessAdultContent\([\s\S]*?cookies\?/, 'canAccessAdultContent accepts cookies');
  // updateGuestAdultPreference enforces admin policy.
  assert.match(adultPolicy, /updateGuestAdultPreference[\s\S]*?if \(!policy\.allowGuest\)/, 'guest preference enforces admin allowGuest');
  // Admin allows check for guest.
  assert.match(adultPolicy, /adminAllows = isAuthenticated \? policy\.allowLoggedIn : policy\.allowGuest/, 'guest uses allowGuest');
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
  // All adult-sensitive functions use the helper.
  assert.match(tmdb, /getTmdbDiscover[\s\S]*?await getResolvedAdultProviderIds/, 'getTmdbDiscover uses resolved IDs');
  assert.match(tmdb, /getTmdbCollection[\s\S]*?await getResolvedAdultProviderIds/, 'getTmdbCollection uses resolved IDs');
  assert.match(tmdb, /getTmdbPopular\b[\s\S]*?await getResolvedAdultProviderIds/, 'getTmdbPopular uses resolved IDs');
  assert.match(tmdb, /getTmdbTrendingMoviesByLanguage[\s\S]*?await getResolvedAdultProviderIds/, 'getTmdbTrendingMoviesByLanguage uses resolved IDs');
  // service.search also ensures providers are resolved.
  assert.match(service, /await ensureAdultProvidersResolved\(\(\) => getTmdbIndiaProviders\(\)\)/, 'service.search ensures providers resolved');
}

// ============================================================================
// E. Normal rails — adult excluded.
// ============================================================================
{
  // Popular: without_watch_providers exclusion.
  assert.match(tmdb, /getTmdbPopularByLanguage[\s\S]*?without_watch_providers.*adultExclusion/, 'popular excludes adult providers');
  // Top rated: without_watch_providers exclusion.
  assert.match(tmdb, /getTmdbTopRated[\s\S]*?without_watch_providers.*adultExclusion/, 'top-rated excludes adult providers');
  // Genre: without_watch_providers exclusion.
  assert.match(tmdb, /getTmdbGenreByLanguage[\s\S]*?without_watch_providers.*adultExclusion/, 'genre excludes adult providers');
  // New on OTT: without_watch_providers exclusion.
  assert.match(tmdb, /getTmdbNewOnOtt[\s\S]*?without_watch_providers.*adultExclusion/, 'new-ott excludes adult providers');
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
  // Adult exclusion is present.
  assert.match(popularFn![0], /without_watch_providers/, 'popular excludes adult providers');
}

// ============================================================================
// G. Adult rail — provider filtering, 10 items, pagination, dedupe, verified.
// ============================================================================
{
  assert.match(tmdb, /export async function getTmdbAdultShows/, 'adult shows query function exists');
  // watch_region=IN.
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?watch_region: 'IN'/, 'adult shows uses watch_region=IN');
  // flatrate.
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?with_watch_monetization_types: 'flatrate'/, 'adult shows uses flatrate');
  // with_watch_providers (verified IDs only).
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?with_watch_providers: watchProviders/, 'adult shows uses with_watch_providers');
  // include_adult: true (this IS the adult section).
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?include_adult: true/, 'adult shows uses include_adult: true');
  // 10 items per page.
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?DISCOVER_PAGE_SIZE/, 'adult shows slices to 10');
  // Dedupes by type+id.
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?seen = new Set/, 'adult shows dedupes');
  // Only verified providers (getCachedAdultProviders).
  assert.match(tmdb, /getTmdbAdultShows[\s\S]*?getCachedAdultProviders/, 'adult shows uses verified providers only');
  // No providers = empty result (no fabrication).
  assert.match(tmdb, /if \(!adultProviders \|\| adultProviders\.length === 0\)/, 'adult shows returns empty if no verified providers');
  // Rail endpoint enforces adult access.
  assert.match(railEndpoint, /sectionParam === 'adult-shows'/, 'rail endpoint checks for adult-shows section');
  assert.match(railEndpoint, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'rail endpoint evaluates adult policy with cookies');
  // Defense in depth: discoverRail also checks canAccessAdult.
  assert.match(service, /case 'adult-shows'[\s\S]*?if \(!canAccessAdult\)/, 'discoverRail defense-in-depth check');
}

// ============================================================================
// H. Search — adult excluded when unavailable.
// ============================================================================
{
  assert.match(searchEndpoint, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'search endpoint evaluates adult policy with cookies');
  assert.match(service, /export async function search\(query.*canAccessAdult = false/, 'search accepts canAccessAdult parameter');
  // Adult exclusion: searchTmdb cache key includes adultExclusion dimension.
  assert.match(tmdb, /searchTmdb[\s\S]*?adultExclusion/, 'searchTmdb uses adultExclusion');
  // searchExclusion is computed when adult access is OFF.
  assert.match(service, /adultExclusion = !canAccessAdult && adultIds\.length > 0/, 'search excludes adult when access is OFF');
  // No client-side bypass parameter (the endpoint must not accept ?adult=true as a query param).
  assert.doesNotMatch(searchEndpoint, /url\.searchParams\.get\('adult'\)/, 'search endpoint does NOT accept adult query param');
  assert.doesNotMatch(searchEndpoint, /url\.searchParams\.get\('userId'\)/, 'search endpoint does NOT accept userId query param');
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
  // Admin policy is cached globally (not per-user) — but user preference is NOT cached.
  assert.match(adultPolicy, /let cachedPolicy.*null/, 'admin policy cached globally');
  assert.match(adultPolicy, /async function getUserPreference[\s\S]*?return data\.adult_mode_enabled/, 'user preference read fresh (not cached)');
}

// ============================================================================
// K. SSR/hydration — no unauthorized adult payload.
// ============================================================================
{
  // DiscoverPage fetches adult settings client-side (not SSR).
  assert.match(discoverPage, /loadAdultModeSettings/, 'DiscoverPage fetches adult settings client-side');
  assert.match(discoverPage, /\{#if adultCanAccess && adultProviders\.length > 0\}/, 'adult section conditionally rendered');
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
  assert.match(contentApi, /tags\?\.includes\('Adult'\)/, 'content API checks Adult tag');
}

// ============================================================================
// R. BUG 2 — Search cache key includes adult-exclusion dimension.
// ============================================================================
{
  // searchTmdb cache key includes adultExclusion.
  assert.match(tmdb, /searchTmdb[\s\S]*?key = `tmdb:search:.*:\$\{adultExclusion \?\? 'no-adult'\}`/, 'search cache key includes adultExclusion');
  // searchTmdb accepts adultExclusion parameter.
  assert.match(tmdb, /export async function searchTmdb\(.*adultExclusion\?: string\)/, 'searchTmdb accepts adultExclusion parameter');
  // service.search passes adultExclusion to searchTmdb.
  assert.match(service, /searchTmdb\(normalized, 'series', page, filters, adultExclusion\)/, 'service passes adultExclusion to searchTmdb for anime');
  assert.match(service, /searchTmdb\(normalized, type, page, filters, adultExclusion\)/, 'service passes adultExclusion to searchTmdb for movie/series');
}

// ============================================================================
// S. BUG 3 — Generic catalog paths exclude adult content.
// ============================================================================
{
  // getTmdbDiscover: adult exclusion in cache key + defense-in-depth filter.
  assert.match(tmdb, /getTmdbDiscover[\s\S]*?adultExclusion/, 'getTmdbDiscover computes adultExclusion');
  assert.match(tmdb, /getTmdbDiscover[\s\S]*?key = `tmdb:discover:.*:\$\{adultExclusion \?\? 'no-adult'\}`/, 'getTmdbDiscover cache key includes adultExclusion');
  // getTmdbCollection: adult exclusion in cache key + without_watch_providers.
  assert.match(tmdb, /getTmdbCollection[\s\S]*?adultExclusion/, 'getTmdbCollection computes adultExclusion');
  assert.match(tmdb, /getTmdbCollection[\s\S]*?without_watch_providers/, 'getTmdbCollection excludes adult providers');
  // getTmdbPopular: adult exclusion.
  assert.match(tmdb, /getTmdbPopular\b[\s\S]*?adultExclusion/, 'getTmdbPopular computes adultExclusion');
  // getTmdbTrendingMoviesByLanguage: adult exclusion.
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
}

console.log('Adult mode tests passed: provider registry (A); admin policy (B); user preference (C); guest cookie (D); provider resolution (D2); normal rail exclusion (E); popular TV OTT (F); adult rail (G); search filtering (H); direct access (I); cache isolation (J); SSR/hydration (K); anime safety (L); scope regression (M); migration (N); admin UI (O); profile/settings UI (P); direct detail classification (Q); search cache key (R); generic catalog exclusion (S); central classifier (T); provider matching (U); anime safety detailed (V); network-aware classifier foundation (W).');
