import { identifierModes, integrationTypes, providerStatuses, sourceVisibilities, type IdentifierMode, type IntegrationType, type JsonObject, type ProviderStatus, type SourceVisibility } from './types';
import { isSourceBadge, isSourceIconKey, type SourceBadge, type SourceIconKey } from '$lib/shared/source-presentation';
import { withSandboxPolicy, sandboxPolicies, type SandboxPolicy } from '$lib/shared/sandbox-policy';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const adapterPattern = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

export class StreamingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamingValidationError';
  }
}

function text(value: FormDataEntryValue | null, label: string, maxLength: number): string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new StreamingValidationError(`${label} must be ${maxLength} characters or fewer.`);
  return normalized;
}

function requiredText(value: FormDataEntryValue | null, label: string, maxLength: number): string {
  const normalized = text(value, label, maxLength);
  if (!normalized) throw new StreamingValidationError(`${label} is required.`);
  return normalized;
}

function enumValue<T extends readonly string[]>(value: FormDataEntryValue | null, label: string, values: T, fallback: T[number]): T[number] {
  const normalized = String(value ?? fallback).trim();
  if (!values.includes(normalized)) throw new StreamingValidationError(`${label} is invalid.`);
  return normalized as T[number];
}

function booleanValue(value: FormDataEntryValue | null, fallback = false): boolean {
  if (value === null) return fallback;
  return value === 'on' || value === 'true' || value === '1';
}

