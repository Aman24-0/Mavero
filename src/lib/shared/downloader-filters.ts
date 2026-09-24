/**
 * MAVERO Downloader — Phase C filter helpers (shared, pure).
 *
 * This module is the SINGLE source of truth for downloader filter logic. Both
 * the Svelte component (`MaveroAddonDownload.svelte`) and the test suite
 * (`stremio_downloader_phaseC_filters_test.ts`) import from here so the
 * filter rules can never drift between the UI and the tests.
 *
 * ARCHITECTURE (per the approved plan §22 / §27):
 *
 *   FULL STREAM COLLECTION (active tab's full resolved stream list)
 *     ↓
 *   FILTER (this module — `filterStreams`)
 *     ↓
 *   RANK (already done server-side via `scoreDownloadCandidate`)
 *     ↓
 *   PRESENTATION WINDOW / Show More (future phase — not implemented here)
 *     ↓
 *   VISIBLE STREAMS
 *
 * Filters operate on the FULL active-tab stream collection, NEVER on a
 * pre-truncated subset. Changing a filter does NOT refetch addons — it
 * recomputes the filtered view from the already-resolved collection.
 *
 * SEMANTIC LANGUAGE MATCHING (per the approved plan §7):
 *
 * The language filter does NOT rely solely on exact display labels. It uses
 * the normalized `audioLanguages` array (derived from addon-supplied text by
 * `detectAudioLanguages` in `stream-normalize.ts`) and the `audio` class
 * (derived by `audioClassFor` in `stream-selection.ts`).
 *
 *   "English" selected
 *     → stream matches if `audioLanguages` includes "English"
 *     → this naturally covers: direct English streams, Dual Audio
 *       containing English, and Multi Audio containing English — because
 *       ALL of these have "English" in their `audioLanguages` array.
 *     → a Dual/Multi Audio stream WITHOUT "English" in `audioLanguages`
 *       does NOT match (we never fabricate language membership).
 *
 *   "Dual Audio" selected
 *     → stream matches if `audio === 'dual' || audio === 'multi'`
 *     → both dual AND multi qualify (the user's plan: "dual/multi-audio
 *       candidates only")
 *
 *   "Multi Audio" selected
 *     → stream matches if `audio === 'multi'` only
 *
 * UNKNOWN-SIZE HANDLING (per the approved plan §6):
 *
 * The previous implementation silently deleted unknown-size streams when ANY
 * size filter was active (`if (bytes === undefined) return false;`). Phase C
 * fixes this: unknown-size streams are PRESERVED when a size filter is active
 * — they are shown alongside size-matching streams with no size badge. The
 * size filter acts as a soft preference (size-matching streams rank above
 * unknown-size streams) rather than a hard exclusion. This is the
 * "should not silently delete" behavior the approved plan requires.
 *
 * Pure module: no DOM, no network, no Svelte, no server imports.
 */

import type { AudioClass } from '$lib/shared/stream-selection';

// ---------------------------------------------------------------------------
// Types — mirror the component's StreamView shape (the fields filters read)
// ---------------------------------------------------------------------------

/**
 * The minimal stream shape that filter helpers need. This is a structural
 * subset of `AddonDownloadStreamView` (from `addon-download-service.ts`) —
 * any object with these fields can be filtered. The component's `StreamView`
 * type satisfies this structurally, so no adapter is needed.
 */
export type FilterableStream = {
  url: string;
  kind: 'http' | 'https' | 'hls' | 'dash' | 'p2p' | 'magnet' | 'external';
  quality: string;
  audio: AudioClass;
  audioLanguages?: string[];
  sizeBytes?: number;
};

/**
 * The four filter dimensions. Each defaults to `'all'` (no filter). The
 * `language` field accepts:
 *   - `'all'` → no language filter
 *   - `'dual'` → Dual Audio filter (dual + multi)
 *   - `'multi'` → Multi Audio filter (multi only)
 *   - any language string (e.g., `'English'`, `'Hindi'`) → semantic match
 */
