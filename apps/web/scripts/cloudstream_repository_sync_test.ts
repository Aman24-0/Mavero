import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import {
  createRepositoryFromUrl,
  syncRepositoryById,
  setRepositoryEnabled,
  deleteRepositoryById,
  listRepositories,
  previewRepository,
  PREVIEW_EXTENSION_LIMIT,
} from '$lib/server/cloudstream/repository/service';
import { setExtensionEnabled, listExtensionsForAdmin } from '$lib/server/cloudstream/extensions/service';
import { CloudStreamRepositoryError } from '$lib/server/cloudstream/repository/errors';
import { fetchCloudStreamJson } from '$lib/server/cloudstream/security/fetch';

// CS-1: CloudStream repository sync + catalog service tests (plan §24, §40.3).
//
// Scope: create/sync/enable/disable/delete/preview over the cloudstream_* catalog
// with a fake Supabase client and injected fetchers. Verifies: happy-path sync,
// extension reconciliation, ENABLED-STATE PRESERVATION, non-destructive partial
// failure, timeout handling, SSRF protection, duplicate rejection, bounds,
// repository removal, and the fetch-call contract (ONLY CS.json + plugins.json
// are ever fetched — never a .cs3 artifact).
//
// No test touches the real network: fetch and DNS are always injected fakes.

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

async function rejectsCode(action: () => Promise<unknown>, code: string, label: string) {
  try {
    await action();
    assert.fail(`${label}: expected rejection with ${code}`);
  } catch (error) {
    assert.ok(error instanceof CloudStreamRepositoryError, `${label}: expected CloudStreamRepositoryError, got ${String(error)}`);
    assert.equal((error as CloudStreamRepositoryError).code, code, label);
  }
  passed += 1;
}

// ---------------------------------------------------------------------------
// Fakes — no test ever hits the real network
// ---------------------------------------------------------------------------

const PUBLIC_IP = { address: '93.184.216.34', family: 4 } as const;
const publicResolver = async () => [PUBLIC_IP];

type Row = Record<string, unknown>;

type FetchCall = { url: string; init: RequestInit | undefined };

function createFetcher(routes: Record<string, () => Response>, calls: FetchCall[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const handler = routes[url] ?? routes['*'];
    if (!handler) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return handler();
  }) as typeof fetch;
}

