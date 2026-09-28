/**
 * Phase 6 — Admin upload page server load.
 * Admin-only. Loads the streaming config for provider selection.
 */

import { requireAdmin } from '$lib/server/streaming/admin-auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });
  // Use the admin client to query streaming_providers (adapter_id is admin-only).
  const { createSupabaseAdminClient } = await import('$lib/server/supabase/admin');
  const adminClient = createSupabaseAdminClient();

  // Get hosting providers (Vidara + Abyss).
  const { data: providers } = await adminClient
    .from('streaming_providers')
    .select('id, name, slug, adapter_id, enabled, status')
    .in('adapter_id', ['vidara', 'abyss'])
    .eq('enabled', true);

  // Get the corresponding sources.
  const providerIds = (providers ?? []).map((p) => p.id);
  const { data: sources } = await adminClient
    .from('streaming_sources')
    .select('id, name, slug, provider_id, status, enabled')
    .in('provider_id', providerIds)
    .eq('enabled', true);

  const hostingSources = (sources ?? []).map((s) => {
    const provider = (providers ?? []).find((p) => p.id === s.provider_id);
    return {
      id: s.id,
      name: s.name,
      providerId: s.provider_id,
      adapterId: provider?.adapter_id ?? null,
    };
  });

  return { hostingSources };
};
