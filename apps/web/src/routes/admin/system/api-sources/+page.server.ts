/**
 * Admin 2.0 — API & Sources workspace page server.
 *
 * Canonical workspace for provider registry + source registry + category
 * registry + defaults. Contains ALL CRUD actions from the legacy
 * /admin/providers, /admin/sources, /admin/defaults, and
 * /admin/categories pages — no redirects to legacy UI needed.
 *
 * Tab routing: ?tab=providers|sources|categories (defaults to providers).
 * Defaults are opened as a contextual sheet (not a tab).
 *
 * Categories were migrated here from /admin/system/content-rules in the
 * 2026-10 admin restructure round (the Feature Control tab moved to its
 * own independent route /admin/system/feature-control, leaving
 * content-rules empty — that route was deleted).
 */

import { fail, redirect, error } from '@sveltejs/kit';
import { isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import {
  listAdminProviders, listProviderHealthSummaries,
  listAdminSources, listAdminDefaults, listAdminDefaultSlots,
  upsertDefaultSource, setDefaultSourceSlots,
  createProvider, updateProvider, deleteProvider,
  createSource, updateSource, deleteSource,
  reorderSourceOrderings,
  listAdminCategories, listSourceCategories,
  createCategory, updateCategory, deleteCategory,
  assignSourceToCategory, deleteSourceCategory, applyCategorySourcePositions,
  reorderCategorySources, reorderCategoryOrderings,
} from '$lib/server/streaming/admin-service';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';
import { lookupProviderCapabilities } from '$lib/shared/player-capabilities';
import {
  parseProviderForm, parseSourceForm, parseId, parseBulkOrderings,
  parseCategoryForm, parseSourceAssignmentForm, parseCategoryReorderForm,
  parseBulkOrderedIds, StreamingValidationError,
} from '$lib/server/streaming/validation';

const VALID_TABS = new Set(['providers', 'sources', 'categories']);

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof StreamingValidationError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });

  const tab = url.searchParams.get('tab') ?? 'providers';
  if (!VALID_TABS.has(tab)) {
    throw error(400, 'Invalid tab. Use ?tab=providers|sources|categories.');
  }

  const [providers, health, sources, defaults, defaultSlots, categories, sourceCategories] = await Promise.all([
    listAdminProviders(locals.supabase),
    listProviderHealthSummaries(locals.supabase),
    listAdminSources(locals.supabase),
    listAdminDefaults(locals.supabase),
    listAdminDefaultSlots(locals.supabase),
    listAdminCategories(locals.supabase),
    listSourceCategories(locals.supabase),
  ]);

  const capabilityMap: Record<string, { supported: string[]; unsupported: string[]; unknown: boolean } | null> = {};
  for (const provider of providers) {
    const caps = lookupProviderCapabilities(provider.adapter_id);
    if (!caps) {
      capabilityMap[provider.id] = null;
    } else {
      capabilityMap[provider.id] = {
        supported: Object.entries(caps).filter(([, v]) => v === true).map(([k]) => k),
        unsupported: Object.entries(caps).filter(([, v]) => v === false).map(([k]) => k),
        unknown: false,
      };
    }
  }

  return {
    initialTab: tab,
    providers,
    health,
    capabilityMap,
    sources,
    defaults,
    defaultSlots,
    categories,
    sourceCategories,
    notice: url.searchParams.get('notice'),
  };
};

