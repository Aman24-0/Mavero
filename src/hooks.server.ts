import { createServerClient, type SetAllCookies } from '@supabase/ssr';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { error, type Handle } from '@sveltejs/kit';
import type { Database } from '$lib/server/supabase/database.types';
import { isEnvironmentFreePath } from '$lib/server/route-policy';
import { resolveRequestIdFromHeaders, PUBLIC_REQUEST_ID_HEADER } from '$lib/server/http/request-id';
import { captureException } from '$lib/server/observability/error-tracking';
import type { SupabaseAdminClient } from '$lib/server/supabase/admin';
import { extractSessionId } from '$lib/server/auth/jwt-session-id';
import { parseDeviceMetadata, ensureDeviceIdCookie, readDeviceHintCookie, DEVICE_ID_COOKIE, DEVICE_HINT_COOKIE } from '$lib/server/auth/device-metadata';
import { registerCurrentSession, lookupSessionRevocationState } from '$lib/server/auth/device-sessions';
import { isSessionRevoked } from '$lib/server/auth/session-revocation-cache';

// Session-registration timeout (Newtask §3 + §22).
//
// Registration is AWAITED with this bounded timeout so a successful
// registry write actually completes before the request lifecycle ends
// (fire-and-forget promises may never finish on Netlify serverless —
// the function can freeze/reuse right after the response is returned,
// which is exactly why the registry behaved like a one-time device
// injection). The timeout bounds the added latency: worst case we add
// REGISTRATION_TIMEOUT_MS to ONE request per session per heartbeat
// interval; the common path (fresh heartbeat, < 5 min old) is a single
// fast RPC that does no DB write.
//
// Failure model (unchanged, task §22): if the registry write times out
// or fails, authentication CONTINUES — the registry is supporting
// infrastructure, not a security gate. The error is logged safely
// (requestId + error class only; never tokens or session IDs).
const REGISTRATION_TIMEOUT_MS = 1500;

/**
 * Awaits a promise with a bounded timeout. Never rejects — resolves
 * `{ timedOut: true, value: null }` when the deadline passes first.
 * Used for session registration so a hanging Supabase RPC cannot
 * stall the request indefinitely.
 */
