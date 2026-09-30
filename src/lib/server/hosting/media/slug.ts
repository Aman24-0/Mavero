/**
 * Phase 5 — Slug/path sanitization for folder display names.
 *
 * Canonical display names may contain slashes, colons, quotes, unicode,
 * and very long titles. This module produces safe folder display names
 * that satisfy the media_folders.name CHECK constraint (1–200 chars,
 * trimmed).
 *
 * IMPORTANT: The display title (e.g. "Movie: The Sequel / Part 2") is
 * preserved on the media_items.title column. The sanitized folder name
 * is ONLY for the media_folders.name column — it is a presentation
 * label for the folder tree, NOT the canonical identity (which uses
 * canonical_key).
 */

/** Maximum folder name length (matches DB CHECK constraint). */
const MAX_FOLDER_NAME = 180; // Conservative: leaves room within the 200-char limit.

/**
 * Sanitizes a display title into a safe folder name.
 *
 * Rules:
 *   - Trims leading/trailing whitespace.
 *   - Replaces `/` with `-` (folder-name-safe).
 *   - Replaces `:` with `-` (avoid path-separator ambiguity).
 *   - Removes leading/trailing dots (filesystem convention).
 *   - Collapses multiple spaces into one.
 *   - Truncates to MAX_FOLDER_NAME characters.
 *   - Preserves unicode characters (no transliteration).
 *   - Empty after sanitization → "Untitled".
 */
export function sanitizeFolderName(title: string | null | undefined): string {
  if (!title) return 'Untitled';
  let name = title.trim();
  if (!name) return 'Untitled';
  // Replace path-separator and colon characters.
  name = name.replace(/[/\\]/g, '-').replace(/:/g, '-');
  // Remove leading/trailing dots.
  name = name.replace(/^\.+/, '').replace(/\.+$/, '');
  // Collapse multiple whitespace.
  name = name.replace(/\s+/g, ' ').trim();
  // Truncate.
  if (name.length > MAX_FOLDER_NAME) {
    name = name.slice(0, MAX_FOLDER_NAME).trim();
  }
  return name || 'Untitled';
}

/**
 * Formats a season number as "Season 01" (zero-padded to 2 digits).
 * Season 0 is formatted as "Specials" per the canonical hierarchy.
 */
export function seasonFolderName(season: number): string {
  if (season === 0) return 'Specials';
  return `Season ${String(season).padStart(2, '0')}`;
}

/**
 * Formats an episode as "S01E01 - Episode Title" or "S01E01" when
 * no title is available.
 */
export function episodeFolderName(season: number, episode: number, episodeTitle?: string | null): string {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const base = `S${s}E${e}`;
  if (episodeTitle && episodeTitle.trim()) {
    return `${base} - ${sanitizeFolderName(episodeTitle)}`;
  }
  return base;
}
