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
