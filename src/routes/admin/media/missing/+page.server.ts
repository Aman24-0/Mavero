/**
 * Phase 9 — Missing Media admin page server.
 */

import { error } from '@sveltejs/kit';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();

  const status = url.searchParams.get('status') ?? 'open';
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);

  const { data: requests, error: err } = await adminClient
    .from('media_availability_requests')
    .select('*')
    .eq('status', status)
    .order('last_requested_at', { ascending: false })
    .limit(limit);

  if (err) throw error(500, 'Failed to load missing media requests.');

  return { requests: requests ?? [], statusFilter: status };
};