async function awaitWithTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<{ timedOut: boolean; value: T | null }> {
  let timedOut = false;
  const bounded = new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
  const value = await bounded;
  return { timedOut, value };
}

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

  // Phase 3 — application-level session revocation enforcement.
  //
  // The Supabase JWT remains valid until its own expiry (default 1 hour).
  // Without this check, a session that was revoked via the Account UI
  // (or via Sign out All) could continue to authenticate Mavero requests
  // for up to 1 hour after revocation.
  //
  // We consult a short-TTL in-memory cache (keyed by supabase_session_id)
  // so the common case does not hit the DB. On cache miss we query
  // device_sessions.revoked_at. The cache is bounded and per-instance
  // (see session-revocation-cache.ts for the full serverless honesty
  // disclosure — staleness is bounded to 30 seconds).
  //
  // If the session is revoked:
  //   - Clear locals.session and locals.user to null — the request is
  //     treated as a guest. Page requests render the guest layout; API
  //     requests hit the existing `if (!locals.user)` 401 path.
  //   - Do NOT register the session — a revoked session must not be
  //     resurrected in the registry.
  //
  // SECURITY:
  //   - userId and supabaseSessionId are server-derived (from locals.user
  //     and the JWT session_id claim). NEVER client-supplied.
  //   - The check fails-open on DB errors (the Supabase JWT remains the
  //     authoritative auth boundary; the registry is a supplementary
  //     revocation layer).
  //
  // Newtask §38/RC-11: the service-role admin client is created ONCE per
  // request (previously the revocation check and the registration block
  // each created their own client — two client instances per request).
  let sessionRevoked = false;
  let supabaseSessionId: string | null = null;
  let admin: SupabaseAdminClient | null = null;
  if (auth.session?.access_token && auth.user) {
    const adminUrl = publicEnv.PUBLIC_SUPABASE_URL;
    const adminKey = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
    if (adminUrl && adminKey) {
      supabaseSessionId = extractSessionId(auth.session.access_token);
      if (supabaseSessionId) {
        const { createClient } = await import('@supabase/supabase-js');
        // Newtask §38/RC-11: ONE admin client per request, shared by
        // the revocation check and the registration block below.
        admin = createClient<Database>(adminUrl, adminKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { fetch: event.fetch },
        });
        const { revoked } = await isSessionRevoked(
          auth.user.id,
          supabaseSessionId,
          (uid, sid) => lookupSessionRevocationState(admin!, uid, sid)
        );
        if (revoked) {
          // Treat as guest: clear the auth context so the rest of the
          // request — page layout, API routes — sees an unauthenticated
          // request. Supabase's own session cookies remain (we do NOT
          // call signOut here — that's a separate user-initiated flow;
          // this is just an enforcement gate).
          event.locals.session = null;
          event.locals.user = null;
          sessionRevoked = true;
          // Safe observability (Newtask §40) — no tokens, no session IDs.
          console.warn('[DeviceSessions] revoked session rejected', {
            requestId: event.locals.requestId,
            deviceType: parseDeviceMetadata(event.request.headers.get('user-agent')).deviceType,
          });
          // Do NOT fall through to registration. A revoked session must
          // not be re-registered (that would resurrect it in the list).
        }
      }
    }
  }

  // Phase 1 Device Auth (Newtask §3 rebuild): register the current
  // device session in the registry.
  //
  // REGISTRATION CONTRACT (fixes the one-time-injection bug):
  //   - The registration RPC is AWAITED with a bounded timeout
  //     (REGISTRATION_TIMEOUT_MS) — a successful registry write must
  //     actually complete before the request finishes. Under Netlify
  //     serverless, a fire-and-forget promise may never run to
  //     completion once the response is returned; that is why new
  //     logins never appeared and last_seen_at never heartbeated.
  //   - Failure-safe: on timeout or RPC error, authentication
  //     continues normally (the registry is supporting infrastructure,
  //     not a security gate). The failure is logged safely.
  //   - No unnecessary DB writes: the RPC heartbeats at most once per
  //     HEARTBEAT_INTERVAL_MS (5 min) per session; fresh sessions are
  //     a single no-write RPC roundtrip.
  //   - DO NOT resurrect revoked sessions: the RPC returns an empty
  //     result for a revoked session and we simply do not register.
  //
  // Skipped entirely when the session was just revoked above.
  if (!sessionRevoked && auth.session && auth.user && admin && supabaseSessionId) {
    // Device ID: centralized cookie handling (Newtask §5/§38) —
    // created only when absent/invalid; httpOnly, lax, path '/',
    // 1 year, secure on HTTPS. Never holds a session token.
    const deviceId = ensureDeviceIdCookie(
      event.cookies.get(DEVICE_ID_COOKIE),
      (value, options) => event.cookies.set(DEVICE_ID_COOKIE, value, options),
      event.url.protocol === 'https:'
    );

    // Device metadata: real User-Agent parsing + client hints
    // (sec-ch-ua brands for Brave, touch-hint cookie for iPad-as-Mac).
    // Never hardcoded — see device-metadata.ts.
    const metadata = parseDeviceMetadata(event.request.headers.get('user-agent'), {
      clientHintsBrands: event.request.headers.get('sec-ch-ua'),
      touchCapable: readDeviceHintCookie(event.cookies.get(DEVICE_HINT_COOKIE)),
    });

    const registration = await awaitWithTimeout(
      registerCurrentSession(admin, {
        userId: auth.user.id,
        supabaseSessionId,
        deviceId,
        metadata,
      }),
      REGISTRATION_TIMEOUT_MS
    );

    if (registration.timedOut) {
      // Bounded-timeout miss: auth continues, registry may be stale
      // for this session until the next request heartbeats it.
      console.error('[DeviceSessions] Registration timed out (non-blocking)', {
        requestId: event.locals.requestId,
      });
    } else if (registration.value) {
      // Safe observability (Newtask §40): distinguish a fresh
      // registration from a heartbeat touch via the RPC's
      // `registered` flag. Never log tokens or session IDs.
      if (registration.value.registered === true) {
        console.log('[DeviceSessions] register success', {
          requestId: event.locals.requestId,
          deviceType: metadata.deviceType,
        });
      } else {
        console.log('[DeviceSessions] heartbeat ok', {
          requestId: event.locals.requestId,
          deviceType: metadata.deviceType,
        });
      }
    }
    // registration.value === null (and not timed out) ⇒ the RPC
    // failed or the session was revoked in the race window.
    // registerCurrentSession already logged the safe diagnostic;
    // authentication continues (failure-safe contract).
  }

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
