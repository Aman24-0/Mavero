import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { readJsonBody } from '$lib/server/http/body';
import { updateAdminAdultPolicy, getPublicAdultModeSettings } from '$lib/server/content/adult-policy';
import type { RequestHandler } from './$types';

// Admin Adult Mode policy API.
//
// GET: Returns the current admin adult mode policy (allowLoggedIn, allowGuest).
// PUT: Updates the admin adult mode policy. Admin-only — uses the existing
// requireAdmin auth guard. After update, the in-memory policy cache is
// invalidated so changes take effect within 60s for all users.

export const GET: RequestHandler = async ({ locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const settings = await getPublicAdultModeSettings(locals.supabase, null);
  // For admin, we return the full policy, not just the user-facing settings.
  const { data } = await locals.supabase
    .from('app_settings')
    .select('adult_mode_allow_logged_in, adult_mode_allow_guest')
    .eq('id', 1)
    .single();
  return json({
    ok: true,
    policy: {
      allowLoggedIn: data?.adult_mode_allow_logged_in ?? false,
      allowGuest: data?.adult_mode_allow_guest ?? false,
    }
  });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  // Phase 1 (audit SEC-010): the shared bounded JSON-body parser (256 KiB
  // cap), consistent with the rest of the application. Auth, validation and
  // error conventions are unchanged.
  const parsed = await readJsonBody<Record<string, unknown>>(request);
  if (!parsed.ok) return json({ ok: false, error: { message: parsed.message } }, { status: parsed.status });
  const body = parsed.value;
  const updates: { allowLoggedIn?: boolean; allowGuest?: boolean } = {};
  if (typeof body.allowLoggedIn === 'boolean') updates.allowLoggedIn = body.allowLoggedIn;
  if (typeof body.allowGuest === 'boolean') updates.allowGuest = body.allowGuest;
  if (Object.keys(updates).length === 0) {
    return json({ ok: false, error: { message: 'No valid fields to update.' } }, { status: 400 });
  }
  try {
    const policy = await updateAdminAdultPolicy(locals.supabase, updates);
    return json({ ok: true, policy });
  } catch {
    return json({ ok: false, error: { message: 'Failed to update adult mode policy.' } }, { status: 500 });
  }
};
