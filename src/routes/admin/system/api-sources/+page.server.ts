/**
 * Admin 2.0 — Phase 1 — API & Sources workspace page server.
 *
 * Canonical workspace for provider registry + source registry + defaults.
 * Contains ALL CRUD actions from the legacy /admin/providers, /admin/sources,
 * and /admin/defaults pages — no redirects to legacy UI needed.
 *
 * Tab routing: ?tab=providers|sources (defaults to providers).
 * Defaults are opened as a contextual sheet (not a tab).
 */

import { fail, redirect, error } from '@sveltejs/kit';
import { isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import {
  listAdminProviders, listProviderHealthSummaries,
  listAdminSources, listAdminDefaults,
  upsertDefaultSource, clearDefaultSource,
  createProvider, updateProvider, deleteProvider,
  createSource, updateSource, deleteSource,
} from '$lib/server/streaming/admin-service';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';
import { lookupProviderCapabilities } from '$lib/shared/player-capabilities';
import { parseProviderForm, parseSourceForm, parseId } from '$lib/server/streaming/validation';

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
  // --- Provider CRUD (migrated from /admin/providers) ---
  createProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const provider = await createProvider(locals.supabase, parseProviderForm(await request.formData()));
      throw redirect(303, `/admin/system/api-sources?tab=providers&notice=${encodeURIComponent(`Created ${provider.name}.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to create provider.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  updateProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Provider');
      const parsed = parseProviderForm(form);
      const { id: _ignored, ...input } = { id, ...parsed };
      const { data: existing } = await locals.supabase.from('streaming_providers').select('capabilities').eq('id', id).maybeSingle();
      const existingCapabilities = (existing?.capabilities && typeof existing.capabilities === 'object' && !Array.isArray(existing.capabilities))
        ? { ...(existing.capabilities as Record<string, unknown>) }
        : {};
      const mergedCapabilities = { ...existingCapabilities, sandbox_policy: parsed.capabilities.sandbox_policy };
      await updateProvider(locals.supabase, id, { ...input, capabilities: mergedCapabilities });
      throw redirect(303, `/admin/system/api-sources?tab=providers&notice=Provider%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update provider.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  toggleProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Provider');
      await updateProvider(locals.supabase, id, { enabled: String(form.get('enabled')) === 'true' });
      throw redirect(303, `/admin/system/api-sources?tab=providers&notice=Provider%20state%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update provider.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  deleteProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Provider');
      await deleteProvider(locals.supabase, id);
      throw redirect(303, `/admin/system/api-sources?tab=providers&notice=Provider%20deleted.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to delete provider.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },

  // --- Source CRUD (migrated from /admin/sources) ---
  createSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const source = await createSource(locals.supabase, parseSourceForm(await request.formData()));
      throw redirect(303, `/admin/system/api-sources?tab=sources&notice=${encodeURIComponent(`Created ${source.name}.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to create source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  updateSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Source');
      await updateSource(locals.supabase, id, parseSourceForm(form));
      throw redirect(303, `/admin/system/api-sources?tab=sources&notice=Source%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  toggleSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Source');
      await updateSource(locals.supabase, id, { enabled: String(form.get('enabled')) === 'true' });
      throw redirect(303, `/admin/system/api-sources?tab=sources&notice=Source%20state%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  deleteSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Source');
      await deleteSource(locals.supabase, id);
      throw redirect(303, `/admin/system/api-sources?tab=sources&notice=Source%20deleted.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to delete source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },

  // --- Defaults actions (migrated from /admin/defaults) ---
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
