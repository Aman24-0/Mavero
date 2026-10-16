/**
 * Admin 2.0 — Phase 1 — Content Rules workspace page server.
 *
 * Canonical workspace for categories CRUD + feature control.
 * Contains ALL CRUD actions from the legacy /admin/categories page.
 */

import { fail, redirect, error } from '@sveltejs/kit';
import { isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import {
  listAdminCategories, listAdminSources, listSourceCategories,
  createCategory, updateCategory, deleteCategory,
  assignSourceToCategory, deleteSourceCategory, applyCategorySourcePositions,
  reorderCategorySources, reorderCategoryOrderings,
} from '$lib/server/streaming/admin-service';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';
import { parseCategoryForm, parseId, parseSourceAssignmentForm, parseCategoryReorderForm, parseBulkOrderedIds, parseBulkOrderings } from '$lib/server/streaming/validation';
import { StreamingValidationError } from '$lib/server/streaming/validation';

const VALID_TABS = new Set(['categories', 'features']);

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof StreamingValidationError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/system/content-rules' });

  const tab = url.searchParams.get('tab') ?? 'categories';
  if (!VALID_TABS.has(tab)) {
    throw error(400, 'Invalid tab. Use ?tab=categories|features.');
  }

  const [categories, sources, sourceCategories] = await Promise.all([
    listAdminCategories(locals.supabase),
    listAdminSources(locals.supabase),
    listSourceCategories(locals.supabase),
  ]);

  return {
    initialTab: tab,
    categories,
    sources,
    sourceCategories,
    notice: url.searchParams.get('notice'),
  };
};

