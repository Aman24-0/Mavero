import { FORBIDDEN_MODEL_TOKENS } from '$lib/server/streaming/addon-validation';
import { ManifestServiceError } from './errors';

/**
 * MAVERO Stremio manifest service — manifest validation + normalization
 * (Phase 2).
 *
 * Converts an arbitrary parsed-JSON manifest into a small, predictable
 * internal representation containing only the fields Mavero needs. Unknown
 * manifest fields are IGNORED (never blindly copied). Per the Stremio addon
 * protocol, a missing `resources` field defaults to
 * `['catalog', 'meta', 'stream']` — addons that omit resources are
 * stream-capable by protocol default.
 *
 * HTTP-only contract (Phase 2 spec §16): torrent/P2P-related tokens are
 * NEVER accepted as streaming capabilities. They are filtered out of the
 * capability view and never persisted; a manifest containing unrelated
 * descriptive text (e.g. a description that mentions torrents) stays valid.
 *
 * Pure synchronous code — no I/O, no fetching, no stream resolution.
 */

const MANIFEST_ID_MAX_LENGTH = 120;
const MANIFEST_NAME_MAX_LENGTH = 120;
const MANIFEST_VERSION_MAX_LENGTH = 120;
const MANIFEST_DESCRIPTION_MAX_LENGTH = 500;
const MANIFEST_LOGO_MAX_LENGTH = 2048;
const MANIFEST_ARRAY_MAX_ITEMS = 40;
const MANIFEST_ARRAY_ITEM_MAX_LENGTH = 120;

/** Stremio addon ids are dot/segment style identifiers (`community.example`). */
const MANIFEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Permissive semver: `1`, `1.2`, `1.2.3`, with optional `-pre`/`+build`. */
const MANIFEST_VERSION_PATTERN = /^\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/;

/** idProperty values are property names like `imdb_id` or `yt_id` (protocol forms). */
const MANIFEST_ID_PROPERTY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Protocol default when a manifest omits `resources` (Stremio addon spec). */
export const STREMIO_PROTOCOL_DEFAULT_RESOURCES = ['catalog', 'meta', 'stream'] as const;

export type NormalizedStremioManifest = {
  id: string;
  version: string;
  name: string;
  description?: string;
  logo?: string;
  /** Declared resource names (lowercase, deduplicated). */
  resources: string[];
  /** Declared media types (lowercase, deduplicated). */
  types: string[];
  /** Declared ID prefixes (trimmed, deduplicated, case preserved). */
  idPrefixes: string[];
  /** Primary idProperty when the manifest declares one. */
  idProperty?: string;
  /** Types declared on the stream resource itself (may be narrower than `types`). */
  streamTypes: string[];
  /** ID prefixes declared on the stream resource itself. */
  streamIdPrefixes: string[];
};

export type ManifestCapabilities = {
  supportsStream: boolean;
  supportedTypes: string[];
  supportedIdPrefixes: string[];
  idProperty?: string;
};

function invalid(message: string): ManifestServiceError {
  return new ManifestServiceError('INVALID_MANIFEST', { message });
}

function containsTorrentToken(text: string): boolean {
  const lowered = text.toLowerCase();
  return FORBIDDEN_MODEL_TOKENS.some((token) => lowered.includes(token));
}

function normalizeTokenArray(value: unknown, label: string, options: { lowercase: boolean }): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`${label} must be an array when present.`);
  if (value.length > MANIFEST_ARRAY_MAX_ITEMS * 4) throw invalid(`${label} is too large.`);
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue; // invalid entries are skipped, not fatal
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > MANIFEST_ARRAY_ITEM_MAX_LENGTH) continue;
    const token = options.lowercase ? trimmed.toLowerCase() : trimmed;
    if (!normalized.includes(token)) normalized.push(token);
    if (normalized.length >= MANIFEST_ARRAY_MAX_ITEMS) break;
  }
  return normalized;
}

/** Extracts a type name from a manifest entry: strings or `{ type_name }` objects. */
function typeNameFromEntry(entry: unknown): string | null {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    return trimmed && trimmed.length <= MANIFEST_ARRAY_ITEM_MAX_LENGTH ? trimmed.toLowerCase() : null;
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const typeName = (entry as Record<string, unknown>).type_name;
    if (typeof typeName === 'string') {
      const trimmed = typeName.trim();
      return trimmed && trimmed.length <= MANIFEST_ARRAY_ITEM_MAX_LENGTH ? trimmed.toLowerCase() : null;
    }
  }
  return null;
}

