/**
 * Per-source floating-control positioning — MAVERO player redesign.
 *
 * The Admin Panel ("Player Controls Position" section of the source edit
 * sheet) persists a validated positioning config per SOURCE inside the
 * existing `streaming_sources.capabilities` JSONB under the
 * `player_controls_position` key. No schema change: the public streaming
 * config already exposes source capabilities verbatim.
 *
 * POSITIONING CONTRACT (MAVP-2 — shared by the Admin UI, server validation,
 * persistence and the player renderer):
 *
 *   axis            = { "anchor": <H|V anchor>, "offsetPercent": 0..100 }
 *   H anchor        = 'left' | 'right' | 'center'
 *   V anchor        = 'top' | 'bottom' | 'center'
 *   orientation     = 'portrait' | 'landscape'   (real viewport orientation)
 *   control         = 'landscape' (Landscape/fullscreen FAB group)
 *                   | 'back'      (Back FAB)
 *
 * Stored capability value:
 * {
 *   "mode": "custom",
 *   // Landscape control — LEGACY base axes + orientation overrides.
 *   // Kept for backward compatibility: sources saved before MAVP-2 carry
 *   // these, and the renderer still honours them as the base that a
 *   // missing orientation override inherits.
 *   "horizontal": { "anchor": "right", "offsetPercent": 18 },   // optional
 *   "vertical":   { "anchor": "bottom", "offsetPercent": 12 },  // optional
 *   "portrait":   { "horizontal": axis|null, "vertical": axis|null },  // optional
 *   "landscape":  { "horizontal": axis|null, "vertical": axis|null },  // optional
 *   // Back control — MAVP-2, fully independent from the Landscape control.
 *   "back": {
 *     "portrait":  { "horizontal": axis|null, "vertical": axis|null },  // optional
 *     "landscape": { "horizontal": axis|null, "vertical": axis|null }   // optional
 *   }
 * }
 *
 * Coordinate convention: offsets are VIEWPORT-RELATIVE PERCENTAGES measured
 * FROM THE ANCHOR EDGE TOWARD THE VIEWPORT INTERIOR. anchor right + offset
 * 18 => `right: 18%` (18% of the viewport width away from the right edge);
 * anchor top + offset 8 => `top: 8%`. Center anchors ignore the offset and
 * translate the control by -50% on that axis. Horizontal and vertical axes
 * are fully INDEPENDENT objects — changing one can never mutate the other,
 * and per-orientation profiles are separate objects, so a portrait
 * calibration can never leak into landscape or vice versa.
 *
 * Every parser is TOTAL: malformed, non-finite, out-of-bounds or wrongly
 * typed values return null (the caller falls back to the default position).
 * Legacy sources without the key are default-positioned (back = top-left,
 * landscape control = bottom-right). Parsing is pure — source A's config
 * can never leak into source B.
 */

export const PLAYER_CONTROLS_POSITION_CAPABILITY_KEY = 'player_controls_position';

export type ControlsPositionAnchor = 'left' | 'right' | 'top' | 'bottom' | 'center';

export type ControlsAxisPosition = {
  anchor: ControlsAnchor;
  offsetPercent: number;
};

/** Horizontal anchors use left/right; vertical anchors use top/center/bottom. */
export type ControlsAnchor = 'left' | 'right' | 'top' | 'bottom' | 'center';

export type PlayerControlsPosition = {
  mode: 'default' | 'custom';
  horizontal: ControlsAxisPosition | null;
  vertical: ControlsAxisPosition | null;
  portrait: { horizontal: ControlsAxisPosition | null; vertical: ControlsAxisPosition | null } | null;
  landscape: { horizontal: ControlsAxisPosition | null; vertical: ControlsAxisPosition | null } | null;
  /** MAVP-2: independent per-orientation Back-button profiles (optional). */
  back: {
    portrait: { horizontal: ControlsAxisPosition | null; vertical: ControlsAxisPosition | null } | null;
    landscape: { horizontal: ControlsAxisPosition | null; vertical: ControlsAxisPosition | null } | null;
  } | null;
};

