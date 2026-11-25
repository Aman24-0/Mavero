import { loadDiscoverData } from '$lib/server/content/discover-load';
import { PUBLIC_CATALOG_CACHE } from '$lib/server/http/cache-headers';
import { redirect } from '@sveltejs/kit';
import { safeRedirectPath } from '$lib/server/supabase/server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals, setHeaders }) => {
  const code = url.searchParams.get('code');
  if (code) {
    const { error } = await locals.supabase.auth.exchangeCodeForSession(code);
    throw redirect(303, error ? `/auth/sign-in?error=confirmation` : safeRedirectPath(url.searchParams.get('next'), '/settings'));
  }
  // The home page payload is the same for everyone (no per-user data in the
  // discover payload — the catalog filter is enforced at the adapter layer).
  // Set the same CDN cache header as /discover, /movies, /tv-shows, /anime,
  // /upcoming so the Netlify edge CDN serves the cached SSR HTML directly,
  // bypassing the function invocation entirely on repeated navigations.
  // This drops TTFB from ~1.5 s (SSR function call) to ~100 ms (edge cache).
  // Authenticated surfaces (/account, /admin, /my-list) are separate routes
  // and are NOT affected by this rule.
  setHeaders({ 'cache-control': PUBLIC_CATALOG_CACHE });
  return loadDiscoverData();
};
