import type { ContentType, NormalizedMediaItem } from '$lib/server/content/types';

/**
 * Phase 7F+ v2: Derive the canonical playback media type for the resolver.
 *
 * The canonical playback media type is what normal providers (VidSrc, VidLink,
 * etc.) expect: `'movie'` or `'series'`. It is NEVER `'anime'` for normal
 * providers — `'anime'` is an additive capability flag, not a playback type.
 *
 * For TMDB-tagged anime (content.type='movie' or 'series'), the canonical
 * type is already correct — it's the TMDB type. No derivation needed.
 *
 * For AniList-native anime (content.type='anime'), the canonical type is
 * derived from `content.animeFormat`:
 *   - animeFormat='movie' → 'movie' (e.g. Spirited Away, Infinity Castle)
 *   - animeFormat='series' → 'series' (e.g. Naruto, Hunter x Hunter)
 *   - animeFormat=undefined → fallback to 'series' (most anime are series)
 *
 * This function is used by the resolver to determine which mediaType to
 * pass to normal providers. Anime-specific providers (Yenime) use the
 * anime-bridge path (content.isAnime + capability.anime) instead.
 *
 * IMPORTANT: This does NOT mutate the canonical content identity.
 * Progress keys, My List, Continue Watching, and URLs all use the
 * ORIGINAL content.type (which stays 'anime' for AniList-native content).
 * Only the resolver request's `mediaType` field uses the derived value.
 */
export function getCanonicalPlaybackMediaType(content: NormalizedMediaItem): Exclude<ContentType, 'anime'> {
  if (content.type === 'movie') return 'movie';
  if (content.type === 'series') return 'series';
  // content.type === 'anime' — derive from animeFormat
  if (content.animeFormat === 'movie') return 'movie';
  // Default to 'series' for all other anime formats (TV, TV_SHORT, ONA, OVA, SPECIAL)
  return 'series';
}

/**
 * Phase 7F+ v2: Check if a content item is anime-flagged AND has a
 * specific anime format that maps to the given canonical type.
 *
 * Used by the resolver to determine if the anime-bridge path should be
 * considered for a provider that declares `anime:true`.
 *
 * For example: Naruto (type='anime', animeFormat='series') is anime-flagged
 * AND has animeFormat='series'. So a provider with `series:true` can handle
 * it via the canonical path, AND a provider with `anime:true` can handle it
 * via the anime-bridge path.
 *
 * For Spirited Away (type='anime', animeFormat='movie'), a provider with
 * `movie:true` can handle it canonically, AND a provider with `anime:true`
 * can handle it via the anime-bridge.
 */
export function isAnimeWithFormat(content: NormalizedMediaItem, canonicalType: 'movie' | 'series'): boolean {
  if (content.isAnime !== true) return false;
  if (content.type === 'movie' && canonicalType === 'movie') return true;
  if (content.type === 'series' && canonicalType === 'series') return true;
  if (content.type === 'anime' && content.animeFormat === canonicalType) return true;
  // AniList-native anime with no explicit animeFormat defaults to 'series'
  if (content.type === 'anime' && !content.animeFormat && canonicalType === 'series') return true;
  return false;
}