/**
 * Extracts a resource NAME from a manifest resources entry. Entries may be
 * plain strings or objects (`{ name, types?, idPrefixes?, extra? }`) per the
 * Stremio manifest specification.
 */
function resourceEntryName(entry: unknown): string | null {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    return trimmed && trimmed.length <= MANIFEST_ARRAY_ITEM_MAX_LENGTH ? trimmed.toLowerCase() : null;
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const name = (entry as Record<string, unknown>).name;
    if (typeof name === 'string') {
      const trimmed = name.trim();
      return trimmed && trimmed.length <= MANIFEST_ARRAY_ITEM_MAX_LENGTH ? trimmed.toLowerCase() : null;
    }
  }
  return null;
}

function resourceEntryStrings(entry: unknown, key: 'types' | 'idPrefixes'): string[] {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
  const value = (entry as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    // Resource `types` entries may be strings or `{ type_name }` objects.
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed && trimmed.length <= MANIFEST_ARRAY_ITEM_MAX_LENGTH) names.push(trimmed.toLowerCase());
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const typeName = (item as Record<string, unknown>).type_name;
      if (typeof typeName === 'string') {
        const trimmed = typeName.trim();
        if (trimmed && trimmed.length <= MANIFEST_ARRAY_ITEM_MAX_LENGTH) names.push(trimmed.toLowerCase());
      }
    }
    if (names.length >= MANIFEST_ARRAY_MAX_ITEMS) break;
  }
  return [...new Set(names)];
}

function normalizeIdProperty(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MANIFEST_ARRAY_ITEM_MAX_LENGTH) throw invalid('Manifest idProperty is not a supported value.');
    if (!MANIFEST_ID_PROPERTY_PATTERN.test(trimmed)) throw invalid('Manifest idProperty is not a supported value.');
    return trimmed;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) throw invalid('Manifest idProperty is not a supported value.');
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      const trimmed = entry.trim();
      if (trimmed && MANIFEST_ID_PROPERTY_PATTERN.test(trimmed) && trimmed.length <= MANIFEST_ARRAY_ITEM_MAX_LENGTH) return trimmed;
    }
    throw invalid('Manifest idProperty is not a supported value.');
  }
  throw invalid('Manifest idProperty is not a supported value.');
}

function optionalTextField(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`${label} must be a string when present.`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) throw invalid(`${label} must be ${maxLength} characters or fewer.`);
  return trimmed;
}

/**
 * Validates a parsed-JSON value as a Stremio-style manifest and returns the
 * normalized internal representation (spec §6). Throws INVALID_MANIFEST for
 * structural violations and UNSUPPORTED_MANIFEST when the manifest declares
 * no usable resources at all.
 */
