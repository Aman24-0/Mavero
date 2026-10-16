import { identifierModes, integrationTypes, providerStatuses, sourceVisibilities, type IdentifierMode, type IntegrationType, type JsonObject, type ProviderStatus, type SourceVisibility } from './types';
import { isSourceBadge, isSourceIconKey, parseSourceBadgesStrict, serializeSourceBadges, type SourceBadge, type SourceBadgeConfig, type SourceIconKey } from '$lib/shared/source-presentation';
import { withSandboxPolicy, sandboxPolicies, type SandboxPolicy } from '$lib/shared/sandbox-policy';
import { validateIconUrl, IconValidationError } from '$lib/shared/icon-url';
// MAVP-4 Issue 4: SVG sanitization (established sanitizer pattern on the
// existing cheerio parser) + PNG upload normalization for source icons.
import { sanitizeSourceSvgMarkup, svgMarkupToDataUrl, SvgValidationError, pngUploadToDataUrl } from './svg-sanitizer';

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

/**
 * Icon/badge persistence contract (2026-10-16 round — "no-change ≠ erase"):
 *
 * The edit sheet ALWAYS submits the hidden presentation fields (icon, badge),
 * so an untouched field cannot be detected by ABSENCE from the payload. The
 * previously shipped semantics treated a submitted EMPTY icon as "remove" —
 * which silently erased a saved PNG-upload icon whenever an administrator
 * edited an UNRELATED field (the upload input mode submits '' when no NEW
 * file is picked; every configured production source stores a PNG data URL).
 *
 * The corrected contract (mirrored by the Admin form):
 *   * an UPLOADED FILE (`icon_file`) always wins — replace;
 *   * an explicit removal flag (`icon_remove=true`) → null — removal;
 *   * a non-empty submitted value → validated and stored — replace;
 *   * an EMPTY submitted value → on CREATE null (no icon), on UPDATE
 *     `undefined` (NO CHANGE — supabase-js drops undefined keys from the
 *     update payload, exactly like the {enabled}-only toggle path).
 * "No new file selected" can therefore never mean "delete the saved icon",
 * and explicit removal remains a deliberate, visible action.
 */
async function resolvedSourceIconValue(form: FormData, forUpdate: boolean): Promise<string | null | undefined> {
  const uploaded = await iconFileValue(form);
  if (uploaded) return uploaded;
  if (booleanValue(form.get('icon_remove'))) return null;
  const submitted = String(form.get('icon') ?? '').trim();
  if (submitted) return iconValue(submitted);
  return forUpdate ? undefined : null;
}

/**
 * Provider icon resolution — the SAME no-change-≠-erase contract as sources
 * (resolvedSourceIconValue above), plus the provider-specific accepted
 * shapes: the established https(s) URL contract (parseProviderIconField /
 * icon-url.ts) OR a bounded data URL (the shared upload pipeline — PNG
 * magic bytes / sanitized SVG — stored by the SAME mechanism as source
 * icons). Legacy source-icon KEYS are intentionally NOT accepted for
 * providers (providers never had a key grid; their icon is a URL or an
 * uploaded data URL).
 */
async function resolvedProviderIconValue(form: FormData, forUpdate: boolean): Promise<string | null | undefined> {
  const uploaded = await iconFileValue(form);
  if (uploaded) return uploaded;
  if (booleanValue(form.get('icon_remove'))) return null;
  const submitted = String(form.get('icon') ?? '').trim();
  if (submitted) {
    if (/^data:image\/(png|svg\+xml);base64,/.test(submitted)) {
      // Bounded revalidation of a stored upload (same contract as sources).
      return iconValue(submitted);
    }
    return parseProviderIconField(submitted);
  }
  return forUpdate ? undefined : null;
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
 * Task 13 / MAVP-4: parses the user-facing badge. '' / 'none' / missing
 * → NULL (no badge rendered). Legacy enum values stay byte-compatible;
 * the extensible JSON-array shape (MAVP-4) is validated STRICTLY —
 * arbitrary text, HTML or markup can never enter the column.
 */
function badgeValue(value: FormDataEntryValue | null): SourceBadge | string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized === 'none') return null;
  // MAVP-4 Issue 4: legacy single-enum values stay byte-compatible; the
  // extensible JSON-array shape is validated STRICTLY (bounded labels,
  // controlled variants, count cap, unique ids) and stored canonically.
  if (isSourceBadge(normalized)) return normalized;
  const badges = parseSourceBadgesStrict(normalized);
  if (!badges.length) return null;
  return serializeSourceBadges(badges);
}

