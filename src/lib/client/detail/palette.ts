// ============================================================================
// MAV-22 — Detail Page 3.0 dynamic artwork palette.
//
// The Detail Page must never sit on a fixed black background or on the
// global default accent: its backdrop palette is DERIVED from the current
// title's artwork (backdrop first, poster fallback, neutral cinematic
// fallback when nothing can be sampled).
//
// Contract (MAV-22 §3):
//   * CLIENT-SIDE extraction — a lightweight canvas sampler, no external
//     dependency. The color math below is pure and runs (and is tested)
//     in Node; only the sampling step touches browser APIs, and it is
//     guarded so importing this module on the server is safe.
//   * RESTRAINED dark variants — raw poster colors are never used as the
//     page background. The derived tones clamp saturation and pin
//     lightness to a deep cinematic band (L ≈ 6–12%) so primary and
//     secondary text keep high contrast on EVERY artwork.
//   * CORS — artwork CDNs may not send CORS headers (image.tmdb.org does
//     not). The sampler first tries the direct URL with crossOrigin
//     'anonymous' (works for CORS-enabled sources, e.g. fixture/QA
//     images), then falls back to the same-origin artwork proxy
//     (/api/content/artwork-proxy). Hosts that are known to refuse CORS
//     skip the doomed direct attempt.
//   * BOUNDED CACHE — palettes are keyed by the ACTUAL artwork URL
//     (never the title) and held in an LRU map (24 entries). Repeated
//     visits and back-navigation render the palette instantly.
//   * STALE-SAFE — DetailPaletteController sequences every request; a
//     late extraction for a previous title is discarded instead of
//     overwriting the current palette (rapid client-side navigation).
//   * SCOPED — the palette is consumed through CSS custom properties set
//     as an inline style on the DetailPage root element. Nothing here
//     mutates :root, the global accent, or any other route's state.
//   * NON-BLOCKING — extraction is async; the page renders immediately
//     with a neutral fallback and the artwork palette fades in when
//     ready (no layout shift — the palette layer is a fixed backdrop).
// ============================================================================

/** A derived, restrained palette for one artwork URL. */
export type DetailPalette = {
  /** The artwork URL this palette was derived from (cache identity). */
  key: string;
  /** Dominant hue in degrees (0–360). 210 for the neutral fallback. */
  hue: number;
  /** True when the artwork had no usable chroma (achromatic poster). */
  neutral: boolean;
  /** Page-deep tone (the dominant backdrop color, L ≈ 7%). */
  deep: string;
  /** Slightly lifted companion stop for the top of the gradient. */
  deepAlt: string;
  /** Deep tone pre-blended toward the global base (gradient fade stop). */
  fadeMid: string;
  /** Low-alpha card/surface tint (rgba) for lower content surfaces. */
  surface: string;
  /** Readable accent (L ≈ 60%) for borders, chips, links, focus rings. */
  accent: string;
  /** Soft accent fill (alpha .12). */
  accentSoft: string;
  /** Accent border (alpha .30). */
  accentBorder: string;
  /** Glow shadow color (alpha .22) for the primary action. */
  glow: string;
  /** Hue-matched dark scrim tint for the hero gradient (alpha .55). */
  scrim: string;
};

/** The global base color every detail gradient fades into (app bg). */
const BASE_RGB = { r: 5, g: 7, b: 8 }; // #050708

// ---------------------------------------------------------------------------
// Pure color math — no browser APIs (Node-testable).
// ---------------------------------------------------------------------------

export type Hsl = { h: number; s: number; l: number };

/** RGB (0–255) → HSL (h: 0–360, s/l: 0–1). */
export function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h: (h + 360) % 360, s, l };
}

