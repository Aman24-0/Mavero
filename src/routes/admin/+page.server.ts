import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createProvider, getAdminOverview } from '$lib/server/streaming/admin-service';
import { StreamingValidationError, parseProviderForm } from '$lib/server/streaming/validation';
import { getDownloadersAdminOverview } from '$lib/server/downloader/admin-service';
import { getAddonsAdminOverview } from '$lib/server/streaming/stremio/admin-addons';

export const load: PageServerLoad = async ({ locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const [overview, downloadersOverview, addonsOverview] = await Promise.all([
    getAdminOverview(locals.supabase),
    // Optional card on the overview — degrades gracefully if the new
    // table doesn't exist yet (pre-migration environments) so the admin
    // overview never 500s.
    getDownloadersAdminOverview(locals.supabase).catch(() => null),
    getAddonsAdminOverview(locals.supabase).catch(() => null),
  ]);
  return { overview, downloadersOverview, addonsOverview };
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
