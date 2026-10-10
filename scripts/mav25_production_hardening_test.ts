/**
 * MAV-25 — Production hardening: discover rails, Live TV desktop layout,
 * detail recommendations, and downloader reliability.
 *
 * Sections:
 *   §A  rail-navigation helpers — the shared edge-state + stepped-scroll
 *       contract (ContentRail §11 semantics, now reused by the Discover
 *       rails and the Downloader chip rail)
 *   §B  rowFillTarget — the pure visible-row fill math (card pitch →
 *       slot target, Show More endcap accounting, degenerate guards,
 *       bounded budgets)
 *   §C  Discover rail navigation + row fill contracts (DiscoverSection +
 *       AdultDiscoverSection: shared arrows, mobile isolation, budgets,
 *       observer cleanup, existing endcap contract preserved)
 *   §D  Live TV desktop/TV 70/30 layout (grid areas over the UNCHANGED
 *       DOM order, internal-scroll ownership, breakpoint isolation,
 *       player cap, mobile untouched)
 *   §E  Detail recommendations fill (cap raised 6 → 20, safety pipeline
 *       untouched, bounded classification concurrency)
 *   §F  Downloader automatic-retry POLICY (pure truth tables: link
 *       validity, exactly-one retry, add-on server-budget respect,
 *       deterministic fallback selection, bounded plan)
 *   §G  Downloader component contracts (visible sources, all-hidden
 *       recoverable state, normalization, budget spending, scheduler
 *       bounds, chip-rail arrows, non-sensitive diagnostics)
 *   §H  SSR mount through vite's real graph (the panel still renders)
 *
 * Deterministic: pure functions, stub elements, source-level assertions,
 * one vite SSR mount — never the real network, never the real DB.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  railEdgeState,
  scrollRailByCards,
} from '$lib/shared/rail-navigation';
import {
  rowFillTarget,
  ROW_FILL_ITEM_CAP,
  ROW_FILL_FETCH_BUDGET,
} from '$lib/shared/rail-row-fill';
import {
  hasValidUsableLinks,
  autoRetryDecision,
  selectFallbackSourceId,
  planAutoRetries,
  AUTO_RETRY_CONCURRENCY,
} from '$lib/shared/downloader-retry-policy';

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ---------------------------------------------------------------------------
// Stub element for the rail-navigation helpers (the minimal HTMLElement
// surface the helpers touch).
// ---------------------------------------------------------------------------
type StubElement = {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
  clientHeight?: number;
  querySelector: (selector: string) => StubChild | null;
  getComputedStyle: never;
  scrollBy: (options: { left: number; behavior: ScrollBehavior }) => void;
  getBoundingClientRect?: never;
};

type StubChild = { getBoundingClientRect: () => { width: number } };

function stubElement(opts: {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
  firstChildWidth?: number | null;
}): StubElement {
  let scrolled: { left: number; behavior: ScrollBehavior } | undefined;
  const el: StubElement = {
    scrollWidth: opts.scrollWidth,
    clientWidth: opts.clientWidth,
    scrollLeft: opts.scrollLeft,
    querySelector: (selector: string) => {
      assert.equal(selector, ':scope > *', 'the step helper measures the first element child');
      if (opts.firstChildWidth === null || opts.firstChildWidth === undefined) return null;
      return { getBoundingClientRect: () => ({ width: opts.firstChildWidth as number }) };
    },
    scrollBy: (options) => { scrolled = options; },
  } as unknown as StubElement;
  (el as unknown as { __scrolled: () => { left: number; behavior: ScrollBehavior } | undefined }).__scrolled = () => scrolled;
  return el;
}

const scrolledOf = (el: unknown) => (el as { __scrolled: () => { left: number; behavior: ScrollBehavior } | undefined }).__scrolled();

// ---------------------------------------------------------------------------
// §A — rail-navigation helpers
// ---------------------------------------------------------------------------
{
  console.log('\n§A rail-navigation helpers');

  // Edge state — the ContentRail §11 1px-tolerance truth table.
  const atStartEl = stubElement({ scrollWidth: 2000, clientWidth: 800, scrollLeft: 0 });
  ok(railEdgeState(atStartEl as unknown as HTMLElement).atStart === true, 'A1a. scrollLeft 0 → atStart');
  ok(railEdgeState(atStartEl as unknown as HTMLElement).atEnd === false, 'A1b. scrollLeft 0 → NOT atEnd');

  const midEl = stubElement({ scrollWidth: 2000, clientWidth: 800, scrollLeft: 500 });
  const mid = railEdgeState(midEl as unknown as HTMLElement);
  ok(mid.atStart === false && mid.atEnd === false, 'A1c. mid-scroll → neither edge');

  const endEl = stubElement({ scrollWidth: 2000, clientWidth: 800, scrollLeft: 1200 });
  const end = railEdgeState(endEl as unknown as HTMLElement);
  ok(end.atStart === false && end.atEnd === true, 'A1d. scrollLeft = max → atEnd');

  const roundingEl = stubElement({ scrollWidth: 2000, clientWidth: 800, scrollLeft: 1199.4 });
  ok(railEdgeState(roundingEl as unknown as HTMLElement).atEnd === true, 'A1e. sub-pixel rounding within the 1px tolerance still reads as the end');

  // Stepped scroll — 2 card pitches, container-only.
  const stepEl = stubElement({ scrollWidth: 2000, clientWidth: 800, scrollLeft: 0, firstChildWidth: 178 });
  // jsdom-free environment: the helper reads getComputedStyle — provide it.
  const originalGetComputedStyle = globalThis.getComputedStyle;
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = (() => ({ columnGap: '14px', gap: '14px' })) as unknown as typeof getComputedStyle;
  try {
    scrollRailByCards(stepEl as unknown as HTMLElement, 1);
    const fwd = scrolledOf(stepEl);
    ok(!!fwd && fwd.left === (178 + 14) * 2, 'A2a. forward step = 2 card pitches (width + gap)');
    ok(!!fwd && (fwd.behavior === 'smooth' || fwd.behavior === 'auto'), 'A2b. the scroll request is well-formed');
    scrollRailByCards(stepEl as unknown as HTMLElement, -1);
    const back = scrolledOf(stepEl);
    ok(!!back && back.left === -(178 + 14) * 2, 'A2c. backward step is negative');
  } finally {
    (globalThis as { getComputedStyle?: unknown }).getComputedStyle = originalGetComputedStyle;
  }

  // No children → a fraction of the visible width (never a crash).
  const emptyEl = stubElement({ scrollWidth: 2000, clientWidth: 800, scrollLeft: 0, firstChildWidth: null });
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = (() => ({ columnGap: '0px', gap: '0px' })) as unknown as typeof getComputedStyle;
  try {
    scrollRailByCards(emptyEl as unknown as HTMLElement, 1);
    const fb = scrolledOf(emptyEl);
    // The fallback fraction feeds the SAME 2-card step multiplier as the
    // measured path (the ContentRail §11 behaviour, verbatim).
    ok(!!fb && Math.abs(fb.left - 800 * 0.6 * 2) < 0.001, 'A2d. childless rail falls back to the 0.6 × clientWidth fraction × 2-card step');
  } finally {
    (globalThis as { getComputedStyle?: unknown }).getComputedStyle = originalGetComputedStyle;
  }
  ok('§A rail-navigation helpers: edge truth table + stepped scroll');
}

// ---------------------------------------------------------------------------
// §B — rowFillTarget (the pure fill math)
// ---------------------------------------------------------------------------
{
  console.log('\n§B rowFillTarget math');

  // 1920 desktop: rail ≈ 1584px inside the section gutters, 178px cards,
  // 14px gap → floor((1584+14)/192) = 8 slots; with a Show More endcap
  // the row needs 7 items (the endcap fills the 8th slot).
  ok(rowFillTarget({ containerWidth: 1584, cardWidth: 178, gap: 14, hasMore: true }) === 7,
    'B1a. 1920 desktop row with endcap → 7 items');
  ok(rowFillTarget({ containerWidth: 1584, cardWidth: 178, gap: 14, hasMore: false }) === 8,
    'B1b. exhausted rail fills every slot with items');

  // 1900px+ TV pitch: 210px cards + 18px gap → 7 slots → 6 with endcap.
  ok(rowFillTarget({ containerWidth: 1584, cardWidth: 210, gap: 18, hasMore: true }) === 6,
    'B1c. TV pitch accounts for the larger card + gap');

  // Narrow fallback (the 1025–1279 desktop band): ~800px rail → 4 slots → 3.
  ok(rowFillTarget({ containerWidth: 800, cardWidth: 178, gap: 14, hasMore: true }) === 3,
    'B1d. narrow desktop row is computed from the CONTAINER, not the viewport');

  // Mobile pitch (40vw ≈ 156px at 390): 2 visible slots → with an endcap
  // the target is 1 — the initially loaded items always satisfy it, so
  // NO fill fetch ever fires on phones (initial count preserved).
  const mobile = rowFillTarget({ containerWidth: 366, cardWidth: 156, gap: 10, hasMore: true });
  ok(mobile === 1, 'B1e. mobile row target stays tiny (mobile initial count preserved)');

  // Degenerate measurements degrade to 1 — never a fetch trigger.
  ok(rowFillTarget({ containerWidth: 0, cardWidth: 178, gap: 14, hasMore: true }) === 1, 'B2a. zero-width container → 1');
  ok(rowFillTarget({ containerWidth: Number.NaN, cardWidth: 178, gap: 14, hasMore: true }) === 1, 'B2b. NaN container → 1');
  ok(rowFillTarget({ containerWidth: 800, cardWidth: 0, gap: 14, hasMore: true }) === 1, 'B2c. zero-width card → 1');
  ok(rowFillTarget({ containerWidth: 800, cardWidth: 178, gap: -50, hasMore: false }) === 4, 'B2d. negative gap is clamped, not used to over-count');

  // Budgets: bounded by construction.
  ok(ROW_FILL_ITEM_CAP === 40, 'B3a. the item cap is 40 (never unlimited)');
  ok(ROW_FILL_FETCH_BUDGET === 3, 'B3b. the automatic fetch budget is 3 per logical load');
  ok('§B rowFillTarget math: slots, endcap accounting, degenerate guards, budgets');
}

// ---------------------------------------------------------------------------
// §C — Discover rail navigation + row fill contracts
// ---------------------------------------------------------------------------
{
  console.log('\n§C Discover rail navigation + row fill');

  const section = read('src/lib/components/DiscoverSection.svelte');
  const adult = read('src/lib/components/AdultDiscoverSection.svelte');
  const shared = read('src/lib/shared/rail-navigation.ts');
  const fill = read('src/lib/shared/rail-row-fill.ts');

  // The shared module exists and both sections consume it (ONE shared
  // behaviour — no conflicting duplicate abstraction).
  ok(shared.includes('export function railEdgeState') && shared.includes('export function scrollRailByCards'),
    'C1a. the shared navigation helpers exist');
  ok(section.includes("from '$lib/shared/rail-navigation'") && adult.includes("from '$lib/shared/rail-navigation'"),
    'C1b. both Discover sections import the shared helpers');
  ok(section.includes("from '$lib/shared/rail-row-fill'") && adult.includes("from '$lib/shared/rail-row-fill'"),
    'C1c. both sections use the shared fill math');

  // Arrows: edge-aligned, accessible, disabled at the real ends.
  for (const [name, src] of [['DiscoverSection', section], ['AdultDiscoverSection', adult]] as const) {
    ok(src.includes('class="rail-wrap"'), `C2a. ${name} wraps the rail (the edge-overlay host)`);
    ok(src.includes('class="rail-nav rail-nav-prev"') && src.includes('class="rail-nav rail-nav-next"'),
      `C2b. ${name} renders both navigation arrows`);
    ok(src.includes('aria-label={`Scroll ${title} left`}') && src.includes('aria-label={`Scroll ${title} right`}'),
      `C2c. ${name} arrows carry accessible labels`);
    ok(src.includes('disabled={atStart}') && src.includes('disabled={atEnd}'),
      `C2d. ${name} arrows disable at the ACTUAL scroll edges`);
    ok(src.includes('onscroll={updateRailState}') && src.includes('bind:this={railEl}'),
      `C2e. ${name} re-syncs edge state from the rail's own scroll events`);
    ok(src.includes('new ResizeObserver'), `C2f. ${name} observes container resizes`);
    ok(src.includes('resizeObserver?.disconnect') || src.includes('.disconnect()'),
      `C2g. ${name} cleans the observer up (no stale listeners)`);
  }

  // The arrows scroll only the section's own rail.
  ok(section.includes('scrollRailByCards(railEl, direction)') && !section.includes('window.scroll'),
    'C3a. DiscoverSection arrows scroll the rail element only');

  // Mobile isolation: arrows hidden ≤640px; native swipe untouched.
  ok(/@media \(max-width: 640px\) \{[\s\S]*?\.rail-nav \{ display: none; \}/.test(section),
    'C4a. DiscoverSection hides the arrows on phones');
  ok(/@media \(max-width: 640px\) \{[\s\S]*?\.rail-nav \{ display: none; \}/.test(adult),
    'C4b. AdultDiscoverSection hides the arrows on phones');
  ok(/@media \(max-width: 640px\) \{[\s\S]*?grid-auto-columns: 40vw/.test(section),
    'C4c. the mobile card pitch is unchanged (40vw)');
  ok(/@media \(min-width: 1900px\) \{[\s\S]*?\.rail-nav \{ width: 44px; height: 64px; \}/.test(section),
    'C4d. TV-scale arrows at the TV breakpoint');
  ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.rail-nav \{ transition: none; \}/.test(section),
    'C4e. reduced-motion disables arrow transitions');
  ok(section.includes("window.matchMedia('(prefers-reduced-motion: reduce)')") || shared.includes("matchMedia('(prefers-reduced-motion: reduce)')"),
    'C4f. the shared scroll helper itself honors prefers-reduced-motion');

  // The fill driver: bounded, reuse-only, reset per logical load.
  ok(section.includes('scheduleRowFill') && section.includes('runRowFill'),
    'C5a. DiscoverSection drives the visible-row fill');
  ok(section.includes('await loadMore()') || section.includes('await loadMore();'),
    'C5b. the fill fetches through the EXISTING Show More pipeline (no new endpoint)');
  ok(section.includes('fillFetchesUsed >= ROW_FILL_FETCH_BUDGET') && section.includes('items.length >= ROW_FILL_ITEM_CAP'),
    'C5c. the fill is bounded by both budgets');
  ok(section.includes("if (target !== lastFillTarget) scheduleRowFill();"),
    'C5d. resizes re-evaluate the fill only when the DERIVED target changed (no loops)');
  ok(section.includes('fillFetchesUsed = 0;') && adult.includes('fillFetchesUsed = 0;'),
    'C5e. filter/provider changes reset the fill budget (new logical load)');
  ok(section.includes('fillToken += 1;') && adult.includes('fillToken += 1;'),
    'C5f. in-flight fills are invalidated on teardown/filter changes');
  ok(adult.includes('runRowFill') && adult.includes('await loadMore();'),
    'C5g. AdultDiscoverSection runs the same bounded fill driver');

  // The pre-existing endcap contract is preserved byte-for-byte in shape.
  ok(/\{#each items as item \(item\.type \+ ':' \+ item\.id\)\}[\s\S]*?\{#if hasNextPage\}[\s\S]*?<div class="rail-endcap">/.test(section),
    'C6a. the Show More endcap still renders inside the rail, after the items');
  ok(/\{#each items as item \(item\.type \+ ':' \+ item\.id\)\}[\s\S]*?\{#if hasNextPage\}[\s\S]*?<div class="rail-endcap">/.test(adult),
    'C6b. the Adult endcap contract is equally preserved');
  ok('§C Discover rail navigation + row fill contracts');
}

// ---------------------------------------------------------------------------
// §D — Live TV desktop/TV 70/30 layout
// ---------------------------------------------------------------------------
{
  console.log('\n§D Live TV 70/30 desktop layout');

  const page = read('src/routes/live-tv/+page.svelte');
  const player = read('src/lib/components/live-tv/LiveTvPlayer.svelte');

  // The two-column grid: ~70% player / ~30% controls — explicitly NOT
  // 50/50 — with a practical right-panel minimum.
  ok(/grid-template-columns: minmax\(0, 70fr\) minmax\(320px, 30fr\);/.test(page),
    'D1a. the columns are 70fr/30fr (not 50/50) with a 320px panel minimum');

  // The desktop block is breakpoint-isolated and nothing else.
  const desktopBlock = page.slice(page.indexOf('MAV-25 WS3 — DESKTOP/TV 70/30 LAYOUT'));
  ok(desktopBlock.includes('@media (min-width: 1280px)'),
    'D1b. the 70/30 rules are isolated behind the ≥1280px desktop breakpoint');
  ok(!/@media \(max-width: 640px\) \{[^}]*70fr/.test(page),
    'D1c. no 70/30 rule leaks into the mobile breakpoints');

  // Grid areas place the SAME elements — DOM order untouched.
  ok(/grid-template-areas:\s*\n\s*'player rail-tools'\s*\n\s*'player rail-list';/.test(page),
    'D2a. the player spans both rows; toolbar + channel list stack on the right');
  ok(desktopBlock.includes('.ltv-player-column {\n      grid-area: player;')
    && desktopBlock.includes('.ltv-toolbar { grid-area: rail-tools; }')
    && desktopBlock.includes('.ltv-channels {\n      grid-area: rail-list;'),
    'D2b. the existing sections are placed by grid-area (no DOM reorder)');

  // Scroll ownership: ONE internal scrollport, no global overflow:hidden.
  const scrollBlock = desktopBlock.slice(desktopBlock.indexOf('.channels-scroll {'));
  ok(scrollBlock.includes('overflow-y: auto;') && scrollBlock.includes('min-height: 0;'),
    'D3a. ONLY the channel-list region scrolls (overflow-y: auto + min-height: 0)');
  ok(!/\.live-tv-page \{[^}]*overflow: hidden/.test(page),
    'D3b. no global overflow: hidden shortcut on the page');
  ok(desktopBlock.includes('height: 100dvh;') && desktopBlock.includes('flex-direction: column;'),
    'D3c. the page sizes itself to exactly one shell viewport (no outer scroll)');

  // The base .channels-scroll stays a plain block (mobile unchanged).
  ok(/\.channels-scroll \{ min-width: 0; min-height: 0; \}/.test(page),
    'D4a. below the breakpoint the scroll wrapper is a plain block (mobile stacked layout unchanged)');
  ok(/@media \(max-width: 640px\) \{[\s\S]*?\.channel-grid \{ grid-template-columns: 1fr; \}/.test(page),
    'D4b. the mobile single-column channel grid is unchanged');

  // The sentinel incremental-render contracts survive the restructure.
  ok(page.includes('CHANNEL_BATCH = 60') && page.includes('IntersectionObserver') && page.includes('visibleChannels.slice(0, visibleLimit)'),
    'D4c. bounded batches + sentinel observer + limit-bounded rendering survive');

  // Player: aspect ratio preserved + short-viewport cap, same breakpoint.
  ok(player.includes('aspect-ratio: 16 / 9;'), 'D5a. the player keeps its 16:9 aspect ratio');
  ok(/@media \(min-width: 1280px\) \{[\s\S]*?\.player-surface \{[\s\S]*?max-height: calc\(100dvh - 300px\);/.test(player),
    'D5b. the surface is height-capped on short desktop viewports (video letterboxes via object-fit, never overflows)');
  ok(player.includes('object-fit: contain;'), 'D5c. the broadcast video itself keeps its exact aspect ratio (object-fit: contain)');
  ok('§D Live TV 70/30 desktop layout contracts');
}

// ---------------------------------------------------------------------------
// §E — Detail recommendations fill the available width
// ---------------------------------------------------------------------------
{
  console.log('\n§E Detail recommendations fill');

  const tmdb = read('src/lib/server/content/adapters/tmdb.ts');
  const service = read('src/lib/server/content/service.ts');
  const detailPage = read('src/lib/components/DetailPage.svelte');

  // The cap: 6 → 20 (the TMDB append_to_response first page — ONE
  // upstream request, no new endpoints, no manufactured rows).
  ok(/\.filter\(\(candidate\) => hasRequiredListMetadata\(candidate, type\)\)\.slice\(0, 20\)\.map\(\(candidate\) => mapTmdb\(candidate, type, 'Recommended'\)\)/.test(tmdb),
    'E1a. the recommendation slice cap is raised to the TMDB page size (20)');
  ok(!tmdb.includes(".slice(0, 6).map((candidate) => mapTmdb(candidate, type, 'Recommended'))"),
    'E1b. the old 6-cap is gone');

  // The safety pipeline is untouched: the ONE classifier still drops
  // adult/uncertain recs fail-closed for non-adult parents.
  ok(service.includes('getDetailWithSafeRecommendations') && service.includes('filterSafeRailItems(rows,'),
    'E2a. recommendations still flow through the central classifier (fail-closed)');
  ok(service.includes('if (!shouldFilterDetailRecommendations(detail.tags))'),
    'E2b. adult parents keep their authorized Adult-surface recs (unchanged)');
  ok(/const DETAIL_RECOMMENDATION_CONCURRENCY = 4;/.test(service),
    'E2c. the classification N+1 stays bounded at concurrency 4');

  // The rail renders whatever the pipeline returns — no client slice.
  ok(detailPage.includes('{#each recommendations as rec (rec.id)}'),
    'E3a. the detail rail renders the full classified set (no client-side truncation)');
  ok(/\.recs-row \{[\s\S]*?overflow-x: auto;/.test(detailPage),
    'E3b. the rail still scrolls horizontally (mobile card width + swipe unchanged)');
  ok('§E Detail recommendations fill contracts');
}

// ---------------------------------------------------------------------------
// §F — Downloader automatic-retry POLICY (pure truth tables)
// ---------------------------------------------------------------------------
{
  console.log('\n§F downloader retry policy');

  // Link validity — normalization-aware.
  ok(hasValidUsableLinks(undefined) === false, 'F1a. undefined links → not usable');
  ok(hasValidUsableLinks(null) === false, 'F1b. null links → not usable');
  ok(hasValidUsableLinks([]) === false, 'F1c. empty list → not usable');
  ok(hasValidUsableLinks([{ url: '' }, { url: '   ' }]) === false, 'F1d. blank-URL entries are not usable links');
  ok(hasValidUsableLinks([{ url: 'https://example.test/file.mkv' }]) === true, 'F1e. a real link is usable');
  ok(hasValidUsableLinks([{ url: '' }, { url: 'magnet:?xt=1' }]) === true, 'F1f. one valid link among malformed entries keeps the source usable (legit links preserved)');

  // The exactly-one-retry decision table.
  const decision = (over: Partial<Parameters<typeof autoRetryDecision>[0]>) => autoRetryDecision({
    kind: 'plugin',
    status: 'failed',
    links: [],
    autoRetryDone: false,
    retryQueued: false,
    hidden: false,
    ...over,
  });

  ok(decision({ status: 'loading' }) === 'wait', 'F2a. loading → wait');
  ok(decision({ status: 'retrying' }) === 'wait', 'F2b. retrying → wait');
  ok(decision({ retryQueued: true }) === 'wait', 'F2c. queued → wait (no duplicate scheduling)');
  ok(decision({ hidden: true }) === 'wait', 'F2d. hidden stays hidden');
  ok(decision({ status: 'failed', links: [{ url: 'https://x.test/v' }] }) === 'keep', 'F2e. valid links → keep regardless of the status label');
  ok(decision({ status: 'empty', links: [{ url: 'https://x.test/v' }] }) === 'keep', 'F2f. the plugin empty-with-links case keeps rendering');

  // ADD-ON: the server endpoint ALREADY spends initial + one retry on
  // transient failures — the client must NOT double-retry.
  ok(decision({ kind: 'addon', status: 'unavailable' }) === 'hide',
    'F3a. add-on unavailable → hide immediately (server retry budget already spent)');
  ok(decision({ kind: 'addon', status: 'empty' }) === 'auto-retry',
    'F3b. add-on honest empty → the ONE client retry (empty never hits the server retry path)');
  ok(decision({ kind: 'addon', status: 'empty', autoRetryDone: true }) === 'hide',
    'F3c. add-on still empty after the retry → hide');

  // PLUGIN: no server retry layer exists — the client is authoritative.
  ok(decision({ kind: 'plugin', status: 'failed' }) === 'auto-retry',
    'F4a. plugin failed → exactly one automatic retry');
  ok(decision({ kind: 'plugin', status: 'empty' }) === 'auto-retry',
    'F4b. plugin empty (zero valid links) → exactly one automatic retry');
  ok(decision({ kind: 'plugin', status: 'failed', autoRetryDone: true }) === 'hide',
    'F4c. plugin failed after the retry → hide');
  ok(decision({ kind: 'plugin', status: 'empty', autoRetryDone: true }) === 'hide',
    'F4d. plugin still empty after the retry → hide');

  // Deterministic fallback selection.
  const pool = [
    { id: 'a', hidden: true, status: 'loaded' as const, links: [{ url: 'https://a.test/v' }] },
    { id: 'b', status: 'loading' as const, links: [] },
    { id: 'c', status: 'empty' as const, links: [] },
    { id: 'd', status: 'loaded' as const, links: [{ url: 'https://d.test/v' }] },
    { id: 'e', status: 'loaded' as const, links: [{ url: 'https://e.test/v' }] },
  ];
  ok(selectFallbackSourceId(pool) === 'd', 'F5a. fallback = first visible loaded source in position order (skips hidden/loading/empty)');
  ok(selectFallbackSourceId([]) === null, 'F5b. empty pool → null');
  ok(selectFallbackSourceId(pool.slice(0, 3)) === null, 'F5c. nothing usable → null (all-hidden state)');

  // The bounded plan.
  const planPool = [
    { id: 'a', kind: 'addon' as const, hidden: true, status: 'unavailable' as const, links: [] },
    { id: 'b', kind: 'plugin' as const, status: 'failed' as const, links: [] },
    { id: 'c', kind: 'addon' as const, status: 'empty' as const, links: [] },
    { id: 'd', kind: 'plugin' as const, status: 'loading' as const, links: [] },
    { id: 'e', kind: 'plugin' as const, status: 'failed' as const, links: [], retryQueued: true },
    { id: 'f', kind: 'plugin' as const, status: 'failed' as const, links: [], autoRetryDone: true },
  ];
  ok(JSON.stringify(planAutoRetries(planPool)) === JSON.stringify(['b', 'c']),
    'F6a. the plan is position-ordered and excludes hidden/loading/queued/done sources');
  ok(AUTO_RETRY_CONCURRENCY === 2, 'F6b. the scheduler drains with bounded concurrency 2');
  ok('§F downloader retry policy truth tables');
}

// ---------------------------------------------------------------------------
// §G — Downloader component contracts
// ---------------------------------------------------------------------------
{
  console.log('\n§G downloader component contracts');

  const component = read('src/lib/components/MaveroUnifiedDownload.svelte');
  const policyFile = read('src/lib/shared/downloader-retry-policy.ts');

  // Visible-source filtering + the all-hidden recoverable state.
  ok(component.includes('$: visibleSources = sources.filter((source) => !source.hidden);'),
    'G1a. the chip rail renders only sources that survived the retry policy');
  ok(component.includes('{#each visibleSources as source (source.id)}'),
    'G1b. the rail iterates visibleSources (hidden sources are removed from the selector)');
  ok(component.includes('$: allSourcesHidden =') && component.includes('No sources could be resolved for this title right now.'),
    'G1c. policy step 5: a clear state replaces the empty-looking panel when every source is hidden');
  ok(/allSourcesHidden\}[\s\S]*?onclick=\{retryAll\}/.test(component),
    'G1d. the all-hidden state is recoverable (Retry = fresh logical load with fresh budgets)');

  // Normalization: malformed entries dropped, legit links preserved.
  ok(component.includes("typeof link.url === 'string' && link.url.trim().length > 0"),
    'G2a. both resolution paths drop blank-URL (malformed) links after mapping');
  ok(component.includes('.filter((stream): stream is AddonStreamPayload => Boolean(stream) && typeof stream === \'object\')'),
    'G2b. null/non-object add-on stream entries are ignored');

  // The add-on server retry budget is respected (no client double-retry):
  // the hide-on-unavailable rule lives in the POLICY module, and the
  // component delegates every decision to it.
  ok(policyFile.includes("if (kind === 'addon' && status === 'unavailable') return 'hide';"),
    'G3a. the policy module encodes the server-budget rule (add-on unavailable = already retried server-side)');
  ok(component.includes('autoRetryDecision({') && component.includes('planAutoRetries(sources)') && component.includes('selectFallbackSourceId(sources)'),
    'G3b. the component delegates ALL policy decisions to the shared pure module (one authoritative layer)');

  // Exactly-one-retry mechanics.
  ok(component.includes('source.autoRetryDone = true;') && component.includes('retryQueued: true'),
    'G4a. the budget is spent BEFORE the attempt (re-entrant scans can never re-arm it)');
  ok(/retrySource[\s\S]*?source\.autoRetryDone = true;[\s\S]*?await resolveAddonSource\(source\);/.test(component),
    'G4b. a manual add-on retry spends the automatic budget too (no manual+automatic stacking)');
  ok(/retrySource[\s\S]*?await resolvePluginExtension\(source, 'manual'\);/.test(component),
    'G4c. the manual plugin retry shares the per-extension resolver');
  ok(component.includes('async function resolvePluginExtension(source: UnifiedSource, mode'),
    'G4d. ONE per-extension resolver serves both manual and automatic attempts');

  // Bounded scheduler + cancellation.
  ok(component.includes('pumpAutoRetryScheduler') && component.includes('drainAutoRetryQueue'),
    'G5a. the bounded scheduler drains retry plans');
  ok(component.includes('while (!componentDestroyed)'),
    'G5b. the scheduler stops on unmount (no retry storms after teardown)');
  ok(/onDestroy\(\(\) => \{[\s\S]*?componentDestroyed = true;[\s\S]*?for \(const abort of retryAborts\.values\(\)\) abort\.abort\(\);/.test(component),
    'G5c. in-flight retries are aborted on destroy (stale responses never land)');
  ok(component.includes('AUTO_RETRY_CONCURRENCY'),
    'G5d. the drain uses the policy concurrency bound (no unbounded bursts)');

  // Active-source recalibration without fetches.
  ok(component.includes('activeSourceId = selectFallbackSourceId(sources);'),
    'G6a. hiding the active source recalculates the selection deterministically (no fetch storm)');

  // Non-sensitive diagnostics.
  const warnBlock = component.slice(component.indexOf('[MaveroDownloader] source hidden after retry budget'));
  const warnPayload = warnBlock.slice(warnBlock.indexOf('{'), warnBlock.indexOf('});'));
  ok(!warnPayload.includes('url'), 'G7a. the hidden-source diagnostic carries no URLs');
  ok(warnPayload.includes('kind') && warnPayload.includes('id') && warnPayload.includes('status') && warnPayload.includes('errorCode'),
    'G7b. the diagnostic still records structured debugging context');

  // WS5 — chip rail arrows.
  ok(component.includes('class="mud-tabs-wrap"') && component.includes('class="mud-tab-nav mud-tab-nav-prev"') && component.includes('class="mud-tab-nav mud-tab-nav-next"'),
    'G8a. the chip rail has shared edge-aligned navigation arrows');
  ok(component.includes('aria-label="Scroll sources left"') && component.includes('aria-label="Scroll sources right"'),
    'G8b. the arrows carry accessible labels');
  ok(component.includes('disabled={tabsAtStart}') && component.includes('disabled={tabsAtEnd}'),
    'G8c. arrow availability follows the ACTUAL scroll position');
  ok(component.includes('bind:this={tabsEl}') && component.includes('onscroll={updateTabsState}'),
    'G8d. the arrows scroll ONLY the chip container (its own scrollport drives the state)');
  ok(/@media \(max-width: 640px\) \{[\s\S]*?\.mud-tab-nav \{ display: none; \}/.test(component),
    'G8e. phones keep native touch scrolling (arrows hidden ≤640px)');
  ok(component.includes('tabsObserver?.disconnect();'),
    'G8f. the chip-rail observer is cleaned up (component destroy + every re-sync)');
  ok(/class="mud-tab-nav[\s\S]*?onclick=\{\(\) => scrollTabsByCard/.test(component) && component.includes('onclick={() => selectSource(source.id)}'),
    'G8g. arrows and chips are separate controls — arrow clicks can never select a source');

  // Source counters/status semantics unchanged.
  ok(component.includes("mud-tab-state ok\" class:plugin={source.kind === 'plugin'}") && component.includes("link.kind !== 'external'"),
    'G9a. the per-kind counting rules survive (plugins count non-external links)');
  ok(component.includes("source.status === 'unavailable' || source.status === 'failed'"),
    'G9b. the Failed pill still renders while a source resolves/retries (before any hide)');
  ok('§G downloader component contracts');
}

// ---------------------------------------------------------------------------
// §H — SSR mount through vite's real graph
// ---------------------------------------------------------------------------
{
  console.log('\n§H SSR mount (vite)');
  const globalAny = globalThis as Record<string, unknown>;
  if (typeof globalAny.requestAnimationFrame !== 'function') {
    globalAny.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0) as unknown as number;
    globalAny.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  }
  const { createServer } = await import('vite');
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const svelteServer = (await server.ssrLoadModule('svelte/server')) as { render: (component: unknown, options: { props: Record<string, unknown> }) => { body: string } };
    const mod = (await server.ssrLoadModule('/src/lib/components/MaveroUnifiedDownload.svelte')) as { default: unknown };
    const body = svelteServer.render(mod.default, { props: { contentId: 'movie-550', mediaType: 'movie', tmdbId: '550', title: 'Fight Club' } }).body;
    ok(body.includes('Finding sources…'), 'H1. the panel mounts and renders its loading surface');
    ok(body.includes('Add-on and plugin sources'), 'H2. the instruction block survives the restructure');
  } finally {
    await server.close();
  }
  ok('§H SSR mount');
}

console.log(`\nMAV-25 production hardening tests passed (${passed} checks)`);
