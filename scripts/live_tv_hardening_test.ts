// MAVERO — LT-5 Hardening: focused regression suite.
//
// Covers the LT-5 additions and the security invariants they must uphold:
//   * §1  Analytics adapter payload safety (BEHAVIORAL — the real adapter
//         runs against an instrumented dispatcher singleton; every emitted
//         payload is inspected field-by-field)
//   * §2  Error normalization for analytics (fixed kinds only, hostile
//         errors collapse to 'unknown', no upstream material escapes)
//   * §3  Taxonomy ↔ DB migration parity (the closed set is identical in
//         analytics-taxonomy.ts and the CHECK constraint; meaningful-
//         activity membership follows plan §11)
//   * §4  Ingest acceptance (isAnalyticsEventName accepts every Live TV
//         event — the /api/events gate is satisfied)
//   * §5  Page wiring (open on mount; select/switch/retry reason logic;
//         single error source — engine events for session failures, the
//         resolve catch for LT-2 failures; never awaited; never inside
//         catalogue/guide flows)
//   * §6  Player component contract (reports raw user actions only; zero
//         analytics knowledge inside the component)
//   * §7  Security scans (no playback material can reach analytics; no
//         storage/console/cookie in Live TV sources; SSR safety — the
//         adapter imports cleanly under Node and the real dispatcher
//         no-ops outside the browser)
//
// NO network, browser, DRM or Shaka package is involved.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { analytics } from '$lib/client/analytics/dispatcher';
import { isAnalyticsEventName, ANALYTICS_EVENT_NAMES, MEANINGFUL_ACTIVITY_EVENTS } from '$lib/shared/analytics-taxonomy';
import {
  trackLiveTvOpen,
  trackLiveTvChannelAction,
  trackLiveTvPlay,
  trackLiveTvPause,
  trackLiveTvError,
  trackLiveTvFullscreen,
  liveTvErrorKindForAnalytics,
  type LiveTvSelectReason
} from '$lib/client/live-tv/analytics';
import { LiveTvError } from '$lib/client/live-tv/errors';
import { LiveTvPlaybackError } from '$lib/client/live-tv/player-errors';
import type { LiveTvChannel } from '$lib/client/live-tv/types';

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const page = read('../src/routes/live-tv/+page.svelte');
const player = read('../src/lib/components/live-tv/LiveTvPlayer.svelte');
const adapterSource = read('../src/lib/client/live-tv/analytics.ts');
const taxonomySource = read('../src/lib/shared/analytics-taxonomy.ts');
const migrationSql = read('../supabase/migrations/20261103000000_live_tv_analytics_events.sql');
// LT-15: the taxonomy now has a second extension migration. The effective
// DB constraint is the UNION of every taxonomy-extension migration (the
// same convention as phase1_analytics_foundation_test.ts 1c) — parity is
// still asserted EXACTLY against the taxonomy below.
const fallbackMigrationSql = read('../supabase/migrations/20261104000000_live_tv_fallback_embed_event.sql');

