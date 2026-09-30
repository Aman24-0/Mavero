/**
 * Admin 2.0 — Phase G — API & Sources workspace page server.
 *
 * Unified workspace for provider registry + source registry + defaults.
 * Reuses the existing admin-service CRUD functions — no new backend
 * APIs needed. The page server loads providers + sources + defaults +
 * health summaries + capability map in parallel.
 *
 * Tab routing: ?tab=providers|sources (defaults to providers).
 * Defaults are opened as a contextual sheet (not a tab).
 */

import { fail, redirect } from '@sveltejs/kit';
import { isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import {
  listAdminProviders, listProviderHealthSummaries,
  listAdminSources, listAdminDefaults,
  upsertDefaultSource, clearDefaultSource,
} from '$lib/server/streaming/admin-service';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';
import { lookupProviderCapabilities } from '$lib/shared/player-capabilities';
import { error } from '@sveltejs/kit';

const VALID_TABS = new Set(['providers', 'sources']);

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });

  const tab = url.searchParams.get('tab') ?? 'providers';
  if (!VALID_TABS.has(tab)) {
    throw error(400, 'Invalid tab. Use ?tab=providers|sources.');
  }

  const [providers, health, sources, defaults] = await Promise.all([
    listAdminProviders(locals.supabase),
    listProviderHealthSummaries(locals.supabase),
    listAdminSources(locals.supabase),
    listAdminDefaults(locals.supabase),
  ]);

  // Build capability map keyed by provider ID (same as legacy /admin/providers).
  const capabilityMap: Record<string, { supported: string[]; unsupported: string[]; unknown: boolean } | null> = {};
  for (const provider of providers) {
    const caps = lookupProviderCapabilities(provider.adapter_id);
    if (!caps) {
      capabilityMap[provider.id] = null;
    } else {
      capabilityMap[provider.id] = {
        supported: Object.entries(caps).filter(([, v]) => v === true).map(([k]) => k),
        unsupported: Object.entries(caps).filter(([, v]) => v === false).map(([k]) => k),
        unknown: false,
      };
    }
  }

  return {
    initialTab: tab,
    providers,
    health,
    capabilityMap,
    sources,
    defaults,
    notice: url.searchParams.get('notice'),
  };
};

export const actions: Actions = {
  // --- Defaults actions (moved from /admin/defaults) ---
  saveDefault: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const contentType = String(form.get('content_type') ?? '');
      const sourceId = String(form.get('source_id') ?? '');
      if (!contentType || !sourceId) return fail(400, { message: 'Content type and source are required.', contentType });
      await upsertDefaultSource(locals.supabase, contentType, sourceId);
      throw redirect(303, `/admin/system/api-sources?notice=${encodeURIComponent(`Default ${contentType} source updated.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to save default source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  clearDefault: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const contentType = String(form.get('content_type') ?? '');
      if (!contentType) return fail(400, { message: 'Content type is required.', contentType });
      await clearDefaultSource(locals.supabase, contentType);
      throw redirect(303, `/admin/system/api-sources?notice=${encodeURIComponent(`Default ${contentType} source cleared.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to clear default source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
};
