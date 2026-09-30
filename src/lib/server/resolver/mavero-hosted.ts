/**
 * Phase 7 — Mavero-hosted provider resolver adapter.
 *
 * This adapter integrates Vidara (Mavero 1) and Abyss (Mavero 2)
 * self-hosted media into the existing playback resolver. It is the
 * SINGLE integration point — by registering under the `'vidara'` and
 * `'abyss'` adapter_id keys in `createDefaultAdapterIds()`, the
 * existing resolver core automatically dispatches to this adapter when
 * a request targets a Mavero-hosted source.
 *
 * Contract (preserved from Phase 3/4/5/6):
 *
 *   * Vidara playback URL: `https://vidara.so/v/<filecode>`
 *   * Abyss playback URL: `https://player.abyssplayer.com/<slug>`
 *
 *   These are PROVIDER-HOSTED PLAYER / EMBED URLs — NOT raw direct
 *   media streams (HLS/MP4/DASH). The adapter returns
 *   `AdapterResult.type = 'embed'` so the player routes them through
 *   the existing iframe embed path (NEVER the native `<video>`
 *   direct-stream path). Phase 4 already classified these providers
 *   with `result_type='embed'` and `supports_direct=false` in the
 *   capabilities jsonb — this adapter respects that classification.
 *
 * Identity model (Phase 5 canonical_key):
 *
 *   movie:    `movie:tmdb:<tmdbId>`
 *   series:   `series:tmdb:<tmdbId>`
 *   episode:  `series:tmdb:<tmdbId>:s<season>:e<episode>`
 *
 *   The adapter consumes `identifiers.tmdbId` (extracted by
 *   `normalizeContentIdentifiers` from TMDB) + `request.season` +
 *   `request.episode`. Anime is NOT handled here — Phase 4 capability
 *   flags `anime:false` for both providers, so the resolver excludes
 *   them from the candidate list before this adapter is invoked.
 *
 * Availability rule (Phase 7 §5):
 *
 *   An asset is USABLE for playback ONLY when
 *   `media_assets.status = 'ready'`. All other lifecycle states
 *   (`queued`, `uploading`, `uploaded`, `processing`, `failed`,
 *   `deleted`) are filtered out — the adapter returns `null` (NOT an
 *   exception), so the resolver's existing fallback machinery
 *   transparently moves to the next candidate.
 *
 * DB query efficiency (Phase 7 §15):
 *
 *   Two-step lookup (avoids Supabase JS client join type complications):
 *     1. `media_items` by `canonical_key` (indexed).
 *     2. `media_assets` by `(provider_source_id, media_item_id)` +
 *        `status='ready'` filter (composite index + status index).
 *
 *   Total: 2 indexed lookups per resolution. No N+1.
 *
 * Security / boundary (Phase 7 §16/§17):
 *
 *   * The adapter queries DB using the service-role Supabase client
 *     (`PRIVATE_SUPABASE_SERVICE_ROLE_KEY` from `$env/dynamic/private`).
 *   * The browser receives ONLY the `playback_url` string + standard
 *     SourceResult metadata. No provider credentials, JWTs, API keys,
 *     provider_asset_id, provider_metadata, size_bytes, etc. leak.
 *   * The `validatePlaybackUrl` SSRF guard (in `safe-url.ts`) rejects
 *     non-HTTPS, private/loopback hosts, and disallowed embed origins.
 *     Phase 4 set `allowed_embed_origins=['https://vidara.so']` /
 *     `['https://player.abyssplayer.com']` — any URL outside these
 *     origins is rejected with `INVALID_SOURCE_URL`.
 *
 * Error isolation (Phase 7 §18):
 *
 *   * DB query failure → return `null` (resolver falls through to the
 *     next candidate). Vidara DB failure does NOT crash Abyss lookup.
 *   * Malformed row (invalid playback_url) → throw `INVALID_SOURCE_URL`
 *     — the resolver catches this via `asResolverError` and treats it
 *     as a candidate failure (continues fallback).
 *   * Malformed `tmdbId` / `season` / `episode` → return `null` (do
 *     NOT throw — the resolver's existing validation has already
 *     accepted the request; we just have no asset for it).
 *   * No credentials are logged.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { allowedEmbedOriginsFromCapabilities, allowDynamicEmbedOriginsFromCapabilities, validatePlaybackUrl } from './safe-url';
import { episodeCanonicalKey, movieCanonicalKey, seriesCanonicalKey } from '$lib/server/hosting/media/canonical-key';
import type { AdapterResult, ProviderAdapter, ResolverContext } from './types';
import type { Json } from '$lib/server/supabase/database.types';

// ---------------------------------------------------------------------------
// Adapter ID constants — match the `streaming_providers.adapter_id` values
// registered by Phase 4 migration 20260928213822.
// ---------------------------------------------------------------------------

export const MAVERO_HOSTED_ADAPTER_ID_VIDARA = 'vidara' as const;
export const MAVERO_HOSTED_ADAPTER_ID_ABYSS = 'abyss' as const;

// ---------------------------------------------------------------------------
// Service-role Supabase client (server-only).
// ---------------------------------------------------------------------------

let cachedClient: SupabaseClient<Database> | null = null;

/**
 * Lazy-loads the service-role Supabase client.
 *
 * The `$env/dynamic/private` SvelteKit virtual module is imported
 * DYNAMICALLY (not at module top-level) so that this module can be
 * safely imported by tsx-driven test scripts that exercise the
 * resolver's contract without invoking `resolve()`. The virtual
 * module is only resolved when `getServiceClient()` is actually
 * called — which only happens in production (SvelteKit runtime) or
 * in tests that explicitly inject a mock via
 * `__setMaveroHostedServiceClientForTests()` first.
 *
 * This mirrors the pattern used by `default-source.ts` (see its
 * module doc: "separated from `service.ts` so it can be imported by
 * Phase 2 contract tests without pulling in the `$env/dynamic/private`
 * SvelteKit virtual module which is not resolvable under tsx").
 */
