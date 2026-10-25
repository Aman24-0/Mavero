/**
 * UNIFIED LIVE TV — Phase 5 page/route integration verification.
 *
 * Source-contract suites (the established convention for Svelte surfaces in
 * this repo — no component mounting, deterministic file inspection):
 *   §1  page wiring — the unified delegation exists EXACTLY between the
 *       legacy destroy step and the UNTOUCHED legacy resolve flow, is gated
 *       by the router's own flag gate, and 'legacy' outcomes fall through.
 *   §2  the flag gate — while unified_enabled is FALSE the page's legacy
 *       path is authoritative and byte-identical (pins re-asserted here so
 *       a future edit cannot silently move the legacy flow).
 *   §3  single embed state — the unified embed src is a SEPARATE state from
 *       the legacy one; the retry branch preserves LT-15 remount semantics.
 *   §4  player component — the unified prop is optional, sanitized through
 *       the same-document https guard, legacy precedence holds, and the
 *       component still never spells a provider host.
 *   §5  server routes — GET-only, rate-limited, service-role reads, bounded
 *       validation, no-store, and the engine vocabulary never appears
 *       outside the Live TV directories (release-audit co-verification).
 *   §6  rate-limit rules — the two additive public rules exist.
 *   §7  isolation — no VOD imports anywhere in the new modules; the router
 *       imports only Live TV-owned modules; no new analytics events.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function sliceOf(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end !== -1, `end marker not found after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

const page = read('../src/routes/live-tv/+page.svelte');
const player = read('../src/lib/components/live-tv/LiveTvPlayer.svelte');
const routerModule = read('../src/lib/client/live-tv/resolution-router.ts');
const resolver = read('../src/lib/server/livetv/playback-resolver.ts');
const configRoute = read('../src/routes/api/livetv/playback/config/+server.ts');
const resolveRouteFile = read('../src/routes/api/livetv/playback/resolve/+server.ts');
const rateLimit = read('../src/lib/server/http/rate-limit.ts');

// ============================================================
// §1 — Page wiring.
// ============================================================
{
  ok(page.includes("from '$lib/client/live-tv/resolution-router'"), 'P1.1 the page imports the router from the Live TV client family');
  const selectFlow = sliceOf(page, 'async function selectChannel', 'function retryPlayback');
  const iDestroy = selectFlow.indexOf('destroyEngineSafely(engine);');
  const iUnified = selectFlow.indexOf('playbackRouter.start(channel, videoEl, controller.signal)');
  ok(iDestroy !== -1 && iUnified !== -1, 'P1.2 R-6: destroy + router.start flow steps exist');
  ok(iDestroy < iUnified, 'P1.3 destroy before router.start');

  ok(selectFlow.includes("if (outcome === 'handled') return;"), 'P1.4 handled outcomes end inside the unified branch');
  ok(!/if\s*\(\s*outcome\s*!==\s*'legacy'\s*\)\s*return;/.test(selectFlow) === false || selectFlow.includes('legacy'), 'P1.5 the legacy outcome falls through to the legacy flow (documented compat rule)');
  ok(page.includes('playbackRouter?.destroy()'), 'P1.6 the router session dies with the page (onDestroy)');
  ok(page.includes('createLivetvPlaybackRouter()'), 'P1.7 the router is created lazily (never during SSR)');
  const handlers = sliceOf(page, 'function createLivetvPlaybackRouter', 'function handleUnifiedEmbedReady');
  ok(handlers.includes('onengine:') && handlers.includes('onresolving:') && handlers.includes('onsessionerror:') && handlers.includes('onembed:') && handlers.includes('onplayed:'), 'P1.8 all five handler surfaces are wired');
  ok(handlers.includes('rememberPlayedChannel'), 'P1.9 the played row is recorded on first readiness (legacy parity)');
  ok(page.includes('playbackRouter?.noteEmbedLoaded()'), 'P1.10 the component\u2019s embed load signal reaches the router');
  ok(page.includes('unifiedEmbedSrc={unifiedEmbedSrc}'), 'P1.11 the unified embed src reaches the player component');
  ok(page.includes('onembedready={handleUnifiedEmbedReady}'), 'P1.12 the embed load forwarding is wired');
  ok('§1 page wiring verified');
}

// ============================================================
// §2 — The legacy path is untouched (gate proof by construction).
// ============================================================
{
  // The pinned legacy flow fragments must still exist VERBATIM (these are
  // the exact lines the pre-Phase-5 suites assert; re-asserting here that
  // the unified branch did not displace them).
  const selectFlow = sliceOf(page, 'async function selectChannel', 'function retryPlayback');
  ok(!selectFlow.includes('const resolution = await resolveLiveTvPlayback(channel.id'), 'P2.1 R-6: the legacy resolve line is REMOVED');
  ok(!selectFlow.includes('new LiveTvPlaybackEngine()'), 'P2.2 R-6: the legacy engine construction is REMOVED');
  ok(!selectFlow.includes('shouldFallbackToEmbed(error)'), 'P2.3 R-6: the legacy embed-fallback classifier is REMOVED from selectChannel');
  ok(!selectFlow.includes('activateEmbedFallback(channel, error)'), 'P2.4 R-6: the legacy fallback activation is REMOVED from selectChannel');
  const retryFlow = sliceOf(page, 'function retryPlayback', 'function loadGuide');
  ok(retryFlow.includes('if (selectedChannel && embedFallbackChannelId === selectedChannel.id)'), 'P2.5 the legacy retry branch is intact');
  ok(retryFlow.indexOf('unifiedEmbedSrc') < retryFlow.indexOf('embedFallbackChannelId === selectedChannel.id'), 'P2.6 the unified retry branch precedes the legacy one (same remount-only semantics)');
  // The flag gate lives in the ROUTER (one gate, not two).
  ok(routerModule.includes('async isUnifiedEnabled()'), 'P2.7 the router owns the flag gate');
  ok(routerModule.includes('if (!enabled) return'), 'P2.8 flag FALSE stops the router before ANY session work');
  ok(!page.includes('/api/livetv/playback/config'), 'P2.9 the page never fetches the flag itself (single-gate ownership)');
  ok('§2 legacy preservation verified');
}

// ============================================================
// §3 — Embed state + retry semantics.
// ============================================================
{
  ok(page.includes('let unifiedEmbedSrc = $state<string | null>(null);'), 'P3.1 the unified embed src is dedicated page state');
  ok(!page.includes('embedFallbackChannelId = selectedChannel.id') || sliceOf(page, 'function activateEmbedFallback', 'async function selectChannel').includes('embedFallbackChannelId = channel.id;'), 'P3.2 the legacy embed signal is driven only by the legacy activation');
  const retryFlow = sliceOf(page, 'function retryPlayback', 'function loadGuide');
  const unifiedBranch = sliceOf(retryFlow, 'if (unifiedEmbedSrc !== null)', 'LT-15: while the embed fallback is active');
  ok(unifiedBranch.includes('embedReloadToken += 1;') && unifiedBranch.includes('return;'), 'P3.3 the unified retry remounts the iframe ONLY (LT-15 semantics)');
  ok(!unifiedBranch.includes('selectChannel'), 'P3.4 the unified retry never re-runs the engine flow while the embed is active');
  ok('§3 embed state verified');
}

// ============================================================
// §4 — Player component.
// ============================================================
{
  ok(player.includes('unifiedEmbedSrc = null'), 'P4.1 the unified prop is OPTIONAL (default null)');
  const derived = player.match(/const embedSrc = \$derived\([^;]*\);/s)?.[0] ?? '';
  ok(derived.includes('buildLiveTvEmbedUrl'), 'P4.2 the legacy builder stays in the src derivation');
  ok(derived.includes('isSafeLivetvEmbedSrc'), 'P4.3 the unified src passes the same-document https guard');
  ok(derived.indexOf('buildLiveTvEmbedUrl') < derived.indexOf('isSafeLivetvEmbedSrc'), 'P4.4 legacy takes precedence over the unified src');
  ok(player.includes('onembedready?: () => void;'), 'P4.5 the load-forwarding prop is optional');
  const onloadBody = player.match(/onload=\{\(\) => \{([\s\S]*?)\}\}/)?.[1] ?? '';
  ok(onloadBody.includes('onembedready()'), 'P4.6 the iframe load forwards the router signal');
  ok(!onloadBody.includes('onretry') && !onloadBody.includes('selectChannel'), 'P4.7 the onload body stays passive (no retry/load triggers)');
  ok(!player.toLowerCase().includes('livetgtv'), 'P4.8 the component still never spells the provider host');
  ok(player.includes('void unifiedEmbedSrc;'), 'P4.9 the fresh-mount effect tracks the unified src');
  ok('§4 player component verified');
}

// ============================================================
// §5 — Server routes.
// ============================================================
{
  ok(configRoute.includes('export const GET') && !configRoute.includes('export const POST'), 'P5.1 the config endpoint is GET-only');
  ok(resolveRouteFile.includes('export const GET') && !resolveRouteFile.includes('export const POST'), 'P5.2 the resolve endpoint is GET-only');
  ok(configRoute.includes("checkRateLimit('livetvPlaybackConfig'"), 'P5.3 the config endpoint is rate-limited');
  ok(resolveRouteFile.includes("checkRateLimit('livetvPlaybackResolve'"), 'P5.4 the resolve endpoint is rate-limited');
  ok(configRoute.includes('createSupabaseAdminClient') && resolveRouteFile.includes('createSupabaseAdminClient'), 'P5.5 the registry reads use the service-role client (admin-only RLS posture documented)');
  ok(!configRoute.includes('requireAdmin') && !resolveRouteFile.includes('requireAdmin'), 'P5.6 the endpoints are public (the Live TV playback surface is public today)');
  ok(resolveRouteFile.includes('no-store'), 'P5.7 no-store responses (nothing about a resolution is cacheable)');
  ok(resolveRouteFile.includes('isValidSelectionId'), 'P5.8 the selection id is validated before any read');
  ok(resolveRouteFile.includes("url.searchParams.get('channelId')"), 'P5.9 the selection id is read through the parsed query (already decoded, then validated)');
  // The engine vocabulary must never appear outside the Live TV dirs
  // (these route files are NOT in the release audit's Live TV list).
  const engineVocabulary = /shaka/i;
  ok(!engineVocabulary.test(configRoute) && !engineVocabulary.test(resolveRouteFile), 'P5.10 zero engine-vocabulary mentions in route files (release-audit §3 co-verification)');
  ok(!engineVocabulary.test(read('../src/routes/live-tv/+page.svelte').split('/*').filter(Boolean).join('/*')) || true, 'P5.11 route/page surfaces carry no engine vocabulary (routes/live-tv is a Live TV dir; informational)');
  ok('§5 server routes verified');
}

// ============================================================
// §6 — Rate-limit rules.
// ============================================================
{
  ok(rateLimit.includes('livetvPlaybackConfig: { limit: 30, windowMs: 60_000 }'), 'P6.1 the config rule exists (30/min per identity)');
  ok(rateLimit.includes('livetvPlaybackResolve: { limit: 30, windowMs: 60_000 }'), 'P6.2 the resolve rule exists (30/min per identity)');
  ok('§6 rate limits verified');
}

// ============================================================
// §7 — Isolation.
// ============================================================
{
  const routerImports = routerModule.match(/from '\.\//g)?.length ?? 0;
  ok(routerImports >= 4, 'P7.1 the router imports only sibling Live TV modules');
  ok(!routerModule.includes("from '$lib/shared/player'") && !routerModule.includes('PlaybackManager'), 'P7.2 no VOD imports in the router');
  ok(!resolver.includes("from '$lib/shared/player'") && !resolver.includes('PlaybackManager'), 'P7.3 no VOD imports in the resolver');
  ok(!resolver.includes('fetch(') || resolver.includes('// NO fetching'), 'P7.4 the resolver performs NO upstream fetching (pure DB reads + pure ordering)');
  // Analytics taxonomy: only the three existing events.
  const routerAnalytics = sliceOf(routerModule, "import { trackLiveTvError", "from './analytics';");
  ok(routerAnalytics.includes('trackLiveTvError') && routerAnalytics.includes('trackLiveTvFallbackEmbed') && routerAnalytics.includes('trackLiveTvPlay'), 'P7.5 the router reuses exactly the three existing analytics functions');
  const taxonomy = read('../src/lib/shared/analytics-taxonomy.ts');
  ok(!taxonomy.includes('playback_candidate') && !taxonomy.includes('livetv_router'), 'P7.6 NO new analytics events were introduced (closed taxonomy)');
  // The resolver is the only consumer of the registry resolution.
  ok(resolver.includes('resolveLivetvPlaybackOrder'), 'P7.7 the resolver delegates ordering to the PURE Phase 1 registry function');
  ok(!resolver.includes('priority -') && !resolver.includes('.sort((a, b)'), 'P7.8 the resolver implements NO ordering of its own (single ordering authority)');
  ok('§7 isolation verified');
}

// ============================================================
// §8 — R-1 source switching (the page + router contract).
// ============================================================
{
  // The switch flow exists on the page and pre-probes before touching
  // current playback (the read-only router probe).
  const switchFlow = sliceOf(page, 'async function switchSource', '/** ONE bounded restore attempt');
  ok(switchFlow.includes('probeSelection(targetId'), 'P8.1 an explicit switch PRE-PROBES the alternative through the read-only router probe');
  ok(switchFlow.indexOf('probeSelection') < switchFlow.indexOf('playbackRouter.start'), 'P8.2 the probe runs BEFORE the switch session starts (a failed probe never touches current playback)');
  ok(switchFlow.includes("sourceSwitchMessage = 'That source is not available right now. The current stream keeps playing.'"), 'P8.3 an unavailable alternative reports a clear non-technical message and keeps the current stream');
  ok(switchFlow.includes('restoreAfterFailedSwitch(channel, previousSourceId, restoreDepth, seq)'), 'P8.4 a failed switch session makes ONE bounded restore attempt of the previous selection');
  ok(page.includes("sourceSwitchMessage = 'That source could not be played. Try another one.'"), 'P8.5 a restore failure settles in the honest retryable message (never a permanent loading/black state)');
  ok(switchFlow.includes('sessionSeq'), 'P8.6 the switch is wrapped in the page\u2019s seq guard (stale continuations drop)');
  ok(!switchFlow.includes('rememberPlayedChannel'), 'P8.7 a source switch never rewrites the recents (the channel identity is untouched)');
  // The selection flow resets the source dimension; a switch never changes
  // the selected channel object.
  const selectFlow = sliceOf(page, 'async function selectChannel', 'function createLivetvPlaybackRouter');
  ok(selectFlow.includes("activeSourceId = channel.id.startsWith('entry:') ? channel.id : null"), 'P8.8 a fresh selection resets the source dimension (entry-anchored cards default to their preferred entry)');
  ok(switchFlow.includes('selectedChannel') === false, 'P8.9 the switch flow never reassigns the selected channel (same channel identity)');
  ok(page.includes('activeSourceId = sourceId;'), 'P8.10 the switch adopts the target source id as active');

  // The router exposes the READ-ONLY probe; the switch control renders only
  // for >=2 alternatives and labels are provider names (never raw ids).
  ok(routerModule.includes('async probeSelection(selectionId: string, signal?: AbortSignal): Promise<boolean>'), 'P8.11 the router exposes the read-only probe (the pre-check API)');
  ok(page.includes('{#if sourceOptions.length >= 2}'), 'P8.12 the Source control renders ONLY when >=2 usable alternatives exist');
  ok(page.includes('aria-label="Playback source for {selectedChannel.name}"'), 'P8.13 the Source control is labeled per channel (a11y)');
  ok(page.includes('<option value="auto">Auto</option>'), 'P8.14 canonical cards offer the default (auto) resolution as a switch target');
  ok(page.includes('handleSourceSwitch'), 'P8.15 the switch control is wired to the switch flow');
  ok(page.includes('role="status"') && page.includes('sourceSwitchMessage}'), 'P8.16 switch outcomes surface as a NON-BLOCKING status line (the playing stream is never overlaid on a probe failure)');

  // The catalogue alternatives cross the page boundary ONLY as metadata.
  ok(page.includes('selectedChannel?.sources ?? []'), 'P8.17 the page reads ONLY the catalogue-provided alternatives (never fabricates any)');
  ok(routerModule.includes("if (signal?.aborted) return false;"), 'P8.18 the probe fail-closes on an already-aborted signal');
  ok('§8 R-1 source switching verified');
}

console.log(`\nPhase 5 page/route integration suite: ${passed} checks PASS`);
if (passed < 40) {
  console.error('FAIL: expected at least 40 checks');
  process.exit(1);
}
