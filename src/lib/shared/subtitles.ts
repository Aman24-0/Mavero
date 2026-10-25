/**
 * Player UI V2 (Part 2, Part A) — canonical subtitle-label validation.
 *
 * SHARED by the VDRK client (`external-subtitles.ts` — file-URL labels) and
 * the server VTT proxy routes (`server/subtitles/vdrk.ts` — decoded path
 * params) so both sides accept exactly the same label language.
 *
 * Verified live 2026-10-12 against the real VDRK API across 10 popular
 * titles (~850 list entries): labels are short ASCII tokens of
 * `A-Za-z0-9` plus SPACES and PARENTHESES — observed inventory
 * `A-Za-z0-9 ().-` with a max length of 23 ("Portuguese (BR)2",
 * "English Hi3", "Chinese (simplified) Hi", "Brazilian4"). The Part 1
 * pattern (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`) rejected the space/paren
 * subset and dropped those tracks entirely — the Part A regression.
 *
 * SECURITY: this is a WHITELIST. Anything outside the listed characters is
 * rejected outright, which subsumes the required rejections:
 *   * path separators `/` `\` (and any traversal — `..` cannot even start
 *     a label because the first character must be alphanumeric),
 *   * `%` (percent-encoding — labels are validated DECODED; a `%` can never
 *     alter the URL structure the server rebuilds),
 *   * control characters, quotes, `#`/`?`/`&` (URL metacharacters),
 *   * non-ASCII/unicode look-alikes,
 *   * excessively long labels (64-char cap vs 23 observed),
 *   * leading/trailing whitespace padding (labels begin alphanumeric and
 *     end with a non-space — observed labels never carry padding, and
 *     trimming semantics would otherwise blur distinct variants).
 */

export const SUBTITLE_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 ()._-]{0,62}[A-Za-z0-9()._-])?$/;

// ---------------------------------------------------------------------------
// VDRK upstream origins — SINGLE SOURCE (Phase 3 3-D, repository-cleanup
// plan §5 group 3-D; audit §3.4 duplication finding).
//
// These two constants used to be DUPLICATED verbatim in the server VDRK
// proxy (`server/subtitles/vdrk.ts`) and the player client
// (`client/player/subtitles/external-subtitles.ts`) — drift between the two
// copies would silently split the subtitle pipeline (server fetches one
// origin, the browser builds proxy URLs against another).
//
// CSP COUPLING (documented, pinned by scripts/vdrk_origin_csp_lockstep_test.ts):
//   * VDRK_LIST_ORIGIN (https://sub.vdrk.site) is a BROWSER-DIRECT fetch
//     (external-subtitles.ts) — it MUST stay in netlify.toml's connect-src.
//   * VDRK_VTT_ORIGIN (https://cache.vdrk.site) is fetched SERVER-SIDE ONLY
//     through the same-origin /api/content/subtitles/vtt proxy — it
//     deliberately has NO CSP entry.
// netlify.toml cannot import TS, so the lockstep is enforced by the pin
// suite (which imports these constants and parses the deployed CSP).
// ---------------------------------------------------------------------------

/** The verified VDRK API origin (subtitle LISTS — browser-direct, CORS open). */
export const VDRK_LIST_ORIGIN = 'https://sub.vdrk.site';
/** The verified VDRK VTT origin (subtitle FILES — only reachable same-origin via the proxy). */
export const VDRK_VTT_ORIGIN = 'https://cache.vdrk.site';

/**
 * Validates an already-DECODED subtitle label and returns it unchanged, or
 * null when the value is not a legitimate VDRK label. Callers must never
 * pass a URL or path here — decode first (e.g. `decodeURIComponent` on a
 * path segment), then validate.
 */
export function validateSubtitleLabel(raw: string): string | null {
  return SUBTITLE_LABEL_PATTERN.test(raw) ? raw : null;
}

/**
 * Sanitizes a subtitle label for DISPLAY ONLY (menu text): removes control
 * characters and bounds the length. The display label never enters a URL —
 * proxy URLs are always rebuilt from the validated file-path label.
 */
export function sanitizeSubtitleDisplayLabel(raw: string): string {
  // Strip C0/C1 control characters (the observed API never sends them).
  const stripped = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return stripped.length > 80 ? '' : stripped.trim();
}
