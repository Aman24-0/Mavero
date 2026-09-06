import { createServerClient, type SetAllCookies } from '@supabase/ssr';
import { env as publicEnv } from '$env/dynamic/public';
import type { RequestEvent } from '@sveltejs/kit';
import type { Database } from './database.types';

export { friendlyAuthMessage, safeRedirectPath } from '$lib/shared/auth';

export function createSupabaseServerClient(event: Pick<RequestEvent, 'cookies' | 'fetch' | 'request' | 'url'>) {
  const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const publishableKey = publicEnv.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) throw new Error('MAVERO Supabase public configuration is missing.');
  return createServerClient<Database>(supabaseUrl, publishableKey, {
    cookies: {
      getAll() {
        return event.cookies.getAll();
      },
      setAll(cookiesToSet: Parameters<SetAllCookies>[0]) {
        cookiesToSet.forEach(({ name, value, options }) => {
          event.cookies.set(name, value, { ...options, path: '/' });
        });
      },
    },
    global: {
      fetch: event.fetch,
    },
  });
}
