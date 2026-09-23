import { fail, redirect } from '@sveltejs/kit';
import { isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createProvider, deleteProvider, listAdminProviders, listProviderHealthSummaries, updateProvider } from '$lib/server/streaming/admin-service';
import { parseId, parseProviderForm } from '$lib/server/streaming/validation';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';


export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/providers' });
  // Phase 8: sandbox is provider-level only. Sources are no longer fetched here.
  const [providers, health] = await Promise.all([
    listAdminProviders(locals.supabase),
    listProviderHealthSummaries(locals.supabase),
  ]);
  // Phase 7: build a capability map keyed by adapter_id for the UI matrix.
  // lookupProviderCapabilities returns null for unknown adapters (display "Unknown").
  const { lookupProviderCapabilities } = await import('$lib/shared/player-capabilities');
  const capabilityMap: Record<string, { supported: string[]; unsupported: string[]; unknown: boolean } | null> = {};
  for (const provider of providers) {
    const caps = lookupProviderCapabilities(provider.adapter_id);
    if (!caps) {
      capabilityMap[provider.id] = null; // Unknown — display as "?" for all fields
    } else {
      capabilityMap[provider.id] = {
        supported: Object.entries(caps).filter(([, v]) => v === true).map(([k]) => k),
        unsupported: Object.entries(caps).filter(([, v]) => v === false).map(([k]) => k),
        unknown: false,
      };
    }
  }
  // Phase 8: source sandbox overrides are no longer computed — sandbox
  // is provider-level only. The sourceSandboxOverrides field is kept
  // as an empty object for backwards compatibility with the page data
  // shape, but it is always empty now.
  const sourceSandboxOverrides: Record<string, Array<{ id: string; name: string; policy: string }>> = {};
  return { providers, health, capabilityMap, sourceSandboxOverrides, notice: url.searchParams.get('notice') };
};

export const actions: Actions = {
  createProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/providers' });
    try {
      const provider = await createProvider(locals.supabase, parseProviderForm(await request.formData()));
      throw redirect(303, `/admin/providers?notice=${encodeURIComponent(`Created ${provider.name}.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to create provider.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  updateProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/providers' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Provider');
      const parsed = parseProviderForm(form);
      // Phase 8: for provider EDITS, preserve existing capabilities and
      // only merge the sandbox_policy. The form no longer sends a raw
      // capabilities JSON textarea (it was blank, causing data loss).
      // Fetch the existing provider's capabilities and merge the new
      // sandbox_policy into them.
      const { data: existing } = await locals.supabase
        .from('streaming_providers')
        .select('capabilities')
        .eq('id', id)
        .maybeSingle();
      const existingCapabilities = (existing?.capabilities && typeof existing.capabilities === 'object' && !Array.isArray(existing.capabilities))
        ? { ...(existing.capabilities as Record<string, unknown>) }
        : {};
      // Merge sandbox_policy into existing capabilities (preserving all other keys).
      const mergedCapabilities = { ...existingCapabilities, sandbox_policy: parsed.capabilities.sandbox_policy };
      const { id: _ignored, ...input } = { id, ...parsed, capabilities: mergedCapabilities };
      await updateProvider(locals.supabase, id, input);
      throw redirect(303, '/admin/providers?notice=Provider%20updated.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update provider.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  toggleProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/providers' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Provider');
      await updateProvider(locals.supabase, id, { enabled: String(form.get('enabled')) === 'true' });
      throw redirect(303, '/admin/providers?notice=Provider%20state%20updated.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update provider state.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  deleteProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/providers' });
    try {
      await deleteProvider(locals.supabase, parseId(await request.formData(), 'Provider'));
      throw redirect(303, '/admin/providers?notice=Provider%20deleted.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to delete provider.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
};