/**
 * MAVP-4 Issue 4: rich source icon values. Accepted stored shapes:
 *   - legacy safe key (Task 13 allowlist) — byte-compatible;
 *   - data:image/png;base64 (uploaded PNG — bounded, magic-byte verified);
 *   - data:image/svg+xml;base64 (pasted SVG — SANITIZED before storing;
 *     scripts/handlers/external refs are REJECTED, never silently kept);
 *   - http(s) image URL (validated by the established icon-url contract).
 * Anything else rejects with a clear admin-facing message.
 */
function iconValue(value: FormDataEntryValue | null): SourceIconKey | string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized === 'none') return null;
  if (isSourceIconKey(normalized)) return normalized;
  // PNG data URL — strict shape + bounded size (the base64 of a ≤64KB PNG).
  const pngMatch = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(normalized);
  if (pngMatch) {
    if (normalized.length > 100_000) throw new StreamingValidationError('Uploaded PNG icons must be 64 KB or smaller.');
    try {
      const bytes = Buffer.from(pngMatch[1], 'base64');
      const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new StreamingValidationError('Uploaded icon is not a valid PNG image.');
      }
    } catch (error) {
      if (error instanceof StreamingValidationError) throw error;
      throw new StreamingValidationError('Uploaded icon is not a valid PNG image.');
    }
    return normalized;
  }
  // SVG data URL — the markup must survive sanitization; the STORED value is
  // the canonical re-encoding of the SANITIZED markup (the submitted markup
  // itself is never persisted).
  const svgMatch = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/]+={0,2})$/.exec(normalized);
  if (svgMatch) {
    let markup: string;
    try {
      markup = Buffer.from(svgMatch[1], 'base64').toString('utf8');
    } catch {
      throw new StreamingValidationError('SVG icon could not be decoded.');
    }
    try {
      const sanitized = sanitizeSourceSvgMarkup(markup);
      return svgMarkupToDataUrl(sanitized);
    } catch (error) {
      if (error instanceof SvgValidationError) throw new StreamingValidationError(error.message);
      throw error;
    }
  }
  // Raw pasted SVG markup (the Admin editor may submit markup directly).
  if (normalized.startsWith('<svg') || normalized.startsWith('<?xml')) {
    try {
      const sanitized = sanitizeSourceSvgMarkup(normalized);
      return svgMarkupToDataUrl(sanitized);
    } catch (error) {
      if (error instanceof SvgValidationError) throw new StreamingValidationError(error.message);
      throw error;
    }
  }
  // Remote image URL — the established icon-url contract (http/https only,
  // bounded length). Rendering is <img>-based, so SVG URLs are inert.
  if (/^https?:\/\//.test(normalized)) {
    try {
      return validateIconUrl(normalized);
    } catch (error) {
      if (error instanceof IconValidationError) throw new StreamingValidationError(error.message);
      throw error;
    }
  }
  throw new StreamingValidationError('Source icon is invalid. Use a built-in icon key, a PNG/SVG upload, sanitized SVG markup, or an https image URL.');
}

/**
 * MAVP-4 Issue 4: process an uploaded icon FILE (multipart form field
 * `icon_file`). PNG uploads are magic-byte verified; SVG uploads are
 * sanitized exactly like pasted markup. Returns the canonical data URL.
 */