function jsonRoute(body: unknown, status = 200): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Emulates the PostgREST query-builder contract over in-memory tables. */
function createFakeClient() {
  const tables: Record<string, Row[]> = {
    cloudstream_repositories: [],
    cloudstream_extensions: [],
  };
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];

  function filterRows(rows: Row[], filters: Array<{ method: string; args: unknown[] }>): Row[] {
    let data = [...rows];
    for (const filter of filters) {
      if (filter.method === 'eq') data = data.filter((row) => row[filter.args[0] as string] === filter.args[1]);
      else if (filter.method === 'in') data = data.filter((row) => (filter.args[1] as unknown[]).includes(row[filter.args[0] as string]));
    }
    return data;
  }

  function sortRows(rows: Row[], orders: Array<{ column: string; ascending: boolean }>): Row[] {
    const data = [...rows];
    for (const order of [...orders].reverse()) {
      data.sort((a, b) => {
        const av = a[order.column] as string | number;
        const bv = b[order.column] as string | number;
        if (av < bv) return order.ascending ? -1 : 1;
        if (av > bv) return order.ascending ? 1 : -1;
        return 0;
      });
    }
    return data;
  }

  function makeBuilder(table: string) {
    const filters: Array<{ method: string; args: unknown[] }> = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];
    let op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' | null = null;
    let payload: Row[] | Row | null = null;
    let upsertOptions: { onConflict?: string } | null = null;
    let upsertCalled = false;

    function applyOp(): { data: Row[]; error: null } {
      const rows = tables[table];
      if (op === 'insert') {
        const inserted = Array.isArray(payload) ? (payload as Row[]) : [payload as Row];
        for (const row of inserted) rows.push({ ...row });
        return { data: inserted.map((row) => ({ ...row })), error: null };
      }
      if (op === 'upsert') {
        const upserted = Array.isArray(payload) ? (payload as Row[]) : [payload as Row];
        const conflictCols = (upsertOptions?.onConflict ?? '').split(',').map((col) => col.trim()).filter(Boolean);
        const written: Row[] = [];
        for (const row of upserted) {
          const conflictIndex = rows.findIndex((existing) =>
            conflictCols.every((col) => existing[col] === row[col]),
          );
          if (conflictIndex >= 0) {
            // PostgREST upsert on conflict: the new row's columns replace the old.
            rows[conflictIndex] = { ...row };
          } else {
            rows.push({ ...row });
          }
          written.push({ ...row });
        }
        return { data: written, error: null };
      }
      if (op === 'update') {
        const patch = payload as Row;
        const matching = filterRows(rows, filters);
        for (const row of matching) Object.assign(row, { ...patch });
        return { data: matching.map((row) => ({ ...row })), error: null };
      }
      if (op === 'delete') {
        const matching = filterRows(rows, filters);
        tables[table] = rows.filter((row) => !matching.includes(row));
        // Emulate the FK ON DELETE CASCADE for the cloudstream catalog.
        if (table === 'cloudstream_repositories') {
          const removedIds = new Set(matching.map((row) => row['id'] as string));
          tables['cloudstream_extensions'] = tables['cloudstream_extensions'].filter(
            (row) => !removedIds.has(row['repository_id'] as string),
          );
        }
        return { data: matching.map((row) => ({ ...row })), error: null };
      }
      // select
      const selected = sortRows(filterRows(rows, filters), orders);
      return { data: selected.map((row) => ({ ...row })), error: null };
    }

    const builder = {
      select(columns: string) {
        calls.push({ table, method: 'select', args: [columns] });
        if (op === null) op = 'select';
        return builder;
      },
      insert(rows: Row | Row[]) {
        calls.push({ table, method: 'insert', args: [rows] });
        op = 'insert';
        payload = rows;
        return builder;
      },
      upsert(rows: Row | Row[], options: { onConflict?: string } = {}) {
        calls.push({ table, method: 'upsert', args: [rows, options] });
        op = 'upsert';
        payload = rows;
        upsertOptions = options;
        upsertCalled = true;
        return builder;
      },
      update(patch: Row) {
        calls.push({ table, method: 'update', args: [patch] });
        op = 'update';
        payload = patch;
        return builder;
      },
      delete() {
        calls.push({ table, method: 'delete', args: [] });
        op = 'delete';
        return builder;
      },
      eq(column: string, value: unknown) {
        calls.push({ table, method: 'eq', args: [column, value] });
        filters.push({ method: 'eq', args: [column, value] });
        return builder;
      },
      in(column: string, values: unknown[]) {
        calls.push({ table, method: 'in', args: [column, values] });
        filters.push({ method: 'in', args: [column, values] });
        return builder;
      },
      order(column: string, options?: { ascending?: boolean }) {
        calls.push({ table, method: 'order', args: [column, options] });
        orders.push({ column, ascending: options?.ascending !== false });
        return builder;
      },
      single() {
        calls.push({ table, method: 'single', args: [] });
        const result = applyOp();
        if (result.data.length !== 1) {
          return Promise.resolve({ data: null, error: { message: 'Multiple rows or no rows', code: 'PGRST116' } });
        }
        return Promise.resolve({ data: result.data[0], error: null });
      },
      maybeSingle() {
        calls.push({ table, method: 'maybeSingle', args: [] });
        const result = applyOp();
        return Promise.resolve({ data: result.data[0] ?? null, error: null });
      },
      then(resolve: (value: { data: Row[]; error: null }) => void, reject: (reason?: unknown) => void) {
        try {
          resolve(applyOp());
        } catch (error) {
          reject(error);
        }
      },
      __upsertCalled: () => upsertCalled,
    };
    return builder;
  }

  const client = {
    from(table: string) {
      if (!(table in tables)) throw new Error(`fake client: unknown table ${table}`);
      return makeBuilder(table);
    },
    _tables: tables,
    _calls: calls,
  };
  return { client: client as unknown as SupabaseClient<Database>, tables, calls };
}

const NOW = '2026-11-01T00:00:00.000Z';
const baseDeps = (fetcher: typeof fetch) => ({ fetcher, dnsResolver: publicResolver, now: () => NOW });

const REPO_URL = 'https://csx.example/builds/CS.json';
const LIST_A = 'https://csx.example/builds/plugins.json';
const LIST_B = 'https://csx.example/builds/plugins2.json';

const CS_INDEX = {
  name: 'CSX',
  description: 'Example CloudStream repository',
  iconUrl: 'https://csx.example/icon.png',
  manifestVersion: 2,
  // REAL format (AC-002): pluginLists is an array of URL STRINGS.
  pluginLists: [LIST_A, LIST_B],
};

