/**
 * Phase 3 3-D (repository-cleanup plan §5 group 3-D) — VDRK origin/CSP
 * LOCKSTEP pin.
 *
 * Background (audit §3.4): the VDRK upstream origins were triplicated —
 * `VDRK_VTT_ORIGIN` in the server VDRK proxy AND the player client, plus
 * the origins hardcoded in the deployed netlify.toml CSP. netlify.toml
 * cannot import TS, so single-sourcing the constants (now in
 * `$lib/shared/subtitles.ts`, re-exported by both original modules) cannot
 * by itself protect the deploy-time coupling. This suite pins it:
 *
 *   §1  the shared constant is the ONE source — the server module and the
 *       client module re-export the SAME value (catches an accidental
 *       re-introduction of a divergent literal copy);
 *   §2  the deployed CSP in netlify.toml contains VDRK_LIST_ORIGIN in
 *       connect-src (the subtitle LIST fetch is BROWSER-DIRECT — a missing
 *       entry makes the deployed CSP reject it: "Refused to connect …
 *       connect-src", the exact production symptom documented in the
 *       netlify.toml comment block);
 *   §3  the CSP does NOT contain VDRK_VTT_ORIGIN (VTT files are fetched
 *       SERVER-SIDE through the same-origin /api/content/subtitles/vtt
 *       proxy — a CSP entry for it would be unnecessary origin exposure;
 *       its absence is the documented minimal-CSP posture).
 *
 * Deterministic: file reads + constant imports only — no network, no DB.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { VDRK_LIST_ORIGIN as SHARED_LIST, VDRK_VTT_ORIGIN as SHARED_VTT } from '$lib/shared/subtitles';
import { VDRK_LIST_ORIGIN as CLIENT_LIST, VDRK_VTT_ORIGIN as CLIENT_VTT } from '$lib/client/player/subtitles/external-subtitles';
import { VDRK_VTT_ORIGIN as SERVER_VTT } from '$lib/server/subtitles/vdrk';

let checks = 0;
function ok(condition: boolean, label: string) {
  assert.ok(condition, label);
  checks += 1;
}

// --- §1 single source -------------------------------------------------------

ok(SHARED_LIST === 'https://sub.vdrk.site', '§1: shared VDRK_LIST_ORIGIN is the verified value');
ok(SHARED_VTT === 'https://cache.vdrk.site', '§1: shared VDRK_VTT_ORIGIN is the verified value');
ok(CLIENT_LIST === SHARED_LIST, '§1: client module re-exports the SAME VDRK_LIST_ORIGIN (no divergent literal)');
ok(CLIENT_VTT === SHARED_VTT, '§1: client module re-exports the SAME VDRK_VTT_ORIGIN (no divergent literal)');
ok(SERVER_VTT === SHARED_VTT, '§1: server module re-exports the SAME VDRK_VTT_ORIGIN (no divergent literal)');

// --- §2/§3 deployed-CSP lockstep ---------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const netlifyToml = readFileSync(path.join(REPO_ROOT, 'netlify.toml'), 'utf8');

const cspMatch = netlifyToml.match(/Content-Security-Policy\s*=\s*"([^"]+)"/);
ok(cspMatch !== null, '§2: netlify.toml declares a Content-Security-Policy header');
const csp = cspMatch ? cspMatch[1] : '';

const connectSrc = csp.split(';').find((d) => d.trim().startsWith('connect-src'));
ok(connectSrc !== undefined, '§2: CSP declares a connect-src directive');
ok(connectSrc?.includes(SHARED_LIST) === true,
  `§2: CSP connect-src contains the VDRK LIST origin (${SHARED_LIST}) — browser-direct fetch`);

ok(!csp.includes(SHARED_VTT),
  `§3: CSP does NOT contain the VTT origin (${SHARED_VTT}) — VTT files go through the same-origin server proxy`);

console.log(`ok - vdrk_origin_csp_lockstep: ${checks} checks passed (shared single-source + netlify.toml CSP lockstep both directions)`);
if (checks !== 9) {
  throw new Error(`expected 9 checks, saw ${checks}`);
}
