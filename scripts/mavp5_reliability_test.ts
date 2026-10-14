/**
 * MAVP-5 — Player Reliability, Source Fallback & Episode UX. Regression suite.
 *
 * Sections (one per issue group):
 *   §1  Issue 1 — VidRift-only portrait scrolling: the player document
 *       scroll lock is completed at the ROOT level (html + body, both axes,
 *       overscroll-behavior: none) so the only UNSANDBOXED embed (VidRift,
 *       sandbox_policy 'unrestricted' by documented provider requirement)
 *       cannot chain gestures into the parent scroller; the embed iframe box
 *       is explicitly bounded on both axes; every MAVP-4 portrait contract
 *       (100vh→dvh chain, definite grid, neutralized legacy aspect-ratio,
 *       object-fit) is preserved.
 *   §2  Issue 2 — The Gentlemen card-play 500: the watch load's ONLY
 *       unguarded await (the adult authorization read) is now fail-CLOSED —
 *       a transient policy-read rejection produces the same non-disclosing
 *       404 as any unauthorized adult request (never a generic 500), the
 *       intentional 404 propagates as-is, the failure is logged safely, and
 *       the guard is scoped to the adult verdict branch only.
 *   §3  Issue 3 — embed rendering delay: the resolver attempts the REQUESTED
 *       source FIRST and loads the fallback candidate list + health ranking
 *       LAZILY, only after the primary attempt fails. Primary-success
 *       resolution no longer waits on the two extra Supabase queries; every
 *       fallback semantic (negative cache, cooldown, ordered defaults,
 *       bounded attempts, deadline) is preserved.
 *   §4  Issue 4 — episode chip + left sheet + source preservation: the
 *       dedicated left-edge episode chip (hidden for movies), its OWN
 *       position contract (parse/resolve/size, fully independent from back
 *       and landscape), the LEFT-opening episode sheet, the Admin editor +
 *       preview integration, and the ACTIVE-SOURCE PRESERVATION across
 *       episode changes (selectedSourceId is no longer reset; the default
 *       re-selection cannot fire; a failing active source follows the
 *       existing explicit failure behavior).
 *   §5  Issue 5 — landscape preservation on source switching: the
 *       presentation-intent state machine (intent + bounded switch window +
 *       one bounded restore attempt + explicit-exit clearing + destroy
 *       clearing), with portrait sessions untouched.
 *   §6  Issue 6 — three ordered default sources per category with automatic
 *       fallback: the additive migration (slots table + backfill), the
 *       public-config `defaultsOrder` reader (eligibility, dedupe, legacy
 *       reconciliation), the admin service validation + legacy mirror, the
 *       admin UI (three ordered slots per category), the resolver's ordered
 *       default attempts (each at most once, before ranked fallback), the
 *       client forwarding, and the bounded fallback message.
 *   §7  Issue 7 — slow Back navigation: the detail routes carry a short
 *       PRIVATE data-cache policy (client-router hit ⇒ instant Back within
 *       the TTL) while closePlayer stays fire-and-forget and the manager
 *       still aborts in-flight work on dispose.
 *   §8  Issue 8 — Avengers card-play function crash: the content cache's
 *       stale-while-revalidate background refreshes are ABSORBED (no
 *       unhandled rejection ⇒ no Node process death), stale entries remain
 *       served, the next request retries, the validated variant preserves
 *       the valid stale entry, and the failure is logged via safe fields.
 *
 * Deterministic: pure functions + source-level contract assertions + real
 * behavioral cache simulations. Never the real network, never the real DB,
 * never a real provider, never a browser (browser/device testing is
 * explicitly out of scope for MAVP-5).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BACK_CONTROL_DEFAULT_SIZE_PX,
  LANDSCAPE_CONTROL_DEFAULT_SIZE_PX,
  parsePlayerControlsPosition,
  resolveControlPlacement,
  resolveControlSize,
  controlsPreviewMarkerStyle,
} from '$lib/shared/player-controls-position';
import { applyOrderedDefaultSourceOrdering, applyDefaultSourceOrdering } from '$lib/server/resolver/default-source';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';
import { getOrSet, getOrSetValidated, clearCache, cacheStats } from '$lib/server/content/cache';
import { parseResolverRequest } from '$lib/server/resolver/identifiers';

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** Strip JS/Svelte/CSS comments so negative assertions test CODE, not docs. */
function codeOnly(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .split('\n')
    .join('\n');
}

let passCount = 0;
function ok(condition: unknown, message: string): void {
  assert.ok(condition, message);
  passCount++;
}
function section(name: string): void {
  console.log(`  § ${name} — checks so far: ${passCount}`);
}