const LIST_A_ENTRIES = [
  {
    internalName: 'BollyflixProvider',
    name: 'Bollyflix',
    version: 12,
    language: 'hi',
    tvTypes: ['Movie', 'TvSeries'],
    status: 1,
    url: 'https://csx.example/builds/Bollyflix.cs3',
    iconUrl: 'https://csx.example/icons/bollyflix.png',
    fileHash: 'sha256-507b486b195b',
    fileSize: 38129,
    repositoryUrl: 'https://github.com/csx/CSX',
  },
  {
    internalName: 'MoviesDriveProvider',
    name: 'MoviesDrive',
    version: 3,
    language: 'en',
    tvTypes: ['Movie'],
    status: 2,
  },
];

const LIST_B_ENTRIES = [
  {
    internalName: 'VegaMoviesProvider',
    name: 'VegaMovies',
    version: 8,
    language: 'hi',
    tvTypes: ['Movie', 'TvSeries'],
    status: 3,
    url: 'https://csx.example/builds/VegaMovies.cs3',
  },
];

function standardRoutes(): Record<string, () => Response> {
  return {
    [REPO_URL]: jsonRoute(CS_INDEX),
    [LIST_A]: jsonRoute(LIST_A_ENTRIES),
    [LIST_B]: jsonRoute(LIST_B_ENTRIES),
  };
}

function extensionRow(client: ReturnType<typeof createFakeClient>, internalName: string): Row | undefined {
  return client.tables['cloudstream_extensions'].find((row) => row['internal_name'] === internalName);
}

// ---------------------------------------------------------------------------
// A. Create repository — happy path (2 plugin lists, 3 extensions)
// ---------------------------------------------------------------------------
{
  const fetchCalls: FetchCall[] = [];
  const fetcher = createFetcher(standardRoutes(), fetchCalls);
  const db = createFakeClient();
  const { repository, outcome } = await createRepositoryFromUrl(db.client, REPO_URL, baseDeps(fetcher));

  ok(repository.name === 'CSX', 'A: repository name persisted from index');
  ok(repository.url === REPO_URL, 'A: repository URL persisted');
  ok(repository.enabled === false, 'A: new repository starts DISABLED (addon precedent)');
  ok(repository.status === 'active', 'A: fully successful discovery → active');
  ok(repository.extensionCount === 3, 'A: all 3 extensions discovered');
  ok(outcome.insertedCount === 3 && outcome.updatedCount === 0 && outcome.removedCount === 0, 'A: outcome counts (3 inserted)');
  ok(outcome.lastError === null, 'A: no error on full success');
  ok(repository.lastSyncedAt === NOW, 'A: last_synced_at set on success');
  ok(repository.lastCheckedAt === NOW, 'A: last_checked_at set');

  const bollyflix = extensionRow(db, 'BollyflixProvider');
  ok(bollyflix !== undefined, 'A: Bollyflix row exists');
  ok(bollyflix?.['enabled'] === false, 'A: new extensions start disabled');
  ok(bollyflix?.['adapter_status'] === 'adapter_required', 'A: no adapter in CS-1 → adapter_required');
  ok(bollyflix?.['plugin_url'] === 'https://csx.example/builds/Bollyflix.cs3', 'A: .cs3 URL (real `url` field) persisted as metadata only');
  ok(bollyflix?.['mavero_adapter_id'] === null, 'A: no adapter id when not compatible');
  ok(Array.isArray(bollyflix?.['tv_types']) && (bollyflix?.['tv_types'] as string[])[0] === 'Movie', 'A: tvTypes persisted as enum NAMES (real format)');
  ok(bollyflix?.['file_hash'] === 'sha256-507b486b195b', 'A: fileHash persisted as inert metadata');
  ok(bollyflix?.['file_size_bytes'] === 38129, 'A: fileSize persisted as inert metadata');
  ok(bollyflix?.['source_url'] === 'https://github.com/csx/CSX', 'A: repositoryUrl persisted as source metadata');
  ok(bollyflix?.['icon_url'] === 'https://csx.example/icons/bollyflix.png', 'A: iconUrl (real field) persisted');

  const moviesDrive = extensionRow(db, 'MoviesDriveProvider');
  ok(moviesDrive?.['adapter_status'] === 'unsupported', 'A: plugin self-reports DOWN (2) → unsupported');
  const vega = extensionRow(db, 'VegaMoviesProvider');
  ok(vega?.['adapter_status'] === 'broken', 'A: plugin self-reports BROKEN (3) → broken');

  // Fetch contract: ONLY the index + plugin list documents were fetched —
  // the .cs3 artifact URLs were NEVER fetched.
  const fetchedUrls = fetchCalls.map((call) => call.url);
  ok(fetchedUrls.includes(REPO_URL) && fetchedUrls.includes(LIST_A) && fetchedUrls.includes(LIST_B), 'A: index + both plugin lists fetched');
  ok(fetchCalls.every((call) => !call.url.endsWith('.cs3')), 'SECURITY: .cs3 artifact URLs are never fetched');
  ok(fetchCalls.length === 3, 'A: exactly 3 documents fetched (sequential, bounded)');
}

