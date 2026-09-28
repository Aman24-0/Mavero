/**
 * Phase 5 — Canonical media/folder service.
 *
 * Provides deterministic, idempotent creation of canonical Mavero
 * media_items and media_folders. The canonical hierarchy is:
 *
 *   Movies/
 *     <Year>/
 *       <Movie>/
 *
 *   Series/
 *     <Series>/
 *       Season 01/
 *         S01E01 - Episode Title
 *
 *   Anime/
 *     <Anime>/
 *       Season 01/
 *         S01E01 - Episode Title
 *
 * All `ensure*` operations use Supabase's `.upsert()` with
 * `onConflict: 'canonical_key'` for idempotency. Repeated calls
 * with the same canonical identity return the same row (same UUID).
 *
 * The service accepts a `SupabaseClient<Database>` as a parameter
 * (same pattern as streaming/admin-service.ts). The client MUST have
 * service-role access (the hosting tables are admin-only via RLS).
 *
 * Provider folder mapping is NOT implemented here — it belongs to
 * a later phase. The canonical hierarchy is independent of provider
 * folder limitations (e.g. Vidara's flat folders).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { MediaServiceError } from './errors';
import {
  movieCanonicalKey,
  seriesCanonicalKey,
  episodeCanonicalKey,
  rootMoviesKey,
  rootSeriesKey,
  rootAnimeKey,
  movieYearFolderKey,
  movieFolderKey,
  seriesFolderKey,
  seasonFolderKey,
  episodeFolderKey,
  animeFolderKey,
  animeSeasonFolderKey,
  animeEpisodeFolderKey,
} from './canonical-key';
import { sanitizeFolderName, seasonFolderName, episodeFolderName } from './slug';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for creating/ensuring a movie media item. */
export type EnsureMovieInput = {
  tmdbId: string;
  imdbId?: string | null;
  title: string;
  year?: number | null;
};

/** Input for creating/ensuring a series media item. */
export type EnsureSeriesInput = {
  tmdbId: string;
  imdbId?: string | null;
  title: string;
  year?: number | null;
};

/** Input for creating/ensuring an episode media item. */
export type EnsureEpisodeInput = {
  /** The parent series TMDB ID. */
  seriesTmdbId: string;
  season: number;
  episode: number;
  episodeTitle?: string | null;
  /** Optional override of the series title (for canonical_key generation). */
  seriesTitle?: string | null;
};

/** Input for creating/ensuring an anime media item (treated as a series). */
export type EnsureAnimeInput = EnsureSeriesInput;

/** Input for creating/ensuring an anime episode. */
export type EnsureAnimeEpisodeInput = EnsureEpisodeInput;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateTmdbId(tmdbId: string): void {
  if (!tmdbId || !/^[0-9]{1,20}$/.test(tmdbId)) {
    throw new MediaServiceError('INVALID_TMDB_ID');
  }
}

function validateImdbId(imdbId: string | null | undefined): void {
  if (imdbId && !/^tt[0-9]{7,10}$/.test(imdbId)) {
    throw new MediaServiceError('INVALID_IMDB_ID');
  }
}

function validateTitle(title: string): void {
  if (!title || !title.trim() || title.length > 300) {
    throw new MediaServiceError('INVALID_TITLE');
  }
}

function validateYear(year: number | null | undefined): void {
  if (year != null && (!Number.isInteger(year) || year < 1880 || year > 3000)) {
    throw new MediaServiceError('INVALID_YEAR');
  }
}

function validateSeason(season: number): void {
  if (!Number.isInteger(season) || season < 0 || season > 1000) {
    throw new MediaServiceError('INVALID_SEASON');
  }
}