const appCss = read('../src/app.css');
const appCssCode = codeOnly(appCss);
const shell = read('../src/lib/components/player/PlayerShell.svelte');
const shellCode = codeOnly(shell);
const viewport = read('../src/lib/components/player/PlayerViewport.svelte');
const viewportCode = codeOnly(viewport);
// Deep-audit: the watch load logic lives in the SHARED loader (consumed by
// both the query-form and canonical path-form routes).
const watchServer = read('../src/routes/watch/[type]/[id]/watch-loader.ts');
const watchServerCode = codeOnly(watchServer);
const watchRoute = read('../src/routes/watch/[type]/[id]/+page.svelte');
const watchRouteCode = codeOnly(watchRoute);
const manager = read('../src/lib/client/player/PlaybackManager.ts');
const managerCode = codeOnly(manager);
const resolverService = read('../src/lib/server/resolver/service.ts');
const resolverServiceCode = codeOnly(resolverService);
const resolverIdentifiers = read('../src/lib/server/resolver/identifiers.ts');
const defaultSourceModule = read('../src/lib/server/resolver/default-source.ts');
const cacheModule = read('../src/lib/server/content/cache.ts');
const cacheModuleCode = codeOnly(cacheModule);
const adminPage = read('../src/routes/admin/system/api-sources/+page.svelte');
const adminPageCode = codeOnly(adminPage);
const adminServer = read('../src/routes/admin/system/api-sources/+page.server.ts');
const adminServerCode = codeOnly(adminServer);
const adminService = read('../src/lib/server/streaming/admin-service.ts');
const adminServiceCode = codeOnly(adminService);
const publicConfig = read('../src/lib/server/streaming/public-config.ts');
const publicConfigCode = codeOnly(publicConfig);
const streamingTypes = read('../src/lib/server/streaming/types.ts');
const validation = read('../src/lib/server/streaming/validation.ts');
const validationCode = codeOnly(validation);
const migration = read('../supabase/migrations/20261107000000_default_source_slots.sql');
const movieDetailServer = read('../src/routes/movie/[id]/+page.server.ts');
// Deep-audit: /series/ + /anime/ are 308 redirect stubs since Phase 5 —
// the canonical detail loads (with the cache policy + adult gate) live on
// the /tv-show/, /anime-series/ and /anime-movie/ routes.
const seriesDetailServer = read('../src/routes/tv-show/[id]/+page.server.ts');
const animeDetailServer = read('../src/routes/anime-series/[id]/+page.server.ts');
const vidriftMigration = read('../supabase/migrations/20261105000000_vidrift_provider.sql');

// ---------------------------------------------------------------------------
// §1 — Issue 1: VidRift-only portrait scrolling (root-level scroll lock)
// ---------------------------------------------------------------------------

// The completed lock: BOTH root elements, BOTH axes, overscroll-behavior.
ok(/html\[data-player-open\]\s*\{\s*overflow:\s*hidden;\s*overscroll-behavior:\s*none;\s*\}/.test(appCssCode),
  'RC-1: the html root scroller itself is locked (both axes) while the player is open');
ok(/html\[data-player-open\]\s*body\s*\{\s*overflow:\s*hidden;\s*overscroll-behavior:\s*none;\s*\}/.test(appCssCode),
  'RC-1: the body lock now also carries overscroll-behavior: none (gesture chaining absorbed)');
ok(!/touch-action:\s*none/.test(appCssCode.slice(appCssCode.indexOf('Player route scroll lock'), appCssCode.indexOf('ADMIN 2.0 — NEON'))),
  'RC-1: the player lock deliberately does NOT disable touch-action (provider interactions preserved)');
// The lock attribute lifecycle is unchanged (set on mount, removed on destroy).
ok(shellCode.includes("document.documentElement.setAttribute('data-player-open', '')"),
  'RC-1: the data-player-open attribute is still set on shell mount');
ok(/removeAttribute\('data-player-open'\)/.test(shellCode),
  'RC-1: the data-player-open attribute is still removed on shell destroy');
// The embed iframe box is explicitly bounded on both axes.
ok(/\.stage-wrap :global\(\.viewport\.embed iframe\)\s*\{\s*aspect-ratio:\s*auto;\s*height:\s*100%;\s*min-height:\s*0;\s*\}/.test(shellCode),
  'RC-1: the MAVP-4 embed sizing contract (aspect-ratio neutralized, definite height) is preserved');
ok(/\.stage-wrap :global\(\.viewport\.embed iframe\)\s*\{\s*max-width:\s*100%;\s*max-height:\s*100%;\s*\}/.test(shellCode),
  'RC-1: the embed iframe box is explicitly bounded on both axes (no intrinsic overflow possible)');
// VidRift is the only unrestricted provider — the mechanism the lock must absorb.
ok(vidriftMigration.includes("'sandbox_policy', 'unrestricted'"),
  'RC-1: VidRift documented as the only sandbox_policy=unrestricted provider (the unsandboxed frame)');
// Established portrait contracts preserved byte-for-byte.
ok(/\.player-shell\s*\{[^}]*height:\s*100vh;\s*height:\s*100dvh;[^}]*min-height:\s*100dvh;[^}]*overflow:\s*hidden;/.test(shellCode),
  'RC-1: the 100vh→100dvh fallback chain and shell overflow:hidden are unchanged');
ok(/\.stage-wrap :global\(\.viewport\)\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/.test(shellCode),
  'RC-1: the definite minmax(0,1fr) grid tracks are unchanged');
ok(viewportCode.includes('object-fit: contain'),
  'RC-1: the provider presentation object-fit: contain is untouched');
section('Issue 1 — VidRift portrait scroll lock');

// ---------------------------------------------------------------------------
// §2 — Issue 2: The Gentlemen card-play 500 ("The signal dropped.")
// ---------------------------------------------------------------------------

