import { createServerClient } from '@supabase/ssr';
import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import type { RequestEvent } from '@sveltejs/kit';
import type { Database } from './database.types';

export { friendlyAuthMessage, safeRedirectPath } from '$lib/shared/auth';

export function createSupabaseServerClient(event: Pick<RequestEvent, 'cookies' | 'fetch' | 'request' | 'url'>) {
  return createServerClient<Database>(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return event.cookies.getAll();
      },
      setAll(cookiesToSet) {
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