/** The two floating controls that can be positioned per source. */
export type ControlsControlId = 'landscape' | 'back';

export type ControlsOrientation = 'portrait' | 'landscape';

export type ControlsOrientationOverride = { horizontal: ControlsAxisPosition | null; vertical: ControlsAxisPosition | null };

const HORIZONTAL_ANCHORS = ['left', 'right', 'center'] as const;
const VERTICAL_ANCHORS = ['top', 'bottom', 'center'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return value;
}

function parseHorizontalAxis(value: unknown): ControlsAxisPosition | null {
  if (!isRecord(value)) return null;
  const anchor = value.anchor;
  if (typeof anchor !== 'string' || !(HORIZONTAL_ANCHORS as readonly string[]).includes(anchor)) return null;
  const offsetPercent = value.offsetPercent === undefined ? (anchor === 'center' ? 50 : 0) : boundedPercent(value.offsetPercent);
  if (offsetPercent === null) return null;
  return { anchor: anchor as ControlsAnchor, offsetPercent };
}

function parseVerticalAxis(value: unknown): ControlsAxisPosition | null {
  if (!isRecord(value)) return null;
  const anchor = value.anchor;
  if (typeof anchor !== 'string' || !(VERTICAL_ANCHORS as readonly string[]).includes(anchor)) return null;
  const offsetPercent = value.offsetPercent === undefined ? (anchor === 'center' ? 50 : 0) : boundedPercent(value.offsetPercent);
  if (offsetPercent === null) return null;
  return { anchor: anchor as ControlsAnchor, offsetPercent };
}

function parseOrientationOverride(value: unknown): ControlsOrientationOverride | null {
  if (!isRecord(value)) return null;
  return {
    horizontal: value.horizontal === undefined ? null : parseHorizontalAxis(value.horizontal),
    vertical: value.vertical === undefined ? null : parseVerticalAxis(value.vertical),
  };
}

function parseBackSection(value: unknown): PlayerControlsPosition['back'] {
  if (!isRecord(value)) return null;
  const portrait = value.portrait === undefined ? null : parseOrientationOverride(value.portrait);
  const landscape = value.landscape === undefined ? null : parseOrientationOverride(value.landscape);
  // A back section with no usable axis is not a back config at all.
  if (!portrait && !landscape) return null;
  const hasAxis = (override: ControlsOrientationOverride | null): boolean =>
    Boolean(override && (override.horizontal || override.vertical));
  if (!hasAxis(portrait) && !hasAxis(landscape)) return null;
  return { portrait, landscape };
}

/**
 * Parse the raw capability value. Returns null when absent or malformed —
 * the caller MUST fall back to the default (bottom-right) positioning.
 */
export function parsePlayerControlsPosition(value: unknown): PlayerControlsPosition | null {
  if (!isRecord(value)) return null;
  const mode = value.mode;
  if (mode === 'default') {
    return { mode: 'default', horizontal: null, vertical: null, portrait: null, landscape: null, back: null };
  }
  if (mode !== 'custom') return null;
  const position: PlayerControlsPosition = {
    mode: 'custom',
    horizontal: value.horizontal === undefined ? null : parseHorizontalAxis(value.horizontal),
    vertical: value.vertical === undefined ? null : parseVerticalAxis(value.vertical),
    portrait: value.portrait === undefined ? null : parseOrientationOverride(value.portrait),
    landscape: value.landscape === undefined ? null : parseOrientationOverride(value.landscape),
    back: value.back === undefined ? null : parseBackSection(value.back),
  };
  // A custom config with NO usable axis is treated as malformed — the admin
  // most likely saved a half-empty config; default positioning is safer.
  if (
    !position.horizontal && !position.vertical
    && !hasUsableAxis(position.portrait) && !hasUsableAxis(position.landscape)
    && !hasUsableAxis(position.back?.portrait ?? null) && !hasUsableAxis(position.back?.landscape ?? null)
  ) return null;
  return position;
}

function hasUsableAxis(override: ControlsOrientationOverride | null): boolean {
  return Boolean(override && (override.horizontal || override.vertical));
}

