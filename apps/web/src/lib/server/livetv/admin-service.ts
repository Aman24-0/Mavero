// ============================================================================
// Unified Live TV — Phase 4 admin management service (server-only).
//
// The ONE administrative data layer behind /admin/system/livetv: CRUD,
// enablement, deterministic priority ordering, canonical-channel mapping,
// playback-candidate management, EPG source/mapping management, delete-impact
// accounting and bounded diagnostics — over the EXISTING Phase 1–3 tables.
//
// NON-NEGOTIABLE BOUNDARIES (Phase 4 brief §3/§4/§5):
//   * Phase 2/3 pipelines are REUSED, never duplicated: refresh/preview run
//     through `refresh-service.ts` / `epg/guide-service.ts`; config identity
//     validation through `registry.ts`; EPG config/identity through
//     `epg/guide-service.ts` + `epg/mapping.ts`. There is NO second fetcher,
//     NO second parser and NO second mapping registry here.
//   * The admin-owned field set is exactly what the Phase 2 ingestion never
//     writes: source-channel `canonical_channel_id` + `enabled`, endpoint
//     `enabled` + `ordering`. Mutating rows the next refresh would resurrect
//     (URL/kind/format edits or deletes on adapter-fed endpoints, entry
//     deletes) is REFUSED for adapter-fed sources — honest CRUD, not invented.
//   * `livetv_config_meta` (and therefore `unified_enabled`) is READ-ONLY
//     here — the master rollback lever is never flipped by admin tooling.
//   * NO playback dispatch, NO candidate auto-materialization, NO
//     user-visible behaviour change: this module only manages configuration.
//   * Diagnostics are bounded and safe: typed failure kinds + counts +
//     bounded samples; no raw upstream payloads, no credentials (upstream
//     URLs are admin-CONFIGURED data — validated https, credential-free by
//     the registry guards — and are shown back only in edit/inspect forms).
//
// ERROR MODEL: every mutation validates first (typed `LivetvAdminError`
// with a safe, actionable message), then performs a bounded write. Known DB
// constraint failures (unique/FK/check/protect triggers) are mapped to the
// same safe messages — a raw Postgres error never reaches the client.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../supabase/database.types';
import { getLivetvRefreshHistoryPage } from './history';
import {
  LIVETV_SOURCE_STATUSES,
  LIVETV_SOURCE_TYPES,
  LIVETV_VISIBILITIES,
  LivetvRegistryValidationError,
  validateLivetvEndpointInput,
  validateLivetvSourceConfig,
  type LivetvEndpointInput,
  type LivetvSourceStatus,
  type LivetvSourceType,
  type LivetvVisibility
} from './registry';
import { validateEpgSourceConfig, type LivetvEpgSourceConfig } from './epg/guide-service';
import { normalizeEpgIdentity, planEpgMapping, type EpgMappingRow, type EpgSourceChannelRow } from './epg/mapping';

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export class LivetvAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LivetvAdminError';
  }
}

function fail(message: string): never {
  throw new LivetvAdminError(message);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 120;
const NAME_MAX_LENGTH = 120;
const CHANNEL_NAME_MAX_LENGTH = 200;
const CATEGORY_MAX_LENGTH = 120;
const URL_MAX_LENGTH = 2048;
const NOTES_MAX_LENGTH = 2000;
const DESCRIPTION_MAX_LENGTH = 1000;
const PRIORITY_MIN = 0;
const PRIORITY_MAX = 100000;
/** Bounded row budgets for table-wide admin reads (Phase 4 scale, documented). */
const LIST_ROWS_CAP = 500;
const DIAGNOSTICS_ROW_CAP = 5000;
const MAPPINGS_LIST_CAP = 500;

function requireUuid(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) fail(`${label} is invalid.`);
  return raw;
}

function requireTrimmedText(raw: unknown, label: string, maxLength: number): string {
  if (typeof raw !== 'string') fail(`${label} is required.`);
  const trimmed = raw.trim();
  if (!trimmed) fail(`${label} is required.`);
  if (trimmed.length > maxLength) fail(`${label} must be ${maxLength} characters or fewer.`);
  return trimmed;
}

function optionalTrimmedText(raw: unknown, label: string, maxLength: number): string | null {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return null;
  return requireTrimmedText(raw, label, maxLength);
}

function requirePriority(raw: unknown, label = 'Priority'): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < PRIORITY_MIN || value > PRIORITY_MAX) {
    fail(`${label} must be an integer between ${PRIORITY_MIN} and ${PRIORITY_MAX}.`);
  }
  return value;
}

