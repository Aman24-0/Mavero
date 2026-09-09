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

// ============================================================
// Cineverse alternate-URL candidate strategy
// ============================================================
//
// Background (Phase 2 refinement):
//   Cineverse's URL scheme is `https://cineverse.modiplay.xyz/download/{titleSlug}`.
//   Most titles resolve with the year-less slug produced by slugifyTitle()
//   (e.g. "Toxic: A Fairy Tale for Grown-ups" → "toxic-a-fairy-tale-for-grown-ups"
//   works; "Spider-Man: Brand New Day" → "spider-man-brand-new-day" works).
//   But a non-trivial minority of titles require the release year appended
//   to the slug (e.g. "Dhurandhar: The Revenge" →
//   "dhurandhar-the-revenge-2026" is the working URL, while
//   "dhurandhar-the-revenge" returns 404).
//
// Design constraints (from the spec):
//   - Do NOT blindly append the year to every Cineverse title (would break
//     the working year-less URLs).
//   - Do NOT invent hardcoded title mappings like "Dhurandhar".
//   - Do NOT implement fake automatic 404 detection (cross-origin iframe
//     onload cannot reliably inspect a Cineverse response).
//   - Preserve the existing deterministic slugifyTitle() behavior.
//   - Keep the normal title slug as the PRIMARY candidate.
//   - Provide a Cineverse alternate candidate {titleSlug}-{releaseYear}
//     ONLY when a release year exists. The user can manually switch to the
//     alternate if the primary doesn't load.
//
// What this module exposes:
//   - cineverseAlternateSlug(title, releaseYear) → string | null
//       Returns the year-suffixed slug ("dhurandhar-the-revenge-2026")
//       or null when the year is missing/invalid (so we never produce
//       "-undefined" / "-0" / "-NaN" candidates).
//   - getDownloadUrlCandidates(provider, options) → { label, url }[]
//       Returns the primary URL first; if the provider is Cineverse AND
//       a release year is supplied AND the alternate URL is different
//       from the primary, appends a labeled alternate URL.
//
// No server-side fetching/proxying is performed. The browser iframe loads
// the primary URL directly; the alternate is offered as a manual fallback.

/**
 * The Cineverse provider slug, as seeded in the migration. Used to detect
 * "this provider is Cineverse" without inventing a separate flag column.
 */
export const CINEVERSE_PROVIDER_SLUG = 'cineverse';

/**
 * Compute the Cineverse alternate slug: the deterministic title slug with
 * the release year appended.
 *
 *   cineverseAlternateSlug("Dhurandhar: The Revenge", 2026)
 *     → "dhurandhar-the-revenge-2026"
 *
 *   cineverseAlternateSlug("Toxic: A Fairy Tale for Grown-ups", 2024)
 *     → "toxic-a-fairy-tale-for-grown-ups-2024"
 *
 * Returns null when:
 *   - the title is empty/whitespace (slug would be empty)
 *   - the release year is missing, not a finite number, or non-positive
 *
 * The "null when no year" rule is critical: we must NEVER produce a
 * "-undefined" / "-0" / "-NaN" candidate — those would generate broken
 * URLs and confuse the user.
 */
export function cineverseAlternateSlug(title: string, releaseYear: number | undefined | null): string | null {
  const slug = slugifyTitle(title ?? '');
  if (!slug) return null;
  // Strict year validation: must be a finite positive integer. We accept
  // years as low as 1900 (anything older is almost certainly a data error
  // and we'd rather skip the alternate than produce a misleading URL).
  if (typeof releaseYear !== 'number' || !Number.isFinite(releaseYear)) return null;
  const year = Math.trunc(releaseYear);
  if (year < 1900) return null;
  return `${slug}-${year}`;
}

/**
 * A labeled download URL candidate. `label` is a short human-readable
 * description used by the DownloadSheet's alternate-URL affordance.
 */
export type DownloadUrlCandidate = {
  label: string;
  url: string;
};

