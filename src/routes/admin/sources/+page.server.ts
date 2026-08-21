import { fail, redirect } from '@sveltejs/kit';
import { isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSource, deleteSource, listAdminProviders, listAdminSources, updateSource } from '$lib/server/streaming/admin-service';
import { parseId, parseSourceForm } from '$lib/server/streaming/validation';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/sources' });
  const [sources, providers] = await Promise.all([listAdminSources(locals.supabase), listAdminProviders(locals.supabase)]);
  return { sources, providers, notice: url.searchParams.get('notice') };
};

export const actions: Actions = {
  createSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/sources' });
    try {
      const source = await createSource(locals.supabase, parseSourceForm(await request.formData()));
      throw redirect(303, `/admin/sources?notice=${encodeURIComponent(`Created ${source.name}.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to create source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  updateSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Source');
      await updateSource(locals.supabase, id, parseSourceForm(form));
      throw redirect(303, '/admin/sources?notice=Source%20updated.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  toggleSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Source');
      await updateSource(locals.supabase, id, { enabled: String(form.get('enabled')) === 'true' });
      throw redirect(303, '/admin/sources?notice=Source%20state%20updated.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update source state.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  deleteSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/sources' });
    try {
      await deleteSource(locals.supabase, parseId(await request.formData(), 'Source'));
      throw redirect(303, '/admin/sources?notice=Source%20deleted.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to delete source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
};

