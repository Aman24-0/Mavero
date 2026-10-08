// MAVERO — LT-15 Automatic Embed Fallback: focused regression suite.
//
// Covers the LT-15 addition (documented LiveGT embed fallback after a
// GENUINE native Shaka playback failure) in the repo's two UI-phase styles:
//   * BEHAVIORAL sections drive the REAL pure modules under Node — the
//     embed-URL builder (api.ts), the fallback classifier (player-errors.ts)
//     and the analytics adapter — which also proves SSR safety (importing
//     the modules under Node is exactly what the SSR server does).
//   * SOURCE-CONTRACT sections assert the page/component wiring: single
//     activation point, identity-guarded stale-session protection, teardown
//     on channel switch, iframe recreation on retry, no Shaka<->iframe loop,
//     URL exactness and injection impossibility.
//
// The twelve directive-mandated cases map to sections as follows:
//   1 native success -> no iframe ............ §B1, §B2
//   2 native failure -> destroy + iframe ..... §B3
//   3 catalogue/API error -> no iframe ....... §A2, §B4
//   4 autoplay-blocked -> existing CTA ....... §A2, §B5
//   5 switch while failing -> no stale mount . §B6
//   6 switch while iframe active -> removed .. §B7
//   7 retry while embed active -> recreate ... §B8
//   8 no Shaka <-> iframe loop ............... §B9
//   9 exact documented embed URL ............. §A1
//  10 no arbitrary URL injection ............. §A1, §B10
//  11 SSR/build safety ........................ §A1, §B11
//  12 native channels unchanged .............. §B12 (+ gates: all existing
//                                               suites must stay green)
//
// NO network, browser, DRM or Shaka package is involved.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildLiveTvEmbedUrl } from '$lib/client/live-tv/api';
import {
  LiveTvPlaybackError,
  isLiveTvPlaybackError,
  shouldFallbackToEmbed,
  type LiveTvPlaybackErrorKind
} from '$lib/client/live-tv/player-errors';
import { LiveTvError } from '$lib/client/live-tv/errors';
import { analytics } from '$lib/client/analytics/dispatcher';
import { ANALYTICS_EVENT_NAMES, MEANINGFUL_ACTIVITY_EVENTS, isAnalyticsEventName } from '$lib/shared/analytics-taxonomy';
import { trackLiveTvFallbackEmbed } from '$lib/client/live-tv/analytics';

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const page = read('../src/routes/live-tv/+page.svelte');
const player = read('../src/lib/components/live-tv/LiveTvPlayer.svelte');
const apiSource = read('../src/lib/client/live-tv/api.ts');
const playerErrorsSource = read('../src/lib/client/live-tv/player-errors.ts');

function sliceOf(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end !== -1, `end marker not found after ${startMarker}`);
  return source.slice(start, end);
}

// ============================================================
// §A1 — The embed URL builder (behavioral; cases 9 + 10 + 11)
// ============================================================
{
  // Case 9: the URL is EXACTLY the documented pattern — trusted constant
  // base + validated numeric id, nothing else.
  assert.equal(buildLiveTvEmbedUrl('154'), 'https://livetgtv.lovable.app/embed/154');
  assert.equal(buildLiveTvEmbedUrl('143'), 'https://livetgtv.lovable.app/embed/143');
  assert.equal(buildLiveTvEmbedUrl('0'), 'https://livetgtv.lovable.app/embed/0');
  assert.equal(buildLiveTvEmbedUrl('12345678'), 'https://livetgtv.lovable.app/embed/12345678');

  // Case 10: no arbitrary URL can ever be injected — everything that is
  // not 1-8 plain decimal digits returns null (no iframe is mounted).
  const rejected: unknown[] = [
    '', ' ', ' 154', '154 ', '15 4', 'a154', '154a', '15.4', '15-4', '+154', '-1',
    '154?x=1', '154#f', '154/extra', '../154', 'javascript:alert(1)', 'data:text/html,x',
    '0x1f', '١٥٤', '123456789', '1234567890123456',
    null, undefined, 154, 15.4, true, {}, [], ['154'], { id: '154' }, NaN, Infinity
  ];
  for (const value of rejected) {
    assert.equal(buildLiveTvEmbedUrl(value as never), null, `rejects ${JSON.stringify(value) ?? String(value)}`);
  }
  // The builder is pure — same input, same output, no state.
  assert.equal(buildLiveTvEmbedUrl('154'), buildLiveTvEmbedUrl('154'));
  // The base is the api.ts constant, never a UI-side literal (§4 isolation):
  // the host exists exactly once in api.ts and NOWHERE else in the UI sources.
  assert.ok(apiSource.includes("'https://livetgtv.lovable.app'"), 'the base constant lives in api.ts');
  assert.ok(!player.includes('livetgtv'), 'the player component never spells the LiveGT host');
  assert.ok(!page.includes('livetgtv'), 'the page never spells the LiveGT host');
  // SSR safety (case 11): this suite imports the REAL api.ts module under
  // Node and just called its builder — proof it has no browser-only paths.
  ok('A1. builder: exact documented URL; everything non-numeric rejected; UI sources never spell the host');
}

