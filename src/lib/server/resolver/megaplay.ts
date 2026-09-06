import { ResolverError } from './errors';
import { validatePlaybackUrl } from './safe-url';
import type { AdapterResult, ProviderAdapter, ResolverContext } from './types';

/**
 * MegaPlay / Anikoto resolver adapter — Phase 7F.
 *
 * MegaPlay (https://megaplay.buzz/api) is an anime-only embed provider
 * that exposes two playback variants per episode: SUB and DUB.
 *
 * API contract (verified from the official MegaPlay API docs page at
 * https://megaplay.buzz/api and the live Anikoto API at
 * https://anikotoapi.site):
 *
 *   1. Embed endpoints (the ONLY URLs Mavero uses — no server-side API
 *      calls, no Anikoto catalog lookups):
 *
 *      https://megaplay.buzz/stream/ani/{anilist_id}/{episode}/{language}
 *      https://megaplay.buzz/stream/mal/{mal_id}/{episode}/{language}
 *
 *      `{language}` is the variant: 'sub' or 'dub'. Both variants are
 *      generated from ONE source row (audio_languages: ['sub','dub']).
 *      Mavero does NOT create separate SUB/DUB provider/source rows.
 *
 *   2. Identifier mode:
 *
 *      - 'anilist_id' — uses the AniList ID (Mavero's primary anime
 *        identifier, sourced from the AniList adapter).
 *      - 'mal_id' — uses the MyAnimeList ID (fallback when AniList ID
 *        is missing but MAL ID is present in content.externalIds).
 *
 *   3. Variant selection:
 *
 *      - The user-selected variant arrives as `context.request.variant`
 *        ('sub' or 'dub', lowercased). Defaults to 'sub' when absent.
 *      - The adapter returns `metadata.variants = ['sub','dub']` and
 *        `metadata.selectedVariant = <the chosen variant>` so the
 *        player UI can render inline SUB/DUB toggles inside the
 *        MegaPlay source option.
 *
 *   4. Availability:
 *
 *      MegaPlay returns HTTP 200 even for missing episodes (it serves
 *      a friendly "We're Sorry" 410 error page inside the iframe), so
 *      Mavero cannot preflight availability via HTTP status. The
 *      player adapter listens for the documented `error` postMessage
 *      event from the MegaPlay iframe to detect missing episodes at
 *      runtime and trigger fallback.
 *
 *   5. startAt / resume:
 *
 *      MegaPlay does NOT document a startAt URL parameter. Mavero
 *      does NOT append one — playback starts at 0. Progress is still
 *      tracked locally via the player's postMessage `time` events.
 *
 *   6. Anime-only:
 *
 *      This adapter throws `UNSUPPORTED_MEDIA_TYPE` for non-anime
 *      content. The provider/source DB row also has `movie: false`
 *      and `series: false` capabilities, so the resolver's lifecycle
 *      gates exclude it for movie/series requests before this
 *      adapter is even called.
 *
 *   7. URL safety:
 *
 *      The resolved URL is validated via `validatePlaybackUrl` with
 *      `allowedEmbedOrigins = ['https://megaplay.buzz']`. This blocks
 *      template tampering (an admin editing the template to point at
 *      an attacker-controlled origin).
 *
 * Anikoto catalog API (https://anikotoapi.site) is intentionally NOT
 * used by Mavero. The Anikoto API is for catalog browsing; Mavero
 * already has its own anime catalog (via the AniList adapter) and
 * resolves episodes directly through MegaPlay's MAL/AniList endpoints.
 * No extra API call, no extra latency, no extra failure mode.
 */

export const MEGAPLAY_ADAPTER_ID = 'megaplay-embed';
export const MEGAPLAY_ORIGIN = 'https://megaplay.buzz';

/**
 * The two variants MegaPlay exposes. Both are always declared available;
 * actual availability is detected at runtime via the player's `error`
 * postMessage event. If a variant is missing, the player emits
 * `provider-error` and the watch route's fallback walker tries the
 * next eligible anime source.
 */
const MEGAPLAY_VARIANTS = ['sub', 'dub'] as const;

/**
 * The variants exposed in the source selector. Order: SUB first (the
 * canonical Japanese-audio default), DUB second.
 */
function megaPlayVariants(audioLanguages: string[] | null | undefined): string[] {
  if (!Array.isArray(audioLanguages) || audioLanguages.length === 0) {
    // No audio_languages declared in the DB row — expose both variants
    // so the user can attempt either one.
    return [...MEGAPLAY_VARIANTS];
  }
  // Filter to known MegaPlay variants, preserving DB order. Case-insensitive.
  const allowed = new Set(MEGAPLAY_VARIANTS.map((v) => v.toLowerCase()));
  const filtered = audioLanguages
    .map((v) => String(v).toLowerCase())
    .filter((v) => allowed.has(v));
  // Dedupe.
  return [...new Set(filtered)].length > 0 ? [...new Set(filtered)] : [...MEGAPLAY_VARIANTS];
}

