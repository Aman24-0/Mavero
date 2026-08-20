import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSource, deleteSource, listAdminProviders, listAdminSources, updateSource } from '$lib/server/streaming/admin-service';
import { StreamingValidationError, parseId, parseSourceForm } from '$lib/server/streaming/validation';

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/sources' });
  const [sources, providers] = await Promise.all([listAdminSources(locals.supabase), listAdminProviders(locals.supabase)]);
  return { sources, providers, notice: url.searchParams.get('notice') };
};

function messageFrom(error: unknown, fallback: string) {
  return error instanceof StreamingValidationError || error instanceof Error ? error.message : fallback;
}

export const actions: Actions = {
  createSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/sources' });
    try {
      const source = await createSource(locals.supabase, parseSourceForm(await request.formData()));
      throw redirect(303, `/admin/sources?notice=${encodeURIComponent(`Created ${source.name}.`)}`);
    } catch (error) {
      if (error instanceof Response) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to create source.') });
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
      if (error instanceof Response) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to update source.') });
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
      if (error instanceof Response) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to update source state.') });
    }
  },
  deleteSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/sources' });
    try {
      await deleteSource(locals.supabase, parseId(await request.formData(), 'Source'));
      throw redirect(303, '/admin/sources?notice=Source%20deleted.');
    } catch (error) {
      if (error instanceof Response) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to delete source.') });
    }
  },
};

