// MAVERO downloader shared module — pure helpers + types shared between the
// public DetailPage UI, the URL builder, and the admin/tests.
//
// This module is the SINGLE source of truth for:
//   * the deterministic Cineverse title-slug algorithm
//   * the known placeholder set used by URL templates
//   * zero-padding helpers for season/episode
//   * the PublicDownloadProvider type used by the public config reader
//
// It is intentionally framework-free (no SvelteKit, no Supabase imports) so
// the same code runs on the server (public-config reader, admin-service,
// tests) and is referenced indirectly by the browser via the typed config.

/**
 * The only placeholders allowed inside download URL templates.
 * Anything else in a template is rejected by validation.
 */
export const DOWNLOAD_PLACEHOLDERS = [
  '{tmdbId}',
  '{season}',
  '{episode}',
  '{season2}',
  '{episode2}',
  '{titleSlug}',
] as const;

export type DownloadPlaceholder = (typeof DOWNLOAD_PLACEHOLDERS)[number];

/**
 * Media-type that the downloader resolves a URL for. The downloader registry
 * is purely movie/TV-shaped: anime movies reuse the movie URL, anime series
 * reuse the TV URL. The DetailPage decides which based on the existing
 * `item.animeFormat` field (preserved by the existing anime routing).
 */
export type DownloadMediaType = 'movie' | 'tv';

/**
 * Public downloader provider shape — exactly the fields the browser iframe
 * feature needs to render + build a URL. No admin-only metadata (notes,
 * status flags, raw admin row data) is ever included.
 */
export type PublicDownloadProvider = {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  isDefault: boolean;
  ordering: number;
  icon: string | null;
  description: string | null;
  supportsMovie: boolean;
  supportsTv: boolean;
  movieUrlTemplate: string | null;
  tvUrlTemplate: string | null;
};

/**
 * Deterministic Cineverse title slug.
 *
 * Algorithm (matches the spec examples):
 *   "Deadpool & Wolverine"   -> "deadpool-wolverine"
 *   "Dune: Part Two"          -> "dune-part-two"
 *   "Breaking Bad"            -> "breaking-bad"
 *   "Loki"                    -> "loki"
 *
 * Steps:
 *   1. lowercase + trim
 *   2. normalize Unicode (NFKD) and drop combining marks
 *   3. strip punctuation EXCEPT digits, letters, and whitespace
 *   4. convert separators (whitespace, underscores) to "-"
 *   5. collapse repeated "-"
 *   6. trim leading/trailing "-"
 *   7. preserve meaningful numbers (digits are kept verbatim)
 *
 * No special title mappings are invented here. The output is a function of
 * the input only, so any consumer (URL builder, tests, admin preview) gets
 * the same string for the same title.
 */
export function slugifyTitle(title: string): string {
  if (typeof title !== 'string') return '';
  // 1. lowercase + trim
  let s = title.trim().toLowerCase();
  if (s === '') return '';
  // 2. Unicode NFKD normalization (decompose accented chars) + drop combining
  //    marks so "café" -> "cafe" rather than "cafe\u0301".
  s = s.normalize('NFKD').replace(/\p{Diacritic}/gu, '');
  // 3. Strip punctuation/anything that is not a letter, digit, or whitespace.
  //    \p{L} covers Latin + CJK + all other scripts. \p{N} preserves numbers.
  //    Underscore is intentionally NOT preserved here — it becomes "-" in
  //    step 4 like every other separator.
  s = s.replace(/[^\p{L}\p{N}\s_-]/gu, '');
  // 4. Convert whitespace + underscores to "-".
  s = s.replace(/[\s_]+/g, '-');
  // 5. Collapse repeated "-".
  s = s.replace(/-+/g, '-');
  // 6. Trim leading/trailing "-".
  s = s.replace(/^-+|-+$/g, '');
  return s;
}

/**
 * Zero-pad a season/episode number to two digits.
 *
 * Cineverse uses {season2} / {episode2} placeholders expecting exactly two
 * digits (s02e05). For seasons/episodes >= 100 the number is preserved
 * verbatim (no truncation).
 *
 *   pad2(5)   -> "05"
 *   pad2(0)   -> "00"
 *   pad2(12)  -> "12"
 *   pad2(123) -> "123"
 */
export function pad2(value: number): string {
  if (!Number.isFinite(value)) return '00';
  const n = Math.max(0, Math.trunc(value));
  return n < 100 ? String(n).padStart(2, '0') : String(n);
}

/**
 * Encode a single placeholder value safely for inclusion in a URL path
 * segment. We use encodeURIComponent so any non-ASCII title-slug fragment
 * (after slugify this should be ASCII-only, but defensively) is escaped.
 *
 * For {tmdbId}, {season}, {episode}, {season2}, {episode2} the input is
 * numeric — encodeURIComponent is a no-op for digits.
 */
function encodePlaceholderValue(value: string | number): string {
  return encodeURIComponent(String(value));
}

