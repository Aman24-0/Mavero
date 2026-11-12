/**
 * Unified Mavero Downloader — global source ordering service (server).
 *
 * The read/write surface over `downloader_source_order` (migration
 * 20261004000000):
 *   * getGlobalSourceOrder — reads the persisted ordering rows. DEGRADES
 *     GRACEFULLY when the table does not exist yet (PGRST205 — the
 *     migration has not been applied): returns an EMPTY list, and the
 *     pure ranking fallback (unified-downloader.rankUnifiedSources)
 *     produces the documented deterministic default order (addons by
 *     streaming_addons ordering → extensions by catalog order). The
 *     unified downloader therefore works BEFORE the migration lands; only
 *     explicit reordering waits for it.
 *   * setGlobalSourcePosition — RPC-first (atomic, advisory-locked, dense
 *     renumber, streaming_addons resync — the migration's contract); falls
 *     back to a deterministic read-modify-write when the RPC is unavailable
 *     (PGRST202); reports TABLE_MISSING honestly when the table itself is
 *     absent so callers can route their own legacy fallbacks.
 *
 * SECURITY:
 *   * Reads/writes happen through the ADMIN client only (the table has NO
 *     public read policy — CS-1 RLS posture).
 *   * Position values are bounded safe integers ≥ 1 (1-based contract).
 *   * The source key format is validated BEFORE it reaches a query
 *     (addon:<uuid> | extension:(cloudstream|nuvio):<name>) — the same
 *     format the table CHECK enforces.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import {
  addonOrderKey,
  extensionOrderKey,
  rankUnifiedSources,
  type RankAddonTab,
  type RankExtensionTab,
  type SourceOrderEntry,
} from '$lib/shared/unified-downloader';

type OrderClient = SupabaseClient<Database>;

/** Honest failure codes for the position mutation (closed vocabulary). */
export type SetSourcePositionErrorCode =
  | 'TABLE_MISSING'
  | 'INVALID_KEY'
  | 'INVALID_POSITION'
  | 'NOT_FOUND'
  | 'WRITE_FAILED';

export type SetSourcePositionResult =
  | { ok: true; position: number }
  | { ok: false; code: SetSourcePositionErrorCode; message: string };

/** PostgREST error shape subset (supabase-js PostgrestError). */
type PgError = { code?: string; message?: string };

function isPgError(value: unknown): value is PgError {
  return typeof value === 'object' && value !== null && 'message' in value;
}

/** True when the error means the table is missing from the schema cache. */
function isTableMissing(error: unknown): boolean {
  if (!isPgError(error)) return false;
  const code = error.code ?? '';
  const message = error.message ?? '';
  return code === 'PGRST205' || /could not find the table/i.test(message) || /does not exist/i.test(message);
}

/** True when the error means the RPC is unavailable in the schema cache. */
function isRpcMissing(error: unknown): boolean {
  if (!isPgError(error)) return false;
  const code = error.code ?? '';
  const message = error.message ?? '';
  return (
    code === 'PGRST202' ||
    code === '42883' ||
    /could not find the function/i.test(message) ||
    /set_downloader_source_position/i.test(message)
  );
}

// ---------------------------------------------------------------------------
// Key validation (mirrors the table CHECK + the migration's RPC guard)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The JS twin of the migration's POSIX check ('^extension:(cloudstream|nuvio):[^[:space:]]{1,180}$')
// — JS regex has no POSIX classes, so \S (any non-whitespace) is the exact
// equivalent (Postgres [^[:space:]] == JS \S).
const CANONICAL_RE = /^(cloudstream|nuvio):\S{1,180}$/;

/** The addon ordering key (validated UUID). Throws on a malformed id. */
export function validatedAddonOrderKey(addonId: string): string {
  const key = addonOrderKey(addonId);
  if (!UUID_RE.test(addonId)) {
    throw new Error('The add-on ordering key is invalid.');
  }
  return key;
}

/**
 * The extension ordering key from a CANONICAL adapter key
 * ('cloudstream:bollyflix' / 'nuvio:moviesdrive'). Throws on a malformed key.
 */
export function validatedExtensionOrderKey(canonicalAdapterKey: string): string {
  if (!CANONICAL_RE.test(canonicalAdapterKey)) {
    throw new Error('The extension ordering key is invalid.');
  }
  return extensionOrderKey(canonicalAdapterKey);
}