// ============================================================
// §1 Analytics adapter payload safety (behavioral)
// ============================================================
{
  type Recorded = { name: string; props: Record<string, unknown> };
  const recorded: Recorded[] = [];
  const dispatcher = analytics as unknown as { track: (name: string, props?: Record<string, unknown>) => void };
  const originalTrack = dispatcher.track.bind(analytics);
  dispatcher.track = (name: string, props?: Record<string, unknown>) => {
    recorded.push({ name, props: props ?? {} });
  };
  try {
    const channel: LiveTvChannel = {
      id: '151',
      name: 'Movies Now HD',
      category: 'English',
      logo: 'https://cdn.example.com/logo.png'
    };

    trackLiveTvOpen();
    trackLiveTvChannelAction(channel, 'initial');
    trackLiveTvChannelAction(channel, 'retry');
    trackLiveTvChannelAction(channel, 'switch');
    trackLiveTvPlay('151');
    trackLiveTvPause('151');
    trackLiveTvError('151', new LiveTvError('server', { status: 502 }));
    trackLiveTvError(null, new LiveTvPlaybackError('drm_playback_failed', 6000));
    trackLiveTvFullscreen('151', 'enter');
    trackLiveTvFullscreen(null, 'exit');

    assert.equal(recorded.length, 10, 'ten events recorded through the dispatcher');
    const names = recorded.map((e) => e.name);
    assert.deepEqual(
      names,
      [
        'live_tv_open',
        'live_tv_channel_select',
        'live_tv_channel_select',
        'live_tv_channel_switch',
        'live_tv_play',
        'live_tv_pause',
        'live_tv_error',
        'live_tv_error',
        'live_tv_fullscreen',
        'live_tv_fullscreen'
      ],
      'event names map 1:1 onto the taxonomy'
    );

    // Payload field whitelist: ONLY content_id + metadata{reason,category,error_kind,action}.
    const ALLOWED_META_KEYS = new Set(['reason', 'category', 'error_kind', 'action']);
    const ALLOWED_TOP_KEYS = new Set(['content_id', 'metadata']);
    for (const event of recorded) {
      for (const key of Object.keys(event.props)) {
        assert.ok(ALLOWED_TOP_KEYS.has(key), `top-level key "${key}" is not whitelisted`);
      }
      const meta = (event.props.metadata ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(meta)) {
        assert.ok(ALLOWED_META_KEYS.has(key), `metadata key "${key}" is not whitelisted`);
      }
    }
    ok('payload whitelist: only content_id + metadata{reason,category,error_kind,action} are ever sent');

    // The channel NAME and LOGO URL never enter any payload (no full
    // channel objects, no provider data — LT-5 brief §8).
    const serialized = JSON.stringify(recorded);
    assert.ok(!serialized.includes('Movies Now HD'), 'channel name never sent');
    assert.ok(!serialized.includes('cdn.example.com'), 'logo URL never sent');
    assert.ok(!serialized.includes('logo'), 'no logo field ever sent');
    ok('channel name/logo/provider data never enter analytics payloads');

    // Reason semantics: initial/retry → select, switch → switch.
    assert.equal(recorded[1].props.content_id, '151');
    assert.deepEqual(recorded[1].props.metadata, { reason: 'initial', category: 'English' });
    assert.deepEqual(recorded[2].props.metadata, { reason: 'retry', category: 'English' });
    assert.deepEqual(recorded[3].props.metadata, { reason: 'switch', category: 'English' });
    ok('select/switch reason semantics mirror the VOD provider_selected convention');

    // Fullscreen payload carries the action; null channel id is omitted.
    assert.deepEqual(recorded[8].props.metadata, { action: 'enter' });
    assert.equal(recorded[8].props.content_id, '151');
    assert.equal(recorded[9].props.content_id, undefined, 'null channel id omitted, not null');
    ok('fullscreen action payload; absent channel id is omitted');

    // Errors carry ONLY the normalized kind.
    assert.deepEqual(recorded[6].props.metadata, { error_kind: 'server' });
    assert.deepEqual(recorded[7].props.metadata, { error_kind: 'drm_playback_failed' });
    ok('error events carry only the normalized kind from the fixed tables');

    // Empty category is omitted; long category is bounded.
    const noCategory: LiveTvChannel = { id: '9', name: 'X' };
    recorded.length = 0;
    trackLiveTvChannelAction(noCategory, 'initial');
    assert.deepEqual(recorded[0].props.metadata, { reason: 'initial' }, 'absent category omitted');
    const longCat: LiveTvChannel = { id: '9', name: 'X', category: 'A'.repeat(500) };
    recorded.length = 0;
    trackLiveTvChannelAction(longCat, 'initial');
    assert.equal(((recorded[0].props.metadata as Record<string, unknown>).category as string).length, 64, 'category bounded to 64 chars');
    ok('category handling: absent omitted, length-bounded');
  } finally {
    dispatcher.track = originalTrack;
  }
}

