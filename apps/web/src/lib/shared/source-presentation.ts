/**
 * Task 13: source PRESENTATION metadata — user-facing badge + icon key.
 *
 * Single source of truth shared by the admin registry UI, the server-side
 * form validation, the public streaming config projection and the player
 * source selector.
 *
 * Security contract:
 *   * A badge is a CONSTRAINED enum value ('ads' | 'ad-free') — never
 *     HTML, CSS, color values or arbitrary markup. The database enforces
 *     the same enum via a CHECK constraint.
 *   * An icon is a SAFE KEY from a fixed allowlist — never SVG/HTML. The
 *     database enforces the key FORMAT, this module defines the allowlist,
 *     and rendering maps the key to a real component with a guaranteed
 *     fallback (see SourceIcon.svelte). No value from the database is ever
 *     executed or injected as markup.
 */

/** Constrained user-facing badge values (matches the DB CHECK constraint). */
export const sourceBadges = ['ads', 'ad-free'] as const;
export type SourceBadge = (typeof sourceBadges)[number];

/** Display labels — the ONLY text ever rendered for a badge. */
export const sourceBadgeLabels: Record<SourceBadge, string> = {
  ads: 'Ads',
  'ad-free': 'Ad-free',
};

/** Type guard for untrusted badge values (DB rows, form input). */
export function isSourceBadge(value: unknown): value is SourceBadge {
  return value === 'ads' || value === 'ad-free';
}

/** Safe label lookup — unknown values never render a badge. */
export function sourceBadgeLabel(badge: SourceBadge): string {
  return sourceBadgeLabels[badge];
}

/**
 * Guarded label lookup for RAW database rows (`badge` is typed
 * `string | null` there). Returns the display label only when the value is
 * one of the constrained badge values — anything else (legacy, tampered)
 * renders no badge.
 */
export function sourceBadgeLabelFor(value: string | null | undefined): string | null {
  return isSourceBadge(value) ? sourceBadgeLabels[value] : null;
}

/**
 * Safe icon keys. The list is the application allowlist; keys map to real
 * lucide-svelte components inside SourceIcon.svelte (the rendering-side
 * registry). Keys use the package's kebab-case icon names.
 */
export const sourceIconKeys = [
  'video',
  'play',
  'film',
  'tv',
  'clapperboard',
  'radio',
  'layers',
  'server',
  'monitor-play',
  'globe',
  'satellite-dish',
  'zap',
] as const;
export type SourceIconKey = (typeof sourceIconKeys)[number];

/** Default icon for sources without a configured (or with an invalid) key. */
export const DEFAULT_SOURCE_ICON: SourceIconKey = 'video';

/** Human-readable labels for the admin icon picker. */
export const sourceIconLabels: Record<SourceIconKey, string> = {
  video: 'Video',
  play: 'Play',
  film: 'Film',
  tv: 'TV',
  clapperboard: 'Clapperboard',
  radio: 'Radio',
  layers: 'Layers',
  server: 'Server',
  'monitor-play': 'Monitor',
  globe: 'Globe',
  'satellite-dish': 'Satellite',
  zap: 'Bolt',
};

/** Type guard for untrusted icon keys. */
export function isSourceIconKey(value: unknown): value is SourceIconKey {
  return typeof value === 'string' && (sourceIconKeys as readonly string[]).includes(value);
}

/**
 * Rendering-side resolver: any configured value that is not a known key
 * (null, legacy, tampered) falls back to the default icon. Rendering can
 * therefore NEVER produce a broken/blank icon state.
 */
export function resolveSourceIcon(value: string | null | undefined): SourceIconKey {
  return isSourceIconKey(value) ? value : DEFAULT_SOURCE_ICON;
}

