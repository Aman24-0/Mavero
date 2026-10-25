/**
 * FINAL TASK suite — the unified Mavero Downloader: ONE downloader carrying
 * BOTH source kinds, the global source ordering, admin position controls,
 * the provider-dropdown alignment fix, and the Downloader 2 retirement.
 *
 * Sections:
 *   §A  rankUnifiedSources — the PURE global ranking rule (fallback order,
 *       positioned interleaving, dense positions, deterministic ties)
 *   §B  the source-order service (fake PostgREST clients): read + RPC-first
 *       mutation + read-modify-write fallback + honest TABLE_MISSING,
 *       computeAdminGlobalPositions, setExtensionPosition
 *   §C  the /api/downloader/mavero/sources endpoint: validation boundaries,
 *       the separate rate-limit bucket, the adult-guard boundary, and
 *       source-scan composition invariants (both catalogs reused, never
 *       the Builder, no-store)
 *   §D  the unified panel source contracts: green/blue chip rail (PART C),
 *       per-kind resolution engines, states, a11y, responsive, no registry
 *       or Builder references
 *   §E  admin contracts: the setPosition action, the extension position
 *       control, the add-on global position action + legacy fallback
 *   §F  PART J — the provider dropdown alignment fix (shared layout)
 *   §G  the retirement: DownloadSheet wiring + the retire statement
 *   §H  SSR mount: the unified panel renders through vite's real graph
 *   §I  rate-limit rules + the migration's retire statement surface
 *
 * Deterministic: pure functions, fake PostgREST clients, source scans, and
 * one vite SSR mount — never the real network, never the real DB.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RATE_LIMIT_RULES, resetRateLimitsForTests } from '$lib/server/http/rate-limit';
import {
  addonOrderKey,
  extensionOrderKey,
  rankUnifiedSources,
  sortUnifiedSources,
  type RankAddonTab,
  type RankExtensionTab,
  type SourceOrderEntry,
} from '$lib/shared/unified-downloader';
import {
  getGlobalSourceOrder,
  setGlobalSourcePosition,
  computeAdminGlobalPositions,
  setExtensionPosition,
  validatedAddonOrderKey,
  validatedExtensionOrderKey,
} from '$lib/server/downloader/source-order';

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ---------------------------------------------------------------------------
// Fake PostgREST client (the minimal surface the source-order service uses)
// ---------------------------------------------------------------------------

type FakeQueryResult = { data: unknown[] | null; error: { code?: string; message?: string } | null };

type FakeTable = {
  rows?: Array<Record<string, unknown>>;
  /** Simulated read error (e.g. PGRST205 table-missing). */
  error?: { code?: string; message?: string } | null;
};