// ---------------------------------------------------------------------------
// B. Duplicate repository rejection (canonical URL identity)
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher(standardRoutes());
  const db = createFakeClient();
  await createRepositoryFromUrl(db.client, REPO_URL, baseDeps(fetcher));
  await rejectsCode(() => createRepositoryFromUrl(db.client, REPO_URL, baseDeps(fetcher)), 'DUPLICATE_REPOSITORY', 'B: exact duplicate rejected');
  // Trailing-slash + case variants are the same canonical identity.
  await rejectsCode(
    () => createRepositoryFromUrl(db.client, 'https://CSX.example/builds/CS.json/', baseDeps(fetcher)),
    'DUPLICATE_REPOSITORY',
    'B: canonical identity (case + trailing slash) detected',
  );
  ok(db.tables['cloudstream_repositories'].length === 1, 'B: no duplicate row inserted');
}

// ---------------------------------------------------------------------------
// C. Sync — metadata update, NEW extension insert, removed extension delete,
//    ENABLED-STATE PRESERVATION (full success)
// ---------------------------------------------------------------------------
{
  const fetchCalls: FetchCall[] = [];
  const fetcher = createFetcher(standardRoutes(), fetchCalls);
  const db = createFakeClient();
  const { repository } = await createRepositoryFromUrl(db.client, REPO_URL, baseDeps(fetcher));

  // Admin enables Bollyflix between syncs.
  await setExtensionEnabled(db.client, extensionRow(db, 'BollyflixProvider')?.['id'], true);
  ok(extensionRow(db, 'BollyflixProvider')?.['enabled'] === true, 'C: extension enabled by admin');

  // Upstream changed: Bollyflix version bump, MoviesDrive REMOVED, new
  // Provider added; VegaMovies unchanged (list B).
  const updatedListA = [
    { internalName: 'BollyflixProvider', name: 'Bollyflix', version: 13, language: 'hi', tvTypes: ['Movie'], status: 1 },
    { internalName: 'NewProvider', name: 'New', version: 1, language: 'en', tvTypes: ['TvSeries'], status: 1 },
  ];
  const routes: Record<string, () => Response> = {
    [REPO_URL]: jsonRoute(CS_INDEX),
    [LIST_A]: jsonRoute(updatedListA),
    [LIST_B]: jsonRoute(LIST_B_ENTRIES),
  };
  const syncFetcher = createFetcher(routes, fetchCalls);

  const outcome = await syncRepositoryById(db.client, repository.id, baseDeps(syncFetcher));
  ok(outcome.status === 'active', 'C: sync full success → active');
  ok(outcome.discoveredCount === 3, 'C: 3 extensions discovered (Bollyflix + New + Vega)');
  ok(outcome.insertedCount === 1 && outcome.updatedCount === 2 && outcome.removedCount === 1, 'C: outcome counts (1 new, 2 updated, 1 removed)');
  ok(outcome.lastError === null, 'C: no error');

  const bollyflix = extensionRow(db, 'BollyflixProvider');
  ok(bollyflix?.['version'] === 13, 'C: metadata updated to the new version');
  ok(bollyflix?.['enabled'] === true, 'C: ENABLED STATE PRESERVED across sync');
  ok(bollyflix?.['created_at'] === NOW, 'C: created_at preserved for existing rows');
  ok(bollyflix?.['updated_at'] === NOW, 'C: updated_at refreshed');

  ok(extensionRow(db, 'NewProvider') !== undefined, 'C: newly discovered extension inserted');
  ok(extensionRow(db, 'NewProvider')?.['enabled'] === false, 'C: new extension starts disabled');
  ok(extensionRow(db, 'MoviesDriveProvider') === undefined, 'C: extension absent upstream REMOVED on full success');
  ok(db.tables['cloudstream_extensions'].length === 3, 'C: exactly 3 extension rows remain');

  const repoRow = db.tables['cloudstream_repositories'][0];
  ok(repoRow?.['last_synced_at'] === NOW, 'C: last_synced_at updated on successful sync');
}

