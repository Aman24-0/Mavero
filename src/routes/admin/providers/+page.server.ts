import { fail, redirect } from '@sveltejs/kit';
import { isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createProvider, deleteProvider, listAdminProviders, listAdminSources, listProviderHealthSummaries, updateProvider } from '$lib/server/streaming/admin-service';
import { parseId, parseProviderForm } from '$lib/server/streaming/validation';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';
import { configuredSandboxPolicy, type SandboxPolicy } from '$lib/shared/sandbox-policy';

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/providers' });
  // Phase 12 (GOAL F): sources ride along so the provider console can warn
  // when an explicit SOURCE-level sandbox override outranks the provider's
  // policy (the exact configured-vs-effective mismatch that made an admin
  // "Unrestricted" choice appear to be ignored at runtime).
  const [providers, health, sources] = await Promise.all([
    listAdminProviders(locals.supabase),
    listProviderHealthSummaries(locals.supabase),
    listAdminSources(locals.supabase),
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
  // Per-provider source sandbox overrides (source EXPLICIT policy ≠ null).
  const sourceSandboxOverrides: Record<string, Array<{ id: string; name: string; policy: SandboxPolicy }>> = {};
  for (const source of sources) {
    const policy = configuredSandboxPolicy(source.capabilities);
    if (!policy) continue;
    (sourceSandboxOverrides[source.provider_id] ??= []).push({ id: source.id, name: source.name, policy });
  }
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
      const { id: _ignored, ...input } = { id, ...parseProviderForm(form) };
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