async function getServiceClient(): Promise<SupabaseClient<Database> | null> {
  if (cachedClient) return cachedClient;
  // Lazy import — only resolved when actually called. Under tsx,
  // tests use the test injection point (`__setMaveroHostedServiceClientForTests`)
  // and never reach this code path.
  const { env } = await import('$env/dynamic/private');
  const { env: publicEnv } = await import('$env/dynamic/public');
  const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  cachedClient = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  });
  return cachedClient;
}

/**
 * Test-only injection point. Allows tests to pass a mock Supabase client
 * (e.g. an in-memory pglite instance or a stub) so the adapter can be
 * exercised without touching the real production DB or the
 * `$env/dynamic/private` virtual module.
 *
 * Production code MUST NOT call this — the adapter reads credentials
 * from `$env/dynamic/private` via `getServiceClient()` at runtime.
 */
export function __setMaveroHostedServiceClientForTests(client: SupabaseClient<Database> | null): void {
  cachedClient = client;
}

// ---------------------------------------------------------------------------
// Canonical key derivation — Phase 5 helpers, parameterized by request.
// ---------------------------------------------------------------------------

/**
 * Computes the Phase 5 canonical_key for the resolver context.
 *
 * Returns `null` when:
 *   - `identifiers.tmdbId` is absent (TMDB ID could not be extracted
 *     from the content item).
 *   - `request.mediaType === 'anime'` (Phase 4 capability flags
 *     `anime:false` — the resolver should have excluded the source
 *     already, but we fail safe here).
 *   - `request.mediaType === 'series'` but only one of season/episode
 *     is present (malformed request — fail safe).
 *
 * For `series` without season+episode (e.g. a series-level lookup,
 * rarely used in practice but supported by the contract), the SERIES
 * canonical_key is returned. This matches a `media_items` row of
 * `content_type='series'` with NULL season+episode — i.e. the show
 * itself, not any specific episode. Phase 5 `ensureSeries()` creates
 * exactly this row.
 */
function computeCanonicalKey(context: ResolverContext): string | null {
  const { request, identifiers } = context;
  if (!identifiers.tmdbId) return null;
  if (request.mediaType === 'movie') return movieCanonicalKey(identifiers.tmdbId);
  if (request.mediaType === 'series') {
    if (request.season != null && request.episode != null) {
      return episodeCanonicalKey(identifiers.tmdbId, request.season, request.episode);
    }
    if (request.season == null && request.episode == null) {
      return seriesCanonicalKey(identifiers.tmdbId);
    }
    // Malformed: only one of season/episode present. Fail safe.
    return null;
  }
  // anime or unknown — fail safe (Phase 4 caps block this branch).
  return null;
}

// ---------------------------------------------------------------------------
// Effective embed origins — union of provider + source capabilities.
// Mirrors the logic in core.ts `resultFromAdapter` so the adapter and
// the post-processing stage agree on what's allowed.
// ---------------------------------------------------------------------------

function effectiveEmbedOrigins(context: ResolverContext): string[] {
  const providerCaps = context.config.provider.capabilities as Json;
  const sourceCaps = context.config.source.capabilities as Json;
  return [...new Set([
    ...allowedEmbedOriginsFromCapabilities(providerCaps),
    ...allowedEmbedOriginsFromCapabilities(sourceCaps),
  ])];
}

