import { json } from '@sveltejs/kit';
import { readJsonBody } from '$lib/server/http/body';
import { getPublicAdultModeSettings, updateUserAdultPreference, updateGuestAdultPreference, getGuestCookieClearHeader } from '$lib/server/content/adult-policy';
import type { RequestHandler } from './$types';

// Adult Mode settings API.
//
// GET: Returns whether adult mode is available (adminAllows) and enabled
// (userEnabled) for the current user. For guests, reads the signed
// HttpOnly cookie. For authenticated users, reads the DB preference.
//
// PUT: Updates the user's adult mode preference. For authenticated users,
// persists to the DB. For guests, sets a signed HttpOnly cookie.
// The server enforces admin policy — if admin has disabled adult mode
// for the user type, the preference is forced to false.

export const GET: RequestHandler = async ({ locals, cookies }) => {
  const { user } = await locals.safeGetSession();
  const settings = await getPublicAdultModeSettings(locals.supabase, user, cookies);
  return json({ ok: true, ...settings });
};

export const PUT: RequestHandler = async ({ request, locals, cookies }) => {
  const { user } = await locals.safeGetSession();
  // Phase 1 (audit SEC-010): the shared bounded JSON-body parser (256 KiB
  // cap) — this unauthenticated route previously parsed the raw body with
  // with no size limit, inconsistent with the rest of the application.
  const parsed = await readJsonBody<{ enabled?: unknown }>(request);
  if (!parsed.ok) return json({ ok: false, error: { message: parsed.message } }, { status: parsed.status });
  const body = parsed.value;
  if (typeof body.enabled !== 'boolean') {
    return json({ ok: false, error: { message: 'The `enabled` field must be a boolean.' } }, { status: 400 });
  }
  try {
    if (user) {
      // Authenticated user: persist to DB.
      const effective = await updateUserAdultPreference(locals.supabase, user.id, body.enabled);
      // Clear any stale guest cookie when an authenticated user sets preference.
      const headers = new Headers();
      headers.append('set-cookie', getGuestCookieClearHeader());
      return json({ ok: true, enabled: effective }, { headers });
    } else {
      // Guest: set signed HttpOnly cookie. Server enforces admin policy.
      const result = await updateGuestAdultPreference(locals.supabase, body.enabled);
      const headers = new Headers();
      headers.append('set-cookie', result.setCookie);
      return json({ ok: true, enabled: result.enabled }, { headers });
    }
  } catch {
    return json({ ok: false, error: { message: 'Could not update adult mode preference.' } }, { status: 500 });
  }
};
