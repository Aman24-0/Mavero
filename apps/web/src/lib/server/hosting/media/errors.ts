/**
 * Phase 5 — Canonical media/folder service domain errors.
 *
 * Typed errors for the canonical media library service. These are
 * distinct from the Phase 3 provider adapter errors (HostingProviderError)
 * because the canonical service operates on Mavero's domain model, not
 * on provider API responses.
 */

export type MediaServiceErrorCode =
  | 'INVALID_CONTENT_TYPE'
  | 'INVALID_TMDB_ID'
  | 'INVALID_IMDB_ID'
  | 'INVALID_YEAR'
  | 'INVALID_SEASON'
  | 'INVALID_EPISODE'
  | 'INVALID_TITLE'
  | 'PARENT_NOT_FOUND'
  | 'DUPLICATE_IDENTITY'
  | 'FOLDER_CREATION_FAILED'
  | 'DATABASE_ERROR';

const messages: Record<MediaServiceErrorCode, string> = {
  INVALID_CONTENT_TYPE: 'The content type is invalid. Must be movie, series, or anime.',
  INVALID_TMDB_ID: 'The TMDB ID is invalid. Must be a numeric string.',
  INVALID_IMDB_ID: 'The IMDb ID is invalid. Must match tt[0-9]{7,10}.',
  INVALID_YEAR: 'The year is invalid. Must be a four-digit year between 1880 and 3000.',
  INVALID_SEASON: 'The season number is invalid. Must be a non-negative integer (0 for specials).',
  INVALID_EPISODE: 'The episode number is invalid. Must be a positive integer (1–10000).',
  INVALID_TITLE: 'The title is invalid. Must be a non-empty string (1–300 characters).',
  PARENT_NOT_FOUND: 'The parent media item was not found.',
  DUPLICATE_IDENTITY: 'A media item with a conflicting identity already exists.',
  FOLDER_CREATION_FAILED: 'A canonical folder could not be created.',
  DATABASE_ERROR: 'A database error occurred.',
};

export class MediaServiceError extends Error {
  readonly code: MediaServiceErrorCode;

  constructor(code: MediaServiceErrorCode, message?: string) {
    super(message ?? messages[code]);
    this.name = 'MediaServiceError';
    this.code = code;
  }
}