/**
 * Extract the config from a raw source-capabilities object (the shape the
 * public streaming config carries for each source). Tolerates missing or
 * non-object capabilities.
 */
export function controlsPositionFromCapabilities(capabilities: unknown): PlayerControlsPosition | null {
  if (!isRecord(capabilities)) return null;
  return parsePlayerControlsPosition(capabilities[PLAYER_CONTROLS_POSITION_CAPABILITY_KEY]);
}

export type LandscapeControlPlacement = {
  /** CSS left/right percentage for the FAB centre (null = default right edge). */
  horizontal: ControlsAxisPosition | null;
  vertical: ControlsAxisPosition | null;
};

/**
 * Resolve the Landscape control's placement for a given orientation,
 * honouring the optional portrait/landscape overrides (which inherit the
 * legacy base axes per axis). Pure — same inputs always yield the same
 * placement for the same source.
 */
export function resolveLandscapeControlPlacement(
  position: PlayerControlsPosition | null,
  orientation: ControlsOrientation,
): LandscapeControlPlacement {
  return resolveControlPlacement(position, 'landscape', orientation);
}

/**
 * Resolve EITHER floating control's placement for a given orientation.
 *   'landscape' control → orientation override ?? legacy base ?? default.
 *   'back' control      → back[orientation] axes only (fully independent —
 *                         the Landscape control's config can never leak in).
 * Unset axes resolve to null → the caller keeps the stylesheet default
 * (back = top-left, landscape control = bottom-right, both safe-area aware).
 * Pure — same inputs always yield the same placement for the same source.
 */
export function resolveControlPlacement(
  position: PlayerControlsPosition | null,
  control: ControlsControlId,
  orientation: ControlsOrientation,
): LandscapeControlPlacement {
  if (!position || position.mode !== 'custom') {
    return { horizontal: null, vertical: null };
  }
  if (control === 'back') {
    const profile = orientation === 'portrait' ? position.back?.portrait : position.back?.landscape;
    return { horizontal: profile?.horizontal ?? null, vertical: profile?.vertical ?? null };
  }
  const override = orientation === 'portrait' ? position.portrait : position.landscape;
  return {
    horizontal: override?.horizontal ?? position.horizontal,
    vertical: override?.vertical ?? position.vertical,
  };
}

/**
 * Build the inline CSS for a floating control given a resolved placement.
 * Null axes mean "keep the stylesheet default" (back = top-left, landscape
 * control = bottom-right — both safe-area aware) — the returned string is
 * empty in that case. Center anchors translate the control by -50% on that
 * axis so `50%` centres it. Percentages are viewport-relative and bounded
 * (validated 0..100) per the positioning contract above.
 */
export function controlsPlacementInlineStyle(placement: LandscapeControlPlacement): string {
  return landscapeControlInlineStyle(placement);
}

/**
 * Legacy alias — the Landscape control was the only positioned control
 * before MAVP-2. Kept (and kept authoritative for existing callers/tests);
 * new call sites should use `controlsPlacementInlineStyle`.
 */
export function landscapeControlInlineStyle(placement: LandscapeControlPlacement): string {
  const decls: string[] = [];
  const transforms: string[] = [];
  if (placement.horizontal) {
    if (placement.horizontal.anchor === 'center') {
      decls.push('left:50%', 'right:auto');
      transforms.push('translateX(-50%)');
    } else if (placement.horizontal.anchor === 'left') {
      decls.push(`left:${placement.horizontal.offsetPercent}%`, 'right:auto');
    } else {
      decls.push(`right:${placement.horizontal.offsetPercent}%`, 'left:auto');
    }
  }
  if (placement.vertical) {
    if (placement.vertical.anchor === 'center') {
      decls.push('top:50%', 'bottom:auto');
      transforms.push('translateY(-50%)');
    } else if (placement.vertical.anchor === 'top') {
      decls.push(`top:${placement.vertical.offsetPercent}%`, 'bottom:auto');
    } else {
      decls.push(`bottom:${placement.vertical.offsetPercent}%`, 'top:auto');
    }
  }
  if (transforms.length) decls.push(`transform:${transforms.join(' ')}`);
  return decls.join(';');
}
