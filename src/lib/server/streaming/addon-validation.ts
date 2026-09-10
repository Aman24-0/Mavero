import type { StreamingAddonStatus } from '$lib/shared/streaming-addons';
import { addonStatuses, defaultAddonStatus, isStreamingAddonStatus } from '$lib/shared/streaming-addons';
import { StreamingValidationError, validateSlug } from './validation';

/**
 * MAVERO Stremio HTTP addon foundation — Phase 1 validation helpers.
 *
 * Scope is deliberately CONFIGURATION VALIDATION ONLY:
 *   * Manifest URL checks are SYNTACTIC (shape, protocol, length). Phase 1
 *     NEVER fetches the URL, never inspects manifest contents, and therefore
 *     introduces no SSRF surface. Fetching + manifest-content validation
 *     belong to Phase 2 and must run server-side in a trusted context.
 *   * No torrent/P2P/peer/debrid configuration exists in this model; the
 *     addon branch only ever carries HTTP/S configuration for the future
 *     server-side resolver.
 */

const MANIFEST_URL_MAX_LENGTH = 2048;
const NAME_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 500;
const METADATA_MAX_LENGTH = 2048;
const VERSION_MAX_LENGTH = 120;
const ID_PROPERTY_MAX_LENGTH = 120;
const NOTES_MAX_LENGTH = 2000;
const MAX_ARRAY_ITEMS = 40;
const MAX_ARRAY_ITEM_LENGTH = 120;

/** Strings that must never appear as fields of the Phase 1 addon model. */
const FORBIDDEN_MODEL_TOKENS = ['torrent', 'p2p', 'magnet', 'tracker', 'peer', 'debrid', 'rtorrent'] as const;

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new StreamingValidationError(`${label} must be a string.`);
  return value;
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = requireString(value, label).trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) throw new StreamingValidationError(`${label} must be ${maxLength} characters or fewer.`);
  return normalized;
}

function rejectForbiddenTokens(text: string, label: string): void {
  const lowered = text.toLowerCase();
  const hit = FORBIDDEN_MODEL_TOKENS.find((token) => lowered.includes(token));
  if (hit) throw new StreamingValidationError(`${label} must not contain ${hit} configuration; torrent/P2P support is out of scope.`);
}

export function validateAddonName(name: unknown): string {
  const normalized = requireString(name, 'Addon name').trim();
  if (!normalized) throw new StreamingValidationError('Addon name is required.');
  if (normalized.length > NAME_MAX_LENGTH) throw new StreamingValidationError(`Addon name must be ${NAME_MAX_LENGTH} characters or fewer.`);
  return normalized;
}

export function validateAddonSlug(slug: unknown): string {
  // Reuses the exact provider/source slug contract (normalize + pattern).
  return validateSlug(requireString(slug, 'Addon slug'), 'Addon slug');
}

/**
 * Syntactic-only manifest URL validation: http(s) scheme, hostname present,
 * no credentials, no whitespace/newlines, bounded length. NO fetching, NO
 * DNS/SSRF considerations — those are Phase 2 server-side concerns.
 */
export function validateAddonManifestUrl(url: unknown): string {
  const raw = requireString(url, 'Manifest URL').trim();
  if (!raw) throw new StreamingValidationError('Manifest URL is required.');
  if (raw.length > MANIFEST_URL_MAX_LENGTH) throw new StreamingValidationError(`Manifest URL must be ${MANIFEST_URL_MAX_LENGTH} characters or fewer.`);
  if (/[\s]/.test(raw)) throw new StreamingValidationError('Manifest URL must not contain whitespace or newlines.');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new StreamingValidationError('Manifest URL must be a valid absolute URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new StreamingValidationError('Manifest URL must use http or https.');
  if (!parsed.hostname) throw new StreamingValidationError('Manifest URL must include a hostname.');
  if (parsed.username || parsed.password) throw new StreamingValidationError('Manifest URL must not contain credentials.');
  return raw;
}

export function validateAddonOrdering(ordering: unknown): number {
  if (typeof ordering === 'number') {
    if (!Number.isSafeInteger(ordering) || ordering < 0) throw new StreamingValidationError('Ordering must be a non-negative integer.');
    return ordering;
  }
  const raw = String(ordering ?? '').trim();
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) throw new StreamingValidationError('Ordering must be a non-negative integer.');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new StreamingValidationError('Ordering must be a non-negative integer.');
  return parsed;
}

