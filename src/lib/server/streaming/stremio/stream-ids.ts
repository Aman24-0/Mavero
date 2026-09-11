import { FORBIDDEN_MODEL_TOKENS } from '$lib/server/streaming/addon-validation';
import type { ContentIdentifiers } from '$lib/server/resolver/types';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import { StreamServiceError } from './stream-errors';

/**
 * MAVERO Stremio stream resolver — addon eligibility + video ID construction
 * (Phase 3).
 *
 * Stremio stream requests follow `/stream/{type}/{videoID}.json`. The video
 * ID is constructed according to EACH addon's OWN declared idProperty /
 * idPrefixes (spec §1–§5) — Mavero never assumes one global ID format:
 *
 *   * `idProperty: "imdb_id"` → the Mavero IMDb id (`tt1234567`)
 *   * `idProperty: "tmdb_id"` → `tmdb:{id}` (the documented Stremio
 *     convention for TMDB-keyed addons)
 *   * no idProperty → inferred from idPrefixes ('tt…' → imdb, 'tmdb…' → tmdb)
 *   * neither declared → the protocol default property (`imdb_id`, the
 *     canonical Stremio video ID namespace — documented protocol behavior,
 *     not an invented restriction)
 *   * any other idProperty (`mal_id`, `anilist_id`, `slug`, `custom`, …) →
 *     the addon is SKIPPED: Mavero does not invent ID formats it cannot
 *     construct from its existing identifier system (spec §4)
 *
 * Series episodes append `:{season}:{episode}` (e.g. `tt1234567:1:3`).
 * The constructed ID is validated against a strict allowlist before it is
 * ever embedded into a URL path — colons are legal path characters and are
 * preserved exactly as the Stremio protocol expects (no `encodeURIComponent`
 * mangling of the ID semantics).
 *
 * Eligibility is EXPLICIT-ONLY (Phase 3 policy): an addon participates only
 * when the Phase 2 sync verified `capabilities.supportsStream === true`
 * (an explicitly advertised stream resource). Stream support is never
 * inferred from missing metadata.
 *
 * Pure synchronous code — no I/O.
 */

/** Stremio media types Mavero can request streams for. */
export type StremioStreamType = 'movie' | 'series';

/** The ID properties Mavero can actually construct (protocol-supported). */
export const SUPPORTED_STREMIO_ID_PROPERTIES = ['imdb_id', 'tmdb_id'] as const;
export type SupportedStremioIdProperty = (typeof SUPPORTED_STREMIO_ID_PROPERTIES)[number];

/**
 * The protocol default property when an addon declares neither idProperty
 * nor idPrefixes: Stremio's canonical video IDs are IMDb-based.
 */
export const DEFAULT_STREMIO_ID_PROPERTY: SupportedStremioIdProperty = 'imdb_id';

/** Strict allowlist for a constructed Stremio video ID (colons preserved). */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const VIDEO_ID_MAX_LENGTH = 200;

/** IMDb base ids are `tt` + digits (the protocol's IMDb ID format). */
const IMDB_ID_PATTERN = /^tt\d{1,12}$/;
/** TMDB ids are positive integers. */
const TMDB_ID_PATTERN = /^\d{1,12}$/;

/** Why an addon was excluded from a resolution (in-memory diagnostics only). */
export type AddonSkipReason =
  | 'no-stream-capability'
  | 'unsupported-media-type'
  | 'unsupported-id-property'
  | 'missing-identifier'
  | 'id-prefix-mismatch'
  | 'invalid-endpoint';

/** Maps a Mavero content type onto the Stremio stream endpoint type. */
export function stremioStreamTypeFor(mediaType: 'movie' | 'series' | 'anime'): StremioStreamType {
  return mediaType === 'movie' ? 'movie' : 'series';
}

function containsTorrentToken(text: string): boolean {
  const lowered = text.toLowerCase();
  return FORBIDDEN_MODEL_TOKENS.some((token) => lowered.includes(token));
}