// ============================================================
// §A2 — The fallback classifier (behavioral; cases 3 + 4)
// ============================================================
{
  const fatalKinds: LiveTvPlaybackErrorKind[] = [
    'invalid_source',
    'init_failed',
    'manifest_load_failed',
    'drm_config_failed',
    'drm_playback_failed',
    'network_failed',
    'unsupported_browser',
    'playback_failed'
  ];
  for (const kind of fatalKinds) {
    assert.equal(shouldFallbackToEmbed(new LiveTvPlaybackError(kind)), true, `${kind} IS a genuine native failure`);
  }
  // Case 4: autoplay-blocked is the existing tap-to-play product behavior —
  // the stream loaded; this is NOT a stream failure.
  assert.equal(shouldFallbackToEmbed(new LiveTvPlaybackError('autoplay_blocked')), false, 'autoplay_blocked never falls back');
  // Aborts are cancellations, never failures.
  assert.equal(shouldFallbackToEmbed(new LiveTvPlaybackError('aborted')), false, 'aborted never falls back');
  // Case 3: NO data-layer error ever qualifies (catalogue / resolution /
  // guide / search are all LiveTvError instances).
  const dataKinds = [
    'bad_request', 'invalid_response', 'not_found', 'no_playback_source', 'unsupported_drm',
    'network', 'timeout', 'aborted', 'server', 'rate_limited'
  ] as const;
  for (const kind of dataKinds) {
    const err = new LiveTvError(kind);
    assert.equal(shouldFallbackToEmbed(err), false, `LiveTvError ${kind} never falls back`);
  }
  // Unknown shapes: conservative default — no fallback.
  assert.equal(shouldFallbackToEmbed(new Error('anything')), false);
  assert.equal(shouldFallbackToEmbed('string error'), false);
  assert.equal(shouldFallbackToEmbed({ code: 6000, category: 6, severity: 2 }), false, 'raw Shaka-like objects never fall back (only normalized LT-3 errors)');
  assert.equal(shouldFallbackToEmbed(null), false);
  assert.equal(shouldFallbackToEmbed(undefined), false);
  // The classifier never inspects messages (the error model forbids it).
  assert.ok(!playerErrorsSource.slice(playerErrorsSource.indexOf('export function shouldFallbackToEmbed')).includes('.message'), 'classifier never reads .message');
  ok('A2. classifier: exactly the 8 fatal playback kinds; autoplay/aborts/data-layer/unknown never qualify');
}

