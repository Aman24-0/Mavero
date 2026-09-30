/**
 * Task 13 follow-up: source → category membership derivation for the admin
 * assignment picker.
 *
 * Pure data projection over rows the page has ALREADY loaded
 * (`data.sourceCategories` + `data.categories` from the page load) — the
 * membership map is derived once, client-side, with ZERO extra Supabase
 * queries (no per-source lookups, no N+1).
 *
 * Structural (not generated) input types keep this module free of server
 * imports so it is safely shareable between client pages and tests.
 */

/** Mapping-row shape (subset of streaming_source_categories). */
export type MembershipMapping = { source_id: string; category_id: string };

/** Category-row shape (subset of streaming_categories). */
export type MembershipCategory = { id: string; name: string };

/** One category a source is assigned to (id + display name). */
export type SourceMembership = { id: string; name: string };

/**
 * Builds the full assignment map: sourceId → the categories that source is
 * assigned to, in CATEGORY REGISTRY order (the order the admin's category
 * list uses). Mappings that reference an unknown/missing category row are
 * skipped safely — they can never render a blank or "undefined" chip.
 */
export function categoryMembershipsBySource(
  mappings: readonly MembershipMapping[],
  categories: readonly MembershipCategory[],
): Map<string, SourceMembership[]> {
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const registryRank = new Map(categories.map((category, index) => [category.id, index]));
  const memberships = new Map<string, SourceMembership[]>();
  for (const mapping of mappings) {
    const category = categoryById.get(mapping.category_id);
    if (!category) continue;
    const existing = memberships.get(mapping.source_id);
    if (existing) existing.push({ id: category.id, name: category.name });
    else memberships.set(mapping.source_id, [{ id: category.id, name: category.name }]);
  }
  for (const list of memberships.values()) {
    // Stable sort — sources assigned to multiple categories show their
    // categories in registry order (same order the admin page lists them).
    list.sort((a, b) => (registryRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (registryRank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }
  return memberships;
}

/**
 * Orders one source's memberships for picker display: the CURRENT category
 * first (it is the most relevant — it explains why the row is not
 * assignable), then every other category in registry order.
 */
export function orderMembershipsForPicker(
  memberships: readonly SourceMembership[],
  currentCategoryId: string | null | undefined,
): SourceMembership[] {
  if (!currentCategoryId) return [...memberships];
  return [...memberships].sort(
    (a, b) => Number(b.id === currentCategoryId) - Number(a.id === currentCategoryId),
  );
}
