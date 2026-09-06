import { ResolverError } from './errors';
import { validatePlaybackUrl } from './safe-url';
import type { AdapterResult, ProviderAdapter, ResolverContext } from './types';

/**
 * Yenime resolver adapter — Phase 7F+.
 *
 * Yenime (https://api.yenime.net) is an anime-only embed provider that
 * uses MAL ID + episode number as its identifier contract. Verified
 * directly from the official API documentation at
 * https://api.yenime.net (homepage + JS chunks).
 *
 * API contract:
 *
 *   1. Embed URL: `https://api.yenime.net/anime/{mal_id}/{episode}`
 *      - `{mal_id}` is the MyAnimeList ID (numeric, e.g. 52991 for Frieren).
 *      - `{episode}` is the episode number (numeric, 1-indexed).
 *      - The episode segment is OPTIONAL in the Yenime API (defaults to
 *        episode 1 when absent), but Mavero always passes it explicitly
 *        so the URL is deterministic and the resolver can validate it.
 *
 *   2. Query parameters (verified from the docs section "Query Parameters"):
 *      - `?autoplay=true` — start video immediately (muted). Mavero does
 *        NOT pass this — the player should respect user gesture.
 *      - `?color=ffffff` — custom accent color. Mavero does NOT pass this.
 *      - `?startAt=N` — begin playback from N seconds. Mavero passes this
 *        when the user has a saved resume position (see `startAtParam`
 *        in the Yenime player adapter — `startAt` is VERIFIED supported).
 *
 *   3. Identifier mode: `mal_id` ONLY. Yenime does NOT accept AniList or
 *      TMDB IDs. The resolver throws `MISSING_IDENTIFIER` when the content
 *      has no MAL ID. This is intentional — the watch route should look
 *      up the MAL ID via the AniList adapter (which exposes `idMal` on
 *      every anime record) before reaching this adapter.
 *
 *   4. SUB/DUB: the Yenime player has an INTERNAL "Toggle SUB/DUB"
 *      button (verified from the player HTML — there is a button with
 *      title="Toggle SUB/DUB" and text "SUB"). There is NO separate
 *      `/sub` or `/dub` URL segment. Therefore Mavero does NOT expose
 *      variants on the Yenime source option — the user toggles audio
 *      inside the iframe. This is different from MegaPlay, which
 *      encodes the variant in the URL path.
 *
 *   5. Origin: `https://api.yenime.net`. The adapter validates the
 *      resolved URL against this origin via `validatePlaybackUrl`.
 *
 *   6. startAt: VERIFIED supported via the `?startAt=N` query parameter.
 *      The player adapter exposes `startAtParam()` returning `'startAt'`
 *      so the PlaybackManager appends it to the URL when a resume
 *      position exists. Unlike MegaPlay, Yenime DOES support resume.
 *
 *   7. Anime-only — defense in depth. Throws `UNSUPPORTED_MEDIA_TYPE`
 *      for movie/series. The DB capability gates should also exclude
 *      Yenime for non-anime content (the migration sets
 *      `movie: false, series: false, anime: true`).
 *
 *   8. Yenime's underlying stream data is sourced from MegaPlay (the
 *      docs explicitly say "Sub-second response via direct megaplay
 *      extraction"). Mavero treats Yenime as a SEPARATE provider
 *      because it accepts MAL IDs (MegaPlay accepts AniList IDs as
 *      primary). This gives users a second anime option when MegaPlay
 *      is missing or fails.
 */

export const YENIME_ADAPTER_ID = 'yenime-embed';
export const YENIME_ORIGIN = 'https://api.yenime.net';

/**
 * Resolve the Yenime embed URL. Throws ResolverError on:
 *   - UNSUPPORTED_MEDIA_TYPE (movie/series)
 *   - MISSING_IDENTIFIER (no MAL ID)
 *   - MISSING_IDENTIFIER (anime request without episode number)
 *   - INVALID_TEMPLATE (admin tampered with the template)
 *   - INVALID_SOURCE_URL (URL origin is not https://api.yenime.net)
 */
function resolveYenimeUrl(context: ResolverContext): string {
  const mediaType = context.request.mediaType;
  if (mediaType !== 'anime') {
    // Defense in depth — DB capability gates should have excluded this.
    throw new ResolverError('UNSUPPORTED_MEDIA_TYPE');
  }
  if (!context.request.episode) {
    // Yenime's URL contract requires an episode number.
    throw new ResolverError('MISSING_IDENTIFIER');
  }

  // Identifier resolution: Yenime accepts ONLY MAL ID. Do NOT fall back to
  // AniList or TMDB — that would produce a broken embed. If MAL is missing,
  // throw MISSING_IDENTIFIER so the fallback walker tries the next anime
  // provider (e.g. MegaPlay, which accepts AniList).
  const malId = context.identifiers.malId;
  if (!malId) {
    throw new ResolverError('MISSING_IDENTIFIER');
  }

  // Use the configured anime_template as a SAFETY CHECK. We do NOT
  // blindly trust the template — we reconstruct the URL from trusted
  // components and verify the template matches the expected shape.
  // If an admin has tampered with the template, we throw INVALID_TEMPLATE.
  const configuredTemplate = context.config.source.anime_template;
  const expectedTemplate = `${YENIME_ORIGIN}/anime/{mal_id}/{episode}`;
  if (configuredTemplate !== expectedTemplate) {
    throw new ResolverError('INVALID_TEMPLATE');
  }

  // Reconstruct the URL from trusted components.
  const safeMalId = encodeURIComponent(malId);
  const safeEpisode = encodeURIComponent(String(context.request.episode));
  return `${YENIME_ORIGIN}/anime/${safeMalId}/${safeEpisode}`;
}

export const yenimeProviderAdapter: ProviderAdapter = {
  integrationType: 'embed',
  adapterId: YENIME_ADAPTER_ID,
  async resolve(context): Promise<AdapterResult> {
    // Anime-only — defense in depth.
    if (context.request.mediaType !== 'anime') {
      throw new ResolverError('UNSUPPORTED_MEDIA_TYPE');
    }

    // Resolve the URL. Throws ResolverError on any contract violation.
    const rawUrl = resolveYenimeUrl(context);

    // Validate the URL: must be HTTPS, must be https://api.yenime.net,
    // must not be a private/local hostname.
    const safeUrl = validatePlaybackUrl(rawUrl, 'embed', [YENIME_ORIGIN]);

    return {
      type: 'embed',
      url: safeUrl,
      metadata: {
        providerName: context.config.provider.name,
        sourceName: context.config.source.name,
        // No variants — Yenime's SUB/DUB is an in-player toggle, not a
        // URL path segment. Mavero does NOT expose variant buttons for
        // Yenime (unlike MegaPlay, which has separate /sub and /dub URLs).
        note: 'Yenime anime embed. MAL ID + episode. SUB/DUB is an in-player toggle (no separate URL variants). Mavero does not use provider redirects, hidden iframe inspection, or provider-specific progress storage.',
      },
    };
  },
};