async function iconFileValue(form: FormData): Promise<string | null> {
  const entry = form.get('icon_file');
  if (!entry || typeof entry === 'string') return null;
  const file = entry as File;
  if (!file.size) return null;
  try {
    if (file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
      if (file.size > 48_000) throw new StreamingValidationError('Uploaded SVG icons must be 48 KB or smaller.');
      const markup = await file.text();
      const sanitized = sanitizeSourceSvgMarkup(markup);
      return svgMarkupToDataUrl(sanitized);
    }
    return await pngUploadToDataUrl(file);
  } catch (error) {
    if (error instanceof SvgValidationError) throw new StreamingValidationError(error.message);
    throw error;
  }
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

/**
 * Provider create/update form (2026-10-16 round): the icon field now goes
 * through resolvedProviderIconValue — URL contract preserved, UPLOAD added
 * (same pipeline/validation as source icons), explicit removal flag added,
 * and an EMPTY icon field on UPDATE means NO CHANGE (never an erase).
 * ASYNC (like parseSourceForm): an uploaded icon file is validated and
 * normalized (PNG magic bytes / SVG sanitization) before it becomes the
 * stored data-URL value.
 */
export async function parseProviderForm(form: FormData, options: { forUpdate?: boolean } = {}) {
  const adapterId = text(form.get('adapter_id'), 'Adapter ID', 80);
  if (adapterId && !adapterPattern.test(adapterId)) throw new StreamingValidationError('Adapter ID must use lowercase letters, numbers, hyphens, underscores, or periods.');
  return {
    name: requiredText(form.get('name'), 'Provider name', 120),
    slug: validateSlug(requiredText(form.get('slug'), 'Provider slug', 120), 'Provider slug'),
    description: text(form.get('description'), 'Description', 500),
    // FINDING-017 fix: validate provider icon as a URL (http/https only).
    // Previously this was loose `text()` validation that accepted
    // arbitrary strings — the same vulnerability as download_providers.icon.
    // Now: the icon must be a valid http/https URL, a validated upload data
    // URL, an explicit removal, or empty (null on create / no-change on
    // update).
    icon: await resolvedProviderIconValue(form, options.forUpdate === true),
    status: enumValue(form.get('status'), 'Provider status', providerStatuses, 'experimental') as ProviderStatus,
    enabled: booleanValue(form.get('enabled')),
    integration_type: enumValue(form.get('integration_type'), 'Integration type', integrationTypes, 'template') as IntegrationType,
    adapter_id: adapterId,
    capabilities: withSandboxPolicy(jsonObject(form.get('capabilities'), 'Capabilities'), enumValue(form.get('sandbox_policy'), 'Sandbox policy', sandboxPolicies, 'required') as SandboxPolicy),
    notes: text(form.get('notes'), 'Notes', 2000),
  };
}

// ----- Player Controls Position (per-source landscape control placement) -----
//
// Player redesign: the Admin Panel's "Player Controls Position" section of the
// source edit sheet persists a validated placement inside the EXISTING
// `streaming_sources.capabilities` JSONB under the `player_controls_position`
// key (no schema change; the public config already exposes source
// capabilities). The runtime shape + a TOTAL client-side parser live in
// `$lib/shared/player-controls-position.ts` — this server-side parser is the
// STRICT gate (malformed/non-finite/out-of-range values are REJECTED with a
// clear admin-facing message, per the approved spec).
//
// Form fields:
//   controls_position_json (MAVP-2, preferred): ONE field carrying the full
//     JSON document in the EXACT stored shape ({ mode, portrait?,
//     landscape?, back?, sizes? } with axis objects { anchor, offsetPercent }
//     and the MAVP-3 sizes object { back?, landscape? } in integer px). A
//     single structured payload eliminates the reported bug class for good:
//     individual text fields could arrive with an offset but a missing
//     anchor (the Admin sheet always rendered the four override offset
//     inputs bound to 0 while their anchor selects submitted an empty
//     "Inherit" value → "Player Controls Position offsets require a
//     matching anchor." on EVERY custom-mode save). The payload is still
//     STRICTLY validated here — server-side validation stays authoritative.
//   Legacy flat fields (kept for backward compatibility with pre-MAVP-2
//     callers and tests; parsed exactly as before when the JSON payload is
//     absent):
//   controls_position_mode           '' | 'default' | 'custom'
//   controls_position_h_anchor       left | right | center
//   controls_position_h_offset       0..100  (percent of viewport)
//   controls_position_v_anchor       top | bottom | center
//   controls_position_v_offset       0..100
//   controls_position_p_h_anchor/_offset, controls_position_p_v_anchor/_offset
//   controls_position_l_h_anchor/_offset, controls_position_l_v_anchor/_offset
//     (optional portrait (_p_) / landscape (_l_) axis overrides)

const CONTROLS_POSITION_H_ANCHORS = ['left', 'right', 'center'] as const;
const CONTROLS_POSITION_V_ANCHORS = ['top', 'bottom', 'center'] as const;

// MAVP-3 size bounds — mirrored from $lib/shared/player-controls-position.ts
// (the module cannot be imported here because this file is the server gate
// and must stay dependency-light; the shared parser re-normalises on read,
// and the contract tests assert BOTH gates agree).
const CONTROLS_POSITION_SIZE_MIN_PX = 28;
const CONTROLS_POSITION_SIZE_MAX_PX = 96;

type ControlsPositionAxisJson = { anchor: string; offsetPercent: number };
type ControlsPositionOverrideJson = { horizontal?: ControlsPositionAxisJson; vertical?: ControlsPositionAxisJson };

function controlsPositionAxisJson(value: unknown, label: string, anchors: readonly string[]): ControlsPositionAxisJson | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StreamingValidationError(`Player Controls Position ${label} must be an object with anchor and offsetPercent.`);
  }
  const record = value as Record<string, unknown>;
  const anchor = record.anchor;
  if (typeof anchor !== 'string' || !anchors.includes(anchor)) {
    throw new StreamingValidationError(`Player Controls Position ${label} anchor is invalid.`);
  }
  // offsetPercent defaults per anchor semantics when omitted (mirrors the
  // legacy flat-field behavior): center = 50, edges = 0.
  const rawOffset = record.offsetPercent;
  if (rawOffset === undefined || rawOffset === null || rawOffset === '') {
    return { anchor, offsetPercent: anchor === 'center' ? 50 : 0 };
  }
  if (typeof rawOffset !== 'number' || !Number.isFinite(rawOffset) || rawOffset < 0 || rawOffset > 100) {
    throw new StreamingValidationError(`Player Controls Position ${label} offset must be a number between 0 and 100.`);
  }
  return { anchor, offsetPercent: Math.round(rawOffset * 10) / 10 };
}

