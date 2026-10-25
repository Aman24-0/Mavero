/**
 * Safe JSON-LD serialization for `<script type="application/ld+json">`
 * head blocks (Google Search Console fix, 2026-10).
 *
 * ROOT CAUSE (GSC "Unparsable structured data — Parsing error: Missing '}'
 * or object member name" on /tv-show/4614): Svelte treats the CONTENTS of
 * `<script>` elements in a template as RAW TEXT — neither `{expr}` nor
 * `{@html expr}` interpolates inside them (verified empirically against
 * the repo's Svelte 5). DetailPage.svelte's
 * `<script type="application/ld+json">{structuredData}</script>` therefore
 * emitted the literal placeholder text `{structuredData}` in the SSR HTML,
 * which `JSON.parse` rejects at position 1 — exactly the GSC report.
 *
 * Even ordinary Svelte text interpolation is wrong here: it HTML-escapes
 * the JSON (`&quot;`, `&amp;`, `&lt;`), which crawlers must NOT see inside
 * a JSON-LD block. The JSON-LD block must be injected as RAW JSON through
 * `{@html}` (whole script element), with script-breaking characters
 * escaped INTO valid JSON unicode escapes — never HTML entities, never
 * truncation.
 *
 * THE CONTRACT: every `<` in the serialized JSON is rewritten to the JSON
 * escape `\u003c`. `JSON.parse` treats the two forms identically (the
 * round-tripped data is byte-for-byte the same), while the raw document
 * can never contain a `</script` or `<!--` sequence that terminates the
 * script element early — a title/description must not be able to break
 * out of the head script or inject markup. U+2028/U+2029 line separators
 * are escaped for JS-context robustness even though their raw forms are
 * valid JSON inside string literals.
 */

/**
 * Escape script-breaking characters in an ALREADY-JSON.stringify'd string,
 * preserving valid JSON encoding.
 */
export function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Serialize a value to raw JSON that is safe to embed inside a
 * `<script type="application/ld+json">` element.
 */
export function serializeJsonLd(value: unknown): string {
  return escapeJsonForScript(JSON.stringify(value));
}

/**
 * Wrap safely-serialized JSON-LD in its complete script element for
 * injection via Svelte's `{@html}`.
 */
export function jsonLdScriptElement(json: string): string {
  return `<script type="application/ld+json">${json}</script>`;
}
