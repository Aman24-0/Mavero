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
} from '$lib/server/streaming/admin-service';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';
import { parseCategoryForm, parseId } from '$lib/server/streaming/validation';
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
  // FINDING-008 fix: removed dead `assignSource`, `removeSource`, and
  // `reorderSources` actions. These server actions existed but were
  // never invoked from any UI — no source-assignment interface was
  // built for the Categories tab. Leaving dead actions in the codebase
  // is a maintenance burden (they import helpers, parse forms, and
  // could be accidentally triggered by a crafted POST). If a
  // source-assignment UI is needed in the future, the actions can be
  // re-added with a corresponding UI.
};
