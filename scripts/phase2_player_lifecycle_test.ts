import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 2-I — Player P1 lifecycle micro-fixes (PLR-02 / PLR-03 / PLR-04 / PLR-05).
 *
 * PLR-02 — viewportMediaQuery.addEventListener('change', ...) must have a
 *          matching removeEventListener in the onMount cleanup.
 * PLR-03 — setupMediaSession() must restore Media Session action handlers
 *          when appropriate (they're cleared by clearMediaSession on source
 *          switch). Embed sources must NOT get action handlers.
 * PLR-04 — Embed playback must participate in auto-hide. The control
 *          visibility condition must account for playing || embedPlaying.
 * PLR-05 — When sandbox mode is toggled and the iframe is remounted, the
 *          embed load timeout must be armed again (stale-source protection
 *          preserved).
 *
 * This test is intentionally static (source-level) — it verifies the
 * wiring without spinning up a real browser session. Runtime behavior is
 * covered by the existing stremio_player_phase*_test suites.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const shell = read('src/lib/components/player/PlayerShell.svelte');

// ============================================================
// PLR-02 — viewportMediaQuery listener has matching cleanup.
// ============================================================
ok(/viewportMediaQuery\.addEventListener\('change', handleViewportChange\)/.test(shell), 'PLR-02a. viewportMediaQuery.addEventListener("change", handleViewportChange) exists');
ok(/viewportMediaQuery\.removeEventListener\('change', handleViewportChange\)/.test(shell), 'PLR-02b. matching removeEventListener exists in cleanup');
ok(/Phase 2-I \(PLR-02\)/.test(shell), 'PLR-02c. fix annotated with Phase 2-I (PLR-02) comment for traceability');

// ============================================================
// PLR-03 — setupMediaSession restores action handlers for DIRECT sources.
// ============================================================
ok(/function setupMediaSession\(\)/.test(shell), 'PLR-03a. setupMediaSession function exists');
ok(/Phase 2-I \(PLR-03\)/.test(shell), 'PLR-03b. fix annotated with Phase 2-I (PLR-03) comment');
ok(/if \(source\?\.type === 'direct'\) \{[\s\S]*?registerMediaSessionHandlers\(\)/.test(shell), 'PLR-03c. setupMediaSession re-registers action handlers for direct sources');
// For embed sources, handlers must NOT be registered.
// Verify the gate is `=== 'direct'` (not `!== 'embed'` or some looser check).
ok(/if \(source\?\.type === 'direct'\) \{\s*registerMediaSessionHandlers\(\);\s*\}/.test(shell), 'PLR-03d. handler registration gated strictly on source.type === "direct" (embed sources excluded)');

// Verify clearMediaSession clears action handlers (so setupMediaSession's re-registration is needed).
ok(/function clearMediaSession\(\)/.test(shell), 'PLR-03e. clearMediaSession function exists');
ok(/for \(const action of actions\) \{[\s\S]*?setActionHandler.*null/.test(shell), 'PLR-03f. clearMediaSession nulls action handlers (so source-switch destroys them, requiring re-registration)');

// The existing handlers cover the required media-session surface.
ok(/trySet\('play'/.test(shell), 'PLR-03g. play action handler preserved');
ok(/trySet\('pause'/.test(shell), 'PLR-03h. pause action handler preserved');
ok(/trySet\('seekbackward'/.test(shell), 'PLR-03i. seekbackward action handler preserved');
ok(/trySet\('seekforward'/.test(shell), 'PLR-03j. seekforward action handler preserved');
ok(/setActionHandler\('seekto'/.test(shell), 'PLR-03k. seekto action handler preserved');
ok(/session\.metadata = new MediaMetadata\(/.test(shell), 'PLR-03l. metadata behavior preserved (play, pause, seek, seekto, metadata all intact)');

// ============================================================
// PLR-04 — Embed auto-hide: visibility condition accounts for embedPlaying.
// ============================================================
ok(/Phase 2-I \(PLR-04\)/.test(shell), 'PLR-04a. fix annotated with Phase 2-I (PLR-04) comment');
ok(/\(\s*playing\s*\|\|\s*embedPlaying\s*\)/.test(shell), 'PLR-04b. revealControls checks (playing || embedPlaying) for auto-hide eligibility');
// The OLD pattern (playing only, no embedPlaying) must be gone from revealControls.
// Extract the revealControls body and verify.
const revealMatch = /function revealControls\(\) \{[\s\S]*?\n  \}/.exec(shell);
ok(revealMatch !== null, 'PLR-04c. revealControls function body extractable');
if (revealMatch) {
  const body = revealMatch[0];
  ok(/\(\s*playing\s*\|\|\s*embedPlaying\s*\)/.test(body), 'PLR-04d. revealControls uses (playing || embedPlaying)');
  ok(!/if \(playing && !menuOpen/.test(body), 'PLR-04e. old pattern (playing only) removed from revealControls');
}
// The provider iframe content itself is NOT hidden — auto-hide only affects
// the Mavero control overlay (the comment makes this explicit).
ok(/provider iframe content itself is[\s\S]*?NOT hidden/.test(shell), 'PLR-04f. documented: provider iframe content not hidden, only Mavero control overlay');

// ============================================================
// PLR-05 — Sandbox toggle re-arms the embed load timeout.
// ============================================================
ok(/Phase 2-I \(PLR-05\)/.test(shell), 'PLR-05a. fix annotated with Phase 2-I (PLR-05) comment');
ok(/function toggleSandbox\(\)/.test(shell), 'PLR-05b. toggleSandbox function exists');
ok(/if \(source\?\.sourceId\) startEmbedLoadTimeout\(source\.sourceId\)/.test(shell), 'PLR-05c. toggleSandbox arms a fresh embed load timeout after the policy change');
// The stale-source protection in startEmbedLoadTimeout is preserved.
ok(/function startEmbedLoadTimeout\(sourceId: string\)/.test(shell), 'PLR-05d. startEmbedLoadTimeout function preserved');
ok(/const timeoutSourceId = sourceId/.test(shell), 'PLR-05e. stale-source guard captures sourceId at start time (preserved)');
ok(/if \(sourceIdentity !== timeoutSourceId\) return/.test(shell), 'PLR-05f. stale-source guard no-ops if user switched sources (preserved)');
ok(/if \(state !== 'embed-loading'\) return/.test(shell), 'PLR-05g. state guard — only transitions to error if still embed-loading (preserved)');

// ============================================================
// Regression — existing patterns preserved.
// ============================================================
ok(/function clearEmbedLoadTimeout\(\)/.test(shell), 'R-1. clearEmbedLoadTimeout preserved');
ok(/clearEmbedLoadTimeout\(\);/.test(shell), 'R-2. clearEmbedLoadTimeout called on cleanup paths');
ok(/EMBED_LOAD_TIMEOUT_MS/.test(shell), 'R-3. EMBED_LOAD_TIMEOUT_MS constant preserved');

console.log(`phase2_player_lifecycle_test: ${passed} checks passed (Phase 2-I PLR-02/03/04/05 player lifecycle micro-fixes)`);
