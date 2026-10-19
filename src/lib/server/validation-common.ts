// ============================================================================
// Server-side form-validation PRIMITIVES shared by the streaming and
// downloader registries (Phase 3 3-B, repository-cleanup plan §5 group 3-B;
// audit §3.4 / §7 P3-2).
//
// `validateSlug` / `normalizeSlug` / `parseId` were DUPLICATED byte-for-byte
// in `server/streaming/validation.ts` and `server/downloader/validation.ts`
// — same regexes, same messages, same check order — with only the thrown
// ERROR CLASS differing (StreamingValidationError vs DownloaderValidationError).
// This module owns ONE implementation; each registry parameterizes the error
// class via `createError` and keeps exporting the same names, so every
// existing importer (admin routes, addon-validation, script suites) is
// untouched and every error keeps its registry-specific class.
//
// The downloader registry's header documents its deliberate decoupling from
// streaming ("so the two registries can evolve without coupling") — that
// decoupling is preserved at the CONTRACT level: sharing these three
// identical PRIMITIVES removes drift risk without coupling the registries'
// form schemas, error classes, or public modules.
// ============================================================================

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The registry-specific slug helpers: identical logic in both registries,
 * differing only in the error class thrown by validateSlug.
 */
export function makeSlugHelpers<E extends Error>(createError: (message: string) => E) {
  function normalizeSlug(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, '-');
  }
  function validateSlug(value: string, label = 'Slug'): string {
    const slug = normalizeSlug(value);
    if (!slugPattern.test(slug)) throw createError(`${label} must use lowercase letters, numbers, and single hyphens only.`);
    return slug;
  }
  return { normalizeSlug, validateSlug };
}

const idPattern = /^[0-9a-f-]{36}$/i;
const ID_MAX_LENGTH = 80;

/**
 * The registry-specific `parseId(form, label)` helper: parses a UUID-shaped
 * id from a form field with the EXACT messages the two registries shipped
 * ("is required." / "must be 80 characters or fewer." / "is invalid."),
 * throwing the registry's error class via `createError`.
 */
export function makeIdParser<E extends Error>(createError: (message: string) => E) {
  return function parseId(form: FormData, label: string): string {
    const id = String(form.get('id') ?? '').trim();
    if (!id) throw createError(`${label} is required.`);
    if (id.length > ID_MAX_LENGTH) throw createError(`${label} must be ${ID_MAX_LENGTH} characters or fewer.`);
    if (!idPattern.test(id)) throw createError(`${label} is invalid.`);
    return id;
  };
}