// ---------------------------------------------------------------------------
// D. Sync — PARTIAL failure (one plugin list fails): non-destructive
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher(standardRoutes());
  const db = createFakeClient();
  const { repository } = await createRepositoryFromUrl(db.client, REPO_URL, baseDeps(fetcher));
  await setExtensionEnabled(db.client, extensionRow(db, 'MoviesDriveProvider')?.['id'], true);

  // List B now fails with a network error; list A still serves.
  const partialRoutes: Record<string, () => Response> = {
    [REPO_URL]: jsonRoute(CS_INDEX),
    [LIST_A]: jsonRoute(LIST_A_ENTRIES),
    [LIST_B]: () => new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } }),
  };
  const partialFetcher = createFetcher(partialRoutes);

  const outcome = await syncRepositoryById(db.client, repository.id, baseDeps(partialFetcher));
  ok(outcome.status === 'active', 'D: index + list A OK → status stays active');
  ok(outcome.discoveredCount === 2, 'D: only list A extensions discovered');
  ok(typeof outcome.lastError === 'string' && outcome.lastError.includes('1 of 2'), 'D: partial failure recorded with safe message');
  ok(outcome.removedCount === 0, 'D: NO removals on partial failure');

  const repoRow = db.tables['cloudstream_repositories'][0];
  ok(repoRow?.['last_error'] !== null, 'D: repository last_error set');
  ok(repoRow?.['status'] === 'active', 'D: repository stays active on partial success');
  // VegaMovies (from the FAILED list) is preserved untouched.
  const vega = extensionRow(db, 'VegaMoviesProvider');
  ok(vega !== undefined, 'D: extensions from the failed list NOT deleted (non-destructive)');
  ok(vega?.['last_checked_at'] === NOW, 'D: untouched rows keep their original last_checked_at');
  // MoviesDrive (from the successful list) keeps its enabled state.
  ok(extensionRow(db, 'MoviesDriveProvider')?.['enabled'] === true, 'D: enabled state preserved on partial sync');
}

// ---------------------------------------------------------------------------
// E. Sync — TOTAL failure (index fetch fails): extensions untouched
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher(standardRoutes());
  const db = createFakeClient();
  const { repository } = await createRepositoryFromUrl(db.client, REPO_URL, baseDeps(fetcher));
  await setExtensionEnabled(db.client, extensionRow(db, 'BollyflixProvider')?.['id'], true);
  const before = db.tables['cloudstream_extensions'].map((row) => ({ ...row }));

  const failingRoutes: Record<string, () => Response> = {
    [REPO_URL]: () => new Response('gone', { status: 503, headers: { 'content-type': 'text/plain' } }),
  };
  const outcome = await syncRepositoryById(db.client, repository.id, baseDeps(createFetcher(failingRoutes)));
  ok(outcome.status === 'error', 'E: index failure → status error');
  ok(outcome.lastError !== null, 'E: error message recorded');
  ok(outcome.discoveredCount === 0 && outcome.removedCount === 0, 'E: nothing discovered, nothing removed');

  const after = db.tables['cloudstream_extensions'].map((row) => ({ ...row }));
  ok(JSON.stringify(before) === JSON.stringify(after), 'E: ALL extension rows untouched when the index fails (non-destructive)');

  const repoRow = db.tables['cloudstream_repositories'][0];
  ok(repoRow?.['status'] === 'error', 'E: repository marked error');
  ok(repoRow?.['last_checked_at'] === NOW, 'E: last_checked_at still updated');
  ok(repoRow?.['last_synced_at'] === NOW, 'E: last_synced_at preserved from the earlier successful sync');
}

// ---------------------------------------------------------------------------
// F. Sync — PERMANENTLY invalid repository → status invalid, rows untouched
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher(standardRoutes());
  const db = createFakeClient();
  const { repository } = await createRepositoryFromUrl(db.client, REPO_URL, baseDeps(fetcher));
  const beforeCount = db.tables['cloudstream_extensions'].length;

  // The index is now a JSON array (structurally invalid).
  const invalidRoutes: Record<string, () => Response> = {
    [REPO_URL]: jsonRoute(['not', 'an', 'object']),
  };
  const outcome = await syncRepositoryById(db.client, repository.id, baseDeps(createFetcher(invalidRoutes)));
  ok(outcome.status === 'invalid', 'F: malformed index → repository invalid');
  ok(db.tables['cloudstream_extensions'].length === beforeCount, 'F: extension rows untouched');
  const repoRow = db.tables['cloudstream_repositories'][0];
  ok(repoRow?.['status'] === 'invalid', 'F: repository status invalid');
}