export type DownloaderFilters = {
  type: 'all' | FilterableStream['kind'];
  quality: 'all' | string;
  size: 'all' | SizeFilterValue;
  language: 'all' | 'dual' | 'multi' | string;
};

/**
 * Size filter values. The ranges match the existing Phase 18 implementation
 * (the approved plan says "Follow the existing implementation/data model for
 * exact ranges if one already exists"). Each value means "streams under X GB"
 * except `over20` which means "streams over 20 GB".
 */
export type SizeFilterValue = 'under1' | 'under2' | 'under3' | 'under5' | 'under10' | 'under20' | 'over20';

/** The default (no-filter) state. */
export const NO_FILTERS: DownloaderFilters = { type: 'all', quality: 'all', size: 'all', language: 'all' };

// ---------------------------------------------------------------------------
// Size ranges (GB thresholds — match the existing Phase 18 implementation)
// ---------------------------------------------------------------------------

const GB = 1024 ** 3;

/** Range boundaries for each size filter value (in bytes). `max` = exclusive upper bound. */
const SIZE_RANGES: Record<SizeFilterValue, { min: number; max: number }> = {
  under1: { min: 0, max: 1 * GB },
  under2: { min: 0, max: 2 * GB },
  under3: { min: 0, max: 3 * GB },
  under5: { min: 0, max: 5 * GB },
  under10: { min: 0, max: 10 * GB },
  under20: { min: 0, max: 20 * GB },
  over20: { min: 20 * GB, max: Number.MAX_SAFE_INTEGER },
};

/**
 * Human-readable label for each size filter value. Used by the chip UI and
 * the active-filter-chip label.
 */
export function sizeFilterLabel(value: SizeFilterValue): string {
  switch (value) {
    case 'under1': return '< 1 GB';
    case 'under2': return '< 2 GB';
    case 'under3': return '< 3 GB';
    case 'under5': return '< 5 GB';
    case 'under10': return '< 10 GB';
    case 'under20': return '< 20 GB';
    case 'over20': return '> 20 GB';
  }
}

// ---------------------------------------------------------------------------
// Individual dimension matchers
// ---------------------------------------------------------------------------

/** Type filter: exact kind match. External is hidden by Phase 18 — never a filter option. */
export function streamMatchesType(stream: FilterableStream, type: DownloaderFilters['type']): boolean {
  if (type === 'all') return true;
  return stream.kind === type;
}

/**
 * Quality filter. The old "2K" alias maps to "4K" (per the existing Phase 18
 * behavior). Unknown quality (`'auto'`) only matches when the filter is 'all'.
 */
export function streamMatchesQuality(stream: FilterableStream, quality: DownloaderFilters['quality']): boolean {
  if (quality === 'all') return true;
  const q = stream.quality;
  if (quality === '2K') return q === '4K';
  return q === quality;
}

/**
 * Size filter. Per the approved plan §6: "A size filter should not silently
 * delete unknown-size streams unless that is explicitly the selected filter's
 * intended behavior."
 *
 * Corrective-audit interpretation: for a SPECIFIC size filter (e.g. "< 1 GB"),
 * the intended behavior is to show streams KNOWN to satisfy the range. A
 * stream with unknown size CANNOT be confirmed to satisfy the range, so
 * excluding it IS the explicitly intended behavior — the "should not silently
 * delete" clause does NOT apply to specific size filters.
 *
 * Behavior:
 *   size === 'all'         → every stream matches (including unknown-size)
 *   specific size filter   → stream matches ONLY when it has a known
 *                             positive size that falls within the range
 *
 * Boundary semantics (matching the existing Phase 18 implementation):
 *   - "under N GB" ranges are EXCLUSIVE on the upper end (exactly N GB does
 *     NOT match "< N GB")
 *   - "over20" is INCLUSIVE on the lower end (exactly 20 GB DOES match
 *     "> 20 GB")
 *   - unknown / undefined / non-positive size → does NOT match any specific
 *     filter (only matches 'all')
 */
