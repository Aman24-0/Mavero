/**
 * MAVERO CloudStream repository manager — document parsing & normalization
 * (CS-1).
 *
 * Implements the parser contract (plan §40.3, corrected by AC-002 after
 * live verification against a real CloudStream repository):
 *
 *   CS.json (repository index)
 *     ↓ pluginLists  (CANONICAL: array of ABSOLUTE http(s) URL STRINGS;
 *     ↓              tolerated: { plugins: string } object entries)
 *   plugins.json (JSON array)
 *     ↓ entries (internalName, name, version, tvTypes as TvType enum
 *     ↓          NAMES, url (.cs3 artifact — metadata ONLY), …)
 *   normalized extension metadata
 *
 * Rules (plan §40.3):
 *   * Missing `pluginLists` → repository is parsed but yields ZERO
 *     extensions (NOT an error).
 *   * Each plugin-list URL must be an absolute http(s) URL; relative URLs are
 *     rejected as invalid.
 *   * Max 4 plugin lists per repository (bounded — surplus lists are
 *     ignored, not fatal).
 *   * Max 500 normalized extension records per repository.
 *   * Plugin-list documents must be a JSON array.
 *   * Entries without `internalName` are skipped (malformed).
 *   * Every string is length-bounded.
 *   * The `.cs3` artifact URL (`url`, tolerated `file`) is normalized as
 *     METADATA ONLY — Mavero NEVER downloads or executes it.
 *
 * SECURITY: all parsing is pure `JSON.parse`-style structural validation on
 * already-fetched bounded documents. No `eval`, no dynamic code, no template
 * interpolation of remote data. Untrusted metadata is never treated as
 * executable configuration.
 */

import { CloudStreamRepositoryError } from './errors';
import { canonicalMediaTypeFromTvType } from '$lib/server/extensions/nuvio';
import type {
  CloudStreamPluginListEntry,
  NormalizedCloudStreamExtension,
  ParsedCloudStreamRepository,
} from '../types';

// ---------------------------------------------------------------------------
// Bounds (plan §40.3)
// ---------------------------------------------------------------------------

export const MAX_PLUGIN_LISTS = 4;
export const MAX_EXTENSIONS_PER_REPOSITORY = 500;

const REPOSITORY_NAME_MAX = 120;
const REPOSITORY_DESCRIPTION_MAX = 1000;
const URL_MAX = 2048;
const INTERNAL_NAME_MAX = 200;
const EXTENSION_NAME_MAX = 200;
const EXTENSION_DESCRIPTION_MAX = 1000;
const LANGUAGE_MAX = 40;
const AUTHORS_MAX_COUNT = 20;
const AUTHOR_MAX_LENGTH = 120;
const TV_TYPES_MAX_COUNT = 20;
const TV_TYPE_NAME_MAX = 60;
const FILE_HASH_MAX = 200;
const ADAPTER_ID_MAX = 200;
const ADAPTER_VERSION_MAX = 120;

/**
 * Best-effort ordinal map for the tolerated numeric tvTypes form. Canonical
 * repositories use TvType enum NAMES (strings) — numbers are a legacy
 * tolerance and are normalized to their enum names here (AC-002).
 */
const TV_TYPE_BY_ORDINAL: Record<number, string> = {
  0: 'Movie',
  1: 'Anime',
  2: 'Cartoon',
  3: 'AsianDrama',
  4: 'Novel',
  5: 'TvSeries',
  6: 'Torrent',
  7: 'Documentaries',
  8: 'Others',
  9: 'AudioBook',
  10: 'Live',
  11: 'NSFW',
};

// ---------------------------------------------------------------------------
// URL validation (cheap lexical gate — the deep SSRF/DNS/redirect
// validation happens inside fetchStremioManifest before any connect)
// ---------------------------------------------------------------------------

/**
 * Validates a CloudStream repository URL lexically: absolute http(s), no
 * credentials, no whitespace, <= 2048 chars. Returns the trimmed URL.
 * Mirrors the first-stage guard of `assertSafeManifestUrl` with
 * CloudStream-specific safe messages.
 */
export function validateRepositoryUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new CloudStreamRepositoryError('INVALID_URL', { message: 'A CloudStream repository URL is required.' });
  const trimmed = raw.trim();
  if (!trimmed) throw new CloudStreamRepositoryError('INVALID_URL', { message: 'A CloudStream repository URL is required.' });
  if (trimmed.length > URL_MAX) throw new CloudStreamRepositoryError('INVALID_URL', { message: `The CloudStream repository URL must be ${URL_MAX} characters or fewer.` });
  if (/\s/.test(trimmed)) throw new CloudStreamRepositoryError('INVALID_URL', { message: 'The CloudStream repository URL must not contain whitespace or newlines.' });
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CloudStreamRepositoryError('INVALID_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CloudStreamRepositoryError('INVALID_URL', { message: 'The CloudStream repository URL must use http or https.' });
  if (url.username || url.password) throw new CloudStreamRepositoryError('INVALID_URL', { message: 'The CloudStream repository URL must not contain credentials.' });
  if (!url.hostname) throw new CloudStreamRepositoryError('INVALID_URL', { message: 'The CloudStream repository URL must include a hostname.' });
  return trimmed;
}

