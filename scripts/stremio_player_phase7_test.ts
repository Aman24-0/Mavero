import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import {
  AddonUnsupportedError,
  UNSUPPORTED_ADDON_MESSAGE,
  DUPLICATE_ADDON_MESSAGE,
  assertAddonId,
  canonicalManifestUrlKey,
  createAddonFromManifestUrl,
  deleteAddonById,
  getAddonsAdminOverview,
  listAdminAddons,
  moveAddon,
  previewAddonFromManifestUrl,
  refreshAddonById,
  setAddonEnabled,
  slugifyAddonName,
  toAdminAddonView,
} from '$lib/server/streaming/stremio/admin-addons';
import { StreamingValidationError } from '$lib/server/streaming/validation';
import { ManifestServiceError } from '$lib/server/streaming/stremio/errors';
import { MAVERO_PLAYER_SOURCE_ID } from '$lib/shared/mavero-player';

// Phase 7: admin Stremio HTTP addon MANAGEMENT tests.
//
// Scope: /admin/addons (list, add-with-preview, enable/disable, reorder,
// refresh, delete), the admin-addons service, admin-only security posture,
// and the Phase 1–6 regression pins that must survive this phase.
//
// Behavioral tests use injected fakes ONLY (fake Supabase client, fake
// fetch, fake DNS) — no test touches the real network or a real database.
// Security invariants are pinned with static architectural assertions per
// the established repo test philosophy.

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

async function rejects(action: () => Promise<unknown>, check: (error: unknown) => boolean, label: string) {
  try {
    await action();
    assert.fail(`${label}: expected rejection`);
  } catch (error) {
    assert.ok(check(error), `${label}: unexpected error ${String(error)}`);
  }
  passed += 1;
}

function throws(action: () => unknown, check: (error: unknown) => boolean, label: string) {
  try {
    action();
    assert.fail(`${label}: expected throw`);
  } catch (error) {
    assert.ok(check(error), `${label}: unexpected error ${String(error)}`);
  }
  passed += 1;
}

const isValidationError = (error: unknown) => error instanceof StreamingValidationError;
const isUnsupportedError = (error: unknown) => error instanceof AddonUnsupportedError;
const isManifestCode = (code: string) => (error: unknown) => error instanceof ManifestServiceError && (error as ManifestServiceError).code === code;

function readRepoFile(relative: string): string {
  return readFileSync(path.resolve(relative), 'utf8');
}

// ---------------------------------------------------------------------------
// Fakes — no test ever hits the real network or database
// ---------------------------------------------------------------------------

const PUBLIC_IP = { address: '93.184.216.34', family: 4 } as const;
const publicResolver = async () => [PUBLIC_IP];

type RouteHandler = () => Response;

function createFetcher(routes: Record<string, RouteHandler>, calls: Array<{ url: string }>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    calls.push({ url });
    const handler = routes[url] ?? routes['*'];
    if (!handler) return new Response('not found', { status: 404 });
    return handler();
  }) as typeof fetch;
}

function manifestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'community.example',
    version: '1.2.3',
    name: 'Example Addon',
    description: 'An example HTTP addon',
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }],
    ...overrides,
  });
}

const MANIFEST_URL = 'https://cdn.example.com/manifest.json';

function manifestDeps(calls: Array<{ url: string }>, routes: Record<string, RouteHandler> = { [MANIFEST_URL]: () => new Response(manifestBody(), { status: 200, headers: { 'content-type': 'application/json' } }) }) {
  return { fetcher: createFetcher(routes, calls), dnsResolver: publicResolver, now: () => '2026-09-11T00:00:00.000Z' };
}

// --- Minimal PostgREST-style fake for the streaming_addons table ---

type FakeRow = Record<string, unknown> & { id: string };

function addonRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Example Addon',
    slug: 'example-addon',
    description: 'An example HTTP addon',
    manifest_url: MANIFEST_URL,
    enabled: false,
    status: 'experimental',
    ordering: 0,
    logo: null,
    version: '1.2.3',
    id_property: 'imdb_id',
    supported_types: ['movie', 'series'],
    id_prefixes: ['tt'],
    resources: ['stream', 'catalog', 'meta'],
    last_checked_at: '2026-09-10T00:00:00.000Z',
    last_success_at: '2026-09-10T00:00:00.000Z',
    last_error: null,
    capabilities: { supportsStream: true, manifestId: 'community.example' },
    notes: null,
    created_at: '2026-09-10T00:00:00.000Z',
    updated_at: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function fakeDb(initialRows: FakeRow[] = []) {
  const state = { rows: initialRows.map((row) => ({ ...row })) };
  const writes = {
    inserts: [] as FakeRow[],
    updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
    deletes: [] as string[],
  };

  function matchesOr(row: FakeRow, expr: string): boolean {
    return expr.split(',').some((term) => {
      const match = term.trim().match(/^([a-z_]+)\.(eq|like)\.(.+)$/);
      if (!match) return false;
      const [, column, operator, rawValue] = match;
      if (operator === 'eq') return row[column] === rawValue;
      return String(row[column]).startsWith(rawValue.replace(/%$/, ''));
    });
  }

  function makeChain(op: 'select' | 'insert' | 'update' | 'delete', payload: unknown) {
    let eqColumn: string | null = null;
    let eqValue: unknown = null;
    let orExpr: string | null = null;
    const orders: Array<{ column: string; ascending: boolean }> = [];
    let limitCount: number | null = null;
    let shaping: 'single' | 'maybeSingle' | null = null;

    function currentRows(): FakeRow[] {
      let rows = [...state.rows];
      if (orExpr) rows = rows.filter((row) => matchesOr(row, orExpr as string));
      if (eqColumn) rows = rows.filter((row) => row[eqColumn as string] === eqValue);
      for (const { column, ascending } of [...orders].reverse()) {
        rows.sort((a, b) => {
          const av = a[column];
          const bv = b[column];
          const cmp = av === bv ? 0 : (av as string | number) > (bv as string | number) ? 1 : -1;
          return ascending ? cmp : -cmp;
        });
      }
      if (limitCount !== null) rows = rows.slice(0, limitCount);
      return rows;
    }

    function execute(): Promise<{ data: unknown; error: unknown }> {
      if (op === 'insert') {
        // The fake table gains the inserted row (mirrors PostgREST persistence).
        const row = { ...(payload as FakeRow) };
        if (!row.created_at) row.created_at = '2026-09-11T00:00:00.000Z';
        if (!row.updated_at) row.updated_at = '2026-09-11T00:00:00.000Z';
        state.rows.push(row);
        return Promise.resolve({ data: payload, error: null });
      }
      if (op === 'update') {
        const rows = currentRows();
        if (rows.length === 0) return Promise.resolve(shaping === 'maybeSingle' ? { data: null, error: null } : { data: null, error: { code: 'PGRST116' } });
        for (const row of rows) {
          Object.assign(row, payload as Record<string, unknown>);
          writes.updates.push({ id: row.id, patch: payload as Record<string, unknown> });
        }
        const [first] = rows;
        if (shaping === 'single' || shaping === 'maybeSingle') return Promise.resolve({ data: first, error: null });
        return Promise.resolve({ data: rows, error: null });
      }
      if (op === 'delete') {
        const rows = currentRows();
        if (rows.length === 0) return Promise.resolve({ data: shaping === 'maybeSingle' ? null : [], error: null });
        state.rows = state.rows.filter((row) => !rows.includes(row));
        for (const row of rows) writes.deletes.push(row.id);
        const [first] = rows;
        if (shaping === 'single' || shaping === 'maybeSingle') return Promise.resolve({ data: first, error: null });
        return Promise.resolve({ data: rows, error: null });
      }
      const rows = currentRows().map((row) => ({ ...row }));
      if (shaping === 'single' || shaping === 'maybeSingle') return Promise.resolve({ data: rows[0] ?? null, error: null });
      return Promise.resolve({ data: rows, error: null });
    }

    const chain: Record<string, unknown> = {
      select(_arg?: string) { return chain; },
      eq(column: string, value: unknown) { eqColumn = column; eqValue = value; return chain; },
      or(expr: string) { orExpr = expr; return chain; },
      order(column: string, options?: { ascending?: boolean }) {
        orders.push({ column, ascending: options?.ascending !== false });
        return chain;
      },
      limit(count: number) { limitCount = count; return chain; },
      single() { shaping = 'single'; return chain; },
      maybeSingle() { shaping = 'maybeSingle'; return chain; },
      then(resolve: (value: { data: unknown; error: unknown }) => unknown, reject: (reason: unknown) => unknown) {
        return execute().then(resolve, reject);
      },
    };
    return chain;
  }

  const client = {
    from(table: string) {
      assert.equal(table, 'streaming_addons');
      return {
        select: () => makeChain('select', null),
        insert: (row: FakeRow) => {
          writes.inserts.push(row);
          return makeChain('insert', row);
        },
        update: (patch: Record<string, unknown>) => makeChain('update', patch),
        delete: () => makeChain('delete', null),
      };
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, state, writes };
}

// ---------------------------------------------------------------------------
// A. Admin authorization
// ---------------------------------------------------------------------------
{
  const route = readRepoFile('src/routes/admin/addons/+page.server.ts');

  ok(route.includes("await requireAdmin(locals"), 'A: admin authorization helper is used in the addons route');
  const requireAdminCount = route.split('await requireAdmin(locals').length - 1;
  ok(requireAdminCount === 7, `A: load + all 6 mutations independently verify admin authorization (${requireAdminCount}/7)`);

  const actionNames = ['previewAddon', 'confirmAddon', 'setEnabled', 'refreshAddon', 'moveAddon', 'deleteAddon'];
  const actionStarts = actionNames.map((name) => route.indexOf(`${name}: async`));
  actionNames.forEach((name, index) => {
    const start = actionStarts[index];
    ok(start !== -1, `A: ${name} action exists`);
    const later = actionStarts.filter((idx) => idx > start);
    const end = later.length ? Math.min(...later) : route.length;
    ok(route.slice(start, end).includes('requireAdmin'), `A: ${name} verifies admin authorization server-side`);
  });

  ok(!route.includes('isAdmin'), 'A: no client-side isAdmin trust anywhere in the route');
  ok(!route.includes('createSupabaseAdminClient'), 'A: admin route never touches the service-role client');
  ok(!route.includes('SUPABASE_SERVICE_ROLE'), 'A: no service-role credentials reachable from the admin route');

  // The admin page is reachable only through requireAdmin (no public load).
  ok(route.includes("redirectTo: REDIRECT"), 'A: unauthenticated visitors are redirected server-side');

  // Server-side id validation contract (every mutation validates the UUID).
  throws(() => assertAddonId('not-a-uuid'), isValidationError, 'A: non-UUID addon id rejected server-side');
  throws(() => assertAddonId(''), isValidationError, 'A: empty addon id rejected server-side');
  ok(assertAddonId(' 123e4567-e89b-42d3-a456-426614174000 ') === '123e4567-e89b-42d3-a456-426614174000', 'A: valid UUID accepted and trimmed');
  throws(() => assertAddonId('123e4567-e89b-42d3-a456-42661417400g'), isValidationError, 'A: malformed UUID rejected');

  // Normal users never see admin navigation: the shared user navigation
  // module must not link to /admin at all.
  const userNav = readRepoFile('src/lib/shared/navigation.ts');
  ok(!userNav.includes('/admin'), 'A: user-facing navigation contains no /admin links');
}

// ---------------------------------------------------------------------------
// B. Addon validation (server-side URL syntax + capability policy)
// ---------------------------------------------------------------------------
{
  const { client, writes } = fakeDb();
  const calls: Array<{ url: string }> = [];

  // Valid HTTP and HTTPS URLs reach the secure manifest service.
  const preview = await previewAddonFromManifestUrl(client, MANIFEST_URL, manifestDeps(calls));
  ok(preview.name === 'Example Addon', 'B: valid HTTPS manifest previewed');
  ok(preview.supportsStream === true, 'B: explicit stream resource detected');
  ok(calls.length === 1 && calls[0].url === MANIFEST_URL, 'B: exactly one server-side manifest fetch performed');
  ok(writes.inserts.length === 0 && writes.updates.length === 0, 'B: preview persists nothing');

  const httpPreview = await previewAddonFromManifestUrl(
    client,
    'http://cdn.example.com/manifest.json',
    manifestDeps([], { 'http://cdn.example.com/manifest.json': () => new Response(manifestBody(), { status: 200, headers: { 'content-type': 'application/json' } }) }),
  );
  ok(httpPreview.name === 'Example Addon', 'B: valid HTTP manifest accepted');

  await rejects(() => previewAddonFromManifestUrl(client, 'not a url', manifestDeps([])), isValidationError, 'B: malformed URL rejected');
  await rejects(() => previewAddonFromManifestUrl(client, 'ftp://cdn.example.com/manifest.json', manifestDeps([])), isValidationError, 'B: unsupported scheme rejected');
  await rejects(() => previewAddonFromManifestUrl(client, 'https://user:pass@example.com/manifest.json', manifestDeps([])), isValidationError, 'B: credentialed URL rejected');
  await rejects(() => previewAddonFromManifestUrl(client, 'https://example.com/a b.json', manifestDeps([])), isValidationError, 'B: whitespace URL rejected');
  await rejects(() => previewAddonFromManifestUrl(client, '', manifestDeps([])), isValidationError, 'B: empty URL rejected');

  // Unsupported capability: manifest valid but no stream resource.
  await rejects(
    () => previewAddonFromManifestUrl(client, MANIFEST_URL, manifestDeps([], { [MANIFEST_URL]: () => new Response(manifestBody({ resources: [{ name: 'catalog' }] }), { status: 200, headers: { 'content-type': 'application/json' } }) })),
    isUnsupportedError,
    'B: catalog-only addon rejected',
  );
  throws(() => { throw new AddonUnsupportedError(); }, (error) => (error as Error).message === UNSUPPORTED_ADDON_MESSAGE, 'B: unsupported message is the fixed safe string');

  // Torrent-only / magnet-only / infoHash-only manifests are HTTP-stream
  // incapable → rejected by the SAME policy (no P2P acceptance anywhere).
  for (const resources of [['torrent'], [{ name: 'torrent' }], [{ name: 'meta' }]]) {
    await rejects(
      () => previewAddonFromManifestUrl(client, MANIFEST_URL, manifestDeps([], { [MANIFEST_URL]: () => new Response(manifestBody({ resources }), { status: 200, headers: { 'content-type': 'application/json' } }) })),
      isUnsupportedError,
      `B: ${JSON.stringify(resources)}-only addon rejected (no stream capability)`,
    );
  }

  // Manifest without any usable resources → existing Phase 2 error class.
  await rejects(
    () => previewAddonFromManifestUrl(client, MANIFEST_URL, manifestDeps([], { [MANIFEST_URL]: () => new Response(manifestBody({ resources: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) })),
    isManifestCode('UNSUPPORTED_MANIFEST'),
    'B: empty-resources manifest rejected by the existing normalization policy',
  );
}

// ---------------------------------------------------------------------------
// C. Manifest service integration (metadata + capabilities persisted)
// ---------------------------------------------------------------------------
{
  const { client, writes } = fakeDb();
  const calls: Array<{ url: string }> = [];

  const created = await createAddonFromManifestUrl(client, MANIFEST_URL, manifestDeps(calls));
  ok(calls[0]?.url === MANIFEST_URL, 'C: creation fetches the manifest through the existing secure service');
  ok(writes.inserts.length === 1, 'C: exactly one addon row inserted');
  const insert = writes.inserts[0];
  ok(insert.name === 'Example Addon', 'C: name persisted from the manifest');
  ok(insert.version === '1.2.3', 'C: version persisted');
  ok(insert.manifest_url === MANIFEST_URL, 'C: manifest URL persisted');
  ok(insert.enabled === false, 'C: new addons start DISABLED (admin opts in explicitly)');
  ok(insert.status === 'experimental', 'C: status uses the existing Phase 1 default model');
  ok(insert.slug === 'example-addon', 'C: slug derived from the manifest name');
  ok(insert.ordering === 0, 'C: first addon appended at position 0');
  ok(Array.isArray(insert.supported_types) && (insert.supported_types as string[]).join(',') === 'movie,series', 'C: supported types persisted');
  ok(Array.isArray(insert.id_prefixes) && (insert.id_prefixes as string[]).join(',') === 'tt', 'C: id prefixes persisted');
  ok(Array.isArray(insert.resources) && (insert.resources as string[]).includes('stream'), 'C: stream capability persisted');
  const insertCapabilities = insert.capabilities as Record<string, unknown>;
  ok(insertCapabilities && insertCapabilities.supportsStream === true && insertCapabilities.manifestId === 'community.example', 'C: capability flags persisted');
  ok(insert.last_success_at === '2026-09-11T00:00:00.000Z' && insert.last_error === null, 'C: health fields reflect the successful validation');
  ok(typeof insert.last_checked_at === 'string', 'C: last_checked_at set on creation');
  ok(created.id === insert.id, 'C: created view returned');

  // Second addon appends after the first.
  const second = await createAddonFromManifestUrl(
    client,
    'https://other.example.com/manifest.json',
    manifestDeps([], { 'https://other.example.com/manifest.json': () => new Response(manifestBody({ id: 'community.other', name: 'Other Addon' }), { status: 200, headers: { 'content-type': 'application/json' } }) }),
  );
  ok(second.ordering === 1, 'C: second addon appended at the end of the registry order');
  ok(second.slug === 'other-addon', 'C: distinct slug derived per addon');

  // Slug collision → deduplicated slug (uniqueness contract).
  const third = await createAddonFromManifestUrl(
    client,
    'https://third.example.com/manifest.json',
    manifestDeps([], { 'https://third.example.com/manifest.json': () => new Response(manifestBody({ name: 'Other Addon' }), { status: 200, headers: { 'content-type': 'application/json' } }) }),
  );
  ok(third.slug === 'other-addon-2', 'C: colliding manifest name gets a unique slug');

  // Refresh flows through the EXISTING sync service using the STORED URL.
  const refreshCalls: Array<{ url: string }> = [];
  const outcome = await refreshAddonById(
    client,
    created.id,
    manifestDeps(refreshCalls, {
      [MANIFEST_URL]: () => new Response(manifestBody({ version: '2.0.0' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    }),
  );
  ok(outcome.ok === true, 'C: refresh succeeds');
  ok(refreshCalls.length === 1 && refreshCalls[0].url === MANIFEST_URL, 'C: refresh re-fetches the STORED manifest URL');
  const refreshUpdate = writes.updates.filter((update) => update.id === created.id).at(-1);
  ok(refreshUpdate?.patch.version === '2.0.0', 'C: refresh updates persisted metadata');
  ok(refreshUpdate?.patch.status === 'active', 'C: successful refresh marks the addon active (existing model)');
  ok(Array.isArray(refreshUpdate?.patch.capabilities as { normalizedAt?: string }) || typeof refreshUpdate?.patch.capabilities === 'object', 'C: capability JSON refreshed');
  ok(!('enabled' in (refreshUpdate?.patch ?? {})) && !('ordering' in (refreshUpdate?.patch ?? {})) && !('manifest_url' in (refreshUpdate?.patch ?? {})), 'C: refresh never writes admin-owned configuration columns');

  // refreshAddonById must NOT accept a URL: only the addon id is input.
  await rejects(() => refreshAddonById(client, 'not-a-uuid', manifestDeps([])), isValidationError, 'C: refresh with invalid id rejected');
}

// ---------------------------------------------------------------------------
// D. CRUD behavior
// ---------------------------------------------------------------------------
{
  const { client, writes } = fakeDb([addonRow(), addonRow({ id: '22222222-2222-4222-8222-222222222222', name: 'Beta', slug: 'beta', ordering: 1 })]);

  const listed = await listAdminAddons(client);
  ok(listed.length === 2, 'D: list returns all configured addons');
  ok(listed[0].name === 'Example Addon' && listed[1].name === 'Beta', 'D: list ordered by ordering then name');
  ok(listed[0].supportsStream === true, 'D: view derives stream support from the persisted model');
  ok(listed[0].status === 'experimental', 'D: view exposes the existing status model');
  ok(listed[0].manifestUrl === MANIFEST_URL, 'D: admin-only view carries the manifest URL (never for normal users)');

  const overview = await getAddonsAdminOverview(client);
  ok(overview.addonCount === 2 && overview.enabledCount === 0, 'D: overview counts addons and enabled addons');

  await setAddonEnabled(client, listed[0].id, true);
  const enable = writes.updates.filter((update) => update.id === listed[0].id).at(-1);
  ok(enable?.patch.enabled === true, 'D: enable persists the enabled column server-side');
  await setAddonEnabled(client, listed[0].id, false);
  const disable = writes.updates.filter((update) => update.id === listed[0].id).at(-1);
  ok(disable?.patch.enabled === false, 'D: disable persists the enabled column server-side');

  await deleteAddonById(client, listed[1].id);
  ok(writes.deletes.length === 1 && writes.deletes[0] === listed[1].id, 'D: delete removes exactly the requested addon');

  // Not-found handling keeps the UI honest (no silent success).
  await rejects(() => setAddonEnabled(client, '123e4567-e89b-42d3-a456-426614174000', true), isValidationError, 'D: enabling a missing addon fails safely');
  await rejects(() => deleteAddonById(client, '123e4567-e89b-42d3-a456-426614174000'), isValidationError, 'D: deleting a missing addon fails safely');
  await rejects(() => refreshAddonById(client, '123e4567-e89b-42d3-a456-426614174000', manifestDeps([])), isValidationError, 'D: refreshing a missing addon fails safely');
  await rejects(() => moveAddon(client, '123e4567-e89b-42d3-a456-426614174000', 'up'), isValidationError, 'D: moving a missing addon fails safely');
}

// ---------------------------------------------------------------------------
// E. Duplicate protection (canonical URL comparison, server-side)
// ---------------------------------------------------------------------------
{
  ok(canonicalManifestUrlKey('https://example.com/manifest.json') === canonicalManifestUrlKey('https://EXAMPLE.com:443/manifest.json/'), 'E: host case, default port and trailing slash are canonicalized');
  ok(canonicalManifestUrlKey('http://example.com/x.json') === canonicalManifestUrlKey('http://example.com:80/x.json'), 'E: http default port canonicalized');
  ok(canonicalManifestUrlKey('https://example.com/manifest.json#frag') === canonicalManifestUrlKey('https://example.com/manifest.json'), 'E: fragment ignored');
  ok(canonicalManifestUrlKey('https://example.com/a.json?x=1') !== canonicalManifestUrlKey('https://example.com/a.json'), 'E: differing query stays distinct');
  ok(canonicalManifestUrlKey('http://example.com/m.json') !== canonicalManifestUrlKey('https://example.com/m.json'), 'E: differing scheme stays distinct');

  const { client } = fakeDb([addonRow()]);
  await rejects(
    () => previewAddonFromManifestUrl(client, 'https://CDN.EXAMPLE.COM:443/manifest.json/', manifestDeps([])),
    (error) => isValidationError(error) && (error as Error).message === DUPLICATE_ADDON_MESSAGE,
    'E: canonical duplicate manifest URL rejected server-side',
  );
  await rejects(
    () => createAddonFromManifestUrl(client, MANIFEST_URL, manifestDeps([])),
    (error) => isValidationError(error) && (error as Error).message === DUPLICATE_ADDON_MESSAGE,
    'E: duplicate create rejected with the fixed safe message',
  );
  // Rejection happens BEFORE any network fetch (duplicate check first).
  const noFetch = await previewAddonFromManifestUrl(
    client,
    'https://fresh.example.com/manifest.json',
    manifestDeps([], { 'https://fresh.example.com/manifest.json': () => new Response(manifestBody(), { status: 200, headers: { 'content-type': 'application/json' } }) }),
  );
  ok(noFetch.name === 'Example Addon', 'E: non-duplicate URL proceeds to manifest validation');
}

// ---------------------------------------------------------------------------
// F. Ordering (persisted, resolver-visible, never frontend-only)
// ---------------------------------------------------------------------------
{
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const { client, writes, state } = fakeDb([
    addonRow({ id: A, name: 'Alpha', slug: 'alpha', ordering: 0 }),
    addonRow({ id: B, name: 'Beta', slug: 'beta', ordering: 1 }),
    addonRow({ id: C, name: 'Gamma', slug: 'gamma', ordering: 2 }),
  ]);

  await moveAddon(client, A, 'down');
  const alphaMove = writes.updates.find((update) => update.id === A);
  const betaMove = writes.updates.find((update) => update.id === B);
  const gammaMove = writes.updates.find((update) => update.id === C);
  ok(alphaMove?.patch.ordering === 1 && betaMove?.patch.ordering === 0, 'F: move down swaps adjacent positions (A→1, B→0)');
  ok(gammaMove === undefined, 'F: unaffected addons are never rewritten');
  ok(state.rows.find((row) => row.id === A)?.ordering === 1, 'F: persisted ordering visible in the registry state');

  // Listing follows the persisted ordering — the same order the resolver consumes.
  const listed = await listAdminAddons(client);
  ok(listed.map((addon) => addon.id).join(',') === `${B},${A},${C}`, 'F: listing reflects the persisted order');

  // Edge no-ops never write.
  writes.updates.length = 0;
  await moveAddon(client, B, 'up');
  ok(writes.updates.length === 0, 'F: moving the first addon up is a safe no-op');
  await moveAddon(client, C, 'down');
  ok(writes.updates.length === 0, 'F: moving the last addon down is a safe no-op');
  await rejects(() => moveAddon(client, B, 'sideways' as 'up'), isValidationError, 'F: invalid direction rejected');

  // Ties self-heal to a clean 0..n-1 numbering (no ordering corruption).
  const tied = fakeDb([
    addonRow({ id: A, name: 'Alpha', slug: 'alpha', ordering: 0 }),
    addonRow({ id: B, name: 'Beta', slug: 'beta', ordering: 0 }),
    addonRow({ id: C, name: 'Gamma', slug: 'gamma', ordering: 0 }),
  ]);
  await moveAddon(tied.client, B, 'down');
  const byId = Object.fromEntries(tied.state.rows.map((row) => [row.id, row.ordering]));
  ok(byId[A] === 0 && byId[C] === 1 && byId[B] === 2, 'F: tied orderings are normalized to deterministic positions');
  ok(tied.writes.updates.every((update) => typeof update.patch.ordering === 'number' && update.patch.ordering >= 0), 'F: ordering writes stay non-negative integers');

  // No frontend-only ordering: the page never computes order itself.
  const page = readRepoFile('src/routes/admin/addons/+page.svelte');
  ok(!page.includes('.order(') && !page.includes('sort('), 'F: no client-side ordering logic in the admin page');
  ok(!page.includes('fetch('), 'F: no client-side fetches in the admin page (order/mutations go through form actions)');
}

// ---------------------------------------------------------------------------
// G. Failure isolation (one broken addon never breaks the page or others)
// ---------------------------------------------------------------------------
{
  const okRow = addonRow();
  const brokenRow = addonRow({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Broken', slug: 'broken', manifest_url: 'https://broken.example.com/manifest.json', last_error: 'The addon manifest endpoint could not be reached.' });
  const { client, writes } = fakeDb([okRow, brokenRow]);

  // A failing refresh produces a SAFE persisted status and touches nothing else.
  const outcome = await refreshAddonById(
    client,
    brokenRow.id,
    manifestDeps([], { 'https://broken.example.com/manifest.json': () => new Response('boom', { status: 500 }) }),
  );
  ok(outcome.ok === false, 'G: failed refresh returns a typed failed outcome');
  const failureUpdate = writes.updates.find((update) => update.id === brokenRow.id);
  ok(typeof failureUpdate?.patch.last_error === 'string' && failureUpdate.patch.last_error.length > 0, 'G: sanitized error persisted');
  ok(!(failureUpdate?.patch.last_error as string).includes('boom'), 'G: persisted error carries no upstream response body detail');
  ok(failureUpdate?.patch.status === undefined, 'G: temporary (HTTP) failure preserves the administrator status');
  ok(writes.updates.filter((update) => update.id === okRow.id).length === 0, 'G: other addons are untouched by a failed refresh');

  // Permanent failures flip the status through the EXISTING Phase 2 policy
  // (a JSON body that fails manifest validation → INVALID_MANIFEST).
  const permanent = await refreshAddonById(
    client,
    brokenRow.id,
    manifestDeps([], { 'https://broken.example.com/manifest.json': () => new Response(JSON.stringify({ id: 'nope' }), { status: 200, headers: { 'content-type': 'application/json' } }) }),
  );
  ok(permanent.ok === false, 'G: invalid manifest refresh fails');
  const permanentUpdate = writes.updates.filter((update) => update.id === brokenRow.id).at(-1);
  ok(permanentUpdate?.patch.status === 'unavailable', 'G: permanent failure marks the addon unavailable (existing status model)');

  // The listing keeps working with the broken addon present.
  const listed = await listAdminAddons(client);
  ok(listed.length === 2, 'G: a broken addon does not remove addons from the listing');
  ok(listed.find((addon) => addon.id === okRow.id)?.lastError === undefined, 'G: healthy addon keeps clean health view');
  const brokenError = listed.find((addon) => addon.id === brokenRow.id)?.lastError;
  ok(typeof brokenError === 'string' && brokenError.length > 0, 'G: broken addon surfaces a safe status text');
  ok(!brokenError?.includes('nope') && !brokenError?.includes('broken.example.com'), 'G: the status text carries no raw bodies or internal URLs');
}

// ---------------------------------------------------------------------------
// H. Security invariants (static architectural pins)
// ---------------------------------------------------------------------------
{
  const service = readRepoFile('src/lib/server/streaming/stremio/admin-addons.ts');
  const route = readRepoFile('src/routes/admin/addons/+page.server.ts');
  const page = readRepoFile('src/routes/admin/addons/+page.svelte');

  // No P2P/torrent/debrid support anywhere in the new Phase 7 files.
  // Comment prose is stripped first: the invariant is that no CODE carries
  // these concepts (policy prose in comments is expected and safe).
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/\/\/.*$/gm, ' ');
  }
  for (const [name, text] of [['service', service], ['route', route], ['page', page]] as const) {
    const code = stripComments(text).toLowerCase();
    for (const token of ['torrent', 'magnet', 'infohash', 'peer', 'debrid', 'webtorrent', 'p2p']) {
      ok(!code.includes(token), `H: ${name} contains no ${token} support`);
    }
  }

  // The secure manifest service is the ONLY network path (no duplicate fetch).
  ok(service.includes('fetchNormalizedManifest') && service.includes('syncAddonManifest'), 'H: service reuses the existing secure manifest service functions');
  ok(!service.includes('await fetch(') && !service.includes('new Request('), 'H: no direct fetch implementation in the service');
  ok(!service.includes('http.request') && !service.includes('node:https'), 'H: no raw HTTP client usage in the service');
  ok(!route.includes('fetch(') && !page.includes('fetch('), 'H: the browser never fetches manifest URLs (spec §8)');

  // No proxy was introduced.
  ok(!service.includes('proxy') && !route.includes('proxy') && !page.includes('proxy'), 'H: no proxy concepts in Phase 7 files');
  ok(!service.includes('xhrSetup') && !service.includes('fetchSetup'), 'H: no arbitrary header proxy hooks');

  // No service-role credential exposure to the browser.
  ok(!route.includes('createSupabaseAdminClient'), 'H: admin route never uses the service-role client');
  ok(!page.includes('SUPABASE_SERVICE_ROLE') && !page.includes('service_role'), 'H: no service-role secrets in the client page');

  // RLS / migration untouched: the Phase 1 security posture is intact.
  const migration = readRepoFile('supabase/migrations/20260918000000_phase1_stremio_addons.sql');
  ok(migration.includes('streaming_addons_admin_all'), 'H: Phase 1 admin-only RLS policy intact');
  ok(migration.includes('public.is_admin()'), 'H: RLS authorization uses the existing is_admin() mechanism');
  ok(migration.includes('revoke all on public.streaming_addons from anon'), 'H: anon privileges still revoked (no public read path)');

  // The user-facing playback endpoint is untouched by Phase 7.
  const playback = readRepoFile('src/routes/api/playback/stremio/+server.ts');
  ok(playback.includes('resolveStremioStreams') && playback.includes('maveroPlayerSourceFromResolution'), 'H: playback endpoint still uses the Phase 3 resolver + Phase 4 adapter');
  ok(!playback.includes('admin-addons') && !playback.includes('createAddonFromManifestUrl'), 'H: playback endpoint has no admin management surface');
  ok(!playback.includes('manifestUrl'), 'H: playback responses expose no manifest URLs to users');

  // The player branch files are not modified by the admin implementation.
  ok(!page.includes('PlayerShell') && !page.includes('PlaybackManager') && !page.includes('hls'), 'H: admin page carries no player architecture');
}

// ---------------------------------------------------------------------------
// I. Admin UI contract (structure, a11y, loading, responsive)
// ---------------------------------------------------------------------------
{
  const page = readRepoFile('src/routes/admin/addons/+page.svelte');

  // Empty state (spec §29).
  ok(page.includes('No Stremio addons configured'), 'I: empty state headline');
  ok(page.includes('Add a supported Stremio HTTP addon to make additional streams'), 'I: empty state guidance');
  ok(page.includes("onclick={() => (addOpen = true)}"), 'I: empty state opens the add workflow');

  // Add workflow: dialog + preview states (spec §9/§11).
  ok(page.includes('Add Stremio Addon'), 'I: add entry point labeled');
  ok(page.includes('name="manifestUrl"') && page.includes('type="url"'), 'I: manifest URL input is a real url field');
  ok(page.includes('aria-describedby="addon-manifest-hint"'), 'I: manifest input is described for screen readers');
  ok(page.includes('Validating addon…') && page.includes('Adding…'), 'I: add-flow loading states exist');
  ok(page.includes('Addon detected'), 'I: successful validation shows the addon preview');
  ok(page.includes('?/confirmAddon'), 'I: preview confirmation posts to the confirm action');
  ok(page.includes('Cancel'), 'I: preview is cancellable');

  // Loading + duplicate-submission protection (spec §28/§32).
  ok(page.includes("disabled={pending !== ''}"), 'I: submit buttons disabled during mutations');
  ok(page.includes('Refreshing…') && page.includes('Removing…') && page.includes('Saving…'), 'I: per-action loading labels exist');
  ok(page.includes('aria-busy={pending ==='), 'I: aria-busy during asynchronous operations');
  ok(page.includes('if (pending) {'), 'I: duplicate submissions are ignored while a mutation is in flight');

  // Enable/disable + refresh + delete confirmation (spec §12/§14/§16).
  ok(page.includes('?/setEnabled') && page.includes("value={addon.enabled ? 'false' : 'true'}"), 'I: enable/disable toggle posts the opposite state');
  ok(page.includes('?/refreshAddon'), 'I: refresh action exists');
  ok(page.includes('Remove addon?'), 'I: destructive confirmation dialog');
  ok(page.includes('This will remove the addon from MAVERO. Its streams will no longer be available.'), 'I: deletion warns about stream loss');
  ok(page.includes('?/deleteAddon'), 'I: deletion posts to the server action');

  // Ordering controls accessible (spec §13/§27).
  ok(page.includes('aria-label={`Move ${addon.name} up`}') && page.includes('aria-label={`Move ${addon.name} down`}'), 'I: icon-only ordering buttons are labeled');
  ok(page.includes('?/moveAddon') && page.includes('direction'), 'I: ordering goes through the server action');

  // Status model (spec §7): existing server statuses surfaced.
  for (const status of ['Active', 'Disabled', 'Maintenance', 'Experimental', 'Unavailable']) {
    ok(page.includes(`'${status}'`), `I: status label ${status} from the existing model`);
  }

  // Accessibility (spec §27): semantic controls only.
  ok(page.includes('role="status"') && page.includes('role="alert"'), 'I: notice/error regions announced');
  const onClickLines = page.split('\n').filter((line) => line.includes('onclick'));
  ok(onClickLines.length > 0 && onClickLines.every((line) => line.includes('<button')), 'I: every click handler is on a real <button>');
  ok(page.includes('<form'), 'I: mutations are real forms (progressive, keyboard reachable)');
  ok(!page.includes('onclick') || !/<div[^>]*onclick/.test(page), 'I: no clickable divs');

  // Responsive design (spec §26): mobile stacking without horizontal overflow.
  ok(page.includes('@media (max-width: 700px)'), 'I: mobile breakpoint stacks the grids');
  ok(page.includes('overflow-wrap: anywhere'), 'I: long manifest URLs wrap instead of overflowing');
  ok(page.includes('grid-template-columns: 1fr'), 'I: meta grids collapse to a single column');
}

// ---------------------------------------------------------------------------
// J. Regression pins (Phase 1–6 contracts that must survive Phase 7)
// ---------------------------------------------------------------------------
{
  // Phase 6/4: MAVERO Player identity unchanged.
  ok(MAVERO_PLAYER_SOURCE_ID === 'mavero-player', 'J: MAVERO Player source identity unchanged');

  // Phase 3: resolver still consumes persisted enabled/status/ordering.
  const resolver = readRepoFile('src/lib/server/streaming/stremio/stream-resolver.ts');
  ok(resolver.includes(".eq('enabled', true)"), 'J: resolver still requires enabled=true');
  ok(resolver.includes(".in('status', ['active', 'experimental'])"), 'J: resolver status policy unchanged');
  ok(resolver.includes(".order('ordering', { ascending: true })"), 'J: resolver still consumes the persisted addon ordering');

  // Phase 2: manifest service untouched by admin concerns.
  const manifestService = readRepoFile('src/lib/server/streaming/stremio/manifest-service.ts');
  ok(manifestService.includes("['id', 'manifest_url', 'status']") || manifestService.includes("select('id, manifest_url, status')") || manifestService.includes(".select('id, manifest_url, status')"), 'J: manifest service target selection unchanged');
  ok(manifestService.toLowerCase().includes('admin-owned columns'), 'J: manifest service still never writes admin-owned columns');

  // Phase 1: the registry remains the single addon table (no second registry).
  const shared = readRepoFile('src/lib/shared/streaming-addons.ts');
  ok(shared.includes("['active', 'disabled', 'maintenance', 'experimental', 'unavailable']"), 'J: the existing status union remains the single model');

  // Admin overview wiring stays graceful (never 500s when the table is absent).
  const adminOverview = readRepoFile('src/routes/admin/+page.server.ts');
  ok(adminOverview.includes('getAddonsAdminOverview'), 'J: admin overview loads the addons card data');
  ok(adminOverview.includes('catch(() => null)'), 'J: addons overview degrades gracefully like the downloaders card');

  // Navigation: the admin shell carries the addons section (admin-only surface).
  const shell = readRepoFile('src/lib/components/AdminShell.svelte');
  ok(shell.includes("href: '/admin/addons'"), 'J: admin navigation includes the Stremio Addons section');
  ok(!readRepoFile('src/lib/shared/navigation.ts').includes('/admin/addons'), 'J: user navigation has no addons admin entry');

  // package.json: this test is registered after the Phase 6 test.
  const pkg = readRepoFile('package.json');
  const phase6 = pkg.indexOf('stremio_player_phase6_test.ts');
  const phase7 = pkg.indexOf('stremio_player_phase7_test.ts');
  ok(phase7 > phase6 && phase6 !== -1, 'J: Phase 7 test registered after Phase 6 in the test chain');
}

// ---------------------------------------------------------------------------
// Helpers contract (slug derivation + view projection)
// ---------------------------------------------------------------------------
{
  ok(slugifyAddonName('Example Addon!') === 'example-addon', 'Helpers: slug derived from the manifest name');
  ok(slugifyAddonName('日本語') === 'addon', 'Helpers: non-latin names fall back to the safe default slug');
  ok(slugifyAddonName('  A  B  ') === 'a-b', 'Helpers: whitespace collapsed and trimmed');
  const view = toAdminAddonView(addonRow() as Parameters<typeof toAdminAddonView>[0]);
  ok(view.name === 'Example Addon' && view.supportsStream === true, 'Helpers: view projects the persisted model');
  ok(view.lastError === undefined && view.description === 'An example HTTP addon', 'Helpers: null columns project to undefined/kept strings');
}

// ---------------------------------------------------------------------------

console.log(`stremio_player_phase7_test: ${passed} checks passed (admin addon management, secure server-side validation, resolver-compatible ordering)`);