// ---------------------------------------------------------------------------
// G. Valid repository with NO pluginLists → created active with zero extensions
// ---------------------------------------------------------------------------
{
  const routes: Record<string, () => Response> = {
    'https://empty.example/CS.json': jsonRoute({ name: 'EmptyRepo', description: null }),
  };
  const db = createFakeClient();
  const { repository, outcome } = await createRepositoryFromUrl(db.client, 'https://empty.example/CS.json', baseDeps(createFetcher(routes)));
  ok(repository.status === 'active', 'G: zero plugin lists is a VALID repository');
  ok(repository.extensionCount === 0, 'G: zero extensions');
  ok(outcome.lastError === null, 'G: no error for a pluginLists-free repository');
  ok(db.tables['cloudstream_extensions'].length === 0, 'G: no extension rows');
}

// ---------------------------------------------------------------------------
// H. Invalid repository at CREATE time → rejected, nothing persisted
// ---------------------------------------------------------------------------
{
  const routes: Record<string, () => Response> = {
    'https://bad.example/CS.json': jsonRoute({ pluginLists: ['relative/plugins.json'] }),
  };
  const db = createFakeClient();
  await rejectsCode(() => createRepositoryFromUrl(db.client, 'https://bad.example/CS.json', baseDeps(createFetcher(routes))), 'INVALID_REPOSITORY', 'H: relative plugin-list URL rejected');
  ok(db.tables['cloudstream_repositories'].length === 0, 'H: nothing persisted on rejection');

  const routes2: Record<string, () => Response> = {
    'https://notjson.example/CS.json': () => new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  };
  await rejectsCode(() => createRepositoryFromUrl(db.client, 'https://notjson.example/CS.json', baseDeps(createFetcher(routes2))), 'INVALID_JSON', 'H: HTML response rejected as INVALID_JSON');
}

// ---------------------------------------------------------------------------
// I. SSRF protection — blocked destinations never fetched
// ---------------------------------------------------------------------------
{
  const fetchCalls: FetchCall[] = [];
  const fetcher = createFetcher({ '*': jsonRoute({ name: 'X' }) }, fetchCalls);
  const db = createFakeClient();
  await rejectsCode(() => createRepositoryFromUrl(db.client, 'http://127.0.0.1:8000/CS.json', baseDeps(fetcher)), 'BLOCKED_URL', 'I: loopback IP-literal repository URL blocked');
  await rejectsCode(() => createRepositoryFromUrl(db.client, 'http://localhost/CS.json', baseDeps(fetcher)), 'BLOCKED_URL', 'I: localhost hostname blocked');
  await rejectsCode(() => createRepositoryFromUrl(db.client, 'http://169.254.169.254/CS.json', baseDeps(fetcher)), 'BLOCKED_URL', 'I: cloud metadata endpoint blocked');
  ok(fetchCalls.length === 0, 'SECURITY: blocked destinations are never connected to');

  // DNS rebinding-style: a public-looking hostname resolving to a private IP.
  const privateResolver = async () => [{ address: '192.168.1.10', family: 4 }];
  await rejectsCode(
    () => createRepositoryFromUrl(db.client, 'https://rebind.example/CS.json', { fetcher, dnsResolver: privateResolver, now: () => NOW }),
    'BLOCKED_URL',
    'I: hostname resolving into a private network blocked (DNS-stage guard)',
  );
  ok(fetchCalls.length === 0, 'SECURITY: no connection attempt for private-resolving hosts');

  // Unit-level: the facade translates the manifest-fetch error taxonomy.
  try {
    await fetchCloudStreamJson('http://10.0.0.5/CS.json', { fetcher, dnsResolver: publicResolver });
    assert.fail('I: expected BLOCKED_URL');
  } catch (error) {
    ok(error instanceof CloudStreamRepositoryError && error.code === 'BLOCKED_URL', 'I: facade maps BLOCKED_URL into the CloudStream taxonomy');
  }
}

// ---------------------------------------------------------------------------
// J. Timeout handling — never-resolving fetcher honoring the abort signal
// ---------------------------------------------------------------------------
{
  const hangingFetcher: typeof fetch = (_input: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }) as Promise<Response> as never;
  const db = createFakeClient();
  await rejectsCode(
    () => createRepositoryFromUrl(db.client, 'https://slow.example/CS.json', { fetcher: hangingFetcher, dnsResolver: publicResolver, now: () => NOW, timeoutMs: 60 }),
    'TIMEOUT',
    'J: per-document timeout aborts and surfaces TIMEOUT',
  );
}

