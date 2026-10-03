/**
 * MAVERO unified Extension domain — Nuvio manifest parsing (Permanent
 * Adapter Plan Phase 2).
 *
 * Implements generic Nuvio manifest detection + provider normalization so
 * Nuvio manifests become a FIRST-CLASS Extension source in the SAME catalog
 * (System → Integrations → Extension), instead of the pre-Phase-2 behavior
 * where a Nuvio manifest URL parsed as a valid-but-EMPTY CloudStream
 * repository ("0 extensions").
 *
 * MANIFEST SCHEMA — verified live (Phase 2 audit) against three independent
 * Nuvio provider repositories (phisher98/phisher-nuvio-providers,
 * LiquidBromineOxide/All-in-One-Nuvio, Gowaru/gowaru-nuvio-providers):
 *
 *   {
 *     "name": "…",                     // repository display name
 *     "version": "1.0.0",              // manifest version (string)
 *     "scrapers": [                    // THE provider list
 *       {
 *         "id": "MoviesDrive",         // provider id (required)
 *         "name": "MoviesDrive",       // display name
 *         "description": "…",          // optional
 *         "version": "1.1.1",          // STRING version
 *         "author": "Phisher",         // STRING author (may be empty)
 *         "supportedTypes": ["movie","tv","anime"],
 *         "filename": "providers/moviesdrive.js",  // RELATIVE JS module path
 *         "enabled": true,             // SELF-REPORTED (NOT the admin switch)
 *         "formats": ["mp4","mkv"],    // optional
 *         "logo": "https://…",         // optional
 *         "contentLanguage": ["en"],   // optional
 *         "limited": true              // optional (tolerated extension)
 *       }
 *     ]
 *   }
 *
 * Detection is SCHEMA-SIGNATURE based (`scrapers` array) — never by
 * repository URL. Repositories are NOT hard-coded (any manifest speaking
 * the schema is recognized, including future variants whose extra fields
 * are captured as bounded provider metadata).
 *
 * SECURITY (mirrors the CloudStream parser posture exactly):
 *   * Pure structural validation on an ALREADY-FETCHED bounded document —
 *     the manifest itself is fetched only through the SSRF-safe
 *     fetchCloudStreamJson pipeline (URL validation, DNS + connect-time
 *     re-validation, bounded redirects, 10s/1MiB, JSON-only).
 *   * The provider JS module (`filename` → module_url) is METADATA ONLY —
 *     Mavero NEVER fetches or executes it (no eval, no new Function, no
 *     dynamic import). Same rule as CloudStream `.cs3` plugin URLs.
 *   * Every string is length-bounded; arrays are count-bounded; the
 *     provider_metadata object is size-bounded (8 KiB) and shape-bounded
 *     (plain JSON values only).
 */

import { CloudStreamRepositoryError } from '$lib/server/cloudstream/repository/errors';
import type { ExtensionMediaType } from '$lib/shared/extension-adapter-types';

// ---------------------------------------------------------------------------
// Bounds (mirror the CloudStream parser discipline — plan §40.3 style)
// ---------------------------------------------------------------------------

/** Maximum providers normalized per manifest (existing catalog cap). */
export const MAX_NUVIO_PROVIDERS_PER_MANIFEST = 500;
const REPOSITORY_NAME_MAX = 120;
const PROVIDER_ID_MAX = 200;
const PROVIDER_NAME_MAX = 200;
const PROVIDER_DESCRIPTION_MAX = 1000;
const VERSION_TEXT_MAX = 120;
const AUTHOR_MAX = 120;
const URL_MAX = 2048;
const TYPES_MAX_COUNT = 20;
const TYPE_NAME_MAX = 60;
const FORMATS_MAX_COUNT = 20;
const FORMAT_MAX_LENGTH = 40;
const LANGUAGES_MAX_COUNT = 10;
const LANGUAGE_MAX_LENGTH = 40;
const FILENAME_MAX = 512;
/** Bounded provider_metadata payload per provider (serialized). */
export const MAX_NUVIO_PROVIDER_METADATA_BYTES = 8192;

