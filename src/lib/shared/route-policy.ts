/**
 * Phase 2-F (audit PERF-006) — Library-aware route classification.
 *
 * Pure, dependency-free classification of which client routes need the
 * authenticated cloud library sync (progress / favorites / Continue
 * Watching / My List cloud reconciliation). Consumed by the root layout
 * (`src/routes/+layout.svelte`) to gate the expensive `syncAuthenticatedState()`
 * call — previously fired on EVERY layout mount for EVERY authenticated
 * user, even on routes where no library state is shown (e.g. /auth/sign-in,
 * /search, /upcoming, /admin/*).
 *
 * Library state is shown on:
 *   - /my-list              (Continue Watching + My List cloud reconciliation)
 *   - /discover*            (Continue Watching rail uses cloud progress)
 *   - /watch/[type]/[id]    (cloud progress for resume position + history)
 *   - /account              (cloud state shown in the account header)
 *   - /movie/[id]           (DetailPage favorite toggle uses cloud)
 *   - /series/[id]          (DetailPage favorite toggle uses cloud)
 *   - /anime/[id]           (DetailPage favorite toggle uses cloud)
 *
 * Routes that DON'T need sync (skip the expensive sync call):
 *   - /auth/*               (auth flows — no library state shown)
 *   - /search               (search results have no library state)
 *   - /upcoming             (upcoming list — no library state shown)
 *   - /admin/*              (admin area — no user library)
 *   - /sitemap.xml          (static)
 *   - /                     (root — Discover handles its own sync via
 *                            the DiscoverPage component, not the layout)
 *
 * The classifier is intentionally pure (no imports beyond node built-ins)
 * so it is testable under tsx without a SvelteKit/Vite context.
 */

/** Path prefixes whose routes display library state. */
const LIBRARY_AWARE_PREFIXES: readonly string[] = [
  '/my-list',
  '/discover',
  '/watch/',
  '/account',
  '/movie/',
  '/series/',
  '/anime/',
];

/** Exact paths that are library-aware. */
const LIBRARY_AWARE_EXACT_PATHS: readonly string[] = [];

/**
 * True when the current pathname displays cloud library state
 * (progress / favorites / Continue Watching / My List) and therefore
 * benefits from running `syncAuthenticatedState()` on mount.
 *
 * The check is intentionally cheap (prefix matching) — it runs on every
 * navigation, not just on mount, so the online-retry handler can decide
 * whether to fire sync based on the CURRENT route.
 */
export function isLibraryAwareRoute(pathname: string): boolean {
  const path = pathname.toLowerCase();
  if (LIBRARY_AWARE_EXACT_PATHS.includes(path)) return true;
  return LIBRARY_AWARE_PREFIXES.some((prefix) => path.startsWith(prefix));
}
