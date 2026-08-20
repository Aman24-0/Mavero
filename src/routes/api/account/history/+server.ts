import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { historyToRow, type CloudHistoryEvent } from '$lib/server/supabase/records';

export const POST: RequestHandler = async ({ locals, request }) => {
  const { user } = await locals.safeGetSession();
  if (!user) return json({ message: 'Authentication required.' }, { status: 401 });

  const body = await request.json().catch(() => null) as { event?: CloudHistoryEvent } | null;
  const event = body?.event;
  if (!event || !event.eventKey || !event.eventType || !event.contentId) return json({ message: 'Invalid history event.' }, { status: 400 });

  const { error } = await locals.supabase.from('watch_history').insert(historyToRow(user.id, event));
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
  return json({ history: data });
};
