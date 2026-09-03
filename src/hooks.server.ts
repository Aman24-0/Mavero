import { createServerClient, type SetAllCookies } from '@supabase/ssr';
import { env as publicEnv } from '$env/dynamic/public';
import { error, type Handle } from '@sveltejs/kit';
import type { Database } from '$lib/server/supabase/database.types';

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

  // Missing public Supabase configuration is a deployment/environment
  // problem, not a programmer error. Returning a controlled SvelteKit
  // error keeps the function alive and lets the user retry once the
  // operator fixes the env. We only log a safe, static message.
  if (!supabaseUrl || !publishableKey) {
    console.error('[Auth] Supabase public configuration is missing.');
    // Allow static asset / prerendered requests to pass through so the
    // app shell + CSS still load; only fail data-bearing routes.
    const path = event.url.pathname;
    if (path.startsWith('/auth/') || path === '/' || path.startsWith('/discover') || path.startsWith('/search') || path.startsWith('/my-list') || path.startsWith('/profile') || path.startsWith('/settings') || path.startsWith('/movie/') || path.startsWith('/series/') || path.startsWith('/anime/') || path.startsWith('/api/')) {
      throw error(503, 'MAVERO is temporarily unavailable. Please try again in a moment.');
    }
    return resolve(event);
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
      console.error('[Auth] safeGetSession exception', { name: (err as Error)?.name ?? 'unknown' });
      return { session: null, user: null };
    }
  };

  const auth = await event.locals.safeGetSession();
  event.locals.session = auth.session;
  event.locals.user = auth.user;

  return resolve(event);
};
