/**
 * Admin 2.0 — Phase 1 — Downloads page server.
 * Full CRUD for downloader providers.
 */

import { fail, redirect } from '@sveltejs/kit';
import { isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { listAdminDownloadProviders, getDownloadersAdminOverview, createDownloadProvider, updateDownloadProvider, deleteDownloadProvider, setDefaultDownloadProvider } from '$lib/server/downloader/admin-service';
import { parseDownloadProviderForm } from '$lib/server/downloader/validation';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';
import { StreamingValidationError } from '$lib/server/streaming/validation';

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/system/downloads' });
  const [providers, overview] = await Promise.all([
    listAdminDownloadProviders(locals.supabase),
    getDownloadersAdminOverview(locals.supabase),
  ]);
  return { providers, overview, notice: url.searchParams.get('notice') };
};

export const actions: Actions = {
  createProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/downloads' });
    try {
      const provider = await createDownloadProvider(locals.supabase, parseDownloadProviderForm(await request.formData()));
      throw redirect(303, `/admin/system/downloads?notice=${encodeURIComponent(`Created ${provider.name}.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      if (error instanceof StreamingValidationError) return fail(400, { message: error.message });
      const result = classifyAdminMutationError(error, 'Unable to create downloader.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  updateProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/downloads' });
    try {
      const form = await request.formData();
      const id = String(form.get('id') ?? '');
      const { id: _ignored, ...input } = { id, ...parseDownloadProviderForm(form) };
      await updateDownloadProvider(locals.supabase, id, input);
      throw redirect(303, `/admin/system/downloads?notice=Downloader%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      if (error instanceof StreamingValidationError) return fail(400, { message: error.message });
      const result = classifyAdminMutationError(error, 'Unable to update downloader.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  toggleProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/downloads' });
    try {
      const form = await request.formData();
      const id = String(form.get('id') ?? '');
      const enabled = String(form.get('enabled')) === 'true';
      await updateDownloadProvider(locals.supabase, id, { enabled });
      throw redirect(303, `/admin/system/downloads?notice=Downloader%20state%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update downloader.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  setDefault: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/downloads' });
    try {
      const form = await request.formData();
      const id = String(form.get('id') ?? '');
      await setDefaultDownloadProvider(locals.supabase, id);
      throw redirect(303, `/admin/system/downloads?notice=Default%20downloader%20set.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      if (error instanceof StreamingValidationError) return fail(400, { message: error.message });
      const result = classifyAdminMutationError(error, 'Unable to set default downloader.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  deleteProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/downloads' });
    try {
      const form = await request.formData();
      const id = String(form.get('id') ?? '');
      await deleteDownloadProvider(locals.supabase, id);
      throw redirect(303, `/admin/system/downloads?notice=Downloader%20deleted.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to delete downloader.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
};
