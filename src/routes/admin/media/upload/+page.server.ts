/**
 * Admin 2.0 — Phase D — Upload / Import page server load.
 *
 * Loads the streaming config for provider selection AND reads URL
 * params for contextual entry points:
 *
 *   ?tmdbId=<id>          — prefill TMDB identity (skips search step)
 *   ?contentType=<type>   — prefill content type (movie/series/anime)
 *   ?season=<n>           — prefill season (for series/anime episodes)
 *   ?episode=<n>          — prefill episode (for series/anime episodes)
 *
 * Sources of these params:
 *   - Media Library detail drawer "Upload to this media" action
 *   - Missing Media "Upload" action on a demand row
 *   - Direct deep-link from external sources
 *
 * The server also returns provider capabilities (multi-audio, subtitles,
 * transcoding, etc.) so the client can render capability-driven UI
 * without calling getCapabilities() per provider (avoids N+1).
 */

import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { getHostingAdapter } from '$lib/server/hosting/registry';
import type { ProviderCapabilities } from '$lib/server/hosting/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });

  // Phase 6: createSupabaseAdminClient() inside try/catch — prevents
  // uncaught 500 if PRIVATE_SUPABASE_SERVICE_ROLE_KEY is missing.
  let providers: any[] = [];
  let sources: any[] = [];
  let hostingSourcesError: string | null = null;
  try {
    const adminClient = createSupabaseAdminClient();

  // Hosting providers AND their sources, fetched with two explicit
  // queries joined in application code (the same reliable pattern used
  // by /admin/media/library/+page.server.ts).
  //
  // The previous implementation used a nested PostgREST join
  // (`streaming_providers!inner(adapter_id)` with an `.in('streaming_providers.adapter_id', ...)`
  // filter). That syntax is fragile: depending on the relation
  // cardinality and PostgREST version, `s.streaming_providers` comes
  // back as either an object or an array, and any failure of the nested
  // relation resolves to an empty source list — silently making the
  // upload page say "No providers configured" even when providers ARE
  // configured. The `catch` block at the bottom also swallowed ALL
  // errors (including genuine DB errors) into the same empty state,
  // making "DB error" indistinguishable from "no providers configured".
  //
  // The explicit two-query pattern avoids the nested-relation fragility
  // entirely: providers are fetched first, then sources are filtered by
  // the resolved provider IDs with a simple `.in('provider_id', …)`.
  // Both queries run in parallel; errors are surfaced via
  // `hostingSourcesError` so the client can distinguish the two cases.
  const providersRes = await adminClient
    .from('streaming_providers')
    .select('id, name, slug, adapter_id, enabled, status')
    .in('adapter_id', ['vidara', 'abyss'])
    .eq('enabled', true);

  if (providersRes.error) {
    hostingSourcesError = `providers: ${providersRes.error.message}`;
  } else {
    providers = providersRes.data ?? [];
    const providerIds = providers.map((p) => p.id);
    if (providerIds.length > 0) {
      const sourcesRes = await adminClient
        .from('streaming_sources')
        .select('id, name, slug, provider_id, status, enabled')
        .in('provider_id', providerIds)
        .eq('enabled', true);
      if (sourcesRes.error) {
        hostingSourcesError = `sources: ${sourcesRes.error.message}`;
      } else {
        sources = sourcesRes.data ?? [];
      }
    }
  }
  } catch (err) {
    // Phase 6: graceful fallback — empty hosting sources if admin client fails.
    // The upload page's "no providers" empty state will guide the admin.
    hostingSourcesError = err instanceof Error ? err.message : String(err);
  }

  // Build hostingSources with adapterId for each source.
  const hostingSources = sources.map((s: any) => {
    const provider = providers.find((p) => p.id === s.provider_id);
    const adapterId = provider?.adapter_id ?? null;
    // Look up capabilities from the adapter registry. This is a
    // module-level singleton — no DB query, no network call. The
    // capabilities object is the same one used by the adapter itself.
    const adapter = adapterId ? getHostingAdapter(adapterId) : null;
    const capabilities: ProviderCapabilities | null = adapter
      ? adapter.getCapabilities()
      : null;
    return {
      id: s.id,
      name: s.name,
      providerId: s.provider_id,
      providerName: provider?.name ?? null,
      adapterId,
      capabilities,
    };
  });

  // Read URL params for contextual entry.
  const sp = url.searchParams;
  const tmdbId = sp.get('tmdbId') ?? null;
  const contentType = sp.get('contentType') as 'movie' | 'series' | 'anime' | null;
  const seasonStr = sp.get('season');
  const episodeStr = sp.get('episode');
  const season = seasonStr && /^\d+$/.test(seasonStr) ? parseInt(seasonStr, 10) : null;
  const episode = episodeStr && /^\d+$/.test(episodeStr) ? parseInt(episodeStr, 10) : null;

  // Validate contentType if provided.
  const validContentType =
    contentType === 'movie' || contentType === 'series' || contentType === 'anime'
      ? contentType
      : null;

  // If tmdbId is provided, the wizard will skip the search step and start
  // at the metadata-confirmation step. The client will fetch the full
  // TMDB detail (title, year, poster, IMDb ID) using the existing
  // /api/admin/media/search endpoint or a TMDB detail endpoint.
  const initialContext = tmdbId
    ? {
        tmdbId,
        contentType: validContentType,
        season,
        episode,
        // title, year, poster, imdbId are fetched client-side from TMDB
        // (the server doesn't have a "get TMDB detail" admin endpoint;
        // the client uses /api/admin/media/search with the TMDB ID as
        // the query, or /api/content/[type]/[id] which already exists).
      }
    : null;

  return {
    hostingSources,
    hostingSourcesError,
    initialContext,
    adminUserId: user.id,
  };
};
