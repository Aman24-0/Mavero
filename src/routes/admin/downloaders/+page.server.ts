import { fail, redirect } from '@sveltejs/kit';
import { isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import {
  createDownloadProvider,
  deleteDownloadProvider,
  getDownloadersAdminOverview,
  listAdminDownloadProviders,
  setDefaultDownloadProvider,
  updateDownloadProvider,
} from '$lib/server/downloader/admin-service';
import { DownloaderValidationError, parseDownloadProviderForm, parseId } from '$lib/server/downloader/validation';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';

// Admin /downloaders page — completely separate from /admin/providers and
// /admin/sources. The only shared import is requireAdmin (existing admin
// authorization helper) and classifyAdminMutationError (existing friendly
// error mapping). The downloader registry itself is fully isolated.

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/downloaders' });
  const [providers, overview] = await Promise.all([
    listAdminDownloadProviders(locals.supabase),
    getDownloadersAdminOverview(locals.supabase),
  ]);
  return { providers, overview, notice: url.searchParams.get('notice') };
};

export const actions: Actions = {
  createProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/downloaders' });
    try {
      const provider = await createDownloadProvider(locals.supabase, parseDownloadProviderForm(await request.formData()));
      throw redirect(303, `/admin/downloaders?notice=${encodeURIComponent(`Created ${provider.name}.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to create downloader.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  updateProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/downloaders' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Downloader');
      const { id: _ignored, ...input } = { id, ...parseDownloadProviderForm(form) };
      await updateDownloadProvider(locals.supabase, id, input);
      throw redirect(303, '/admin/downloaders?notice=Downloader%20updated.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update downloader.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  toggleProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/downloaders' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Downloader');
      await updateDownloadProvider(locals.supabase, id, { enabled: String(form.get('enabled')) === 'true' });
      throw redirect(303, '/admin/downloaders?notice=Downloader%20state%20updated.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update downloader state.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  setDefault: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/downloaders' });
    try {
      const id = parseId(await request.formData(), 'Downloader');
      await setDefaultDownloadProvider(locals.supabase, id);
      throw redirect(303, '/admin/downloaders?notice=Default%20downloader%20updated.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      // DownloaderValidationError is a friendly user-facing message; surface
      // it directly. classifyAdminMutationError handles Supabase/network.
      if (error instanceof DownloaderValidationError) {
        return fail(400, { message: error.message });
      }
      const result = classifyAdminMutationError(error, 'Unable to set default downloader.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  deleteProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/downloaders' });
    try {
      await deleteDownloadProvider(locals.supabase, parseId(await request.formData(), 'Downloader'));
      throw redirect(303, '/admin/downloaders?notice=Downloader%20deleted.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to delete downloader.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
};