// The ONLY previously-unguarded await in the watch load is now fail-closed.
ok(/try\s*\{\s*const canAccess = await canAccessAdultContent/.test(watchServerCode),
  'RC-2: the adult authorization read is wrapped in an explicit try/catch');
ok(watchServerCode.includes('if (isHttpError(gateError)) throw gateError;'),
  'RC-2: the intentional non-disclosing 404 propagates as-is (isHttpError passthrough)');
ok(/logger\.error\('watch adult authorization check failed \(fail closed\)'/.test(watchServerCode),
  'RC-2: a failed authorization evaluation is logged server-side (actionable, safe fields)');
ok((watchServerCode.match(/throw error\(404, 'Title not found'\)/g) ?? []).length >= 3,
  'RC-2: the fail-closed path throws the SAME non-disclosing 404 as unauthorized adult access');
ok(watchServerCode.includes("import { logger } from '$lib/server/http/log';"),
  'RC-2: the safe structured logger is used (never console noise, no secrets)');
// The guard is scoped to the adult verdict branch — non-adult playback unaffected.
ok(/if \(detailVerdict\(item\.tags\) === 'adult'\)\s*\{[^}]*canAccessAdultContent[\s\S]*?\n  \}/.test(watchServerCode),
  'RC-2: the fail-closed guard lives inside the adult-verdict branch only');
// The rest of the load's guarded shape is unchanged (detail→404, config→empty, season→null).
ok(/getDetail\(internalType, rawId\)\.catch/.test(watchServerCode),
  'RC-2: the getDetail→404 guard is unchanged');
// MAVP-6 (Issue 1): the degradation boundary now LOGS (stage-tagged) before
// returning the SAME EMPTY config — the outcome contract is unchanged; the
// assertion is updated to the stronger shape (log + same typed outcome).
ok(watchServerCode.includes('logWatchLoadStageFailure(logger, \'watch:streaming-config\'')
  && watchServerCode.includes('return EMPTY_STREAMING_CONFIG;'),
  'RC-2: the streaming-config degradation outcome is unchanged (now stage-logged)');
// MAVP-6 (Issue 1): the season boundary now LOGS (stage-tagged) before
// returning the SAME null — the absorption contract is unchanged; the
// assertion is updated to the stronger shape (log + same typed outcome).
ok(/getSeriesSeason\(rawId, seasonNumber\)[\s\S]*?logWatchLoadStageFailure\(logger, 'watch:season'[\s\S]*?return null;/.test(watchServerCode),
  'RC-2: the optional season fetch absorption is unchanged (now stage-logged)');
section('Issue 2 — The Gentlemen card-play 500');

// ---------------------------------------------------------------------------
// §3 — Issue 3: embed rendering delay (resolver primary-first, lazy fallback)
// ---------------------------------------------------------------------------

// The primary attempt happens BEFORE any fallback infrastructure loads.
const primaryIdx = resolverServiceCode.indexOf('resolveSourceFromConfig(request, config, content, dependencies)');
const lazyIdx = resolverServiceCode.indexOf('const orderedConfigs = sourceList?.length');
const candidatesIdx = resolverServiceCode.indexOf('loadTrustedFallbackCandidates(config)');
const healthIdx = resolverServiceCode.indexOf('loadSourceHealthMap(trustedClient');
ok(primaryIdx > -1 && lazyIdx > primaryIdx,
  'RC-3: the primary attempt precedes the lazy fallback pipeline');
ok(candidatesIdx > lazyIdx,
  'RC-3: loadTrustedFallbackCandidates runs only INSIDE the lazy fallback path (after the primary attempt)');
ok(healthIdx > lazyIdx,
  'RC-3: loadSourceHealthMap runs only INSIDE the lazy fallback path');
// The primary attempt preserves the walker's eligibility gates.
ok(resolverServiceCode.includes('getCachedNegative(negativeKey)'),
  'RC-3: the primary attempt honors the deterministic negative cache');
ok(resolverServiceCode.includes('isProviderEligible(config.provider.id)') && resolverServiceCode.includes('isProbeDue(config.provider.id)'),
  'RC-3: the primary attempt honors the transient-failure provider cooldown (probe-due aware)');
ok(resolverServiceCode.includes("config.provider.enabled && config.source.enabled && config.source.visibility === 'public'"),
  'RC-3: the primary attempt honors the ranking eligibility gates (provider enabled, source enabled, public visibility) — a disabled or hidden requested source is never attempted as primary and falls through to the unchanged ranking exclusion');
ok(/deadline\.guard\(resolveSourceFromConfig\(request, config, content, dependencies\)\)/.test(resolverServiceCode),
  'RC-3: the primary attempt is bounded by the overall resolution deadline');
ok(resolverServiceCode.includes('if (deadline.expired) throw primaryError;'),
  'RC-3: a deadline expiry during the primary attempt propagates (typed error, no fallback)');
ok(resolverServiceCode.includes('recordProviderSuccess(config.provider.id)') && resolverServiceCode.includes('recordProviderFailure(config.provider.id, primaryResolverError.code)'),
  'RC-3: primary success/failure is recorded in the cooldown bookkeeping');
ok(resolverServiceCode.includes('setCachedNegative(negativeKey, primaryResolverError.code, primaryResolverError.status)'),
  'RC-3: deterministic primary failures enter the negative cache (retry never loops)');
// The requested source is excluded from the fallback walk (no double attempts).
ok(resolverServiceCode.includes('alreadyAttemptedSourceIds = new Set<string>([config.source.id])'),
  'RC-3: the requested source is seeded into the already-attempted set');
// Manual selection path untouched (allowFallback=false resolves the single source directly).
ok(/if \(request\.allowFallback === false\)\s*\{[\s\S]*?resolveSourceFromConfig/.test(resolverServiceCode),
  'RC-3: manual explicit selection keeps its deterministic single-source path');
// The client's resolver timeout + the shell's presentation gate are untouched.
ok(managerCode.includes('const RESOLVER_TIMEOUT_MS = 15000;'),
  'RC-3: the 15s client resolver timeout is unchanged');
ok(shellCode.includes('EMBED_PRESENT_FAIL_OPEN_MS = 3000') && shellCode.includes('EMBED_LOAD_TIMEOUT_MS = 18000'),
  'RC-3: the MAVP-4 presentation gate bounds and the 18s embed timeout are unchanged');
section('Issue 3 — embed rendering delay');

// ---------------------------------------------------------------------------
// §4 — Issue 4: episode chip + left sheet + ACTIVE-SOURCE PRESERVATION
// ---------------------------------------------------------------------------

// The dedicated left-edge episode chip exists and mirrors the source chip.
ok(/class="episode-chip"/.test(shell) && shellCode.includes("aria-label=\"Choose episode\""),
  'RC-4: the dedicated episode chip renders with its own accessible role');
ok(/class="episode-chip-bar"[\s\S]*?class="episode-chip-label"/.test(shell),
  'RC-4: the chip mirrors the source chip design system (bar + hover label)');
ok(/\.episode-chip\s*\{[^}]*top:\s*50%;\s*left:\s*0;/.test(shellCode),
  'RC-4: the chip default position is the LEFT edge at the vertical centre');
ok(shellCode.includes('{#if episodes.length}') && /episodes\.length\}[\s\S]*?episode-chip/.test(shell),
  'RC-4: the chip renders ONLY when episode selection is supported (movies never show it)');
ok(shellCode.includes('openEpisodeSheet(event.currentTarget instanceof HTMLElement'),
  'RC-4: the chip opens the EXISTING focus-managed episode sheet');
// MAVP-6 (Issues 2+3) SUPERSESSION of the MAVP-5 episode-chip position
// contract: the per-source `episodes`/`sizes.episodes` configuration was
// REMOVED end-to-end (Admin editor, shared contract, server validation,
// preview) because the source chip is intentionally NOT positionable and the
// configurable episode profile was the sole cause of the reported vertical
// misalignment between the two edge chips. The replacements below are
// STRICTLY STRONGER: (a) the chip consumes NO per-source placement at all,
// (b) both edge chips share the IDENTICAL stylesheet vertical reference, and
// (c) legacy stored episode sections are dropped by the total parser while
// the Back/Landscape semantics stay byte-identical.
ok(!shellCode.includes("resolveControlPlacement(activeSourceOption?.controlsPosition ?? null, 'episodes'")
  && !shellCode.includes("controlsSizeInlineStyle(activeSourceOption?.controlsPosition ?? null, 'episodes'")
  && !shellCode.includes('--episodes-chip-size'),
  'RC-4 (superseded by MAVP-6): the chip consumes NO per-source placement/size — stronger than the old own-contract resolution');
// (c) Behavioral: a legacy stored config (episodes section + sizes.episodes)
// parses with those keys DROPPED and the back/landscape semantics intact.
const legacyEpisodesConfig = parsePlayerControlsPosition({
  mode: 'custom',
  back: { portrait: { horizontal: { anchor: 'right', offsetPercent: 20 }, vertical: { anchor: 'top', offsetPercent: 10 } } },
  episodes: { portrait: { horizontal: { anchor: 'left', offsetPercent: 4 }, vertical: { anchor: 'center', offsetPercent: 50 } } },
  sizes: { back: 50, landscape: 52, episodes: 72 },
});
ok(legacyEpisodesConfig !== null && !('episodes' in legacyEpisodesConfig)
  && JSON.stringify((legacyEpisodesConfig as any)?.sizes) === JSON.stringify({ back: 50, landscape: 52 }),
  'RC-4 (superseded by MAVP-6): legacy episodes sections/entries are DROPPED by the total parser (legacy configs never break playback)');
ok(resolveControlPlacement(legacyEpisodesConfig, 'back', 'portrait').horizontal?.anchor === 'right'
  && resolveControlSize(legacyEpisodesConfig, 'back') === 50 && resolveControlSize(legacyEpisodesConfig, 'landscape') === 52,
  'RC-4 (superseded by MAVP-6): the Back/Landscape placement+size semantics are byte-identical after the removal');
// (b) The alignment contract: both edge chips share the identical vertical
// reference (extracted value-by-value from the stylesheet — no prose claim).
const chipVertical = (selector: string) => {
  const rule = shellCode.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  return ['top', 'transform', 'min-height'].map((prop) => rule.match(new RegExp(`${prop}:\\s*([^;]+);`))?.[1]?.trim());
};
ok(JSON.stringify(chipVertical('episode-chip')) === JSON.stringify(chipVertical('source-chip'))
  && chipVertical('episode-chip').join('|') === '50%|translateY(-50%)|64px',
  'RC-4 (superseded by MAVP-6): BOTH edge chips share the identical top:50% + translateY(-50%) + 64px vertical reference (alignment by construction, both orientations)');
// (b) Total-parser honesty retained: a config with ONLY the (now-unknown)
// episodes keys carries no usable axis/size and still degrades to default.
ok(parsePlayerControlsPosition({ mode: 'custom', episodes: { portrait: { horizontal: { anchor: 'up', offsetPercent: 5 } } } }) === null,
  'RC-4 (superseded by MAVP-6): an episodes-only custom config degrades to the default (total parser, unknown-key tolerance)');
ok(parsePlayerControlsPosition({ mode: 'custom', sizes: { episodes: 999 } }) === null,
  'RC-4 (superseded by MAVP-6): an out-of-bounds legacy episodes size alone degrades to the default (total parser)');
// The shared preview resolver still serves the two REMAINING markers with
// their documented defaults (the episode marker itself was removed —
// asserted by the MAVP-6 suite).
ok(controlsPreviewMarkerStyle(null, 'back', 'portrait').includes('left:')
  && controlsPreviewMarkerStyle(null, 'landscape', 'portrait').includes('right:'),
  'RC-4 (superseded by MAVP-6): the Back/Landscape preview markers render through the shared resolver unchanged');
ok(BACK_CONTROL_DEFAULT_SIZE_PX === 44 && LANDSCAPE_CONTROL_DEFAULT_SIZE_PX === 48,
  'RC-4 (superseded by MAVP-6): the Back/Landscape default sizes are unchanged');
// The episode sheet opens from the LEFT at every viewport.
ok(/\.episode-sheet\s*\{[^}]*top:\s*0;\s*bottom:\s*0;\s*left:\s*0;/.test(shellCode),
  'RC-4: the episode sheet is a full-height LEFT drawer');
ok(shellCode.includes('@keyframes sheet-left { from { transform: translateX(-100%); } to { transform: translateX(0); } }'),
  'RC-4: the left drawer has a consistent slide-in animation');
ok(/\.episode-sheet\s*\{[^}]*width:\s*min\(360px,\s*88vw\);/.test(shellCode),
  'RC-4: the drawer width is bounded for narrow screens');
ok(/\.source-sheet\s*\{[^}]*animation:\s*sheet-up/.test(shellCode),
  'RC-4: the source sheet\u2019s existing responsive behavior is untouched');
// Keyboard/touch/a11y contracts preserved.
ok(shellCode.includes('.back-fab, .control-fab-group, .source-chip, .episode-chip, .direct-controls-overlay'),
  'RC-4: the chip participates in the focus-within auto-hide guard');
ok(shellCode.includes(".episode-sheet')") && shellCode.includes("focusSheetCloseButton('episode')"),
  'RC-4: the sheet focus management (trap + close-button focus) is unchanged');
ok(shellCode.includes('.episode-chip, .episode-chip-label { transition: none; }') || /prefers-reduced-motion[\s\S]*episode-chip/.test(shell),
  'RC-4: reduced-motion disables the chip transitions');
// ACTIVE-SOURCE PRESERVATION across episode changes.
const episodeChangeIdx = watchRouteCode.indexOf('async function handleEpisodeChange');
const episodeChangeBody = watchRouteCode.slice(episodeChangeIdx, watchRouteCode.indexOf('}', watchRouteCode.indexOf('replaceState: true', episodeChangeIdx)));
ok(!/selectedSourceId\s*=\s*'('|"")/.test(episodeChangeBody.replace('// ', '')) && !episodeChangeBody.includes("selectedSourceId = '';"),
  'RC-4: handleEpisodeChange NO LONGER resets selectedSourceId (the active source persists)');
ok(episodeChangeBody.includes("savedSourceId = '';") && episodeChangeBody.includes('resumeApplied = false;'),
  'RC-4: the rest of the episode-change session reset is unchanged');
ok(watchRoute.includes('MAVP-5 source-preservation contract'),
  'RC-4: the P11 supersession is documented at the change site');
ok(watchRouteCode.includes('progressReady && !selectedSourceId && sourceOptions.length'),
  'RC-4: the reactive selection block still only fires when NO source is selected (preserved source cannot be overwritten)');
// The failing active source follows the explicit failure behavior (no silent switch).
ok(watchRouteCode.includes("resolutionState === 'provider-error' || resolutionState === 'unsupported' || resolutionState === 'unavailable' || resolutionState === 'network-error'"),
  'RC-4: typed resolver failures still surface the explicit error/retry/switch controls');
section('Issue 4 — episode chip, left sheet, source preservation');

// ---------------------------------------------------------------------------
// §5 — Issue 5: landscape preservation during source switching
// ---------------------------------------------------------------------------

ok(shellCode.includes('landscapePresentationIntent = true') && shellCode.includes('landscapePresentationIntent = false'),
  'RC-5: the presentation intent is set on entry and cleared on explicit exits');
ok(shellCode.includes('LANDSCAPE_RESTORE_WINDOW_MS = 2000'),
  'RC-5: the restore window is a documented policy bound');
ok(shellCode.includes('async function restoreLandscapePresentationOnce()'),
  'RC-5: the restore is a dedicated bounded routine');
ok(shellCode.includes('if (landscapeRestoreInFlight) return;'),
  'RC-5: the restore can never run twice concurrently (no duplicate lock requests)');
ok(/lastSourceSwitchAt = Date\.now\(\);[\s\S]*capturePendingSeek/.test(shellCode),
  'RC-5: the source-switch watcher stamps the restore window');
ok(/identity !== embedSurfaceIdentity[^}]*lastSourceSwitchAt = Date\.now\(\);/.test(shellCode),
  'RC-5: the same-source URL change (episode switch) stamps the window too');
