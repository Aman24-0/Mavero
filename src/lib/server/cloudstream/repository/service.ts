/**
 * MAVERO CloudStream repository manager — repository service (CS-1).
 *
 * Administrator-facing CRUD + synchronization over the `cloudstream_*`
 * catalog (plan §5, §24). Mirrors the streaming_addons admin-service
 * conventions (admin-addons.ts) so the CloudStream domain deliberately:
 *
 *   * never introduces a second addon registry or status model — the CS-1
 *     migration is the single source of truth for the catalog;
 *   * never fetches repository documents itself — every network operation
 *     goes through the SSRF-safe pipeline (fetchStremioManifest via the
 *     cloudstream/security facade: URL validation, redirect/DNS policy,
 *     connect-time re-validation, timeouts, body limits, JSON-only);
 *   * never trusts client-supplied repository metadata — the only client
 *     input is a repository URL (validated) or a row id (UUID-checked);
 *     previews and creates always re-fetch through the secure pipeline;
 *   * never executes remote plugin code — `.cs3` artifact URLs are
 *     persisted as METADATA ONLY (plan §2.4/§10.2);
 *   * performs NON-DESTRUCTIVE syncs: a failed index/list fetch never
 *     deletes valid extension rows; removal happens only on a fully
 *     successful sync; extension `enabled` state is always preserved
 *     unless explicitly changed by the admin.
 *
 * Safe-error contract: callers receive `CloudStreamRepositoryError`
 * (closed vocabulary, curated messages) or the raw Supabase error for
 * classification upstream. No SSRF/DNS/stack internals ever surface.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { CloudStreamRepositoryError, isPermanentRepositoryFailure } from './errors';
import { validateCloudStreamId } from './ids';
import {
  canonicalRepositoryUrlKey,
  parsePluginList,
  parseRepositoryIndex,
  validateRepositoryUrl,
  MAX_EXTENSIONS_PER_REPOSITORY,
} from './parse';
import { fetchCloudStreamJson } from '../security/fetch';
import { deriveAdapterStatus, lookupCloudStreamAdapter } from '../adapters/registry';
import {
  buildNuvioProviderMetadata,
  detectExtensionManifestKind,
  parseNuvioManifest,
  type NormalizedNuvioProvider,
} from '$lib/server/extensions/nuvio';
import {
  deriveAdapterState,
  effectiveMediaTypes,
} from '$lib/server/extensions/adapter-registry';
import type { CloudStreamExtensionRow } from '../extensions/service';
import type {
  CloudStreamAdapterStatus,
  CloudStreamExtensionPreview,
  CloudStreamRepositoryPreview,
  CloudStreamRepositoryStatus,
  CloudStreamRepositoryView,
  CloudStreamSyncDeps,
  CloudStreamSyncOutcome,
  NormalizedCloudStreamExtension,
  ParsedCloudStreamRepository,
} from '../types';

type CloudStreamClient = SupabaseClient<Database>;

type CloudStreamExtensionInsert = Database['public']['Tables']['cloudstream_extensions']['Insert'];
type CloudStreamRepositoryUpdate = Database['public']['Tables']['cloudstream_repositories']['Update'];

/** Maximum extensions surfaced inside the add-flow preview (UI bound). */
export const PREVIEW_EXTENSION_LIMIT = 60;