/**
 * Compute all download URL candidates for a single provider given a media
 * item.
 *
 * Behaviour:
 *   - The PRIMARY candidate is always the output of buildDownloadUrl()
 *     (the existing deterministic year-less URL for Cineverse, the
 *     TMDB-id URL for every other provider).
 *   - For the Cineverse provider ONLY, when a releaseYear is supplied
 *     AND the alternate URL is different from the primary, an ALTERNATE
 *     candidate is appended with label "Try with year".
 *   - For every other provider, only the primary candidate is returned
 *     (the array has length 1, or length 0 if buildDownloadUrl returns
 *     null for the primary).
 *
 * The function never fetches anything server-side. The browser iframe
 * loads the primary URL directly; the alternate is offered to the user
 * as a manual fallback when Cineverse returns a blank/404 page.
 *
 * @returns An array of { label, url } candidates. Primary first; alternate
 *          (if any) second. Empty if the provider cannot build any valid
 *          URL for this item.
 */
export function getDownloadUrlCandidates(
  provider: Pick<PublicDownloadProvider, 'slug' | 'supportsMovie' | 'supportsTv' | 'movieUrlTemplate' | 'tvUrlTemplate'>,
  options: {
    mediaType: DownloadMediaType;
    tmdbId?: string;
    title?: string;
    season?: number;
    episode?: number;
    releaseYear?: number;
  }
): DownloadUrlCandidate[] {
  const primaryUrl = buildDownloadUrl(provider, options);
  if (!primaryUrl) return [];

  const candidates: DownloadUrlCandidate[] = [{ label: 'Primary', url: primaryUrl }];

  // Cineverse-only alternate: {titleSlug}-{releaseYear}. We detect
  // Cineverse by its slug (no separate DB column needed).
  if (provider.slug !== CINEVERSE_PROVIDER_SLUG) return candidates;
  if (!options.title) return candidates;

  const altSlug = cineverseAlternateSlug(options.title, options.releaseYear);
  if (!altSlug) return candidates;

  // Build the alternate URL by re-applying the template with the
  // year-suffixed slug. We do this by calling applyDownloadTemplate
  // with a title whose slugified form equals altSlug. The cleanest way
  // is to inline the substitution against the same template the primary
  // used, replacing {titleSlug} with altSlug.
  const template = options.mediaType === 'movie' ? provider.movieUrlTemplate : provider.tvUrlTemplate;
  if (!template || !template.includes('{titleSlug}')) return candidates;

  // Substitute every placeholder EXCEPT {titleSlug} using the normal
  // applyDownloadTemplate path, then manually swap {titleSlug} → altSlug.
  // We do the manual swap because applyDownloadTemplate always slugifies
  // the title itself — there's no way to inject a pre-computed slug
  // through it without changing its public signature (which we don't
  // want to do, to keep the change minimal).
  const tmdbId = options.tmdbId?.trim();
  const season = typeof options.season === 'number' && Number.isFinite(options.season) ? options.season : undefined;
  const episode = typeof options.episode === 'number' && Number.isFinite(options.episode) ? options.episode : undefined;

  // Validate required placeholders are present (mirror buildDownloadUrl's
  // graceful-fail behavior).
  if (template.includes('{tmdbId}') && !tmdbId) return candidates;
  if (template.includes('{season}') && season === undefined) return candidates;
  if (template.includes('{season2}') && season === undefined) return candidates;
  if (template.includes('{episode}') && episode === undefined) return candidates;
  if (template.includes('{episode2}') && episode === undefined) return candidates;

  let altUrl = template;
  altUrl = altUrl.split('{tmdbId}').join(encodePlaceholderValue(tmdbId ?? ''));
  altUrl = altUrl.split('{titleSlug}').join(encodePlaceholderValue(altSlug));
  if (template.includes('{season}')) altUrl = altUrl.split('{season}').join(encodePlaceholderValue(season as number));
  if (template.includes('{season2}')) altUrl = altUrl.split('{season2}').join(encodePlaceholderValue(pad2(season as number)));
  if (template.includes('{episode}')) altUrl = altUrl.split('{episode}').join(encodePlaceholderValue(episode as number));
  if (template.includes('{episode2}')) altUrl = altUrl.split('{episode2}').join(encodePlaceholderValue(pad2(episode as number)));

  // Validate HTTPS + dedupe against the primary (if the year-suffixed
  // URL happens to equal the primary — e.g. the title already ends with
  // the year — skip the alternate).
  if (!/^https:\/\/[a-z0-9]/i.test(altUrl)) return candidates;
  if (altUrl === primaryUrl) return candidates;

  candidates.push({ label: 'Try with year', url: altUrl });
  return candidates;
}
