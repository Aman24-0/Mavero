/**
 * Admin 2.0 — Phase G — Content Rules workspace page server.
 *
 * Unified workspace for categories + feature control.
 * Reuses existing admin-service for categories CRUD.
 * Feature control uses the existing /api/admin/adult-mode API.
 */

import { fail, redirect } from '@sveltejs/kit';
import { isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import {
  listAdminCategories, listAdminSources, listSourceCategories,
} from '$lib/server/streaming/admin-service';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';
import { error } from '@sveltejs/kit';

const VALID_TABS = new Set(['categories', 'features']);

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