/**
 * Apply a download URL template: substitute the known placeholders and
 * validate that the result is an HTTPS URL.
 *
 * Behaviour:
 *   - If the template is null/empty, returns null (the provider is treated as
 *     "not configured for this media type").
 *   - If a required placeholder is missing (e.g. {titleSlug} but the title is
 *     empty), returns null (the provider cannot build a valid URL for this
 *     item).
 *   - Unknown placeholders (anything inside "{...}" that is NOT in
 *     DOWNLOAD_PLACEHOLDERS) are left untouched. This is defensive — admin
 *     validation rejects unknown placeholders at write-time, so this should
 *     never happen with DB-stored templates. But the function is also used by
 *     tests with arbitrary fixtures, so we don't throw.
 *   - The returned URL is always HTTPS (verified). If a non-HTTPS URL is
 *     somehow produced, null is returned.
 *
 * @param template - The provider's movie_url_template or tv_url_template.
 * @param params   - The values to substitute.
 * @returns The fully-substituted HTTPS URL, or null.
 */
export function applyDownloadTemplate(
  template: string | null | undefined,
  params: {
    tmdbId?: string;
    title?: string;
    season?: number;
    episode?: number;
  }
): string | null {
  if (!template || typeof template !== 'string') return null;
  const tmdbId = params.tmdbId?.trim();
  const titleSlug = slugifyTitle(params.title ?? '');
  const season = typeof params.season === 'number' && Number.isFinite(params.season) ? params.season : undefined;
  const episode = typeof params.episode === 'number' && Number.isFinite(params.episode) ? params.episode : undefined;

  // Detect which placeholders the template actually references so we can
  // fail gracefully (return null) if a required value is missing.
  const needsTmdb = template.includes('{tmdbId}');
  const needsTitleSlug = template.includes('{titleSlug}');
  const needsSeason = template.includes('{season}') || template.includes('{season2}');
  const needsEpisode = template.includes('{episode}') || template.includes('{episode2}');

  if (needsTmdb && !tmdbId) return null;
  if (needsTitleSlug && !titleSlug) return null;
  if (needsSeason && season === undefined) return null;
  if (needsEpisode && episode === undefined) return null;

  let url = template;
  if (needsTmdb) url = url.split('{tmdbId}').join(encodePlaceholderValue(tmdbId as string));
  if (needsTitleSlug) url = url.split('{titleSlug}').join(encodePlaceholderValue(titleSlug));
  if (template.includes('{season}')) url = url.split('{season}').join(encodePlaceholderValue(season as number));
  if (template.includes('{season2}')) url = url.split('{season2}').join(encodePlaceholderValue(pad2(season as number)));
  if (template.includes('{episode}')) url = url.split('{episode}').join(encodePlaceholderValue(episode as number));
  if (template.includes('{episode2}')) url = url.split('{episode2}').join(encodePlaceholderValue(pad2(episode as number)));

  // Validate HTTPS.
  if (!/^https:\/\/[a-z0-9]/i.test(url)) return null;
  return url;
}

/**
 * Build the download URL for a single provider given a media item.
 *
 * Decision logic:
 *   - mediaType 'movie' -> use movie_url_template with {tmdbId} (or
 *     {titleSlug} for Cineverse).
 *   - mediaType 'tv'    -> use tv_url_template with {tmdbId}/{season}/
 *     {episode} (or {titleSlug}/{season2}/{episode2} for Cineverse).
 *
 * The function NEVER fetches anything server-side. It returns the HTTPS URL
 * that the browser iframe should load directly.
 *
 * @returns A validated HTTPS URL string, or null if the provider cannot
 *          build a valid URL for this item (missing required identifier,
 *          unsupported media type, or non-HTTPS template).
 */
export function buildDownloadUrl(
  provider: Pick<PublicDownloadProvider, 'supportsMovie' | 'supportsTv' | 'movieUrlTemplate' | 'tvUrlTemplate'>,
  options: {
    mediaType: DownloadMediaType;
    tmdbId?: string;
    title?: string;
    season?: number;
    episode?: number;
  }
): string | null {
  if (options.mediaType === 'movie') {
    if (!provider.supportsMovie) return null;
    return applyDownloadTemplate(provider.movieUrlTemplate, {
      tmdbId: options.tmdbId,
      title: options.title,
    });
  }
  // 'tv'
  if (!provider.supportsTv) return null;
  return applyDownloadTemplate(provider.tvUrlTemplate, {
    tmdbId: options.tmdbId,
    title: options.title,
    season: options.season,
    episode: options.episode,
  });
}

/**
 * Filter the public provider list by content-type capability.
 *
 * Used by the DetailPage to decide which providers to show in the Download
 * sheet — a movie-only downloader is hidden on a series detail page, and
 * vice versa.
 */
export function filterProvidersByMediaType(
  providers: PublicDownloadProvider[],
  mediaType: DownloadMediaType
): PublicDownloadProvider[] {
  return providers.filter((provider) =>
    mediaType === 'movie' ? provider.supportsMovie : provider.supportsTv
  );
}

/**
 * Sort providers for public display:
 *   1. default first
 *   2. ordering ascending
 *   3. name ascending
 *
 * The default-fallback rule (when the current default is disabled, pick the
 * first enabled by ordering) is implemented by the public-config reader; this
 * helper only sorts the already-resolved list.
 */
export function sortPublicDownloadProviders(providers: PublicDownloadProvider[]): PublicDownloadProvider[] {
  return [...providers].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (a.ordering !== b.ordering) return a.ordering - b.ordering;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}
