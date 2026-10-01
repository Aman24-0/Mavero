import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { asResolverError } from '$lib/server/resolver/errors';
import { resolveSource } from '$lib/server/resolver/service';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { DemandService } from '$lib/server/hosting/demand/service';
import type { ResolverRequest, SourceResult } from '$lib/server/resolver/types';

export const POST: RequestHandler = async ({ request, locals }) => {
  const parsed = await readJsonBody<unknown>(request);
  if (!parsed.ok) return json({ ok: false, error: { code: parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', message: parsed.status === 413 ? parsed.message : 'The playback request is invalid.' } }, { status: parsed.status });
  const body = parsed.value;

  const verdict = checkRateLimit('resolve', clientIdentity(request.headers, locals.user?.id));
  if (!verdict.allowed) {
    return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(verdict.retryAfterSeconds) } });
  }

  try {
    const source = await resolveSource(locals.supabase, body);

    // Phase 9: Missing-media demand tracking. Fire-and-forget — must NOT
    // block or delay the playback response. Only fires when the resolved
    // source was NOT a Mavero-hosted provider (meaning both Vidara and
    // Abyss were unavailable for this content). The demand signal comes
    // from a real playback attempt, NOT from search/browse/detail.
    recordDemandIfNeeded(source, body, locals.user?.id).catch(() => {
      // Silently absorb — demand tracking must NOT break playback.
    });

    return json({ ok: true, source }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const resolverError = asResolverError(error);
    if (resolverError.code === 'INTERNAL_RESOLUTION_ERROR') console.error('[Playback] Resolution failed', { code: resolverError.code });

    // Phase 9: also record demand when resolution fails entirely (both
    // Mavero providers missing + all fallback sources also failed).
    recordDemandIfNeeded(null, body, locals.user?.id).catch(() => {});

    return json({ ok: false, error: { code: resolverError.code, message: resolverError.message } }, { status: resolverError.status, headers: { 'cache-control': 'no-store' } });
  }
};

/**
 * Phase 9 — Records a missing-media demand request if the resolved source
 * was NOT a Mavero-hosted provider. This is the ONLY insertion point for
 * demand tracking — NOT search, NOT browse, NOT detail page load.
 *
 * The demand signal fires when:
 *   1. Resolution succeeded with a non-Mavero fallback source (meaning
 *      both Mavero providers were unavailable but a fallback worked).
 *   2. Resolution failed entirely (all sources unavailable).
 *
 * It does NOT fire when:
 *   - A Mavero provider resolved successfully (the media is hosted).
 *   - The request was from search/browse (different endpoint entirely).
 */
async function recordDemandIfNeeded(
  source: SourceResult | null,
  requestBody: unknown,
  userId: string | undefined,
): Promise<void> {
  // Check if the resolved source is a Mavero-hosted provider.
  // If source is null (resolution failed) or the source is not from
  // a Mavero provider, record the demand.
  if (source && source.type !== 'unavailable' && source.type !== 'error') {
    // Resolution succeeded — check if it was a Mavero provider.
    // Mavero providers have adapter_id 'vidara' or 'abyss'. The
    // Mavero-hosted resolver adapter stamps `adapterId` into the
    // source metadata (see mavero-hosted.ts), so we can check it
    // directly — this is robust against provider display-name
    // changes (e.g. "Vidara" → "Vidara Pro" would silently break a
    // pure providerName check).
    //
    // The providerName substring fallback is retained for backward
    // compatibility with any older resolver path that does not yet
    // set adapterId on the metadata — it must NOT be removed.
    const adapterId = source.metadata?.adapterId ?? source.metadata?.adapter_id ?? '';
    const providerName = source.metadata?.providerName?.toLowerCase() ?? '';
    if (adapterId === 'vidara' || adapterId === 'abyss' || providerName.includes('mavero') || providerName.includes('vidara') || providerName.includes('abyss')) {
      // A Mavero provider resolved — do NOT record demand.
      return;
    }
  }

  // At this point, either resolution failed or a non-Mavero fallback
  // resolved. Record the missing-media demand.
  const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return;

  const client = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  });

  // Parse the request body to get the resolver request parameters.
  const req = requestBody as ResolverRequest;
  if (!req || !req.contentId || !req.mediaType) return;

  // Get the content details to build the canonical key.
  const { getDetail } = await import('$lib/server/content/service');
  try {
    const content = await getDetail(req.mediaType, req.contentId);
    const userKind = userId ? 'authenticated' : 'guest';
    const entry = DemandService.buildEntry(content, req, userKind);
    if (!entry) return;

    const demandService = new DemandService(client);
    await demandService.recordDemand(entry);
  } catch {
    // Silently absorb — demand tracking must NOT break playback.
  }
}