// ============================================================
// §A3 — Analytics: one safe event, payload contract intact (behavioral)
// ============================================================
{
  // Taxonomy: the event exists, is ingestible, and is NOT meaningful
  // activity (activation is not a new engagement signal).
  assert.ok((ANALYTICS_EVENT_NAMES as readonly string[]).includes('live_tv_fallback_embed'), 'event in taxonomy');
  assert.equal(isAnalyticsEventName('live_tv_fallback_embed'), true, 'event passes the ingest gate');
  assert.ok(!MEANINGFUL_ACTIVITY_EVENTS.has('live_tv_fallback_embed'), 'activation is not meaningful activity');
  // Migration parity (the closed set is auditable): the union of every
  // taxonomy-extension migration must contain the event.
  const migrationSql =
    read('../supabase/migrations/20261103000000_live_tv_analytics_events.sql') +
    read('../supabase/migrations/20261104000000_live_tv_fallback_embed_event.sql');
  assert.ok(migrationSql.includes("'live_tv_fallback_embed'"), 'event in a migration CHECK constraint');
  const newMigration = read('../supabase/migrations/20261104000000_live_tv_fallback_embed_event.sql');
  assert.ok(!/create\s+table/i.test(newMigration), 'the new migration creates no tables');
  assert.ok(/alter table public\.analytics_events/.test(newMigration), 'the new migration only widens the CHECK');

  // Behavioral: the adapter emits channelId + normalized kind ONLY.
  type Recorded = { name: string; props: Record<string, unknown> };
  const recorded: Recorded[] = [];
  const dispatcher = analytics as unknown as { track: (name: string, props?: Record<string, unknown>) => void };
  const originalTrack = dispatcher.track.bind(analytics);
  dispatcher.track = (name: string, props?: Record<string, unknown>) => {
    recorded.push({ name, props: props ?? {} });
  };
  try {
    trackLiveTvFallbackEmbed('154', new LiveTvPlaybackError('drm_playback_failed', 6012));
    trackLiveTvFallbackEmbed('165', new LiveTvPlaybackError('manifest_load_failed', 1001));
  } finally {
    dispatcher.track = originalTrack;
  }
  assert.equal(recorded.length, 2, 'exactly one event per activation');
  for (const [i, entry] of recorded.entries()) {
    assert.equal(entry.name, 'live_tv_fallback_embed', `event ${i} name`);
    assert.deepEqual(Object.keys(entry.props).sort(), ['content_id', 'metadata'], `event ${i} payload keys`);
    assert.equal(typeof entry.props.content_id, 'string', `event ${i} content_id is the channel id`);
    const metadata = entry.props.metadata as Record<string, unknown>;
    assert.deepEqual(Object.keys(metadata), ['error_kind'], `event ${i} metadata keys`);
    assert.equal(typeof metadata.error_kind, 'string', `event ${i} normalized kind`);
  }
  assert.equal((recorded[0]?.props.metadata as Record<string, unknown>).error_kind, 'drm_playback_failed');
  assert.equal((recorded[1]?.props.metadata as Record<string, unknown>).error_kind, 'manifest_load_failed');
  const serialized = JSON.stringify(recorded);
  assert.ok(!/https?:\/\//.test(serialized), 'no URLs in any payload');
  assert.ok(!serialized.toLowerCase().includes('hdnea'), 'no tokens in any payload');
  assert.ok(!serialized.toLowerCase().includes('key'), 'no key material in any payload');
  ok('A3. analytics: taxonomy + migration widened; payload is channelId + normalized kind only');
}

// ============================================================
// §B1 — Single activation point (case 1: native success -> no iframe)
// ============================================================
{
  // activateEmbedFallback is DEFINED once and CALLED exactly once — from
  // the engine 'error' subscription. Nothing else can activate a fallback.
  const definitions = page.match(/function activateEmbedFallback\(/g) ?? [];
  assert.equal(definitions.length, 1, 'exactly one activateEmbedFallback definition');
  const calls = page.match(/activateEmbedFallback\(channel, error\)/g) ?? [];
  assert.equal(calls.length, 1, 'exactly one activation call site');
  const errorSubscription = sliceOf(page, "eng.on('error', (error) => {", '});');
  assert.ok(errorSubscription.includes('activateEmbedFallback(channel, error)'), 'the only call is inside the error subscription');
  assert.ok(errorSubscription.includes('if (engine !== eng) return;'), 'the subscription is identity-guarded BEFORE activating');
  assert.ok(errorSubscription.indexOf('if (engine !== eng) return;') < errorSubscription.indexOf('activateEmbedFallback'), 'identity guard precedes activation');
  // The embed state is assigned a channel id ONLY inside activateEmbedFallback.
  const assignments = page.match(/embedFallbackChannelId = [^;]+;/g) ?? [];
  const idAssignments = assignments.filter((a) => a.includes('channel.id'));
  assert.equal(idAssignments.length, 1, 'channel.id is assigned to the embed state in exactly one place');
  assert.ok(sliceOf(page, 'function activateEmbedFallback', 'async function selectChannel').includes('embedFallbackChannelId = channel.id;'), 'that place is activateEmbedFallback');
  // Success path: nothing in the load-success flow touches the embed state.
  const successFlow = sliceOf(page, 'await eng.load(videoEl, resolution', "} catch (err) {\n        if (seq !== sessionSeq");
  assert.ok(!successFlow.includes('embedFallback'), 'the load-success continuation never touches embed state');
  ok('B1. single activation point: the identity-guarded engine error subscription, and nothing else');
}

// ============================================================
// §B2 — The component mounts an iframe ONLY in fallback mode (cases 1+2)
// ============================================================
{
  // The iframe is rendered only inside {#if embedSrc}; embedSrc comes ONLY
  // from the builder applied to the prop (never a prop URL, never {@html}).
  assert.ok(!player.includes('{@html'), 'no {@html} anywhere in the player component');
  const iframes = player.match(/<iframe/g) ?? [];
  assert.equal(iframes.length, 1, 'exactly one iframe element in the component');
  const embedBlock = sliceOf(player, '{#if embedSrc}', '{/if}\n\n    {#if !embedActive && displayError}');
  assert.ok(embedBlock.includes('src={embedSrc}'), 'iframe src is the builder output only');
  assert.ok(embedBlock.includes('allow="autoplay; fullscreen; encrypted-media; picture-in-picture"'), 'documented allow list');
  assert.ok(embedBlock.includes('allowfullscreen'), 'documented allowfullscreen');
  assert.ok(embedBlock.includes('style="position:absolute;inset:0;width:100%;height:100%;border:0"'), 'documented responsive iframe style');
  // embedSrc derivation: builder(prop) only.
  const derived = player.match(/const embedSrc = \$derived\([^)]*\)/)?.[0] ?? '';
  assert.ok(derived.includes('buildLiveTvEmbedUrl'), 'embedSrc is derived through the builder');
  assert.ok(!/embedChannelId\s*}\s*"/.test(player), 'the raw prop is never interpolated into markup as a URL');
  // The video element is hidden (not removed) while the fallback is active.
  assert.ok(player.includes('class:embed-hidden={embedActive}'), 'the native video is hidden in fallback mode');
  assert.ok(player.includes('video.embed-hidden'), 'the hidden class exists');
  // Comment-free projection (the page-test convention): prose like
  // "the page-owned <video> element" must never count as a rendered tag.
  const playerNoComments = player
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
  const videoTags = playerNoComments.match(/<video[\s>]/g) ?? [];
  assert.equal(videoTags.length, 1, 'still exactly one <video> element (never removed)');
  const iframeTags = playerNoComments.match(/<iframe[\s>]/g) ?? [];
  assert.equal(iframeTags.length, 1, 'exactly one rendered iframe element');
  ok('B2. component: exactly one iframe, builder-derived src, documented markup, video hidden not removed');
}

// ============================================================
// §B3 — Activation destroys Shaka + mounts the iframe (case 2)
// ============================================================
{
  const activation = sliceOf(page, 'function activateEmbedFallback', 'async function selectChannel');
  assert.ok(activation.includes('if (embedFallbackChannelId !== null) return;'), 'set-once guard: never activate twice');
  const iDestroy = activation.indexOf('destroyEngineSafely(engine)');
  const iSet = activation.indexOf('embedFallbackChannelId = channel.id;');
  assert.ok(iDestroy !== -1 && iSet !== -1, 'destroy + state set both present');
  assert.ok(iDestroy < iSet, 'the Shaka engine is destroyed BEFORE the fallback takes over');
  assert.ok(activation.includes('resolving = false;'), 'pending resolution state is cleared');
  assert.ok(activation.includes('sessionErrorMessage = null;'), 'the native error message is suppressed');
  assert.ok(activation.includes('trackLiveTvFallbackEmbed(channel.id, err);'), 'activation is tracked (channel id + kind only)');
  // The load-failure catch defers to the already-active fallback instead of
  // double-reporting (the error event fired first).
  const loadFlow = sliceOf(page, 'await eng.load(videoEl, resolution', 'function retryPlayback');
  const catchStart = loadFlow.indexOf('} catch (err) {');
  const catchBody = loadFlow.slice(catchStart);
  assert.ok(catchBody.includes('if (embedFallbackChannelId === channel.id) return;'), 'the load catch never re-surfaces a fallback-handled failure');
  ok('B3. activation: set-once, engine destroyed first, error suppressed, tracked once');
}

// ============================================================
// §B4 — Catalogue / resolution / guide failures never mount (case 3)
// ============================================================
{
  // Catalogue flow: no embed references at all (slice to the search
  // section — the fallback functions live much later, next to
  // selectChannel, and are NOT part of this flow).
  const catalogueFlow = sliceOf(page, 'async function loadCatalogue', 'let query = $state');
  assert.ok(!catalogueFlow.includes('embedFallback') && !catalogueFlow.includes('activateEmbedFallback'), 'catalogue errors never touch the fallback');
  // Guide flow: independent of playback, no embed references.
  const guideFlow = sliceOf(page, 'async function loadGuide', 'function retryGuide');
  assert.ok(!guideFlow.includes('embedFallback') && !guideFlow.includes('activateEmbedFallback'), 'guide errors never touch the fallback');
  // The resolution-failure catch (outer, LT-2 errors): no activation —
  // shouldFallbackToEmbed returns false for LiveTvError by construction (§A2).
  const selectFlow = sliceOf(page, 'async function selectChannel', 'function retryPlayback');
  const outerCatch = selectFlow.indexOf('} catch (err) {', selectFlow.indexOf('const resolution = await resolveLiveTvPlayback'));
  assert.ok(outerCatch !== -1, 'resolution catch located');
  const outerBody = selectFlow.slice(outerCatch, selectFlow.indexOf('function retryPlayback'));
  assert.ok(!outerBody.includes('activateEmbedFallback'), 'resolution failures never activate the fallback');
  // Local search/category: pure filtering functions, no playback coupling.
  const localFlows = sliceOf(page, 'function applyCategory', 'function retryPlayback').slice(0, 2000);
  assert.ok(!localFlows.includes('activateEmbedFallback'), 'search/category never activates anything');
  ok('B4. catalogue, guide, resolution and local-filter flows are structurally fallback-free');
}

// ============================================================
// §B5 — Autoplay-blocked keeps the existing product behavior (case 4)
// ============================================================
{
  // Component: the tap-to-play CTA still exists and is NOT gated by embed
  // state in a way that could convert it into a failure...
  assert.ok(player.includes('autoplayBlocked'), 'autoplay state still exists');
  assert.ok(player.includes('Tap to play'), 'the tap-to-play CTA still exists');
  // ...and the component's autoplay path is untouched by embed logic
  // (attemptAutoplay lives in the player component).
  const autoplayFlow = sliceOf(player, 'async function attemptAutoplay', 'function togglePlay');
  assert.ok(autoplayFlow.includes("err.kind === 'autoplay_blocked'"), 'autoplay-blocked is still classified as a non-failure');
  assert.ok(autoplayFlow.includes('autoplayBlocked = true'), 'the stream stays loaded — the CTA, not an error');
  assert.ok(!autoplayFlow.includes('embedFallback') && !autoplayFlow.includes('embedActive'), 'autoplay handling has no embed coupling');
  // The engine 'error' subscription cannot see autoplay_blocked at all
  // (the component swallows it), and even if it did, §A2 proved the
  // classifier rejects it.
  ok('B5. autoplay-blocked remains the tap-to-play CTA; no embed coupling');
}

// ============================================================
// §B6 — A stale session can never mount a fallback (case 5)
// ============================================================
{
  // Identity guard: the error subscription drops events from an engine
  // that is no longer the page's current engine (switched away/destroyed).
  const errorSubscription = sliceOf(page, "eng.on('error', (error) => {", '});');
  assert.ok(errorSubscription.includes('if (engine !== eng) return;'), 'engine-identity guard present');
  // The activation itself is set-once — a second failure while a fallback
  // is already active is ignored (§B3 asserted the guard; here: nothing
  // else can overwrite a NEWER session's fallback either, because
  // selectChannel resets the state before any async work continues).
  const selectFlow = sliceOf(page, 'async function selectChannel', 'function retryPlayback');
  const iAbort = selectFlow.indexOf('sessionController?.abort();');
  const iDestroy = selectFlow.indexOf('destroyEngineSafely(engine);');
  const iReset = selectFlow.indexOf('embedFallbackChannelId = null;');
  const iResolve = selectFlow.indexOf('await resolveLiveTvPlayback');
  assert.ok(iAbort !== -1 && iDestroy !== -1 && iReset !== -1 && iResolve !== -1, 'switch steps present');
  assert.ok(iAbort < iDestroy && iDestroy < iReset && iReset < iResolve, 'switch order: abort -> destroy engine -> reset fallback -> resolve fresh');
  // And the load catch remains sequence-guarded (stale completions die).
  assert.ok(selectFlow.includes('if (seq !== sessionSeq || controller.signal.aborted'), 'seq + abort guards intact');
  ok('B6. stale engines cannot mount; switch resets fallback state before any new work');
}

// ============================================================
// §B7 — Switching away from an active fallback removes the iframe (case 6)
// ============================================================
{
  // The reset in selectChannel (asserted in §B6 ordering) drives the
  // component: embedChannelId becomes null -> embedSrc null -> the {#if
  // embedSrc} block unmounts -> the iframe is REMOVED from the DOM (a
  // destroyed iframe browsing context cannot keep playing).
  assert.ok(page.includes('embedChannelId={embedFallbackChannelId}'), 'the component receives the page fallback state');
  // onDestroy: the fallback dies with the page.
  const destroyFlow = sliceOf(page, 'onDestroy(() => {', '</script>');
  assert.ok(destroyFlow.includes('embedFallbackChannelId = null;'), 'onDestroy clears the fallback state');
  ok('B7. channel switch and page teardown both clear the fallback state (iframe unmounts)');
}

// ============================================================
// §B8 — Retry while the fallback is active recreates the iframe (case 7)
// ============================================================
{
  const retryFlow = sliceOf(page, 'function retryPlayback', '// ---------------------------------------------------------------------\n  // Guide state');
  const iEmbedBranch = retryFlow.indexOf('if (selectedChannel && embedFallbackChannelId === selectedChannel.id)');
  const iSelectCall = retryFlow.indexOf('void selectChannel(');
  assert.ok(iEmbedBranch !== -1 && iSelectCall !== -1, 'both retry branches present');
  assert.ok(iEmbedBranch < iSelectCall, 'the embed branch is checked FIRST');
  assert.ok(retryFlow.includes('embedReloadToken += 1;'), 'the embed branch bumps the reload token');
  assert.ok(/embedReloadToken \+= 1;\n      return;/.test(retryFlow), 'the embed branch returns without touching Shaka');
  // Component: the token keys the iframe — a bump destroys and recreates
  // EXACTLY ONE iframe.
  assert.ok(player.includes('{#key embedReloadToken}'), 'the iframe is keyed by the reload token');
  const keyed = sliceOf(player, '{#key embedReloadToken}', '{/key}');
  assert.equal((keyed.match(/<iframe/g) ?? []).length, 1, 'exactly one iframe inside the key block');
  ok('B8. retry in fallback mode: one fresh iframe mount, never a Shaka re-instantiation');
}

// ============================================================
// §B9 — No Shaka <-> iframe loop can exist (case 8)
// ============================================================
{
  // The iframe onload handler only flips the pending overlay flag.
  const onloadBody = player.match(/onload=\{\(\) => \{([\s\S]*?)\}\}/)?.[1] ?? '';
  assert.ok(onloadBody.includes('embedLoaded = true'), 'onload only marks the embed loaded');
  assert.ok(!onloadBody.includes('onretry') && !onloadBody.includes('selectChannel') && !onloadBody.includes('load'), 'onload never triggers any retry/load');
  // Nothing in embed mode re-enters the native flow: the only engine
  // construction site is the selectChannel resolution flow, and retry's
  // embed branch returns before it.
  const engineCreations = page.match(/new LiveTvPlaybackEngine\(\)/g) ?? [];
  assert.equal(engineCreations.length, 1, 'still exactly one engine construction site');
  const selectFlow = sliceOf(page, 'async function selectChannel', 'function retryPlayback');
  assert.ok(selectFlow.indexOf('const eng = new LiveTvPlaybackEngine()') > selectFlow.indexOf('await resolveLiveTvPlayback'), 'the engine is still constructed only after a fresh resolution');
  // Activation is set-once per session (a second error changes nothing).
  assert.ok(sliceOf(page, 'function activateEmbedFallback', 'async function selectChannel').includes('if (embedFallbackChannelId !== null) return;'), 'set-once guard re-verified');
  ok('B9. no loop: onload is passive, one engine construction site, set-once activation');
}

// ============================================================
// §B10 — No arbitrary URL injection surface (case 10)
// ============================================================
{
  // The page passes ONLY the catalogue channel id; the component builds
  // the URL ONLY through the builder (§A1 proved the builder's validation).
  const playerProps = sliceOf(player, 'embedChannelId = null,', '}: {');
  assert.ok(player.includes("embedChannelId?: string | null;"), 'the prop is typed as a channel id, not a URL');
  assert.ok(!/\bsrc=\{[^}]*ChannelId/.test(player), 'the raw channel id is never used as src directly');
  assert.ok(!player.includes('src={`'), 'no template-literal src construction');
  assert.ok(!player.includes('src="http'), 'no hardcoded URL src');
  // The page never reads LiveGT wire embed/watch fields (types forbid them;
  // the page source contains no such reads).
  assert.ok(!/\.embed\b|\.watch\b/.test(page), 'the page never reads API embed/watch fields');
  ok('B10. injection impossible: id-typed prop, builder-only src, no wire-field reads');
}

// ============================================================
// §B11 — SSR/build safety (case 11)
// ============================================================
{
  // The pure modules imported under Node by THIS suite prove SSR safety of
  // the new logic; the component mounts the iframe only through browser
  // runtime state (a failure can only happen after a real engine ran).
  assert.ok(!/^\s*(window|document|navigator)\b/m.test(playerErrorsSource), 'player-errors has no top-level browser globals');
  const builderSection = apiSource.slice(apiSource.indexOf('export function buildLiveTvEmbedUrl'));
  assert.ok(!/^\s*(window|document|navigator)\b/m.test(builderSection), 'the builder has no browser globals');
  // The iframe has a title (a11y) and no sandbox stripping surprises: the
  // documented pattern is followed verbatim (no sandbox attribute, exactly
  // like the docs snippet).
  assert.ok(player.includes('title="Live TV alternate player"'), 'the iframe is labelled for a11y');
  ok('B11. SSR-safe pure modules; a11y-labelled documented iframe');
}

// ============================================================
// §B12 — The native path is unchanged (case 12)
// ============================================================
{
  // The LT-4 critical ordering still holds (this is the §B6 marker set,
  // re-asserted independently): abort -> destroy -> resolve -> engine -> load.
  const selectFlow = sliceOf(page, 'async function selectChannel', 'function retryPlayback');
  const iAbort = selectFlow.indexOf('sessionController?.abort();');
  const iDestroy = selectFlow.indexOf('destroyEngineSafely(engine);');
  const iResolve = selectFlow.indexOf('await resolveLiveTvPlayback');
  const iNewEngine = selectFlow.indexOf('const eng = new LiveTvPlaybackEngine()');
  const iLoad = selectFlow.indexOf('await eng.load(videoEl, resolution');
  assert.ok(iAbort < iDestroy, 'abort before destroy');
  assert.ok(iDestroy < iResolve, 'destroy before resolve');
  assert.ok(iResolve < iNewEngine, 'resolve before new engine');
  assert.ok(iNewEngine < iLoad, 'new engine before load');
  // The native success flow is byte-identical in behavior: 'loaded' ->
  // component autoplay; play tracking unchanged.
  assert.ok(selectFlow.includes("if (state === 'playing' && !playTracked)"), 'play tracking unchanged');
  assert.ok(page.includes("void attemptAutoplay(eng);") || player.includes('void attemptAutoplay(eng);'), 'autoplay wiring unchanged');
  // No engine retry was added anywhere (the no-auto-retry invariant).
  assert.ok(!/eng\.load\([^)]*\)[^;]*;\s*\/\/ retry/.test(page), 'no auto-retry added');
  ok('B12. native flow ordering + autoplay + tracking unchanged; existing suites remain the behavioral proof');
}

console.log(`\nLT-15 embed fallback suite: ${passed}/${passed} checks PASS`);
