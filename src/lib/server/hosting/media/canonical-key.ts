/**
 * Phase 5 — Canonical key generation utilities.
 *
 * Generates deterministic canonical_key values for media_items and
 * media_folders. These keys are the primary lookup mechanism for
 * idempotent creation — repeated calls with the same identity MUST
 * produce the same key.
 *
 * Key formats:
 *
 * media_items.canonical_key:
 *   movie:tmdb:<tmdb_id>
 *   series:tmdb:<tmdb_id>
 *   series:tmdb:<tmdb_id>:s<season>:e<episode>
 *
 * media_folders.canonical_key:
 *   root:movies
 *   root:series
 *   root:anime
 *   movies:<year>
 *   movies:<year>:tmdb-<tmdb_id>
 *   series:tmdb-<tmdb_id>
 *   series:tmdb-<tmdb_id>:season-<NN>
 *   series:tmdb-<tmdb_id>:season-<NN>:episode-<NN>
 *   anime:tmdb-<tmdb_id>
 *   anime:tmdb-<tmdb_id>:season-<NN>
 *   anime:tmdb-<tmdb_id>:season-<NN>:episode-<NN>
 */

// ---------------------------------------------------------------------------
// media_items canonical keys
// ---------------------------------------------------------------------------

export function movieCanonicalKey(tmdbId: string): string {
  return `movie:tmdb:${tmdbId}`;
}

export function seriesCanonicalKey(tmdbId: string): string {
  return `series:tmdb:${tmdbId}`;
}

export function episodeCanonicalKey(tmdbId: string, season: number, episode: number): string {
  return `series:tmdb:${tmdbId}:s${season}:e${episode}`;
}

// ---------------------------------------------------------------------------
// media_folders canonical keys — root folders
// ---------------------------------------------------------------------------

export function rootMoviesKey(): string {
  return 'root:movies';
}

export function rootSeriesKey(): string {
  return 'root:series';
}

export function rootAnimeKey(): string {
  return 'root:anime';
}

// ---------------------------------------------------------------------------
// media_folders canonical keys — movie hierarchy
// ---------------------------------------------------------------------------

export function movieYearFolderKey(year: number): string {
  return `movies:${year}`;
}

export function movieFolderKey(year: number, tmdbId: string): string {
  return `movies:${year}:tmdb-${tmdbId}`;
}

// ---------------------------------------------------------------------------
// media_folders canonical keys — series hierarchy
// ---------------------------------------------------------------------------

export function seriesFolderKey(tmdbId: string): string {
  return `series:tmdb-${tmdbId}`;
}

export function seasonFolderKey(tmdbId: string, season: number): string {
  const s = String(season).padStart(2, '0');
  return `series:tmdb-${tmdbId}:season-${s}`;
}

export function episodeFolderKey(tmdbId: string, season: number, episode: number): string {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  return `series:tmdb-${tmdbId}:season-${s}:episode-${e}`;
}

// ---------------------------------------------------------------------------
// media_folders canonical keys — anime hierarchy
// ---------------------------------------------------------------------------

export function animeFolderKey(tmdbId: string): string {
  return `anime:tmdb-${tmdbId}`;
}

export function animeSeasonFolderKey(tmdbId: string, season: number): string {
  const s = String(season).padStart(2, '0');
  return `anime:tmdb-${tmdbId}:season-${s}`;
}

export function animeEpisodeFolderKey(tmdbId: string, season: number, episode: number): string {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  return `anime:tmdb-${tmdbId}:season-${s}:episode-${e}`;
}