// ---------------------------------------------------------------------------
// MAVP-4 Issue 4: EXTENSIBLE BADGES + RICH SOURCE ICONS.
//
// Badge contract (backward compatible):
//   * The DB column stays `streaming_sources.badge text`. THREE accepted
//     stored shapes:
//       1. null / empty                 → no badges.
//       2. legacy enum string           → 'ads' | 'ad-free' (Task 13 values,
//          mapped to the equivalent single-badge config list).
//       3. canonical JSON array         → [{"id","label","variant"}, ...]
//          (bounded, validated — see BOUND_* below).
//   * Badge definitions are PER-SOURCE COPIES (id + label + variant inline):
//     the Admin editor harvests previously used definitions from existing
//     rows for reuse, and creating/renaming/deleting a badge on one source
//     can never corrupt another source's configuration.
//   * Rendering NEVER trusts the raw stored value: every consumer parses
//     through `parseSourceBadges` (total, capped, sanitized labels rendered
//     as text — never markup).
//
// Icon contract (backward compatible):
//   * The DB column stays `streaming_sources.icon text`. Accepted shapes:
//       1. legacy safe key              → lucide allowlist (Task 13 values).
//       2. data:image/png;base64,…      → uploaded PNG (bounded, validated).
//       3. data:image/svg+xml;base64,…  → SANITIZED pasted SVG (the server
//          sanitizes before saving — scripts/handlers/external refs are
//          rejected at the boundary).
//       4. http(s)://… image URL        → remote PNG/SVG (validated by the
//          established icon-url.ts contract).
//   * Rendering goes through SourceIcon.svelte: keys → lucide components,
//     data/URL icons → <img> (script-inert by specification — untrusted SVG
//     markup is never injected via {@html}).
// ---------------------------------------------------------------------------

/** Controlled badge style variants (theme-token mapped at the render sites). */
export const sourceBadgeVariants = ['accent', 'positive', 'warning', 'neutral'] as const;
export type SourceBadgeVariant = (typeof sourceBadgeVariants)[number];

/** One badge configuration (per-source copy). */
export type SourceBadgeConfig = {
  /** Stable id (slug-like) — reuse/dedupe key in the Admin editor. */
  id: string;
  /** Display label — the ONLY text ever rendered (inert text node). */
  label: string;
  /** Controlled visual style. */
  variant: SourceBadgeVariant;
};

/** Hard bounds enforced by the strict parser and mirrored by the DB migration. */
export const SOURCE_BADGES_MAX_COUNT = 3;
export const SOURCE_BADGE_LABEL_MAX_LENGTH = 24;
export const SOURCE_BADGE_ID_MAX_LENGTH = 32;
/** Serialized badges JSON length bound (mirrored by the DB CHECK). */
export const SOURCE_BADGES_JSON_MAX_LENGTH = 1000;

const BADGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Built-in badge definitions (always available in the Admin picker). */
export const BUILTIN_SOURCE_BADGES: readonly SourceBadgeConfig[] = [
  { id: 'ad-free', label: 'Ad-Free', variant: 'positive' },
  { id: 'ads', label: 'Ads', variant: 'warning' },
  { id: '4k', label: '4K', variant: 'accent' },
];

/** Legacy Task 13 single-value enum → the equivalent config list. */
const LEGACY_BADGE_CONFIGS: Record<SourceBadge, SourceBadgeConfig> = {
  ads: { id: 'ads', label: 'Ads', variant: 'warning' },
  'ad-free': { id: 'ad-free', label: 'Ad-Free', variant: 'positive' },
};

/** Validation failure for the STRICT badge parser (server-side form/API gate). */
export class SourceBadgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceBadgeValidationError';
  }
}

function isSourceBadgeVariant(value: unknown): value is SourceBadgeVariant {
  return typeof value === 'string' && (sourceBadgeVariants as readonly string[]).includes(value);
}

/** Parse ONE badge object from untrusted JSON data; null when invalid. */
function parseBadgeConfig(value: unknown): SourceBadgeConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const label = typeof record.label === 'string' ? record.label.trim() : '';
  if (!id || id.length > SOURCE_BADGE_ID_MAX_LENGTH || !BADGE_ID_PATTERN.test(id)) return null;
  if (!label || label.length > SOURCE_BADGE_LABEL_MAX_LENGTH) return null;
  // Labels are rendered as INERT text nodes — but markup-like content is
  // rejected outright (never stored, never rendered) so no consumer can
  // ever turn a label into HTML.
  if (/[<>\u0000-\u001f]/.test(label)) return null;
  if (!isSourceBadgeVariant(record.variant)) return null;
  return { id, label, variant: record.variant };
}

/**
 * TOTAL badges parser for untrusted stored values (DB rows, public config).
 * Accepts null | legacy enum | JSON array; returns at most
 * SOURCE_BADGES_MAX_COUNT sanitized configs with duplicate ids removed.
 * NEVER throws — an invalid value simply renders no badges (safe fallback).
 */