export const actions: Actions = {
  // --- Category CRUD (migrated from /admin/categories) ---
  createCategory: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/content-rules' });
    try {
      const category = await createCategory(locals.supabase, parseCategoryForm(await request.formData()));
      throw redirect(303, `/admin/system/content-rules?tab=categories&notice=${encodeURIComponent(`Created ${category.name}.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to create category.') });
    }
  },
  updateCategory: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/content-rules' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Category');
      // 2026-10-16 round: forUpdate semantics — the edit sheet no longer
      // submits a global ordering field (the authoritative workflow is the
      // bulk reposition editor on the category list). An absent ordering
      // key on update is OMITTED from the payload, so saving the category's
      // name/description can never clobber the saved ordering.
      await updateCategory(locals.supabase, id, parseCategoryForm(form, { forUpdate: true }));
      throw redirect(303, `/admin/system/content-rules?tab=categories&notice=Category%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to update category.') });
    }
  },
  toggleCategory: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/content-rules' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Category');
      await updateCategory(locals.supabase, id, { enabled: String(form.get('enabled')) === 'true' });
      throw redirect(303, `/admin/system/content-rules?tab=categories&notice=Category%20state%20updated.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to update category.') });
    }
  },
  deleteCategory: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/content-rules' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Category');
      await deleteCategory(locals.supabase, id);
      throw redirect(303, `/admin/system/content-rules?tab=categories&notice=Category%20deleted.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to delete category.') });
    }
  },
  // --- Source assignment management (MAVP-6 Issue 4; numeric positions MAVP-7) ---
  //
  // FINDING-008 history: these actions were removed because the
  // Categories tab shipped without a source-assignment UI. MAVP-6 restores
  // the COMPLETE workflow: the category editor now carries the source
  // management section (assign / remove / reorder), so every action below
  // has a real UI caller. The contracts are the EXISTING service-layer
  // methods over the authoritative streaming_source_categories mapping — no
  // competing data model.
  //
  // MAVP-7 changes (both driven by production feedback on this editor):
  //   * reorderSources now uses the numeric-position contract: the admin
  //     edits ONE source's target position per row and the FINAL order is
  //     derived SERVER-SIDE from the database's current assignments
  //     (applyCategorySourcePositions → shared applyPositionEdits "move to
  //     position N, shift the rest" semantics, dense 1..N). The client can
  //     never inject an arbitrary ordering; positions below 1 are rejected
  //     by the parser, positions above the list length are rejected by the
  //     service ("Positions run from 1 to N.").
  //   * assignSource enforces GLOBAL assignment uniqueness: a source may
  //     live in at most ONE category (the service rejects any
  //     already-assigned source and the unique(source_id) DB constraint
  //     closes the concurrent-assign race).
  //
  // Security/integrity contract (re-verified against the service layer):
  //   * requireAdmin on EVERY mutation (same gate as category CRUD).
  //   * All submitted IDs are strictly parsed/validated server-side
  //     (parseSourceAssignmentForm / parseCategoryReorderForm — UUID shapes,
  //     bounded text, positive integer positions).
  //   * Assignment appends densely (service) and never touches source metadata.
  //   * Removal deletes ONLY the mapping row (the source itself is never
  //     deleted) and re-normalizes the category's ordering.
  //   * Reordering is scoped to ONE category (the service validates the
  //     submitted set against the category's real assignments, rejects
  //     duplicates, and uses the atomic RPC / constraint-safe fallback).
  assignSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/content-rules' });
    try {
      const { source_id, category_id } = parseSourceAssignmentForm(await request.formData());
      await assignSourceToCategory(locals.supabase, source_id, category_id);
      throw redirect(303, `/admin/system/content-rules?tab=categories&notice=Source%20assigned.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to assign source.') });
    }
  },
  removeSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/content-rules' });
    try {
      const { source_id, category_id } = parseSourceAssignmentForm(await request.formData());
      await deleteSourceCategory(locals.supabase, source_id, category_id);
      throw redirect(303, `/admin/system/content-rules?tab=categories&notice=Source%20removed.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to remove source.') });
    }
  },
  reorderSources: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/content-rules' });
    try {
      const { categoryId, positions } = parseCategoryReorderForm(await request.formData());
      // MAVP-7 (Issue 2): numeric-position contract. The submitted fields are
      // PER-SOURCE TARGETS (`position_<source_id>` — typically exactly one,
      // the row the admin edited). The final order is derived SERVER-SIDE
      // from the database's current assignments (move-to-position-N, shift
      // the rest, dense 1..N) — the client can never inject an arbitrary
      // ordering, and out-of-range/malformed targets are rejected with an
      // admin-facing error before any write.
      // 2026-10-16 round: the interactive UI now uses the UNIFIED bulk
      // reposition workflow (reorderSourcesBulk below — the complete
      // intended order in ONE request); this single-row move action remains
      // a valid API (no UI caller) and its contract/tests are unchanged.
      await applyCategorySourcePositions(locals.supabase, categoryId, positions);
      throw redirect(303, `/admin/system/content-rules?tab=categories&notice=Sources%20reordered.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to reorder sources.') });
    }
  },

  // 2026-10-16 round (Issue 5): UNIFIED BULK REPOSITION — the category's
  // complete intended source order in ONE request. The client submits
  // `ordered_source_ids` (repeated field, first = position 1); the service
  // re-validates the set against the category's REAL assignments (every
  // assigned source exactly once, no unknown ids) and persists through the
  // ATOMIC reorder_category_sources RPC (single transaction, row lock,
  // two-phase renumber that can never violate unique(category_id, ordering))
  // with the constraint-safe fallback. There is no partially applied order
  // when a write fails.
  reorderSourcesBulk: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/content-rules' });
    try {
      const form = await request.formData();
      const categoryId = parseId(form, 'Category');
      const orderedSourceIds = parseBulkOrderedIds(form, 'ordered_source_ids', 'Source order');
      if (!orderedSourceIds.length) return fail(400, { message: 'The reorder payload is empty.' });
      await reorderCategorySources(locals.supabase, categoryId, orderedSourceIds);
      throw redirect(303, `/admin/system/content-rules?tab=categories&notice=Sources%20reordered.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to reorder sources.') });
    }
  },

  // 2026-10-16 round (Issue 5): UNIFIED BULK REPOSITION for the GLOBAL
  // category list ordering. The client submits `ordering_<category_id>` for
  // EVERY category (prefilled from the saved values); the service
  // re-validates completeness, integer bounds and uniqueness server-side
  // before any write. The interactive form uses use:enhance — success
  // invalidates the load in place (no full-page reload, list state kept).
  reorderCategories: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/content-rules' });
    try {
      const positions = parseBulkOrderings(await request.formData(), 'ordering_', 'Category');
      await reorderCategoryOrderings(locals.supabase, positions.map(({ id, ordering }) => ({ categoryId: id, ordering })));
      throw redirect(303, `/admin/system/content-rules?tab=categories&notice=Category%20order%20saved.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to reorder categories.') });
    }
  },
};