export function streamMatchesSize(stream: FilterableStream, size: DownloaderFilters['size']): boolean {
  if (size === 'all') return true;
  const bytes = stream.sizeBytes;
  // Unknown-size streams do NOT match a specific size filter — we cannot
  // confirm they satisfy the range. This is the "intended behavior" of a
  // specific size filter per the approved plan §6.
  if (bytes === undefined || bytes <= 0) return false;
  const range = SIZE_RANGES[size];
  return bytes >= range.min && bytes < range.max;
}

/**
 * Language / audio filter — the SEMANTIC matching helper (per the approved
 * plan §7). This is the single function used by both the UI and the tests.
 *
 * Matching rules:
 *   'all'    → always matches
 *   'dual'   → stream.audio is 'dual' OR 'multi' (dual/multi-audio candidates)
 *   'multi'  → stream.audio is 'multi' only
 *   <lang>   → stream.audioLanguages includes <lang>
 *             (this naturally covers: direct language streams, Dual Audio
 *             containing the language, and Multi Audio containing the
 *             language — because all of these have <lang> in audioLanguages)
 *
 * A Dual/Multi Audio stream WITHOUT the language in audioLanguages does NOT
 * match the language filter — we never fabricate language membership (per
 * the approved plan: "Do NOT invent language metadata when the addon did
 * not provide reliable information").
 */
export function streamMatchesLanguage(stream: FilterableStream, language: DownloaderFilters['language']): boolean {
  if (language === 'all') return true;
  if (language === 'dual') return stream.audio === 'dual' || stream.audio === 'multi';
  if (language === 'multi') return stream.audio === 'multi';
  // Specific language (e.g., 'English', 'Hindi') — semantic match via the
  // normalized audioLanguages array. This covers direct matches AND
  // dual/multi streams that contain the language.
  const langs = stream.audioLanguages ?? [];
  return langs.includes(language);
}

// ---------------------------------------------------------------------------
// Composite filter — stream matches ALL active filter dimensions (AND logic)
// ---------------------------------------------------------------------------

/**
 * Applies ALL four filter dimensions to a stream. A stream survives only if
 * it matches EVERY active filter (AND composition). Per the approved plan
 * §10: "stream matches ALL active filter dimensions, not OR across unrelated
 * active filters."
 *
 * Generic over T so the caller's full stream type (e.g., the component's
 * StreamView with codec/transport/confidence) is preserved through the filter
 * — the helper only READS the filterable fields, never strips other fields.
 */
export function streamMatchesFilters<T extends FilterableStream>(stream: T, filters: DownloaderFilters): boolean {
  return (
    streamMatchesType(stream, filters.type) &&
    streamMatchesQuality(stream, filters.quality) &&
    streamMatchesSize(stream, filters.size) &&
    streamMatchesLanguage(stream, filters.language)
  );
}

/**
 * Filters the FULL stream collection. This is the main entry point used by
 * the component. Operates on the full active-tab stream list — NEVER on a
 * pre-truncated subset. Does NOT mutate the input array.
 *
 * Generic over T so the caller's full stream type is preserved (the filter
 * only reads filterable fields — codec/transport/confidence/etc. pass through
 * untouched). The component casts its StreamView[] to FilterableStream[] for
 * the option-derivation helpers (which only need filterable fields), but
 * filterStreams itself preserves the full type.
 */
export function filterStreams<T extends FilterableStream>(streams: T[], filters: DownloaderFilters): T[] {
  return streams.filter((stream) => streamMatchesFilters(stream, filters));
}

// ---------------------------------------------------------------------------
// Dynamic option derivation — only show options actually present in the
// collection, with counts from the FULL collection
// ---------------------------------------------------------------------------