function effectiveAllowDynamic(context: ResolverContext): boolean {
  const providerCaps = context.config.provider.capabilities as Json;
  const sourceCaps = context.config.source.capabilities as Json;
  return allowDynamicEmbedOriginsFromCapabilities(providerCaps)
    || allowDynamicEmbedOriginsFromCapabilities(sourceCaps);
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Creates a Mavero-hosted resolver adapter for the given adapter_id.
 *
 * The adapter_id MUST match the `streaming_providers.adapter_id` value
 * registered by Phase 4 (currently `'vidara'` and `'abyss'`). The
 * adapter_id is exposed as `ProviderAdapter.adapterId` so the resolver
 * registry can dispatch correctly.
 *
 * The same implementation handles both providers — the provider
 * identity is read from `context.config.provider` at runtime, and the
 * asset lookup is scoped by `context.config.source.id`
 * (streaming_sources.id) which is unique per (provider, source) pair.
 */
export function createMaveroHostedAdapter(adapterId: 'vidara' | 'abyss'): ProviderAdapter {
  return {
    integrationType: 'custom',
    adapterId,
    async resolve(context: ResolverContext): Promise<AdapterResult | null> {
      // 1. Compute the canonical key for this request.
      const canonicalKey = computeCanonicalKey(context);
      if (!canonicalKey) return null;

      // 2. Obtain the service-role Supabase client. If env vars are
      //    missing, fail safe — return null so the resolver falls
      //    through to the next candidate. (This branch is reached
      //    only in misconfigured deployments; the resolver endpoint
      //    itself already validates env vars at startup.)
      const client = await getServiceClient();
      if (!client) return null;

      // 3. Two-step DB lookup. Wrap in try/catch — any DB error
      //    (network, RLS denial, malformed row) returns null so the
      //    resolver's fallback machinery continues with the next
      //    candidate. This is the Phase 7 §18 error-isolation contract.
      try {
        // 3a. Lookup the media_items row by canonical_key.
        const itemResult = await client
          .from('media_items')
          .select('id')
          .eq('canonical_key', canonicalKey)
          .limit(1)
          .maybeSingle();
        if (itemResult.error || !itemResult.data) return null;
        const mediaItemId: string = itemResult.data.id;

        // 3b. Lookup the latest ready asset for this (media_item, source).
        //     Phase C §Hosting/Media Issue Audit: gate on BOTH
        //       `status='ready'`  (provider lifecycle complete)
        //     AND
        //       `mavero_status='available'`  (admin has not detached /
        //       disabled / soft-deleted the asset)
        //     Without the mavero_status gate, ManagementService.detachAsset
        //     (which sets mavero_status='missing' but leaves status='ready')
        //     would NOT actually detach the asset from playback — the
        //     resolver would keep serving it. That was a real bug fixed
        //     in Phase C. mavero_status is the admin's lever; status is
        //     the provider's lever. Both must be green.
        const assetResult = await client
          .from('media_assets')
          .select('playback_url')
          .eq('media_item_id', mediaItemId)
          .eq('provider_source_id', context.config.source.id)
          .eq('status', 'ready')
          .eq('mavero_status', 'available')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (assetResult.error || !assetResult.data) return null;
        const playbackUrl = assetResult.data.playback_url;
        if (!playbackUrl || typeof playbackUrl !== 'string') return null;

        // 4. Validate the URL against the provider's allowed embed
        //    origins + the SSRF guard. A malformed URL throws
        //    INVALID_SOURCE_URL — the resolver catches this via
        //    `asResolverError` and treats it as a candidate failure
        //    (continues fallback). This is the Phase 7 §16 boundary.
        const safeUrl = validatePlaybackUrl(
          playbackUrl,
          'embed',
          effectiveEmbedOrigins(context),
          effectiveAllowDynamic(context),
        );

        // 5. Return the embed source. The metadata is presentation-
        //    only — sourceName and providerName come from the
        //    streaming_sources/streaming_providers rows (already
        //    public in the registry, never secrets).
        return {
          type: 'embed',
          url: safeUrl,
          metadata: {
            sourceName: context.config.source.name,
            providerName: context.config.provider.name,
          },
        };
      } catch {
        // Swallow the exception — Phase 7 §18 contract. Never log
        // credentials (none are present in this code path; the catch
        // is purely defensive). The resolver's existing
        // `console.error('[Resolver] adapter failure', ...)` log path
        // in core.ts will surface INTERNAL_RESOLUTION_ERROR if the
        // error propagates from `resultFromAdapter` — but this catch
        // prevents propagation for adapter-internal failures, so the
        // next candidate is attempted instead.
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Sentinel export — re-exported for tests that want to introspect the
// adapter without constructing it. Not used by the resolver core.
// ---------------------------------------------------------------------------

export const MAVERO_HOSTED_ADAPTER_SENTINEL = Symbol('mavero-hosted-adapter');
