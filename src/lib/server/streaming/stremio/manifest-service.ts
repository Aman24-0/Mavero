import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { StreamingAddonUpdate } from '$lib/server/streaming/addons';
import { asManifestServiceError, isPermanentManifestFailure, ManifestServiceError, type ManifestErrorCode } from './errors';
import { fetchStremioManifest, type ManifestFetchDeps } from './manifest-fetch';
import { defaultManifestCache, manifestCacheKey, type ManifestCache } from './manifest-cache';
import { getManifestCapabilities, persistableCapabilities, persistableResourceNames, validateStremioManifest, type NormalizedStremioManifest } from './manifest-normalize';
import type { SafeDnsResolver } from './ssrf';

/**
 * MAVERO Stremio manifest service — orchestration + persistence (Phase 2).
 *
 * Responsibilities (Phase 2 spec §7–§10):
 *   * fetch + validate a manifest and normalize it into the internal model
 *   * build the `streaming_addons` update payloads for success and failure
 *   * persist health-check outcomes through an injected Supabase client
 *     (same convention as `streaming/health-service.ts`)
 *   * refresh stale manifest metadata for enabled addons (service-level
 *     only — Phase 2 deliberately ships NO HTTP endpoint, admin UI, or
 *     public surface)
 *
 * Administrator-owned columns (`enabled`, `ordering`, `slug`, `manifest_url`,
 * `notes`) are NEVER written by this service. Torrent/P2P content is never
 * persisted. `last_error` only ever receives the curated safe messages from
 * `errors.ts` (truncated to the DB limit) — never internal IPs, DNS details,
 * stack traces, headers, credentials, or response bodies (spec §11).
 */

/** The DB's `last_error` limit (mirrors the Phase 1 migration CHECK). */
const LAST_ERROR_MAX_LENGTH = 1000;

export type AddonManifestTarget = Pick<StreamingAddonUpdate, 'id' | 'manifest_url' | 'status'> & {
  id: string;
  manifest_url: string;
  status?: string | null;
};

export type ManifestSyncDeps = ManifestFetchDeps & {
  /** Injectable clock (ISO string) for deterministic tests. */
  now?: () => string;
  /** Injectable cache instance (tests use an isolated cache). */
  cache?: ManifestCache;
  /**
   * Opt-in metadata cache for non-health flows. Health checks and stale
   * refreshes default to a REAL network check so health data stays honest.
   */
  useCache?: boolean;
};

export type ManifestSyncOutcome =
  | { ok: true; manifest: NormalizedStremioManifest; finalUrl: string; update: StreamingAddonUpdate }
  | { ok: false; errorCode: ManifestErrorCode; update: StreamingAddonUpdate };

type StreamingClient = SupabaseClient<Database>;

function defaultNowIso(): string {
  return new Date().toISOString();
}

/** Fetches and validates a manifest in one step (no DB access). */
export async function fetchNormalizedManifest(rawUrl: string, deps: ManifestSyncDeps = {}): Promise<{ manifest: NormalizedStremioManifest; finalUrl: string }> {
  const { useCache = false, cache = defaultManifestCache, ...fetchDeps } = deps;
  if (useCache) {
    const key = manifestCacheKey(rawUrl);
    const cached = cache.get(key);
    if (cached) return { manifest: cached.manifest, finalUrl: cached.finalUrl };
    const fetched = await fetchStremioManifest(rawUrl, fetchDeps);
    const manifest = validateStremioManifest(fetched.body);
    cache.set(key, manifest, fetched.finalUrl);
    return { manifest, finalUrl: fetched.finalUrl };
  }
  const fetched = await fetchStremioManifest(rawUrl, fetchDeps);
  const manifest = validateStremioManifest(fetched.body);
  return { manifest, finalUrl: fetched.finalUrl };
}

/**
 * Builds the update payload persisted after a successful manifest fetch
 * (spec §9–§10): metadata refreshed from the manifest, status `active`,
 * health marked successful, `last_error` cleared. Admin-owned columns are
 * never included.
 */
export function buildSuccessfulManifestUpdate(manifest: NormalizedStremioManifest, now: string): StreamingAddonUpdate {
  const capabilities = getManifestCapabilities(manifest);
  return {
    name: manifest.name,
    description: manifest.description ?? null,
    logo: manifest.logo ?? null,
    version: manifest.version,
    id_property: manifest.idProperty ?? null,
    supported_types: capabilities.supportedTypes,
    id_prefixes: capabilities.supportedIdPrefixes,
    resources: persistableResourceNames(manifest),
    capabilities: persistableCapabilities(manifest, now) as StreamingAddonUpdate['capabilities'],
    status: 'active',
    last_checked_at: now,
    last_success_at: now,
    last_error: null,
  };
}

