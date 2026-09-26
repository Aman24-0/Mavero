import { error, redirect } from '@sveltejs/kit';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';

export async function requireAdmin(locals: App.Locals, options: { redirectTo?: string } = {}) {
  // Phase 2-A: use hook-resolved locals.user (no second auth roundtrip).
  const user = locals.user;
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

/**
 * Non-throwing, boolean admin-role check for capability projection.
 *
 * Used by the root layout to resolve the DevTools-protection exemption
 * (`devtoolExempt`) — the only consumer of this capability. It answers a
 * different question than requireAdmin()/assertAdminClient():
 *
 *   - requireAdmin()/assertAdminClient() are AUTHORIZATION gates: they
 *     redirect (303), 401 or 403, and remain the source of truth for
 *     every admin route and admin action.
 *   - isAdminUser() resolves a UI-deterrence capability: it only decides
 *     whether the CLIENT-side DevTools detector initializes in the
 *     current browser. It grants no privileges and gates nothing on the
 *     server — the detector is a deterrence layer, never a security
 *     boundary.
 *
 * Security contract:
 *   - Trusted inputs only: the hook-resolved authenticated `locals.user`
 *     id plus the profiles table (same query requireAdmin uses). Never
 *     localStorage, sessionStorage, URL/query parameters, client-set
 *     cookies, or any user-supplied request data.
 *   - Fail-closed: any lookup error resolves to false — the safest
 *     direction for a deterrence feature (protection stays ON; an admin
 *     who hits a transient error can simply reload the page).
 *   - Minimal disclosure: only the boolean capability reaches the
 *     client. No role string, no profile fields, no admin enumeration.
 */
export async function isAdminUser(client: SupabaseClient<Database>, userId: string): Promise<boolean> {
  try {
    const { data, error } = await client
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[Admin] Role capability lookup failed', { code: error.code, message: error.message });
      return false;
    }
    return data?.role === 'admin';
  } catch (err) {
    console.error('[Admin] Role capability lookup exception', { name: (err as Error)?.name ?? 'unknown' });
    return false;
  }
}
