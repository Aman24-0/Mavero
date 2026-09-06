import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createProvider, getAdminOverview } from '$lib/server/streaming/admin-service';
import { StreamingValidationError, parseProviderForm } from '$lib/server/streaming/validation';

export const load: PageServerLoad = async ({ locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  return { overview: await getAdminOverview(locals.supabase) };
};

export const actions: Actions = {
  createProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin' });
    try {
      const provider = await createProvider(locals.supabase, parseProviderForm(await request.formData()));
      throw redirect(303, `/admin/providers?created=${encodeURIComponent(provider.name)}`);
    } catch (error) {
      if (error instanceof Response) throw error;
      const message = error instanceof StreamingValidationError || error instanceof Error ? error.message : 'Unable to create provider.';
      return fail(400, { message });
    }
  },
};
