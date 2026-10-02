/**
 * Admin 2.0 — Phase 1 — Integrations page server.
 * Full CRUD for Stremio addons.
 *
 * CS-1 (AC-001): the page becomes the single central integrations workspace
 * with TWO URL-driven tabs:
 *
 *   ?tab=addon     (default) — Stremio addon management (EXISTING, unchanged)
 *   ?tab=extension           — CloudStream Extension Manager (new, CS-1)
 *
 * The default (no param) resolves to the Add-on tab so every existing link
 * to /admin/system/integrations keeps rendering the Stremio list. Invalid
 * tab values are rejected server-side (Hosting Control VALID_TABS
 * convention). All pre-existing Stremio actions are preserved verbatim; the
 * CloudStream actions are additive.
 */

import { fail, redirect } from '@sveltejs/kit';
import { isRedirect } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
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
import {
  listRepositories,
  createRepositoryFromUrl,
  syncRepositoryById,
  setRepositoryEnabled,
  deleteRepositoryById,
} from '$lib/server/cloudstream/repository/service';
import { listExtensionsForAdmin, setExtensionEnabled } from '$lib/server/cloudstream/extensions/service';
import { CloudStreamRepositoryError } from '$lib/server/cloudstream/repository/errors';
import type { CloudStreamExtensionView, CloudStreamRepositoryView } from '$lib/server/cloudstream/types';

const REDIRECT = '/admin/system/integrations';

/** CS-1 tab contract (AC-001): Add-on (Stremio) | Extension (CloudStream). */
const VALID_TABS = new Set(['addon', 'extension']);

function addonActionError(error: unknown, fallback: string) {
  if (error instanceof StreamingValidationError || error instanceof AddonUnsupportedError || error instanceof ManifestServiceError) {
    return fail(400, { message: error.message });
  }
  const result = classifyAdminMutationError(error, fallback);
  return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
}

function cloudstreamActionError(error: unknown, fallback: string) {
  if (error instanceof CloudStreamRepositoryError) {
    return fail(400, { message: error.message });
  }
  const result = classifyAdminMutationError(error, fallback);
  return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
}

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: REDIRECT });

  // URL-driven tab state (AC-001): default = Add-on so every existing link
  // keeps rendering the Stremio list; invalid tabs are rejected (Hosting
  // Control VALID_TABS convention).
  const tab = url.searchParams.get('tab') ?? 'addon';
  if (!VALID_TABS.has(tab)) {
    throw error(400, 'Invalid tab. Use ?tab=addon|extension.');
  }

  // The Add-on tab data loads exactly as before (unchanged behavior).
  const addons = await listAdminAddons(locals.supabase);

  // The Extension tab loads the CloudStream catalog; failures degrade
  // gracefully (the page still renders with an error notice) instead of
  // taking the whole Integrations page down.
  let cloudstreamRepositories: CloudStreamRepositoryView[] = [];
  let cloudstreamExtensions: CloudStreamExtensionView[] = [];
  let cloudstreamError: string | null = null;
  if (tab === 'extension') {
    try {
      [cloudstreamRepositories, cloudstreamExtensions] = await Promise.all([
        listRepositories(locals.supabase),
        listExtensionsForAdmin(locals.supabase),
      ]);
    } catch (err) {
      cloudstreamError = err instanceof Error ? err.message : 'Failed to load the CloudStream extension catalog.';
    }
  }

  return {
    addons,
    tab,
    cloudstreamRepositories,
    cloudstreamExtensions,
    cloudstreamError,
    notice: url.searchParams.get('notice'),
  };
};

export const actions: Actions = {
  // -----------------------------------------------------------------
  // Stremio Add-on actions (EXISTING — preserved verbatim)
  // -----------------------------------------------------------------
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

  // -----------------------------------------------------------------
  // CloudStream Extension actions (CS-1 — additive)
  // -----------------------------------------------------------------
  confirmCloudStreamRepository: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: `${REDIRECT}?tab=extension` });
    try {
      const form = await request.formData();
      const repositoryUrl = String(form.get('repositoryUrl') ?? '');
      const { repository } = await createRepositoryFromUrl(locals.supabase, repositoryUrl);
      throw redirect(
        303,
        `${REDIRECT}?tab=extension&notice=${encodeURIComponent(`Added ${repository.name} (${repository.extensionCount} extensions discovered).`)}`,
      );
    } catch (error) {
      if (isRedirect(error)) throw error;
      return cloudstreamActionError(error, 'Unable to add the CloudStream repository.');
    }
  },
  syncCloudStreamRepository: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: `${REDIRECT}?tab=extension` });
    try {
      const form = await request.formData();
      const id = String(form.get('id') ?? '');
      const outcome = await syncRepositoryById(locals.supabase, id);
      const notice =
        outcome.status === 'active'
          ? `Repository synced — ${outcome.discoveredCount} extensions (${outcome.insertedCount} new, ${outcome.updatedCount} updated, ${outcome.removedCount} removed).`
          : 'Repository sync failed — error recorded.';
      throw redirect(303, `${REDIRECT}?tab=extension&notice=${encodeURIComponent(notice)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return cloudstreamActionError(error, 'Unable to sync the CloudStream repository.');
    }
  },
  setCloudStreamRepositoryEnabled: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: `${REDIRECT}?tab=extension` });
    try {
      const form = await request.formData();
      const id = String(form.get('id') ?? '');
      const enabled = String(form.get('enabled')) === 'true';
      await setRepositoryEnabled(locals.supabase, id, enabled);
      throw redirect(303, `${REDIRECT}?tab=extension&notice=Repository%20${enabled ? 'enabled' : 'disabled'}.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return cloudstreamActionError(error, 'Unable to update the CloudStream repository.');
    }
  },
  deleteCloudStreamRepository: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: `${REDIRECT}?tab=extension` });
    try {
      const form = await request.formData();
      const id = String(form.get('id') ?? '');
      await deleteRepositoryById(locals.supabase, id);
      throw redirect(303, `${REDIRECT}?tab=extension&notice=Repository%20deleted.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return cloudstreamActionError(error, 'Unable to delete the CloudStream repository.');
    }
  },
  setCloudStreamExtensionEnabled: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: `${REDIRECT}?tab=extension` });
    try {
      const form = await request.formData();
      const id = String(form.get('id') ?? '');
      const enabled = String(form.get('enabled')) === 'true';
      await setExtensionEnabled(locals.supabase, id, enabled);
      throw redirect(303, `${REDIRECT}?tab=extension&notice=Extension%20${enabled ? 'enabled' : 'disabled'}.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return cloudstreamActionError(error, 'Unable to update the extension.');
    }
  },
};
