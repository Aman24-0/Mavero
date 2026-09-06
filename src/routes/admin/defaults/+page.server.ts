import { fail, redirect } from '@sveltejs/kit';
import { isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { clearDefaultSource, listAdminDefaults, listAdminSources, listAdminProviders, upsertDefaultSource } from '$lib/server/streaming/admin-service';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/defaults' });
  const [defaults, sources, providers] = await Promise.all([
    listAdminDefaults(locals.supabase),
    listAdminSources(locals.supabase),
    listAdminProviders(locals.supabase),
  ]);
  return { defaults, sources, providers, notice: url.searchParams.get('notice') };
};

export const actions: Actions = {
  saveDefault: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/defaults' });
    try {
      const form = await request.formData();
      const contentType = String(form.get('content_type') ?? '');
      const sourceId = String(form.get('source_id') ?? '');
      if (!contentType || !sourceId) return fail(400, { message: 'Content type and source are required.', contentType });
      await upsertDefaultSource(locals.supabase, contentType, sourceId);
      throw redirect(303, `/admin/defaults?notice=${encodeURIComponent(`Default ${contentType} source updated.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to save default source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  clearDefault: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/defaults' });
    try {
      const form = await request.formData();
      const contentType = String(form.get('content_type') ?? '');
      if (!contentType) return fail(400, { message: 'Content type is required.', contentType });
      await clearDefaultSource(locals.supabase, contentType);
      throw redirect(303, `/admin/defaults?notice=${encodeURIComponent(`Default ${contentType} source cleared.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to clear default source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
};