function validateEpisode(episode: number): void {
  if (!Number.isInteger(episode) || episode < 1 || episode > 10000) {
    throw new MediaServiceError('INVALID_EPISODE');
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CanonicalMediaService {
  constructor(private client: SupabaseClient<Database>) {}

  // --- Root folder ensure ---

  async ensureRootFolder(kind: 'movies' | 'series' | 'anime'): Promise<{ id: string; canonical_key: string; name: string }> {
    const key = kind === 'movies' ? rootMoviesKey() : kind === 'series' ? rootSeriesKey() : rootAnimeKey();
    const name = kind === 'movies' ? 'Movies' : kind === 'series' ? 'Series' : 'Anime';
    return this.upsertFolder({
      canonical_key: key,
      kind: 'root',
      name,
      parent_id: null,
      content_type: null,
      tmdb_id: null,
      year: null,
      season: null,
      media_item_id: null,
      sort_order: 0,
    });
  }

  // --- Movie ensure ---

  async ensureMovie(input: EnsureMovieInput): Promise<{ mediaItemId: string; folderId: string }> {
    validateTmdbId(input.tmdbId);
    validateImdbId(input.imdbId);
    validateTitle(input.title);
    validateYear(input.year);

    const canonicalKey = movieCanonicalKey(input.tmdbId);

    // 1. Ensure the media_items row.
    const mediaItem = await this.upsertMediaItem({
      canonical_key: canonicalKey,
      content_type: 'movie',
      tmdb_id: input.tmdbId,
      imdb_id: input.imdbId ?? null,
      title: input.title.trim(),
      year: input.year ?? null,
      season: null,
      episode: null,
      episode_title: null,
      parent_media_id: null,
    });

    // 2. Ensure the root Movies folder.
    const root = await this.ensureRootFolder('movies');

    // 3. Ensure the year folder (under Movies root).
    const year = input.year ?? 0; // 0 = unknown year fallback.
    const yearKey = movieYearFolderKey(year);
    const yearName = year > 0 ? String(year) : 'Unknown Year';
    const yearFolder = await this.upsertFolder({
      canonical_key: yearKey,
      kind: 'year',
      name: yearName,
      parent_id: root.id,
      content_type: null,
      tmdb_id: null,
      year: year > 0 ? year : null,
      season: null,
      media_item_id: null,
      sort_order: year,
    });

    // 4. Ensure the movie folder (under the year folder).
    const folderKey = movieFolderKey(year, input.tmdbId);
    const movieFolder = await this.upsertFolder({
      canonical_key: folderKey,
      kind: 'movie',
      name: sanitizeFolderName(input.title),
      parent_id: yearFolder.id,
      content_type: 'movie',
      tmdb_id: input.tmdbId,
      year: year > 0 ? year : null,
      season: null,
      media_item_id: mediaItem.id,
      sort_order: 0,
    });

    return { mediaItemId: mediaItem.id, folderId: movieFolder.id };
  }

  // --- Series ensure ---

  async ensureSeries(input: EnsureSeriesInput): Promise<{ mediaItemId: string; folderId: string }> {
    validateTmdbId(input.tmdbId);
    validateImdbId(input.imdbId);
    validateTitle(input.title);
    validateYear(input.year);

    const canonicalKey = seriesCanonicalKey(input.tmdbId);

    const mediaItem = await this.upsertMediaItem({
      canonical_key: canonicalKey,
      content_type: 'series',
      tmdb_id: input.tmdbId,
      imdb_id: input.imdbId ?? null,
      title: input.title.trim(),
      year: input.year ?? null,
      season: null,
      episode: null,
      episode_title: null,
      parent_media_id: null,
    });

    const root = await this.ensureRootFolder('series');

    const folderKey = seriesFolderKey(input.tmdbId);
    const seriesFolder = await this.upsertFolder({
      canonical_key: folderKey,
      kind: 'series',
      name: sanitizeFolderName(input.title),
      parent_id: root.id,
      content_type: 'series',
      tmdb_id: input.tmdbId,
      year: input.year ?? null,
      season: null,
      media_item_id: mediaItem.id,
      sort_order: 0,
    });

    return { mediaItemId: mediaItem.id, folderId: seriesFolder.id };
  }

  // --- Episode ensure ---

  async ensureEpisode(input: EnsureEpisodeInput): Promise<{ mediaItemId: string; folderId: string }> {
    validateTmdbId(input.seriesTmdbId);
    validateSeason(input.season);
    validateEpisode(input.episode);

    const parentCanonicalKey = seriesCanonicalKey(input.seriesTmdbId);

    // 1. Ensure the parent series media item exists.
    let parent = await this.getMediaItemByKey(parentCanonicalKey);
    if (!parent) {
      throw new MediaServiceError('PARENT_NOT_FOUND', `Parent series not found for TMDB ID ${input.seriesTmdbId}. Call ensureSeries first.`);
    }

    // 2. Ensure the episode media item.
    const epKey = episodeCanonicalKey(input.seriesTmdbId, input.season, input.episode);
    const episodeItem = await this.upsertMediaItem({
      canonical_key: epKey,
      content_type: 'series',
      tmdb_id: input.seriesTmdbId,
      imdb_id: null,
      title: parent.title,
      year: parent.year,
      season: input.season,
      episode: input.episode,
      episode_title: input.episodeTitle ?? null,
      parent_media_id: parent.id,
    });

    // 3. Ensure the series folder + season folder.
    const seriesFolderK = seriesFolderKey(input.seriesTmdbId);
    const seriesFolder = await this.getFolderByKey(seriesFolderK);
    if (!seriesFolder) {
      throw new MediaServiceError('FOLDER_CREATION_FAILED', `Series folder not found for TMDB ID ${input.seriesTmdbId}. Call ensureSeries first.`);
    }

    const seasonKey = seasonFolderKey(input.seriesTmdbId, input.season);
    const seasonFolder = await this.upsertFolder({
      canonical_key: seasonKey,
      kind: 'season',
      name: seasonFolderName(input.season),
      parent_id: seriesFolder.id,
      content_type: 'series',
      tmdb_id: input.seriesTmdbId,
      year: null,
      season: input.season,
      media_item_id: null,
      sort_order: input.season,
    });

    // 4. Ensure the episode folder.
    const epFolderKey = episodeFolderKey(input.seriesTmdbId, input.season, input.episode);
    const epFolder = await this.upsertFolder({
      canonical_key: epFolderKey,
      kind: 'episode',
      name: episodeFolderName(input.season, input.episode, input.episodeTitle),
      parent_id: seasonFolder.id,
      content_type: 'series',
      tmdb_id: input.seriesTmdbId,
      year: null,
      season: input.season,
      media_item_id: episodeItem.id,
      sort_order: input.episode,
    });

    return { mediaItemId: episodeItem.id, folderId: epFolder.id };
  }

  // --- Anime ensure (treated as series under the Anime root) ---

  async ensureAnime(input: EnsureAnimeInput): Promise<{ mediaItemId: string; folderId: string }> {
    validateTmdbId(input.tmdbId);
    validateImdbId(input.imdbId);
    validateTitle(input.title);
    validateYear(input.year);

    // Anime media items use content_type='anime' and the same canonical_key
    // format as series (the canonical_key doesn't distinguish anime from
    // series — the content_type column does).
    const itemKey = seriesCanonicalKey(input.tmdbId);

    const mediaItem = await this.upsertMediaItem({
      canonical_key: itemKey,
      content_type: 'anime',
      tmdb_id: input.tmdbId,
      imdb_id: input.imdbId ?? null,
      title: input.title.trim(),
      year: input.year ?? null,
      season: null,
      episode: null,
      episode_title: null,
      parent_media_id: null,
    });

    const root = await this.ensureRootFolder('anime');

    const folderKey = animeFolderKey(input.tmdbId);
    const animeFolder = await this.upsertFolder({
      canonical_key: folderKey,
      kind: 'series',
      name: sanitizeFolderName(input.title),
      parent_id: root.id,
      content_type: 'anime',
      tmdb_id: input.tmdbId,
      year: input.year ?? null,
      season: null,
      media_item_id: mediaItem.id,
      sort_order: 0,
    });

    return { mediaItemId: mediaItem.id, folderId: animeFolder.id };
  }

  // --- Anime episode ensure ---

  async ensureAnimeEpisode(input: EnsureAnimeEpisodeInput): Promise<{ mediaItemId: string; folderId: string }> {
    validateTmdbId(input.seriesTmdbId);
    validateSeason(input.season);
    validateEpisode(input.episode);

    const parentKey = seriesCanonicalKey(input.seriesTmdbId);
    let parent = await this.getMediaItemByKey(parentKey);
    if (!parent) {
      throw new MediaServiceError('PARENT_NOT_FOUND', `Parent anime not found for TMDB ID ${input.seriesTmdbId}. Call ensureAnime first.`);
    }

    const epKey = episodeCanonicalKey(input.seriesTmdbId, input.season, input.episode);
    const episodeItem = await this.upsertMediaItem({
      canonical_key: epKey,
      content_type: 'anime',
      tmdb_id: input.seriesTmdbId,
      imdb_id: null,
      title: parent.title,
      year: parent.year,
      season: input.season,
      episode: input.episode,
      episode_title: input.episodeTitle ?? null,
      parent_media_id: parent.id,
    });

    const animeFolderK = animeFolderKey(input.seriesTmdbId);
    const animeFolder = await this.getFolderByKey(animeFolderK);
    if (!animeFolder) {
      throw new MediaServiceError('FOLDER_CREATION_FAILED', `Anime folder not found for TMDB ID ${input.seriesTmdbId}. Call ensureAnime first.`);
    }

    const seasonKey = animeSeasonFolderKey(input.seriesTmdbId, input.season);
    const seasonFolder = await this.upsertFolder({
      canonical_key: seasonKey,
      kind: 'season',
      name: seasonFolderName(input.season),
      parent_id: animeFolder.id,
      content_type: 'anime',
      tmdb_id: input.seriesTmdbId,
      year: null,
      season: input.season,
      media_item_id: null,
      sort_order: input.season,
    });

    const epFolderKey = animeEpisodeFolderKey(input.seriesTmdbId, input.season, input.episode);
    const epFolder = await this.upsertFolder({
      canonical_key: epFolderKey,
      kind: 'episode',
      name: episodeFolderName(input.season, input.episode, input.episodeTitle),
      parent_id: seasonFolder.id,
      content_type: 'anime',
      tmdb_id: input.seriesTmdbId,
      year: null,
      season: input.season,
      media_item_id: episodeItem.id,
      sort_order: input.episode,
    });

    return { mediaItemId: episodeItem.id, folderId: epFolder.id };
  }

  // --- Lookup helpers ---

  async getMediaItemByKey(canonicalKey: string): Promise<{ id: string; title: string; year: number | null } | null> {
    const { data, error } = await this.client
      .from('media_items')
      .select('id, title, year')
      .eq('canonical_key', canonicalKey)
      .maybeSingle();
    if (error) throw new MediaServiceError('DATABASE_ERROR', error.message);
    return data;
  }

  async getFolderByKey(canonicalKey: string): Promise<{ id: string; name: string; parent_id: string | null } | null> {
    const { data, error } = await this.client
      .from('media_folders')
      .select('id, name, parent_id')
      .eq('canonical_key', canonicalKey)
      .maybeSingle();
    if (error) throw new MediaServiceError('DATABASE_ERROR', error.message);
    return data;
  }

  async getMediaItemByTmdb(tmdbId: string, contentType: 'movie' | 'series' | 'anime'): Promise<{ id: string; canonical_key: string } | null> {
    const { data, error } = await this.client
      .from('media_items')
      .select('id, canonical_key')
      .eq('tmdb_id', tmdbId)
      .eq('content_type', contentType)
      .is('season', null)
      .is('episode', null)
      .maybeSingle();
    if (error) throw new MediaServiceError('DATABASE_ERROR', error.message);
    return data;
  }

  // --- Internal upsert helpers ---

  private async upsertMediaItem(row: Database['public']['Tables']['media_items']['Insert']): Promise<{ id: string }> {
    const { data, error } = await this.client
      .from('media_items')
      .upsert(row, { onConflict: 'canonical_key' })
      .select('id')
      .single();
    if (error || !data) {
      throw new MediaServiceError('DATABASE_ERROR', error?.message ?? 'Failed to upsert media item.');
    }
    return data;
  }

  private async upsertFolder(row: Database['public']['Tables']['media_folders']['Insert']): Promise<{ id: string; canonical_key: string; name: string }> {
    const { data, error } = await this.client
      .from('media_folders')
      .upsert(row, { onConflict: 'canonical_key' })
      .select('id, canonical_key, name')
      .single();
    if (error || !data) {
      throw new MediaServiceError('FOLDER_CREATION_FAILED', error?.message ?? 'Failed to upsert folder.');
    }
    return data;
  }
}
