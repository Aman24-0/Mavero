/**
 * Phase 1 production hardening (audit BL-2) — environment-free route policy.
 *
 * Pure, dependency-free classification of request paths that can safely be
 * served when the Supabase public environment is missing (misconfigured
 * deployment, cold-start race, Netlify function instance without env
 * propagation). `hooks.server.ts` consumes this policy to implement the
 * DEFAULT-DENY fail-closed contract:
 *
 *   - Every route that depends on the Supabase environment (all pages via
 *     the root server layout, every API endpoint that reads `locals`) MUST
 *     receive the intentional controlled 503 — never a fall-through into
 *     unassigned locals (which used to crash `+layout.server.ts` with a raw
 *     TypeError → generic 500 on /watch, /upcoming, /account, /admin, …).
 *   - Only paths that GENUINELY function without the environment are
 *     allowed to pass through. This is a deliberately small, explicit
 *     allowlist: static build assets (defensive — on Netlify they are
 *     normally served by the CDN before the function is reached), the
 *     service-worker shell files, and the /sitemap.xml endpoint whose
 *     handler is built entirely from static data and never touches
 *     `locals`.
 *
 * Protected routes can NEVER become public through this policy: they fail
 * closed with the same intentional 503 the rest of the app already used.
 * The policy is pure so the fail-closed contract is behaviorally testable
 * under tsx (hooks.server.ts itself imports `$env/dynamic/public`, which
 * cannot be imported outside Vite).
 */

/** Path prefixes that are served as static assets without any environment. */
const ENV_FREE_PREFIXES: readonly string[] = [
  // Built immutable client assets (defensive: normally CDN-served).
  '/_app/',
  // Static-directory assets (defensive: normally CDN-served).
  '/icons/',
  '/images/',
];

/** Exact paths that function completely without the Supabase environment. */
const ENV_FREE_EXACT_PATHS: readonly string[] = [
  // Static shell files.
  '/robots.txt',
  '/sw.js',
  '/manifest.webmanifest',
  '/offline.html',
  '/favicon.ico',
  // The sitemap endpoint renders from static catalog data only — its
  // handler never reads `locals` (verified: src/routes/sitemap.xml/+server.ts).
  '/sitemap.xml',
];

/**
 * True when the request path can be served WITHOUT the Supabase public
 * environment. Everything else must fail closed with the intentional 503.
 */
export function isEnvironmentFreePath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  if (ENV_FREE_EXACT_PATHS.includes(path)) return true;
  return ENV_FREE_PREFIXES.some((prefix) => path.startsWith(prefix));
}
