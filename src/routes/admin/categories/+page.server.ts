import { fail, redirect, isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { applyCategorySourcePositions, assignSourceToCategory, createCategory, deleteCategory, deleteSourceCategory, listAdminCategories, listAdminSources, listSourceCategories, updateCategory } from '$lib/server/streaming/admin-service';
import { StreamingValidationError, parseCategoryForm, parseCategoryReorderForm, parseId, parseSourceAssignmentForm } from '$lib/server/streaming/validation';

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/categories' });
  const [categories, sources, sourceCategories] = await Promise.all([listAdminCategories(locals.supabase), listAdminSources(locals.supabase), listSourceCategories(locals.supabase)]);
  return { categories, sources, sourceCategories, notice: url.searchParams.get('notice') };
};

function messageFrom(error: unknown, fallback: string) {
  return error instanceof StreamingValidationError || error instanceof Error ? error.message : fallback;
}

export const actions: Actions = {
  createCategory: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/categories' });
    try {
      const category = await createCategory(locals.supabase, parseCategoryForm(await request.formData()));
      throw redirect(303, `/admin/categories?notice=${encodeURIComponent(`Created ${category.name}.`)}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to create category.') });
    }
  },
  updateCategory: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/categories' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Category');
      await updateCategory(locals.supabase, id, parseCategoryForm(form));
      throw redirect(303, '/admin/categories?notice=Category%20updated.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to update category.') });
    }
  },
  toggleCategory: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/categories' });
    try {
      const form = await request.formData();
      const id = parseId(form, 'Category');
      await updateCategory(locals.supabase, id, { enabled: String(form.get('enabled')) === 'true' });
      throw redirect(303, '/admin/categories?notice=Category%20state%20updated.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to update category state.') });
    }
  },
  deleteCategory: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/categories' });
    try {
      await deleteCategory(locals.supabase, parseId(await request.formData(), 'Category'));
      throw redirect(303, '/admin/categories?notice=Category%20deleted.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to delete category.') });
    }
  },
  assignSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/categories' });
    try {
      // Task 13: assignment appends at the END of the category (dense
      // numbering); re-assigning an already assigned source is a no-op that
      // keeps its position. Position changes go through reorderSources.
      const assignment = parseSourceAssignmentForm(await request.formData());
      await assignSourceToCategory(locals.supabase, assignment.source_id, assignment.category_id);
      throw redirect(303, '/admin/categories?notice=Source%20assignment%20saved.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to assign source.') });
    }
  },
  reorderSources: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/categories' });
    try {
      // Task 13: the client submits 1-based position targets; the server
      // derives the final order from the database's current order.
      const { categoryId, positions } = parseCategoryReorderForm(await request.formData());
      await applyCategorySourcePositions(locals.supabase, categoryId, positions);
      throw redirect(303, '/admin/categories?notice=Source%20order%20saved.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to save the source order.') });
    }
  },
  removeSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/categories' });
    try {
      // Task 13 follow-up: the delete form posts `source_id` + `category_id`
      // (the same field names as the assign form). Parsing the source with
      // parseId() read the WRONG field (`id`) and always failed with
      // "Source is required." before the service was reached. Both ids now
      // go through the shared assignment parser — identical validation to
      // assignSource, and the action still only removes the category
      // ASSIGNMENT (deleteSourceCategory never deletes the global source).
      const assignment = parseSourceAssignmentForm(await request.formData());
      await deleteSourceCategory(locals.supabase, assignment.source_id, assignment.category_id);
      throw redirect(303, '/admin/categories?notice=Source%20assignment%20removed.');
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to remove source assignment.') });
    }
  },
};
