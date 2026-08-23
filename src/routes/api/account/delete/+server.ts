import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteAuthenticatedAccount, AccountDeletionError } from '$lib/server/account/deletion';
import { readJsonBody } from '$lib/server/http/body';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';

const MAX_DELETE_BODY_BYTES = 16 * 1024;
const deletionInFlight = new Set<string>();

type DeleteRequest = { confirmation?: unknown };

export const POST: RequestHandler = async ({ locals, request }) => {
  const { user } = await locals.safeGetSession();
  if (!user) return json({ ok: false, message: 'Authentication required.' }, { status: 401 });
  if (deletionInFlight.has(user.id)) return json({ ok: false, message: 'Account deletion is already in progress.' }, { status: 409 });

  const body = await readJsonBody<DeleteRequest>(request, MAX_DELETE_BODY_BYTES);
  if (!body.ok) return json({ ok: false, message: body.message }, { status: body.status });
  if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value) || body.value.confirmation !== 'DELETE') {
    return json({ ok: false, message: 'Type DELETE to confirm account deletion.' }, { status: 400 });
  }

  deletionInFlight.add(user.id);
  try {
    const admin = createSupabaseAdminClient();
    await deleteAuthenticatedAccount(user.id, admin);

    const { error: signOutError } = await locals.supabase.auth.signOut();
    if (signOutError) console.error('[Account deletion] Session cleanup returned an error.', { code: signOutError.code });

    return json({ ok: true, message: 'Account deleted successfully.' }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof AccountDeletionError) {
      return json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status, headers: { 'cache-control': 'no-store' } });
    }
    console.error('[Account deletion] Request failed.', { code: 'DELETE_FAILED', userId: user.id });
    return json({ ok: false, error: { code: 'DELETE_FAILED', message: 'Unable to delete the account right now.' } }, { status: 503, headers: { 'cache-control': 'no-store' } });
  } finally {
    deletionInFlight.delete(user.id);
  }
};