function nonNegativeInteger(value: FormDataEntryValue | null, label: string, fallback = 0): number {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new StreamingValidationError(`${label} must be a non-negative integer.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new StreamingValidationError(`${label} is invalid.`);
  return parsed;
}

function jsonObject(value: FormDataEntryValue | null, label: string): JsonObject {
  const raw = String(value ?? '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('object required');
    return parsed as JsonObject;
  } catch {
    throw new StreamingValidationError(`${label} must be a valid JSON object.`);
  }
}

function stringList(value: FormDataEntryValue | null, label: string, maxItems = 20): string[] {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  const values = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length > maxItems || values.some((item) => item.length > 60)) throw new StreamingValidationError(`${label} contains too many or overly long values.`);
  return [...new Set(values)];
}

function template(value: FormDataEntryValue | null, label: string): string | null {
  const normalized = text(value, label, 500);
  if (normalized && /[\r\n]/.test(normalized)) throw new StreamingValidationError(`${label} must be a single line in Phase 7A.`);
  return normalized;
}

/**
 * Task 13: parses the constrained user-facing badge. '' / 'none' / missing
 * → NULL (no badge rendered). Any other value is REJECTED — arbitrary
 * text, HTML or markup can never enter the column.
 */
function badgeValue(value: FormDataEntryValue | null): SourceBadge | null {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized === 'none') return null;
  if (!isSourceBadge(normalized)) throw new StreamingValidationError('User tag is invalid.');
  return normalized;
}

/**
 * Task 13: parses the safe icon KEY. '' / missing → NULL (default icon
 * rendered). Only allowlisted keys are accepted — SVG/HTML/arbitrary text
 * is rejected here, by the DB format CHECK, and again at render time.
 */
function iconValue(value: FormDataEntryValue | null): SourceIconKey | null {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized === 'none') return null;
  if (!isSourceIconKey(normalized)) throw new StreamingValidationError('Source icon is invalid.');
  return normalized;
}

function positiveInteger(value: FormDataEntryValue | null, label: string): number {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new StreamingValidationError(`${label} must be a positive whole number.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new StreamingValidationError(`${label} must be a positive whole number.`);
  return parsed;
}

/**
 * Phase 8: strips any legacy `sandbox_policy` key from a source's
 * capabilities JSON. Sandbox is now provider-level only — sources must
 * NOT carry this key. All other capability fields (allowed_embed_origins,
 * result_type, supports_*, movie/series/anime flags, etc.) are preserved.
 */
function stripSandboxPolicy(capabilities: JsonObject): JsonObject {
  if ('sandbox_policy' in capabilities) {
    const next = { ...capabilities };
    delete next.sandbox_policy;
    return next;
  }
  return capabilities;
}

export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

export function validateSlug(value: string, label = 'Slug'): string {
  const slug = normalizeSlug(value);
  if (!slugPattern.test(slug)) throw new StreamingValidationError(`${label} must use lowercase letters, numbers, and single hyphens only.`);
  return slug;
}

export function parseProviderForm(form: FormData) {
  const adapterId = text(form.get('adapter_id'), 'Adapter ID', 80);
  if (adapterId && !adapterPattern.test(adapterId)) throw new StreamingValidationError('Adapter ID must use lowercase letters, numbers, hyphens, underscores, or periods.');
  return {
    name: requiredText(form.get('name'), 'Provider name', 120),
    slug: validateSlug(requiredText(form.get('slug'), 'Provider slug', 120), 'Provider slug'),
    description: text(form.get('description'), 'Description', 500),
    icon: text(form.get('icon'), 'Icon', 120),
    status: enumValue(form.get('status'), 'Provider status', providerStatuses, 'experimental') as ProviderStatus,
    enabled: booleanValue(form.get('enabled')),
    integration_type: enumValue(form.get('integration_type'), 'Integration type', integrationTypes, 'template') as IntegrationType,
    adapter_id: adapterId,
    capabilities: withSandboxPolicy(jsonObject(form.get('capabilities'), 'Capabilities'), enumValue(form.get('sandbox_policy'), 'Sandbox policy', sandboxPolicies, 'required') as SandboxPolicy),
    notes: text(form.get('notes'), 'Notes', 2000),
  };
}

export function parseSourceForm(form: FormData) {
  const providerId = requiredText(form.get('provider_id'), 'Provider', 80);
  if (!/^[0-9a-f-]{36}$/i.test(providerId)) throw new StreamingValidationError('Provider is invalid.');
  return {
    provider_id: providerId,
    name: requiredText(form.get('name'), 'Source name', 120),
    slug: validateSlug(requiredText(form.get('slug'), 'Source slug', 120), 'Source slug'),
    description: text(form.get('description'), 'Description', 500),
    // Task 13: presentation metadata (badge + icon) — constrained values
    // only, parsed by badgeValue/iconValue above.
    badge: badgeValue(form.get('badge')),
    icon: iconValue(form.get('icon')),
    enabled: booleanValue(form.get('enabled')),
    visibility: enumValue(form.get('visibility'), 'Visibility', sourceVisibilities, 'public') as SourceVisibility,
    status: enumValue(form.get('status'), 'Source status', providerStatuses, 'experimental') as ProviderStatus,
    ordering: nonNegativeInteger(form.get('ordering'), 'Ordering'),
    integration_type: (() => {
      const value = String(form.get('integration_type') ?? '').trim();
      return value ? enumValue(form.get('integration_type'), 'Integration type', integrationTypes, 'template') as IntegrationType : null;
    })(),
    // Phase 8: sandbox is PROVIDER-LEVEL ONLY. Source forms no longer
    // accept or store sandbox_policy. The capabilities JSON is parsed
    // as-is (preserving allowed_embed_origins, result_type, supports_*
    // fields, etc.) and any legacy sandbox_policy key is stripped.
    capabilities: stripSandboxPolicy(jsonObject(form.get('capabilities'), 'Capabilities')),
    movie_template: template(form.get('movie_template'), 'Movie template'),
    series_template: template(form.get('series_template'), 'Series template'),
    anime_template: template(form.get('anime_template'), 'Anime template'),
    identifier_mode: enumValue(form.get('identifier_mode'), 'Identifier mode', identifierModes, 'custom') as IdentifierMode,
    language: text(form.get('language'), 'Language', 60),
    audio_languages: stringList(form.get('audio_languages'), 'Audio languages'),
    subtitle_capability: booleanValue(form.get('subtitle_capability')),
    quality_capability: stringList(form.get('quality_capability'), 'Quality capability'),
    notes: text(form.get('notes'), 'Notes', 2000),
  };
}

export function parseCategoryForm(form: FormData) {
  return {
    name: requiredText(form.get('name'), 'Category name', 120),
    slug: validateSlug(requiredText(form.get('slug'), 'Category slug', 120), 'Category slug'),
    description: text(form.get('description'), 'Description', 500),
    enabled: booleanValue(form.get('enabled'), true),
    ordering: nonNegativeInteger(form.get('ordering'), 'Ordering'),
  };
}

export function parseId(form: FormData, label: string): string {
  const id = requiredText(form.get('id'), label, 80);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new StreamingValidationError(`${label} is invalid.`);
  return id;
}

export function parseSourceCategoryForm(form: FormData) {
  const sourceId = requiredText(form.get('source_id'), 'Source', 80);
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new StreamingValidationError('Source is invalid.');
  const categoryId = (() => {
    const value = requiredText(form.get('category_id'), 'Category', 80);
    if (!/^[0-9a-f-]{36}$/i.test(value)) throw new StreamingValidationError('Category is invalid.');
    return value;
  })();
  return { source_id: sourceId, category_id: categoryId, ordering: nonNegativeInteger(form.get('ordering'), 'Ordering') };
}

/**
 * Task 13: assignment form WITHOUT a manual ordering input. Assigning a
 * source appends it at the end of the category (dense numbering); position
 * changes belong to the dedicated reorder workflow.
 */
export function parseSourceAssignmentForm(form: FormData): { source_id: string; category_id: string } {
  const sourceId = requiredText(form.get('source_id'), 'Source', 80);
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new StreamingValidationError('Source is invalid.');
  const categoryId = requiredText(form.get('category_id'), 'Category', 80);
  if (!/^[0-9a-f-]{36}$/i.test(categoryId)) throw new StreamingValidationError('Category is invalid.');
  return { source_id: sourceId, category_id: categoryId };
}

const POSITION_FIELD_PREFIX = 'position_';

/**
 * Task 13: category reorder form. The client submits 1-based position
 * fields (`position_<source_id>`) for the sources the admin edited. The
 * server derives the final order from the DATABASE's current order — the
 * client can never inject an arbitrary ordering or touch another
 * category's sources (membership is validated against the category's
 * real assignments in the admin service).
 */
export function parseCategoryReorderForm(form: FormData): { categoryId: string; positions: Array<{ sourceId: string; position: number }> } {
  const categoryId = requiredText(form.get('category_id'), 'Category', 80);
  if (!/^[0-9a-f-]{36}$/i.test(categoryId)) throw new StreamingValidationError('Category is invalid.');
  const positions: Array<{ sourceId: string; position: number }> = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith(POSITION_FIELD_PREFIX)) continue;
    const sourceId = key.slice(POSITION_FIELD_PREFIX.length);
    if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new StreamingValidationError('Source is invalid.');
    positions.push({ sourceId, position: positiveInteger(value, 'Position') });
  }
  return { categoryId, positions };
}
