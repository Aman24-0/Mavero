/**
 * MAVP-4 Issue 4 — server-side SVG sanitizer for pasted source icons.
 *
 * Security contract (established-sanitizer pattern: STRICT PARSE → ALLOWLIST
 * WALK → RE-SERIALIZE → RE-VERIFY):
 *
 *   Parsing uses cheerio (an existing dependency — htmlparser2/parse5, NOT
 *   regex scanning), so malformed markup cannot smuggle constructs past a
 *   pattern matcher. The walk keeps ONLY allowlisted elements and attributes
 *   with safe values; anything else is either silently dropped (benign
 *   unknown content, e.g. editor namespaces) or REJECTED with a
 *   `SvgValidationError` (dangerous constructs — the task requires
 *   rejection, not silent stripping, so an admin always knows why).
 *
 *   REJECTED (thrown, never stored):
 *     - <script> and any scripting/SMIL-animation element (script, handler,
 *       animate, animateMotion, animateTransform, set, foreignObject,
 *       iframe, embed, object, image, use, audio, video) — animation/set
 *       elements can mutate event-handler attributes at runtime.
 *     - ANY event-handler attribute (on*).
 *     - ANY external reference: href/xlink:href in any form, url() values
 *       that are not pure #fragment references (blocks javascript:/data:/http
 *       exfiltration and remote-resource loads).
 *     - <style> elements and style attributes carrying url()/@import/
 *       expression()/javascript: (only a small presentation-property
 *       declaration allowlist survives).
 *
 *   NORMALIZED (applied, documented):
 *     - The root <svg> always carries xmlns (required for data: URL rendering).
 *     - The root <svg> gains color="#f5f5f5" when absent — inside <img>
 *       rendering currentColor would otherwise resolve to black, breaking
 *       dark-theme legibility (the app's text token value, static by design:
 *       data URLs cannot reference app CSS). 2026-10 rebrand: was #f2fff8
 *       (greenish-white), now #f5f5f5 (neutral white).
 *
 *   Rendering-side defense in depth: the sanitized markup is stored as a
 *   data URL and rendered via <img> (script-inert by specification) — the
 *   markup NEVER passes through {@html}.
 */

import * as cheerio from 'cheerio';

export class SvgValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SvgValidationError';
  }
}

/** Bounded pasted-SVG markup size (mirrored by the validation gate). */
export const SOURCE_SVG_MAX_LENGTH = 48_000;

/** Elements that may survive sanitization (icon-grade vector shapes only). */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc',
  'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'text', 'tspan',
  'lineargradient', 'radialgradient', 'stop', 'clippath',
]);

/** Elements whose presence is REJECTED outright (never silently stripped). */
const REJECTED_ELEMENTS = new Set([
  'script', 'handler', 'foreignobject', 'iframe', 'embed', 'object', 'image',
  'use', 'audio', 'video', 'animate', 'animatemotion', 'animatetransform', 'set',
  'style', 'filter', 'mask', 'pattern', 'symbol', 'metadata',
  'a', // links carry href-based external references — rejected, never stripped
]);

/** Attributes that may survive sanitization (geometry + presentation). */
const ALLOWED_ATTRIBUTES = new Set([
  'id', 'xmlns', 'version', 'viewbox', 'preserveaspectratio', 'color',
  'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'width', 'height', 'points', 'transform',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'opacity', 'clip-path', 'clip-rule',
  'offset', 'stop-color', 'stop-opacity',
  'gradientunits', 'gradienttransform', 'spreadmethod',
  'dx', 'dy', 'text-anchor', 'dominant-baseline', 'font-size',
]);

/** Paint-value attributes whose values must be fragment-only url() safe. */
const PAINT_ATTRIBUTES = new Set(['fill', 'stroke', 'stop-color', 'clip-path']);

/** Presentation declarations allowed inside a surviving style attribute. */
const ALLOWED_STYLE_PROPERTIES = new Set([
  'fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity',
  'color', 'display',
]);

const MAX_ATTRIBUTE_LENGTH = 300;

