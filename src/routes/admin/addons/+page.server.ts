import { fail, redirect, isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import {
  AddonUnsupportedError,
  createAddonFromManifestUrl,
  deleteAddonById,
  listAdminAddons,
  moveAddon,
  previewAddonFromManifestUrl,
  refreshAddonById,
  setAddonEnabled,
} from '$lib/server/streaming/stremio/admin-addons';
import { StreamingValidationError } from '$lib/server/streaming/validation';
import { ManifestServiceError } from '$lib/server/streaming/stremio/errors';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';

/**
 * Admin Stremio addon management (Phase 7) — `/admin/addons`.
 *
 * SvelteKit form actions follow the established admin convention (same as
 * `/admin/downloaders` and `/admin/defaults`):
 *
 *   * `requireAdmin` runs on the load AND on EVERY mutation — authorization
 *     is always re-verified server-side, never trusted from the client
 *     (spec §4). The database RLS policy (`public.is_admin()`) remains the
 *     second defense layer.
 *   * The browser never fetches manifest URLs itself (spec §8) — the only
 *     client input is a manifest URL string, which is validated and fetched
 *     exclusively by the existing secure Phase 2 manifest service.
 *   * Manifest refresh never accepts a URL: `refreshAddonById` re-reads the
 *     STORED manifest URL server-side (spec §14).
 *   * CSRF protection is SvelteKit's built-in form-action origin check — the
 *     same mechanism every existing admin mutation relies on (spec §25).
 *   * Errors are mapped to fixed safe messages; no SSRF diagnostics, DNS
 *     details, stack traces or upstream response bodies are ever returned
 *     (spec §15, §30, §39).
 */
const REDIRECT = '/admin/addons';

/** Maps service errors to safe action failures (fixed messages only). */
function addonActionError(error: unknown, fallback: string) {
  if (error instanceof StreamingValidationError || error instanceof AddonUnsupportedError || error instanceof ManifestServiceError) {
    // These messages are curated safe text (validation contract, fixed
    // unsupported/duplicate strings, Phase 2 manifest error table).
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
  /** Step 1 of the add workflow: validate + fetch + preview, NO persistence. */
  previewAddon: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: REDIRECT });
    try {
      const form = await request.formData();
      const preview = await previewAddonFromManifestUrl(locals.supabase, String(form.get('manifestUrl') ?? ''));
      return { preview };
    } catch (error) {
      if (isRedirect(error)) throw error;
      return addonActionError(error, 'Unable to validate the addon.');
    }
  },

  /** Step 2 of the add workflow: re-validate through the secure service and persist. */
  confirmAddon: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: REDIRECT });
    try {
      const form = await request.formData();
      const addon = await createAddonFromManifestUrl(locals.supabase, String(form.get('manifestUrl') ?? ''));
      throw redirect(303, `${REDIRECT}?notice=${encodeURIComponent(`Added ${addon.name}. It stays disabled until you enable it.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return addonActionError(error, 'Unable to add the addon.');
    }
  },

  /** Enable/disable — persists the existing `enabled` column (spec §12). */
  setEnabled: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: REDIRECT });
    try {
      const form = await request.formData();
      const enabled = String(form.get('enabled')) === 'true';
      await setAddonEnabled(locals.supabase, form.get('id'), enabled);
      throw redirect(303, `${REDIRECT}?notice=${encodeURIComponent(enabled ? 'Addon enabled.' : 'Addon disabled.')}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return addonActionError(error, 'Unable to update the addon state.');
    }
  },

  /** Refresh — re-fetches the STORED manifest URL through the secure service. */
  refreshAddon: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: REDIRECT });
    try {
      const form = await request.formData();
      const outcome = await refreshAddonById(locals.supabase, form.get('id'));
      const notice = outcome.ok ? 'Addon manifest refreshed.' : 'Addon refresh failed. The addon status was updated.';
      throw redirect(303, `${REDIRECT}?notice=${encodeURIComponent(notice)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return addonActionError(error, 'Unable to refresh the addon.');
    }
  },

  /** Move up/down — persists the ordering consumed by the resolver (spec §13). */
  moveAddon: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: REDIRECT });
    try {
      const form = await request.formData();
      const direction = String(form.get('direction')) === 'up' ? 'up' : 'down';
      await moveAddon(locals.supabase, form.get('id'), direction);
      throw redirect(303, `${REDIRECT}?notice=${encodeURIComponent('Addon order updated.')}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return addonActionError(error, 'Unable to reorder the addons.');
    }
  },

  /** Delete — destructive, confirmed in the UI, persisted server-side (spec §16). */
  deleteAddon: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: REDIRECT });
    try {
      const form = await request.formData();
      await deleteAddonById(locals.supabase, form.get('id'));
      throw redirect(303, `${REDIRECT}?notice=${encodeURIComponent('Addon removed.')}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return addonActionError(error, 'Unable to remove the addon.');
    }
  },
};