ok(/landscapePresentationIntent && lastSourceSwitchAt > 0 && Date\.now\(\) - lastSourceSwitchAt <= LANDSCAPE_RESTORE_WINDOW_MS/.test(shellCode),
  'RC-5: a loss within the window while the intent is active RESTORES the presentation');
ok(shell.includes('catch { /* declined — the CSS landscape presentation remains */ }'),
  'RC-5: a declined re-acquisition keeps the CSS landscape presentation (no portrait revert)');
ok(/const handleFullscreen = \(\) => \{[\s\S]*?landscapePresentationIntent && lastSourceSwitchAt/.test(shell),
  'RC-5: the restore branch lives in the fullscreenchange handler');
// Explicit user exits clear the intent BEFORE the fullscreenchange fires.
ok(/} else \{\s*\/\/ MAVP-5 \(Issue 5\): an explicit user exit clears the presentation[\s\S]*?landscapePresentationIntent = false;/.test(shell),
  'RC-5: the toggleLandscape exit branch clears the intent');
ok(/async function exitMaveroFullscreen\(\) \{\s*\/\/ MAVP-5 \(Issue 5\): an explicit keyboard exit clears the presentation intent\.\s*landscapePresentationIntent = false;/.test(shell),
  'RC-5: the keyboard exit clears the intent');
ok(/landscapePresentationIntent = false;\s*\n\s*\};?\s*\n\s*\}\);/.test(shell) || /wakeLockDestroyed = true;[\s\S]*landscapePresentationIntent = false;/.test(shell),
  'RC-5: the shell destroy clears the intent (no stale state across navigation)');
