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
 *   },
 *   "sizes": { "back": 44, "landscape": 48 }   // MAVP-3 — optional, integers, px
 * }
 *
 * MAVP-6 (Issues 2+3) — the EPISODES CHIP IS NO LONGER POSITIONABLE:
 * the previously-optional `episodes` section and `sizes.episodes` entry are
 * REMOVED from the contract. The source chip (right edge) is intentionally
 * NOT per-source positionable — it is anchored to the vertical centre by
 * the player stylesheet — and the episode chip (left edge) now follows the
 * SAME fixed rule (left edge, vertical centre, identical 64px hit area), so
 * the two edge chips are vertically aligned BY CONSTRUCTION in both
 * orientations and for every source. A stored configuration that still
 * carries `episodes` / `sizes.episodes` keys (a pre-MAVP-6 save) stays
 * fully parseable: the total parser below ignores unknown keys (the
 * established reader convention), so legacy values are silently dropped
 * and can never move the chip or break playback/source editing. The
 * position editor for the chip was removed from the Admin source editor in
 * the same change; the runtime consumes no per-source episode-chip
 * placement at all.
 *
 * Size contract (MAVP-3): `sizes` carries an INDEPENDENT size per control
 * (Back button, Landscape button) in CSS pixels, orientation-independent
 * (the task specifies exactly one size setting per control per source).
 * Bounds [CONTROLS_SIZE_MIN_PX .. CONTROLS_SIZE_MAX_PX] prevent invisible,
 * unusably small, or viewport-dominating controls. A null/absent entry (or
 * a config without the `sizes` key at all) keeps the control's DEFAULT
 * stylesheet size — existing sources and legacy configurations are
 * byte-compatible. Sizes are fully independent of the placement axes:
 * changing a size never mutates any anchor/offset and vice versa, and the
 * two controls' sizes never affect each other.
 *
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

// ----- MAVP-3 size contract -------------------------------------------------
// Defaults mirror the player stylesheet EXACTLY (.back-fab 44px,
// .control-fab 48px) so a source without custom sizing renders identically
// to the pre-MAVP-3 design. Bounds keep controls visible, usable and never
// viewport-dominating (documented safe range; enforced server-side too).
export const BACK_CONTROL_DEFAULT_SIZE_PX = 44;
export const LANDSCAPE_CONTROL_DEFAULT_SIZE_PX = 48;
export const CONTROLS_SIZE_MIN_PX = 28;
export const CONTROLS_SIZE_MAX_PX = 96;

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
  // MAVP-6 (Issues 2+3): the episode chip is NOT per-source positionable
  // (fixed left edge + vertical centre, mirroring the source chip) — the
  // former `episodes` section and `sizes.episodes` entry are removed; legacy
  // stored values are ignored by the total parser (unknown keys dropped).
  /** MAVP-3: independent per-control size overrides in px (optional).
   *  null entry / absent section = the control's default stylesheet size. */
  sizes: { back: number | null; landscape: number | null } | null;
};

/** The floating controls that can be positioned per source. */
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
 * MAVP-6 (Issues 2+3): the former MAVP-5 `episodes` section parser was
 * REMOVED together with the contract — a legacy `episodes` key in a stored
 * config is an unknown key and is dropped by the total parser (the
 * established reader convention), never by a special-cased branch.
 */
/**
 * MAVP-3: TOTAL per-control size parse. Only finite integers within the
 * documented bounds are accepted; anything else (absent, null, wrong type,
 * non-finite, out of bounds) degrades to null = the control's default size.
 * Values are normalised to integers (px).
 */
function parseControlSize(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < CONTROLS_SIZE_MIN_PX || rounded > CONTROLS_SIZE_MAX_PX) return null;
  return rounded;
}

/**
 * MAVP-3: the `sizes` section — independent per-control sizes. Returns null
 * when the section is absent, not an object, or carries no usable value
 * (legacy configs and sizes-less custom configs keep `sizes: null`).
 * MAVP-6 (Issues 2+3): a legacy `sizes.episodes` entry is IGNORED (dropped) —
 * the episode chip is no longer per-source sizeable (fixed 64px, matching
 * the source chip).
 */
function parseSizesSection(value: unknown): PlayerControlsPosition['sizes'] {
  if (!isRecord(value)) return null;
  const back = parseControlSize(value.back);
  const landscape = parseControlSize(value.landscape);
  if (back === null && landscape === null) return null;
  return { back, landscape };
}

/**
 * Parse the raw capability value. Returns null when absent or malformed —
 * the caller MUST fall back to the default (bottom-right) positioning.
 */