// ---------------------------------------------------------------------------
// Normalized output model
// ---------------------------------------------------------------------------

/**
 * One normalized Nuvio provider. Field names intentionally mirror
 * NormalizedCloudStreamExtension (the unified catalog insert shape) with
 * Nuvio-specific additions; the repository service maps this into the
 * extension-row write.
 */
export type NormalizedNuvioProvider = {
  /** Provider id → extension internal_name (unique per repository). */
  id: string;
  name: string | null;
  /** STRING version ('1.1.1') → version_text. */
  versionText: string | null;
  description: string | null;
  /** Single manifest author → authors[0]. */
  author: string | null;
  /** Canonical media support derived from supportedTypes. */
  mediaTypes: ExtensionMediaType[];
  /** Raw supportedTypes (pre-canonicalization, bounded). */
  rawTypes: string[];
  /** Raw manifest filename (pre-resolution, bounded). */
  filename: string | null;
  /** Resolved absolute http(s) module URL — METADATA ONLY, never fetched. */
  moduleUrl: string | null;
  /** Manifest self-reported enabled (provider metadata — NOT the DB flag). */
  manifestEnabled: boolean | null;
  formats: string[];
  contentLanguage: string[];
  limited: boolean | null;
  logoUrl: string | null;
  /** The manifest document URL this provider was discovered from. */
  manifestUrl: string;
};

/** Parsed Nuvio manifest (repository-level metadata + providers). */
export type ParsedNuvioManifest = {
  name: string;
  version: string | null;
  providers: NormalizedNuvioProvider[];
  /** Number of scraper entries skipped as malformed (diagnostics). */
  skippedEntries: number;
};

// ---------------------------------------------------------------------------
// Detection (schema signature — generic, NOT repository-hardcoded)
// ---------------------------------------------------------------------------

/**
 * Detection precedence (fixed at design time, D-P2-2):
 *   1. body is not a plain object → NOT Nuvio (caller's CloudStream parse
 *      will reject it as INVALID_REPOSITORY).
 *   2. `pluginLists` PRESENT → CloudStream document (100% unchanged
 *      behavior — Nuvio detection never wins against a CloudStream index).
 *   3. `scrapers` is an Array → Nuvio manifest.
 *   4. `scrapers` present but NOT an Array → malformed Nuvio manifest
 *      (caller surfaces INVALID_REPOSITORY — honest failure instead of a
 *      silent valid-empty repository).
 *   5. otherwise → NOT Nuvio (valid-empty CloudStream path preserved).
 *
 * Returns the detected integration type + whether the scrapers field was
 * present-but-malformed, so the caller can dispatch AND error honestly.
 */
export function detectExtensionManifestKind(
  body: unknown,
): { kind: 'cloudstream' | 'nuvio' | 'unknown'; malformedScrapers: boolean } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'unknown', malformedScrapers: false };
  }
  const doc = body as Record<string, unknown>;
  // A CloudStream index ALWAYS wins when pluginLists is present (existing
  // behavior must remain byte-identical for every CloudStream document).
  if (doc['pluginLists'] !== undefined && doc['pluginLists'] !== null) {
    return { kind: 'cloudstream', malformedScrapers: false };
  }
  if (Array.isArray(doc['scrapers'])) return { kind: 'nuvio', malformedScrapers: false };
  if (doc['scrapers'] !== undefined) return { kind: 'unknown', malformedScrapers: true };
  return { kind: 'unknown', malformedScrapers: false };
}

/**
 * Canonicalizes one raw supportedType entry to the unified media
 * vocabulary: movie → 'movie'; tv/series/anime → 'tv' (anime rides the
 * series pipeline — the CS-3 anime media-type contract); anything else →
 * null (dropped — never invent media support the manifest did not state).
 */
