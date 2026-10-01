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
import { resolveHostingSources } from '$lib/server/hosting/provider-resolver';
import type { ProviderCapabilities } from '$lib/server/hosting/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });

  // Phase 6 + Phase C audit fix: use the CANONICAL provider resolver.
  // This replaces the inline two-query pattern that had drifted to
  // include `.eq('enabled', true)` filters on BOTH providers and
  // sources (FINDING-004). Disabled providers/sources may have linked
  // assets and MUST be visible in the upload provider selector.
  //
  // The resolver also surfaces query failures as `hostingSourcesError`
  // instead of silently returning an empty list (which previously made
  // "DB error" indistinguishable from "no providers configured").
  let hostingSources: any[] = [];
  let hostingSourcesError: string | null = null;
  try {
    const adminClient = createSupabaseAdminClient();
    const result = await resolveHostingSources(adminClient);
    hostingSourcesError = result.error?.message ?? null;

    // Enrich each resolved source with adapter capabilities (for the
    // upload UI's capability-driven rendering). The capabilities come
    // from the adapter registry — no DB query, no network call.
    hostingSources = result.list.map((s) => {
      const adapter = s.adapterId ? getHostingAdapter(s.adapterId) : null;
      const capabilities: ProviderCapabilities | null = adapter
        ? adapter.getCapabilities()
        : null;
      return {
        id: s.id,
        name: s.name,
        providerId: s.providerId,
        providerName: s.providerName,
        adapterId: s.adapterId,
        capabilities,
      };
    });
  } catch (err) {
    // Graceful fallback — empty hosting sources if admin client fails.
    // The upload page's "no providers" empty state will guide the admin.
    hostingSourcesError = err instanceof Error ? err.message : String(err);
  }

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