/**
 * Canonical identity for duplicate-repository detection (mirrors
 * `canonicalManifestUrlKey`): scheme + lowercased host + default-port
 * stripping + trailing-slash-collapsed path + query. Purely lexical.
 */
export function canonicalRepositoryUrlKey(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    let path = parsed.pathname.replace(/\/+$/, '');
    if (!path) path = '/';
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  } catch {
    return rawUrl;
  }
}

// ---------------------------------------------------------------------------
// CS.json parsing
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

/**
 * Parses a fetched CS.json document body into the normalized repository
 * model. The body must already be the output of the SSRF-safe fetcher.
 *
 * Missing `pluginLists` → valid repository with zero plugin lists.
 * Structurally invalid index (non-object, pluginLists non-array, relative or
 * malformed plugin-list URLs) → INVALID_REPOSITORY.
 *
 * AC-002: pluginLists entries are CANONICALLY plain URL strings; the legacy
 * `{ plugins: string }` object form is tolerated.
 */
export function parseRepositoryIndex(body: unknown): ParsedCloudStreamRepository {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CloudStreamRepositoryError('INVALID_REPOSITORY');
  }
  const doc = body as Record<string, unknown>;

  const name = boundedString(doc['name'], REPOSITORY_NAME_MAX);
  const description = boundedString(doc['description'], REPOSITORY_DESCRIPTION_MAX);
  // Canonical icon field is `iconUrl` (AC-002); `icon` is a tolerated alias.
  const iconUrl = boundedUrl(doc['iconUrl']) ?? boundedUrl(doc['icon']);

  const rawLists = doc['pluginLists'];
  // Missing pluginLists → valid repository with ZERO extensions (plan §40.3).
  // (Phase 2 note: the repository service dispatcher detects the Nuvio
  // `scrapers` signature BEFORE this parser runs, so this branch only ever
  // sees genuine CloudStream-shaped documents.)
  if (rawLists === undefined || rawLists === null) {
    return { name: name ?? 'Unnamed repository', description, iconUrl, integrationType: 'cloudstream', pluginLists: [] };
  }
  if (!Array.isArray(rawLists)) {
    throw new CloudStreamRepositoryError('INVALID_REPOSITORY', { message: 'The CloudStream repository pluginLists must be a list.' });
  }

  const pluginLists: Array<{ name: string | null; url: string }> = [];
  for (const entry of rawLists) {
    if (pluginLists.length >= MAX_PLUGIN_LISTS) break; // bounded — surplus ignored
    let pluginsUrl: string | null = null;
    if (typeof entry === 'string') {
      // CANONICAL real-world form: a plain plugin-list URL string (AC-002).
      pluginsUrl = entry.trim();
      if (!pluginsUrl) continue; // empty string entry skipped
    } else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      // Tolerated legacy form: { plugins: string } (pre-AC-002 assumption).
      const listEntry = entry as Record<string, unknown>;
      if (typeof listEntry['plugins'] === 'string' && listEntry['plugins'].trim()) {
        pluginsUrl = listEntry['plugins'].trim();
      }
    }
    if (pluginsUrl === null) continue; // malformed entry skipped
    // ABSOLUTE http(s) URL required — relative plugin-list URLs are invalid.
    let url: URL;
    try {
      url = new URL(pluginsUrl);
    } catch {
      throw new CloudStreamRepositoryError('INVALID_REPOSITORY', { message: 'Every plugin list URL must be an absolute URL.' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new CloudStreamRepositoryError('INVALID_REPOSITORY', { message: 'Every plugin list URL must use http or https.' });
    }
    pluginLists.push({ name: null, url: pluginsUrl });
  }

  return { name: name ?? 'Unnamed repository', description, iconUrl, integrationType: 'cloudstream', pluginLists };
}

// ---------------------------------------------------------------------------
// plugins.json parsing
// ---------------------------------------------------------------------------

function boundedAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const authors: string[] = [];
  for (const item of value) {
    if (authors.length >= AUTHORS_MAX_COUNT) break;
    const author = boundedString(item, AUTHOR_MAX_LENGTH);
    if (author !== null) authors.push(author);
  }
  return authors;
}

function boundedTvTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tvTypes: string[] = [];
  for (const item of value) {
    if (tvTypes.length >= TV_TYPES_MAX_COUNT) break;
    if (typeof item === 'string') {
      // CANONICAL real-world form: CloudStream TvType enum names (AC-002).
      const trimmed = item.trim();
      if (trimmed && trimmed.length <= TV_TYPE_NAME_MAX) tvTypes.push(trimmed);
    } else if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) {
      // Tolerated legacy form: numeric ids normalized to enum names.
      tvTypes.push(TV_TYPE_BY_ORDINAL[item] ?? `Type${item}`);
    }
    // Booleans / other shapes are dropped.
  }
  return tvTypes;
}

function boundedInt(value: unknown): number | null {
  // Booleans are NOT numbers (Number(true) would coerce to 1).
  if (typeof value === 'boolean') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function boundedPluginStatus(value: unknown): number | null {
  const parsed = boundedInt(value);
  if (parsed === null) return null;
  if (parsed < 1 || parsed > 3) return null;
  return parsed;
}

/**
 * Parses a fetched plugins.json document body (must be a JSON array) into
 * normalized extension metadata. Entries without `internalName` are skipped;
 * all fields are sanitized/bounded. Output is deduplicated by `internalName`
 * (first occurrence wins) and capped at MAX_EXTENSIONS_PER_REPOSITORY.
 */
export function parsePluginList(body: unknown): NormalizedCloudStreamExtension[] {
  if (!Array.isArray(body)) {
    throw new CloudStreamRepositoryError('PLUGIN_LIST_INVALID', { message: 'The plugin list document must be a JSON array.' });
  }
  const seen = new Set<string>();
  const normalized: NormalizedCloudStreamExtension[] = [];
  for (const entry of body) {
    if (normalized.length >= MAX_EXTENSIONS_PER_REPOSITORY) break; // bounded
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue; // malformed entry skipped
    const plugin = entry as Record<string, unknown>;
    const internalName = boundedString(plugin['internalName'], INTERNAL_NAME_MAX);
    if (internalName === null) continue; // no canonical key → skip (plan §40.3)
    const key = internalName.toLowerCase();
    if (seen.has(key)) continue; // duplicate internalName in one document → first wins
    seen.add(key);
    // Phase 2: canonical media support derived from the TvType enum names
    // (the same derivation the live view uses — one source of truth).
    const mediaTypes: Array<'movie' | 'tv'> = [];
    for (const tvType of boundedTvTypes(plugin['tvTypes'])) {
      const canonical = canonicalMediaTypeFromTvType(tvType);
      if (canonical !== null && !mediaTypes.includes(canonical)) mediaTypes.push(canonical);
    }
    normalized.push({
      internalName,
      name: boundedString(plugin['name'], EXTENSION_NAME_MAX),
      version: boundedInt(plugin['version']),
      apiVersion: boundedInt(plugin['apiVersion']),
      description: boundedString(plugin['description'], EXTENSION_DESCRIPTION_MAX),
      authors: boundedAuthors(plugin['authors']),
      language: boundedString(plugin['language'], LANGUAGE_MAX),
      tvTypes: boundedTvTypes(plugin['tvTypes']),
      // .cs3 artifact URL — METADATA ONLY, never fetched/executed.
      // Canonical field is `url` (AC-002); `file` is a tolerated alias.
      pluginUrl: boundedUrl(plugin['url']) ?? boundedUrl(plugin['file']),
      pluginStatus: boundedPluginStatus(plugin['status']),
      // Canonical icon field is `iconUrl` (AC-002); `icon` is a tolerated alias.
      iconUrl: boundedUrl(plugin['iconUrl']) ?? boundedUrl(plugin['icon']),
      // Inert artifact metadata (plan §6.2 'hash' + verified real fields).
      fileHash: boundedString(plugin['fileHash'], FILE_HASH_MAX),
      fileSizeBytes: boundedInt(plugin['fileSize']),
      sourceUrl: boundedUrl(plugin['repositoryUrl']),
      // Phase 2 — unified Extension catalog fields (CloudStream defaults).
      integrationType: 'cloudstream',
      mediaTypes,
      moduleUrl: null,
      versionText: null,
      providerMetadata: null,
    });
  }
  return normalized;
}

/** Re-exported for services/tests that need the bound constants. */
export const PARSE_BOUNDS = {
  MAX_PLUGIN_LISTS,
  MAX_EXTENSIONS_PER_REPOSITORY,
  INTERNAL_NAME_MAX,
  ADAPTER_ID_MAX,
  ADAPTER_VERSION_MAX,
} as const;

/** Type-only re-export so services share one contract source. */
export type { CloudStreamPluginListEntry };