function isValidOrderKeyShape(sourceKey: string): boolean {
  if (sourceKey.startsWith('addon:')) return UUID_RE.test(sourceKey.slice(6));
  if (sourceKey.startsWith('extension:')) return CANONICAL_RE.test(sourceKey.slice(10));
  return false;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Reads the persisted global ordering rows, deterministically ordered by
 * position (ties defensively broken by source_key — the RPC keeps positions
 * dense, so this is belt-and-braces).
 *
 * Returns [] when the table is missing (pre-migration degradation — the
 * ranking fallback takes over; never throws for the READER path).
 */
export async function getGlobalSourceOrder(client: OrderClient): Promise<SourceOrderEntry[]> {
  const { data, error } = await client
    .from('downloader_source_order')
    .select('source_key,position')
    .order('position', { ascending: true })
    .order('source_key', { ascending: true });
  if (error) {
    if (isTableMissing(error)) return [];
    throw new Error(`Global source order lookup failed: ${error.message}`);
  }
  const rows = (data ?? []) as Array<{ source_key: string; position: number }>;
  return rows
    .filter((row) => isValidOrderKeyShape(row.source_key) && Number.isSafeInteger(row.position) && row.position >= 1)
    .map((row) => ({ sourceKey: row.source_key, position: row.position }));
}

// ---------------------------------------------------------------------------
// Write (admin mutations)
// ---------------------------------------------------------------------------

/**
 * Moves one source to a 1-based global position (dense renumber + addon
 * resync handled by the RPC; read-modify-write fallback when the RPC is
 * unavailable).
 *
 * Callers that own a legacy fallback (the add-on admin path) branch on
 * code === 'TABLE_MISSING' and route to it; the extension admin path
 * surfaces the honest message instead.
 */
export async function setGlobalSourcePosition(
  client: OrderClient,
  sourceKey: string,
  position: number,
): Promise<SetSourcePositionResult> {
  if (!isValidOrderKeyShape(sourceKey)) {
    return { ok: false, code: 'INVALID_KEY', message: 'The source key is invalid.' };
  }
  if (!Number.isSafeInteger(position) || position < 1) {
    return { ok: false, code: 'INVALID_POSITION', message: 'Position must be a whole number starting at 1.' };
  }

  // Primary path: atomic RPC (admin-authorized through the request session).
  try {
    const { data, error } = await client.rpc('set_downloader_source_position', {
      p_source_key: sourceKey,
      p_position: position,
    });
    if (!error) {
      const final = typeof data === 'number' ? data : position;
      return { ok: true, position: final };
    }
    if (!isRpcMissing(error)) {
      // Genuine RPC failures (authorization, range validation) carry curated
      // messages from the SQL function — surface them honestly.
      return { ok: false, code: 'WRITE_FAILED', message: error.message || 'Failed to set the source position.' };
    }
    console.warn(
      '[setGlobalSourcePosition] RPC set_downloader_source_position unavailable — falling back to the deterministic read-modify-write. Apply migration 20261004000000 to enable the atomic path.',
    );
  } catch (rpcError) {
    const message = rpcError instanceof Error ? rpcError.message : String(rpcError);
    if (!isRpcMissing({ message })) throw rpcError;
    console.warn('[setGlobalSourcePosition] RPC failed — falling back to the deterministic read-modify-write.', message);
  }

  // Fallback: deterministic read-modify-write (single-writer correctness is
  // provided by the admin-only surface; the RPC remains the primary path).
  const { data, error: readError } = await client
    .from('downloader_source_order')
    .select('source_key,position')
    .order('position', { ascending: true })
    .order('source_key', { ascending: true });
  if (readError) {
    if (isTableMissing(readError)) {
      return {
        ok: false,
        code: 'TABLE_MISSING',
        message: 'Global source ordering is not initialized yet — apply migration 20261004000000.',
      };
    }
    return { ok: false, code: 'WRITE_FAILED', message: 'Failed to read the global source order.' };
  }
  const rows = (data ?? []) as Array<{ source_key: string; position: number }>;

  const exists = rows.some((row) => row.source_key === sourceKey);
  const total = rows.length;
  const upperBound = exists ? total : total + 1;
  if (position > upperBound) {
    return {
      ok: false,
      code: 'INVALID_POSITION',
      message: `Position must be between 1 and ${upperBound}.`,
    };
  }

  // Build the new dense 1..N order (pure move semantics).
  const others = rows.filter((row) => row.source_key !== sourceKey).map((row) => row.source_key);
  const order: string[] = [];
  for (let index = 0; index < others.length; index += 1) {
    if (order.length + 1 === position) order.push(sourceKey);
    order.push(others[index]!);
  }
  if (order.length < position || !order.includes(sourceKey)) order.push(sourceKey);

  // Persist: one update per row whose position changed (positions are dense
  // and unique by construction; sequential updates are safe WITHOUT a unique
  // constraint — the migration documents this deliberately).
  for (let index = 0; index < order.length; index += 1) {
    const key = order[index]!;
    const row = rows.find((candidate) => candidate.source_key === key);
    const nextPosition = index + 1;
    if (row && row.position === nextPosition) continue;
    if (row) {
      const { error: updateError } = await client
        .from('downloader_source_order')
        .update({ position: nextPosition })
        .eq('source_key', key);
      if (updateError) {
        return { ok: false, code: 'WRITE_FAILED', message: updateError.message };
      }
    } else {
      const { error: insertError } = await client
        .from('downloader_source_order')
        .insert({ source_key: key, position: nextPosition });
      if (insertError) {
        return { ok: false, code: 'WRITE_FAILED', message: insertError.message };
      }
    }
  }

  // Addon resync (the RPC's contract, mirrored): streaming_addons.ordering
  // takes the addon-relative dense 0..M-1 ranks from the NEW global order.
  if (sourceKey.startsWith('addon:')) {
    const addonKeys = order.filter((key) => key.startsWith('addon:'));
    for (let index = 0; index < addonKeys.length; index += 1) {
      const addonId = addonKeys[index]!.slice(6);
      const { error: syncError } = await client
        .from('streaming_addons')
        .update({ ordering: index })
        .eq('id', addonId);
      if (syncError) {
        return { ok: false, code: 'WRITE_FAILED', message: syncError.message };
      }
    }
  }

  return { ok: true, position };
}

// ---------------------------------------------------------------------------
// Admin position computation (the merged global rank map)
// ---------------------------------------------------------------------------

/**
 * Computes the CURRENT global rank of every admin-visible source — the SAME
 * pure ranking rule the user-facing /sources endpoint applies, evaluated
 * over ALL add-ons (enabled + disabled; the ordering namespace is total)
 * and every repo-enabled + enabled extension (the backfill set). The admin
 * position controls display these ranks; the mutation recomputes them.
 *
 * Returns a map keyed by the FULL ordering key ('addon:<uuid>' |
 * 'extension:<canonicalKey>') → 1-based dense global rank. Degrades to the
 * fallback order when the ordering table is absent (pre-migration), so the
 * admin position display works before the migration lands.
 */
export async function computeAdminGlobalPositions(client: OrderClient): Promise<Map<string, number>> {
  // Add-ons: (ordering, name, created_at) — the canonical admin order.
  const { data: addonData, error: addonError } = await client
    .from('streaming_addons')
    .select('id,name,ordering,created_at')
    .order('ordering', { ascending: true })
    .order('name', { ascending: true })
    .order('created_at', { ascending: true });
  if (addonError) throw new Error(`Addon order lookup failed: ${addonError.message}`);
  const addonTabs = ((addonData ?? []) as Array<{ id: string; name: string }>).map((row) => ({
    addonId: row.id,
    addonName: row.name,
  })) satisfies RankAddonTab[];

  // Extensions: repo-enabled + enabled rows in catalog order (repository
  // created_at → internal_name) — the SAME order the backfill + the
  // /mavero2/tabs eligibility use.
  const { data: repoData, error: repoError } = await client
    .from('cloudstream_repositories')
    .select('id,enabled,created_at')
    .order('created_at', { ascending: true });
  if (repoError) throw new Error(`Repository order lookup failed: ${repoError.message}`);
  const repoOrder = new Map(((repoData ?? []) as Array<{ id: string; enabled: boolean }>).map((repo, index) => [repo.id, index]));
  const repoEnabled = new Set(((repoData ?? []) as Array<{ id: string; enabled: boolean }>).filter((repo) => repo.enabled).map((repo) => repo.id));

  const { data: extData, error: extError } = await client
    .from('cloudstream_extensions')
    .select('repository_id,internal_name,name,enabled,integration_type');
  if (extError) throw new Error(`Extension order lookup failed: ${extError.message}`);
  const extensionTabs = ((extData ?? []) as Array<{ repository_id: string; internal_name: string; name: string | null; enabled: boolean; integration_type: string }>)
    .filter((row) => repoEnabled.has(row.repository_id) && row.enabled)
    .sort((a, b) => {
      const orderDiff = (repoOrder.get(a.repository_id) ?? 0) - (repoOrder.get(b.repository_id) ?? 0);
      if (orderDiff !== 0) return orderDiff;
      return a.internal_name.localeCompare(b.internal_name);
    })
    .map((row) => {
      const canonicalKey = row.integration_type === 'nuvio'
        ? `nuvio:${row.internal_name.toLowerCase()}`
        : `cloudstream:${row.internal_name.toLowerCase()}`;
      return {
        // The canonical key doubles as the tab correlation id — unique per
        // user-visible source, so the ranked output maps back exactly.
        extensionId: canonicalKey,
        extensionName: row.name ?? row.internal_name,
        canonicalKey,
      };
    })
    // Canonical dedup (first in catalog order wins — the SAME rule the
    // user-facing eligibility selection applies): one user-visible source
    // has exactly one ordering key, so the admin rank map can never count
    // a phantom duplicate row.
    .filter((tab, index, list) => list.findIndex((candidate) => candidate.canonicalKey === tab.canonicalKey) === index) satisfies RankExtensionTab[];

  const order = await getGlobalSourceOrder(client);
  const ranked = rankUnifiedSources(addonTabs, extensionTabs, order);
  // Map ranks back onto their ordering keys by EXACT id correlation — the
  // extension tab id IS the canonical key here (unique per user-visible
  // source), and the add-on id is the unique row UUID, so no ambiguity is
  // possible even when an internal name appears under both integration
  // types.
  const positions = new Map<string, number>();
  for (const source of ranked) {
    if (source.kind === 'addon') {
      positions.set(`addon:${source.id}`, source.position);
    } else {
      positions.set(`extension:${source.id}`, source.position);
    }
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Extension position mutation (admin surface — PART G)
// ---------------------------------------------------------------------------

/**
 * Moves ONE CloudStream/Nuvio extension to a 1-based global position (task
 * PART G: the plugin counterpart of the add-on position control, in the
 * SAME global ordering namespace). The extension's ordering key is derived
 * from its row through the canonical adapter key — never the bare name
 * (cross-integration name collisions cannot cross wires).
 *
 * Returns the mutation result + the FRESH global position map (the caller
 * patches every displayed position from it, not just the moved row).
 */
export async function setExtensionPosition(
  client: OrderClient,
  id: unknown,
  position: number,
): Promise<{ result: SetSourcePositionResult; positions: Map<string, number> }> {
  const extensionId = typeof id === 'string' && id.length > 0 ? id : null;
  if (extensionId === null) {
    return {
      result: { ok: false, code: 'INVALID_KEY', message: 'An extension id is required.' },
      positions: new Map(),
    };
  }
  const { data, error } = await client
    .from('cloudstream_extensions')
    .select('id,internal_name,integration_type')
    .eq('id', extensionId)
    .maybeSingle();
  if (error || data === null) {
    return {
      result: { ok: false, code: 'NOT_FOUND', message: 'Extension not found.' },
      positions: new Map(),
    };
  }
  const row = data as { internal_name: string; integration_type: string };
  const canonicalKey = row.integration_type === 'nuvio'
    ? `nuvio:${row.internal_name.toLowerCase()}`
    : `cloudstream:${row.internal_name.toLowerCase()}`;

  let orderKey: string;
  try {
    orderKey = validatedExtensionOrderKey(canonicalKey);
  } catch {
    return {
      result: { ok: false, code: 'INVALID_KEY', message: 'The extension ordering key is invalid.' },
      positions: new Map(),
    };
  }

  const result = await setGlobalSourcePosition(client, orderKey, position);
  const positions = result.ok
    ? await computeAdminGlobalPositions(client).catch(() => new Map<string, number>())
    : new Map<string, number>();
  return { result, positions };
}