export function validateAddonStatus(status: unknown): StreamingAddonStatus {
  if (status === undefined || status === null || status === '') return defaultAddonStatus;
  const normalized = requireString(status, 'Addon status').trim();
  if (!isStreamingAddonStatus(normalized)) throw new StreamingValidationError(`Addon status must be one of: ${addonStatuses.join(', ')}.`);
  return normalized;
}

export function validateAddonStringArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new StreamingValidationError(`${label} must be an array of strings.`);
  if (value.length > MAX_ARRAY_ITEMS) throw new StreamingValidationError(`${label} must contain at most ${MAX_ARRAY_ITEMS} items.`);
  const normalized = value.map((item) => {
    if (typeof item !== 'string') throw new StreamingValidationError(`${label} must contain strings only.`);
    const trimmed = item.trim();
    if (trimmed.length > MAX_ARRAY_ITEM_LENGTH) throw new StreamingValidationError(`${label} items must be ${MAX_ARRAY_ITEM_LENGTH} characters or fewer.`);
    return trimmed;
  });
  return [...new Set(normalized)];
}

export function validateAddonCapabilities(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StreamingValidationError('Capabilities must be a JSON object.');
  const capabilities = value as Record<string, unknown>;
  for (const key of Object.keys(capabilities)) {
    rejectForbiddenTokens(key, `Capabilities key "${key}"`);
  }
  return capabilities;
}

/** Normalized Phase 1 addon configuration draft produced by `validateAddonDraft`. */
export type AddonDraft = {
  name: string;
  slug: string;
  description?: string;
  manifestUrl: string;
  enabled: boolean;
  status: StreamingAddonStatus;
  ordering: number;
  logo?: string;
  version?: string;
  idProperty?: string;
  supportedTypes: string[];
  idPrefixes: string[];
  resources: string[];
  capabilities: Record<string, unknown>;
  notes?: string;
};

/**
 * Validates a complete Phase 1 addon configuration object and returns a
 * normalized draft (trimmed strings, defaulted fields, deduplicated arrays).
 * Purely synchronous and offline — suitable for future admin form handling
 * and for unit-testing the DB/model contract.
 */
export function validateAddonDraft(input: unknown): AddonDraft {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new StreamingValidationError('Addon configuration must be a JSON object.');
  }
  const draft = input as Record<string, unknown>;
  const manifestUrl = validateAddonManifestUrl(draft.manifestUrl ?? draft.manifest_url);
  return {
    name: validateAddonName(draft.name),
    slug: validateAddonSlug(draft.slug),
    description: optionalString(draft.description, 'Description', DESCRIPTION_MAX_LENGTH),
    manifestUrl,
    enabled: draft.enabled === undefined ? false : draft.enabled === true,
    status: validateAddonStatus(draft.status),
    ordering: validateAddonOrdering(draft.ordering),
    logo: optionalString(draft.logo, 'Logo', METADATA_MAX_LENGTH),
    version: optionalString(draft.version, 'Version', VERSION_MAX_LENGTH),
    idProperty: optionalString(draft.idProperty ?? draft.id_property, 'ID property', ID_PROPERTY_MAX_LENGTH),
    supportedTypes: validateAddonStringArray(draft.supportedTypes ?? draft.supported_types, 'Supported types'),
    idPrefixes: validateAddonStringArray(draft.idPrefixes ?? draft.id_prefixes, 'ID prefixes'),
    resources: validateAddonStringArray(draft.resources, 'Resources'),
    capabilities: validateAddonCapabilities(draft.capabilities),
    notes: optionalString(draft.notes, 'Notes', NOTES_MAX_LENGTH),
  };
}