// ============================================================
// §2 Error normalization for analytics (behavioral)
// ============================================================
{
  // Every LT-2 kind passes through unchanged.
  const lt2Kinds = [
    'network', 'timeout', 'aborted', 'bad_request', 'not_found',
    'rate_limited', 'server', 'invalid_response', 'no_playback_source', 'unsupported_drm'
  ] as const;
  for (const kind of lt2Kinds) {
    assert.equal(liveTvErrorKindForAnalytics(new LiveTvError(kind)), kind, `LT-2 kind ${kind} preserved`);
  }
  // Every LT-3 kind passes through unchanged.
  const lt3Kinds = [
    'invalid_source', 'init_failed', 'manifest_load_failed', 'drm_config_failed',
    'drm_playback_failed', 'network_failed', 'unsupported_browser',
    'autoplay_blocked', 'aborted', 'playback_failed'
  ] as const;
  for (const kind of lt3Kinds) {
    assert.equal(liveTvErrorKindForAnalytics(new LiveTvPlaybackError(kind)), kind, `LT-3 kind ${kind} preserved`);
  }
  // Hostile/unknown errors collapse to 'unknown' — nothing else is read.
  const hostile = [
    undefined,
    null,
    new Error('https://signed.example.mpd?token=SECRET_KEY'),
    { message: 'clearkey keyId=deadbeef key=cafebabecafebabecafebabecafebabe' },
    'string error',
    42
  ];
  for (const err of hostile) {
    assert.equal(liveTvErrorKindForAnalytics(err), 'unknown', 'unknown error collapses to the literal kind');
  }
  // And the end-to-end guarantee: the hostile material never reaches a payload.
  const recorded: Array<Record<string, unknown>> = [];
  const dispatcher = analytics as unknown as { track: (name: string, props?: Record<string, unknown>) => void };
  const originalTrack = dispatcher.track.bind(analytics);
  dispatcher.track = (_name: string, props?: Record<string, unknown>) => {
    recorded.push(props ?? {});
  };
  try {
    trackLiveTvError('143', hostile[2]);
    trackLiveTvError('143', hostile[3]);
    const serialized = JSON.stringify(recorded);
    assert.ok(!serialized.includes('SECRET_KEY'), 'no upstream URL/token material');
    assert.ok(!serialized.includes('deadbeef'), 'no ClearKey material');
    assert.ok(serialized.includes('"error_kind":"unknown"'), 'normalized kind present');
  } finally {
    dispatcher.track = originalTrack;
  }
  ok('error normalization: fixed kinds preserved, hostile errors collapse to unknown, no material leaks');
}

// ============================================================
// §3 Taxonomy ↔ DB migration parity
// ============================================================
{
  const expected = [
    'live_tv_open',
    'live_tv_channel_select',
    'live_tv_channel_switch',
    'live_tv_play',
    'live_tv_pause',
    'live_tv_error',
    'live_tv_fullscreen'
  ];
  for (const name of expected) {
    assert.ok((ANALYTICS_EVENT_NAMES as readonly string[]).includes(name), `${name} in taxonomy`);
  }
  // Extract the event list from EVERY taxonomy migration's CHECK
  // constraint and union them (append-only migration history — the
  // effective DB constraint is the union of all extensions).
  const checkEvents = (sql: string): string[] => {
    const start = sql.indexOf('check (event_name in (');
    assert.ok(start !== -1, 'migration CHECK constraint found');
    const end = sql.indexOf('))', start);
    const body = sql.slice(start, end);
    return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  };
  const sqlEvents = [...new Set([...checkEvents(migrationSql), ...checkEvents(fallbackMigrationSql)])];
  assert.deepEqual(
    new Set(sqlEvents),
    new Set(ANALYTICS_EVENT_NAMES),
    'migration CHECK event set === taxonomy event set (exact parity)'
  );
  assert.equal(sqlEvents.length, ANALYTICS_EVENT_NAMES.length, 'no duplicate events in the constraint');
  // Meaningful-activity membership (plan §11): engagement yes, page loads no.
  assert.ok(MEANINGFUL_ACTIVITY_EVENTS.has('live_tv_channel_select'), 'channel select is meaningful activity');
  assert.ok(MEANINGFUL_ACTIVITY_EVENTS.has('live_tv_play'), 'play is meaningful activity');
  assert.ok(!MEANINGFUL_ACTIVITY_EVENTS.has('live_tv_open'), 'page open is NOT meaningful (refresh-safe)');
  assert.ok(!MEANINGFUL_ACTIVITY_EVENTS.has('live_tv_error'), 'errors are not activity');
  // No high-frequency telemetry in the taxonomy.
  for (const forbidden of ['live_tv_timeupdate', 'live_tv_buffering', 'live_tv_seek', 'live_tv_progress']) {
    assert.ok(!(ANALYTICS_EVENT_NAMES as readonly string[]).includes(forbidden), `${forbidden} must not exist`);
  }
  ok('taxonomy/SQL parity, meaningful-activity membership, no high-frequency telemetry');
}

// ============================================================
// §4 Ingest acceptance
// ============================================================
{
  for (const name of ['live_tv_open', 'live_tv_channel_select', 'live_tv_channel_switch', 'live_tv_play', 'live_tv_pause', 'live_tv_error', 'live_tv_fullscreen']) {
    assert.ok(isAnalyticsEventName(name), `${name} accepted by the ingest gate`);
  }
  assert.ok(!isAnalyticsEventName('live_tv_bogus'), 'unknown live_tv event rejected');
  ok('every Live TV event passes the /api/events ingest gate');
}

