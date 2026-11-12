/**
 * Admin 2.0 — Phase F — Operations Attention API.
 *
 * GET /api/admin/operations/attention
 *   Returns aggregated items needing admin action: failed ops, stale ops,
 *   unconfigured providers, degraded providers.
 *
 * Query params:
 *   ?category=failed|stale|unconfigured|degraded|all
 *   ?severity=critical|warning|info|all
 *   ?provider=vidara|abyss
 *   ?page=1
 *   ?limit=25 (max 100)
 *
 * Security: Admin-only. No credentials exposed.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { OperationsService } from '$lib/server/hosting/operations/service';
import { NO_STORE } from '$lib/server/http/cache-headers';
import type { AttentionQuery, AttentionCategory, AttentionSeverity } from '$lib/shared/operations-types';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

const VALID_CATEGORIES = new Set(['failed', 'stale', 'unconfigured', 'degraded', 'all']);
const VALID_SEVERITIES = new Set(['critical', 'warning', 'info', 'all']);

export const GET: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const service = new OperationsService(adminClient);

  const category = url.searchParams.get('category') ?? 'all';
  const severity = url.searchParams.get('severity') ?? 'all';
  const provider = url.searchParams.get('provider') ?? undefined;
  const page = url.searchParams.get('page') ?? '1';
  const limit = url.searchParams.get('limit') ?? '25';

  if (!VALID_CATEGORIES.has(category)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Invalid category.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!VALID_SEVERITIES.has(severity)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Invalid severity.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const query: AttentionQuery = {
    category: category as AttentionCategory | 'all',
    severity: severity as AttentionSeverity | 'all',
    provider,
    page: Number(page),
    limit: Number(limit),
  };

  try {
    const result = await service.listAttention(query);
    return json({ ok: true, ...result }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load attention items.';
    return json({ ok: false, error: { code: 'ATTENTION_FAILED', message } }, { status: 502, headers: NO_STORE_HEADERS });
  }
};
