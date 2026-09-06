import { error, redirect } from '@sveltejs/kit';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';

export async function requireAdmin(locals: App.Locals, options: { redirectTo?: string } = {}) {
  const { user } = await locals.safeGetSession();
  if (!user) throw redirect(303, `/auth/sign-in?next=${encodeURIComponent(options.redirectTo ?? '/admin')}`);

  const { data: profile, error: profileError } = await locals.supabase
    .from('profiles')
    .select('id,role')
    .eq('id', user.id)
    .limit(1)
    .maybeSingle();

  if (profileError) {
    console.error('[Admin] Profile role lookup failed', profileError);
    throw error(500, 'Admin authorization is temporarily unavailable.');
  }
  if (profile?.role !== 'admin') throw error(403, 'This area is reserved for MAVERO administrators.');

  return { user, profile };
}

export async function assertAdminClient(client: SupabaseClient<Database>, userId: string | null | undefined): Promise<void> {
  if (!userId) throw error(401, 'Authentication is required.');
  const { data, error: queryError } = await client
    .from('profiles')
    .select('id,role')
    .eq('id', userId)
    .limit(1)
    .maybeSingle();
  if (queryError) throw error(500, 'Admin authorization is temporarily unavailable.');
  if (data?.role !== 'admin') throw error(403, 'This action is reserved for MAVERO administrators.');
}