export const actions: Actions = {
  // --- Provider CRUD (migrated from /admin/providers) ---
  createProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const provider = await createProvider(locals.supabase, await parseProviderForm(await request.formData()));
      throw redirect(303, `/admin/system/api-sources?tab=providers&notice=${encodeURIComponent(`Created ${provider.name}.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to create provider.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  updateProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Provider');
      // 2026-10-16 round: forUpdate semantics — an empty icon field on the
      // edit path means NO CHANGE (upload file > explicit icon_remove flag >
      // submitted URL > no-change). "No new file selected" can never erase a
      // saved icon.
      const parsed = await parseProviderForm(form, { forUpdate: true });
      const { id: _ignored, ...input } = { id, ...parsed };
      const { data: existing } = await locals.supabase.from('streaming_providers').select('capabilities').eq('id', id).maybeSingle();
      const existingCapabilities = (existing?.capabilities && typeof existing.capabilities === 'object' && !Array.isArray(existing.capabilities))
        ? { ...(existing.capabilities as Record<string, unknown>) }
        : {};
      const mergedCapabilities = { ...existingCapabilities, sandbox_policy: parsed.capabilities.sandbox_policy };
      await updateProvider(locals.supabase, id, { ...input, capabilities: mergedCapabilities });
      throw redirect(303, `/admin/system/api-sources?tab=providers&notice=Provider%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update provider.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  toggleProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Provider');
      await updateProvider(locals.supabase, id, { enabled: String(form.get('enabled')) === 'true' });
      throw redirect(303, `/admin/system/api-sources?tab=providers&notice=Provider%20state%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update provider.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  deleteProvider: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Provider');
      await deleteProvider(locals.supabase, id);
      throw redirect(303, `/admin/system/api-sources?tab=providers&notice=Provider%20deleted.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to delete provider.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },

  // --- Source CRUD (migrated from /admin/sources) ---
  createSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const source = await createSource(locals.supabase, await parseSourceForm(await request.formData()));
      throw redirect(303, `/admin/system/api-sources?tab=sources&notice=${encodeURIComponent(`Created ${source.name}.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to create source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  updateSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Source');
      // 2026-10-16 round: forUpdate semantics — an EMPTY icon field on the
      // edit path means NO CHANGE (upload file > explicit icon_remove flag >
      // submitted value > no-change). This is the root-cause fix for the
      // reported "editing an unrelated field erases the saved icon": the
      // upload input mode submits '' when no NEW file is picked, which the
      // previous contract interpreted as removal. The form also no longer
      // submits a global ordering field (the dedicated bulk-reposition
      // editor is authoritative) — an absent ordering key on update is
      // OMITTED from the payload so unrelated saves can never clobber the
      // saved global ordering.
      const parsed = await parseSourceForm(form, { forUpdate: true });

      // FINDING-006 fix: MERGE capabilities with existing instead of
      // wiping. parseSourceForm() reads `capabilities` from the form,
      // but the source edit form has NO `<input name="capabilities">`
      // field — so `parsed.capabilities` is always `{}` (empty object).
      // Previously this empty object was passed directly to
      // updateSource(), wiping `allowed_embed_origins`, `result_type`,
      // `supports_*`, and all other capability keys that were set when
      // the source was created.
      //
      // Now: fetch the existing source's capabilities and MERGE the
      // new (non-empty) keys into them. This mirrors the provider
      // update path (lines 89-94 above) and preserves all capability
      // keys that aren't explicitly being changed by this edit.
      //
      // stripSandboxPolicy() is still applied (Phase 8 invariant:
      // sandbox is provider-level only, never source-level), so a
      // legacy sandbox_policy key in the existing capabilities is
      // still stripped on update.
      const { data: existing } = await locals.supabase
        .from('streaming_sources')
        .select('capabilities')
        .eq('id', id)
        .maybeSingle();
      const existingCapabilities = (existing?.capabilities && typeof existing.capabilities === 'object' && !Array.isArray(existing.capabilities))
        ? { ...(existing.capabilities as Record<string, unknown>) }
        : {};
      const mergedCapabilities = { ...existingCapabilities, ...parsed.capabilities } as Record<string, unknown>;

      // Strip the wiped capabilities from the parsed input and replace
      // with the merged set. All other parsed fields (name, slug, etc.)
      // pass through unchanged. Cast to `any` for the capabilities field
      // because the Supabase typed client's `Json` type doesn't accept
      // `Record<string, unknown>` directly (excess property checking).
      const { capabilities: _ignoredCaps, ...input } = parsed;
      await updateSource(locals.supabase, id, { ...input, capabilities: mergedCapabilities as never });
      throw redirect(303, `/admin/system/api-sources?tab=sources&notice=Source%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  toggleSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Source');
      await updateSource(locals.supabase, id, { enabled: String(form.get('enabled')) === 'true' });
      throw redirect(303, `/admin/system/api-sources?tab=sources&notice=Source%20state%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to update source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  deleteSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Source');
      await deleteSource(locals.supabase, id);
      throw redirect(303, `/admin/system/api-sources?tab=sources&notice=Source%20deleted.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to delete source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },

  // 2026-10-16 round (Issue 5): UNIFIED BULK REPOSITION for the GLOBAL
  // source ordering — the authoritative ordering workflow for sources (the
  // per-sheet Ordering field was REMOVED). The client submits
  // `ordering_<source_id>` for EVERY source (prefilled from the saved
  // values); the service re-validates completeness, integer bounds and
  // duplicate orderings server-side before any write. The interactive form
  // uses use:enhance — success invalidates the load in place (no full-page
  // reload); a failed save keeps the admin's edits visible.
  reorderSources: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const positions = parseBulkOrderings(await request.formData(), 'ordering_', 'Source');
      await reorderSourceOrderings(locals.supabase, positions.map(({ id, ordering }) => ({ sourceId: id, ordering })));
      throw redirect(303, `/admin/system/api-sources?tab=sources&notice=Source%20order%20saved.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to reorder sources.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },

  // --- Defaults actions (migrated from /admin/defaults) ---
  saveDefault: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const contentType = String(form.get('content_type') ?? '');
      const sourceId = String(form.get('source_id') ?? '');
      if (!contentType || !sourceId) return fail(400, { message: 'Content type and source are required.', contentType });
      await upsertDefaultSource(locals.supabase, contentType, sourceId);
      throw redirect(303, `/admin/system/api-sources?notice=${encodeURIComponent(`Default ${contentType} source updated.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to save default source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  // MAVP-5 (Issue 6): save the THREE ordered default sources for one
  // category. `slot_source` is a repeated form field — position = order of
  // appearance (primary, secondary, tertiary); omitting all of them clears
  // the category. Server-side validation (distinct, ≤3, valid UUIDs, known
  // content type) lives in setDefaultSourceSlots; eligibility filtering
  // happens at read time. The legacy single-default row is kept in sync
  // with slot 1 for backward compatibility.
  saveDefaultSlots: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const contentType = String(form.get('content_type') ?? '');
      if (!contentType) return fail(400, { message: 'Content type is required.', contentType });
      const sourceIds = form.getAll('slot_source').filter((id): id is string => typeof id === 'string' && id.length > 0);
      await setDefaultSourceSlots(locals.supabase, contentType, sourceIds);
      throw redirect(303, `/admin/system/api-sources?notice=${encodeURIComponent(`Ordered default ${contentType} sources saved.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to save ordered default sources.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },
  clearDefault: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const contentType = String(form.get('content_type') ?? '');
      if (!contentType) return fail(400, { message: 'Content type is required.', contentType });
      // MAVP-5 (Issue 6): Clear empties BOTH storage shapes — the ordered
      // slots and the legacy single-default row — so the category really
      // has no configured default afterwards.
      await setDefaultSourceSlots(locals.supabase, contentType, []);
      throw redirect(303, `/admin/system/api-sources?notice=${encodeURIComponent(`Default ${contentType} source cleared.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      const result = classifyAdminMutationError(error, 'Unable to clear default source.');
      return fail(result.status === 'unknown' ? 503 : 400, { message: result.message, mutationStatus: result.status });
    }
  },

  // --- Category CRUD + source-assignment management (migrated from
  // /admin/system/content-rules during the 2026-10 admin restructure).
  // The contracts are UNCHANGED — same service-layer methods, same
  // validation parsers, same atomic RPC persistence. Only the URL the
  // forms POST to changed (?/createCategory etc. now lives on this
  // route). `requireAdmin` gates every mutation; all IDs are strictly
  // parsed/validated server-side.
  createCategory: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const category = await createCategory(locals.supabase, parseCategoryForm(await request.formData()));
      throw redirect(303, `/admin/system/api-sources?tab=categories&notice=${encodeURIComponent(`Created ${category.name}.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to create category.') });
    }
  },
  updateCategory: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Category');
      // forUpdate semantics — the edit sheet no longer submits a global
      // ordering field (the authoritative workflow is the bulk reposition
      // editor on the category list). An absent ordering key on update is
      // OMITTED from the payload, so saving the category's name/description
      // can never clobber the saved ordering.
      await updateCategory(locals.supabase, id, parseCategoryForm(form, { forUpdate: true }));
      throw redirect(303, `/admin/system/api-sources?tab=categories&notice=Category%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to update category.') });
    }
  },
  toggleCategory: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Category');
      await updateCategory(locals.supabase, id, { enabled: String(form.get('enabled')) === 'true' });
      throw redirect(303, `/admin/system/api-sources?tab=categories&notice=Category%20state%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to update category.') });
    }
  },
  deleteCategory: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Category');
      await deleteCategory(locals.supabase, id);
      throw redirect(303, `/admin/system/api-sources?tab=categories&notice=Category%20deleted.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to delete category.') });
    }
  },
  assignSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const { source_id, category_id } = parseSourceAssignmentForm(await request.formData());
      await assignSourceToCategory(locals.supabase, source_id, category_id);
      throw redirect(303, `/admin/system/api-sources?tab=categories&notice=Source%20assigned.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to assign source.') });
    }
  },
  removeSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const { source_id, category_id } = parseSourceAssignmentForm(await request.formData());
      await deleteSourceCategory(locals.supabase, source_id, category_id);
      throw redirect(303, `/admin/system/api-sources?tab=categories&notice=Source%20removed.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to remove source.') });
    }
  },
  moveCategorySource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const { categoryId, positions } = parseCategoryReorderForm(await request.formData());
      // Numeric-position contract. The submitted fields are PER-SOURCE
      // TARGETS (`position_<source_id>`). The final order is derived
      // SERVER-SIDE from the database's current assignments (move-to-
      // position-N, shift the rest, dense 1..N) — the client can never
      // inject an arbitrary ordering. (The interactive UI uses
      // reorderSourcesBulk; this single-row move action remains a valid
      // API.)
      await applyCategorySourcePositions(locals.supabase, categoryId, positions);
      throw redirect(303, `/admin/system/api-sources?tab=categories&notice=Sources%20reordered.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to reorder sources.') });
    }
  },
  // UNIFIED BULK REPOSITION — the category's complete intended source
  // order in ONE request. The client submits `ordered_source_ids`
  // (repeated field, first = position 1); the service re-validates the
  // set against the category's REAL assignments (every assigned source
  // exactly once, no unknown ids) and persists through the ATOMIC
  // reorder_category_sources RPC.
  reorderSourcesBulk: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const form = await request.formData();
      const categoryId = parseId(form, 'Category');
      const orderedSourceIds = parseBulkOrderedIds(form, 'ordered_source_ids', 'Source order');
      if (!orderedSourceIds.length) return fail(400, { message: 'The reorder payload is empty.' });
      await reorderCategorySources(locals.supabase, categoryId, orderedSourceIds);
      throw redirect(303, `/admin/system/api-sources?tab=categories&notice=Sources%20reordered.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to reorder sources.') });
    }
  },
  // UNIFIED BULK REPOSITION for the GLOBAL category list ordering. The
  // client submits `ordering_<category_id>` for EVERY category (prefilled
  // from the saved values); the service re-validates completeness,
  // integer bounds and uniqueness server-side before any write.
  reorderCategories: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/api-sources' });
    try {
      const positions = parseBulkOrderings(await request.formData(), 'ordering_', 'Category');
      await reorderCategoryOrderings(locals.supabase, positions.map(({ id, ordering }) => ({ categoryId: id, ordering })));
      throw redirect(303, `/admin/system/api-sources?tab=categories&notice=Category%20order%20saved.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to reorder categories.') });
    }
  },
};