export function canonicalNuvioMediaType(rawType: string): ExtensionMediaType | null {
  const normalized = rawType.trim().toLowerCase();
  if (normalized === 'movie') return 'movie';
  if (normalized === 'tv' || normalized === 'series' || normalized === 'anime') return 'tv';
  return null;
}

/**
 * Canonicalizes CloudStream TvType enum NAMES to the unified media
 * vocabulary (used by both the CloudStream sync write and the live view
 * derivation, so the two can never drift): Movie → 'movie';
 * TvSeries/Anime/AsianDrama/Cartoon → 'tv'; anything else → null.
 */
export function canonicalMediaTypeFromTvType(tvType: string): ExtensionMediaType | null {
  const normalized = tvType.trim().toLowerCase();
  if (normalized === 'movie') return 'movie';
  if (normalized === 'tvseries' || normalized === 'anime' || normalized === 'asiandrama' || normalized === 'cartoon') {
    return 'tv';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bounded primitive extraction (mirror repository/parse.ts helpers)
// ---------------------------------------------------------------------------

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function boundedUrl(value: unknown): string | null {
  const bounded = boundedString(value, URL_MAX);
  if (bounded === null) return null;
  if (/\s/.test(bounded)) return null;
  try {
    const url = new URL(bounded);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return bounded;
  } catch {
    return null;
  }
}

function boundedBool(value: unknown): boolean | null {
  if (typeof value !== 'boolean') return null;
  return value;
}

function boundedStringArray(value: unknown, maxCount: number, maxItem: number): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    if (items.length >= maxCount) break;
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed && trimmed.length <= maxItem) items.push(trimmed);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Module URL resolution (metadata only — NEVER fetched)
// ---------------------------------------------------------------------------

/**
 * Resolves the manifest `filename` against the manifest URL into an
 * absolute http(s) URL. Non-http results and oversized values yield null
 * (the raw filename is still preserved in provider metadata — no
 * information is silently invented or dropped).
 */
export function resolveNuvioModuleUrl(
  filename: string | null,
  manifestUrl: string,
): string | null {
  if (filename === null || filename.length === 0) return null;
  let resolved: URL;
  try {
    resolved = new URL(filename, manifestUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  const href = resolved.href;
  if (href.length > URL_MAX) return null;
  return href;
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

/**
 * Parses a fetched Nuvio manifest body into the normalized provider model.
 *
 * Rules (the CloudStream parser contract, mirrored):
 *   * The body must be a plain object (else INVALID_REPOSITORY — the
 *     repository-level document contract).
 *   * `scrapers` must be an array (else INVALID_REPOSITORY — malformed
 *     manifest detected honestly instead of a silent empty catalog).
 *   * Entries without a non-empty `id` are SKIPPED (malformed provider
 *     entry — counted in skippedEntries, never fatal).
 *   * Duplicate provider ids inside one manifest are deduplicated
 *     case-insensitively (first occurrence wins) — same repository +
 *     same provider can never produce duplicate rows.
 *   * Providers are capped at MAX_NUVIO_PROVIDERS_PER_MANIFEST.
 *   * The manifest self-reported `enabled` NEVER maps to the DB enabled
 *     flag — it is recorded in provider metadata only (the admin switch
 *     starts false and is preserved across syncs, CS-1 convention).
 *   * No field is invented: absent manifest fields stay null/[].
 */
export function parseNuvioManifest(body: unknown, manifestUrl: string): ParsedNuvioManifest {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CloudStreamRepositoryError('INVALID_REPOSITORY', { message: 'The Nuvio manifest must be a JSON object.' });
  }
  const doc = body as Record<string, unknown>;
  const scrapers = doc['scrapers'];
  if (!Array.isArray(scrapers)) {
    throw new CloudStreamRepositoryError('INVALID_REPOSITORY', { message: 'The Nuvio manifest scrapers must be a list.' });
  }

  const name = boundedString(doc['name'], REPOSITORY_NAME_MAX) ?? 'Unnamed repository';
  const version = boundedString(doc['version'], VERSION_TEXT_MAX);

  const seen = new Set<string>();
  const providers: NormalizedNuvioProvider[] = [];
  let skippedEntries = 0;

  for (const entry of scrapers) {
    if (providers.length >= MAX_NUVIO_PROVIDERS_PER_MANIFEST) break; // bounded
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      skippedEntries += 1;
      continue; // malformed provider entry skipped
    }
    const scraper = entry as Record<string, unknown>;
    const id = boundedString(scraper['id'], PROVIDER_ID_MAX);
    if (id === null) {
      skippedEntries += 1;
      continue; // no canonical provider key → skip (mirror: no internalName)
    }
    const key = id.toLowerCase();
    if (seen.has(key)) continue; // duplicate id in one manifest → first wins
    seen.add(key);

    // Canonical media support (raw types preserved separately for fidelity).
    const rawTypes = boundedStringArray(scraper['supportedTypes'], TYPES_MAX_COUNT, TYPE_NAME_MAX);
    const mediaTypes: ExtensionMediaType[] = [];
    for (const rawType of rawTypes) {
      const canonical = canonicalNuvioMediaType(rawType);
      if (canonical !== null && !mediaTypes.includes(canonical)) mediaTypes.push(canonical);
    }

    const filename = boundedString(scraper['filename'], FILENAME_MAX);
    const manifestEnabled = boundedBool(scraper['enabled']);

    providers.push({
      id,
      name: boundedString(scraper['name'], PROVIDER_NAME_MAX),
      versionText: boundedString(scraper['version'], VERSION_TEXT_MAX),
      description: boundedString(scraper['description'], PROVIDER_DESCRIPTION_MAX),
      author: boundedString(scraper['author'], AUTHOR_MAX),
      mediaTypes,
      rawTypes,
      filename,
      moduleUrl: resolveNuvioModuleUrl(filename, manifestUrl),
      manifestEnabled,
      formats: boundedStringArray(scraper['formats'], FORMATS_MAX_COUNT, FORMAT_MAX_LENGTH),
      contentLanguage: boundedStringArray(scraper['contentLanguage'], LANGUAGES_MAX_COUNT, LANGUAGE_MAX_LENGTH),
      limited: boundedBool(scraper['limited']),
      logoUrl: boundedUrl(scraper['logo']),
      manifestUrl,
    });
  }

  return { name, version, providers, skippedEntries };
}

/**
 * Builds the bounded, extensible provider_metadata payload for one
 * normalized Nuvio provider (the schema's Nuvio-specific fields + the
 * manifest URL — the provenance record). Returns null when no metadata
 * field is present (nothing invented). The payload is guaranteed ≤
 * MAX_NUVIO_PROVIDER_METADATA_BYTES after serialization (fields are
 * dropped from the tail if a pathological entry overflows — every
 * individual field is already length-bounded, so this is a defensive
 * total-size guard, not the primary mechanism).
 */
export function buildNuvioProviderMetadata(
  provider: NormalizedNuvioProvider,
): Record<string, unknown> | null {
  const payload: Record<string, unknown> = { manifestUrl: provider.manifestUrl };
  if (provider.formats.length > 0) payload['formats'] = provider.formats;
  if (provider.contentLanguage.length > 0) payload['contentLanguage'] = provider.contentLanguage;
  if (provider.limited !== null) payload['limited'] = provider.limited;
  if (provider.manifestEnabled !== null) payload['manifestEnabled'] = provider.manifestEnabled;
  if (provider.rawTypes.length > 0) payload['types'] = provider.rawTypes;
  if (provider.filename !== null) payload['filename'] = provider.filename;
  let serialized = JSON.stringify(payload);
  if (serialized.length > MAX_NUVIO_PROVIDER_METADATA_BYTES) {
    delete payload['types'];
    delete payload['filename'];
    serialized = JSON.stringify(payload);
    if (serialized.length > MAX_NUVIO_PROVIDER_METADATA_BYTES) return null;
  }
  return Object.keys(payload).length > 0 ? payload : null;
}