export function parseSourceBadges(rawValue: unknown): SourceBadgeConfig[] {
  if (rawValue === null || rawValue === undefined) return [];
  const normalized = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!normalized) return [];
  // Legacy Task 13 single-value shape.
  if (isSourceBadge(normalized)) return [LEGACY_BADGE_CONFIGS[normalized]];
  // Canonical JSON array shape (bounded input length guards the parser).
  if (!normalized.startsWith('[') || normalized.length > SOURCE_BADGES_JSON_MAX_LENGTH) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const badges: SourceBadgeConfig[] = [];
  for (const entry of parsed) {
    const config = parseBadgeConfig(entry);
    if (!config || seen.has(config.id)) continue;
    seen.add(config.id);
    badges.push(config);
    if (badges.length >= SOURCE_BADGES_MAX_COUNT) break;
  }
  return badges;
}

/**
 * STRICT badges parser for ADMIN input (server validation gate). Same
 * accepted shapes as `parseSourceBadges` but REJECTS invalid values with a
 * `SourceBadgeValidationError` (admins get an explicit error instead of a
 * silently dropped badge). Duplicate ids are rejected, the count cap is
 * enforced, and the result is canonicalized (trimmed labels/ids).
 */
export function parseSourceBadgesStrict(rawValue: string | null | undefined): SourceBadgeConfig[] {
  const normalized = String(rawValue ?? '').trim();
  if (!normalized || normalized === 'none') return [];
  if (isSourceBadge(normalized)) return [LEGACY_BADGE_CONFIGS[normalized]];
  if (!normalized.startsWith('[')) throw new SourceBadgeValidationError('Source badges payload is invalid.');
  if (normalized.length > SOURCE_BADGES_JSON_MAX_LENGTH) throw new SourceBadgeValidationError(`Source badges payload must be ${SOURCE_BADGES_JSON_MAX_LENGTH} characters or fewer.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new SourceBadgeValidationError('Source badges payload is invalid JSON.');
  }
  if (!Array.isArray(parsed)) throw new SourceBadgeValidationError('Source badges payload must be a JSON array.');
  if (parsed.length > SOURCE_BADGES_MAX_COUNT) throw new SourceBadgeValidationError(`A source can carry at most ${SOURCE_BADGES_MAX_COUNT} badges.`);
  const seen = new Set<string>();
  const badges: SourceBadgeConfig[] = [];
  for (const entry of parsed) {
    const config = parseBadgeConfig(entry);
    if (!config) throw new SourceBadgeValidationError(`Badge ${badges.length + 1} is invalid: id must be kebab-case (≤${SOURCE_BADGE_ID_MAX_LENGTH} chars), label 1–${SOURCE_BADGE_LABEL_MAX_LENGTH} chars, and the variant must be one of: ${sourceBadgeVariants.join(', ')}.`);
    if (seen.has(config.id)) throw new SourceBadgeValidationError(`Duplicate badge id "${config.id}".`);
    seen.add(config.id);
    badges.push(config);
  }
  return badges;
}

/** Canonical serialized form for validated badge configs (the stored shape). */
export function serializeSourceBadges(badges: readonly SourceBadgeConfig[]): string {
  return JSON.stringify(badges.map((badge) => ({ id: badge.id, label: badge.label, variant: badge.variant })));
}

// ----- MAVP-4: rich icon values ---------------------------------------------

/** Bounded data-URL budgets (mirrored by the DB CHECK constraints). */
export const SOURCE_ICON_DATA_URL_MAX_LENGTH = 100_000;
/** The established URL bound (icon-url.ts) applies to remote icon URLs. */
export const SOURCE_ICON_REMOTE_URL_MAX_LENGTH = 500;

const DATA_URL_PATTERN = /^data:image\/(png|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/;
const REMOTE_URL_PATTERN = /^https?:\/\//;

/** The accepted stored icon kinds (after server validation). */
export type SourceIconValueKind = 'key' | 'png-data' | 'svg-data' | 'remote-url';

/**
 * Classify an untrusted stored icon value. TOTAL — never throws; unknown
 * values are 'key' kind and fall back to the default icon at render time
 * (the same Task 13 fallback contract).
 */
export function classifySourceIconValue(value: string | null | undefined): SourceIconValueKind {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return 'key';
  if (isSourceIconKey(normalized)) return 'key';
  const dataMatch = DATA_URL_PATTERN.exec(normalized);
  if (dataMatch) return dataMatch[1] === 'png' ? 'png-data' : 'svg-data';
  if (REMOTE_URL_PATTERN.test(normalized) && normalized.length <= SOURCE_ICON_REMOTE_URL_MAX_LENGTH) return 'remote-url';
  return 'key';
}

/** True when the icon value renders as an <img> (data URL / remote URL). */
export function isImageSourceIcon(value: string | null | undefined): boolean {
  const kind = classifySourceIconValue(value);
  return kind === 'png-data' || kind === 'svg-data' || kind === 'remote-url';
}