function rejectIfDangerousValue(name: string, value: string): void {
  const lower = value.toLowerCase();
  if (lower.includes('javascript:') || lower.includes('data:') || lower.includes('vbscript:')) {
    throw new SvgValidationError(`SVG attribute "${name}" carries a forbidden URL scheme.`);
  }
  if (lower.includes('@import') || lower.includes('expression(')) {
    throw new SvgValidationError(`SVG attribute "${name}" carries a forbidden CSS construct.`);
  }
  // url() is only safe as a pure INTERNAL fragment reference (url(#id)).
  const urlMatch = /url\(\s*['"]?([^'")]*)['"]?\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlMatch.exec(lower)) !== null) {
    if (!match[1].trim().startsWith('#')) {
      throw new SvgValidationError(`SVG attribute "${name}" references an external resource ("url(${match[1]})"). Only same-document "#fragment" references are allowed.`);
    }
  }
}

function sanitizeStyleValue(name: string, value: string): string | null {
  const declarations = value.split(';').map((entry) => entry.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const declaration of declarations) {
    const separator = declaration.indexOf(':');
    if (separator <= 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const propertyValue = declaration.slice(separator + 1).trim();
    // Dangerous constructs REJECT regardless of the property allowlist —
    // an external reference can never hide inside a dropped declaration.
    rejectIfDangerousValue(`style:${property}`, propertyValue);
    if (!ALLOWED_STYLE_PROPERTIES.has(property)) continue;
    // Bounded, simple values only (colors, numbers, keywords).
    if (!/^[-a-z0-9 #%().,]+$/.test(propertyValue.toLowerCase())) continue;
    kept.push(`${property}:${propertyValue}`);
  }
  if (!kept.length) return null;
  void name;
  return kept.join(';');
}

/**
 * Sanitize pasted SVG markup. Throws `SvgValidationError` for rejected
 * constructs; returns the normalized markup (canonical root attributes,
 * bounded size) ready to be stored as a data URL.
 */
export function sanitizeSourceSvgMarkup(input: string): string {
  const markup = String(input ?? '').trim();
  if (!markup) throw new SvgValidationError('SVG markup is empty.');
  if (markup.length > SOURCE_SVG_MAX_LENGTH) {
    throw new SvgValidationError(`SVG markup must be ${SOURCE_SVG_MAX_LENGTH} characters or fewer.`);
  }
  // Strip XML declarations / doctypes / processing instructions first — the
  // sanitizer works on a fragment and they can confuse the HTML parser.
  const fragment = markup
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');

  const dangerousCheck = fragment.toLowerCase();
  if (dangerousCheck.includes('<script') || /\son[a-z-]+\s*=/.test(dangerousCheck)) {
    throw new SvgValidationError('SVG markup must not contain scripts or event-handler attributes.');
  }

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(fragment, { xmlMode: true });
  } catch {
    throw new SvgValidationError('SVG markup could not be parsed.');
  }

  const roots = $('svg');
  if (roots.length !== 1) {
    throw new SvgValidationError('SVG markup must contain exactly one root <svg> element.');
  }

  // Walk EVERY element: allowlisted → keep (scrub attributes); benign
  // unknown → drop; dangerous → REJECT.
  $('*').each((_index, element) => {
    const node = element as unknown as { tagName?: string; type?: string };
    if (node.type === 'comment' || node.type === 'directive' || node.type === 'doctype') return;
    const tag = (node.tagName ?? '').toLowerCase();
    if (REJECTED_ELEMENTS.has(tag)) {
      throw new SvgValidationError(`SVG markup uses a forbidden element: <${tag}>.`);
    }
    if (!ALLOWED_ELEMENTS.has(tag)) {
      $(element).remove();
      return;
    }
    // Scrub attributes: only the allowlist survives; dangerous values reject.
    // htmlparser2 exposes the REAL attribute map on `attribs` — walk exactly
    // that (never the node's internal fields).
    const attribs = (element as unknown as { attribs?: Record<string, string> }).attribs ?? {};
    for (const attributeName of Object.keys(attribs)) {
      if (attributeName.startsWith('on')) {
        throw new SvgValidationError(`SVG markup uses a forbidden event-handler attribute (${attributeName}).`);
      }
      if (attributeName === 'href' || attributeName === 'xlink:href') {
        throw new SvgValidationError('SVG markup must not carry href/xlink:href references.');
      }
      if (attributeName === 'style') {
        const sanitized = sanitizeStyleValue(attributeName, String(attribs[attributeName] ?? ''));
        if (sanitized) $(element).attr('style', sanitized);
        else $(element).removeAttr('style');
        continue;
      }
      const lowerName = attributeName.toLowerCase();
      if (!ALLOWED_ATTRIBUTES.has(lowerName)) {
        if (attributeName.includes(':')) {
          // Editor namespaces (inkscape:*, sodipodi:*, …) are benign — drop.
          $(element).removeAttr(attributeName);
          continue;
        }
        $(element).removeAttr(attributeName);
        continue;
      }
      const value = String(attribs[attributeName] ?? '');
      if (value.length > MAX_ATTRIBUTE_LENGTH) {
        throw new SvgValidationError(`SVG attribute "${attributeName}" exceeds ${MAX_ATTRIBUTE_LENGTH} characters.`);
      }
      if (PAINT_ATTRIBUTES.has(lowerName)) rejectIfDangerousValue(attributeName, value);
      // href-like references are already rejected above; remaining values are
      // geometry/presentation — inert by construction.
    }
  });

  const root = $('svg').first();
  // Canonical root: xmlns is REQUIRED for a standalone data-URL document.
  if (!root.attr('xmlns')) root.attr('xmlns', 'http://www.w3.org/2000/svg');
  // Dark-theme legibility: currentColor inside <img> otherwise resolves black.
  // 2026-10 rebrand: --color-text changed from #f2fff8 (greenish-white) to
  // #f5f5f5 (neutral white). This static anchor mirrors that token.
  if (!root.attr('color')) root.attr('color', '#f5f5f5');

  const serialized = $.html('svg').trim();
  if (!serialized.startsWith('<svg') || serialized.length > SOURCE_SVG_MAX_LENGTH) {
    throw new SvgValidationError('Sanitized SVG output is malformed or too large.');
  }

  // RE-VERIFY: sanitize the serialized output again and require a stable
  // result (proves nothing smuggled through the parser round-trip).
  const secondPass = sanitizePassVerify(serialized);
  if (secondPass !== serialized) {
    throw new SvgValidationError('SVG markup did not stabilize after sanitization.');
  }
  return serialized;
}

/** Verification pass — parses + validates WITHOUT mutating, returns markup. */
function sanitizePassVerify(markup: string): string {
  const $ = cheerio.load(markup, { xmlMode: true });
  let failed: string | null = null;
  $('*').each((_index, element) => {
    const tag = ((element as unknown as { tagName?: string }).tagName ?? '').toLowerCase();
    if (REJECTED_ELEMENTS.has(tag)) failed = tag;
  });
  if (failed) throw new SvgValidationError(`SVG markup uses a forbidden element: <${failed}>.`);
  return $.html('svg').trim();
}

/** Canonical storage form for sanitized SVG markup (the stored icon value). */
export function svgMarkupToDataUrl(markup: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(markup, 'utf8').toString('base64')}`;
}

/**
 * Decode a stored `data:image/svg+xml;base64,…` icon back to markup (used by
 * the Admin editor prefill so an existing sanitized icon can be re-edited).
 * Returns null for values that are not decodable SVG data URLs.
 */
export function svgDataUrlToMarkup(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim();
  const match = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/]+={0,2})$/.exec(normalized);
  if (!match) return null;
  try {
    const markup = Buffer.from(match[1], 'base64').toString('utf8');
    return markup.startsWith('<svg') ? markup : null;
  } catch {
    return null;
  }
}

/** PNG upload guard: MIME + size + magic bytes → canonical data URL. */
export async function pngUploadToDataUrl(file: File): Promise<string> {
  if (file.type !== 'image/png') {
    throw new SvgValidationError('Uploaded icons must be PNG images.');
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 64 * 1024) {
    throw new SvgValidationError('Uploaded PNG icons must be 64 KB or smaller.');
  }
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new SvgValidationError('Uploaded file is not a valid PNG image.');
  }
  return `data:image/png;base64,${bytes.toString('base64')}`;
}
