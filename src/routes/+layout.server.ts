import type { LayoutServerLoad } from './$types';

// Phase 2-A (audit PERF-001) — Session resolution optimization.
//
// The server hook (src/hooks.server.ts) resolves auth ONCE per request and
// stores the result on `locals.session` / `locals.user`. The previous
// implementation re-called `locals.safeGetSession()` here — a SECOND
// Supabase Auth network roundtrip (getSession + getUser) on every page
// navigation. That doubled the auth cost of every server-rendered route.
//
// We now read the already-resolved `locals.user` directly. The hook is the
// authoritative resolver; re-resolving here added latency without adding
// security (the hook already failed-closed on missing env and on auth
// initialization errors — see hooks.server.ts). Routes whose session
// genuinely changes mid-request (e.g. /auth/reset after
// exchangeCodeForSession) still call safeGetSession themselves — they
// don't go through this layout projection.
//
// Phase 2-B (audit PERF-002) — Auth payload projection.
//
// The client only needs IDENTITY: an opaque user id, the email, the display
// name, and whether the user is authenticated. The previous implementation
// serialized the full Supabase `Session` (access_token, refresh_token,
// expires_at, …) AND the full `User` object (user_metadata, app_metadata,
// identities, …) into the page payload.
//
// We now serialize a minimal projection. No access token, no refresh token,
// no expires_at, no identities, no app_metadata, no aud, no SSB event tokens.
// The session object is preserved server-side (locals.session) for any
// server route that genuinely needs the access token (e.g. calling Supabase
// on behalf of the user); the client never receives it.
//
// Client consumers of the layout payload were updated to read
// `data.user?.email`, `data.user?.displayName`, `data.isAuthenticated`
// instead of `data.user?.email`, `data.user?.user_metadata?.display_name`,
// `Boolean(data.user)`. The shape is intentionally smaller — no client
// behavior depends on tokens or full user metadata.
export const load: LayoutServerLoad = async ({ locals }) => {
  const user = locals.user;
  if (!user) {
    return { user: null, isAuthenticated: false };
  }
  const metadata = user.user_metadata;
  const displayName = typeof metadata?.display_name === 'string' && metadata.display_name.trim()
    ? metadata.display_name.trim()
    : null;
  return {
    user: { id: user.id, email: user.email, displayName },
    isAuthenticated: true
  };
};
