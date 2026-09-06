import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { historyFromRow, historyToRow, isCloudHistoryEvent, type CloudHistoryEvent } from '$lib/server/supabase/records';

type HistoryRequest = { event?: unknown };

export const POST: RequestHandler = async ({ locals, request }) => {
  const { user } = await locals.safeGetSession();
  if (!user) return json({ message: 'Authentication required.' }, { status: 401 });

  const body = await readJsonBody<HistoryRequest>(request);
  if (!body.ok) return json({ message: body.message }, { status: body.status });
  if (!isCloudHistoryEvent(body.value.event)) return json({ message: 'Invalid history event.' }, { status: 400 });

  const { error } = await locals.supabase
    .from('watch_history')
    .upsert(historyToRow(user.id, body.value.event), { onConflict: 'user_id,event_key' });
  if (error) return json({ message: 'History is temporarily unavailable.' }, { status: 503 });
  return json({ ok: true });
};

export const GET: RequestHandler = async ({ locals, url }) => {
  const { user } = await locals.safeGetSession();
  if (!user) return json({ message: 'Authentication required.' }, { status: 401 });

  const requestedLimit = Number(url.searchParams.get('limit') ?? 50);
  const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 50;
  const { data, error } = await locals.supabase.from('watch_history').select('*').order('occurred_at', { ascending: false }).limit(limit);
  if (error) return json({ message: 'History is temporarily unavailable.' }, { status: 503 });
  return json({ history: (data ?? []).map(historyFromRow) satisfies CloudHistoryEvent[] });
};
