import { json } from '@sveltejs/kit';
import { getPublicAdultModeSettings, updateUserAdultPreference } from '$lib/server/content/adult-policy';
import type { RequestHandler } from './$types';

// Adult Mode settings API.
//
// GET: Returns whether adult mode is available (adminAllows) and enabled
// (userEnabled) for the current user. The client uses this to decide
// whether to render the Adult Mode toggle and the Indian Adult Shows
// section. This endpoint does NOT expose adult content — it only
// communicates availability/preference state.
//
// PUT: Updates the user's adult mode preference (ON/OFF). The server
// enforces admin policy — if admin has disabled adult mode for the
// user type, the preference is forced to false regardless of what the
// client sent.

export const GET: RequestHandler = async ({ locals }) => {
  const { user } = await locals.safeGetSession();
  const settings = await getPublicAdultModeSettings(locals.supabase, user);
  return json({ ok: true, ...settings });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
  const { user } = await locals.safeGetSession();
  if (!user) {
    return json({ ok: false, error: { message: 'Authentication required.' } }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  if (typeof body.enabled !== 'boolean') {
    return json({ ok: false, error: { message: 'The `enabled` field must be a boolean.' } }, { status: 400 });
  }
  try {
    // Server-side enforcement: updateUserAdultPreference checks admin
    // policy before persisting. If admin has disabled adult mode, the
    // preference is forced to false.
    const effective = await updateUserAdultPreference(locals.supabase, user.id, body.enabled);
    return json({ ok: true, enabled: effective });
  } catch {
    return json({ ok: false, error: { message: 'Could not update adult mode preference.' } }, { status: 500 });
  }
};
