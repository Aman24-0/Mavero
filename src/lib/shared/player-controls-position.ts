/**
 * Per-source landscape-control positioning — MAVERO player redesign.
 *
 * The Admin Panel ("Player Controls Position" section of the source edit
 * sheet) persists a validated positioning config per SOURCE inside the
 * existing `streaming_sources.capabilities` JSONB under the
 * `player_controls_position` key. No schema change: the public streaming
 * config already exposes source capabilities verbatim.
 *
 * Shape (all numeric bounds enforced — 0..100 viewport-relative percent):
 * {
 *   "mode": "custom",
 *   "horizontal": { "anchor": "right", "offsetPercent": 18 },
 *   "vertical":   { "anchor": "bottom", "offsetPercent": 12 },
 *   "portrait":   { "horizontal": {...}, "vertical": {...} },   // optional
 *   "landscape":  { "horizontal": {...}, "vertical": {...} }    // optional
 * }
 *
 * Every parser is TOTAL: malformed, non-finite, out-of-bounds or wrongly
 * typed values return null (the caller falls back to the default position).
 * Legacy sources without the key are default-positioned (bottom-right).
 * Parsing is pure — source A's config can never leak into source B.
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
};

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

function parseOrientationOverride(value: unknown): { horizontal: ControlsAxisPosition | null; vertical: ControlsAxisPosition | null } | null {
  if (!isRecord(value)) return null;
  return {
    horizontal: value.horizontal === undefined ? null : parseHorizontalAxis(value.horizontal),
    vertical: value.vertical === undefined ? null : parseVerticalAxis(value.vertical),
  };
}

/**
 * Parse the raw capability value. Returns null when absent or malformed —
 * the caller MUST fall back to the default (bottom-right) positioning.
 */
export function parsePlayerControlsPosition(value: unknown): PlayerControlsPosition | null {
  if (!isRecord(value)) return null;
  const mode = value.mode;
  if (mode === 'default') {
    return { mode: 'default', horizontal: null, vertical: null, portrait: null, landscape: null };
  }
  if (mode !== 'custom') return null;
  const position: PlayerControlsPosition = {
    mode: 'custom',
    horizontal: value.horizontal === undefined ? null : parseHorizontalAxis(value.horizontal),
    vertical: value.vertical === undefined ? null : parseVerticalAxis(value.vertical),
    portrait: value.portrait === undefined ? null : parseOrientationOverride(value.portrait),
    landscape: value.landscape === undefined ? null : parseOrientationOverride(value.landscape),
  };
  // A custom config with NO usable axis is treated as malformed — the admin
  // most likely saved a half-empty config; default positioning is safer.
  if (!position.horizontal && !position.vertical && !position.portrait && !position.landscape) return null;
  return position;
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
 * Resolve the placement for a given orientation, honouring the optional
 * portrait/landscape overrides. Pure — same inputs always yield the same
 * placement for the same source.
 */
export function resolveLandscapeControlPlacement(
  position: PlayerControlsPosition | null,
  orientation: 'portrait' | 'landscape',
): LandscapeControlPlacement {
  if (!position || position.mode !== 'custom') {
    return { horizontal: null, vertical: null };
  }
  const override = orientation === 'portrait' ? position.portrait : position.landscape;
  return {
    horizontal: override?.horizontal ?? position.horizontal,
    vertical: override?.vertical ?? position.vertical,
  };
}

/**
 * Build the inline CSS for the Landscape control group given a resolved
 * placement. Null axes mean "keep the stylesheet default" (bottom-right,
 * safe-area aware) — the returned string is empty in that case. Center
 * anchors translate the group by -50% on that axis so `50%` centres it.
 * Percentages are viewport-relative and bounded (validated 0..100).
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