// ---------------------------------------------------------------------------
// K. Bounds — max 4 plugin lists fetched; 500 extension cap
// ---------------------------------------------------------------------------
{
  const fiveLists = {
    name: 'Many',
    pluginLists: [0, 1, 2, 3, 4].map((i) => `https://many.example/list-${i}.json`),
  };
  const routes: Record<string, () => Response> = {
    'https://many.example/CS.json': jsonRoute(fiveLists),
    ...Object.fromEntries(
      [0, 1, 2, 3, 4].map((i) => [`https://many.example/list-${i}.json`, jsonRoute([{ internalName: `Provider${i}` }])]),
    ),
  };
  const fetchCalls: FetchCall[] = [];
  const db = createFakeClient();
  const { repository } = await createRepositoryFromUrl(db.client, 'https://many.example/CS.json', baseDeps(createFetcher(routes, fetchCalls)));
  ok(repository.extensionCount === 4, 'K: only 4 plugin lists consumed (5th ignored)');
  const listFetched = fetchCalls.filter((call) => call.url.includes('list-'));
  ok(listFetched.length === 4, 'K: only 4 plugin-list documents fetched');
  ok(!fetchCalls.some((call) => call.url === 'https://many.example/list-4.json'), 'K: the 5th list is never fetched');
}

// ---------------------------------------------------------------------------
// L. Preview — validation only, NO persistence, bounded extension list
// ---------------------------------------------------------------------------
{
  const fetchCalls: FetchCall[] = [];
  const fetcher = createFetcher(standardRoutes(), fetchCalls);
  const db = createFakeClient();
  const preview = await previewRepository(db.client, REPO_URL, baseDeps(fetcher));
  ok(preview.repositoryUrl === REPO_URL, 'L: validated URL echoed');
  ok(preview.name === 'CSX', 'L: preview name');
  ok(preview.pluginListCount === 2, 'L: plugin list count');
  ok(preview.extensionCount === 3, 'L: total extension count');
  ok(preview.extensions.length === 3, 'L: all extensions shown (below the bound)');
  ok(preview.truncated === false, 'L: not truncated');
  ok(preview.extensions[0]?.adapterStatus === 'adapter_required', 'L: preview derives adapter status');
  ok(db.tables['cloudstream_repositories'].length === 0, 'L: preview persists NOTHING');
  ok(db.tables['cloudstream_extensions'].length === 0, 'L: preview persists no extensions');

  // Preview a repository with more than the preview bound.
  const bigList = Array.from({ length: PREVIEW_EXTENSION_LIMIT + 25 }, (_, i) => ({ internalName: `P${i}`, name: `P${i}` }));
  const bigRoutes: Record<string, () => Response> = {
    'https://big.example/CS.json': jsonRoute({ name: 'Big', pluginLists: ['https://big.example/list.json'] }),
    'https://big.example/list.json': jsonRoute(bigList),
  };
  const bigPreview = await previewRepository(db.client, 'https://big.example/CS.json', baseDeps(createFetcher(bigRoutes)));
  ok(bigPreview.extensions.length === PREVIEW_EXTENSION_LIMIT, `L: preview list bounded to ${PREVIEW_EXTENSION_LIMIT}`);
  ok(bigPreview.extensionCount === PREVIEW_EXTENSION_LIMIT + 25, 'L: total count reported honestly');
  ok(bigPreview.truncated === true, 'L: truncation flagged');

  // Duplicate URL is detected in preview (Stremio parity).
  await createRepositoryFromUrl(db.client, REPO_URL, baseDeps(fetcher));
  await rejectsCode(() => previewRepository(db.client, REPO_URL, baseDeps(fetcher)), 'DUPLICATE_REPOSITORY', 'L: duplicate repository rejected at preview time');
}