/** HSL → RGB (0–255). */
export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hn = ((((h % 360) + 360) % 360) / 360);
  if (s <= 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };
  return {
    r: Math.round(channel(hn + 1 / 3) * 255),
    g: Math.round(channel(hn) * 255),
    b: Math.round(channel(hn - 1 / 3) * 255)
  };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Mix an HSL color toward the global base (#050708) by t (0–1). */
export function mixTowardBase(h: number, s: number, l: number, t: number): string {
  const rgb = hslToRgb(h, s, l);
  const mix = (c: number, base: number) => Math.round(c + (base - c) * t);
  return `rgb(${mix(rgb.r, BASE_RGB.r)}, ${mix(rgb.g, BASE_RGB.g)}, ${mix(rgb.b, BASE_RGB.b)})`;
}

const cssHsl = (h: number, s: number, l: number) =>
  `hsl(${Math.round(((h % 360) + 360) % 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
const cssHsla = (h: number, s: number, l: number, a: number) =>
  `hsla(${Math.round(((h % 360) + 360) % 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${a})`;

// ---------------------------------------------------------------------------
// Palette derivation from raw pixels.
// ---------------------------------------------------------------------------

/** Hue-bin count for the dominant-color histogram (30° buckets). */
const HUE_BINS = 12;
/** Pixels below this alpha are transparent — skipped. */
const MIN_ALPHA = 200;
/** Below this saturation a pixel counts as achromatic, not chromatic. */
const NEUTRAL_SAT = 0.1;

/**
 * Derive the restrained dark palette from RGBA pixel data (any size —
 * the sampler pre-downscales). Pure math, Node-testable.
 */
export function derivePaletteFromPixels(
  pixels: Uint8ClampedArray | number[],
  key: string
): DetailPalette {
  const binWeight = new Array<number>(HUE_BINS).fill(0);
  const binX = new Array<number>(HUE_BINS).fill(0);
  const binY = new Array<number>(HUE_BINS).fill(0);
  const binSat = new Array<number>(HUE_BINS).fill(0);
  let chromaWeight = 0;
  let neutralWeight = 0;
  let sampled = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    if (alpha < MIN_ALPHA) continue;
    sampled += 1;
    const { h, s, l } = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    // Weight window: vivid, mid-luminance pixels dominate (both washed
    // near-white highlights and crushed near-black shadows contribute
    // almost nothing — they would bias the derived tone).
    const windowWeight = clamp(1 - Math.abs(l - 0.42) * 1.7, 0.02, 1);
    if (s < NEUTRAL_SAT) {
      neutralWeight += windowWeight;
      continue;
    }
    const weight = Math.pow(s, 1.4) * windowWeight;
    if (weight < 0.015) continue;
    const bin = Math.floor(h / (360 / HUE_BINS)) % HUE_BINS;
    const rad = (h * Math.PI) / 180;
    binWeight[bin] += weight;
    binX[bin] += Math.cos(rad) * weight;
    binY[bin] += Math.sin(rad) * weight;
    binSat[bin] += s * weight;
    chromaWeight += weight;
  }

  // Achromatic artwork (or nothing usable sampled) → the neutral
  // cinematic fallback family (cool slate — never the global accent).
  const neutralDominant = neutralWeight > chromaWeight * 0.9;
  if (sampled === 0 || neutralDominant || chromaWeight <= 0) {
    return buildPalette({ key, hue: 210, sat: 0.16, neutral: true });
  }

  let dominantBin = 0;
  for (let bin = 1; bin < HUE_BINS; bin += 1) {
    if (binWeight[bin] > binWeight[dominantBin]) dominantBin = bin;
  }
  // Circular mean hue (bins wrap: red sits in bins 0 and 11).
  const hue = (Math.atan2(binY[dominantBin], binX[dominantBin]) * 180) / Math.PI;
  const satMean = binSat[dominantBin] / binWeight[dominantBin];
  return buildPalette({ key, hue: (hue + 360) % 360, sat: satMean, neutral: false });
}

function buildPalette(input: { key: string; hue: number; sat: number; neutral: boolean }): DetailPalette {
  const { key, hue, neutral } = input;
  // Deep tones: hue preserved, saturation pulled into a restrained band,
  // lightness pinned to the deep cinematic band. Bright posters produce
  // a DARK backdrop — never a raw bright poster color.
  const deepSat = clamp(input.sat, 0.2, 0.52);
  const deep = cssHsl(hue, deepSat, 0.07);
  const deepAlt = cssHsl(hue, clamp(deepSat * 1.15, 0.22, 0.58), 0.115);
  const fadeMid = mixTowardBase(hue, deepSat, 0.07, 0.55);
  const surface = cssHsla(hue, deepSat, 0.32, 0.1);
  const accentSat = neutral ? 0.3 : clamp(input.sat * 1.3, 0.38, 0.8);
  const accent = cssHsl(hue, accentSat, 0.6);
  const accentSoft = cssHsla(hue, accentSat, 0.6, 0.12);
  const accentBorder = cssHsla(hue, accentSat, 0.62, 0.3);
  const glow = cssHsla(hue, accentSat, 0.55, 0.22);
  const scrim = cssHsla(hue, clamp(input.sat * 0.9, 0.16, 0.5), 0.04, 0.55);
  return { key, hue, neutral, deep, deepAlt, fadeMid, surface, accent, accentSoft, accentBorder, glow, scrim };
}

/**
 * The neutral cinematic fallback (missing artwork, failed extraction,
 * achromatic artwork). Cool deep slate — deliberately NOT the global
 * green accent and NOT a pure black rectangle.
 */
export const NEUTRAL_FALLBACK: DetailPalette = buildPalette({ key: '', hue: 210, sat: 0.16, neutral: true });

/** The inline CSS custom-property string consumed by the DetailPage. */
export function buildPaletteStyle(palette: DetailPalette): string {
  return [
    `--dp-deep: ${palette.deep}`,
    `--dp-deep-alt: ${palette.deepAlt}`,
    `--dp-fade-mid: ${palette.fadeMid}`,
    `--dp-surface: ${palette.surface}`,
    `--dp-accent: ${palette.accent}`,
    `--dp-accent-soft: ${palette.accentSoft}`,
    `--dp-accent-border: ${palette.accentBorder}`,
    `--dp-glow: ${palette.glow}`,
    `--dp-scrim: ${palette.scrim}`
  ].join('; ');
}

// ---------------------------------------------------------------------------
// Bounded palette cache — keyed by the ACTUAL artwork URL (LRU, 24).
// ---------------------------------------------------------------------------

const CACHE_MAX_ENTRIES = 24;
const paletteCache = new Map<string, DetailPalette>();

export function getCachedPalette(key: string): DetailPalette | undefined {
  const entry = paletteCache.get(key);
  if (!entry) return undefined;
  // LRU touch.
  paletteCache.delete(key);
  paletteCache.set(key, entry);
  return entry;
}

export function setCachedPalette(palette: DetailPalette): void {
  if (!palette.key) return;
  if (paletteCache.has(palette.key)) paletteCache.delete(palette.key);
  paletteCache.set(palette.key, palette);
  while (paletteCache.size > CACHE_MAX_ENTRIES) {
    const oldest = paletteCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    paletteCache.delete(oldest);
  }
}

export function clearPaletteCache(): void {
  paletteCache.clear();
}

// ---------------------------------------------------------------------------
// Browser extraction (guarded — the module imports safely on the server).
// ---------------------------------------------------------------------------

const SAMPLE_WIDTH = 48;
const SAMPLE_HEIGHT = 36;

/** Same-origin proxy for artwork CDNs that refuse CORS (image.tmdb.org). */
const ARTWORK_PROXY_PATH = '/api/content/artwork-proxy?url=';

/**
 * Hosts already proven to refuse CORS — skip the doomed direct attempt.
 * image.tmdb.org (the production artwork CDN) is pre-seeded: its images
 * are served WITHOUT Access-Control-Allow-Origin, so the direct CORS
 * load can never succeed.
 */
const corsFailedHosts = new Set<string>(['image.tmdb.org']);

function proxyUrl(url: string): string {
  return `${ARTWORK_PROXY_PATH}${encodeURIComponent(url)}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // Only the DIRECT attempt asks for CORS; the proxy is same-origin.
    if (!src.startsWith(ARTWORK_PROXY_PATH)) image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('ARTWORK_LOAD_FAILED'));
    image.src = src;
  });
}

