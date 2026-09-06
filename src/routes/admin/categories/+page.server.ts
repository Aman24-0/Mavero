import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createCategory, deleteCategory, deleteSourceCategory, listAdminCategories, listAdminSources, listSourceCategories, updateCategory, upsertSourceCategory } from '$lib/server/streaming/admin-service';
import { StreamingValidationError, parseCategoryForm, parseId, parseSourceCategoryForm } from '$lib/server/streaming/validation';

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
      if (error instanceof Response) throw error;
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
      if (error instanceof Response) throw error;
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
      if (error instanceof Response) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to update category state.') });
    }
  },
  deleteCategory: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/categories' });
    try {
      await deleteCategory(locals.supabase, parseId(await request.formData(), 'Category'));
      throw redirect(303, '/admin/categories?notice=Category%20deleted.');
    } catch (error) {
      if (error instanceof Response) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to delete category.') });
    }
  },
  assignSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/categories' });
    try {
      await upsertSourceCategory(locals.supabase, parseSourceCategoryForm(await request.formData()));
      throw redirect(303, '/admin/categories?notice=Source%20assignment%20saved.');
    } catch (error) {
      if (error instanceof Response) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to assign source.') });
    }
  },
  removeSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/categories' });
    try {
      const form = await request.formData();
      const sourceId = parseId(form, 'Source');
      const categoryId = (() => {
        const category = new FormData();
        category.set('id', String(form.get('category_id') ?? ''));
        return parseId(category, 'Category');
      })();
      await deleteSourceCategory(locals.supabase, sourceId, categoryId);
      throw redirect(303, '/admin/categories?notice=Source%20assignment%20removed.');
    } catch (error) {
      if (error instanceof Response) throw error;
      return fail(400, { message: messageFrom(error, 'Unable to remove source assignment.') });
    }
  },
};
