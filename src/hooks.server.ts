import { createServerClient, type SetAllCookies } from '@supabase/ssr';
import { env as publicEnv } from '$env/dynamic/public';
import type { Handle } from '@sveltejs/kit';
import type { Database } from '$lib/server/supabase/database.types';

export const handle: Handle = async ({ event, resolve }) => {
  const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const publishableKey = publicEnv.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) throw new Error('MAVERO Supabase public configuration is missing.');
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
      const { data: { user }, error } = await event.locals.supabase.auth.getUser();
      if (error || !user) return { session: null, user: null };
      return { session, user };
    } catch {
      return { session: null, user: null };
    }
  };

  const auth = await event.locals.safeGetSession();
  event.locals.session = auth.session;
  event.locals.user = auth.user;

  return resolve(event);
};