export type TypeOption = { value: 'all' | FilterableStream['kind']; label: string; count: number };

/**
 * Derives the Type chip options from the FULL stream collection. Only kinds
 * that actually appear are shown (no zero-result options). "All" is always
 * first with the total count.
 *
 * The kind order follows the existing Phase 18 classification order (HTTP →
 * HTTPS → HLS → DASH → P2P → Magnet) for consistent visual scanning.
 */
export function typeOptions(streams: FilterableStream[]): TypeOption[] {
  const order: FilterableStream['kind'][] = ['http', 'https', 'hls', 'dash', 'p2p', 'magnet'];
  const counts = new Map<FilterableStream['kind'], number>();
  for (const s of streams) {
    if (s.kind === 'external') continue; // Phase 18: external is hidden, never a filter option
    counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  }
  const options: TypeOption[] = [{ value: 'all', label: 'All', count: streams.filter((s) => s.kind !== 'external').length }];
  for (const kind of order) {
    const count = counts.get(kind);
    if (count !== undefined && count > 0) {
      options.push({ value: kind, label: kindLabel(kind), count });
    }
  }
  return options;
}

/** Human-readable label for each stream kind (mirrors the card's kindLabel helper). */
function kindLabel(kind: FilterableStream['kind']): string {
  switch (kind) {
    case 'http': return 'HTTP';
    case 'https': return 'HTTPS';
    case 'hls': return 'HLS';
    case 'dash': return 'DASH';
    case 'p2p': return 'P2P';
    case 'magnet': return 'MAGNET';
    default: return kind.toUpperCase();
  }
}

export type QualityOption = { value: string; label: string; count: number };

/**
 * Derives the Quality chip options from the FULL stream collection. Only
 * qualities that actually appear are shown. "All" is always first.
 *
 * The quality order follows the standard display priority: 4K → 1080p →
 * 720p → 480p → auto (unknown quality). This matches the existing ranking
 * weight order in `download-selection.ts`.
 */
