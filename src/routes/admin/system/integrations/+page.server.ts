/**
 * Admin 2.0 — Phase 1 — Integrations page server.
 * Full CRUD for Stremio addons.
 */

import { fail, redirect } from '@sveltejs/kit';
import { isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import {
  listAdminAddons,
  previewAddonFromManifestUrl,
  createAddonFromManifestUrl,
  setAddonEnabled,
  setAddonLinkTypes,
  refreshAddonById,
  setAddonPosition,
  deleteAddonById,
} from '$lib/server/streaming/stremio/admin-addons';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';
import { StreamingValidationError } from '$lib/server/streaming/validation';
import { ManifestServiceError } from '$lib/server/streaming/stremio/errors';
import { AddonUnsupportedError } from '$lib/server/streaming/stremio/admin-addons';

const REDIRECT = '/admin/system/integrations';

function addonActionError(error: unknown, fallback: string) {
  if (error instanceof StreamingValidationError || error instanceof AddonUnsupportedError || error instanceof ManifestServiceError) {
    return fail(400, { message: error.message });
  }
  const result = classifyAdminMutationError(error, fallback);
  return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
}

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: REDIRECT });
  const addons = await listAdminAddons(locals.supabase);
  return { addons, notice: url.searchParams.get('notice') };
};

export const actions: Actions = {
  previewAddon: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: REDIRECT });
    try {
      const form = await request.formData();
      const manifestUrl = String(form.get('manifestUrl') ?? '');
      const preview = await previewAddonFromManifestUrl(locals.supabase, manifestUrl);
      return { preview };
    } catch (error) {
      if (isRedirect(error)) throw error;
      return addonActionError(error, 'Unable to preview addon.');
    }
  },
  confirmAddon: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: REDIRECT });
    try {
      const form = await request.formData();
      const manifestUrl = String(form.get('manifestUrl') ?? '');
      const addon = await createAddonFromManifestUrl(locals.supabase, manifestUrl);
      throw redirect(303, `${REDIRECT}?notice=${encodeURIComponent(`Added ${addon.name}.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return addonActionError(error, 'Unable to add addon.');
    }
  },
  setEnabled: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: REDIRECT });
    try {
      const form = await request.formData();
      const id = String(form.get('id') ?? '');
      const enabled = String(form.get('enabled')) === 'true';
      await setAddonEnabled(locals.supabase, id, enabled);
      throw redirect(303, `${REDIRECT}?notice=Addon%20${enabled ? 'enabled' : 'disabled'}.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return addonActionError(error, 'Unable to update addon.');
    }
  },
  refreshAddon: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: REDIRECT });
    try {
      const form = await request.formData();
      const id = String(form.get('id') ?? '');
      await refreshAddonById(locals.supabase, id);
      throw redirect(303, `${REDIRECT}?notice=Addon%20refreshed.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return addonActionError(error, 'Unable to refresh addon.');
    }
  },
  setAddonPosition: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: REDIRECT });
    try {
      const form = await request.formData();
      const id = String(form.get('id') ?? '');
      const position = parseInt(String(form.get('position') ?? '0'), 10);
      await setAddonPosition(locals.supabase, id, position);
      throw redirect(303, `${REDIRECT}?notice=Addon%20position%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return addonActionError(error, 'Unable to update position.');
    }
  },
  deleteAddon: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: REDIRECT });
    try {
      const form = await request.formData();
      const id = String(form.get('id') ?? '');
      await deleteAddonById(locals.supabase, id);
      throw redirect(303, `${REDIRECT}?notice=Addon%20deleted.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return addonActionError(error, 'Unable to delete addon.');
    }
  },
  saveLinkTypes: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: REDIRECT });
    try {
      const form = await request.formData();
      const id = String(form.get('id') ?? '');
      const { getLinkTypesConfig } = await import('$lib/shared/download-link-types');
      const config = getLinkTypesConfig(Object.fromEntries(form));
      await setAddonLinkTypes(locals.supabase, id, config);
      throw redirect(303, `${REDIRECT}?notice=Link%20types%20saved.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return addonActionError(error, 'Unable to save link types.');
    }
  },
};