function samplePixels(image: HTMLImageElement): Uint8ClampedArray | null {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  // Throws SecurityError on a tainted canvas — surfaced to the caller.
  return context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
}

async function extractFromCandidate(url: string, viaProxy: boolean): Promise<DetailPalette> {
  const image = await loadImage(viaProxy ? proxyUrl(url) : url);
  const pixels = samplePixels(image);
  if (!pixels) throw new Error('SAMPLING_UNAVAILABLE');
  const palette = derivePaletteFromPixels(pixels, url);
  if (palette.neutral && !viaProxy) {
    // A tainted canvas can silently yield suspect data in some engines
    // (a fully transparent read classifies as neutral). A DIRECT load
    // that reads as neutral is therefore retried through the proxy
    // before the caller settles for the fallback.
    throw new Error('SUSPECT_NEUTRAL_READ');
  }
  return palette;
}

/**
 * Extract the palette for one artwork URL:
 *   1. direct load with CORS (CORS-enabled CDNs),
 *   2. same-origin proxy fallback (image.tmdb.org),
 *   3. null when nothing could be sampled safely (caller keeps the
 *      neutral fallback — the page never breaks).
 * Results are cached by the artwork URL.
 */
export async function extractArtworkPalette(url: string): Promise<DetailPalette | null> {
  if (!url) return null;
  const cached = getCachedPalette(url);
  if (cached) return cached;

  if (typeof window === 'undefined' || typeof document === 'undefined') return null;

  let host = '';
  try {
    host = new URL(url, window.location.origin).host;
  } catch {
    return null;
  }
  const directAllowed = Boolean(host) && !corsFailedHosts.has(host);

  // 1. Direct CORS attempt (skipped for hosts already known to refuse).
  if (directAllowed) {
    try {
      const palette = await extractFromCandidate(url, false);
      setCachedPalette(palette);
      return palette;
    } catch {
      // Mark the host so later extractions skip straight to the proxy.
      if (corsFailedHosts.size < 8) corsFailedHosts.add(host);
    }
  }

  // 2. Same-origin proxy.
  try {
    const palette = await extractFromCandidate(url, true);
    setCachedPalette(palette);
    return palette;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Race-guarded controller — stale extractions never overwrite the current
// title's palette (rapid client-side navigation between detail pages).
// ---------------------------------------------------------------------------

export class DetailPaletteController {
  private sequence = 0;
  private disposed = false;

  constructor(private readonly onPalette: (palette: DetailPalette | null) => void) {}

  /** True when a later request/dispose has superseded `sequence`. */
  private isStale(sequence: number): boolean {
    return this.disposed || sequence !== this.sequence;
  }

  /**
   * Request the palette for `key` (an artwork URL, '' = no artwork).
   * Cached palettes apply synchronously; extractions apply only if this
   * request is still the newest one when it settles.
   */
  request(
    key: string,
    extract: (url: string) => Promise<DetailPalette | null> = extractArtworkPalette
  ): void {
    if (this.disposed) return;
    const sequence = ++this.sequence;
    if (!key) {
      this.onPalette(null);
      return;
    }
    const cached = getCachedPalette(key);
    if (cached) {
      if (!this.isStale(sequence)) this.onPalette(cached);
      return;
    }
    void extract(key).then(
      (palette) => {
        if (this.isStale(sequence)) return; // stale — discard, never apply
        this.onPalette(palette);
      },
      () => {
        if (this.isStale(sequence)) return;
        this.onPalette(null);
      }
    );
  }

  /** Supersede every in-flight request (component teardown). */
  dispose(): void {
    this.disposed = true;
    this.sequence += 1;
  }
}