/** Raw snake_case row shape of cloudstream_repositories. */
export type CloudStreamRepositoryRow = {
  id: string;
  name: string;
  url: string;
  description: string | null;
  icon_url: string | null;
  enabled: boolean;
  status: string;
  integration_type: string;
  last_synced_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Discovery pipeline (shared by preview / create / sync)
// ---------------------------------------------------------------------------

type DiscoveryResult = {
  parsed: ParsedCloudStreamRepository;
  /** Normalized extensions from the SUCCESSFULLY fetched plugin lists (deduped, bounded). */
  extensions: NormalizedCloudStreamExtension[];
  /** Safe failure notes for plugin lists that could not be fetched/parsed. */
  listFailures: string[];
  /** True when every plugin list referenced by the index was fetched and parsed. */
  fullSuccess: boolean;
};

/** Maps one normalized Nuvio provider onto the unified catalog insert shape. */
function toNuvioExtension(provider: NormalizedNuvioProvider): NormalizedCloudStreamExtension {
  return {
    internalName: provider.id,
    name: provider.name,
    version: null,
    apiVersion: null,
    description: provider.description,
    authors: provider.author !== null ? [provider.author] : [],
    // Nuvio manifests have no single language field — contentLanguage lives
    // in provider metadata (nothing invented here).
    language: provider.contentLanguage.length > 0 ? provider.contentLanguage[0] : null,
    tvTypes: [...provider.rawTypes],
    // Nuvio has no .cs3 artifact — the JS module URL is the analogous inert
    // provenance field, stored on its own column (module_url).
    pluginUrl: null,
    pluginStatus: null,
    iconUrl: provider.logoUrl,
    fileHash: null,
    fileSizeBytes: null,
    // Provenance: the manifest document the provider was discovered from.
    sourceUrl: provider.manifestUrl,
    integrationType: 'nuvio',
    mediaTypes: [...provider.mediaTypes],
    moduleUrl: provider.moduleUrl,
    versionText: provider.versionText,
    providerMetadata: buildNuvioProviderMetadata(provider),
  };
}

/**
 * Runs the full discovery pipeline against a repository URL:
 * CS.json → pluginLists → plugins.json → normalized extension metadata.
 *
 * PHASE 2 (Unified Extension catalog): the fetched document is dispatched by
 * MANIFEST SCHEMA SIGNATURE before any CloudStream-specific parsing —
 *   * `pluginLists` present → CloudStream path (byte-identical to CS-1…CS-6
 *     behavior: same fetches, same parses, same failures);
 *   * `scrapers` array → Nuvio manifest path (the manifest itself is the
 *     provider list — ONE fetch, no plugin-list follow-ups, so Nuvio
 *     repositories never show "0 extensions" again);
 *   * `scrapers` present but malformed → INVALID_REPOSITORY (honest failure
 *     instead of a silently empty catalog);
 *   * neither → valid-empty CloudStream repository (unchanged).
 * Plugin lists are fetched SEQUENTIALLY (bounded: max 4 lists — inherently
 * bounded concurrency, gentle on remote hosts). A failing plugin list never
 * aborts the whole discovery — its failure is recorded and the remaining
 * lists are still synced (partial success).
 */
async function discoverRepository(rawUrl: string, deps: CloudStreamSyncDeps = {}): Promise<DiscoveryResult> {
  const fetchDeps = {
    ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
    ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.maxBytes !== undefined ? { maxBytes: deps.maxBytes } : {}),
  };
  const { body } = await fetchCloudStreamJson(rawUrl, fetchDeps);

  // ---- Phase 2 schema dispatch ---------------------------------------
  const detection = detectExtensionManifestKind(body);
  if (detection.malformedScrapers) {
    throw new CloudStreamRepositoryError('INVALID_REPOSITORY', { message: 'The Nuvio manifest scrapers must be a list.' });
  }
  if (detection.kind === 'nuvio') {
    const manifest = parseNuvioManifest(body, rawUrl);
    const extensions = manifest.providers.slice(0, MAX_EXTENSIONS_PER_REPOSITORY).map(toNuvioExtension);
    return {
      parsed: {
        name: manifest.name,
        description: null,
        iconUrl: null,
        integrationType: 'nuvio',
        pluginLists: [],
      },
      extensions,
      listFailures: [],
      // Single-document discovery: the manifest itself is authoritative.
      fullSuccess: true,
    };
  }
  // ---- CloudStream path (unchanged from CS-1) ------------------------
  const parsed = parseRepositoryIndex(body);

  const extensions: NormalizedCloudStreamExtension[] = [];
  const seen = new Set<string>();
  const listFailures: string[] = [];

  for (const list of parsed.pluginLists) {
    if (extensions.length >= MAX_EXTENSIONS_PER_REPOSITORY) break;
    try {
      const { body: listBody } = await fetchCloudStreamJson(list.url, fetchDeps);
      const entries = parsePluginList(listBody);
      for (const entry of entries) {
        if (extensions.length >= MAX_EXTENSIONS_PER_REPOSITORY) break;
        const key = entry.internalName.toLowerCase();
        if (seen.has(key)) continue; // first occurrence wins across lists
        seen.add(key);
        extensions.push(entry);
      }
    } catch (error) {
      // Partial failure: record a SAFE message, keep syncing other lists.
      const message = error instanceof CloudStreamRepositoryError ? error.message : 'A plugin list could not be synced.';
      listFailures.push(message);
    }
  }

  return {
    parsed,
    extensions,
    listFailures,
    // Complete knowledge: the index parsed AND every referenced plugin list
    // was fetched. A repository with ZERO plugin lists also yields complete
    // knowledge (the discovered set is authoritatively empty).
    fullSuccess: listFailures.length === 0,
  };
}

