import { redirect } from '@sveltejs/kit';
import { safeRedirectPath } from '$lib/server/supabase/server';
import { recordServerEvent } from '$lib/server/analytics/ingest';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
  const code = url.searchParams.get('code');
  const next = safeRedirectPath(url.searchParams.get('next'), '/account');

  if (code) {
    const { error } = await locals.supabase.auth.exchangeCodeForSession(code);
    if (error) throw redirect(303, `/auth/sign-in?error=confirmation&next=${encodeURIComponent(next)}`);

    // Phase 1 Analytics Foundation — server-authoritative `signup_completed`
    // event. Fired on the email-confirmation callback (the only path that
    // completes a NEW account in the email-confirmation flow). For
    // password-sign-up that auto-creates a session, the sign-up action
    // emits the event directly. anonymous_id comes from the cookie (still
    // present on the callback); user_id is re-resolved AFTER the session
    // exchange so we have the real authenticated identity.
    try {
      const { data: { user } } = await locals.supabase.auth.getUser();
      if (user && locals.anonymousId) {
        const admin = createSupabaseAdminClient();
        void recordServerEvent(
          admin,
          {
            event_id: crypto.randomUUID(),
            event_name: 'signup_completed',
            anonymous_id: locals.anonymousId,
            user_id: user.id,
            metadata: { method: 'email_confirmation' },
          },
          { requestId: locals.requestId }
        );
      }
    } catch {
      // Analytics must not break the callback redirect.
    }

    throw redirect(303, next);
  }

  throw redirect(303, '/auth/sign-in?error=missing_confirmation');
};
