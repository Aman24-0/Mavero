import { json } from '@sveltejs/kit';
import { getPublicDownloadConfig, rewriteMaveroOrigins } from '$lib/server/downloader/public-config';
import type { RequestHandler } from './$types';

// Public downloader configuration endpoint.
//
// Returns ONLY enabled providers + the public fields (id, name, slug, enabled,
// isDefault, ordering, icon, description, supportsMovie, supportsTv,
// movieUrlTemplate, tvUrlTemplate). No admin-only metadata, no secrets.
//
// Phase 19: Mavero Downloader + 4K Downloader are now DB-managed rows. The
// config endpoint reads them from the DB (getPublicDownloadConfig) and
// rewrites the Mavero URL templates to the current origin (the DB stores
// https://mavero.local/... placeholders to satisfy the HTTPS CHECK).
//
// Caching: the server-side reader has an in-process cache keyed by the
// download_providers_config_meta version counter, which is bumped by a DB
// trigger on every mutation. The HTTP layer adds a short max-age so the
// browser can reuse the response between DetailPage visits without
// re-fetching.

export const GET: RequestHandler = async ({ locals, url, setHeaders }) => {
  try {
    const config = await getPublicDownloadConfig(locals.supabase);
    setHeaders({ 'cache-control': 'public, max-age=15, stale-while-revalidate=30' });
    return json({ ok: true, config: rewriteMaveroOrigins(config, url.origin) });
  } catch (error) {
    console.error('[Downloader] Public configuration failed', error);
    return json({ ok: false, error: { message: 'Downloader configuration is temporarily unavailable.' } }, { status: 503 });
  }
};