function fakeClient(tables: Record<string, FakeTable>, rpcBehavior?: { name: string; result: { data: unknown; error: { code?: string; message?: string } | null } }) {
  const writes: Array<{ table: string; op: 'update' | 'insert' | 'rpc'; payload: Record<string, unknown> }> = [];
  const client = {
    writes,
    from(table: string) {
      const state = tables[table] ?? { rows: [], error: null };
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const makeChain = (filtered: Array<Record<string, unknown>> | null = null) => {
        const rowsInView = () => filtered ?? (state.rows ?? []);
        const chain: Record<string, unknown> = {};
        const terminal = async (): Promise<FakeQueryResult> => {
          if (state.error) return { data: null, error: state.error };
          return { data: [...rowsInView()], error: null };
        };
        chain.then = (onFulfilled: (value: FakeQueryResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
          terminal().then(onFulfilled, onRejected);
        chain.catch = (onRejected: (reason: unknown) => unknown) => terminal().catch(onRejected);
        chain.order = () => makeChain(filtered);
        chain.eq = (column: string, value: unknown) => makeChain(rowsInView().filter((row) => row[column] === value));
        chain.in = (column: string, values: unknown[]) => makeChain(rowsInView().filter((row) => values.includes(row[column])));
        chain.limit = () => makeChain(filtered);
        chain.maybeSingle = async () => {
          if (state.error) return { data: null, error: state.error };
          return { data: rowsInView()[0] ?? null, error: null };
        };
        chain.select = () => makeChain(filtered);
        return chain;
      };
      const base = makeChain();
      (base as Record<string, unknown>).update = (payload: Record<string, unknown>) => {
        writes.push({ table, op: 'update', payload });
        const after = makeChain();
        (after as Record<string, unknown>).eq = () => makeChain();
        (after as unknown as Promise<FakeQueryResult>).then = (onFulfilled: (value: FakeQueryResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
        return after;
      };
      (base as Record<string, unknown>).insert = (payload: Record<string, unknown>) => {
        writes.push({ table, op: 'insert', payload });
        const after = makeChain();
        (after as unknown as Promise<FakeQueryResult>).then = (onFulfilled: (value: FakeQueryResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
        return after;
      };
      return base;
    },
    rpc(name: string, params: Record<string, unknown>) {
      writes.push({ table: 'rpc', op: 'rpc', payload: { name, ...params } });
      if (rpcBehavior && rpcBehavior.name === name) {
        const { data, error } = rpcBehavior.result;
        return Promise.resolve({ data, error });
      }
      return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache` } });
    },
  };
  return client as never;
}

const A1 = '11111111-1111-1111-1111-111111111111';
const A2 = '22222222-2222-2222-2222-222222222222';
const A3 = '33333333-3333-3333-3333-333333333333';

const ADDON_TABS: RankAddonTab[] = [
  { addonId: A1, addonName: 'PenguPlay' },
  { addonId: A2, addonName: 'HdHub' },
  { addonId: A3, addonName: 'Orion' },
];
const EXTENSION_TABS: RankExtensionTab[] = [
  { extensionId: 'Bollyflix', extensionName: 'Bollyflix', canonicalKey: 'cloudstream:bollyflix' },
  { extensionId: 'nuvio:moviesdrive', extensionName: 'MoviesDrive', canonicalKey: 'nuvio:moviesdrive' },
];

console.log('unified_downloader_test: ONE downloader, global ordering, admin positions, dropdown fix\n');

// ---------------------------------------------------------------------------
// §A — the pure ranking rule
// ---------------------------------------------------------------------------
{
  console.log('§A rankUnifiedSources (the global ordering rule)');
  // A1 fallback: no ordering rows → addons (tab order) then extensions (catalog order).
  const fallback = rankUnifiedSources(ADDON_TABS, EXTENSION_TABS, []);
  ok(fallback.length === 5, `A1: all sources ranked (${fallback.length})`);
  ok(
    fallback.map((source) => `${source.kind}:${source.name}`).join('|') === 'addon:PenguPlay|addon:HdHub|addon:Orion|plugin:Bollyflix|plugin:MoviesDrive',
    'A1: fallback order = addons in ordering order, then extensions in catalog order',
  );
  ok(fallback.every((source, index) => source.position === index + 1), 'A1: fallback positions are dense 1..N');

  // A2 positioned interleaving: MoviesDrive (plugin) to position 2, Bollyflix to position 4.
  const entries: SourceOrderEntry[] = [
    { sourceKey: extensionOrderKey('nuvio:moviesdrive'), position: 2 },
    { sourceKey: extensionOrderKey('cloudstream:bollyflix'), position: 4 },
  ];
  const interleaved = rankUnifiedSources(ADDON_TABS, EXTENSION_TABS, entries);
  ok(
    interleaved.map((source) => `${source.kind}:${source.name}`).join('|') === 'plugin:MoviesDrive|plugin:Bollyflix|addon:PenguPlay|addon:HdHub|addon:Orion',
    'A2: positioned sources rank by position; unpositioned sources append deterministically (addons first, then extensions)',
    interleaved.map((source) => `${source.kind}:${source.name}`).join('|'),
  );
  ok(interleaved.every((source, index) => source.position === index + 1), 'A2: interleaved positions are dense 1..N');

  // A3 the task's example shape: PenguPlay(1) → MoviesDrive(2) → HdHub(3).
  const taskExample: SourceOrderEntry[] = [
    { sourceKey: addonOrderKey(A1), position: 1 },
    { sourceKey: extensionOrderKey('nuvio:moviesdrive'), position: 2 },
    { sourceKey: addonOrderKey(A2), position: 3 },
  ];
  const example = rankUnifiedSources(ADDON_TABS, EXTENSION_TABS, taskExample);
  ok(
    example.map((source) => source.name).join('|') === 'PenguPlay|MoviesDrive|HdHub|Orion|Bollyflix',
    'A3: the PART F example order (PenguPlay → MoviesDrive → HdHub) ranks exactly',
    example.map((source) => source.name).join('|'),
  );

  // A4 unknown ordering keys are ignored (stale rows never reorder).
  const stale = rankUnifiedSources(ADDON_TABS, EXTENSION_TABS, [
    { sourceKey: 'extension:cloudstream:ghost', position: 1 },
    { sourceKey: 'addon:99999999-9999-9999-9999-999999999999', position: 1 },
  ]);
  ok(stale.map((source) => source.name).join('|') === fallback.map((source) => source.name).join('|'), 'A4: stale/unknown ordering rows never affect the order');

  // A5 malformed entries are skipped defensively (never throw).
  const malformed = rankUnifiedSources(ADDON_TABS, EXTENSION_TABS, [
    { sourceKey: '', position: 1 },
    { sourceKey: addonOrderKey(A1), position: Number.NaN },
  ]);
  ok(malformed.length === 5, 'A5: malformed ordering rows are skipped, ranking never throws');

  // A6 tie-break: same position → the documented per-kind order wins.
  const tied = rankUnifiedSources(ADDON_TABS, EXTENSION_TABS, [
    { sourceKey: addonOrderKey(A2), position: 1 },
    { sourceKey: addonOrderKey(A1), position: 1 },
  ]);
  ok(tied[0]?.name === 'PenguPlay' && tied[1]?.name === 'HdHub', 'A6: position ties break by the per-kind input order (deterministic)');

  // A7 sortUnifiedSources (the client-side mirror).
  const shuffled = [
    { kind: 'plugin' as const, id: 'x', name: 'X', position: 3 },
    { kind: 'addon' as const, id: 'y', name: 'Y', position: 1 },
    { kind: 'addon' as const, id: 'z', name: 'Z', position: 2 },
  ];
  ok(sortUnifiedSources(shuffled).map((source) => source.name).join('|') === 'Y|Z|X', 'A7: sortUnifiedSources orders by position');

  // A8 key builders + validators.
  ok(addonOrderKey(A1) === `addon:${A1}`, 'A8: addonOrderKey format');
  ok(extensionOrderKey('cloudstream:bollyflix') === 'extension:cloudstream:bollyflix', 'A8: extensionOrderKey format');
  ok(validatedAddonOrderKey(A1) === `addon:${A1}`, 'A8: validatedAddonOrderKey accepts a UUID');
  assert.throws(() => validatedAddonOrderKey('not-a-uuid'), /invalid/i, 'A8: validatedAddonOrderKey rejects a malformed id');
  ok(validatedExtensionOrderKey('nuvio:moviesdrive') === 'extension:nuvio:moviesdrive', 'A8: validatedExtensionOrderKey accepts a canonical key');
  assert.throws(() => validatedExtensionOrderKey('bollyflix'), /invalid/i, 'A8: validatedExtensionOrderKey rejects a bare name');
}

// ---------------------------------------------------------------------------
// §B — the source-order service (fake PostgREST)
// ---------------------------------------------------------------------------
{
  console.log('\n§B source-order service');

  const orderRows = [
    { source_key: `addon:${A1}`, position: 1 },
    { source_key: `addon:${A2}`, position: 2 },
    { source_key: 'extension:cloudstream:bollyflix', position: 3 },
  ];
  const tables = {
    downloader_source_order: { rows: orderRows, error: null },
    streaming_addons: { rows: [
      { id: A1, name: 'PenguPlay', ordering: 0, created_at: '2026-01-01' },
      { id: A2, name: 'HdHub', ordering: 1, created_at: '2026-01-02' },
      { id: A3, name: 'Orion', ordering: 2, created_at: '2026-01-03' },
    ], error: null },
    cloudstream_repositories: { rows: [
      { id: 'repo-1', name: 'Megix', enabled: true, created_at: '2026-02-01' },
    ], error: null },
    cloudstream_extensions: { rows: [
      { repository_id: 'repo-1', internal_name: 'Bollyflix', name: 'Bollyflix', enabled: true, integration_type: 'cloudstream' },
      { repository_id: 'repo-1', internal_name: 'MoviesDrive', name: 'MoviesDrive', enabled: true, integration_type: 'cloudstream' },
      { repository_id: 'repo-1', internal_name: 'VegaMovies', name: 'VegaMovies', enabled: false, integration_type: 'cloudstream' },
    ], error: null },
  };

  // B1 read: rows → entries.
  const entries = await getGlobalSourceOrder(fakeClient({ downloader_source_order: { rows: orderRows, error: null } }));
  ok(entries.length === 3 && entries[0]?.sourceKey === `addon:${A1}` && entries[0]?.position === 1, 'B1: getGlobalSourceOrder reads the persisted rows');
  ok(entries.every((entry) => entry.position >= 1), 'B1: entries carry 1-based positions');

  // B2 read: table missing → [] (pre-migration degradation, never throws).
  const missing = await getGlobalSourceOrder(fakeClient({ downloader_source_order: { rows: [], error: { code: 'PGRST205', message: "Could not find the table 'public.downloader_source_order' in the schema cache" } } }));
  ok(missing.length === 0, 'B2: a missing ordering table degrades to [] (the deterministic fallback takes over)');

  // B3 set: RPC success (the atomic path).
  const rpcClient = fakeClient(tables, { name: 'set_downloader_source_position', result: { data: 2, error: null } });
  const rpcResult = await setGlobalSourcePosition(rpcClient, `addon:${A2}`, 2);
  ok(rpcResult.ok && rpcResult.position === 2, 'B3: the RPC path returns the final position');

  // B4 set: RPC unavailable → read-modify-write fallback.
  const rmwClient = fakeClient(tables);
  const rmwResult = await setGlobalSourcePosition(rmwClient, 'extension:cloudstream:moviesdrive', 2);
  ok(rmwResult.ok, 'B4: the read-modify-write fallback succeeds when the RPC is missing');
  const update = rmwClient.writes.find((write) => write.op === 'update' && write.table === 'downloader_source_order');
  ok(update !== undefined, 'B4: the fallback persists the renumbered position');

  // B5 set: table missing → honest TABLE_MISSING (the add-on legacy fallback trigger).
  const tableMissingClient = fakeClient({ downloader_source_order: { rows: [], error: { code: 'PGRST205', message: 'Could not find the table' } } });
  const missingResult = await setGlobalSourcePosition(tableMissingClient, `addon:${A1}`, 1);
  ok(!missingResult.ok && missingResult.code === 'TABLE_MISSING', 'B5: a missing table reports TABLE_MISSING honestly (callers route their legacy fallbacks)');

  // B6 set: invalid inputs.
  const invalidKey = await setGlobalSourcePosition(fakeClient(tables), 'bogus', 1);
  ok(!invalidKey.ok && invalidKey.code === 'INVALID_KEY', 'B6: a malformed source key is rejected');
  const invalidPosition = await setGlobalSourcePosition(fakeClient(tables), `addon:${A1}`, 0);
  ok(!invalidPosition.ok && invalidPosition.code === 'INVALID_POSITION', 'B6: position 0 is rejected');
  const outOfRange = await setGlobalSourcePosition(fakeClient(tables), `addon:${A3}`, 99);
  ok(!outOfRange.ok && outOfRange.code === 'INVALID_POSITION' && /between 1 and/.test(outOfRange.message), 'B6: an out-of-range position is rejected with the range message');

  // B7 computeAdminGlobalPositions: the merged rank map.
  const adminPositions = await computeAdminGlobalPositions(fakeClient(tables));
  ok(adminPositions.get(`addon:${A1}`) === 1 && adminPositions.get(`addon:${A2}`) === 2, 'B7: positioned addons carry their persisted ranks');
  ok(adminPositions.get('extension:cloudstream:bollyflix') === 3, 'B7: positioned extensions carry their persisted ranks');
  ok(adminPositions.get('extension:cloudstream:moviesdrive') === 5, 'B7: the unpositioned extension falls back after the unpositioned ADD-ON (the documented fallback order)');
  ok(adminPositions.get(`addon:${A3}`) === 4, 'B7: the unpositioned add-on falls back after the positioned block (addons before extensions)');
  ok(!adminPositions.has('extension:cloudstream:vegamovies'), 'B7: a disabled extension is NOT ranked (it is not a user-facing source)');

  // B8 setExtensionPosition: derives the canonical key from the ROW (not the bare name).
  const extClient = fakeClient({
    cloudstream_extensions: { rows: [{ id: 'ext-1', internal_name: 'MoviesDrive', integration_type: 'cloudstream' }], error: null },
    downloader_source_order: { rows: [], error: null },
  });
  const notFound = await setExtensionPosition(extClient, 'ext-404', 1);
  ok(!notFound.result.ok && notFound.result.code === 'NOT_FOUND', 'B8: an unknown extension id reports NOT_FOUND');
  const invalidId = await setExtensionPosition(extClient, 42, 1);
  ok(!invalidId.result.ok && invalidId.result.code === 'INVALID_KEY', 'B8: a non-string extension id is rejected');
}

// ---------------------------------------------------------------------------
// §C — the /api/downloader/mavero/sources endpoint
// ---------------------------------------------------------------------------
{
  console.log('\n§C the unified sources endpoint');
  const { GET } = await import('../src/routes/api/downloader/mavero/sources/+server');
  type EndpointFn = (event: unknown) => Promise<Response>;
  const VALID_MOVIE = 'mediaType=movie&contentId=movie-123&tmdbId=123';
  const VALID_SERIES = 'mediaType=series&contentId=series-94605&tmdbId=94605&season=1&episode=2';

  const endpointStatus = async (handler: EndpointFn, path: string): Promise<{ status: number; body: Record<string, unknown>; retryAfter: string }> => {
    try {
      const response = await handler({
        url: new URL(`https://mavero.test${path}`),
        request: new Request(`https://mavero.test${path}`),
        locals: {},
        cookies: { get: () => undefined },
      } as never);
      return { status: response.status, body: (await response.json()) as Record<string, unknown>, retryAfter: response.headers.get('retry-after') ?? '' };
    } catch (caught) {
      // The adult guard throws the SvelteKit HttpError once validation and
      // rate limiting pass — surface its status (the established convention).
      const status = (caught as { status?: number }).status;
      return { status: typeof status === 'number' ? status : 0, body: {}, retryAfter: '' };
    }
  };

  // C1 validation: every malformed shape → 400 INVALID_REQUEST.
  const badQueries = [
    `mediaType=bogus&contentId=movie-123&tmdbId=123`,
    `mediaType=movie&tmdbId=123`,
    `mediaType=movie&contentId=movie-123`,
    `mediaType=movie&contentId=${'x'.repeat(201)}&tmdbId=123`,
    `mediaType=movie&contentId=movie-123&tmdbId=${'x'.repeat(51)}`,
    `mediaType=movie&contentId=movie-123&tmdbId=123&season=1`,
    `mediaType=movie&contentId=movie-123&tmdbId=123&episode=2`,
    `mediaType=series&contentId=series-1&tmdbId=1&season=1`,
    `mediaType=series&contentId=series-1&tmdbId=1&episode=2`,
    `mediaType=series&contentId=series-1&tmdbId=1&season=0&episode=2`,
    `mediaType=series&contentId=series-1&tmdbId=1&season=1&episode=99999`,
  ];
  let rejections = 0;
  for (const query of badQueries) {
    const { status, body } = await endpointStatus(GET as unknown as EndpointFn, `/api/downloader/mavero/sources?${query}`);
    if (status === 400 && (body as { error?: { code?: string } }).error?.code === 'INVALID_REQUEST') rejections += 1;
  }
  ok(rejections === badQueries.length, `C1: every malformed shape is rejected with 400 INVALID_REQUEST (${rejections}/${badQueries.length})`);

  // C2 valid shapes pass validation + rate limiting and reach the adult-guard
  // boundary (fail-closed 404 under tsx — the established convention).
  const movie = await endpointStatus(GET as unknown as EndpointFn, `/api/downloader/mavero/sources?${VALID_MOVIE}`);
  ok(movie.status !== 400 && movie.status !== 429, 'C2: a valid movie request is not rejected by validation/rate limit');
  const series = await endpointStatus(GET as unknown as EndpointFn, `/api/downloader/mavero/sources?${VALID_SERIES}`);
  ok(series.status !== 400 && series.status !== 429, 'C2: a valid series-episode request is not rejected by validation/rate limit');

  // C3 the separate rate-limit bucket.
  resetRateLimitsForTests();
  let saw429 = false;
  for (let index = 0; index < RATE_LIMIT_RULES.downloaderUnifiedSources.limit + 1; index += 1) {
    const { status } = await endpointStatus(GET as unknown as EndpointFn, `/api/downloader/mavero/sources?${VALID_MOVIE}&contentId=movie-${index}`);
    if (status === 429) { saw429 = true; break; }
  }
  ok(saw429, 'C3: the unified sources bucket trips within limit+1 requests');
  ok(RATE_LIMIT_RULES.downloaderUnifiedSources.limit === 30 && RATE_LIMIT_RULES.downloaderUnifiedSources.windowMs === 60_000, 'C3: the downloaderUnifiedSources bucket (30/min, the tabs-endpoint cost profile)');

  // C4 source-scan composition invariants (comments stripped — the scan
  // inspects CODE, not prose).
  const rawSource = read('src/routes/api/downloader/mavero/sources/+server.ts');
  const source = rawSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(source.includes('listAddonDownloadTargets'), 'C4: the endpoint COMPOSES the existing add-on tabs service (no second engine)');
  ok(source.includes('listCloudStreamDownloadTabs'), 'C4: the endpoint COMPOSES the existing CloudStream tabs service (permanent adapters, unchanged)');
  ok(source.includes('rankUnifiedSources'), 'C4: the endpoint merges through the shared pure ranking function');
  ok(source.includes('getGlobalSourceOrder'), 'C4: the endpoint reads the persisted global ordering');
  ok(!/builder/i.test(source) && !/PRIVATE_ADAPTER_BUILDER/.test(source), 'C4: the endpoint NEVER references the Adapter Builder (runtime independence)');
  ok(source.includes("cache-control': 'no-store'") || source.includes('NO_STORE'), 'C4: the endpoint serves no-store (fresh enable/adapter/ordering state)');
  ok(source.includes('downloaderUnifiedSources'), 'C4: the endpoint uses its own rate-limit bucket');
}

// ---------------------------------------------------------------------------
// §D — the unified panel source contracts (PART C/D)
// ---------------------------------------------------------------------------
{
  console.log('\n§D the unified panel contracts');
  const component = read('src/lib/components/MaveroUnifiedDownload.svelte');

  // D1 the chip rail: green = addon, blue = plugin.
  ok(component.includes('.mud-tab.active { border-color: var(--accent); color: var(--ink); background: var(--accent-soft); }'), 'D1: ADD-ON chips keep the GREEN primary accent (the existing treatment, verbatim)');
  ok(component.includes('.mud-tab.plugin.active { border-color: var(--accent-2); color: var(--ink); background: var(--accent-2-soft); }'), 'D1: PLUGIN chips use the BLUE secondary accent (PART C)');
  ok(component.includes('.mud-tab.plugin .mud-tab-kind { background: var(--accent-2); }'), 'D1: the plugin kind dot is blue');
  ok(component.includes('.mud-tab-kind { width: 6px; height: 6px; border-radius: 999px; background: var(--accent);'), 'D1: the add-on kind dot is green');
  ok(component.includes('.mud-tab-state.ok { color: var(--accent); }'), 'D1: the add-on count pill is green');
  ok(component.includes('.mud-tab-state.ok.plugin { color: var(--accent-2); }'), 'D1: the plugin count pill is blue');

  // D2 the per-kind resolution engines (PART D — preserved mechanisms).
  ok(component.includes('/api/downloader/mavero/addon?'), 'D2: add-on chips resolve through the EXISTING per-addon endpoint');
  ok(component.includes('/api/downloader/mavero2?'), 'D2: plugin chips resolve through the EXISTING one-batch endpoint');
  ok(component.includes('/api/downloader/mavero2/extension?'), 'D2: plugin per-source retry uses the EXISTING extension endpoint');
  ok(component.includes('/api/downloader/mavero/sources?'), 'D2: the panel loads the merged ranked list from the unified endpoint');

  // D3 the state model: loading/failed/empty/active/retry (PART C chip states).
  ok(component.includes("class:plugin={source.kind === 'plugin'}"), 'D3: chips carry the plugin discriminator class');
  ok(component.includes('mud-tab-state loading') && component.includes('mud-tab-state failed'), 'D3: chips render loading + failed states');
  ok(component.includes('aria-selected={source.id === activeSourceId}'), 'D3: the chip rail is a real tablist (aria-selected)');
  ok(component.includes('void retrySource(activeSource)'), 'D3: per-source retry is wired for the active source');
  ok(component.includes('function retryAll()'), 'D3: the manual full retry exists');

  // D4 partial success: one failed source never fails the whole list.
  ok(component.includes('activeSourceErrorMessage'), 'D4: per-source failure messages (honest partial success)');
  ok(component.includes('addonCatalogFailed') && component.includes('extensionCatalogFailed'), 'D4: per-kind catalog degradation notices');

  // D5 no registry/Builder references — the panel is a pure consumer.
  ok(!component.includes('download_providers'), 'D5: the panel never touches the download_providers registry');
  ok(!/adapter.?builder|PRIVATE_ADAPTER_BUILDER/i.test(component), 'D5: the panel NEVER references the Builder (runtime independence)');

  // D6 the shared action model (frozen semantics reused, not reimplemented).
  ok(component.includes("from '$lib/shared/stream-actions'"), 'D6: the panel reuses the shared capability action model');
  ok(component.includes('selectPresentationWindow') && component.includes('showMoreBatch'), 'D6: the panel reuses the shared presentation window');

  // D7 responsive + reduced-motion rules (the existing breakpoint family).
  ok(component.includes('@media (max-width: 360px)'), 'D7: the narrow-mobile breakpoint exists');
  ok(component.includes('@media (min-width: 700px)') && component.includes('@media (min-width: 1024px)'), 'D7: the tablet/desktop breakpoints exist');
  ok(component.includes('@media (prefers-reduced-motion: reduce)'), 'D7: reduced-motion is respected');

  // D8 filters: per-kind models (the EXISTING rules, unchanged).
  ok(component.includes("from '$lib/shared/downloader-filters'"), 'D8: the add-on filter model is reused for add-on sources');
  ok(component.includes("from '$lib/shared/cloudstream-download-view'"), 'D8: the plugin filter model is reused for plugin sources');
  ok(component.includes('resetActiveFilters'), 'D8: switching sources resets the filter state (the existing per-tab rule)');
}

// ---------------------------------------------------------------------------
// §E — admin contracts (PART G)
// ---------------------------------------------------------------------------
{
  console.log('\n§E admin position contracts');
  const api = read('src/routes/api/admin/integrations/cloudstream/extensions/+server.ts');
  ok(api.includes("'setPosition'"), 'E1: the extensions mutation endpoint exposes the setPosition action');
  ok(api.includes('setExtensionPosition'), 'E1: the action routes to the shared source-order service');
  ok(api.includes('positions: positionEntries'), 'E1: the response carries the fresh global position map (every displayed position patches)');

  const manager = read('src/lib/components/admin2/AdminCloudStreamManager.svelte');
  ok(manager.includes('globalPositions'), 'E2: the Integration Manager accepts the global positions prop');
  ok(manager.includes('cs-position-input'), 'E2: the per-row position input exists (the addon position UX mirrored)');
  ok(manager.includes('Set global position'), 'E2: the Set Position button is wired per row');
  ok(manager.includes("adapterState === 'native' || extension.adapterState === 'generated'"), 'E2: the position control shows only for rows that CAN be user-facing sources');
  ok(manager.includes('action: \'setPosition\''  .replace(/\\'/g, "'")) || manager.includes('"setPosition"') || manager.includes("'setPosition'"), 'E2: the fetch-based mutation posts the setPosition action');

  const pageServer = read('src/routes/admin/system/integrations/+page.server.ts');
  ok(pageServer.includes('computeAdminGlobalPositions'), 'E3: the page load computes the merged global rank map');
  ok(pageServer.includes('globalPositions'), 'E3: the page load returns the positions for BOTH tabs');
  ok(pageServer.includes('setGlobalSourcePosition(locals.supabase, orderKey, position)'), 'E3: the add-on position action moves the GLOBAL position');
  ok(pageServer.includes("globalResult.code === 'TABLE_MISSING'"), 'E3: the pre-migration legacy fallback is preserved (zero regression)');
  ok(pageServer.includes('await setAddonPosition(locals.supabase, id, position);'), 'E3: the legacy add-on-only path remains the fallback');

  const pageSvelte = read('src/routes/admin/system/integrations/+page.svelte');
  ok(pageSvelte.includes('addonGlobalPosition(detailAddon.id)'), 'E4: the add-on detail sheet input shows the GLOBAL rank');
  ok(pageSvelte.includes('globalPositions={data.globalPositions}'), 'E4: the Extension manager receives the positions prop');
  ok(pageSvelte.includes('spans add-ons AND plugin sources'), 'E4: the position hint explains the unified namespace');

  // E5 the admin tabs stay SEPARATE (PART I).
  ok(pageSvelte.includes("{ id: 'addon', label: 'Add-on'") && pageSvelte.includes("{ id: 'extension', label: 'Extension'"), 'E5: the Add-on and Extension admin tabs remain separate (PART I)');
  ok(pageServer.includes("VALID_TABS = new Set(['addon', 'extension'])"), 'E5: the tab contract is unchanged');
}

// ---------------------------------------------------------------------------
// §F — PART J: the provider dropdown alignment fix
// ---------------------------------------------------------------------------
{
  console.log('\n§F PART J — the dropdown alignment fix');
  const sheet = read('src/lib/components/DownloadSheet.svelte');
  const itemRule = sheet.slice(sheet.indexOf('.dl-dropdown-item {'), sheet.indexOf('.dl-close {'));
  ok(itemRule.includes('justify-content: flex-start'), 'F1: the shared item layout is flex-start (icon + adjacent title)');
  ok(!itemRule.includes('justify-content: space-between'), 'F1: the space-between distribution is GONE (the Nxsha/VidVault bug)');
  const nameRule = sheet.slice(sheet.indexOf('.dl-item-name {'), sheet.indexOf('.dl-item-badge {'));
  ok(nameRule.includes('flex: 1 1 auto') && nameRule.includes('min-width: 0'), 'F1: the title takes the flexible row (truncation preserved)');
  ok(nameRule.includes('text-overflow: ellipsis') && nameRule.includes('white-space: nowrap'), 'F1: long-name truncation preserved');
  const badgeRule = sheet.slice(sheet.indexOf('.dl-item-badge {'), sheet.indexOf('.dl-close {'));
  ok(badgeRule.includes('margin-left: auto'), 'F1: the Default badge stays pinned to the row end');
  // The fix is SHARED: the same rule renders icon-bearing AND non-icon providers.
  ok(sheet.includes('class="dl-item-icon"') && sheet.includes('class="dl-item-name"') && sheet.includes('class="dl-item-badge"'), 'F1: one shared item markup for every provider (no per-provider special casing)');
  // Dropdown behavior preserved.
  ok(sheet.includes('aria-haspopup="listbox"') && sheet.includes('role="option"'), 'F1: the listbox a11y contract is preserved');
  ok(sheet.includes('class:active={provider.id === activeProvider?.id}'), 'F1: the active state is preserved');
}

// ---------------------------------------------------------------------------
// §G — the retirement (PART B/E)
// ---------------------------------------------------------------------------
{
  console.log('\n§G the Downloader 2 retirement');
  const sheet = read('src/lib/components/DownloadSheet.svelte');
  ok(!sheet.includes('isMaveroDownloader2'), 'G1: the DownloadSheet special-casing for mavero-downloader-2 is REMOVED');
  ok(!sheet.includes('MaveroCloudStreamDownload'), 'G1: the sheet no longer renders the separate Downloader 2 panel');
  ok((sheet.match(/<MaveroUnifiedDownload/g) ?? []).length === 1, 'G1: the mavero-downloader slug renders the ONE unified panel');

  const shared = read('src/lib/shared/downloader.ts');
  ok(shared.includes("export const MAVERO_DOWNLOADER_2_PROVIDER_ID = 'mavero-downloader-2';"), 'G2: the slug constant remains registered (harmless back-compat for the retired row)');

  const migration = read('supabase/migrations/20261004000000_unified_downloader_global_order.sql');
  const migrationNoComments = migration.replace(/--[^\n]*/g, '');
  ok(/update\s+public\.download_providers\s+set\s+enabled\s*=\s*false\s+where\s+slug\s*=\s*'mavero-downloader-2'/i.test(migrationNoComments), 'G3: the migration retires the provider row (idempotent disable)');
  ok(migration.includes('create table if not exists public.downloader_source_order'), 'G3: the migration creates the global ordering table');
  ok(migration.includes('create or replace function public.set_downloader_source_position'), 'G3: the migration creates the atomic reorder RPC');
  ok(migration.includes("source_key like 'addon:%'"), 'G3: the RPC resyncs streaming_addons.ordering for addon moves (single source of truth)');
  ok(migration.includes('if v_count > 0 then'), 'G3: the backfill is first-run only (idempotent re-runs)');

  // The reusable components + standalone pages are PRESERVED (not deleted).
  for (const preserved of [
    'src/lib/components/MaveroCloudStreamDownload.svelte',
    'src/lib/components/MaveroAddonDownload.svelte',
    'src/routes/watch/mavero-downloader-2/movie/[tmdbId]/+page.svelte',
    'src/routes/watch/mavero-downloader-2/tv/[tmdbId]/[season]/[episode]/+page.svelte',
  ]) {
    ok(read(preserved).length > 0, `G4: ${preserved} is preserved (reusable code, not prematurely removed)`);
  }
}

// ---------------------------------------------------------------------------
// §H — SSR mount: the unified panel renders through vite's real graph
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
    const render = (props: Record<string, unknown>): string =>
      svelteServer.render(mod.default, { props }).body;

    // H1 movie mount: the loading surface renders (the fetch starts on mount).
    const movie = render({ contentId: 'movie-123', mediaType: 'movie', tmdbId: '123', title: 'Test Movie' });
    ok(movie.includes('mud-'), 'H1: the unified panel root renders');
    ok(movie.includes('Finding sources'), 'H1: the initial loading state renders');
    ok(movie.includes('Add-on and plugin sources'), 'H1: the unified instruction copy renders');
    ok(!movie.includes('Season '), 'H1: NO episode context for a movie');

    // H2 series mount: the episode context line renders from the props.
    const series = render({ contentId: 'series-94605', mediaType: 'series', tmdbId: '94605', season: 2, episode: 4, title: 'Arcane' });
    ok(series.includes('Season 2 · Episode 4'), 'H2: the series episode context renders at SSR');

    // H3 anime mount (contentType rides the series pipeline).
    const anime = render({ contentId: 'anime-12345', mediaType: 'anime', tmdbId: '12345', season: 1, episode: 1, title: 'Anime' });
    ok(anime.includes('Season 1 · Episode 1'), 'H3: the anime episode context renders');

    // H4 the sheet + unified panel together (the real final surface).
    const sheetMod = (await server.ssrLoadModule('/src/lib/components/DownloadSheet.svelte')) as { default: unknown };
    const sheetHtml = svelteServer.render(sheetMod.default, {
      props: {
        open: true,
        providers: [{
          id: 'p1', name: 'Mavero Downloader', slug: 'mavero-downloader', enabled: true, isDefault: true,
          ordering: 90, icon: null, description: null, supportsMovie: true, supportsTv: true,
          movieUrlTemplate: null, tvUrlTemplate: null, type: 'embed',
        }],
        title: 'Test Movie', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie',
        onClose: () => {},
      },
    }).body;
    ok(sheetHtml.includes('mud-'), 'H4: the sheet renders the unified panel inline for the mavero-downloader provider');
    ok(!sheetHtml.includes('mad-') && !sheetHtml.includes('mcd-'), 'H4: neither legacy panel mounts inside the sheet');
  } finally {
    await server.close();
  }
}

console.log(`\nunified_downloader_test: ${passed} checks passed (ONE downloader: unified sources, global ordering, admin positions, dropdown fix, retirement)`);
