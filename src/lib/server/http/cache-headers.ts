// Phase 2-C (audit PERF-003) — Public HTTP cache headers.
//
// Catalog content (Discover, Upcoming, providers) is the same for every
// anonymous AND authenticated user — it carries NO user state, NO Adult
// Mode dimension (TMDB's `include_adult=false` filter is enforced at the
// adapter layer), and NO per-user preferences. A short CDN cache window
// eliminates repeat upstream TMDB calls without leaking any user state.
//
// The policy intentionally uses `s-maxage` (CDN cache) + a longer
// `stale-while-revalidate` (serves stale while refreshing in the
// background). The browser is given a short `max-age` so user-facing
// refresh still picks up recent changes quickly.
//
// IMPORTANT — these constants are ONLY safe to apply to endpoints that:
//   1. Carry no per-user / per-session state.
//   2. Do NOT vary by Adult Mode (or prove the cache key separates the
//      authorization dimension — none of the catalog endpoints here
//      currently do, so user-state-dependent endpoints MUST stay
//      `private` / `no-store`).
//   3. Are GET (cache headers on POST/PUT/DELETE have no useful effect
//      and can confuse intermediaries).
//
// Endpoints that MUST NOT use these constants:
//   - /api/account/* (user-scoped)
//   - /api/playback/* (stream URLs, must not be cached)
//   - /api/downloader/mavero/* + /api/downloader/4k (Adult Mode protected)
//   - /api/admin/* (admin-only)
//   - /api/settings/adult-mode (per-user preference)
//   - /api/content/adult-discover (fully gated by Adult Mode)
//   - /api/content/[type]/[id] when the title is adult (per-request policy)
//   - /api/content/search (per-request Adult Mode evaluation)
//   - /api/discover/rail section='adult-shows' (per-request Adult Mode)
//   - /api/discover/adult-providers (per-request Adult Mode)

// CDN-friendly public catalog cache. 4 minutes fresh at the CDN, 10 minutes
// of stale-while-revalidate, 30 seconds of browser max-age so user-facing
// refresh picks up recent changes quickly.
export const PUBLIC_CATALOG_CACHE = 'public, max-age=30, s-maxage=240, stale-while-revalidate=600';

// Already-existing endpoints that use a short public browser cache — kept
// as a named constant so the policy is documented in one place.
export const PUBLIC_SHORT_CACHE = 'public, max-age=15, stale-while-revalidate=30';

// Private cache for endpoints whose response depends on the requesting
// user (e.g. streaming config may reflect admin-managed provider state,
// but is otherwise identical across users of the same deployment).
export const PRIVATE_SHORT_CACHE = 'private, max-age=15, stale-while-revalidate=30';

// No-store — for endpoints that mutate state, return per-request tokens,
// or expose stream URLs / secrets.
export const NO_STORE = 'no-store' as const;
