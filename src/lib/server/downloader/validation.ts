// MAVERO downloader registry validation.
//
// Validates admin form submissions for download_providers. Mirrors the
// streaming registry's validation contract (StreamingValidationError +
// FormData parsers) but lives completely separately so the two registries
// can evolve without coupling.
//
// Enforced at the application layer (in addition to the DB CHECKs):
//   - name: required, 1-120 chars
//   - slug: required, lowercase-kebab-case, unique (DB-enforced)
//   - description, icon: optional short text
//   - enabled, is_default: booleans
//   - ordering: non-negative integer
//   - supports_movie, supports_tv: booleans
//   - movie_url_template, tv_url_template: optional, HTTPS-only, single-line,
//     only the known placeholders from DOWNLOAD_PLACEHOLDERS
//
// HTTPS enforcement + placeholder allowlist is duplicated here so an invalid
// submission is rejected with a friendly message BEFORE hitting Postgres
// (which would otherwise return a generic 23514 violation). The DB CHECKs
// remain as defense-in-depth.

import { DOWNLOAD_PLACEHOLDERS } from '$lib/shared/downloader';

export class DownloaderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloaderValidationError';
  }
}

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function text(value: FormDataEntryValue | null, label: string, maxLength: number): string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new DownloaderValidationError(`${label} must be ${maxLength} characters or fewer.`);
  return normalized;
}

function requiredText(value: FormDataEntryValue | null, label: string, maxLength: number): string {
  const normalized = text(value, label, maxLength);
  if (!normalized) throw new DownloaderValidationError(`${label} is required.`);
  return normalized;
}

function booleanValue(value: FormDataEntryValue | null, fallback = false): boolean {
  if (value === null) return fallback;
  return value === 'on' || value === 'true' || value === '1';
}

function nonNegativeInteger(value: FormDataEntryValue | null, label: string, fallback = 0): number {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new DownloaderValidationError(`${label} must be a non-negative integer.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new DownloaderValidationError(`${label} is invalid.`);
  return parsed;
}

export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

export function validateSlug(value: string, label = 'Slug'): string {
  const slug = normalizeSlug(value);
  if (!slugPattern.test(slug)) throw new DownloaderValidationError(`${label} must use lowercase letters, numbers, and single hyphens only.`);
  return slug;
}

/**
 * Validate a single URL template.
 *
 * Rules:
 *   - Optional (may be null/empty).
 *   - Must be a single line (no \r or \n).
 *   - Must start with "https://" (case-insensitive) followed by at least one
 *     alphanumeric character (so "https://" alone is rejected).
 *   - If it contains a "{", every "{...}" group must be one of the known
 *     placeholders. Any "{...}" group whose content is not a known
 *     placeholder is rejected.
 *   - No "javascript:" or "data:" scheme may appear anywhere (defense in
 *     depth; the HTTPS prefix check already blocks these at the start).
 */
function urlTemplate(value: FormDataEntryValue | null, label: string): string | null {
  const normalized = text(value, label, 500);
  if (!normalized) return null;
  if (/[\r\n]/.test(normalized)) throw new DownloaderValidationError(`${label} must be a single line.`);
  if (!/^https:\/\/[a-z0-9]/i.test(normalized)) throw new DownloaderValidationError(`${label} must be an HTTPS URL starting with https://`);
  // Reject dangerous schemes anywhere in the string (defensive; the HTTPS
  // prefix already prevents them at position 0, but a misplaced "javascript:"
  // inside a query value is still suspicious).
  if (/\b(javascript|data|file|vbscript):/i.test(normalized)) throw new DownloaderValidationError(`${label} must not contain a javascript/data/file/vbscript scheme.`);
  // Validate every "{...}" group is a known placeholder.
  const placeholderRegex = /\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  const known = new Set<string>(DOWNLOAD_PLACEHOLDERS.map((p) => p.slice(1, -1)));
  while ((match = placeholderRegex.exec(normalized)) !== null) {
    const inner = match[1];
    if (!known.has(inner)) {
      throw new DownloaderValidationError(`${label} contains an unknown placeholder "{${inner}}". Allowed: ${[...known].map((k) => `{${k}}`).join(', ')}.`);
    }
  }
  return normalized;
}

/**
 * Parse the create/update form for a download provider.
 *
 * Returns a normalized object suitable for insert/update — the caller decides
 * whether to pass it directly to Supabase (insert) or strip the id first
 * (update).
 */
export function parseDownloadProviderForm(form: FormData) {
  const supportsMovie = booleanValue(form.get('supports_movie'), true);
  const supportsTv = booleanValue(form.get('supports_tv'), true);
  if (!supportsMovie && !supportsTv) {
    throw new DownloaderValidationError('A downloader must support at least one of movie or TV.');
  }
  const movieUrlTemplate = urlTemplate(form.get('movie_url_template'), 'Movie URL template');
  const tvUrlTemplate = urlTemplate(form.get('tv_url_template'), 'TV URL template');
  if (supportsMovie && !movieUrlTemplate) {
    throw new DownloaderValidationError('Movie URL template is required when movie support is enabled.');
  }
  if (supportsTv && !tvUrlTemplate) {
    throw new DownloaderValidationError('TV URL template is required when TV support is enabled.');
  }
  return {
    name: requiredText(form.get('name'), 'Provider name', 120),
    slug: validateSlug(requiredText(form.get('slug'), 'Provider slug', 120), 'Provider slug'),
    description: text(form.get('description'), 'Description', 500),
    icon: text(form.get('icon'), 'Icon', 120),
    enabled: booleanValue(form.get('enabled')),
    is_default: booleanValue(form.get('is_default')),
    ordering: nonNegativeInteger(form.get('ordering'), 'Ordering'),
    supports_movie: supportsMovie,
    supports_tv: supportsTv,
    movie_url_template: movieUrlTemplate,
    tv_url_template: tvUrlTemplate,
  };
}

/**
 * Parse just an id from a form. Mirrors streaming's parseId for consistency.
 */
export function parseId(form: FormData, label: string): string {
  const id = requiredText(form.get('id'), label, 80);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DownloaderValidationError(`${label} is invalid.`);
  return id;
}