export function parsePlayerControlsPosition(value: unknown): PlayerControlsPosition | null {
  if (!isRecord(value)) return null;
  const mode = value.mode;
  if (mode === 'default') {
    return { mode: 'default', horizontal: null, vertical: null, portrait: null, landscape: null, back: null, sizes: null };
  }
  if (mode !== 'custom') return null;
  const position: PlayerControlsPosition = {
    mode: 'custom',
    horizontal: value.horizontal === undefined ? null : parseHorizontalAxis(value.horizontal),
    vertical: value.vertical === undefined ? null : parseVerticalAxis(value.vertical),
    portrait: value.portrait === undefined ? null : parseOrientationOverride(value.portrait),
    landscape: value.landscape === undefined ? null : parseOrientationOverride(value.landscape),
    back: value.back === undefined ? null : parseBackSection(value.back),
    // MAVP-6 (Issues 2+3): a legacy `episodes` section is an unknown key —
    // dropped by construction (never parsed, never consumed by the runtime).
    sizes: value.sizes === undefined ? null : parseSizesSection(value.sizes),
  };
  // A custom config with NO usable axis and NO usable size is treated as
  // malformed — the admin most likely saved a half-empty config; default
  // positioning/sizing is safer. A sizes-only config is VALID (the admin may
  // only want to resize the controls without moving them).
  if (
    !position.horizontal && !position.vertical
    && !hasUsableAxis(position.portrait) && !hasUsableAxis(position.landscape)
    && !hasUsableAxis(position.back?.portrait ?? null) && !hasUsableAxis(position.back?.landscape ?? null)
    && !position.sizes
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
  // MAVP-6 (Issues 2+3): the 'episodes' control no longer exists in this
  // contract — the episode chip is fixed by the player stylesheet (left
  // edge, vertical centre, mirroring the source chip).
  const override = orientation === 'portrait' ? position.portrait : position.landscape;
  return {
    horizontal: override?.horizontal ?? position.horizontal,
    vertical: override?.vertical ?? position.vertical,
  };
}

/**
 * MAVP-3: resolve a control's configured size for a source. Returns null
 * when the source has no custom size for that control (the caller keeps the
 * control's default stylesheet size). Pure — never mutates the config.
 */
export function resolveControlSize(
  position: PlayerControlsPosition | null,
  control: ControlsControlId,
): number | null {
  if (!position || position.mode !== 'custom') return null;
  return position.sizes?.[control] ?? null;
}

/**
 * MAVP-3: build the inline CSS for a control's configured size. Emits a
 * single CSS custom property declaration (e.g. `--back-fab-size: 56px`)
 * consumed by the player stylesheet; empty string when the control keeps
 * its default size — placement styles and size styles never overlap keys.
 */
export function controlsSizeInlineStyle(
  position: PlayerControlsPosition | null,
  control: ControlsControlId,
  cssVariable: string,
): string {
  const size = resolveControlSize(position, control);
  return size === null ? '' : `${cssVariable}:${size}px`;
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

// ---------------------------------------------------------------------------
// MAVP-4 Issue 3: SHARED preview geometry.
//
// The Admin calibration preview must interpret a configuration EXACTLY like
// the real player. The runtime resolves placements through
// `resolveControlPlacement` + `resolveControlSize` (above); the preview now
// runs the SAME resolvers over the SAME payload shape (the serialized
// `controls_position_json`, parsed by the total `parsePlayerControlsPosition`)
// and maps the result onto a SCALED stage with a documented, deterministic
// coordinate model:
//
//   * Reference viewports — the preview models a concrete runtime viewport
//     per orientation (portrait 390×844, landscape 844×390). The stage keeps
//     the SAME aspect ratio, so viewport-relative percentages map 1:1.
//   * Percent axes — configured anchors/offsets are viewport-relative
//     percentages at runtime; on the stage they are the same percentages of
//     the stage box (uniform scale — no preview-pixel/runtime-pixel mixing).
//   * Unset axes — the runtime keeps the stylesheet default corner
//     (Back = top-left at 12px, Landscape = bottom-right at 16px, both
//     safe-area aware). The preview renders those defaults scaled by
//     container-query units (cqw/cqh) so they shrink/grow with the stage.
//   * Sizes — a configured px size renders as (size / reference width) ×
//     100cqw; the default size when unset. Both orientations scale the SAME
//     way (the stage height factor equals its width factor because the stage
//     keeps the reference aspect ratio).
//
// Device safe-area insets (env(safe-area-inset-*)) are device-specific and
// deliberately NOT represented — the preview shows the no-inset default
// corner; the runtime shifts it by the device's real insets.
// ---------------------------------------------------------------------------

/** Documented reference viewport the portrait preview models. */
export const CONTROLS_PREVIEW_REFERENCE_PORTRAIT = { width: 390, height: 844 } as const;
/** Documented reference viewport the landscape preview models. */
export const CONTROLS_PREVIEW_REFERENCE_LANDSCAPE = { width: 844, height: 390 } as const;

/**
 * Runtime stylesheet default corner offsets (px), mirrored here so the
 * preview renders the same defaults the player stylesheet paints
 * (.back-fab top/left 12px; .control-fab-group bottom/right 16px).
 */
export const BACK_CONTROL_DEFAULT_EDGE_PX = 12;
export const LANDSCAPE_CONTROL_DEFAULT_EDGE_PX = 16;

/** Runtime stylesheet default sizes (px) — the same values the renderer uses. */
function defaultSizeFor(control: ControlsControlId): number {
  return control === 'back' ? BACK_CONTROL_DEFAULT_SIZE_PX : LANDSCAPE_CONTROL_DEFAULT_SIZE_PX;
}

/**
 * Build the inline CSS for ONE preview marker (Back square / Landscape dot)
 * from the shared resolvers. Pure — the preview component only supplies the
 * parsed configuration and the orientation; every decision (inheritance,
 * defaults, sizes, scaling) happens here so the preview can never diverge
 * from the runtime interpretation.
 */
export function controlsPreviewMarkerStyle(
  position: PlayerControlsPosition | null,
  control: ControlsControlId,
  orientation: ControlsOrientation,
): string {
  const reference = orientation === 'portrait' ? CONTROLS_PREVIEW_REFERENCE_PORTRAIT : CONTROLS_PREVIEW_REFERENCE_LANDSCAPE;
  const placement = resolveControlPlacement(position, control, orientation);
  const sizePx = resolveControlSize(position, control) ?? defaultSizeFor(control);
  const defaultEdge = control === 'back' ? BACK_CONTROL_DEFAULT_EDGE_PX : LANDSCAPE_CONTROL_DEFAULT_EDGE_PX;
  const decls: string[] = [];
  const transforms: string[] = [];
  // Horizontal axis: configured anchor wins; null → the control's default
  // corner edge (Back hugs the left, Landscape hugs the right), scaled.
  if (placement.horizontal) {
    if (placement.horizontal.anchor === 'center') {
      decls.push('left:50%', 'right:auto');
      transforms.push('translateX(-50%)');
    } else if (placement.horizontal.anchor === 'left') {
      decls.push(`left:${placement.horizontal.offsetPercent}%`, 'right:auto');
    } else {
      decls.push(`right:${placement.horizontal.offsetPercent}%`, 'left:auto');
    }
  } else if (control === 'landscape') {
    decls.push(`right:${cqw(defaultEdge, reference.width)}`, 'left:auto');
  } else {
    // 'back' defaults to the left edge.
    decls.push(`left:${cqw(defaultEdge, reference.width)}`, 'right:auto');
  }
  // Vertical axis: same contract (Back defaults to the top edge, Landscape
  // to the bottom edge); vertical scale uses cqh against the reference height.
  if (placement.vertical) {
    if (placement.vertical.anchor === 'center') {
      decls.push('top:50%', 'bottom:auto');
      transforms.push('translateY(-50%)');
    } else if (placement.vertical.anchor === 'top') {
      decls.push(`top:${placement.vertical.offsetPercent}%`, 'bottom:auto');
    } else {
      decls.push(`bottom:${placement.vertical.offsetPercent}%`, 'top:auto');
    }
  } else if (control === 'back') {
    decls.push(`top:${cqh(BACK_CONTROL_DEFAULT_EDGE_PX, reference.height)}`, 'bottom:auto');
  } else {
    decls.push(`bottom:${cqh(LANDSCAPE_CONTROL_DEFAULT_EDGE_PX, reference.height)}`, 'top:auto');
  }
  // Configured (or default) control size, scaled uniformly by the reference
  // width (the stage's height factor is identical — same aspect ratio).
  const scaled = cqw(sizePx, reference.width);
  decls.push(`width:${scaled}`, `height:${scaled}`);
  if (transforms.length) decls.push(`transform:${transforms.join(' ')}`);
  return decls.join(';');
}

/** px → container-query width units at a given reference viewport width. */
function cqw(px: number, referenceWidth: number): string {
  return `calc(${px} / ${referenceWidth} * 100cqw)`;
}

/** px → container-query height units at a given reference viewport height. */
function cqh(px: number, referenceHeight: number): string {
  return `calc(${px} / ${referenceHeight} * 100cqh)`;
}