function capabilityStringArray(capabilities: Record<string, unknown>, key: string): string[] {
  const value = capabilities[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Defensive re-filter: persisted arrays were torrent-filtered on write; fail safe on read. */
function safeStringArray(values: string[]): string[] {
  return values.filter((value) => !containsTorrentToken(value));
}

/**
 * The stream resource may declare its OWN (narrower) type list. When present
 * in the persisted capabilities it wins over the manifest-level types.
 */
function effectiveStreamTypes(addon: StreamingAddon): string[] {
  const scoped = capabilityStringArray(addon.capabilities, 'streamTypes');
  return safeStringArray(scoped.length ? scoped : addon.supportedTypes);
}

function effectiveStreamIdPrefixes(addon: StreamingAddon): string[] {
  const scoped = capabilityStringArray(addon.capabilities, 'streamIdPrefixes');
  return safeStringArray(scoped.length ? scoped : addon.idPrefixes);
}

/**
 * EXPLICIT-ONLY stream capability (Phase 3 policy): the addon participates
 * only when the Phase 2 manifest sync recorded an explicitly advertised
 * `stream` resource. Missing/absent capability data never implies support.
 */
export function addonSupportsStreamResource(addon: StreamingAddon): boolean {
  return addon.capabilities.supportsStream === true;
}

/**
 * Resolves which of Mavero's supported ID properties this addon accepts:
 * declared idProperty first, then idPrefixes inference, then the protocol
 * default. Returns null when the addon demands an ID Mavero cannot
 * construct (the addon is then skipped, never called with a guessed ID).
 */
export function resolveAddonIdProperty(addon: StreamingAddon): SupportedStremioIdProperty | null {
  return resolveAddonIdPropertyCandidates(addon)[0] ?? null;
}

/**
 * Phase 11 (GOAL C — the Pipe loss point): ALL constructible ID properties
 * the addon accepts, in the addon's own preference order. The historical
 * planner resolved ONE property and skipped the addon when the content had
 * no id for it (`missing-identifier`) — a Stremio-visible addon therefore
 * vanished from MAVERO whenever:
 *
 *   * its manifest declared an `idProperty` ARRAY whose first entry MAVERO
 *     cannot construct (`["kitsu_id","imdb_id"]` — one entry later is
 *     constructible), or
 *   * it accepted BOTH id namespaces via its prefixes (`idPrefixes:
 *     ["tt","tmdb"]` / stream-scoped equivalents) but the content item only
 *     carried one of the two ids.
 *
 * Candidate order (deduplicated):
 *   1. the declared scalar `idProperty` (highest precedence);
 *   2. every declared `idProperties` array entry (capabilities — Phase 11
 *      manifest sync persists the full list) in declared order;
 *   3. prefix-inferred properties (`tt…` → imdb, `tmdb…` → tmdb) — only
 *      when the addon did NOT explicitly declare an idProperty, mirroring
 *      the historical inference rule;
 *   4. the protocol default (`imdb_id`) when the addon declares nothing.
 * Only properties MAVERO can construct (imdb/tmdb) are ever returned — an
 * addon accepting exclusively unsupported namespaces still yields an empty
 * list (unsupported-id-property skip, unchanged).
 */
export function resolveAddonIdPropertyCandidates(addon: StreamingAddon): SupportedStremioIdProperty[] {
  const candidates: SupportedStremioIdProperty[] = [];
  const push = (property: SupportedStremioIdProperty) => {
    if (!candidates.includes(property)) candidates.push(property);
  };

  const declared = addon.idProperty?.trim();
  const declaredList = capabilityStringArray(addon.capabilities, 'idProperties');
  const hasExplicitDeclaration = Boolean(declared) || declaredList.length > 0;

  if (declared && (SUPPORTED_STREMIO_ID_PROPERTIES as readonly string[]).includes(declared)) {
    push(declared as SupportedStremioIdProperty);
  }
  for (const entry of declaredList) {
    if ((SUPPORTED_STREMIO_ID_PROPERTIES as readonly string[]).includes(entry)) push(entry as SupportedStremioIdProperty);
  }

  if (!hasExplicitDeclaration) {
    // No explicit declaration — infer from the (effective) idPrefixes. Both
    // namespaces may be accepted; the inference order mirrors the protocol
    // default precedence (imdb first) and stays deterministic.
    const prefixes = effectiveStreamIdPrefixes(addon);
    if (prefixes.length) {
      const lowered = prefixes.map((prefix) => prefix.toLowerCase());
      if (lowered.some((prefix) => prefix.startsWith('tt'))) push('imdb_id');
      if (lowered.some((prefix) => prefix.startsWith('tmdb'))) push('tmdb_id');
      return candidates;
    }
    push(DEFAULT_STREMIO_ID_PROPERTY);
  }
  return candidates;
}

function baseIdFor(property: SupportedStremioIdProperty, identifiers: Pick<ContentIdentifiers, 'imdbId' | 'tmdbId'>): string | null {
  if (property === 'imdb_id') {
    const value = identifiers.imdbId?.trim();
    return value && IMDB_ID_PATTERN.test(value) ? value : null;
  }
  const value = identifiers.tmdbId?.trim();
  return value && TMDB_ID_PATTERN.test(value) ? `tmdb:${value}` : null;
}

/** A validated, ready-to-fetch plan for one addon's stream request. */
export type StremioAddonStreamPlan = {
  addonId: string;
  addonName: string;
  addonSlug: string;
  addonOrdering: number;
  /** Origin base the endpoint was derived from (the admin-configured manifest URL). */
  manifestUrl: string;
  streamType: StremioStreamType;
  idProperty: SupportedStremioIdProperty;
  videoId: string;
  endpointUrl: string;
};

export type AddonStreamPlan = { ok: true; plan: StremioAddonStreamPlan } | { ok: false; reason: AddonSkipReason };

/**
 * Builds the Stremio stream endpoint URL from the addon's manifest URL:
 * `/stream/{type}/{videoID}.json` resolved against the manifest URL
 * directory (relative resolution replaces the `manifest.json` file name).
 * Keyed manifests keep their query string on stream calls. The video ID is
 * validated against a strict allowlist — it is never free-form embedded
 * into a URL.
 */
export function buildStremioStreamUrl(manifestUrl: string, streamType: StremioStreamType, videoId: string): string | null {
  if (!videoId || videoId.length > VIDEO_ID_MAX_LENGTH || !VIDEO_ID_PATTERN.test(videoId)) return null;
  let base: URL;
  try {
    base = new URL(manifestUrl);
  } catch {
    return null;
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
  let endpoint: URL;
  try {
    endpoint = new URL(`stream/${streamType}/${videoId}.json`, base);
  } catch {
    return null;
  }
  if (base.search) endpoint.search = base.search;
  return endpoint.toString();
}

/**
 * Decides whether one addon participates in a stream resolution and, if so,
 * produces the exact request plan (endpoint URL + constructed video ID).
 * Every exclusion is a typed reason — no addon is ever called "blindly"
 * (spec §3), and no network request is made just to discover an ID is
 * invalid (spec §4).
 */
export function planAddonStreamRequest(
  addon: StreamingAddon,
  streamType: StremioStreamType,
  identifiers: Pick<ContentIdentifiers, 'imdbId' | 'tmdbId'>,
  season?: number,
  episode?: number,
): AddonStreamPlan {
  if (!addonSupportsStreamResource(addon)) return { ok: false, reason: 'no-stream-capability' };

  const types = effectiveStreamTypes(addon);
  if (!types.includes(streamType)) return { ok: false, reason: 'unsupported-media-type' };

  // Phase 11 (GOAL C): availability-aware planning. Every constructible
  // property the addon accepts is tried in the addon's preference order;
  // the first one whose id EXISTS on the content item wins. An addon is
  // skipped as `missing-identifier` only when NONE of its accepted
  // namespaces has an id — never because the FIRST accepted namespace
  // happened to be unavailable (the historical single-property behavior
  // that made Stremio-visible addons disappear from MAVERO).
  const candidates = resolveAddonIdPropertyCandidates(addon);
  if (!candidates.length) return { ok: false, reason: 'unsupported-id-property' };
  let property: SupportedStremioIdProperty | null = null;
  let baseId: string | null = null;
  for (const candidate of candidates) {
    const id = baseIdFor(candidate, identifiers);
    if (id) {
      property = candidate;
      baseId = id;
      break;
    }
  }
  if (!property || !baseId) return { ok: false, reason: 'missing-identifier' };

  let videoId = baseId;
  if (streamType === 'series') {
    if (!Number.isSafeInteger(season) || (season as number) < 1 || !Number.isSafeInteger(episode) || (episode as number) < 1) {
      return { ok: false, reason: 'missing-identifier' };
    }
    videoId = `${baseId}:${season}:${episode}`;
  }
  if (!videoId || videoId.length > VIDEO_ID_MAX_LENGTH || !VIDEO_ID_PATTERN.test(videoId)) {
    return { ok: false, reason: 'missing-identifier' };
  }

  // Prefix filtering (spec §3): an addon declaring idPrefixes is called only
  // when the CONSTRUCTED id matches one of them. No prefixes → no invented
  // restriction (protocol semantics).
  const prefixes = effectiveStreamIdPrefixes(addon);
  if (prefixes.length && !prefixes.some((prefix) => videoId.startsWith(prefix))) {
    return { ok: false, reason: 'id-prefix-mismatch' };
  }

  const endpointUrl = buildStremioStreamUrl(addon.manifestUrl, streamType, videoId);
  if (!endpointUrl) return { ok: false, reason: 'invalid-endpoint' };

  return {
    ok: true,
    plan: {
      addonId: addon.id,
      addonName: addon.name,
      addonSlug: addon.slug,
      addonOrdering: addon.ordering,
      manifestUrl: addon.manifestUrl,
      streamType,
      idProperty: property,
      videoId,
      endpointUrl,
    },
  };
}

/**
 * Guard used by the resolver input validation: a series request must carry a
 * season AND an episode (mirrors the existing resolver request contract);
 * movie requests must not.
 */
export function assertEpisodeScope(streamType: StremioStreamType, season?: number, episode?: number): void {
  if (streamType === 'series' && (!Number.isSafeInteger(season) || (season as number) < 1 || !Number.isSafeInteger(episode) || (episode as number) < 1)) {
    throw new StreamServiceError('INVALID_REQUEST');
  }
}