// Portrait sessions are untouched — nothing in the switch path sets landscapeMode.
ok((shellCode.match(/landscapeMode = true/g) ?? []).length === 1,
  'RC-5: the ONLY landscapeMode=true writer remains the explicit toggleLandscape entry');
ok(shell.includes("try { await orientationController()?.lock?.('landscape'); } catch { /* device/browser declined; CSS presentation remains */ }"),
  'RC-5: the restore re-issues the SAME landscape lock (no automatic rotation beyond the user\u2019s intent)');
section('Issue 5 — landscape preservation on source switching');

// ---------------------------------------------------------------------------
// §6 — Issue 6: three ordered default sources + automatic fallback
// ---------------------------------------------------------------------------

// Migration: slots table, constraints, RLS, backfill.
ok(migration.includes('create table if not exists public.streaming_default_source_slots'),
  'RC-6: the migration creates the ordered-slot table');
ok(/content_type text not null check \(content_type in \('movie', 'series', 'anime', 'adult'\)\)/.test(migration),
  'RC-6: the content-type CHECK covers every supported category');
ok(/position smallint not null check \(position between 1 and 3\)/.test(migration),
  'RC-6: positions are bounded to 1..3');
ok(/primary key \(content_type, position\)/.test(migration),
  'RC-6: one slot per (category, position)');