/**
 * Sanitized, human-readable, persistence-safe error text. Only curated
 * `ManifestServiceError` messages (plus a safe HTTP status detail) ever
 * reach `streaming_addons.last_error`; anything else collapses to the fixed
 * UNEXPECTED message with the cause logged server-side only.
 */
export function sanitizeLastError(error: unknown): string {
  const serviceError = asManifestServiceError(error);
  const message = serviceError.message;
  if (message.length <= LAST_ERROR_MAX_LENGTH) return message;
  return `${message.slice(0, LAST_ERROR_MAX_LENGTH - 3)}...`;
}

/**
 * Builds the update payload persisted after a failed manifest check
 * (spec §10): `last_checked_at` refreshed, a sanitized error recorded, and
 * — only for PERMANENT failures (invalid/blocked URL, invalid/unsupported
 * manifest) — status flipped to `unavailable`. Temporary failures
 * (timeout, network, HTTP error, oversized, non-JSON) keep the
 * administrator's current status and preserve all previously synced
 * metadata.
 */
export function buildFailedManifestUpdate(error: unknown, now: string, options: { permanent?: boolean } = {}): StreamingAddonUpdate {
  const permanent = options.permanent ?? isPermanentManifestFailure(error);
  return {
    last_checked_at: now,
    last_error: sanitizeLastError(error),
    ...(permanent ? { status: 'unavailable' } : {}),
  };
}

/** Persists an addon update through the injected (server-side) client. */
export async function persistAddonManifestUpdate(client: StreamingClient, addonId: string, update: StreamingAddonUpdate): Promise<void> {
  const { error } = await client.from('streaming_addons').update(update).eq('id', addonId);
  if (error) throw error;
}

/**
 * Health-checks one addon against its stored manifest URL: fetches the
 * manifest securely, validates it, and persists the resulting metadata or
 * sanitized failure state. Returns a discriminated outcome; the update
 * payload is included so callers (and tests) can inspect exactly what was
 * written without touching the database.
 */
export async function syncAddonManifest(client: StreamingClient, target: AddonManifestTarget, deps: ManifestSyncDeps = {}): Promise<ManifestSyncOutcome> {
  const now = (deps.now ?? defaultNowIso)();
  try {
    const { manifest, finalUrl } = await fetchNormalizedManifest(target.manifest_url, deps);
    const update = buildSuccessfulManifestUpdate(manifest, now);
    await persistAddonManifestUpdate(client, target.id, update);
    return { ok: true, manifest, finalUrl, update };
  } catch (error) {
    const serviceError = asManifestServiceError(error);
    if (serviceError.code === 'UNEXPECTED') {
      // Diagnostic detail stays in server logs only (repo convention).
      console.warn('[AddonManifest] unexpected manifest sync failure', error);
    }
    const update = buildFailedManifestUpdate(serviceError, now);
    try {
      await persistAddonManifestUpdate(client, target.id, update);
    } catch (persistError) {
      console.warn('[AddonManifest] health update unavailable', persistError);
    }
    return { ok: false, errorCode: serviceError.code, update };
  }
}

export type StaleManifestRefreshOptions = {
  /** Addons whose last check is older than this are refreshed. Default 6h. */
  maxAgeMs?: number;
  /** Upper bound of addons refreshed per run. Default 10. */
  limit?: number;
  deps?: ManifestSyncDeps;
};

export type StaleManifestRefreshReport = {
  checked: number;
  succeeded: number;
  failed: number;
  results: Array<{ addonId: string; outcome: ManifestSyncOutcome }>;
};

/**
 * Refreshes stale manifest metadata for ENABLED addons whose
 * `last_checked_at` is missing or older than `maxAgeMs`. Server-side only;
 * Phase 2 ships no endpoint or scheduler around it (spec §14 — service-level
 * function, callable from a future admin route or cron).
 */
export async function refreshStaleAddonManifests(client: StreamingClient, options: StaleManifestRefreshOptions = {}): Promise<StaleManifestRefreshReport> {
  const maxAgeMs = options.maxAgeMs ?? 6 * 60 * 60_000;
  const limit = options.limit ?? 10;
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  const { data, error } = await client
    .from('streaming_addons')
    .select('id, manifest_url, status')
    .eq('enabled', true)
    .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`)
    .order('last_checked_at', { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw error;

  const targets = (data ?? []) as AddonManifestTarget[];
  const results: StaleManifestRefreshReport['results'] = [];
  let succeeded = 0;
  let failed = 0;
  for (const target of targets) {
    const outcome = await syncAddonManifest(client, target, options.deps);
    if (outcome.ok) succeeded += 1;
    else failed += 1;
    results.push({ addonId: target.id, outcome });
  }
  return { checked: targets.length, succeeded, failed, results };
}

export { ManifestServiceError };
