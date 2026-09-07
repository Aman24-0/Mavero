import { json } from '@sveltejs/kit';
import { readJsonBody } from '$lib/server/http/body';
import type { LocalContentType } from '$lib/client/progress/types';
import type { RequestHandler } from './$types';

// Batch removal endpoint for the My List page.
//
// Atomicity: instead of issuing N independent DELETE requests for a batch
// (which would leave partial state behind if any single request failed,
// and would also leak the user's auth on every request), this endpoint
// invokes the `public.batch_remove_favorites(jsonb)` Postgres RPC. The
// RPC runs entirely inside the database, scoped to the authenticated
// user's own rows (SECURITY INVOKER + RLS), and returns per-identity
// success/failure so the caller can report partial results honestly.
//
// What the RPC does per identity (all-or-nothing within that row):
//   1. upsert a `favorite_deletions` tombstone,
//   2. delete the matching `favorites` row,
//   3. delete ALL `watch_progress` rows for that title (every episode).
//
// What it does NOT do:
//   - touch `watch_history` (history is a separate audit log),
//   - accept a `user_id` from the client (server resolves it via
//     `locals.safeGetSession()` and the RPC reads `auth.uid()`).

const MAX_ITEMS = 200;
const MAX_BODY_BYTES = 256 * 1024;

type BatchItem = { contentType: string; contentId: string };

function isValidType(value: string | null | undefined): value is LocalContentType {
  return value === 'movie' || value === 'series' || value === 'anime';
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const { user } = await locals.safeGetSession();
  if (!user) return json({ message: 'Authentication required.' }, { status: 401 });

  const body = await readJsonBody<{ items?: BatchItem[] }>(request, MAX_BODY_BYTES);
  if (!body.ok) return json({ message: body.message }, { status: body.status });
  if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value) || !Array.isArray(body.value.items)) {
    return json({ message: 'Request body must be an object with an `items` array.' }, { status: 400 });
  }

  const rawItems = body.value.items;
  if (rawItems.length === 0) {
    return json({ message: 'At least one item is required.' }, { status: 400 });
  }
  if (rawItems.length > MAX_ITEMS) {
    return json({ message: `Batch exceeds the maximum of ${MAX_ITEMS} items.` }, { status: 413 });
  }

  // Validate every identity up front so we never send malformed input to
  // the RPC. We also normalize contentId (trim) and deduplicate by key so
  // a payload with the same identity twice does not run the RPC twice.
  const seen = new Set<string>();
  const sanitized: BatchItem[] = [];
  for (const candidate of rawItems) {
    if (!candidate || typeof candidate !== 'object') continue;
    const contentType = typeof candidate.contentType === 'string' ? candidate.contentType : '';
    const contentId = typeof candidate.contentId === 'string' ? candidate.contentId.trim() : '';
    if (!isValidType(contentType) || !contentId) {
      return json({ message: 'Each item must have a valid contentType (movie|series|anime) and a non-empty contentId.' }, { status: 400 });
    }
    if (contentId.length > 120) {
      return json({ message: 'contentId is too long.' }, { status: 400 });
    }
    const key = `${contentType}:${contentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sanitized.push({ contentType, contentId });
  }
  if (sanitized.length === 0) {
    return json({ message: 'No valid items to remove.' }, { status: 400 });
  }

  // Delegate to the atomic RPC. The user_id is implicit (the RPC reads
  // auth.uid() inside the database), so we never accept or trust a
  // client-supplied user_id.
  const payload = sanitized.map((item) => ({
    contentType: item.contentType,
    contentId: item.contentId,
    deletedAt: new Date().toISOString()
  }));
  const { data, error } = await locals.supabase.rpc('batch_remove_favorites', { p_items: payload });

  if (error) {
    return json({ message: 'Cloud library removal failed.' }, { status: 503 });
  }

  // The RPC returns per-identity `{content_type, content_id, ok, error}` rows.
  // Map them back to the original casing the client expects.
  type RpcRow = { content_type: string | null; content_id: string | null; ok: boolean | null; error: string | null };
  const rows = Array.isArray(data) ? (data as RpcRow[]) : [];

  const succeeded = rows.filter((row) => Boolean(row.ok)).map((row) => ({
    contentType: row.content_type ?? '',
    contentId: row.content_id ?? ''
  }));
  const failed = rows.filter((row) => !row.ok).map((row) => ({
    contentType: row.content_type ?? '',
    contentId: row.content_id ?? '',
    error: row.error ?? 'unknown'
  }));

  return json({ ok: true, succeeded, failed });
};