export function validateStremioManifest(value: unknown): NormalizedStremioManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('The manifest must be a JSON object.');
  }
  const manifest = value as Record<string, unknown>;

  const id = typeof manifest.id === 'string' ? manifest.id.trim() : '';
  if (!id || id.length > MANIFEST_ID_MAX_LENGTH || !MANIFEST_ID_PATTERN.test(id)) {
    throw invalid('The manifest must declare a valid non-empty id.');
  }

  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (!version || version.length > MANIFEST_VERSION_MAX_LENGTH || !MANIFEST_VERSION_PATTERN.test(version)) {
    throw invalid('The manifest must declare a valid version string.');
  }

  const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
  if (!name || name.length > MANIFEST_NAME_MAX_LENGTH) {
    throw invalid('The manifest must declare a non-empty name (120 characters or fewer).');
  }

  const description = optionalTextField(manifest.description, 'Manifest description', MANIFEST_DESCRIPTION_MAX_LENGTH);
  const logo = optionalTextField(manifest.logo, 'Manifest logo', MANIFEST_LOGO_MAX_LENGTH);

  // `types` normalization: strings or `{ type_name }` objects, lowercased,
  // deduplicated, invalid entries skipped (spec §6 — normalize, don't trust).
  const types = normalizeTokenArray(manifest.types, 'Manifest types', { lowercase: true })
    .concat(
      Array.isArray(manifest.types)
        ? manifest.types.map(typeNameFromEntry).filter((entry): entry is string => entry !== null)
        : [],
    )
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .slice(0, MANIFEST_ARRAY_MAX_ITEMS);

  const idPrefixes = normalizeTokenArray(manifest.idPrefixes, 'Manifest idPrefixes', { lowercase: false });

  // `resources` normalization: absent → protocol default; present-but-empty
  // or fully-invalid → UNSUPPORTED (an addon that declares nothing usable).
  let resources: string[];
  let streamTypes: string[] = [];
  let streamIdPrefixes: string[] = [];
  if (manifest.resources === undefined || manifest.resources === null) {
    resources = [...STREMIO_PROTOCOL_DEFAULT_RESOURCES];
  } else {
    if (!Array.isArray(manifest.resources)) throw invalid('Manifest resources must be an array when present.');
    if (manifest.resources.length > MANIFEST_ARRAY_MAX_ITEMS * 4) throw invalid('Manifest resources are too large.');
    resources = [];
    const streamTypesAccumulator: string[] = [];
    const streamIdPrefixesAccumulator: string[] = [];
    for (const entry of manifest.resources) {
      const resourceName = resourceEntryName(entry);
      if (!resourceName) continue;
      if (!resources.includes(resourceName)) resources.push(resourceName);
      if (resourceName === 'stream') {
        streamTypesAccumulator.push(...resourceEntryStrings(entry, 'types'));
        streamIdPrefixesAccumulator.push(...resourceEntryStrings(entry, 'idPrefixes'));
      }
      if (resources.length >= MANIFEST_ARRAY_MAX_ITEMS) break;
    }
    if (resources.length === 0) {
      throw new ManifestServiceError('UNSUPPORTED_MANIFEST');
    }
    streamTypes = [...new Set(streamTypesAccumulator)].slice(0, MANIFEST_ARRAY_MAX_ITEMS);
    streamIdPrefixes = [...new Set(streamIdPrefixesAccumulator)].slice(0, MANIFEST_ARRAY_MAX_ITEMS);
  }

  const idProperty = normalizeIdProperty(manifest.idProperty);

  return {
    id,
    version,
    name,
    description,
    logo,
    resources,
    types,
    idPrefixes,
    idProperty,
    streamTypes,
    streamIdPrefixes,
  };
}

/**
 * True only when the manifest explicitly declares the `stream` resource.
 * An existing manifest alone never implies stream support (spec §7).
 */
export function supportsStreamResource(manifest: NormalizedStremioManifest): boolean {
  return manifest.resources.includes('stream');
}

/**
 * Mavero's HTTP-stream capability view of a normalized manifest
 * (spec §7). Torrent/P2P-related tokens are never accepted as streaming
 * capabilities: they are filtered out of `supportedTypes` here, and
 * `supportsStream` only ever comes from a declared `stream` resource.
 */
export function getManifestCapabilities(manifest: NormalizedStremioManifest): ManifestCapabilities {
  return {
    supportsStream: supportsStreamResource(manifest),
    supportedTypes: manifest.types.filter((type) => !containsTorrentToken(type)),
    supportedIdPrefixes: [...manifest.idPrefixes],
    idProperty: manifest.idProperty,
  };
}

/**
 * Resource names safe to persist: torrent/P2P-ish declared tokens are
 * dropped (they are not HTTP-stream capabilities and never enter the addon
 * registry). `stream` itself always survives.
 */
export function persistableResourceNames(manifest: NormalizedStremioManifest): string[] {
  return manifest.resources.filter((resource) => !containsTorrentToken(resource));
}

/** Whitelisted capabilities JSONB payload persisted with a successful sync. */
export function persistableCapabilities(manifest: NormalizedStremioManifest, normalizedAt: string): Record<string, unknown> {
  const capabilities = getManifestCapabilities(manifest);
  // Whitelisted keys only — never a raw manifest dump (spec §9). The keys
  // are checked against the Phase 1 forbidden-token contract by tests.
  return {
    supportsStream: capabilities.supportsStream,
    manifestId: manifest.id,
    manifestVersion: manifest.version,
    normalizedAt,
  };
}