function requireBoolean(raw: unknown, label: string): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${label} must be a boolean.`);
}

/** https-only, credential-free, control-char-free display URL (DB CHECK parity). */
function optionalHttpsUrl(raw: unknown, label: string): string | null {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return null;
  if (typeof raw !== 'string') fail(`${label} must be a string.`);
  const trimmed = raw.trim();
  if (!trimmed.startsWith('https://')) fail(`${label} must use https.`);
  if (trimmed.length > URL_MAX_LENGTH) fail(`${label} must be ${URL_MAX_LENGTH} characters or fewer.`);
  if (/\s/.test(trimmed)) fail(`${label} must not contain whitespace.`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) fail(`${label} must not contain control characters.`);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    fail(`${label} is not a valid absolute URL.`);
  }
  if (url.username || url.password) fail(`${label} must not contain credentials.`);
  return trimmed;
}

/** Dedup key: null or 8..200 of [a-z0-9:_-] (DB CHECK parity). */
function optionalDedupKey(raw: unknown): string | null {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return null;
  if (typeof raw !== 'string') fail('Dedup key must be a string.');
  const trimmed = raw.trim();
  if (trimmed.length < 8 || trimmed.length > 200) fail('Dedup key must be 8-200 characters.');
  if (!/^[a-z0-9:_-]+$/.test(trimmed)) fail('Dedup key may only contain a-z, 0-9, ":", "_" and "-".');
  return trimmed;
}

/** Derives a slug from a display name (deterministic; admin may override). */
export function deriveSlugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  if (!slug) fail('Could not derive a slug from the name — provide one explicitly.');
  return slug;
}

function validateSlug(raw: unknown, fallbackName: string | null): string {
  const candidate = raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim()) ? (fallbackName ? deriveSlugFromName(fallbackName) : null) : String(raw).trim();
  if (!candidate) fail('Slug is required.');
  if (candidate.length > SLUG_MAX_LENGTH) fail(`Slug must be ${SLUG_MAX_LENGTH} characters or fewer.`);
  if (!SLUG_PATTERN.test(candidate)) fail('Slug may only contain lowercase letters, digits and single dashes.');
  return candidate;
}

// ---------------------------------------------------------------------------
// DB error mapping — safe messages for known constraint failures
// ---------------------------------------------------------------------------

type DbFailure = { code?: string; message?: string; details?: string; hint?: string } | null | undefined;

function dbFailureText(error: unknown): string {
  if (error && typeof error === 'object') {
    const typed = error as NonNullable<DbFailure>;
    return `${typed.code ?? ''} ${typed.message ?? ''}`.trim();
  }
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

/** Maps a known DB constraint failure to a safe, actionable admin message. */
export function mapLivetvDbError(error: unknown, fallback: string): LivetvAdminError {
  const text = dbFailureText(error);
  if (/LIVETV_BUILTIN_SOURCE_PROTECTED/.test(text)) {
    return new LivetvAdminError('The built-in LiveGT V1 source cannot be deleted.');
  }
  if (/LIVETV_CANDIDATE_CHANNEL_MISMATCH/.test(text)) {
    return new LivetvAdminError('The endpoint does not belong to a source channel mapped to this canonical channel.');
  }
  if (/livetv_sources_slug_key|duplicate key.*livetv_sources.*slug/i.test(text)) {
    return new LivetvAdminError('That slug is already in use by another source.');
  }
  if (/duplicate key.*livetv_channels.*dedup_key/i.test(text)) {
    return new LivetvAdminError('That dedup key is already in use by another canonical channel.');
  }
  if (/duplicate key.*livetv_epg_channel_mappings.*epg_source_id_channel_id/i.test(text)) {
    return new LivetvAdminError('This canonical channel already has a mapping on this EPG source.');
  }
  if (/duplicate key.*livetv_epg_channel_mappings.*epg_source_id_epg_channel_id/i.test(text)) {
    return new LivetvAdminError('This guide channel id is already mapped on this EPG source.');
  }
  if (/duplicate key.*livetv_playback_candidates/i.test(text)) {
    return new LivetvAdminError('This endpoint is already a candidate for this channel.');
  }
  if (/duplicate key.*livetv_playback_endpoints/i.test(text)) {
    return new LivetvAdminError('An endpoint with this URL already exists for this source channel.');
  }
  if (/\b23503\b|violates foreign key constraint/i.test(text)) {
    return new LivetvAdminError('The referenced record no longer exists — refresh the page and try again.');
  }
  if (/\b23514\b|violates check constraint/i.test(text)) {
    return new LivetvAdminError('The submitted values violate the database constraints (kind/format pairing or field bounds).');
  }
  if (/FetchError|TypeError.*fetch|network/i.test(text)) {
    return new LivetvAdminError('The registry update may still be processing. Refresh to confirm the state.');
  }
  // Plain Error messages pass through verbatim — every error thrown inside
  // this module is already a static, safe, actionable string (the redaction
  // suite pins this); only non-Error values get the generic fallback.
  if (error instanceof Error && error.message) return new LivetvAdminError(error.message);
  return new LivetvAdminError(fallback);
}

async function executeOrMap<T>(run: () => Promise<T>, fallback: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof LivetvAdminError) throw error;
    if (error instanceof LivetvRegistryValidationError) throw new LivetvAdminError(error.message);
    throw mapLivetvDbError(error, fallback);
  }
}

// ---------------------------------------------------------------------------
// Row shapes (structural mirrors of database.types.ts; kept minimal)
// ---------------------------------------------------------------------------

export type LivetvAdminSourceRow = {
  id: string;
  slug: string;
  name: string;
  source_type: LivetvSourceType;
  builtin: boolean;
  enabled: boolean;
  status: LivetvSourceStatus;
  priority: number;
  visibility: LivetvVisibility;
  config: Record<string, unknown>;
  description: string | null;
  updated_at: string;
  /** Entries imported for this source (embedded exact count; null when unavailable). */
  entry_count: number | null;
};

export type LivetvAdminChannelRow = {
  id: string;
  name: string;
  category: string | null;
  logo_url: string | null;
  dedup_key: string | null;
  enabled: boolean;
  notes: string | null;
  updated_at: string;
  entry_count: number | null;
  candidate_count: number | null;
  epg_mapping_count: number | null;
};

export type LivetvAdminEntryRow = {
  id: string;
  source_id: string;
  source_channel_id: string;
  canonical_channel_id: string | null;
  name: string;
  category: string | null;
  logo_url: string | null;
  tvg_id: string | null;
  enabled: boolean;
};

export type LivetvAdminEndpointRow = {
  id: string;
  source_channel_id: string;
  endpoint_kind: string;
  stream_format: string | null;
  url: string;
  ordering: number;
  enabled: boolean;
  label: string | null;
};

export type LivetvAdminCandidateRow = {
  id: string;
  channel_id: string;
  endpoint_id: string;
  priority: number;
  enabled: boolean;
};

export type LivetvAdminEpgSourceRow = {
  id: string;
  slug: string;
  name: string;
  epg_type: string;
  source_url: string | null;
  enabled: boolean;
  status: LivetvSourceStatus;
  config: Record<string, unknown>;
  description: string | null;
  updated_at: string;
  mapping_count: number | null;
  programme_count: number | null;
};

export type LivetvAdminEpgMappingRow = {
  id: string;
  epg_source_id: string;
  channel_id: string;
  epg_channel_id: string;
  channel_name: string | null;
};

// ---------------------------------------------------------------------------
// Counts helper (bounded exact counts via head requests)
// ---------------------------------------------------------------------------

type CountFilter = [column: string, value: string | boolean];

async function exactCount(client: SupabaseClient<Database>, table: keyof Database['public']['Tables'], filters: CountFilter[] = []): Promise<number | null> {
  let query = client.from(table).select('id', { count: 'exact', head: true });
  for (const [column, value] of filters) query = query.eq(column, value as never);
  const { count, error } = await query;
  if (error) return null;
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Sources — list / create / update / enable / priority / delete impact
// ---------------------------------------------------------------------------

export async function listLivetvSources(client: SupabaseClient<Database>): Promise<LivetvAdminSourceRow[]> {
  const { data, error } = await client
    .from('livetv_sources')
    .select('id, slug, name, source_type, builtin, enabled, status, priority, visibility, config, description, updated_at, livetv_source_channels(count)')
    .order('priority', { ascending: true })
    .order('slug', { ascending: true })
    .limit(LIST_ROWS_CAP);
  if (error) fail('The source list could not be loaded.');
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row['id']),
    slug: String(row['slug']),
    name: String(row['name']),
    source_type: row['source_type'] as LivetvSourceType,
    builtin: Boolean(row['builtin']),
    enabled: Boolean(row['enabled']),
    status: row['status'] as LivetvSourceStatus,
    priority: Number(row['priority'] ?? 0),
    visibility: row['visibility'] as LivetvVisibility,
    config: (row['config'] && typeof row['config'] === 'object' && !Array.isArray(row['config']) ? row['config'] : {}) as Record<string, unknown>,
    description: (row['description'] as string | null) ?? null,
    updated_at: String(row['updated_at'] ?? ''),
    entry_count: extractEmbedCount(row['livetv_source_channels'])
  }));
}

/** Extracts the exact count from a PostgREST `relation(count)` embed cell. */
function extractEmbedCount(cell: unknown): number | null {
  if (!Array.isArray(cell) || cell.length === 0) return cell === null ? null : 0;
  const first = cell[0] as Record<string, unknown> | undefined;
  const count = first?.['count'];
  return typeof count === 'number' ? count : null;
}

export type LivetvSourceCreateInput = {
  slug?: unknown;
  name: unknown;
  sourceType: unknown;
  status?: unknown;
  visibility?: unknown;
  priority?: unknown;
  enabled?: unknown;
  description?: unknown;
  config: unknown;
};

export async function createLivetvSource(client: SupabaseClient<Database>, input: LivetvSourceCreateInput): Promise<{ id: string; slug: string }> {
  const name = requireTrimmedText(input.name, 'Source name', NAME_MAX_LENGTH);
  const sourceType = requireTrimmedText(input.sourceType, 'Source type', 40);
  if (!LIVETV_SOURCE_TYPES.includes(sourceType as LivetvSourceType)) fail('Source type is not supported.');
  if (sourceType === 'builtin_livegt_v1') fail('The built-in LiveGT V1 source is seeded by the system and cannot be created manually.');
  const slug = validateSlug(input.slug, name);
  const status = normalizeStatus(input.status);
  const visibility = normalizeVisibility(input.visibility);
  const priority = input.priority === undefined ? 100 : requirePriority(input.priority);
  const enabled = input.enabled === undefined ? false : requireBoolean(input.enabled, 'Enabled');
  const description = optionalTrimmedText(input.description, 'Description', DESCRIPTION_MAX_LENGTH);
  const config = validateLivetvSourceConfig(sourceType as LivetvSourceType, input.config) as Record<string, unknown>;

  return executeOrMap(async () => {
    const { data, error } = await client
      .from('livetv_sources')
      .insert({ slug, name, source_type: sourceType, builtin: false, enabled, status, priority, visibility, config: config as Json, description })
      .select('id, slug')
      .single();
    if (error || !data) throw error ?? new Error('insert returned no row');
    return { id: String(data['id']), slug: String(data['slug']) };
  }, 'Unable to create the source.');
}

export type LivetvSourceUpdateInput = {
  name?: unknown;
  status?: unknown;
  visibility?: unknown;
  priority?: unknown;
  description?: unknown;
  config?: unknown;
};

/**
 * Updates an existing source. IMMUTABLE by design: slug, source_type and the
 * builtin flag never change after creation (a type change would orphan the
 * adapter contract; a slug change would break stored references).
 */
export async function updateLivetvSource(client: SupabaseClient<Database>, sourceId: unknown, input: LivetvSourceUpdateInput): Promise<void> {
  const id = requireUuid(sourceId, 'Source');
  const patch: Database['public']['Tables']['livetv_sources']['Update'] = {};

  if (input.name !== undefined) patch.name = requireTrimmedText(input.name, 'Source name', NAME_MAX_LENGTH);
  if (input.status !== undefined) patch.status = normalizeStatus(input.status);
  if (input.visibility !== undefined) patch.visibility = normalizeVisibility(input.visibility);
  if (input.priority !== undefined) patch.priority = requirePriority(input.priority);
  if (input.description !== undefined) patch.description = optionalTrimmedText(input.description, 'Description', DESCRIPTION_MAX_LENGTH);
  if (input.config !== undefined) {
    const existing = await loadSourceType(client, id);
    if (!existing) fail('The source no longer exists.');
    const config = validateLivetvSourceConfig(existing.source_type, input.config);
    patch.config = config as Json;
  }
  if (Object.keys(patch).length === 0) fail('Nothing to update.');

  await executeOrMap(async () => {
    // R-0 honesty fix: an UPDATE matching zero rows (the source was deleted
    // concurrently between the edit-open and the submit) previously resolved
    // as SUCCESS. The write is only successful when the row really changed.
    const { data, error } = await client.from('livetv_sources').update(patch).eq('id', id).select('id').single();
    if (error || !data) fail('The source no longer exists.');
  }, 'Unable to update the source.');
}

export async function setLivetvSourceEnabled(client: SupabaseClient<Database>, sourceId: unknown, enabled: unknown): Promise<void> {
  const id = requireUuid(sourceId, 'Source');
  const value = requireBoolean(enabled, 'Enabled');
  await executeOrMap(async () => {
    // R-0 honesty fix: the toggle reports success only when the row really
    // changed (a 0-row match — concurrent delete — is a typed failure, never
    // a silent "Source state updated.").
    const { data, error } = await client.from('livetv_sources').update({ enabled: value }).eq('id', id).select('id').single();
    if (error || !data) fail('The source no longer exists.');
  }, 'Unable to change the source state.');
}

/** The per-source slice of the latest DURABLE refresh attempt (R-0). */
export type LivetvSourceLatestHistory = {
  status: string;
  finishedAt: string | null;
  trigger: string;
};

/**
 * The latest durable refresh-history row per SOURCE (R-0): the Playback
 * Sources table shows, when available, each source's last durable attempt
 * (status + finished time + trigger) instead of only the instance-local
 * in-memory record. Bounded read (LIVETV_HISTORY_MAX_PAGE newest rows,
 * grouped in memory). NEVER throws: a missing/unreadable history table
 * (RLS surprise, migration not yet applied) degrades to an empty map —
 * the column then falls back to the instance-local outcomes, and to '—'
 * when neither exists. Fail-open DIAGNOSTICS only: this surface never
 * gates refresh or playback.
 */
export async function getLatestLivetvRefreshHistoryBySource(client: SupabaseClient<Database>): Promise<Map<string, LivetvSourceLatestHistory>> {
  const latest = new Map<string, LivetvSourceLatestHistory>();
  const rows = await getLivetvRefreshHistoryPage(client, { limit: 300, subjectKind: 'source' });
  for (const row of rows) {
    // Rows arrive newest-first; the FIRST occurrence per source is the
    // most recent durable attempt.
    if (latest.has(row.subject_id)) continue;
    latest.set(row.subject_id, {
      status: String(row.status),
      finishedAt: (row.finished_at as string | null) ?? null,
      trigger: String(row.trigger_type ?? 'manual')
    });
  }
  return latest;
}

/**
 * Deterministic source priority ordering: the payload carries a priority for
 * EVERY source (completeness is validated — partial sets are rejected) and
 * duplicates are rejected. Values are admin-owned default ordering keys
 * (lower attempted first); this never encodes a playback engine.
 */
export async function reorderLivetvSources(client: SupabaseClient<Database>, positions: Array<{ id: string; priority: number }>): Promise<void> {
  if (!positions.length) fail('The reordering payload is empty.');
  const seen = new Set<string>();
  const priorities = new Set<number>();
  for (const position of positions) {
    const id = requireUuid(position.id, 'Source');
    if (seen.has(id)) fail('A source has more than one priority value.');
    seen.add(id);
    const priority = requirePriority(position.priority, 'Priority');
    if (priorities.has(priority)) fail('Duplicate priority values are not allowed — sources must be uniquely ordered.');
    priorities.add(priority);
  }

  const { data, error } = await client.from('livetv_sources').select('id').limit(LIST_ROWS_CAP);
  if (error) fail('The source list could not be loaded.');
  const existing = new Set(((data ?? []) as unknown as Array<{ id: string }>).map((row) => row.id));
  for (const id of seen) {
    if (!existing.has(id)) fail('The reordering payload does not match the current source list.');
  }
  if (existing.size !== seen.size) fail('The reordering payload must cover EVERY source.');

  await executeOrMap(async () => {
    for (const position of positions) {
      const { error: updateError } = await client.from('livetv_sources').update({ priority: position.priority }).eq('id', position.id);
      if (updateError) throw updateError;
    }
  }, 'Unable to save the source ordering.');
}

export type LivetvSourceDeleteImpact = {
  id: string;
  slug: string;
  name: string;
  builtin: boolean;
  entries: number | null;
  endpoints: number | null;
  candidates: number | null;
};

/**
 * Impact preview for the confirmed-delete flow. Bounded embedded counts —
 * nothing is deleted by this call.
 */
export async function describeLivetvSourceDeleteImpact(client: SupabaseClient<Database>, sourceId: unknown): Promise<LivetvSourceDeleteImpact> {
  const id = requireUuid(sourceId, 'Source');
  const { data, error } = await client
    .from('livetv_sources')
    .select('id, slug, name, builtin, livetv_source_channels(count), livetv_source_channels(livetv_playback_endpoints(count)), livetv_source_channels(livetv_playback_endpoints(livetv_playback_candidates(count)))')
    .eq('id', id)
    .maybeSingle();
  if (error) fail('The source impact could not be computed.');
  const row = data as unknown as Record<string, unknown> | null;
  if (!row) fail('The source no longer exists.');

  // Nested embeds of the same relation return as SEPARATE top-level keys with
  // a PostgREST-generated suffix; find every embed whose key starts with the
  // relation name and read its deepest count.
  const keys = Object.keys(row).filter((key) => key.startsWith('livetv_source_channels'));
  let entries: number | null = null;
  let endpoints: number | null = null;
  let candidates: number | null = null;
  for (const key of keys) {
    const depth = (key.match(/livetv_/g) ?? []).length;
    const total = sumEmbedCounts(row[key]);
    if (total === null) continue;
    if (depth === 1 && entries === null) entries = total;
    else if (depth === 2 && endpoints === null) endpoints = total;
    else if (depth >= 3 && candidates === null) candidates = total;
  }
  return {
    id: String(row['id']),
    slug: String(row['slug']),
    name: String(row['name']),
    builtin: Boolean(row['builtin']),
    entries,
    endpoints,
    candidates
  };
}

/** Recursively sums `{ count }` leaves inside a PostgREST embed payload. */
function sumEmbedCounts(node: unknown): number | null {
  if (Array.isArray(node)) {
    let total = 0;
    let sawCount = false;
    for (const child of node) {
      const nested = sumEmbedCounts(child);
      if (nested === null) continue;
      total += nested;
      sawCount = true;
    }
    return sawCount || node.length === 0 ? total : null;
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (typeof record['count'] === 'number') return record['count'];
    let total = 0;
    let sawCount = false;
    for (const value of Object.values(record)) {
      const nested = sumEmbedCounts(value);
      if (nested === null) continue;
      total += nested;
      sawCount = true;
    }
    return sawCount ? total : null;
  }
  return null;
}

export async function deleteLivetvSource(client: SupabaseClient<Database>, sourceId: unknown): Promise<void> {
  const id = requireUuid(sourceId, 'Source');
  // Impact is BEST-EFFORT: if it cannot be computed, still allow the delete —
  // the database's delete-protection trigger guards the builtin source anyway.
  let builtin = false;
  try {
    const impact = await describeLivetvSourceDeleteImpact(client, id);
    builtin = impact.builtin;
  } catch {
    builtin = false;
  }
  if (builtin) fail('The built-in LiveGT V1 source cannot be deleted (it is delete-protected by the database).');
  await executeOrMap(async () => {
    const { error } = await client.from('livetv_sources').delete().eq('id', id);
    if (error) throw error;
  }, 'Unable to delete the source.');
}

// ---------------------------------------------------------------------------
// Shared normalizers
// ---------------------------------------------------------------------------

function normalizeStatus(raw: unknown): LivetvSourceStatus {
  const value = raw === undefined || raw === null || raw === '' ? 'experimental' : requireTrimmedText(raw, 'Status', 40);
  if (!LIVETV_SOURCE_STATUSES.includes(value as LivetvSourceStatus)) fail('Status must be one of: ' + LIVETV_SOURCE_STATUSES.join(', ') + '.');
  return value as LivetvSourceStatus;
}

function normalizeVisibility(raw: unknown): LivetvVisibility {
  const value = raw === undefined || raw === null || raw === '' ? 'internal' : requireTrimmedText(raw, 'Visibility', 20);
  if (!LIVETV_VISIBILITIES.includes(value as LivetvVisibility)) fail('Visibility must be public, internal or hidden.');
  return value as LivetvVisibility;
}

async function loadSourceType(client: SupabaseClient<Database>, sourceId: string): Promise<{ source_type: LivetvSourceType } | null> {
  const { data, error } = await client.from('livetv_sources').select('source_type').eq('id', sourceId).maybeSingle();
  if (error) fail('The source could not be loaded.');
  return (data as unknown as { source_type: LivetvSourceType } | null) ?? null;
}

// ---------------------------------------------------------------------------
// Imported source channels — paginated list / enable / canonical mapping
// ---------------------------------------------------------------------------

export type LivetvEntryListFilter = {
  sourceId?: string | null;
  mappingState?: 'all' | 'mapped' | 'unmapped';
  query?: string | null;
  page?: number;
  pageSize?: number;
};

export type LivetvEntryListResult = {
  rows: LivetvAdminEntryRow[];
  total: number;
  page: number;
  pageSize: number;
};

const ENTRY_PAGE_SIZE = 50;

/** Paginated, filterable inspector over the imported source-channel entries. */
export async function listLivetvEntries(client: SupabaseClient<Database>, filter: LivetvEntryListFilter = {}): Promise<LivetvEntryListResult> {
  const pageSize = Math.max(1, Math.min(100, Math.floor(filter.pageSize ?? ENTRY_PAGE_SIZE)));
  const page = Math.max(0, Math.floor(filter.page ?? 0));

  let query = client
    .from('livetv_source_channels')
    .select('id, source_id, source_channel_id, canonical_channel_id, name, category, logo_url, tvg_id, enabled');
  let countQuery = client.from('livetv_source_channels').select('id', { count: 'exact', head: true });

  if (filter.sourceId) {
    const sourceId = requireUuid(filter.sourceId, 'Source');
    query = query.eq('source_id', sourceId);
    countQuery = countQuery.eq('source_id', sourceId);
  }
  if (filter.mappingState === 'mapped') {
    query = query.not('canonical_channel_id', 'is', null);
    countQuery = countQuery.not('canonical_channel_id', 'is', null);
  } else if (filter.mappingState === 'unmapped') {
    query = query.is('canonical_channel_id', null);
    countQuery = countQuery.is('canonical_channel_id', null);
  }
  const search = filter.query ? String(filter.query).trim().slice(0, 80) : '';
  if (search) {
    const escaped = search.replace(/[%_,()]/g, (match) => `\\${match}`);
    query = query.ilike('name', `%${escaped}%`);
    countQuery = countQuery.ilike('name', `%${escaped}%`);
  }

  const [{ data, error }, counted] = await Promise.all([
    query
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1),
    countQuery
  ]);
  if (error) fail('The imported channel list could not be loaded.');
  return {
    rows: ((data ?? []) as unknown as LivetvAdminEntryRow[]).map((row) => ({ ...row })),
    total: counted.count ?? 0,
    page,
    pageSize
  };
}

export async function setLivetvEntryEnabled(client: SupabaseClient<Database>, entryId: unknown, enabled: unknown): Promise<void> {
  const id = requireUuid(entryId, 'Entry');
  const value = requireBoolean(enabled, 'Enabled');
  await executeOrMap(async () => {
    const { error } = await client.from('livetv_source_channels').update({ enabled: value }).eq('id', id);
    if (error) throw error;
  }, 'Unable to change the entry state.');
}

// ---------------------------------------------------------------------------
// R-1 — the bounded per-source channel page (the Edit sheet's channel
// section). Display-oriented: one bounded page of a source's imported
// entries plus the USABLE stream kinds derived from each entry's ENABLED
// endpoints (one extra bounded read scoped to exactly the page's entry ids —
// cross-source endpoints are never read). No mutation, no mapping writes.
// ---------------------------------------------------------------------------

export type LivetvAdminSourceChannelRow = {
  id: string;
  name: string;
  category: string | null;
  logo_url: string | null;
  enabled: boolean;
  /** True when the entry is canonically mapped (display-only provenance hint). */
  mapped: boolean;
  /** Bounded usable stream kinds (deterministic order; empty when none). */
  streamKinds: string[];
};

export type LivetvSourceChannelPage = {
  rows: LivetvAdminSourceChannelRow[];
  total: number;
  page: number;
  pageSize: number;
};

const SOURCE_CHANNEL_PAGE_SIZE = 50;
/** Deterministic stream-kind display order (endpoint-derived, never configured). */
const STREAM_KIND_ORDER = ['DASH', 'HLS', 'Direct', 'Embed'];

function describeStreamKind(endpointKind: unknown, streamFormat: unknown): string | null {
  if (endpointKind === 'embed_page') return 'Embed';
  if (endpointKind === 'direct_stream') {
    if (streamFormat === 'dash') return 'DASH';
    if (streamFormat === 'hls') return 'HLS';
    return 'Direct';
  }
  return null;
}

/** Bounded endpoint-kind read scoped to EXACTLY the page's entry ids. */
async function loadUsableStreamKinds(client: SupabaseClient<Database>, entryIds: string[]): Promise<Map<string, string[]>> {
  const kindsByEntry = new Map<string, string[]>();
  if (entryIds.length === 0) return kindsByEntry;
  // Diagnostics-only column: ANY read problem (error payload or a thrown
  // client failure) degrades to empty kinds, never a failed page — the
  // channel section stays loadable without the kind chips.
  type EndpointKindRow = { source_channel_id: string; endpoint_kind: string; stream_format: string | null; enabled: boolean };
  let rows: EndpointKindRow[] | null = null;
  try {
    const { data, error } = await client
      .from('livetv_playback_endpoints')
      .select('source_channel_id, endpoint_kind, stream_format, enabled')
      .in('source_channel_id', entryIds)
      .limit(400);
    if (!error && data) rows = data as unknown as EndpointKindRow[];
  } catch {
    rows = null;
  }
  if (!rows) return kindsByEntry;
  for (const row of rows) {
    if (row.enabled !== true) continue; // only USABLE endpoints describe the stream type
    const kind = describeStreamKind(row.endpoint_kind, row.stream_format);
    if (!kind) continue;
    const bucket = kindsByEntry.get(row.source_channel_id) ?? [];
    if (!bucket.includes(kind)) bucket.push(kind);
    kindsByEntry.set(row.source_channel_id, bucket);
  }
  for (const bucket of kindsByEntry.values()) {
    bucket.sort((a, b) => STREAM_KIND_ORDER.indexOf(a) - STREAM_KIND_ORDER.indexOf(b));
  }
  return kindsByEntry;
}

/**
 * One bounded, searchable page of ONE source's imported channel entries
 * (R-1 Edit-sheet channel section). `sourceId` must be a valid UUID; page
 * and query are bounded exactly like `listLivetvEntries`. The stream-kind
 * read is scoped to the page's entry ids only.
 */
export async function listLivetvSourceChannelsForAdmin(
  client: SupabaseClient<Database>,
  filter: { sourceId: unknown; page?: number; query?: string | null; pageSize?: number }
): Promise<LivetvSourceChannelPage> {
  const sourceId = requireUuid(filter.sourceId, 'Source');
  const pageSize = Math.max(1, Math.min(100, Math.floor(filter.pageSize ?? SOURCE_CHANNEL_PAGE_SIZE)));
  const page = Math.max(0, Math.floor(filter.page ?? 0));

  let query = client
    .from('livetv_source_channels')
    .select('id, name, category, logo_url, enabled, canonical_channel_id');
  let countQuery = client.from('livetv_source_channels').select('id', { count: 'exact', head: true }).eq('source_id', sourceId);
  query = query.eq('source_id', sourceId);

  const search = filter.query ? String(filter.query).trim().slice(0, 80) : '';
  if (search) {
    const escaped = search.replace(/[%_,()]/g, (match) => `\\${match}`);
    query = query.ilike('name', `%${escaped}%`);
    countQuery = countQuery.ilike('name', `%${escaped}%`);
  }

  const [{ data, error }, counted] = await Promise.all([
    query
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1),
    countQuery
  ]);
  if (error) fail('The source channel list could not be loaded.');

  const rows: LivetvAdminSourceChannelRow[] = [];
  const entryIds: string[] = [];
  for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const id = typeof row['id'] === 'string' ? row['id'] : '';
    const name = typeof row['name'] === 'string' ? row['name'].trim() : '';
    if (!id || !name) continue; // unusable rows are dropped, never coerced
    entryIds.push(id);
    rows.push({
      id,
      name,
      category: (row['category'] as string | null) ?? null,
      logo_url: (row['logo_url'] as string | null) ?? null,
      enabled: row['enabled'] === true,
      mapped: typeof row['canonical_channel_id'] === 'string' && row['canonical_channel_id'] !== '',
      streamKinds: [] // filled below from the scoped endpoint read
    });
  }

  const kindsByEntry = await loadUsableStreamKinds(client, entryIds);
  for (const row of rows) row.streamKinds = kindsByEntry.get(row.id) ?? [];

  return { rows, total: counted.count ?? 0, page, pageSize };
}

/**
 * Sets (or clears) the canonical mapping of one imported entry. The channel
 * must exist; clearing is always allowed. This is the EXACT field the Phase 2
 * ingestion never writes — admin intent is authoritative here.
 */
export async function setLivetvEntryMapping(client: SupabaseClient<Database>, entryId: unknown, channelId: unknown): Promise<void> {
  const id = requireUuid(entryId, 'Entry');
  let mappedId: string | null = null;
  if (channelId !== undefined && channelId !== null && channelId !== '') {
    mappedId = requireUuid(channelId, 'Canonical channel');
    const { data, error } = await client.from('livetv_channels').select('id').eq('id', mappedId).maybeSingle();
    if (error) fail('The canonical channel could not be loaded.');
    if (!data) fail('The canonical channel no longer exists.');
  }
  await executeOrMap(async () => {
    const { error } = await client.from('livetv_source_channels').update({ canonical_channel_id: mappedId }).eq('id', id);
    if (error) throw error;
  }, 'Unable to update the entry mapping.');
}

// ---------------------------------------------------------------------------
// Canonical channels — CRUD / exposure / delete impact
// ---------------------------------------------------------------------------

export async function listLivetvChannels(client: SupabaseClient<Database>, filter: { query?: string | null; page?: number; pageSize?: number } = {}): Promise<{ rows: LivetvAdminChannelRow[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.max(1, Math.min(100, Math.floor(filter.pageSize ?? ENTRY_PAGE_SIZE)));
  const page = Math.max(0, Math.floor(filter.page ?? 0));

  let query = client
    .from('livetv_channels')
    .select('id, name, category, logo_url, dedup_key, enabled, notes, updated_at, livetv_source_channels(count), livetv_playback_candidates(count), livetv_epg_channel_mappings(count)');
  let countQuery = client.from('livetv_channels').select('id', { count: 'exact', head: true });
  const search = filter.query ? String(filter.query).trim().slice(0, 80) : '';
  if (search) {
    const escaped = search.replace(/[%_,()]/g, (match) => `\\${match}`);
    query = query.ilike('name', `%${escaped}%`);
    countQuery = countQuery.ilike('name', `%${escaped}%`);
  }

  const [{ data, error }, counted] = await Promise.all([
    query.order('name', { ascending: true }).order('id', { ascending: true }).range(page * pageSize, page * pageSize + pageSize - 1),
    countQuery
  ]);
  if (error) fail('The canonical channel list could not be loaded.');
  const rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({
    id: String(row['id']),
    name: String(row['name']),
    category: (row['category'] as string | null) ?? null,
    logo_url: (row['logo_url'] as string | null) ?? null,
    dedup_key: (row['dedup_key'] as string | null) ?? null,
    enabled: Boolean(row['enabled']),
    notes: (row['notes'] as string | null) ?? null,
    updated_at: String(row['updated_at'] ?? ''),
    entry_count: extractEmbedCount(row['livetv_source_channels']),
    candidate_count: extractEmbedCount(row['livetv_playback_candidates']),
    epg_mapping_count: extractEmbedCount(row['livetv_epg_channel_mappings'])
  }));
  return { rows, total: counted.count ?? 0, page, pageSize };
}

export type LivetvChannelInput = {
  name: unknown;
  category?: unknown;
  logoUrl?: unknown;
  dedupKey?: unknown;
  enabled?: unknown;
  notes?: unknown;
};

function normalizeChannelInput(input: LivetvChannelInput): Database['public']['Tables']['livetv_channels']['Insert'] {
  return {
    name: requireTrimmedText(input.name, 'Channel name', CHANNEL_NAME_MAX_LENGTH),
    category: optionalTrimmedText(input.category, 'Category', CATEGORY_MAX_LENGTH),
    logo_url: optionalHttpsUrl(input.logoUrl, 'Logo URL'),
    dedup_key: optionalDedupKey(input.dedupKey),
    enabled: input.enabled === undefined ? true : requireBoolean(input.enabled, 'Enabled'),
    notes: optionalTrimmedText(input.notes, 'Notes', NOTES_MAX_LENGTH)
  };
}

export async function createLivetvChannel(client: SupabaseClient<Database>, input: LivetvChannelInput): Promise<{ id: string }> {
  const patch = normalizeChannelInput(input);
  return executeOrMap(async () => {
    const { data, error } = await client.from('livetv_channels').insert(patch).select('id').single();
    if (error || !data) throw error ?? new Error('insert returned no row');
    return { id: String(data['id']) };
  }, 'Unable to create the canonical channel.');
}

export async function updateLivetvChannel(client: SupabaseClient<Database>, channelId: unknown, input: LivetvChannelInput): Promise<void> {
  const id = requireUuid(channelId, 'Canonical channel');
  const patch = normalizeChannelInput(input);
  await executeOrMap(async () => {
    const { error } = await client.from('livetv_channels').update(patch).eq('id', id);
    if (error) throw error;
  }, 'Unable to update the canonical channel.');
}

export async function setLivetvChannelEnabled(client: SupabaseClient<Database>, channelId: unknown, enabled: unknown): Promise<void> {
  const id = requireUuid(channelId, 'Canonical channel');
  const value = requireBoolean(enabled, 'Enabled');
  await executeOrMap(async () => {
    const { error } = await client.from('livetv_channels').update({ enabled: value }).eq('id', id);
    if (error) throw error;
  }, 'Unable to change the channel state.');
}

export type LivetvChannelDeleteImpact = {
  id: string;
  name: string;
  /** Entries mapped to this channel — unmapped (SET NULL), never deleted. */
  entries: number | null;
  /** Candidate rows — deleted by cascade. */
  candidates: number | null;
  /** Explicit EPG mappings — deleted by cascade. */
  epgMappings: number | null;
};

export async function describeLivetvChannelDeleteImpact(client: SupabaseClient<Database>, channelId: unknown): Promise<LivetvChannelDeleteImpact> {
  const id = requireUuid(channelId, 'Canonical channel');
  const { data, error } = await client
    .from('livetv_channels')
    .select('id, name, livetv_source_channels(count), livetv_playback_candidates(count), livetv_epg_channel_mappings(count)')
    .eq('id', id)
    .maybeSingle();
  if (error) fail('The channel impact could not be computed.');
  const row = data as unknown as Record<string, unknown> | null;
  if (!row) fail('The canonical channel no longer exists.');
  return {
    id: String(row['id']),
    name: String(row['name']),
    entries: extractEmbedCount(row['livetv_source_channels']),
    candidates: extractEmbedCount(row['livetv_playback_candidates']),
    epgMappings: extractEmbedCount(row['livetv_epg_channel_mappings'])
  };
}

/**
 * Deletes a canonical channel. The database semantics (documented on the FKs)
 * are safe by construction: mapped source entries are UNMAPPED (SET NULL —
 * another source's provenance is never destroyed), candidates and explicit
 * EPG mappings cascade. The impact counts above are what the confirm dialog
 * shows; this function re-verifies existence and performs the delete.
 */
export async function deleteLivetvChannel(client: SupabaseClient<Database>, channelId: unknown): Promise<void> {
  const id = requireUuid(channelId, 'Canonical channel');
  await describeLivetvChannelDeleteImpact(client, id);
  await executeOrMap(async () => {
    const { error } = await client.from('livetv_channels').delete().eq('id', id);
    if (error) throw error;
  }, 'Unable to delete the canonical channel.');
}

// ---------------------------------------------------------------------------
// Playback candidates — per-channel priority management (configuration ONLY;
// the Phase 5 dispatcher consumes this, nothing dispatches here).
// ---------------------------------------------------------------------------

export type LivetvChannelCandidateView = {
  candidate: LivetvAdminCandidateRow | null;
  endpoint: LivetvAdminEndpointRow;
  entry: { id: string; source_id: string; source_channel_id: string; name: string; enabled: boolean } | null;
  sourceSlug: string | null;
};

export type LivetvChannelCandidateInspector = {
  channelId: string;
  mode: 'explicit' | 'default';
  /** Entries mapped to this channel with their typed endpoints (bounded). */
  endpoints: Array<LivetvChannelCandidateView>;
  /** Explicit candidate rows for this channel (bounded). */
  candidates: LivetvAdminCandidateRow[];
};

/**
 * Loads everything the per-channel candidate editor needs in ONE bounded
 * query: the channel's mapped entries, their typed endpoints, the source
 * slugs and the existing explicit candidate rows.
 */
export async function getLivetvChannelCandidates(client: SupabaseClient<Database>, channelId: unknown): Promise<LivetvChannelCandidateInspector> {
  const id = requireUuid(channelId, 'Canonical channel');
  const { data, error } = await client
    .from('livetv_channels')
    .select(
      'id, livetv_source_channels(id, source_id, source_channel_id, name, enabled, livetv_playback_endpoints(id, source_channel_id, endpoint_kind, stream_format, url, ordering, enabled, label), livetv_sources(slug)), livetv_playback_candidates(id, channel_id, endpoint_id, priority, enabled)'
    )
    .eq('id', id)
    .maybeSingle();
  if (error) fail('The channel candidates could not be loaded.');
  const row = data as unknown as Record<string, unknown> | null;
  if (!row) fail('The canonical channel no longer exists.');

  const entries = (Array.isArray(row['livetv_source_channels']) ? row['livetv_source_channels'] : []) as Array<Record<string, unknown>>;
  const views: Array<LivetvChannelCandidateView> = [];
  for (const entry of entries) {
    const endpoints = (Array.isArray(entry['livetv_playback_endpoints']) ? entry['livetv_playback_endpoints'] : []) as Array<Record<string, unknown>>;
    const sourceSlug = Array.isArray(entry['livetv_sources']) && entry['livetv_sources'].length > 0 ? String((entry['livetv_sources'][0] as Record<string, unknown>)['slug'] ?? '') : null;
    for (const endpoint of endpoints) {
      views.push({
        candidate: null,
        endpoint: {
          id: String(endpoint['id']),
          source_channel_id: String(endpoint['source_channel_id']),
          endpoint_kind: String(endpoint['endpoint_kind']),
          stream_format: (endpoint['stream_format'] as string | null) ?? null,
          url: String(endpoint['url']),
          ordering: Number(endpoint['ordering'] ?? 0),
          enabled: Boolean(endpoint['enabled']),
          label: (endpoint['label'] as string | null) ?? null
        },
        entry: {
          id: String(entry['id']),
          source_id: String(entry['source_id']),
          source_channel_id: String(entry['source_channel_id']),
          name: String(entry['name']),
          enabled: Boolean(entry['enabled'])
        },
        sourceSlug
      });
    }
  }
  views.sort((a, b) => {
    const sourceOrder = (a.sourceSlug ?? '').localeCompare(b.sourceSlug ?? '');
    if (sourceOrder !== 0) return sourceOrder;
    if (a.endpoint.ordering !== b.endpoint.ordering) return a.endpoint.ordering - b.endpoint.ordering;
    return a.endpoint.id < b.endpoint.id ? -1 : a.endpoint.id > b.endpoint.id ? 1 : 0;
  });

  const candidates = ((Array.isArray(row['livetv_playback_candidates']) ? row['livetv_playback_candidates'] : []) as Array<Record<string, unknown>>).map((candidate) => ({
    id: String(candidate['id']),
    channel_id: String(candidate['channel_id']),
    endpoint_id: String(candidate['endpoint_id']),
    priority: Number(candidate['priority'] ?? 0),
    enabled: Boolean(candidate['enabled'])
  }));

  return { channelId: String(row['id']), mode: candidates.length > 0 ? 'explicit' : 'default', endpoints: views, candidates };
}

/**
 * Adds one endpoint as an explicit playback candidate for a canonical channel.
 * The endpoint MUST belong to a source entry mapped to THIS channel (the DB
 * trigger enforces it structurally; this pre-validation yields the friendly
 * error). The playback engine is derived from the endpoint kind downstream —
 * it is never configured here.
 */
export async function addLivetvChannelCandidate(client: SupabaseClient<Database>, channelId: unknown, endpointId: unknown, input: { priority?: unknown; enabled?: unknown }): Promise<void> {
  const id = requireUuid(channelId, 'Canonical channel');
  const endpointUuid = requireUuid(endpointId, 'Endpoint');
  const priority = input.priority === undefined ? 100 : requirePriority(input.priority);
  const enabled = input.enabled === undefined ? true : requireBoolean(input.enabled, 'Enabled');

  const { data, error } = await client
    .from('livetv_playback_endpoints')
    .select('id, livetv_source_channels(canonical_channel_id)')
    .eq('id', endpointUuid)
    .maybeSingle();
  if (error) fail('The endpoint could not be loaded.');
  const row = data as unknown as Record<string, unknown> | null;
  if (!row) fail('The endpoint no longer exists.');
  const entry = Array.isArray(row['livetv_source_channels']) && row['livetv_source_channels'].length > 0 ? (row['livetv_source_channels'][0] as Record<string, unknown> | undefined) : undefined;
  const mapped = entry ? entry['canonical_channel_id'] : null;
  if (!mapped || mapped !== id) fail('The endpoint does not belong to a source channel mapped to this canonical channel.');

  await executeOrMap(async () => {
    const { error: insertError } = await client.from('livetv_playback_candidates').insert({ channel_id: id, endpoint_id: endpointUuid, priority, enabled });
    if (insertError) throw insertError;
  }, 'Unable to add the playback candidate.');
}

export type LivetvCandidateUpdateInput = {
  priority?: unknown;
  enabled?: unknown;
};

/** Updates priority and/or enablement of one candidate row (scoped to its channel). */
export async function updateLivetvChannelCandidate(client: SupabaseClient<Database>, channelId: unknown, candidateId: unknown, input: LivetvCandidateUpdateInput): Promise<void> {
  const id = requireUuid(channelId, 'Canonical channel');
  const candidateUuid = requireUuid(candidateId, 'Candidate');
  const patch: Database['public']['Tables']['livetv_playback_candidates']['Update'] = {};
  if (input.priority !== undefined) patch.priority = requirePriority(input.priority);
  if (input.enabled !== undefined) patch.enabled = requireBoolean(input.enabled, 'Enabled');
  if (Object.keys(patch).length === 0) fail('Nothing to update.');
  await executeOrMap(async () => {
    const { error } = await client.from('livetv_playback_candidates').update(patch).eq('id', candidateUuid).eq('channel_id', id);
    if (error) throw error;
  }, 'Unable to update the playback candidate.');
}

/** Removes one candidate row (scoped to its channel; the endpoint itself is untouched). */
export async function removeLivetvChannelCandidate(client: SupabaseClient<Database>, channelId: unknown, candidateId: unknown): Promise<void> {
  const id = requireUuid(channelId, 'Canonical channel');
  const candidateUuid = requireUuid(candidateId, 'Candidate');
  await executeOrMap(async () => {
    const { data, error } = await client.from('livetv_playback_candidates').delete().eq('id', candidateUuid).eq('channel_id', id).select('id');
    if (error) throw error;
    if (!data || data.length === 0) fail('The candidate no longer exists for this channel.');
  }, 'Unable to remove the playback candidate.');
}

// ---------------------------------------------------------------------------
// Typed playback endpoints — admin management with refresh-semantics bounds
// ---------------------------------------------------------------------------

/** Sources WITHOUT an upstream adapter: their endpoints are admin-authored. */
const ADMIN_AUTHORED_SOURCE_TYPES: ReadonlySet<string> = new Set(['manual_stream', 'embed_provider']);

async function loadEndpointContext(client: SupabaseClient<Database>, endpointId: string): Promise<{ endpoint: LivetvAdminEndpointRow; entry: { id: string; source_id: string } | null; sourceType: string | null } | null> {
  const { data, error } = await client
    .from('livetv_playback_endpoints')
    .select('id, source_channel_id, endpoint_kind, stream_format, url, ordering, enabled, label, livetv_source_channels(id, source_id, livetv_sources(source_type))')
    .eq('id', endpointId)
    .maybeSingle();
  if (error) fail('The endpoint could not be loaded.');
  const row = data as unknown as Record<string, unknown> | null;
  if (!row) return null;
  const entryCell = row['livetv_source_channels'];
  const entry = Array.isArray(entryCell) && entryCell.length > 0 ? (entryCell[0] as Record<string, unknown>) : undefined;
  const sourceCell = entry && Array.isArray(entry['livetv_sources']) && entry['livetv_sources'].length > 0 ? (entry['livetv_sources'][0] as Record<string, unknown>) : undefined;
  return {
    endpoint: {
      id: String(row['id']),
      source_channel_id: String(row['source_channel_id']),
      endpoint_kind: String(row['endpoint_kind']),
      stream_format: (row['stream_format'] as string | null) ?? null,
      url: String(row['url']),
      ordering: Number(row['ordering'] ?? 0),
      enabled: Boolean(row['enabled']),
      label: (row['label'] as string | null) ?? null
    },
    entry: entry ? { id: String(entry['id']), source_id: String(entry['source_id']) } : null,
    sourceType: sourceCell ? String(sourceCell['source_type'] ?? '') : null
  };
}

/**
 * Adds a typed endpoint to an imported entry. Only sources WITHOUT an
 * upstream catalogue adapter accept endpoint authoring (manual_stream,
 * embed_provider) — for adapter-fed sources the refresh pipeline owns the
 * endpoint set, and a hand-added row would resurrect the refresh's own URL
 * set next run. The kind/format pairing is validated by the Phase 1 registry
 * validator (an iframe URL can never be stored "as a manifest").
 */
export async function addLivetvEndpoint(client: SupabaseClient<Database>, entryId: unknown, input: LivetvEndpointInput): Promise<void> {
  const id = requireUuid(entryId, 'Entry');
  const validated = validateLivetvEndpointInput(input);
  const { data, error } = await client
    .from('livetv_source_channels')
    .select('id, source_id, livetv_sources(source_type)')
    .eq('id', id)
    .maybeSingle();
  if (error) fail('The source channel could not be loaded.');
  const row = data as unknown as Record<string, unknown> | null;
  if (!row) fail('The source channel no longer exists.');
  const sourceCell = Array.isArray(row['livetv_sources']) && row['livetv_sources'].length > 0 ? (row['livetv_sources'][0] as Record<string, unknown>) : undefined;
  const sourceType = sourceCell ? String(sourceCell['source_type'] ?? '') : '';
  if (!ADMIN_AUTHORED_SOURCE_TYPES.has(sourceType)) {
    fail(`Endpoints of ${sourceType || 'this'} sources are managed by the source refresh — endpoint authoring is available for manual_stream and embed_provider sources.`);
  }

  await executeOrMap(async () => {
    const { error: insertError } = await client.from('livetv_playback_endpoints').insert({
      source_channel_id: id,
      endpoint_kind: validated.endpointKind,
      stream_format: validated.streamFormat,
      url: validated.url,
      ordering: validated.ordering,
      label: validated.label
    });
    if (insertError) throw insertError;
  }, 'Unable to add the endpoint.');
}

/**
 * Edits one endpoint. Adapter-fed sources: ONLY the admin-owned fields
 * (enabled, ordering) may change — URL/kind/label edits would be overwritten
 * by the next refresh. Admin-authored sources (manual_stream/embed_provider):
 * full edits.
 */
export async function updateLivetvEndpoint(client: SupabaseClient<Database>, endpointId: unknown, input: { endpointKind?: unknown; streamFormat?: unknown; url?: unknown; ordering?: unknown; enabled?: unknown; label?: unknown }): Promise<void> {
  const id = requireUuid(endpointId, 'Endpoint');
  const context = await loadEndpointContext(client, id);
  if (!context) fail('The endpoint no longer exists.');

  const adminAuthored = context.sourceType !== null && ADMIN_AUTHORED_SOURCE_TYPES.has(context.sourceType);
  const patch: Database['public']['Tables']['livetv_playback_endpoints']['Update'] = {};
  if (input.enabled !== undefined) patch.enabled = requireBoolean(input.enabled, 'Enabled');
  if (input.ordering !== undefined) patch.ordering = requirePriority(input.ordering, 'Ordering');

  if (adminAuthored) {
    if (input.url !== undefined || input.endpointKind !== undefined || input.streamFormat !== undefined || input.label !== undefined) {
      const validated = validateLivetvEndpointInput({
        endpointKind: (input.endpointKind ?? context.endpoint.endpoint_kind) as LivetvEndpointInput['endpointKind'],
        streamFormat: (input.streamFormat ?? context.endpoint.stream_format) as LivetvEndpointInput['streamFormat'],
        url: (input.url ?? context.endpoint.url) as string,
        ordering: (input.ordering ?? context.endpoint.ordering) as number,
        label: (input.label ?? context.endpoint.label) as string | null | undefined
      });
      patch.endpoint_kind = validated.endpointKind;
      patch.stream_format = validated.streamFormat;
      patch.url = validated.url;
      patch.label = validated.label;
      if (validated.ordering !== undefined) patch.ordering = validated.ordering;
    }
  } else if (input.url !== undefined || input.endpointKind !== undefined || input.streamFormat !== undefined || input.label !== undefined) {
    const owned = ['url', 'endpointKind', 'streamFormat', 'label'].filter((key) => input[key as keyof typeof input] !== undefined);
    fail(`The ${owned.join('/')} of ${context.sourceType ?? 'adapter-fed'} endpoints are managed by the source refresh — only enablement and ordering are admin-owned.`);
  }

  if (Object.keys(patch).length === 0) fail('Nothing to update.');
  await executeOrMap(async () => {
    const { error } = await client.from('livetv_playback_endpoints').update(patch).eq('id', id);
    if (error) throw error;
  }, 'Unable to update the endpoint.');
}

export type LivetvEndpointDeleteImpact = {
  id: string;
  url: string;
  endpointKind: string;
  /** Candidate rows referencing this endpoint — deleted by cascade. */
  candidates: number | null;
  adminAuthored: boolean;
};

export async function describeLivetvEndpointDeleteImpact(client: SupabaseClient<Database>, endpointId: unknown): Promise<LivetvEndpointDeleteImpact> {
  const id = requireUuid(endpointId, 'Endpoint');
  const context = await loadEndpointContext(client, id);
  if (!context) fail('The endpoint no longer exists.');
  const candidates = await exactCount(client, 'livetv_playback_candidates', [['endpoint_id', id]]);
  return {
    id: context.endpoint.id,
    url: context.endpoint.url,
    endpointKind: context.endpoint.endpoint_kind,
    candidates,
    adminAuthored: context.sourceType !== null && ADMIN_AUTHORED_SOURCE_TYPES.has(context.sourceType)
  };
}

/**
 * Deletes one endpoint. Adapter-fed endpoints are REFUSED (the next refresh
 * would re-import them — the honest report-only stale strategy covers them
 * instead). Candidates referencing the endpoint cascade (DB semantics).
 */
export async function deleteLivetvEndpoint(client: SupabaseClient<Database>, endpointId: unknown): Promise<void> {
  const id = requireUuid(endpointId, 'Endpoint');
  const impact = await describeLivetvEndpointDeleteImpact(client, id);
  if (!impact.adminAuthored) {
    fail('This endpoint is managed by the source refresh — deleting it would only be undone on the next refresh. Disable it instead.');
  }
  await executeOrMap(async () => {
    const { error } = await client.from('livetv_playback_endpoints').delete().eq('id', id);
    if (error) throw error;
  }, 'Unable to delete the endpoint.');
}

/** Endpoint-level enablement gate (rule E1) — admin-owned, refresh-preserved. */
export async function setLivetvEndpointEnabled(client: SupabaseClient<Database>, endpointId: unknown, enabled: unknown): Promise<void> {
  const id = requireUuid(endpointId, 'Endpoint');
  const value = requireBoolean(enabled, 'Enabled');
  await executeOrMap(async () => {
    const { error } = await client.from('livetv_playback_endpoints').update({ enabled: value }).eq('id', id);
    if (error) throw error;
  }, 'Unable to change the endpoint state.');
}

// ---------------------------------------------------------------------------
// EPG sources — CRUD / enablement / delete impact (the Phase 3 pipeline is
// the ONLY ingestion path; this module manages its CONFIGURATION rows).
// ---------------------------------------------------------------------------

export async function listLivetvEpgSources(client: SupabaseClient<Database>): Promise<LivetvAdminEpgSourceRow[]> {
  const { data, error } = await client
    .from('livetv_epg_sources')
    .select('id, slug, name, epg_type, source_url, enabled, status, config, description, updated_at, livetv_epg_channel_mappings(count), livetv_epg_programmes(count)')
    .order('slug', { ascending: true })
    .limit(LIST_ROWS_CAP);
  if (error) fail('The EPG source list could not be loaded.');
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row['id']),
    slug: String(row['slug']),
    name: String(row['name']),
    epg_type: String(row['epg_type']),
    source_url: (row['source_url'] as string | null) ?? null,
    enabled: Boolean(row['enabled']),
    status: row['status'] as LivetvSourceStatus,
    config: (row['config'] && typeof row['config'] === 'object' && !Array.isArray(row['config']) ? row['config'] : {}) as Record<string, unknown>,
    description: (row['description'] as string | null) ?? null,
    updated_at: String(row['updated_at'] ?? ''),
    mapping_count: extractEmbedCount(row['livetv_epg_channel_mappings']),
    programme_count: extractEmbedCount(row['livetv_epg_programmes'])
  }));
}

export type LivetvEpgSourceInput = {
  slug?: unknown;
  name: unknown;
  sourceUrl: unknown;
  status?: unknown;
  enabled?: unknown;
  description?: unknown;
  defaultTimezone?: unknown;
};

function normalizeEpgSourceInput(input: LivetvEpgSourceInput): Database['public']['Tables']['livetv_epg_sources']['Insert'] {
  const name = requireTrimmedText(input.name, 'EPG source name', NAME_MAX_LENGTH);
  const sourceUrl = optionalHttpsUrl(input.sourceUrl, 'Guide URL');
  if (!sourceUrl) fail('Guide URL is required (an https XMLTV document the server will fetch).');
  let config: LivetvEpgSourceConfig = {};
  if (input.defaultTimezone !== undefined && input.defaultTimezone !== null && input.defaultTimezone !== '') {
    try {
      config = validateEpgSourceConfig({ defaultTimezone: input.defaultTimezone });
    } catch (error) {
      throw new LivetvAdminError(error instanceof Error ? error.message : 'The default timezone is invalid.');
    }
  }
  const patch: Database['public']['Tables']['livetv_epg_sources']['Insert'] = {
    slug: '',
    name,
    epg_type: 'xmltv',
    source_url: sourceUrl,
    status: normalizeStatus(input.status),
    config: config as Json,
    description: optionalTrimmedText(input.description, 'Description', DESCRIPTION_MAX_LENGTH)
  };
  if (input.enabled !== undefined) patch.enabled = requireBoolean(input.enabled, 'Enabled');
  patch.slug = validateSlug(input.slug, name);
  return patch;
}

export async function createLivetvEpgSource(client: SupabaseClient<Database>, input: LivetvEpgSourceInput): Promise<{ id: string; slug: string }> {
  const patch = normalizeEpgSourceInput(input);
  return executeOrMap(async () => {
    const { data, error } = await client
      .from('livetv_epg_sources')
      .insert(patch)
      .select('id, slug')
      .single();
    if (error || !data) throw error ?? new Error('insert returned no row');
    return { id: String(data['id']), slug: String(data['slug']) };
  }, 'Unable to create the EPG source.');
}

export async function updateLivetvEpgSource(client: SupabaseClient<Database>, epgSourceId: unknown, input: LivetvEpgSourceInput): Promise<void> {
  const id = requireUuid(epgSourceId, 'EPG source');
  const patch = normalizeEpgSourceInput(input);
  // IMMUTABLE by design: slug + epg_type never change after creation (same
  // rule as playback sources — slugs are stored references; epg_type is the
  // closed 'xmltv' vocabulary).
  const { slug: _slug, epg_type: _epgType, ...updatePatch } = patch;
  await executeOrMap(async () => {
    const { error } = await client.from('livetv_epg_sources').update(updatePatch).eq('id', id);
    if (error) throw error;
  }, 'Unable to update the EPG source.');
}

export async function setLivetvEpgSourceEnabled(client: SupabaseClient<Database>, epgSourceId: unknown, enabled: unknown): Promise<void> {
  const id = requireUuid(epgSourceId, 'EPG source');
  const value = requireBoolean(enabled, 'Enabled');
  await executeOrMap(async () => {
    const { error } = await client.from('livetv_epg_sources').update({ enabled: value }).eq('id', id);
    if (error) throw error;
  }, 'Unable to change the EPG source state.');
}

export type LivetvEpgSourceDeleteImpact = {
  id: string;
  slug: string;
  name: string;
  /** Explicit mappings — deleted by cascade. */
  mappings: number | null;
  /** Persisted programme rows — deleted by cascade. */
  programmes: number | null;
};

export async function describeLivetvEpgSourceDeleteImpact(client: SupabaseClient<Database>, epgSourceId: unknown): Promise<LivetvEpgSourceDeleteImpact> {
  const id = requireUuid(epgSourceId, 'EPG source');
  const { data, error } = await client
    .from('livetv_epg_sources')
    .select('id, slug, name, livetv_epg_channel_mappings(count), livetv_epg_programmes(count)')
    .eq('id', id)
    .maybeSingle();
  if (error) fail('The EPG source impact could not be computed.');
  const row = data as unknown as Record<string, unknown> | null;
  if (!row) fail('The EPG source no longer exists.');
  return {
    id: String(row['id']),
    slug: String(row['slug']),
    name: String(row['name']),
    mappings: extractEmbedCount(row['livetv_epg_channel_mappings']),
    programmes: extractEmbedCount(row['livetv_epg_programmes'])
  };
}

export async function deleteLivetvEpgSource(client: SupabaseClient<Database>, epgSourceId: unknown): Promise<void> {
  const id = requireUuid(epgSourceId, 'EPG source');
  await describeLivetvEpgSourceDeleteImpact(client, id);
  await executeOrMap(async () => {
    const { error } = await client.from('livetv_epg_sources').delete().eq('id', id);
    if (error) throw error;
  }, 'Unable to delete the EPG source.');
}

// ---------------------------------------------------------------------------
// Explicit EPG channel mappings — CRUD (the Phase 1 uniqueness constraints
// are the authority; violations map to friendly typed errors).
// ---------------------------------------------------------------------------

/** Guide-id parity with the DB CHECK + the Phase 3 planner (1..200, no whitespace/control). */
function validateEpgChannelId(raw: unknown): string {
  if (typeof raw !== 'string') fail('Guide channel id is required.');
  const normalized = normalizeEpgIdentity(raw);
  if (!normalized) fail('Guide channel id is required.');
  if (normalized.length > 200) fail('Guide channel id must be 200 characters or fewer.');
  if (/\s/.test(normalized)) fail('Guide channel id must not contain whitespace.');
  if (/[\u0000-\u001f\u007f]/.test(normalized)) fail('Guide channel id must not contain control characters.');
  return normalized;
}

export async function listLivetvEpgMappings(client: SupabaseClient<Database>, epgSourceId: unknown, page = 0): Promise<{ rows: LivetvAdminEpgMappingRow[]; total: number; page: number; pageSize: number }> {
  const id = requireUuid(epgSourceId, 'EPG source');
  const pageSize = 50;
  const safePage = Math.max(0, Math.floor(page));
  const { data, error } = await client
    .from('livetv_epg_channel_mappings')
    .select('id, epg_source_id, channel_id, epg_channel_id')
    .eq('epg_source_id', id)
    .order('epg_channel_id', { ascending: true })
    .range(safePage * pageSize, safePage * pageSize + pageSize - 1);
  if (error) fail('The EPG mappings could not be loaded.');
  const rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({
    id: String(row['id']),
    epg_source_id: String(row['epg_source_id']),
    channel_id: String(row['channel_id']),
    epg_channel_id: String(row['epg_channel_id']),
    channel_name: null as string | null
  }));
  const channelIds = [...new Set(rows.map((row) => row.channel_id))].slice(0, pageSize);
  if (channelIds.length > 0) {
    const { data: channels, error: channelError } = await client.from('livetv_channels').select('id, name').in('id', channelIds);
    if (!channelError) {
      const names = new Map(((channels ?? []) as unknown as Array<{ id: string; name: string }>).map((channel) => [channel.id, channel.name]));
      for (const row of rows) row.channel_name = names.get(row.channel_id) ?? null;
    }
  }
  const total = await exactCount(client, 'livetv_epg_channel_mappings', [['epg_source_id', id]]);
  return { rows, total: total ?? 0, page: safePage, pageSize };
}

export async function createLivetvEpgMapping(client: SupabaseClient<Database>, epgSourceId: unknown, channelId: unknown, epgChannelId: unknown): Promise<void> {
  const sourceId = requireUuid(epgSourceId, 'EPG source');
  const id = requireUuid(channelId, 'Canonical channel');
  const guideId = validateEpgChannelId(epgChannelId);

  const [sourceRow, channelRow] = await Promise.all([
    client.from('livetv_epg_sources').select('id').eq('id', sourceId).maybeSingle(),
    client.from('livetv_channels').select('id').eq('id', id).maybeSingle()
  ]);
  if (sourceRow.error) fail('The EPG source could not be loaded.');
  if (!sourceRow.data) fail('The EPG source no longer exists.');
  if (channelRow.error) fail('The canonical channel could not be loaded.');
  if (!channelRow.data) fail('The canonical channel no longer exists.');

  await executeOrMap(async () => {
    const { error } = await client.from('livetv_epg_channel_mappings').insert({ epg_source_id: sourceId, channel_id: id, epg_channel_id: guideId });
    if (error) throw error;
  }, 'Unable to create the EPG mapping.');
}

/** Deletes one explicit mapping (scoped to its EPG source; guide data is untouched). */
export async function deleteLivetvEpgMapping(client: SupabaseClient<Database>, epgSourceId: unknown, mappingId: unknown): Promise<void> {
  const sourceId = requireUuid(epgSourceId, 'EPG source');
  const id = requireUuid(mappingId, 'Mapping');
  await executeOrMap(async () => {
    const { data, error } = await client.from('livetv_epg_channel_mappings').delete().eq('id', id).eq('epg_source_id', sourceId).select('id');
    if (error) throw error;
    if (!data || data.length === 0) fail('The mapping no longer exists for this EPG source.');
  }, 'Unable to delete the EPG mapping.');
}

// ---------------------------------------------------------------------------
// Guide diagnostics — bounded, per-EPG-source, derived from the Phase 3
// tables + the Phase 3 mapping planner (NO second pipeline). Two honest
// views: the LAST REFRESH outcome (live document; per-instance) and this
// stored-data view (persisted guide rows; always available).
// ---------------------------------------------------------------------------

export type LivetvEpgGuideDiagnostics = {
  epgSourceId: string;
  slug: string;
  name: string;
  /** Programmes persisted for this source (exact count; null when unavailable). */
  programmeCount: number | null;
  /** Distinct guide identities observed in the STORED rows (bounded). */
  storedGuideIds: number;
  /** Truncated: the stored-row probe hit its cap (run a refresh for exact numbers). */
  storedGuideIdsTruncated: boolean;
  counts: {
    guideChannels: number;
    matched: number;
    viaExplicit: number;
    viaTvgId: number;
    unmatched: number;
    ambiguous: number;
    invalid: number;
  };
  samples: {
    unmatched: string[];
    ambiguous: string[];
    invalid: string[];
  };
  /** Bounded per-guide current/next view for MATCHED identities. */
  guide: Array<{
    epgChannelId: string;
    status: 'matched' | 'unmatched' | 'ambiguous' | 'invalid';
    channelId: string | null;
    channelName: string | null;
    mappingSource: 'explicit' | 'tvgid' | null;
    currentTitle: string | null;
    nextTitle: string | null;
    nextStartMs: number | null;
  }>;
};

const DIAGNOSTICS_GUIDE_VIEW_CAP = 100;

export async function getLivetvEpgGuideDiagnostics(client: SupabaseClient<Database>, epgSourceId: unknown, now: Date = new Date()): Promise<LivetvEpgGuideDiagnostics> {
  const id = requireUuid(epgSourceId, 'EPG source');
  const { data, error } = await client
    .from('livetv_epg_sources')
    .select('id, slug, name')
    .eq('id', id)
    .maybeSingle();
  if (error) fail('The EPG source could not be loaded.');
  const sourceRow = data as unknown as { id: string; slug: string; name: string } | null;
  if (!sourceRow) fail('The EPG source no longer exists.');

  // Stored guide identities (bounded probe; the persisted rows are the
  // guide's presence proof between refreshes).
  const programmeProbe = await client
    .from('livetv_epg_programmes')
    .select('epg_channel_id')
    .eq('epg_source_id', id)
    .limit(DIAGNOSTICS_ROW_CAP);
  if (programmeProbe.error) fail('The stored guide rows could not be loaded.');
  const programmeRows = (programmeProbe.data ?? []) as unknown as Array<{ epg_channel_id: string }>;
  const storedGuideIdsTruncated = programmeRows.length >= DIAGNOSTICS_ROW_CAP;
  const guideIds = [...new Set(programmeRows.map((row) => row.epg_channel_id))];

  // Explicit mappings + tvgId votes (the planner's exact input contract).
  const mappingsResult = await client
    .from('livetv_epg_channel_mappings')
    .select('epg_channel_id, channel_id')
    .eq('epg_source_id', id)
    .limit(MAPPINGS_LIST_CAP * 2);
  if (mappingsResult.error) fail('The EPG mappings could not be loaded.');
  const explicitMappings = (mappingsResult.data ?? []) as unknown as EpgMappingRow[];

  const entriesResult = await client
    .from('livetv_source_channels')
    .select('id, source_id, source_channel_id, canonical_channel_id, tvg_id, enabled')
    .not('tvg_id', 'is', null)
    .limit(DIAGNOSTICS_ROW_CAP);
  if (entriesResult.error) fail('The source entries could not be loaded.');
  const sourceChannels = (entriesResult.data ?? []) as unknown as EpgSourceChannelRow[];

  const plan = planEpgMapping({ guideChannelIds: guideIds, explicitMappings, sourceChannels });

  // Bounded now/next window for this source (ONE query; grouped per guide id).
  const nowIso = new Date(now.getTime()).toISOString();
  const horizonIso = new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString();
  const windowResult = await client
    .from('livetv_epg_programmes')
    .select('epg_channel_id, start_at, end_at, title')
    .eq('epg_source_id', id)
    .gte('end_at', nowIso)
    .lte('start_at', horizonIso)
    .order('start_at', { ascending: true })
    .limit(400);
  if (windowResult.error) fail('The guide window could not be loaded.');
  const windowRows = ((windowResult.data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({
    epgChannelId: String(row['epg_channel_id'] ?? ''),
    startMs: Date.parse(String(row['start_at'])),
    endMs: Date.parse(String(row['end_at'])),
    title: String(row['title'] ?? '')
  }));
  const currentByGuide = new Map<string, string>();
  const nextByGuideMap = new Map<string, { title: string; startMs: number }>();
  for (const row of windowRows) {
    if (!Number.isFinite(row.startMs) || !Number.isFinite(row.endMs)) continue;
    const isCurrent = row.startMs <= now.getTime() && now.getTime() < row.endMs;
    if (isCurrent && !currentByGuide.has(row.epgChannelId)) currentByGuide.set(row.epgChannelId, row.title);
    if (row.startMs > now.getTime() && !nextByGuideMap.has(row.epgChannelId)) nextByGuideMap.set(row.epgChannelId, { title: row.title, startMs: row.startMs });
  }

  // Matched channel names (bounded).
  const matchedChannelIds = [...new Set([...plan.matches.values()].map((match) => match.channelId).filter((value): value is string => typeof value === 'string'))].slice(0, DIAGNOSTICS_GUIDE_VIEW_CAP);
  const channelNames = new Map<string, string>();
  if (matchedChannelIds.length > 0) {
    const namesResult = await client.from('livetv_channels').select('id, name').in('id', matchedChannelIds);
    if (!namesResult.error) {
      for (const row of (namesResult.data ?? []) as unknown as Array<{ id: string; name: string }>) channelNames.set(row.id, row.name);
    }
  }

  const guide = guideIds.slice(0, DIAGNOSTICS_GUIDE_VIEW_CAP).map((guideId) => {
    const match = plan.matches.get(guideId);
    const next = nextByGuideMap.get(guideId) ?? null;
    return {
      epgChannelId: guideId,
      status: match?.status ?? ('unmatched' as const),
      channelId: match?.channelId ?? null,
      channelName: match?.channelId ? channelNames.get(match.channelId) ?? null : null,
      mappingSource: match?.source ?? null,
      currentTitle: currentByGuide.get(guideId) ?? null,
      nextTitle: next?.title ?? null,
      nextStartMs: next?.startMs ?? null
    };
  });

  return {
    epgSourceId: sourceRow.id,
    slug: sourceRow.slug,
    name: sourceRow.name,
    programmeCount: await exactCount(client, 'livetv_epg_programmes', [['epg_source_id', id]]),
    storedGuideIds: guideIds.length,
    storedGuideIdsTruncated,
    counts: plan.counts,
    samples: plan.samples,
    guide
  };
}

// ---------------------------------------------------------------------------
// Overview — the health/summary read for the Overview tab + the admin
// Overview metric card. READ-ONLY: `livetv_config_meta` is displayed, never
// written (unified_enabled stays exactly as the migration seeded it).
// ---------------------------------------------------------------------------

export type LivetvAdminOverview = {
  configVersion: number | null;
  unifiedEnabled: boolean | null;
  sources: { total: number; enabled: number; byType: Record<string, number> };
  channels: { total: number; enabled: number };
  entries: { total: number; mapped: number };
  endpoints: { total: number };
  candidates: { total: number };
  epg: { sources: number; enabledSources: number; mappings: number; programmes: number | null };
};

export async function getLivetvAdminOverview(client: SupabaseClient<Database>): Promise<LivetvAdminOverview> {
  const [meta, sourcesResult, channelsCount, enabledChannelsCount, entriesTotal, entriesMapped, endpointsTotal, candidatesTotal, epgSources, epgEnabledSources, epgMappings, programmesTotal] = await Promise.all([
    client.from('livetv_config_meta').select('version, unified_enabled').eq('id', 1).maybeSingle(),
    client.from('livetv_sources').select('id, enabled, source_type').limit(DIAGNOSTICS_ROW_CAP),
    exactCount(client, 'livetv_channels'),
    exactCount(client, 'livetv_channels', [['enabled', true]]),
    exactCount(client, 'livetv_source_channels'),
    // Mapped entries: exact count with the NOT-IS filter (the canonical link).
    client.from('livetv_source_channels').select('id', { count: 'exact', head: true }).not('canonical_channel_id', 'is', null),
    exactCount(client, 'livetv_playback_endpoints'),
    exactCount(client, 'livetv_playback_candidates'),
    exactCount(client, 'livetv_epg_sources'),
    exactCount(client, 'livetv_epg_sources', [['enabled', true]]),
    exactCount(client, 'livetv_epg_channel_mappings'),
    exactCount(client, 'livetv_epg_programmes')
  ]);

  if (meta.error) fail('The Live TV configuration meta could not be loaded.');
  if (sourcesResult.error) fail('The source list could not be loaded.');
  const sourceRows = (sourcesResult.data ?? []) as unknown as Array<{ enabled: boolean; source_type: string }>;
  const byType: Record<string, number> = {};
  for (const row of sourceRows) byType[row.source_type] = (byType[row.source_type] ?? 0) + 1;
  const metaRow = meta.data as unknown as { version: number; unified_enabled: boolean } | null;

  return {
    configVersion: metaRow ? Number(metaRow.version) : null,
    unifiedEnabled: metaRow ? Boolean(metaRow.unified_enabled) : null,
    sources: { total: sourceRows.length, enabled: sourceRows.filter((row) => row.enabled).length, byType },
    channels: { total: channelsCount ?? 0, enabled: enabledChannelsCount ?? 0 },
    entries: { total: entriesTotal ?? 0, mapped: entriesMapped.count ?? 0 },
    endpoints: { total: endpointsTotal ?? 0 },
    candidates: { total: candidatesTotal ?? 0 },
    epg: { sources: epgSources ?? 0, enabledSources: epgEnabledSources ?? 0, mappings: epgMappings ?? 0, programmes: programmesTotal }
  };
}

/**
 * Delete-impact counts for EVERY source in THREE bounded embedded-count
 * queries (entries → endpoints → candidates). Consumed by the sources tab so
 * the confirmed-delete dialogs always show real impact without per-row
 * round-trips.
 */
export async function listLivetvSourceDeleteImpacts(client: SupabaseClient<Database>): Promise<Map<string, { entries: number | null; endpoints: number | null; candidates: number | null }>> {
  const impacts = new Map<string, { entries: number | null; endpoints: number | null; candidates: number | null }>();
  const collect = (rows: Array<Record<string, unknown>>, key: string, apply: (impact: { entries: number | null; endpoints: number | null; candidates: number | null }, total: number | null) => void) => {
    for (const row of rows) {
      const id = String(row['id']);
      const impact = impacts.get(id) ?? { entries: null, endpoints: null, candidates: null };
      apply(impact, sumEmbedCounts(row[key]));
      impacts.set(id, impact);
    }
  };

  const [entriesResult, endpointsResult, candidatesResult] = await Promise.all([
    client.from('livetv_sources').select('id, livetv_source_channels(count)').limit(LIST_ROWS_CAP),
    client.from('livetv_sources').select('id, livetv_source_channels(livetv_playback_endpoints(count))').limit(LIST_ROWS_CAP),
    client.from('livetv_sources').select('id, livetv_source_channels(livetv_playback_endpoints(livetv_playback_candidates(count)))').limit(LIST_ROWS_CAP)
  ]);
  if (entriesResult.error || endpointsResult.error || candidatesResult.error) fail('The source delete impacts could not be computed.');
  collect((entriesResult.data ?? []) as unknown as Array<Record<string, unknown>>, 'livetv_source_channels', (impact, total) => { impact.entries = total; });
  collect((endpointsResult.data ?? []) as unknown as Array<Record<string, unknown>>, 'livetv_source_channels', (impact, total) => { impact.endpoints = total; });
  collect((candidatesResult.data ?? []) as unknown as Array<Record<string, unknown>>, 'livetv_source_channels', (impact, total) => { impact.candidates = total; });
  return impacts;
}

/**
 * Per-entry endpoint inspector: the entry, its source type (whether endpoint
 * authoring is allowed) and its typed endpoints — ONE bounded query.
 */
export async function getLivetvEntryEndpoints(client: SupabaseClient<Database>, entryId: unknown): Promise<{ entry: { id: string; source_id: string; source_channel_id: string; name: string; enabled: boolean; canonical_channel_id: string | null }; sourceType: string | null; adminAuthored: boolean; endpoints: LivetvAdminEndpointRow[] } | null> {
  const id = requireUuid(entryId, 'Entry');
  const { data, error } = await client
    .from('livetv_source_channels')
    .select('id, source_id, source_channel_id, name, enabled, canonical_channel_id, livetv_sources(source_type), livetv_playback_endpoints(id, source_channel_id, endpoint_kind, stream_format, url, ordering, enabled, label)')
    .eq('id', id)
    .maybeSingle();
  if (error) fail('The entry could not be loaded.');
  const row = data as unknown as Record<string, unknown> | null;
  if (!row) return null;
  const sourceCell = Array.isArray(row['livetv_sources']) && row['livetv_sources'].length > 0 ? (row['livetv_sources'][0] as Record<string, unknown>) : undefined;
  const sourceType = sourceCell ? String(sourceCell['source_type'] ?? '') : null;
  const endpoints = ((Array.isArray(row['livetv_playback_endpoints']) ? row['livetv_playback_endpoints'] : []) as Array<Record<string, unknown>>).map((endpoint) => ({
    id: String(endpoint['id']),
    source_channel_id: String(endpoint['source_channel_id']),
    endpoint_kind: String(endpoint['endpoint_kind']),
    stream_format: (endpoint['stream_format'] as string | null) ?? null,
    url: String(endpoint['url']),
    ordering: Number(endpoint['ordering'] ?? 0),
    enabled: Boolean(endpoint['enabled']),
    label: (endpoint['label'] as string | null) ?? null
  }));
  endpoints.sort((a, b) => (a.ordering !== b.ordering ? a.ordering - b.ordering : a.id < b.id ? -1 : 1));
  return {
    entry: {
      id: String(row['id']),
      source_id: String(row['source_id']),
      source_channel_id: String(row['source_channel_id']),
      name: String(row['name']),
      enabled: Boolean(row['enabled']),
      canonical_channel_id: (row['canonical_channel_id'] as string | null) ?? null
    },
    sourceType,
    adminAuthored: sourceType !== null && ADMIN_AUTHORED_SOURCE_TYPES.has(sourceType),
    endpoints
  };
}
