import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { asDiscoveryError } from '$lib/server/discovery/errors';
import { discoverPublicPage } from '$lib/server/discovery/service';
import { toPlayerSources } from '$lib/server/discovery/player-source';
import type { ResolverMediaType } from '$lib/server/resolver/types';

function statusForDiscoveryError(code: ReturnType<typeof asDiscoveryError>['code']): number {
  if (code === 'SOURCE_NOT_FOUND') return 404;
  if (code === 'BLOCKED_SOURCE') return 403;
  if (code === 'TIMEOUT') return 504;
  if (code === 'CANCELLED') return 499;
  if (code === 'UNSUPPORTED_FORMAT') return 422;
  return 502;
}

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await readJsonBody<unknown>(request);
  if (!parsed.ok) return json({ ok: false, error: { code: parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', message: parsed.status === 413 ? parsed.message : 'The discovery request is invalid.' } }, { status: parsed.status });
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'A public page URL is required.' } }, { status: 400 });
  }
  const input = body as { pageUrl?: unknown; mediaType?: unknown; timeoutMs?: unknown };
  if (typeof input.pageUrl !== 'string' || !input.pageUrl.trim()) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'A public page URL is required.' } }, { status: 400 });
  }
  const mediaType: ResolverMediaType = input.mediaType === 'series' || input.mediaType === 'anime' ? input.mediaType : 'movie';
  const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) ? Math.min(10000, Math.max(1000, input.timeoutMs)) : undefined;
  try {
    const result = await discoverPublicPage({ pageUrl: input.pageUrl, timeoutMs });
    return json({ ok: true, streams: result.streams, playerSources: toPlayerSources(result.streams, mediaType), diagnostics: result.diagnostics }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const discoveryError = asDiscoveryError(error);
    console.error('[Universal Discovery]', { code: discoveryError.code });
    return json({ ok: false, error: { code: discoveryError.code, message: discoveryError.message } }, { status: statusForDiscoveryError(discoveryError.code), headers: { 'cache-control': 'no-store' } });
  }
};