// ---------------------------------------------------------------------------
// M. Repository enable/disable + delete (cascade)
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher(standardRoutes());
  const db = createFakeClient();
  const { repository } = await createRepositoryFromUrl(db.client, REPO_URL, baseDeps(fetcher));

  await setRepositoryEnabled(db.client, repository.id, true);
  ok(db.tables['cloudstream_repositories'][0]?.['enabled'] === true, 'M: repository enabled');
  await setRepositoryEnabled(db.client, repository.id, false);
  ok(db.tables['cloudstream_repositories'][0]?.['enabled'] === false, 'M: repository disabled');

  await setRepositoryEnabled(db.client, 'not-a-uuid', true).then(
    () => assert.fail('M: expected INVALID_ID'),
    (error: unknown) => ok(error instanceof CloudStreamRepositoryError && error.code === 'INVALID_ID', 'M: invalid id rejected'),
  );
  await rejectsCode(() => setRepositoryEnabled(db.client, '00000000-0000-4000-8000-0000000000ff', true), 'NOT_FOUND', 'M: unknown repository → NOT_FOUND');

  await deleteRepositoryById(db.client, repository.id);
  ok(db.tables['cloudstream_repositories'].length === 0, 'M: repository deleted');
  ok(db.tables['cloudstream_extensions'].length === 0, 'M: extensions cascade-removed with the repository');
  await rejectsCode(() => syncRepositoryById(db.client, repository.id, baseDeps(fetcher)), 'NOT_FOUND', 'M: syncing a deleted repository → NOT_FOUND');
}

// ---------------------------------------------------------------------------
// N. Admin listing projections
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher(standardRoutes());
  const db = createFakeClient();
  await createRepositoryFromUrl(db.client, REPO_URL, baseDeps(fetcher));
  await createRepositoryFromUrl(db.client, 'https://empty.example/CS.json', {
    ...baseDeps(createFetcher({ 'https://empty.example/CS.json': jsonRoute({ name: 'EmptyRepo' }) })),
  });
  await setExtensionEnabled(db.client, extensionRow(db, 'BollyflixProvider')?.['id'], true);

  const repositories = await listRepositories(db.client);
  ok(repositories.length === 2, 'N: both repositories listed');
  ok(repositories[0]?.name === 'CSX', 'N: creation order (first created first)');
  ok(repositories[0]?.extensionCount === 3, 'N: extension counts computed');
  ok(repositories[1]?.extensionCount === 0, 'N: empty repository count');

  const extensions = await listExtensionsForAdmin(db.client);
  ok(extensions.length === 3, 'N: all extensions listed');
  ok(extensions.every((extension) => extension.repositoryName === 'CSX'), 'N: repository name joined');
  ok(extensions[0]?.internalName === 'BollyflixProvider', 'N: deterministic internal_name ordering');
  ok(extensions.find((extension) => extension.internalName === 'BollyflixProvider')?.enabled === true, 'N: enabled state projected');
  ok(extensions.find((extension) => extension.internalName === 'VegaMoviesProvider')?.adapterStatus === 'broken', 'N: adapter status projected');
}

// ---------------------------------------------------------------------------
// O. Extension enable/disable validation
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher(standardRoutes());
  const db = createFakeClient();
  await createRepositoryFromUrl(db.client, REPO_URL, baseDeps(fetcher));
  const extensionId = extensionRow(db, 'BollyflixProvider')?.['id'];
  await setExtensionEnabled(db.client, extensionId, true);
  ok(extensionRow(db, 'BollyflixProvider')?.['enabled'] === true, 'O: extension enabled');
  await setExtensionEnabled(db.client, extensionId, false);
  ok(extensionRow(db, 'BollyflixProvider')?.['enabled'] === false, 'O: extension disabled');
  await rejectsCode(() => setExtensionEnabled(db.client, '00000000-0000-4000-8000-0000000000ef', true), 'NOT_FOUND', 'O: unknown extension → NOT_FOUND');
  await setExtensionEnabled(db.client, 42, true).then(
    () => assert.fail('O: expected INVALID_ID'),
    (error: unknown) => ok(error instanceof CloudStreamRepositoryError && error.code === 'INVALID_ID', 'O: non-UUID extension id rejected'),
  );
}

// ---------------------------------------------------------------------------
// P. Malformed plugin entries skipped during sync (no internalName → skipped)
// ---------------------------------------------------------------------------
{
  const routes: Record<string, () => Response> = {
    'https://mixed.example/CS.json': jsonRoute({ name: 'Mixed', pluginLists: ['https://mixed.example/list.json'] }),
    'https://mixed.example/list.json': jsonRoute([
      { name: 'NoKey' },
      null,
      { internalName: 'GoodProvider', name: 'Good' },
      { internalName: 'GoodProvider', name: 'Duplicate' },
    ]),
  };
  const db = createFakeClient();
  const { repository } = await createRepositoryFromUrl(db.client, 'https://mixed.example/CS.json', baseDeps(createFetcher(routes)));
  ok(repository.extensionCount === 1, 'P: malformed + duplicate entries skipped during sync');
  ok(extensionRow(db, 'GoodProvider')?.['name'] === 'Good', 'P: first occurrence kept');
}

console.log(`cloudstream_repository_sync_test: ${passed} checks passed`);