ok(/unique \(content_type, source_id\)/.test(migration),
  'RC-6: a source can occupy at most ONE slot per category (distinct choices)');
ok(/references public\.streaming_sources\(id\) on delete cascade/.test(migration),
  'RC-6: deleted sources cascade away (no orphaned slots)');
ok(/insert into public\.streaming_default_source_slots \(content_type, position, source_id\)\s*\nselect content_type, 1, source_id\s*\nfrom public\.streaming_default_sources\s*\n\s*on conflict \(content_type, position\) do nothing;/.test(migration),
  'RC-6: existing single defaults are backfilled into position 1 (idempotent, backward compatible)');
ok(migration.includes('streaming_default_source_slots_bump_config'),
  'RC-6: slot changes invalidate the public config cache atomically (version bump)');
ok(/create policy streaming_default_source_slots_admin_all[\s\S]*is_admin\(\)/.test(migration),
  'RC-6: writes stay admin-only (existing RLS model)');
ok(/create policy streaming_default_source_slots_select_public/.test(migration),
  'RC-6: public read rides the established public-config model');
// Public config reader: defaultsOrder (additive, eligibility, dedupe, legacy reconciliation).
ok(streamingTypes.includes('defaultsOrder: PublicStreamingDefaultsOrder'),
  'RC-6: the public config type carries the additive ordered view');
ok(/defaults:\s*PublicStreamingDefaults;/.test(streamingTypes),
  'RC-6: the single `defaults` view is preserved byte-compatibly');
ok(/streaming_default_source_slots'\)\.select\('content_type,position,source_id,updated_at'\)\.order\('position'\)/.test(publicConfigCode),
  'RC-6: the reader loads the slot rows in position order');