/**
 * Validate the variant string. Returns the lowercased variant if it is
 * a known MegaPlay variant, otherwise returns the default ('sub').
 * Never throws.
 */
function normalizeVariant(variant: string | undefined, available: string[]): string {
  if (typeof variant === 'string' && variant.length > 0 && available.includes(variant.toLowerCase())) {
    return variant.toLowerCase();
  }
  return available[0] ?? 'sub';
}

/**
 * Resolve the MegaPlay embed URL. Throws ResolverError on:
 *   - UNSUPPORTED_MEDIA_TYPE (movie/series)
 *   - MISSING_IDENTIFIER (no AniList ID and no MAL ID)
 *   - MISSING_IDENTIFIER (anime request without episode number)
 *   - INVALID_TEMPLATE (admin tampered with the template)
 *   - INVALID_SOURCE_URL (URL origin is not https://megaplay.buzz)
 */
function resolveMegaPlayUrl(context: ResolverContext, variant: string): string {
  const mediaType = context.request.mediaType;
  if (mediaType !== 'anime') {
    // The DB capability gates should have excluded this already, but we
    // double-check here for defense in depth.
    throw new ResolverError('UNSUPPORTED_MEDIA_TYPE');
  }
  if (!context.request.episode) {
    // Anime requires an episode number —MegaPlay's URL contract is
    // /stream/{ani|mal}/{id}/{episode}/{language}.
    throw new ResolverError('MISSING_IDENTIFIER');
  }

  // Identifier resolution: prefer AniList ID (Mavero's primary), fall back to MAL.
  const anilistId = context.identifiers.anilistId;
  const malId = context.identifiers.malId;
  if (!anilistId && !malId) {
    throw new ResolverError('MISSING_IDENTIFIER');
  }

  // Use the configured anime_template as a SAFETY CHECK. We do NOT
  // blindly trust the template — we reconstruct the URL from trusted
  // components and verify the template matches the expected shape.
  // If an admin has tampered with the template, we throw INVALID_TEMPLATE.
  const configuredTemplate = context.config.source.anime_template;
  const expectedAniTemplate = `${MEGAPLAY_ORIGIN}/stream/ani/{anilist_id}/{episode}/sub`;
  const expectedMalTemplate = `${MEGAPLAY_ORIGIN}/stream/mal/{mal_id}/{episode}/sub`;
  // Accept either the AniList-shaped or MAL-shaped template. Both must
  // end with `/sub` (the default variant); the variant segment is
  // substituted at runtime by this adapter.
  if (configuredTemplate !== expectedAniTemplate && configuredTemplate !== expectedMalTemplate) {
    throw new ResolverError('INVALID_TEMPLATE');
  }

  // Reconstruct the URL from trusted components. We do NOT use
  // resolveTemplate() here because the template's `{episode}` placeholder
  // already encodes the episode number — we just need to swap the trailing
  // `/sub` for the user-selected variant.
  const episode = context.request.episode;
  const safeEpisode = encodeURIComponent(String(episode));
  const safeVariant = encodeURIComponent(variant);

  let rawUrl: string;
  if (anilistId) {
    const safeId = encodeURIComponent(anilistId);
    rawUrl = `${MEGAPLAY_ORIGIN}/stream/ani/${safeId}/${safeEpisode}/${safeVariant}`;
  } else if (malId) {
    const safeId = encodeURIComponent(malId);
    rawUrl = `${MEGAPLAY_ORIGIN}/stream/mal/${safeId}/${safeEpisode}/${safeVariant}`;
  } else {
    // Unreachable — we threw MISSING_IDENTIFIER above.
    throw new ResolverError('MISSING_IDENTIFIER');
  }

  return rawUrl;
}

export const megaplayProviderAdapter: ProviderAdapter = {
  integrationType: 'embed',
  adapterId: MEGAPLAY_ADAPTER_ID,
  async resolve(context): Promise<AdapterResult> {
    // Anime-only — defense in depth even though DB capability gates
    // should exclude this adapter for movie/series requests.
    if (context.request.mediaType !== 'anime') {
      throw new ResolverError('UNSUPPORTED_MEDIA_TYPE');
    }

    // Determine the variants exposed by this source row.
    const variants = megaPlayVariants(context.config.source.audio_languages);

    // Determine which variant to use for this resolution.
    const selectedVariant = normalizeVariant(context.request.variant, variants);

    // Resolve the URL. Throws ResolverError on any contract violation.
    const rawUrl = resolveMegaPlayUrl(context, selectedVariant);

    // Validate the URL: must be HTTPS, must be https://megaplay.buzz,
    // must not be a private/local hostname.
    const safeUrl = validatePlaybackUrl(rawUrl, 'embed', [MEGAPLAY_ORIGIN]);

    return {
      type: 'embed',
      url: safeUrl,
      metadata: {
        providerName: context.config.provider.name,
        sourceName: context.config.source.name,
        variants,
        selectedVariant,
        note: 'MegaPlay anime embed. SUB/DUB variants are exposed as runtime options on a single source row. Mavero does not use provider redirects, hidden iframe inspection, or provider-specific progress storage.',
      },
    };
  },
};
