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
  assignSourceToCategory, deleteSourceCategory, reorderCategorySources,
} from '$lib/server/streaming/admin-service';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';
import { parseCategoryForm, parseId, parseSourceAssignmentForm, parseCategoryReorderForm } from '$lib/server/streaming/validation';
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
      await updateCategory(locals.supabase, id, parseCategoryForm(form));
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
  // --- Source assignment management (MAVP-6 Issue 4) ---
  //
  // FINDING-008 history: these three actions were removed because the
  // Categories tab shipped without a source-assignment UI. MAVP-6 restores
  // the COMPLETE workflow: the category editor now carries the source
  // management section (assign / remove / reorder), so every action below
  // has a real UI caller. The contracts are the EXISTING service-layer
  // methods (assignSourceToCategory / deleteSourceCategory /
  // reorderCategorySources) over the authoritative
  // streaming_source_categories mapping — no competing data model.
  //
  // Security/integrity contract (unchanged from the pre-removal design and
  // re-verified against the service layer):
  //   * requireAdmin on EVERY mutation (same gate as category CRUD).
  //   * All submitted IDs are strictly parsed/validated server-side
  //     (parseSourceAssignmentForm / parseCategoryReorderForm — UUID shapes,
  //     bounded text, positive integer positions).
  //   * Assignment appends densely (service), is idempotent for an
  //     already-assigned source, and never touches source metadata.
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
      // Deterministic: the submitted 1-based positions define the order —
      // sorted explicitly here so the payload's field order can never
      // influence the outcome. The service then validates the set against
      // the category's real assignments (duplicates / stale / deleted
      // records are rejected with an admin-facing error, never half-applied).
      const orderedSourceIds = [...positions].sort((a, b) => a.position - b.position).map((p) => p.sourceId);
      await reorderCategorySources(locals.supabase, categoryId, orderedSourceIds);
      throw redirect(303, `/admin/system/content-rules?tab=categories&notice=Sources%20reordered.`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to reorder sources.') });
    }
  },
};