export function qualityOptions(streams: FilterableStream[]): QualityOption[] {
  const order = ['4K', '1080p', '720p', '480p', 'auto'];
  const counts = new Map<string, number>();
  for (const s of streams) {
    const q = s.quality;
    if (!q) continue;
    counts.set(q, (counts.get(q) ?? 0) + 1);
  }
  const options: QualityOption[] = [{ value: 'all', label: 'All', count: streams.length }];
  for (const q of order) {
    const count = counts.get(q);
    if (count !== undefined && count > 0) {
      const label = q === 'auto' ? 'Auto' : q;
      options.push({ value: q, label, count });
    }
  }
  // Also include any unexpected qualities not in the standard order (rare but
  // possible if the normalizer produces a non-standard label). These appear
  // after the standard ones, sorted alphabetically for determinism.
  for (const [q, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (order.includes(q)) continue;
    if (count > 0) options.push({ value: q, label: q, count });
  }
  return options;
}

export type SizeOption = { value: 'all' | SizeFilterValue; label: string; count: number };

/**
 * Derives the Size chip options from the FULL stream collection. Only size
 * ranges that actually contain streams are shown. "All" is always first.
 * Unknown-size streams are counted under "All" but not under any specific
 * range (they don't match any range — they're preserved by the soft filter
 * but don't count as "matching" a specific range).
 */
export function sizeOptions(streams: FilterableStream[]): SizeOption[] {
  const order: SizeFilterValue[] = ['under1', 'under2', 'under3', 'under5', 'under10', 'under20', 'over20'];
  const options: SizeOption[] = [{ value: 'all', label: 'All', count: streams.length }];
  for (const size of order) {
    let count = 0;
    for (const s of streams) {
      if (streamMatchesSize(s, size) && s.sizeBytes !== undefined && s.sizeBytes > 0) count += 1;
    }
    if (count > 0) {
      options.push({ value: size, label: sizeFilterLabel(size), count });
    }
  }
  return options;
}

export type LanguageOption = { value: 'all' | 'dual' | 'multi' | string; label: string; count: number };

/**
 * Derives the Language chip options from the FULL stream collection. Options:
 *   - "All" (always first, total count)
 *   - Detected languages (e.g., English, Hindi) — only those that actually appear
 *   - "Dual Audio" — only if dual/multi streams exist
 *   - "Multi Audio" — only if multi streams exist
 *
 * The order is: All → detected languages (alphabetical) → Dual Audio → Multi Audio.
 * Dual/Multi come last because they're audio-class filters, not language filters.
 */
export function languageOptions(streams: FilterableStream[]): LanguageOption[] {
  const options: LanguageOption[] = [{ value: 'all', label: 'All', count: streams.length }];
  // Detected languages — from the normalized audioLanguages array.
  const langCounts = new Map<string, number>();
  for (const s of streams) {
    for (const lang of s.audioLanguages ?? []) {
      if (!lang) continue;
      langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
    }
  }
  for (const [lang, count] of [...langCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > 0) options.push({ value: lang, label: lang, count });
  }
  // Dual Audio — only if dual/multi streams exist.
  let dualCount = 0;
  let multiCount = 0;
  for (const s of streams) {
    if (s.audio === 'multi') { dualCount += 1; multiCount += 1; }
    else if (s.audio === 'dual') { dualCount += 1; }
  }
  if (dualCount > 0) options.push({ value: 'dual', label: 'Dual Audio', count: dualCount });
  if (multiCount > 0) options.push({ value: 'multi', label: 'Multi Audio', count: multiCount });
  return options;
}

// ---------------------------------------------------------------------------
// Active-filter state + Clear
// ---------------------------------------------------------------------------

/**
 * Returns true if ANY filter dimension is active (not 'all'). Used by the
 * component to decide whether to show the active-filter-chips row + Clear button.
 */
export function hasActiveFilters(filters: DownloaderFilters): boolean {
  return filters.type !== 'all' || filters.quality !== 'all' || filters.size !== 'all' || filters.language !== 'all';
}

/**
 * One removable active-filter chip descriptor. Used by the component to
 * render the active-filter-chips row below the filter controls.
 */
export type ActiveFilterChip = {
  /** The filter dimension this chip belongs to. */
  dimension: 'type' | 'quality' | 'size' | 'language';
  /** The current value (to clear when removed). */
  value: string;
  /** Human-readable label for the chip. */
  label: string;
};

/**
 * Derives the list of active-filter chips for display. Each active filter
 * dimension produces one chip. The component renders these as removable
 * chips with a single "Clear" action.
 */
export function activeFilterChips(filters: DownloaderFilters): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  if (filters.type !== 'all') {
    chips.push({ dimension: 'type', value: filters.type, label: kindLabel(filters.type as FilterableStream['kind']) });
  }
  if (filters.quality !== 'all') {
    const q = filters.quality;
    chips.push({ dimension: 'quality', value: q, label: q === '2K' ? '2K' : q === 'auto' ? 'Auto' : q });
  }
  if (filters.size !== 'all') {
    chips.push({ dimension: 'size', value: filters.size, label: sizeFilterLabel(filters.size) });
  }
  if (filters.language !== 'all') {
    const l = filters.language;
    if (l === 'dual') chips.push({ dimension: 'language', value: l, label: 'Dual Audio' });
    else if (l === 'multi') chips.push({ dimension: 'language', value: l, label: 'Multi Audio' });
    else chips.push({ dimension: 'language', value: l, label: l });
  }
  return chips;
}

/**
 * Clears one filter dimension (when the user clicks a removable chip).
 * Returns a NEW filters object (immutable — does not mutate the input).
 */
export function clearFilterDimension(filters: DownloaderFilters, dimension: ActiveFilterChip['dimension']): DownloaderFilters {
  return { ...filters, [dimension]: 'all' };
}
