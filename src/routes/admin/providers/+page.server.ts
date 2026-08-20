import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createProvider, deleteProvider, listAdminProviders, updateProvider } from '$lib/server/streaming/admin-service';
import { StreamingValidationError, parseId, parseProviderForm } from '$lib/server/streaming/validation';

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/providers' });
  return { providers: await listAdminProviders(locals.supabase), notice: url.searchParams.get('notice') };
};

function messageFrom(error: unknown, fallback: string) {
  return error instanceof StreamingValidationError || error instanceof Error ? error.message : fallback;
}

export const actions: Actions = {
  createProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/providers' });
    try {
      const provider = await createProvider(locals.supabase, parseProviderForm(await request.formData()));
      throw redirect(303, `/admin/providers?notice=${encodeURIComponent(`Created ${provider.name}.`)}`);
    } catch (error) {
      if (error instanceof Response) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to create provider.') });
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
      if (error instanceof Response) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to update provider.') });
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
      if (error instanceof Response) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to update provider state.') });
    }
  },
  deleteProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/providers' });
    try {
      await deleteProvider(locals.supabase, parseId(await request.formData(), 'Provider'));
      throw redirect(303, '/admin/providers?notice=Provider%20deleted.');
    } catch (error) {
      if (error instanceof Response) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to delete provider.') });
    }
  },
};