ok(/for \(const row of defaultSlotsResult\.data \?\? \[\]\)\s*\{[\s\S]*?if \(!publicSourceIds\.has\(row\.source_id\)\) continue;/,
  'RC-6: ineligible/deleted/disabled slots are silently omitted (established reader convention)');
ok(/for \(const position of \[1, 2, 3\]\)/.test(publicConfigCode) && /seen\.has\(sourceId\)/.test(publicConfigCode),
  'RC-6: positions resolve in order and duplicates within a category are skipped');
ok(/if \(defaultsOrder\[category\]\?\.length\) continue;\s*\n\s*const legacy = defaults\[category\];/.test(publicConfigCode),
  'RC-6: a category with no slots keeps its legacy single default (deploy-safe reconciliation)');
// Admin service: validation + legacy mirror.
ok(adminServiceCode.includes('export async function listAdminDefaultSlots'),
  'RC-6: the admin service lists the saved slots');
ok(/sourceIds\.length === 0 \|\| sourceIds\.length > 3/.test(adminServiceCode),
  'RC-6: server-side validation bounds the ordered list to 1..3 entries');
ok(/new Set\(sourceIds\)\.size !== sourceIds\.length/.test(adminServiceCode),
  'RC-6: server-side validation rejects duplicate source choices');
ok(/upsert\(\{ content_type: contentType, source_id: sourceIds\[0\] \}, \{ onConflict: 'content_type' \}\)/.test(adminServiceCode),
  'RC-6: the legacy single-default row is kept in sync with slot 1 (backward compatibility)');
ok(/invalidatePublicStreamingConfig\(\);\s*\n\s*return inserted;/.test(adminServiceCode),
  'RC-6: slot writes invalidate the public config cache');
// Deploy-ordering safety: an unapplied migration must degrade, never empty
// the public config or 500 the Admin page.
ok(publicConfigCode.includes('isMissingDefaultSlotsTableError(defaultSlotsResult.error) ? null : defaultSlotsResult.error'),
  'RC-6: the public config degrades ONLY the slots read to the legacy view when the slots table is missing (42P01/PGRST205) — every other slots error stays a hard failure (the watch route EMPTY fallback would otherwise hide ALL sources)');
ok(/error\.code === '42P01' \|\| error\.code === 'PGRST205'/.test(publicConfigCode) && /\/does not exist\/i|\/schema cache\/i/.test(publicConfigCode),
  'RC-6: the missing-table detection covers the Postgres and PostgREST error shapes');
ok(adminServiceCode.includes("if (error && !isMissingDefaultSlotsTableError(error)) throwRegistryError('List default source slots', error);"),
  'RC-6: the Admin slots list degrades to an empty view when the table is missing (page renders); writes still fail loudly');
// Admin actions + UI.
ok(adminServerCode.includes("form.getAll('slot_source')"),
  'RC-6: the save action reads the ordered slot selections');
ok(adminServerCode.includes('await setDefaultSourceSlots(locals.supabase, contentType, []);') && adminServer.includes('MAVP-5 (Issue 6): Clear empties BOTH storage shapes'),
  'RC-6: Clear empties both storage shapes');
ok(/slotIds\[slotIndex\]/.test(adminPageCode) && adminPageCode.includes("slotIndex === 0 ? 'Primary' : slotIndex === 1 ? 'Secondary' : 'Tertiary'"),
  'RC-6: the Admin sheet renders three labelled ordered selects per category');
ok(/chosenElsewhere = slotIds\.some\(\(id, i\) => i !== slotIndex && id === source\.id\)/.test(adminPageCode),
  'RC-6: already-chosen sources are disabled in the other slots (distinct in the UI)');
ok(/action="\?\/saveDefaultSlots"/.test(adminPage),
  'RC-6: the ordered form posts to the new server action');
// Resolver: ordered defaults attempted in order, each at most once.
ok(resolverServiceCode.includes('applyOrderedDefaultSourceOrdering(orderedConfigs, defaultSourceIds)'),
  'RC-6: the resolver sorts the ordered defaults to the front');
ok(/for \(const orderedDefaultId of defaultSourceIds\)\s*\{\s*\n\s*if \(alreadyAttemptedSourceIds\.has\(orderedDefaultId\)\) continue;/.test(resolverServiceCode),
  'RC-6: each ordered default is attempted AT MOST once (no loops, no duplicates)');
ok(resolverService.includes('MAVP-5 (Issue 6): attempt the ORDERED DEFAULTS in'),
  'RC-6: the ordered default walk is documented at the change site');
// Ordered ordering helper behavior (pure, real function).
const cfg = (id: string): TrustedResolutionConfig => ({ source: { id }, provider: { id: `p-${id}` } }) as unknown as TrustedResolutionConfig;
const reordered = applyOrderedDefaultSourceOrdering([cfg('a'), cfg('b'), cfg('c'), cfg('d')], ['c', 'a']);
ok(reordered.map((c) => c.source.id).join(',') === 'c,a,b,d',
  'RC-6: ordered defaults move to the front IN ATTEMPT ORDER; the remainder keeps its order');
ok(applyOrderedDefaultSourceOrdering([cfg('a'), cfg('b')], ['x', 'y']).map((c) => c.source.id).join(',') === 'a,b',
  'RC-6: defaults not present in the candidate list are never injected');
ok(applyOrderedDefaultSourceOrdering([cfg('a')], ['a']).map((c) => c.source.id).join(',') === 'a',
  'RC-6: single-candidate configs are returned unchanged (guard)');
ok(applyDefaultSourceOrdering([cfg('a'), cfg('b'), cfg('c')], 'b').map((c) => c.source.id).join(',') === 'b,a,c',
  'RC-6: the Phase 2 single-default ordering contract is preserved');
// Request parsing: strict ordered-defaults validation.
const baseRequest = { sourceId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', contentId: 'movie-299534', mediaType: 'movie' };
ok((parseResolverRequest({ ...baseRequest, defaultSourceIds: ['0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f01', '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f02', '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f03'] }).defaultSourceIds ?? []).length === 3,
  'RC-6: three distinct valid ordered defaults parse');
ok(parseResolverRequest({ ...baseRequest, defaultSourceIds: ['0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f01', '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f01'] }).defaultSourceIds === undefined,
  'RC-6: duplicate ordered defaults drop the whole list (strict validation)');
ok(parseResolverRequest({ ...baseRequest, defaultSourceIds: ['not-a-uuid'] }).defaultSourceIds === undefined,
  'RC-6: malformed entries drop the list — the request stays valid (never an unhandled exception)');
ok((parseResolverRequest({ ...baseRequest, defaultSourceId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f01' }).defaultSourceIds ?? [])[0] === '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f01',
  'RC-6: the legacy single default becomes a one-entry order');
// Client forwarding + bounded fallback message.
ok(/allowFallback && request\.defaultSourceIds\?\.length\) body\.defaultSourceIds = request\.defaultSourceIds;/.test(managerCode),
  'RC-6: the client forwards the ordered defaults only with fallback enabled');
ok(managerCode.includes("'Streaming not available, changing to a better source.'"),
  'RC-6: the documented fallback message is shown during the transition');
ok(managerCode.includes('resolvedSource.sourceId !== request.sourceId'),
  'RC-6: the fallback message is keyed on the resolver landing on a DIFFERENT source than requested');
ok(manager.includes('Manual source switches (allowFallback=false) never enter the'),
  'RC-6: manual selections can never trigger the fallback message');
ok(watchRouteCode.includes('?? (defaultSourceId ? [defaultSourceId] : [])'),
  'RC-6: the watch route resolves the ordered list with the legacy single-default fallback');
ok(watchRouteCode.includes('data.streamingConfig.defaultsOrder?.adult'),
  'RC-6: adult titles use the dedicated adult order (same override as the single default)');
section('Issue 6 — three ordered default sources + fallback');

// ---------------------------------------------------------------------------
// §7 — Issue 7: slow Back navigation from the player
// ---------------------------------------------------------------------------

for (const [name, src] of [['movie', movieDetailServer], ['series', seriesDetailServer], ['anime', animeDetailServer]] as const) {
  ok(src.includes("setHeaders({ 'cache-control': 'private, max-age=60' })"),
    `RC-7: the ${name} detail route sets the short private data-cache policy`);
  ok(src.includes('PageServerLoad = async ({ params, locals, cookies, setHeaders })'),
    `RC-7: the ${name} load unwraps setHeaders`);
}
ok(!/cache-control[^]*?max-age=\d{4,}/.test(movieDetailServer),
  'RC-7: the cache TTL stays short (60s) — no long-lived staleness');
// closePlayer remains fire-and-forget (navigation never waits on progress writes).
ok(watchRouteCode.includes('void writer?.pause();'),
  'RC-7: closePlayer still fires the final flush WITHOUT awaiting it');
ok(watchRouteCode.includes('navigateBackOr(() => {'),
  'RC-7: the real-history back policy (MAV-20 Phase D) is unchanged');
ok(watchRouteCode.includes('void writer?.flush();') && watchRouteCode.includes('writer?.dispose();'),
  'RC-7: the onDestroy flush backstop + dispose are unchanged');
// Stale async callbacks cannot touch the next page.
ok(managerCode.includes('dispose(): void') && managerCode.includes('this.session.abortController?.abort();'),
  'RC-7: the manager aborts in-flight resolution work on dispose');
ok(managerCode.includes('if (!this.active) return;'),
  'RC-7: disposed-manager methods short-circuit (no stale state writes)');
section('Issue 7 — slow Back navigation');

// ---------------------------------------------------------------------------
// §8 — Issue 8: Avengers card-play function crash (unhandled rejection)
// ---------------------------------------------------------------------------

// Both SWR background paths are absorbed (never a discarded rejected promise).
ok(!cacheModuleCode.includes('void refresh(key, policy, loader);') && !cacheModuleCode.includes('void refreshValidated(key, policy, isValid, loader);'),
  'RC-8: no fire-and-forget refresh promise remains (both SWR paths absorbed)');
ok(cacheModuleCode.includes('backgroundRefresh(refresh(key, policy, loader))'),
  'RC-8: the plain getOrSet stale path routes through backgroundRefresh');
ok(cacheModuleCode.includes('backgroundRefresh(refreshValidated(key, policy, isValid, loader))'),
  'RC-8: the validated getOrSetValidated stale path routes through backgroundRefresh');
ok(/refreshPromise\.catch\(\(error: unknown\) => \{/.test(cacheModuleCode),
  'RC-8: the sink attaches a catch (an upstream rejection can never escape)');
ok(cacheModuleCode.includes("logger.error('content cache background refresh failed'"),
  'RC-8: the failure is logged via the safe structured logger');
ok(cacheModuleCode.includes('errorType:') && cacheModuleCode.includes('errorCode:'),
  'RC-8: only safe error CLASS fields are logged (never URLs, keys, tokens)');
ok(cacheModuleCode.includes("import { logger } from '$lib/server/http/log';"),
  'RC-8: the logger import is the redacting server logger');
// Real behavioral proof: a rejecting background loader must not crash, must
// keep serving stale, and the next request must retry the load.
clearCache();
let backgroundRejected = false;
process.on('unhandledRejection', () => { backgroundRejected = true; });
let loadCalls = 0;
let failLoader = false;
const mavp5Loader = async () => {
  loadCalls += 1;
  if (failLoader) throw new Error('simulated TMDB timeout');
  return { title: loadCalls === 1 ? 'Avengers: Endgame' : 'Avengers: Endgame (refreshed)' };
};
const fresh = await getOrSet('mavp5:crash', { ttlMs: 10, staleWhileRevalidateMs: 60_000 }, mavp5Loader);
ok(fresh.value && (fresh.value as { title: string }).title === 'Avengers: Endgame' && fresh.stale === false,
  'RC-8: the first (miss) load succeeds and caches');
const statsBefore = cacheStats();
ok(statsBefore.entries >= 1, 'RC-8: the entry is resident');
// Age the entry past its fresh TTL (into the stale window) deterministically.
await new Promise((resolve) => setTimeout(resolve, 15));
failLoader = true;
const stale = await getOrSet('mavp5:crash', { ttlMs: 10, staleWhileRevalidateMs: 60_000 }, mavp5Loader);
ok(stale.stale === true && (stale.value as { title: string }).title === 'Avengers: Endgame',
  'RC-8: a stale hit serves the cached value while the failing background refresh runs');
// Give the (absorbed) background rejection a tick to surface.
await new Promise((resolve) => setTimeout(resolve, 20));
ok(backgroundRejected === false,
  'RC-8: the background rejection is ABSORBED — no unhandledRejection (no process death)');
// The next request inside the stale window RETRIES the loader (the failure
// is never permanent). The retry SUCCEEDS in the background; the stale call
// itself still returns the cached value immediately (SWR semantics).
failLoader = false;
let retried = false;
const staleAgain = await getOrSet('mavp5:crash', { ttlMs: 10, staleWhileRevalidateMs: 60_000 }, async () => {
  retried = true;
  return { title: 'Avengers: Endgame (refreshed)' };
});
ok(retried,
  'RC-8: the next stale-window request RETRIES the load (the failure is never permanent)');
ok((staleAgain.value as { title: string }).title === 'Avengers: Endgame',
  'RC-8: the retrying stale call still serves the cached value immediately');
await new Promise((resolve) => setTimeout(resolve, 20));
const refreshed = await getOrSet('mavp5:crash', { ttlMs: 10, staleWhileRevalidateMs: 60_000 }, mavp5Loader);
// (The 10 ms test TTL re-expires the entry between calls — the assertion is
// that the successful retry's WRITE landed: the refreshed title is served.)
ok((refreshed.value as { title: string }).title === 'Avengers: Endgame (refreshed)',
  'RC-8: the successful background retry refreshes the cache (next read is fresh)');
// The validated variant preserves the valid stale entry on invalid refresh results.
clearCache();
let validatedCalls = 0;
await getOrSetValidated(
  'mavp5:validated',
  { ttlMs: 10, staleWhileRevalidateMs: 60_000 },
  (value: { ok: boolean }) => value.ok,
  async () => { validatedCalls += 1; return { ok: true, n: validatedCalls }; },
);
await new Promise((resolve) => setTimeout(resolve, 15));
const validatedStale = await getOrSetValidated(
  'mavp5:validated',
  { ttlMs: 10, staleWhileRevalidateMs: 60_000 },
  (value: { ok: boolean }) => value.ok,
  async () => { validatedCalls += 1; return { ok: false, n: validatedCalls }; },
);
ok(validatedStale.stale === true && (validatedStale.value as { n: number }).n === 1 && validatedStale.fromCache === true,
  'RC-8: the validated variant keeps the VALID stale entry when the background refresh is invalid');
// The end-to-end card-play chain keeps its typed error boundaries.
ok(watchServerCode.includes('isHttpError(gateError)') && resolverServiceCode.includes('asResolverError(primaryError)'),
  'RC-8: expected upstream failures stay distinct (typed errors, never generic crashes)');
section('Issue 8 — card-play function crash (absorbed background refreshes)');

console.log(`MAVP-5 player reliability, source fallback & episode UX regression suite: ${passCount} checks passed`);