// ============================================================
// §5 Page wiring (source contract)
// ============================================================
{
  // Open: exactly once, in onMount.
  const openCalls = page.match(/trackLiveTvOpen\(\)/g) ?? [];
  assert.equal(openCalls.length, 1, 'exactly one trackLiveTvOpen call');
  assert.match(page, /onMount\(\(\) => \{\s*void loadCatalogue\(\);\s*\/\/ Analytics[\s\S]*?trackLiveTvOpen\(\);/, 'open tracked on mount (after the catalogue kickoff)');

  // Reason logic derives from the PREVIOUS selected channel.
  assert.match(
    page,
    /const previousChannel = selectedChannel;\s*const selectReason = previousChannel\s*\?\s*previousChannel\.id === channel\.id \? 'retry' : 'switch'\s*:\s*'initial';/,
    'initial/switch/retry derived from the previous selection'
  );
  assert.match(page, /trackLiveTvChannelAction\(channel, selectReason\);/, 'selection tracked with the derived reason');

  // Play: first 'playing' per session, via the engine subscription.
  assert.match(
    page,
    /let playTracked = false;\s*eng\.on\('statechange', \(\{ state \}\) => \{\s*if \(state === 'playing' && !playTracked\) \{\s*playTracked = true;\s*trackLiveTvPlay\(channel\.id\);/,
    'play tracked once per session on the first playing state'
  );

  // Single error source: engine 'error' subscription + the resolve catch;
  // the engine-load catch must NOT track (the engine already emitted).
  // LT-15 evolution: the subscription is identity-guarded (a stale engine
  // can never mount an embed fallback) and MAY activate the documented
  // embed fallback for genuine native failures — the tracking call is
  // unchanged and still exactly one.
  {
    const subStart = page.indexOf("eng.on('error', (error) => {");
    assert.ok(subStart !== -1, 'engine error subscription present');
    const subBody = page.slice(subStart, page.indexOf('});', subStart));
    const iGuard = subBody.indexOf('if (engine !== eng) return;');
    const iTrack = subBody.indexOf('trackLiveTvError(channel.id, error);');
    const iFallback = subBody.indexOf('if (shouldFallbackToEmbed(error)) activateEmbedFallback(channel, error);');
    assert.ok(iGuard !== -1 && iTrack !== -1 && iFallback !== -1, 'subscription: identity guard + single tracking call + fallback activation');
    assert.ok(iGuard < iTrack && iTrack < iFallback, 'identity guard first; tracking unchanged; fallback activation last');
  }
  const selectFlowStart = page.indexOf('async function selectChannel');
  const selectFlowEnd = page.indexOf('function retryPlayback');
  const selectFlow = page.slice(selectFlowStart, selectFlowEnd);
  const errorTrackCalls = selectFlow.match(/trackLiveTvError\(/g) ?? [];
  assert.equal(errorTrackCalls.length, 2, 'exactly two trackLiveTvError sites in the flow (engine subscription + resolve catch)');
  const loadCatch = selectFlow.slice(selectFlow.indexOf('// failed session: surface via safe message'));
  assert.ok(!loadCatch.slice(0, 200).includes('trackLiveTv'), 'the engine-load catch never tracks (no double-reporting)');

  // Never awaited (fire-and-forget — analytics can never block playback).
  assert.doesNotMatch(page, /await trackLiveTv/, 'no trackLiveTv call is ever awaited');

  // Catalogue/guide failures are deliberately NOT tracked (playback-only
  // taxonomy; those surfaces have their own retry UIs).
  const catalogueFlow = page.slice(page.indexOf('async function loadCatalogue'), page.indexOf('// Search + filters'));
  assert.ok(!catalogueFlow.includes('trackLiveTv'), 'catalogue flow never tracks');
  const guideFlow = page.slice(page.indexOf('async function loadGuide'), page.indexOf('function retryGuide'));
  assert.ok(!guideFlow.includes('trackLiveTv'), 'guide flow never tracks');

  // User-action bridge maps the component report to the taxonomy calls.
  assert.match(page, /function handlePlayerUserAction\(action: 'pause' \| 'fullscreen_enter' \| 'fullscreen_exit'\)/, 'user-action bridge exists');
  assert.match(page, /trackLiveTvPause\(id\);/, 'pause tracked with the active channel id');
  assert.match(page, /trackLiveTvFullscreen\(selectedChannel\?\.id \?\? null,/, 'fullscreen tracked with the active channel id');

  // Analytics is imported ONLY through the Live TV adapter — the page
  // never touches the dispatcher directly.
  assert.ok(!page.includes("from '$lib/client/analytics/dispatcher'"), 'page never imports the dispatcher directly');
  assert.ok(page.includes("from '$lib/client/live-tv/analytics'"), 'page imports the Live TV adapter');
  ok('page wiring: open/select/switch/play/pause/error/fullscreen all flow through the adapter, single error source');
}

// ============================================================
// §6 Player component contract (source contract)
// ============================================================
{
  // Comment-free projection (full-line + trailing // comments; this file
  // contains no protocol-relative URLs in code, so the naive strip is safe
  // here — https:// URLs never appear in the component's script body).
  const playerCode = player
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
    .replace(/([^:])\/\/[^\n]*/g, '$1');
  assert.ok(!playerCode.includes('analytics'), 'player component code contains no analytics references');
  assert.ok(!playerCode.includes('trackLiveTv'), 'player component never calls Live TV trackers');
  assert.ok(!playerCode.includes('dispatcher'), 'player component never imports the dispatcher');
  assert.match(player, /onuseraction = \(\) => \{\}/, 'onuseraction is an optional no-op prop');
  const reports = player.match(/onuseraction\('([a-z_]+)'\)/g) ?? [];
  assert.deepEqual(reports.sort(), ["onuseraction('fullscreen_enter')", "onuseraction('fullscreen_exit')", "onuseraction('pause')"].sort(), 'exactly three user-action reports: pause + fullscreen enter/exit');
  // The pause report is strictly the user's control action.
  assert.match(
    player,
    /if \(engineState === 'playing'\) \{\s*eng\.pause\(\);\s*onuseraction\('pause'\);/,
    'pause reported only for the user pause action'
  );
  ok('player component: reports raw user actions only; zero analytics knowledge');
}

// ============================================================
// §7 Security scans + SSR safety
// ============================================================
{
  // The adapter structurally cannot send playback material: it only ever
  // touches channel.id / channel.category / error kinds. (Comments are
  // stripped first — the header DOCUMENTS the forbidden material by name,
  // which is exactly what we want in prose and never want in code.)
  const adapterCode = adapterSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
  assert.doesNotMatch(adapterCode, /\.url\b|\.sources\b|\.drm\b|keyId|clearKeys|\.mpd|livetgtv|jiotv|akamaized/i, 'adapter code never references playback sources/DRM/hosts');
  for (const source of [page, player, adapterSource]) {
    assert.doesNotMatch(source, /console\./, 'no console calls');
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/i, 'no storage APIs');
    assert.doesNotMatch(source, /document\.cookie/, 'no cookie access');
    assert.doesNotMatch(source, /livetgtv/i, 'no LiveGT URLs');
  }
  // The adapter module imports cleanly under Node (this suite does exactly
  // that), and the REAL dispatcher no-ops outside the browser — calling it
  // must neither throw nor record anything.
  let threw = false;
  try {
    (analytics as unknown as { track: (n: never) => void }).track('live_tv_open');
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'dispatcher.track under Node (SSR import context) never throws');
  // Taxonomy source documents the Live TV extension inline.
  assert.match(taxonomySource, /Live TV \(LT-5/, 'taxonomy source documents the Live TV extension');
  ok('security scans: adapter cannot send playback material; no console/storage/cookies; SSR-safe');
}

// ============================================================
// §8 Accessibility structural invariants (LT-5 audit outcomes)
// ============================================================
{
  // Touch targets: the slider INPUTS must keep a practical hit box — the
  // 4px visual track belongs to the runnable-track pseudo-elements, never
  // to the input element itself (WCAG 2.5.8 — 24px minimum).
  assert.match(player, /\.volume, \.live-seek \{[^}]*height: 28px;/, 'slider inputs are 28px tall (hit area)');
  assert.match(player, /::-webkit-slider-runnable-track[\s\S]{0,120}?height: 4px;/, '4px visual track on the webkit runnable-track');
  assert.match(player, /::-moz-range-track[\s\S]{0,120}?height: 4px;/, '4px visual track on the moz range-track');
  assert.doesNotMatch(player, /\.volume, \.live-seek \{[^}]*height: 4px;/, 'the input box itself is never 4px tall');

  // Reduced motion: every continuous animation in the Live TV UI is
  // disabled under prefers-reduced-motion (the repo-wide convention).
  const reducedBlocks = [...player.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n  \}/g)].map((m) => m[1]);
  assert.ok(reducedBlocks.length > 0, 'player has a reduced-motion block');
  for (const block of reducedBlocks) {
    assert.match(block, /animation: none/, 'animations disabled under reduced motion');
  }
  ok('a11y invariants: 28px slider touch targets, reduced-motion respected');
}

console.log(`\nLT-5 hardening suite: ${passed}/${passed} checks PASS`);