/** Repository status derivation from the discovery outcome. */
function deriveRepositoryStatus(discovery: DiscoveryResult): { status: CloudStreamRepositoryStatus; lastError: string | null } {
  if (discovery.listFailures.length === 0) {
    // Full success (including the valid-but-empty zero-plugin-list case).
    return { status: 'active', lastError: null };
  }
  if (discovery.listFailures.length === discovery.parsed.pluginLists.length) {
    // EVERY referenced plugin list failed → error state.
    return { status: 'error', lastError: discovery.listFailures[0] ?? 'The repository plugin lists could not be synced.' };
  }
  // Partial failure: still active, with the safe error recorded.
  return {
    status: 'active',
    lastError: `${discovery.listFailures.length} of ${discovery.parsed.pluginLists.length} plugin lists could not be synced.`,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Maps a database row + extension count into the safe admin view model. */
function toRepositoryView(row: CloudStreamRepositoryRow, extensionCount: number): CloudStreamRepositoryView {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    description: row.description,
    iconUrl: row.icon_url,
    enabled: row.enabled,
    status: row.status as CloudStreamRepositoryView['status'],
    integrationType: row.integration_type === 'nuvio' ? 'nuvio' : 'cloudstream',
    extensionCount,
    lastSyncedAt: row.last_synced_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Lists all CloudStream repositories with their extension counts. */
export async function listRepositories(client: CloudStreamClient): Promise<CloudStreamRepositoryView[]> {
  const { data, error } = await client
    .from('cloudstream_repositories')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as unknown as CloudStreamRepositoryRow[];

  const { data: extData, error: extError } = await client
    .from('cloudstream_extensions')
    .select('repository_id');
  if (extError) throw extError;
  const counts = new Map<string, number>();
  for (const row of (extData ?? []) as unknown as Array<{ repository_id: string }>) {
    counts.set(row.repository_id, (counts.get(row.repository_id) ?? 0) + 1);
  }
  return rows.map((row) => toRepositoryView(row, counts.get(row.id) ?? 0));
}

// ---------------------------------------------------------------------------
// Preview (validation only — NO persistence)
// ---------------------------------------------------------------------------

function toExtensionPreview(extension: NormalizedCloudStreamExtension): CloudStreamExtensionPreview {
  return {
    internalName: extension.internalName,
    name: extension.name,
    version: extension.version,
    versionText: extension.versionText,
    language: extension.language,
    tvTypes: extension.tvTypes,
    adapterStatus: deriveAdapterStatusForExtension(extension),
    integrationType: extension.integrationType,
    mediaTypes: effectiveMediaTypes({
      integration_type: extension.integrationType,
      tv_types: extension.tvTypes,
      media_types: extension.mediaTypes,
    }),
  };
}

/**
 * TYPE-AWARE legacy adapter_status derivation (Phase 2): a Nuvio provider
 * never claims 'compatible' via the CloudStream code registry even when its
 * provider id collides with a native adapter id (e.g. 'MoviesDrive' exists in
 * both ecosystems). Nuvio rows are honestly 'adapter_required' until a Nuvio
 * adapter exists (Phase 3+).
 */
function deriveAdapterStatusForExtension(extension: NormalizedCloudStreamExtension): CloudStreamAdapterStatus {
  if (extension.integrationType === 'nuvio') return 'adapter_required';
  return deriveAdapterStatus(extension.internalName, extension.pluginStatus);
}

/** Safe preview of a CloudStream repository — discovery only, NO persistence. */
export async function previewRepository(
  client: CloudStreamClient,
  rawUrl: unknown,
  deps: CloudStreamSyncDeps = {},
): Promise<CloudStreamRepositoryPreview> {
  const repositoryUrl = validateRepositoryUrl(rawUrl);
  await assertRepositoryUrlNotConfigured(client, repositoryUrl);
  const discovery = await discoverRepository(repositoryUrl, deps);
  const total = discovery.extensions.length;
  const shown = discovery.extensions.slice(0, PREVIEW_EXTENSION_LIMIT);
  return {
    // The validated URL is echoed back so the confirmation round-trip
    // re-submits exactly what was validated (the confirm action re-validates
    // and re-fetches server-side anyway — nothing here is trusted client-side).
    repositoryUrl,
    name: discovery.parsed.name,
    description: discovery.parsed.description,
    iconUrl: discovery.parsed.iconUrl,
    integrationType: discovery.parsed.integrationType,
    pluginListCount: discovery.parsed.pluginLists.length,
    extensionCount: total,
    extensions: shown.map(toExtensionPreview),
    truncated: total > shown.length,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Creates a CloudStream repository from a validated URL (add flow).
 * New repositories start DISABLED (streaming_addons precedent): they
 * participate in nothing until the administrator explicitly enables them.
 * Partial plugin-list failures still persist the repository with whatever
 * extensions were discovered, recording the safe error on the row.
 */
export async function createRepositoryFromUrl(
  client: CloudStreamClient,
  rawUrl: unknown,
  deps: CloudStreamSyncDeps = {},
): Promise<{ repository: CloudStreamRepositoryView; outcome: CloudStreamSyncOutcome }> {
  const repositoryUrl = validateRepositoryUrl(rawUrl);
  await assertRepositoryUrlNotConfigured(client, repositoryUrl);
  const discovery = await discoverRepository(repositoryUrl, deps);
  const { status, lastError } = deriveRepositoryStatus(discovery);
  const now = (deps.now ?? (() => new Date().toISOString()))();

  const row: CloudStreamRepositoryRow = {
    id: crypto.randomUUID(),
    name: discovery.parsed.name,
    url: repositoryUrl,
    description: discovery.parsed.description,
    icon_url: discovery.parsed.iconUrl,
    enabled: false,
    status,
    integration_type: discovery.parsed.integrationType,
    last_synced_at: status === 'active' ? now : null,
    last_checked_at: now,
    last_error: lastError,
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await client
    .from('cloudstream_repositories')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  const created = data as unknown as CloudStreamRepositoryRow;

  const outcome = await reconcileExtensions(client, created.id, discovery.extensions, now, true);
  const repository = toRepositoryView(created, outcome.insertedCount);
  const syncOutcome: CloudStreamSyncOutcome = {
    repositoryId: created.id,
    status,
    discoveredCount: discovery.extensions.length,
    insertedCount: outcome.insertedCount,
    updatedCount: outcome.updatedCount,
    removedCount: outcome.removedCount,
    lastError,
  };
  return { repository, outcome: syncOutcome };
}

// ---------------------------------------------------------------------------
// Sync (refresh) — NON-DESTRUCTIVE
// ---------------------------------------------------------------------------

/**
 * Re-syncs one repository through the secure pipeline (mirror of
 * refreshAddonById): re-fetches the STORED repository URL (never a
 * client-supplied URL), reconciles discovered extensions, updates metadata,
 * preserves the enabled state of every existing extension, and removes rows
 * ONLY when the sync was fully successful AND the extension is genuinely
 * absent from the repository. A failed index fetch marks the repository
 * error/invalid and leaves every extension row untouched.
 */
export async function syncRepositoryById(
  client: CloudStreamClient,
  id: unknown,
  deps: CloudStreamSyncDeps = {},
): Promise<CloudStreamSyncOutcome> {
  const repositoryId = validateCloudStreamId(id, 'Repository');
  const { data: existing, error } = await client
    .from('cloudstream_repositories')
    .select('*')
    .eq('id', repositoryId)
    .maybeSingle();
  if (error) throw error;
  if (!existing) throw new CloudStreamRepositoryError('NOT_FOUND', { message: 'Repository not found.' });
  const existingRow = existing as unknown as CloudStreamRepositoryRow;

  const now = (deps.now ?? (() => new Date().toISOString()))();
  let discovery: DiscoveryResult;
  try {
    discovery = await discoverRepository(existingRow.url, deps);
  } catch (syncError) {
    // Index fetch/parse failed: record health, NEVER touch extension rows.
    // Permanent failures (bad URL / blocked destination / malformed index)
    // mark the repository invalid; transient failures mark it error.
    if (syncError instanceof CloudStreamRepositoryError && isPermanentRepositoryFailure(syncError)) {
      await updateRepositoryRow(client, repositoryId, {
        status: 'invalid',
        last_checked_at: now,
        last_error: syncError.message,
      });
      return {
        repositoryId,
        status: 'invalid',
        discoveredCount: 0,
        insertedCount: 0,
        updatedCount: 0,
        removedCount: 0,
        lastError: syncError.message,
      };
    }
    const message = syncError instanceof CloudStreamRepositoryError ? syncError.message : 'The repository could not be synced.';
    await updateRepositoryRow(client, repositoryId, {
      status: 'error',
      last_checked_at: now,
      last_error: message,
    });
    return {
      repositoryId,
      status: 'error',
      discoveredCount: 0,
      insertedCount: 0,
      updatedCount: 0,
      removedCount: 0,
      lastError: message,
    };
  }

  const { status, lastError } = deriveRepositoryStatus(discovery);
  const outcome = await reconcileExtensions(client, repositoryId, discovery.extensions, now, discovery.fullSuccess);
  await updateRepositoryRow(client, repositoryId, {
    status,
    last_checked_at: now,
    ...(status === 'active' ? { last_synced_at: now } : {}),
    last_error: lastError,
  });

  return {
    repositoryId,
    status,
    discoveredCount: discovery.extensions.length,
    insertedCount: outcome.insertedCount,
    updatedCount: outcome.updatedCount,
    removedCount: outcome.removedCount,
    lastError,
  };
}

// ---------------------------------------------------------------------------
// Enable / disable + delete
// ---------------------------------------------------------------------------

/** Enables or disables a repository (server-persisted; status/health untouched). */
export async function setRepositoryEnabled(client: CloudStreamClient, id: unknown, enabled: boolean): Promise<void> {
  const repositoryId = validateCloudStreamId(id, 'Repository');
  const { data, error } = await client
    .from('cloudstream_repositories')
    .update({ enabled })
    .eq('id', repositoryId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new CloudStreamRepositoryError('NOT_FOUND', { message: 'Repository not found.' });
}

/** Deletes a repository; extensions cascade via the FK (derived catalog data). */
export async function deleteRepositoryById(client: CloudStreamClient, id: unknown): Promise<void> {
  const repositoryId = validateCloudStreamId(id, 'Repository');
  const { data, error } = await client
    .from('cloudstream_repositories')
    .delete()
    .eq('id', repositoryId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new CloudStreamRepositoryError('NOT_FOUND', { message: 'Repository not found.' });
}

// ---------------------------------------------------------------------------
// Extension reconciliation (the sync core)
// ---------------------------------------------------------------------------

type ExtensionInsertRow = CloudStreamExtensionInsert;

/**
 * Reconciles the discovered extension set against the persisted rows for one
 * repository:
 *   * existing rows keep their `enabled` state (PRESERVED) and gain the new
 *     metadata (update via upsert);
 *   * new internal names are inserted with enabled=false (additive);
 *   * rows whose internal name vanished from the repository are deleted ONLY
 *     when `allowRemoval` (the sync was fully successful — every referenced
 *     plugin list was fetched). Partial failures NEVER delete rows.
 *
 * PHASE 2 (unified catalog): the same single upsert writes BOTH integration
 * types — integration_type, canonical media_types, the derived adapter_state
 * snapshot, and the type-specific columns (module_url / version_text /
 * provider_metadata for Nuvio rows; null for CloudStream rows). The
 * Phase-3-Builder columns (last_tested_at / last_test_error) are NEVER
 * written here — validation facts belong to the future Builder/Tester.
 *
 * A single upsert (conflict target repository_id+internal_name) writes the
 * merged set deterministically.
 */
async function reconcileExtensions(
  client: CloudStreamClient,
  repositoryId: string,
  discovered: NormalizedCloudStreamExtension[],
  now: string,
  allowRemoval: boolean,
): Promise<{ insertedCount: number; updatedCount: number; removedCount: number }> {
  const { data: existingData, error } = await client
    .from('cloudstream_extensions')
    .select('*')
    .eq('repository_id', repositoryId);
  if (error) throw error;
  const existing = (existingData ?? []) as unknown as CloudStreamExtensionRow[];
  const existingByKey = new Map(existing.map((row) => [row.internal_name.toLowerCase(), row]));

  const merged: ExtensionInsertRow[] = [];
  const discoveredKeys = new Set<string>();
  let insertedCount = 0;
  let updatedCount = 0;

  for (const extension of discovered) {
    const key = extension.internalName.toLowerCase();
    discoveredKeys.add(key);
    // Type-aware legacy status + binding (Nuvio rows never bind the
    // CloudStream code registry — see deriveAdapterStatusForExtension).
    const adapterStatus = deriveAdapterStatusForExtension(extension);
    const adapter = adapterStatus === 'compatible' ? lookupCloudStreamAdapter(extension.internalName) : null;
    const existingRow = existingByKey.get(key);
    // Phase 2: persisted lifecycle snapshot — type-aware (a Nuvio row never
    // derives 'native' even when its provider id matches a CloudStream
    // adapter); Builder outcomes are never written by sync code.
    const adapterState = deriveAdapterState(
      {
        integration_type: extension.integrationType,
        internal_name: extension.internalName,
        plugin_status: extension.pluginStatus,
      },
      existingRow?.adapter_state ?? null,
    );
    const baseRow = {
      repository_id: repositoryId,
      internal_name: extension.internalName,
      name: extension.name,
      version: extension.version,
      api_version: extension.apiVersion,
      description: extension.description,
      authors: extension.authors,
      language: extension.language,
      tv_types: extension.tvTypes,
      plugin_url: extension.pluginUrl,
      plugin_status: extension.pluginStatus,
      icon_url: extension.iconUrl,
      file_hash: extension.fileHash,
      file_size_bytes: extension.fileSizeBytes,
      source_url: extension.sourceUrl,
      // Phase 2 — unified Extension catalog columns.
      integration_type: extension.integrationType,
      media_types: extension.mediaTypes,
      adapter_state: adapterState,
      module_url: extension.moduleUrl,
      version_text: extension.versionText,
      provider_metadata: extension.providerMetadata,
      adapter_status: adapterStatus,
      mavero_adapter_id: adapter?.id ?? null,
      adapter_version: adapter?.version ?? null,
      last_checked_at: now,
      last_error: null,
      updated_at: now,
    };
    if (existingRow) {
      updatedCount += 1;
      merged.push({
        ...baseRow,
        id: existingRow.id,
        // PRESERVED across syncs unless explicitly changed by the admin.
        enabled: existingRow.enabled,
        created_at: existingRow.created_at,
      });
    } else {
      insertedCount += 1;
      merged.push({
        ...baseRow,
        id: crypto.randomUUID(),
        // New extensions start DISABLED (streaming_addons precedent).
        enabled: false,
        created_at: now,
      });
    }
  }

  if (merged.length > 0) {
    const { error: upsertError } = await client
      .from('cloudstream_extensions')
      .upsert(merged, { onConflict: 'repository_id,internal_name' });
    if (upsertError) throw upsertError;
  }

  // Removals: only on a fully successful sync, only for internal names that
  // are genuinely absent from the repository. Partial failures skip removal
  // entirely (conservative — staleness beats data loss).
  const removedNames = existing
    .map((row) => row.internal_name)
    .filter((name) => !discoveredKeys.has(name.toLowerCase()));
  let removedCount = 0;
  if (allowRemoval && removedNames.length > 0) {
    const { error: deleteError } = await client
      .from('cloudstream_extensions')
      .delete()
      .eq('repository_id', repositoryId)
      .in('internal_name', removedNames);
    if (deleteError) throw deleteError;
    removedCount = removedNames.length;
  }

  return { insertedCount, updatedCount, removedCount };
}

/** Persists a health patch on the repository row. */
async function updateRepositoryRow(client: CloudStreamClient, repositoryId: string, patch: CloudStreamRepositoryUpdate): Promise<void> {
  const { error } = await client
    .from('cloudstream_repositories')
    .update(patch)
    .eq('id', repositoryId);
  if (error) throw error;
}

/** Rejects repository URLs whose canonical identity is already configured. */
async function assertRepositoryUrlNotConfigured(client: CloudStreamClient, repositoryUrl: string): Promise<void> {
  const { data, error } = await client.from('cloudstream_repositories').select('url');
  if (error) throw error;
  const key = canonicalRepositoryUrlKey(repositoryUrl);
  const duplicate = (data ?? []).some(
    (row) => canonicalRepositoryUrlKey((row as { url: string }).url) === key,
  );
  if (duplicate) throw new CloudStreamRepositoryError('DUPLICATE_REPOSITORY');
}