function controlsPositionOverrideJson(value: unknown, label: string): ControlsPositionOverrideJson | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StreamingValidationError(`Player Controls Position ${label} profile must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const horizontal = controlsPositionAxisJson(record.horizontal, `${label} horizontal`, CONTROLS_POSITION_H_ANCHORS);
  const vertical = controlsPositionAxisJson(record.vertical, `${label} vertical`, CONTROLS_POSITION_V_ANCHORS);
  if (!horizontal && !vertical) return null;
  return { ...(horizontal ? { horizontal } : {}), ...(vertical ? { vertical } : {}) };
}

/**
 * MAVP-3: STRICT per-control size validation for the JSON payload. Sizes are
 * integer CSS pixels within [CONTROLS_POSITION_SIZE_MIN_PX .. _MAX_PX] —
 * the documented safe range that prevents invisible, unusably small, or
 * viewport-dominating controls. Malformed types, non-finite numbers and
 * out-of-range values are REJECTED with a clear admin-facing message
 * (server validation stays authoritative). Valid values normalise to
 * integers; absent/null entries are omitted (default size).
 */
function controlsPositionSizeJson(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StreamingValidationError(`Player Controls Position ${label} size must be a number of pixels.`);
  }
  const rounded = Math.round(value);
  if (rounded < CONTROLS_POSITION_SIZE_MIN_PX || rounded > CONTROLS_POSITION_SIZE_MAX_PX) {
    throw new StreamingValidationError(`Player Controls Position ${label} size must be between ${CONTROLS_POSITION_SIZE_MIN_PX} and ${CONTROLS_POSITION_SIZE_MAX_PX} pixels.`);
  }
  return rounded;
}

function controlsPositionSizesJson(value: unknown): { back?: number; landscape?: number } | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StreamingValidationError('Player Controls Position sizes section must be an object.');
  }
  const record = value as Record<string, unknown>;
  const back = controlsPositionSizeJson(record.back, 'back button');
  const landscape = controlsPositionSizeJson(record.landscape, 'landscape button');
  // MAVP-6 (Issues 2+3): the episode chip has NO size entry — the chip is
  // fixed (64px, matching the source chip). A legacy `sizes.episodes` key is
  // an unknown key inside the sizes object and is DROPPED from the canonical
  // output (the validator rebuilds the object from known keys only).
  if (back === null && landscape === null) return null;
  return {
    ...(back !== null ? { back } : {}),
    ...(landscape !== null ? { landscape } : {}),
  };
}

/**
 * Strict parse of the `controls_position_json` transport field (MAVP-2).
 * Returns the canonical stored value, or null when the field is absent or
 * empty (the caller then falls back to the legacy flat-field parser and the
 * mode field). Every value is validated with the same strictness as the
 * flat fields — this is the authoritative gate; the Admin UI cannot bypass
 * it. Unknown keys inside the payload are ignored (tolerant), known keys
 * are validated strictly.
 */
function playerControlsPositionFromJson(raw: string): JsonObject | null {
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StreamingValidationError('Player Controls Position payload must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StreamingValidationError('Player Controls Position payload must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  const mode = record.mode;
  if (mode === 'default') return { mode: 'default' };
  if (mode !== 'custom') throw new StreamingValidationError('Player Controls Position mode is invalid.');
  const horizontal = controlsPositionAxisJson(record.horizontal, 'horizontal', CONTROLS_POSITION_H_ANCHORS);
  const vertical = controlsPositionAxisJson(record.vertical, 'vertical', CONTROLS_POSITION_V_ANCHORS);
  const portrait = controlsPositionOverrideJson(record.portrait, 'portrait');
  const landscape = controlsPositionOverrideJson(record.landscape, 'landscape');
  let back: ControlsPositionOverrideJsonContainer | null = null;
  if (record.back !== undefined && record.back !== null) {
    if (!record.back || typeof record.back !== 'object' || Array.isArray(record.back)) {
      throw new StreamingValidationError('Player Controls Position back section must be an object.');
    }
    const backRecord = record.back as Record<string, unknown>;
    const backPortrait = controlsPositionOverrideJson(backRecord.portrait, 'back portrait');
    const backLandscape = controlsPositionOverrideJson(backRecord.landscape, 'back landscape');
    if (backPortrait || backLandscape) back = { ...(backPortrait ? { portrait: backPortrait } : {}), ...(backLandscape ? { landscape: backLandscape } : {}) };
  }
  // MAVP-6 (Issues 2+3): the episode chip is no longer positionable — the
  // former `episodes` section validator was REMOVED. A payload that still
  // carries an `episodes` key (a legacy/naive client) hits the documented
  // unknown-key tolerance: ignored and dropped from the canonical value.
  // MAVP-3: independent per-control sizes (Back button, Landscape button).
  const sizes = controlsPositionSizesJson(record.sizes);
  // A custom payload needs at least one anchor OR at least one size — a
  // sizes-only save (resize without repositioning) is valid.
  if (!horizontal && !vertical && !portrait && !landscape && !back && !sizes) {
    throw new StreamingValidationError('Custom Player Controls Position needs at least one anchor (horizontal or vertical).');
  }
  return {
    mode: 'custom',
    ...(horizontal ? { horizontal } : {}),
    ...(vertical ? { vertical } : {}),
    ...(portrait ? { portrait } : {}),
    ...(landscape ? { landscape } : {}),
    ...(back ? { back } : {}),
    ...(sizes ? { sizes } : {}),
  };
}

type ControlsPositionOverrideJsonContainer = { portrait?: ControlsPositionOverrideJson; landscape?: ControlsPositionOverrideJson };

function controlsPositionPercent(form: FormData, field: string, anchor: string): number {
  const raw = String(form.get(field) ?? '').trim();
  if (!raw) return anchor === 'center' ? 50 : 0;
  const parsed = Number(raw);
  // Explicit rejection of malformed / non-finite / out-of-range offsets.
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new StreamingValidationError('Player Controls Position offsets must be numbers between 0 and 100.');
  }
  return Math.round(parsed * 10) / 10;
}

function controlsPositionAxis(form: FormData, anchorField: string, offsetField: string, anchors: readonly string[]): ControlsPositionAxisJson | null {
  const anchor = String(form.get(anchorField) ?? '').trim();
  const offsetRaw = String(form.get(offsetField) ?? '').trim();
  if (!anchor) {
    // An offset without its anchor is a form inconsistency — reject rather
    // than silently dropping the admin's (possibly meaningful) value.
    if (offsetRaw) throw new StreamingValidationError('Player Controls Position offsets require a matching anchor.');
    return null;
  }
  if (!anchors.includes(anchor)) throw new StreamingValidationError(`Player Controls Position anchor "${anchor}" is invalid.`);
  return { anchor, offsetPercent: controlsPositionPercent(form, offsetField, anchor) };
}

function controlsPositionOverride(form: FormData, prefix: string): { horizontal?: ControlsPositionAxisJson; vertical?: ControlsPositionAxisJson } | null {
  const horizontal = controlsPositionAxis(form, `${prefix}_h_anchor`, `${prefix}_h_offset`, CONTROLS_POSITION_H_ANCHORS);
  const vertical = controlsPositionAxis(form, `${prefix}_v_anchor`, `${prefix}_v_offset`, CONTROLS_POSITION_V_ANCHORS);
  if (!horizontal && !vertical) return null;
  return { ...(horizontal ? { horizontal } : {}), ...(vertical ? { vertical } : {}) };
}

/**
 * Parse the "Player Controls Position" form fields into the capability value.
 * Always returns an object: `{ mode: 'default' }` when the admin keeps the
 * default (which overwrites any stale custom config on merge), or the full
 * validated custom placement.
 *
 * Transport priority: the structured `controls_position_json` payload (the
 * Admin sheet's MAVP-2 contract) wins when present; the legacy flat fields
 * are parsed exactly as before when the payload is absent — existing
 * callers and tests keep working unchanged.
 */
export function playerControlsPositionCapability(form: FormData): JsonObject {
  const jsonPayload = form.get('controls_position_json');
  if (jsonPayload !== null) {
    const parsed = playerControlsPositionFromJson(String(jsonPayload));
    if (parsed) return parsed;
    // An explicitly empty payload means the admin saved the DEFAULT mode —
    // fall through and let the mode field decide (identical outcome),
    // preserving the overwrite-stale-custom-config merge behavior.
  }
  const mode = String(form.get('controls_position_mode') ?? '').trim() || 'default';
  if (mode === 'default') return { mode: 'default' };
  if (mode !== 'custom') throw new StreamingValidationError('Player Controls Position mode is invalid.');
  const horizontal = controlsPositionAxis(form, 'controls_position_h_anchor', 'controls_position_h_offset', CONTROLS_POSITION_H_ANCHORS);
  const vertical = controlsPositionAxis(form, 'controls_position_v_anchor', 'controls_position_v_offset', CONTROLS_POSITION_V_ANCHORS);
  const portrait = controlsPositionOverride(form, 'controls_position_p');
  const landscape = controlsPositionOverride(form, 'controls_position_l');
  if (!horizontal && !vertical && !portrait && !landscape) {
    throw new StreamingValidationError('Custom Player Controls Position needs at least one anchor (horizontal or vertical).');
  }
  return {
    mode: 'custom',
    ...(horizontal ? { horizontal } : {}),
    ...(vertical ? { vertical } : {}),
    ...(portrait ? { portrait } : {}),
    ...(landscape ? { landscape } : {}),
  };
}

function withPlayerControlsPosition(capabilities: JsonObject, position: JsonObject): JsonObject {
  return { ...capabilities, player_controls_position: position };
}

/**
 * MAVP-4 Issue 4: parseSourceForm is ASYNC — an uploaded icon file
 * (`icon_file`, multipart) is validated and normalized (PNG magic bytes /
 * SVG sanitization) before it becomes the stored data-URL value. When a
 * file is present it takes precedence over the `icon` field; without one
 * the `icon` field carries a legacy key, data URL, pasted markup or URL.
 *
 * 2026-10-16 round: options.forUpdate switches the ICON and ORDERING
 * semantics for the EDIT path:
 *   * icon — resolvedSourceIconValue (upload > explicit icon_remove >
 *     submitted value > NO CHANGE on empty). On the create path an empty
 *     icon stays null exactly as before.
 *   * ordering — the sheet no longer submits a global-ordering field (the
 *     authoritative ordering workflow is the dedicated bulk-reposition
 *     editor); when the form carries NO ordering field on an update the
 *     key is OMITTED from the payload (undefined) so an unrelated save can
 *     never clobber the saved global ordering. A form that DOES submit an
 *     ordering value is validated exactly as before.
 */
export async function parseSourceForm(form: FormData, options: { forUpdate?: boolean } = {}) {
  const forUpdate = options.forUpdate === true;
  const providerId = requiredText(form.get('provider_id'), 'Provider', 80);
  if (!/^[0-9a-f-]{36}$/i.test(providerId)) throw new StreamingValidationError('Provider is invalid.');
  const orderingRaw = form.get('ordering');
  return {
    provider_id: providerId,
    name: requiredText(form.get('name'), 'Source name', 120),
    slug: validateSlug(requiredText(form.get('slug'), 'Source slug', 120), 'Source slug'),
    description: text(form.get('description'), 'Description', 500),
    // Task 13 / MAVP-4: presentation metadata — constrained values only,
    // parsed by badgeValue/iconValue/iconFileValue above. The uploaded file
    // (when present) wins over the icon field. 2026-10-16: an EMPTY icon on
    // update means NO CHANGE (never an erase); removal is the explicit
    // icon_remove flag.
    badge: badgeValue(form.get('badge')),
    icon: await resolvedSourceIconValue(form, forUpdate),
    enabled: booleanValue(form.get('enabled')),
    visibility: enumValue(form.get('visibility'), 'Visibility', sourceVisibilities, 'public') as SourceVisibility,
    status: enumValue(form.get('status'), 'Source status', providerStatuses, 'experimental') as ProviderStatus,
    ordering: (forUpdate && orderingRaw === null) ? undefined : nonNegativeInteger(orderingRaw, 'Ordering'),
    integration_type: (() => {
      const value = String(form.get('integration_type') ?? '').trim();
      return value ? enumValue(form.get('integration_type'), 'Integration type', integrationTypes, 'template') as IntegrationType : null;
    })(),
    // Phase 8: sandbox is PROVIDER-LEVEL ONLY. Source forms no longer
    // accept or store sandbox_policy. The capabilities JSON is parsed
    // as-is (preserving allowed_embed_origins, result_type, supports_*
    // fields, etc.) and any legacy sandbox_policy key is stripped.
    // Player redesign: the per-source Landscape-control placement is parsed
    // from its own form fields and stored under
    // capabilities.player_controls_position (always emitted — 'default'
    // overwrites any stale custom config that a previous save left behind,
    // because the update path MERGES capabilities with the existing row).
    capabilities: withPlayerControlsPosition(
      stripSandboxPolicy(jsonObject(form.get('capabilities'), 'Capabilities')),
      playerControlsPositionCapability(form),
    ),
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

/**
 * Category create/update form. 2026-10-16 round: options.forUpdate makes
 * the ordering key OPTIONAL on the edit path (omitted from the payload when
 * the form no longer submits it — the authoritative ordering workflow is
 * the dedicated bulk-reposition editor, so an unrelated category save can
 * never clobber the saved ordering).
 */
export function parseCategoryForm(form: FormData, options: { forUpdate?: boolean } = {}) {
  const orderingRaw = form.get('ordering');
  return {
    name: requiredText(form.get('name'), 'Category name', 120),
    slug: validateSlug(requiredText(form.get('slug'), 'Category slug', 120), 'Category slug'),
    description: text(form.get('description'), 'Description', 500),
    enabled: booleanValue(form.get('enabled'), true),
    ordering: (options.forUpdate === true && orderingRaw === null) ? undefined : nonNegativeInteger(orderingRaw, 'Ordering'),
  };
}

export function parseId(form: FormData, label: string): string {
  const id = requiredText(form.get('id'), label, 80);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new StreamingValidationError(`${label} is invalid.`);
  return id;
}

/**
 * 2026-10-16 round (Issue 5): parse a BULK REORDER payload — the COMPLETE
 * intended order of one list submitted as a repeated form field
 * (`ordered_source_ids`), first entry = position 1. Every entry must be a
 * UUID; the SERVICE layer validates completeness against the database's
 * actual rows (this parser only checks shapes) and persists atomically.
 */
export function parseBulkOrderedIds(form: FormData, field: string, label: string): string[] {
  const ids: string[] = [];
  for (const value of form.getAll(field)) {
    const id = String(value ?? '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new StreamingValidationError(`${label} contains an invalid identifier.`);
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) throw new StreamingValidationError(`${label} contains a duplicate entry.`);
  return ids;
}

/**
 * 2026-10-16 round (Issue 5): parse a BULK ORDERING payload —
 * `<prefix>_<uuid>` repeated fields carrying the intended position for
 * EVERY row of a global list (e.g. `ordering_<category_id>`). Values are
 * non-negative integers (global orderings permit gaps); the SERVICE layer
 * validates completeness + duplicate orderings against the database's
 * actual rows before any write.
 */
export function parseBulkOrderings(form: FormData, fieldPrefix: string, label: string): Array<{ id: string; ordering: number }> {
  const positions: Array<{ id: string; ordering: number }> = [];
  const seen = new Set<string>();
  for (const [key, value] of form.entries()) {
    if (!key.startsWith(fieldPrefix)) continue;
    const id = key.slice(fieldPrefix.length);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new StreamingValidationError(`${label} is invalid.`);
    if (seen.has(id)) throw new StreamingValidationError(`${label} has more than one ordering value.`);
    seen.add(id);
    positions.push({ id, ordering: nonNegativeInteger(value, 'Ordering') });
  }
  if (!positions.length) throw new StreamingValidationError(`${label} reposition payload is empty.`);
  return positions;
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

/**
 * FINDING-017 fix: parse + validate the provider icon field as a URL.
 * Returns the validated URL string, or null if the field is empty.
 * @throws StreamingValidationError if the URL is non-empty but invalid.
 */
function parseProviderIconField(value: FormDataEntryValue | null): string | null {
  try {
    return validateIconUrl(value as string);
  } catch (err) {
    if (err instanceof IconValidationError) {
      throw new StreamingValidationError(err.message);
    }
    throw new StreamingValidationError('Provider icon URL is invalid.');
  }
}
