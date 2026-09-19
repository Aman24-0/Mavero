import { createServerClient, type SetAllCookies } from '@supabase/ssr';
import { env as publicEnv } from '$env/dynamic/public';
import { error, type Handle } from '@sveltejs/kit';
import type { Database } from '$lib/server/supabase/database.types';
import { isEnvironmentFreePath } from '$lib/server/route-policy';
import { resolveRequestIdFromHeaders, PUBLIC_REQUEST_ID_HEADER } from '$lib/server/http/request-id';
import { captureException } from '$lib/server/observability/error-tracking';

// Server hook.
//
// Reliability contract:
//   - Supabase public configuration is read from dynamic public env.
//     If the env vars are missing (misconfigured deployment, cold
//     start race, Netlify function instance without env propagation),
//     we MUST NOT throw an unhandled exception — that would crash the
//     Netlify function and produce a 502 "function has crashed" page.
//     Instead we return a controlled 503 SvelteKit error for the
//     affected request, and log a safe diagnostic so the operator can
//     see the configuration gap. Subsequent requests may succeed once
//     the env is available.
//   - DEFAULT-DENY (Phase 1, audit BL-2): when the environment is
//     missing, the 503 applies to EVERY environment-dependent route.
//     The previous allowlist let unprotected paths (e.g. /watch,
//     /upcoming, /account, /admin) fall through to `resolve(event)`
//     with `locals.supabase` / `locals.safeGetSession` unassigned —
//     the root server layout then crashed on `locals.safeGetSession()`
//     with a raw TypeError → generic 500. Route classification lives
//     in the pure `route-policy.ts` (behaviorally tested): only paths
//     that genuinely function without the environment (static shell
//     assets, /sitemap.xml — static-data handler, no `locals` reads)
//     pass through. Protected routes remain protected (fail closed
//     with the same intentional 503), no fake Supabase clients are
//     created, and no configuration failure becomes a partially
//     functional security-sensitive environment.
//   - safeGetSession is wrapped in try/catch so a Supabase auth
//     initialization exception becomes a null session (guest) rather
//     than a function crash. A user with a broken session is treated
//     as a guest — they can still browse the catalog.
//   - Cookie lifecycle is unchanged: getAll/setAll use the standard
//     SvelteKit cookie helpers, and setAll writes with path: '/' so
//     Supabase can clear auth tokens on sign-out.
//   - We never log tokens, cookies, or credentials.

function isConfigured() {
  return Boolean(publicEnv.PUBLIC_SUPABASE_URL && publicEnv.PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}

export const handle: Handle = async ({ event, resolve }) => {
  const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const publishableKey = publicEnv.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  // Phase 3-A: resolve a request/correlation ID ONCE per request. The
  // ID is stored on locals.requestId (so server routes/loaders and the
  // structured logger can read it) AND returned in the X-Request-ID
  // response header (so the client can surface it in bug reports and
  // operators can grep Netlify logs by requestId). A trusted incoming
  // X-Request-ID is REUSED only if it matches the narrow accepted shape
  // (see request-id.ts) — otherwise a fresh cryptographically-strong ID
  // is generated. NEVER used as an auth boundary.
  event.locals.requestId = resolveRequestIdFromHeaders(event.request.headers);

  // Missing public Supabase configuration is a deployment/environment
  // problem, not a programmer error. Returning a controlled SvelteKit
  // error keeps the function alive and lets the user retry once the
  // operator fixes the env. We only log a safe, static message.
  if (!supabaseUrl || !publishableKey) {
    console.error('[Auth] Supabase public configuration is missing.', { requestId: event.locals.requestId });
    // DEFAULT-DENY: fail closed with the intentional 503 for every
    // environment-dependent route (pages resolve through the root server
    // layout; API endpoints read `locals`). Only paths that genuinely
    // function without the environment pass through — see route-policy.ts.
    if (!isEnvironmentFreePath(event.url.pathname)) {
      throw error(503, 'MAVERO is temporarily unavailable. Please try again in a moment.');
    }
    return resolve(event, {
      transformPageChunk: ({ html }) => appendRequestIdHeader(html, event.locals.requestId),
    });
  }

  event.locals.supabase = createServerClient<Database>(supabaseUrl, publishableKey, {
    cookies: {
      getAll: () => event.cookies.getAll(),
      setAll: (cookiesToSet: Parameters<SetAllCookies>[0]) => {
        cookiesToSet.forEach(({ name, value, options }) => {
          event.cookies.set(name, value, { ...options, path: '/' });
        });
      },
    },
    global: { fetch: event.fetch },
  });

  event.locals.safeGetSession = async () => {
    try {
      const { data: { session } } = await event.locals.supabase.auth.getSession();
      if (!session) return { session: null, user: null };
      const { data: { user }, error: userError } = await event.locals.supabase.auth.getUser();
      if (userError || !user) return { session: null, user: null };
      return { session, user };
    } catch (err) {
      // A Supabase auth initialization failure (network, cookie parse,
      // token refresh race) must not crash the request. Treat the user
      // as a guest and continue. Safe diagnostic only — no tokens.
      console.error('[Auth] safeGetSession exception', { name: (err as Error)?.name ?? 'unknown', requestId: event.locals.requestId });
      return { session: null, user: null };
    }
  };

  const auth = await event.locals.safeGetSession();
  event.locals.session = auth.session;
  event.locals.user = auth.user;

  // Phase 3-A: return the request ID in the response header so the
  // client and operator can correlate. SvelteKit's resolve() options
  // include `transformPageChunk` for HTML responses; for non-HTML
  // (API JSON) responses, SvelteKit's setHeaders (used by individual
  // +server.ts handlers) is the standard path. We use a lightweight
  // resolve option that adds the header to ALL responses — this is
  // the most robust approach and doesn't require every API handler to
  // remember to set it.
  try {
    const response = await resolve(event);
    response.headers.set(PUBLIC_REQUEST_ID_HEADER, event.locals.requestId);
    return response;
  } catch (err) {
    // Phase 6.3: capture unexpected server-side errors for production
    // error tracking. When MAVERO_SENTRY_DSN is set, the error is sent
    // to the Sentry-compatible endpoint with the request ID for
    // correlation. When disabled, this is a no-op — the error propagates
    // normally (SvelteKit's error handler takes over).
    captureException(err, {
      requestId: event.locals.requestId,
      route: event.url.pathname,
    });
    throw err;
  }
};

/**
 * Adds the request ID as an HTTP meta tag inside the HTML <head>.
 * This is the ONLY way to surface the request ID in a server-rendered
 * HTML response without a separate response-header read (the response
 * header is set on the Response object above; this is a complementary
 * surface for client-side code that reads from the DOM).
 *
 * For non-HTML responses the header on the Response object is the
 * canonical surface; this transform is a no-op.
 */
function appendRequestIdHeader(html: string, requestId: string): string {
  // Only inject into HTML responses (the transformPageChunk input is
  // the full HTML document for SSR routes). For non-HTML it's a no-op.
  if (!html || !html.includes('<head>')) return html;
  return html.replace('<head>', `<head><meta name="x-request-id" content="${requestId}">`);
}
