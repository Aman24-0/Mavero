import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import {
  detectExtensionManifestKind,
  parseNuvioManifest,
  canonicalNuvioMediaType,
  canonicalMediaTypeFromTvType,
  resolveNuvioModuleUrl,
  buildNuvioProviderMetadata,
  MAX_NUVIO_PROVIDER_METADATA_BYTES,
} from '$lib/server/extensions/nuvio';
import {
  canonicalAdapterKey,
  canonicalAdapterKeyForRow,
  executableAdapterForExtension,
  deriveAdapterState,
  deriveOperationalAdapterState,
  effectiveMediaTypes,
  isValidLifecycleTransition,
  requestCreateAdapterTransition,
  buildRegistryIndex,
  lookupRegistryEntry,
  listCanonicalKeys,
  toRegistryEntry,
  isBuilderState,
} from '$lib/server/extensions/adapter-registry';
import { CloudStreamRepositoryError } from '$lib/server/cloudstream/repository/errors';
import {
  createRepositoryFromUrl,
  syncRepositoryById,
  previewRepository,
} from '$lib/server/cloudstream/repository/service';
import { listExtensionsForAdmin, toExtensionView } from '$lib/server/cloudstream/extensions/service';
import {
  selectEligibleExtensions,
  resolveCloudStreamDownloads,
  resolveCloudStreamExtensionDownload,
} from '$lib/server/cloudstream/downloader/service';
import { listCloudStreamAdapters } from '$lib/server/cloudstream/adapters/registry';

// PHASE 2 — Unified Permanent Adapter System tests (Permanent Adapter Plan §4/§5).
//
// Scope: Nuvio manifest detection/parsing/identity, the unified permanent
// adapter registry + lifecycle model, type-aware Downloader 2 eligibility,
// repository-service Nuvio integration (fake client, injected fetcher), and
// the Phase 2 security posture (SSRF pipeline inheritance, NO JS execution,
// NO Render/Oracle). No test touches the real network.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

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
const privateResolver = async () => [{ address: '10.0.0.5', family: 4 }];

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
        if (table === 'cloudstream_repositories') {
          const removedIds = new Set(matching.map((row) => row['id'] as string));
          tables['cloudstream_extensions'] = tables['cloudstream_extensions'].filter(
            (row) => !removedIds.has(row['repository_id'] as string),
          );
        }
        return { data: matching.map((row) => ({ ...row })), error: null };
      }
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
      maybeSingle() {
        calls.push({ table, method: 'maybeSingle', args: [] });
        const result = applyOp();
        return Promise.resolve({ data: result.data[0] ?? null, error: null });
      },
      single() {
        calls.push({ table, method: 'single', args: [] });
        const result = applyOp();
        if (result.data.length !== 1) {
          return Promise.resolve({ data: null, error: { message: 'Multiple rows or no rows', code: 'PGRST116' } });
        }
        return Promise.resolve({ data: result.data[0], error: null });
      },
      then(resolve: (value: { data: Row[]; error: null }) => void, reject: (reason?: unknown) => void) {
        try {
          resolve(applyOp());
        } catch (error) {
          reject(error);
        }
      },
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

const NOW = '2026-11-02T00:00:00.000Z';
const baseDeps = (fetcher: typeof fetch) => ({ fetcher, dnsResolver: publicResolver, now: () => NOW });

const MANIFEST_URL = 'https://nuvio.example/manifest.json';

// A REAL-shape Nuvio manifest (schema verified live against
// phisher98/phisher-nuvio-providers + All-in-One-Nuvio + gowaru during the
// Phase 2 audit — including the provider id that COLLIDES with a native
// CloudStream adapter id, the identity-conflation probe).
const NUPIO_MANIFEST = {
  name: "Phisher's Repo",
  version: '1.0.0',
  scrapers: [
    {
      id: 'MoviesDrive',
      name: 'MoviesDrive',
      description: 'MoviesDrive streaming with multiple quality options and versions',
      version: '1.1.1',
      author: 'Phisher',
      supportedTypes: ['movie', 'tv'],
      filename: 'providers/moviesdrive.js',
      enabled: true,
      formats: ['mp4', 'mkv'],
      logo: 'https://i.imgur.com/9bGkGMi.png',
      contentLanguage: ['en'],
    },
    {
      id: 'allanime',
      name: 'AllAnime',
      description: 'AllAnime - Anime and Manga content streaming',
      version: '1.0.0',
      author: 'Nuvio Team',
      supportedTypes: ['movie', 'tv', 'anime'],
      filename: 'providers/allanime.js',
      enabled: true,
      formats: ['mp4', 'mkv', 'm3u8'],
      logo: 'https://i.postimg.cc/DwpqLJWV/allanime.png',
      contentLanguage: ['en', 'ja'],
    },
    {
      id: 'allwish',
      name: '🌟 All-Wish',
      version: '2.0.0',
      supportedTypes: ['tv'],
      filename: 'providers/allwish.js',
      enabled: false,
      limited: true,
    },
  ],
};

console.log('=== Phase 2 — Unified Permanent Adapter System tests ===\n');

// ===========================================================================
// A. Nuvio manifest detection + parsing (pure — no fakes needed)
// ===========================================================================
{
  // A1 detection precedence.
  ok(detectExtensionManifestKind(NUPIO_MANIFEST).kind === 'nuvio', 'A: scrapers array detected as Nuvio');
  ok(detectExtensionManifestKind({ pluginLists: ['https://x.example/p.json'] }).kind === 'cloudstream', 'A: pluginLists always wins as CloudStream');
  ok(detectExtensionManifestKind({ name: 'x' }).kind === 'unknown', 'A: neither signature → unknown (valid-empty CloudStream)');
  ok(detectExtensionManifestKind({ scrapers: 'nope' }).malformedScrapers === true, 'A: scrapers non-array flagged malformed');
  ok(detectExtensionManifestKind([1, 2]).kind === 'unknown', 'A: array body → unknown');
  ok(detectExtensionManifestKind(null).kind === 'unknown', 'A: null body → unknown');
  ok(detectExtensionManifestKind({ scrapers: [] }).kind === 'nuvio', 'A: empty scrapers array is still a Nuvio manifest');
  // A document with BOTH pluginLists and scrapers stays CloudStream (precedence).
  ok(
    detectExtensionManifestKind({ pluginLists: [], scrapers: [{ id: 'x' }] }).kind === 'cloudstream',
    'A: pluginLists beats scrapers (CloudStream behavior preserved byte-identically)',
  );

  // A2 provider list extraction + metadata parsing.
  const parsed = parseNuvioManifest(NUPIO_MANIFEST, MANIFEST_URL);
  ok(parsed.name === "Phisher's Repo", 'A: manifest name parsed');
  ok(parsed.version === '1.0.0', 'A: manifest version (string) parsed');
  ok(parsed.providers.length === 3, 'A: all three providers extracted');
  ok(parsed.skippedEntries === 0, 'A: no entries skipped in a valid manifest');

  const drive = parsed.providers[0]!;
  ok(drive.id === 'MoviesDrive', 'A: provider id parsed');
  ok(drive.name === 'MoviesDrive', 'A: provider name parsed');
  ok(drive.versionText === '1.1.1', 'A: STRING provider version preserved (not coerced)');
  ok(drive.description !== null && drive.description.startsWith('MoviesDrive streaming'), 'A: description parsed');
  ok(drive.author === 'Phisher', 'A: single string author parsed');
  ok(drive.filename === 'providers/moviesdrive.js', 'A: raw filename preserved');
  ok(
    drive.moduleUrl === 'https://nuvio.example/providers/moviesdrive.js',
    'A: module URL resolved against the manifest URL',
  );
  ok(drive.manifestEnabled === true, 'A: self-reported enabled captured as metadata');
  ok(JSON.stringify(drive.formats) === JSON.stringify(['mp4', 'mkv']), 'A: formats parsed');
  ok(JSON.stringify(drive.contentLanguage) === JSON.stringify(['en']), 'A: contentLanguage parsed');
  ok(drive.logoUrl === 'https://i.imgur.com/9bGkGMi.png', 'A: logo URL parsed');

  // A3 media type canonicalization.
  ok(JSON.stringify(drive.mediaTypes) === JSON.stringify(['movie', 'tv']), 'A: movie+tv supportedTypes canonicalized');
  const anime = parsed.providers[1]!;
  ok(JSON.stringify(anime.mediaTypes) === JSON.stringify(['movie', 'tv']), 'A: anime canonicalizes to tv (series pipeline), no duplicates');
  const wish = parsed.providers[2]!;
  ok(JSON.stringify(wish.mediaTypes) === JSON.stringify(['tv']), 'A: tv-only provider canonicalizes to tv');
  ok(wish.limited === true, 'A: tolerated extension field (limited) captured');
  ok(wish.author === null, 'A: absent author stays null (nothing invented)');

  // A4 canonical media-type helpers.
  ok(canonicalNuvioMediaType('movie') === 'movie', 'A: movie → movie');
  ok(canonicalNuvioMediaType('tv') === 'tv', 'A: tv → tv');
  ok(canonicalNuvioMediaType('anime') === 'tv', 'A: anime → tv');
  ok(canonicalNuvioMediaType('series') === 'tv', 'A: series → tv');
  ok(canonicalNuvioMediaType('novel') === null, 'A: unknown type dropped');
  ok(canonicalMediaTypeFromTvType('Movie') === 'movie', 'A: TvType Movie → movie');
  ok(canonicalMediaTypeFromTvType('TvSeries') === 'tv', 'A: TvType TvSeries → tv');
  ok(canonicalMediaTypeFromTvType('Anime') === 'tv', 'A: TvType Anime → tv');
  ok(canonicalMediaTypeFromTvType('Torrent') === null, 'A: TvType Torrent → null (honest no-support)');

  // A5 module URL resolution rules.
  ok(resolveNuvioModuleUrl('providers/x.js', 'https://nuvio.example/manifest.json') === 'https://nuvio.example/providers/x.js', 'A: relative filename resolved');
  ok(resolveNuvioModuleUrl('/abs/x.js', 'https://nuvio.example/manifest.json') === 'https://nuvio.example/abs/x.js', 'A: root-relative filename resolved');
  ok(resolveNuvioModuleUrl(null, MANIFEST_URL) === null, 'A: null filename → null module URL');
  ok(resolveNuvioModuleUrl('javascript:alert(1)', MANIFEST_URL) === null, 'A: non-http module scheme rejected');
  ok(resolveNuvioModuleUrl('data:text/javascript,x', MANIFEST_URL) === null, 'A: data: module scheme rejected');

  // A6 malformed / empty / invalid manifests.
  rejectsCode(() => parseNuvioManifest({ scrapers: 'oops' }, MANIFEST_URL), 'INVALID_REPOSITORY', 'A: scrapers non-array → INVALID_REPOSITORY');
  rejectsCode(() => parseNuvioManifest([1, 2], MANIFEST_URL), 'INVALID_REPOSITORY', 'A: array body → INVALID_REPOSITORY');
  const empty = parseNuvioManifest({ name: 'Empty', version: '1.0.0', scrapers: [] }, MANIFEST_URL);
  ok(empty.providers.length === 0, 'A: empty provider list → valid manifest with 0 providers');
  const invalidEntries = parseNuvioManifest({
    name: 'Bad',
    scrapers: [
      'not-an-object',
      { noId: true },
      null,
      { id: 'valid-one', supportedTypes: ['movie'] },
    ],
  }, MANIFEST_URL);
  ok(invalidEntries.providers.length === 1 && invalidEntries.providers[0]!.id === 'valid-one', 'A: invalid provider entries skipped, valid one kept');
  ok(invalidEntries.skippedEntries === 3, 'A: skipped invalid entries counted');

  // A7 duplicate provider ids in one manifest → first wins.
  const dupes = parseNuvioManifest({
    name: 'Dupes',
    scrapers: [
      { id: 'Same', name: 'First', version: '1.0.0', supportedTypes: ['movie'] },
      { id: 'same', name: 'Second', version: '2.0.0', supportedTypes: ['tv'] },
    ],
  }, MANIFEST_URL);
  ok(dupes.providers.length === 1, 'A: duplicate provider id (case-insensitive) deduplicated');
  ok(dupes.providers[0]!.name === 'First', 'A: first occurrence wins');

  // A8 provider metadata payload bounds.
  const metadata = buildNuvioProviderMetadata(drive);
  ok(metadata !== null && JSON.stringify(metadata).length <= MAX_NUVIO_PROVIDER_METADATA_BYTES, 'A: provider metadata bounded');
  ok(metadata !== null && metadata['manifestUrl'] === MANIFEST_URL, 'A: provenance manifestUrl recorded in metadata');
  ok(metadata !== null && metadata['manifestEnabled'] === true, 'A: self-reported enabled stored in metadata only');
  ok(buildNuvioProviderMetadata({ ...drive, formats: [], contentLanguage: [], limited: null, manifestEnabled: null, rawTypes: [], filename: null, manifestUrl: MANIFEST_URL }) !== null, 'A: minimal provider still records manifestUrl');
}

// ===========================================================================
// B. Unified adapter registry + lifecycle model
// ===========================================================================
{
  // B1 canonical identity.
  ok(canonicalAdapterKey('cloudstream', 'Bollyflix') === 'cloudstream:bollyflix', 'B: cloudstream canonical key lowercased');
  ok(canonicalAdapterKey('nuvio', 'MoviesDrive') === 'nuvio:moviesdrive', 'B: nuvio canonical key lowercased');
  ok(canonicalAdapterKey('cloudstream', ' Bollyflix ') === 'cloudstream:bollyflix', 'B: canonical key trims');
  ok(canonicalAdapterKey('nuvio', 'MoviesDrive') !== canonicalAdapterKey('cloudstream', 'MoviesDrive'), 'B: integration types never collide');

  // B2 TYPE-AWARE executable binding (the identity-conflation fix).
  const csDrive = { integration_type: 'cloudstream', internal_name: 'MoviesDrive' };
  const nuvioDrive = { integration_type: 'nuvio', internal_name: 'MoviesDrive' };
  ok(executableAdapterForExtension(csDrive) !== null, 'B: cloudstream MoviesDrive binds the native adapter');
  ok(executableAdapterForExtension(nuvioDrive) === null, 'B: nuvio MoviesDrive does NOT bind the native adapter (type-aware)');
  ok(executableAdapterForExtension({ integration_type: 'nuvio', internal_name: 'Whatever' }) === null, 'B: any nuvio row has no executable adapter in Phase 2');
  ok(executableAdapterForExtension({ integration_type: 'cloudstream', internal_name: 'CineStream' }) === null, 'B: unregistered cloudstream row → null');
  // Defensive normalization: not-yet-migrated rows behave like the legacy catalog.
  ok(executableAdapterForExtension({ integration_type: undefined as unknown as string, internal_name: 'MoviesDrive' }) !== null, 'B: undefined integration_type defaults to cloudstream behavior');

  // B3 lifecycle derivation.
  ok(deriveAdapterState({ ...csDrive, plugin_status: null }, null) === 'native', 'B: cloudstream + registered adapter → native');
  ok(deriveAdapterState({ integration_type: 'cloudstream', internal_name: 'X', plugin_status: 2 }, null) === 'runtime_required', 'B: plugin DOWN → runtime_required');
  ok(deriveAdapterState({ integration_type: 'cloudstream', internal_name: 'X', plugin_status: 3 }, null) === 'runtime_required', 'B: plugin BROKEN → runtime_required');
  ok(deriveAdapterState({ ...nuvioDrive, plugin_status: null }, null) === 'adapter_required', 'B: nuvio provider → adapter_required (honest)');
  ok(deriveAdapterState({ integration_type: 'cloudstream', internal_name: 'X', plugin_status: null }, 'failed') === 'failed', 'B: persisted builder failure respected');
  ok(deriveAdapterState({ integration_type: 'cloudstream', internal_name: 'X', plugin_status: null }, 'generated') === 'generated', 'B: persisted generated state represented');
  ok(deriveAdapterState({ ...csDrive, plugin_status: 2 }, 'failed') === 'native', 'B: live native binding wins over stale persisted snapshot');
  ok(isBuilderState('generated') && isBuilderState('building') && isBuilderState('testing'), 'B: builder states recognized');
  ok(!isBuilderState('native') && !isBuilderState('adapter_required'), 'B: non-builder states recognized');

  // B4 operational (display) states.
  const nativeEnabled = { integration_type: 'cloudstream', internal_name: 'MoviesDrive', plugin_status: null, enabled: true };
  const nativeDisabled = { integration_type: 'cloudstream', internal_name: 'MoviesDrive', plugin_status: null, enabled: false };
  ok(deriveOperationalAdapterState(nativeEnabled, 'native') === 'active', 'B: native + enabled → active');
  ok(deriveOperationalAdapterState(nativeDisabled, 'native') === 'disabled', 'B: native + disabled → disabled');
  ok(deriveOperationalAdapterState({ ...nativeDisabled, internal_name: 'X' }, 'adapter_required') === 'adapter_required', 'B: adapter_required surfaces regardless of enabled (Nuvio discovery state)');
  ok(deriveOperationalAdapterState({ ...nativeDisabled, integration_type: 'nuvio' }, 'adapter_required') === 'adapter_required', 'B: nuvio row shows adapter_required until an adapter exists');

  // B5 lifecycle state machine: the model exists, Phase 2 refuses the Builder.
  ok(isValidLifecycleTransition('adapter_required', 'building'), 'B: adapter_required → building is a valid MODEL transition');
  ok(isValidLifecycleTransition('building', 'testing') && isValidLifecycleTransition('testing', 'generated'), 'B: build → test → generated chain valid in the model');
  ok(isValidLifecycleTransition('testing', 'failed') && isValidLifecycleTransition('failed', 'building'), 'B: failure/retry transitions valid');
  ok(!isValidLifecycleTransition('native', 'building'), 'B: native → building invalid (native adapters are code-owned)');
  ok(!isValidLifecycleTransition('runtime_required', 'building'), 'B: runtime_required → building invalid (not convertible)');
  const refused = requestCreateAdapterTransition('adapter_required');
  ok(refused.ok === false && refused.code === 'BUILDER_UNAVAILABLE', 'B: CREATE_ADAPTER refuses in Phase 2 (no Builder)');
  ok(refused.message.includes('later phase'), 'B: refusal is honest about the Builder arriving later');
  const refusedFromNative = requestCreateAdapterTransition('native');
  ok(refusedFromNative.code === 'BUILDER_UNAVAILABLE', 'B: CREATE_ADAPTER from native also refused');

  // B6 registry index: duplicate registration prevention + canonical lookup.
  const repo1 = '00000000-0000-4000-8000-000000000001';
  const repo2 = '00000000-0000-4000-8000-000000000002';
  const registryRows = [
    {
      id: 'e1', repository_id: repo1, internal_name: 'MoviesDrive', name: 'MoviesDrive',
      integration_type: 'cloudstream', plugin_status: null, enabled: true, adapter_state: 'native',
      media_types: ['movie', 'tv'], tv_types: ['Movie', 'TvSeries'], mavero_adapter_id: null,
      adapter_version: null, last_tested_at: null, last_test_error: null, source_url: null,
    },
    {
      id: 'e2', repository_id: repo2, internal_name: 'MoviesDrive', name: 'MoviesDrive (mirror)',
      integration_type: 'cloudstream', plugin_status: null, enabled: true, adapter_state: 'native',
      media_types: ['movie', 'tv'], tv_types: ['Movie', 'TvSeries'], mavero_adapter_id: null,
      adapter_version: null, last_tested_at: null, last_test_error: null, source_url: null,
    },
    {
      id: 'e3', repository_id: repo2, internal_name: 'MoviesDrive', name: 'MoviesDrive (Nuvio)',
      integration_type: 'nuvio', plugin_status: null, enabled: true, adapter_state: 'adapter_required',
      media_types: ['movie', 'tv'], tv_types: [], mavero_adapter_id: null,
      adapter_version: null, last_tested_at: null, last_test_error: null, source_url: MANIFEST_URL,
    },
  ];
  const enabledRepos = new Set<string>([repo1, repo2]);
  const index = buildRegistryIndex(registryRows, enabledRepos);
  ok(index.size === 2, 'B: one entry per canonical key (duplicate registration prevented)');
  ok(listCanonicalKeys(index).join(',') === 'cloudstream:moviesdrive,nuvio:moviesdrive', 'B: canonical keys sorted + collision-free across types');
  const csEntry = lookupRegistryEntry(index, 'cloudstream:moviesdrive');
  ok(csEntry !== null && csEntry.extensionId === 'e1', 'B: canonical lookup deterministic (first repo wins)');
  ok(csEntry !== null && csEntry.repositoryId === repo1, 'B: entry carries the repository association');
  ok(csEntry !== null && csEntry.executable !== null && csEntry.eligible, 'B: cloudstream native entry is executable + eligible');
  ok(csEntry !== null && csEntry.maveroAdapterId === 'MoviesDrive', 'B: entry carries the Mavero adapter id');
  const nuvioEntry = lookupRegistryEntry(index, 'nuvio:moviesdrive');
  ok(nuvioEntry !== null && nuvioEntry.executable === null && !nuvioEntry.eligible, 'B: nuvio entry honestly not executable');
  ok(nuvioEntry !== null && nuvioEntry.adapterState === 'adapter_required', 'B: nuvio entry state is adapter_required');
  ok(lookupRegistryEntry(index, 'cloudstream:missing') === null, 'B: unknown canonical key → null');

  // B7 effective media types (single derivation site).
  ok(JSON.stringify(effectiveMediaTypes({ integration_type: 'cloudstream', tv_types: ['Movie', 'Anime'] })) === JSON.stringify(['movie', 'tv']), 'B: cloudstream media types derived from tv_types');
  ok(JSON.stringify(effectiveMediaTypes({ integration_type: 'nuvio', media_types: ['movie', 'tv'] })) === JSON.stringify(['movie', 'tv']), 'B: nuvio media types from stored snapshot');
  ok(effectiveMediaTypes({ integration_type: 'cloudstream', tv_types: ['Torrent'] }).length === 0, 'B: unknown cloudstream types → no media support');
  ok(effectiveMediaTypes({ integration_type: 'nuvio', media_types: ['weird'] }).length === 0, 'B: non-canonical stored values dropped');

  // B8 generated-adapter REPRESENTATION (model only — never executable in Phase 2).
  const generatedEntry = toRegistryEntry({
    id: 'e4', repository_id: repo1, internal_name: 'CineStream', name: 'CineStream',
    integration_type: 'cloudstream', plugin_status: null, enabled: true, adapter_state: 'generated',
    media_types: [], tv_types: ['Movie'], mavero_adapter_id: null, adapter_version: null,
    last_tested_at: null, last_test_error: null, source_url: null,
  }, true);
  ok(generatedEntry.adapterState === 'generated', 'B: generated state represented in the registry');
  ok(generatedEntry.executable === null && !generatedEntry.eligible, 'B: generated adapter NOT executable in Phase 2 (no generation path exists)');
  ok(generatedEntry.operationalState === 'active', 'B: generated + enabled displays active (the future steady state)');
}

console.log(`A+B sections: ${passed} checks`);

// ===========================================================================
// C. Repository service — Nuvio integration (fake client + injected fetcher)
// ===========================================================================
{
  const fetchCalls: FetchCall[] = [];
  const fetcher = createFetcher({ [MANIFEST_URL]: jsonRoute(NUPIO_MANIFEST) }, fetchCalls);
  const { client, tables } = createFakeClient();

  // C1 create a Nuvio repository from a manifest URL.
  const { repository, outcome } = await createRepositoryFromUrl(client, MANIFEST_URL, baseDeps(fetcher));
  ok(repository.integrationType === 'nuvio', 'C: repository row records integration_type nuvio');
  ok(repository.status === 'active', 'C: single-document Nuvio sync is active');
  ok(outcome.discoveredCount === 3 && outcome.insertedCount === 3, 'C: 3 providers discovered + inserted (no more "0 extensions")');
  ok(outcome.lastError === null, 'C: no list failures on the Nuvio path');

  const repoRow = tables['cloudstream_repositories']![0]!;
  ok(repoRow['integration_type'] === 'nuvio', 'C: persisted repository integration_type');
  ok(repoRow['enabled'] === false, 'C: new Nuvio repository starts DISABLED (admin switch)');

  const extRows = tables['cloudstream_extensions']! as Array<Record<string, unknown>>;
  ok(extRows.length === 3, 'C: three Nuvio provider rows persisted');
  const driveRow = extRows.find((row) => row['internal_name'] === 'MoviesDrive');
  ok(driveRow !== undefined, 'C: MoviesDrive scraper row exists');
  ok(driveRow!['integration_type'] === 'nuvio', 'C: extension row integration_type nuvio');
  ok(driveRow!['enabled'] === false, 'C: manifest self-reported enabled does NOT set the DB enabled flag');
  ok(driveRow!['adapter_state'] === 'adapter_required', 'C: Nuvio provider state is adapter_required (honest)');
  ok(driveRow!['adapter_status'] === 'adapter_required', 'C: legacy adapter_status also adapter_required (no false compatibility)');
  ok(driveRow!['mavero_adapter_id'] === null, 'C: Nuvio MoviesDrive does NOT bind the native adapter id');
  ok(driveRow!['version_text'] === '1.1.1', 'C: string version persisted');
  ok(driveRow!['version'] === null, 'C: integer version column stays null for Nuvio');
  ok(driveRow!['module_url'] === 'https://nuvio.example/providers/moviesdrive.js', 'C: resolved module URL persisted as metadata');
  ok(driveRow!['plugin_url'] === null, 'C: no .cs3 plugin URL for Nuvio rows');
  ok(driveRow!['source_url'] === MANIFEST_URL, 'C: manifest URL recorded as provenance');
  ok(JSON.stringify(driveRow!['media_types']) === JSON.stringify(['movie', 'tv']), 'C: canonical media types persisted');
  const metadata = driveRow!['provider_metadata'] as Record<string, unknown>;
  ok(metadata['manifestUrl'] === MANIFEST_URL && metadata['manifestEnabled'] === true, 'C: provider metadata persisted with provenance');

  // C2 the fetch-call contract: ONLY the manifest is fetched — the JS module
  // is NEVER fetched (metadata only).
  ok(fetchCalls.length === 1 && fetchCalls[0]!.url === MANIFEST_URL, 'C: exactly ONE fetch (the manifest) — no plugin-list follow-ups');
  ok(fetchCalls.every((call) => !call.url.endsWith('.js')), 'C: provider JS modules are never fetched');

  // C3 admin view projection (the Phase 2 data contract).
  const views = await listExtensionsForAdmin(client);
  ok(views.length === 3, 'C: admin listing includes Nuvio providers');
  const driveView = views.find((view) => view.internalName === 'MoviesDrive');
  ok(driveView !== undefined && driveView.integrationType === 'nuvio', 'C: view carries integrationType');
  ok(driveView !== undefined && driveView.adapterState === 'adapter_required', 'C: view carries the adapter state');
  ok(driveView !== undefined && driveView.moduleUrl === 'https://nuvio.example/providers/moviesdrive.js', 'C: view carries moduleUrl (inert metadata)');
  ok(driveView !== undefined && driveView.versionText === '1.1.1', 'C: view carries versionText');
  ok(driveView !== undefined && driveView.mediaTypes.join(',') === 'movie,tv', 'C: view carries canonical media types');
  ok(driveView !== undefined && driveView.providerMetadata?.formats?.length === 2, 'C: view carries bounded provider metadata (formats)');

  // C4 preview shows the Nuvio schema before persistence.
  const { client: previewClient } = createFakeClient();
  const preview = await previewRepository(previewClient, MANIFEST_URL, baseDeps(fetcher));
  ok(preview.integrationType === 'nuvio', 'C: preview reports the detected Nuvio schema');
  ok(preview.extensionCount === 3, 'C: preview shows the actual providers (not 0)');
  ok(preview.extensions[0]!.integrationType === 'nuvio', 'C: preview entries carry integrationType');
  ok(preview.extensions[0]!.adapterStatus === 'adapter_required', 'C: preview entries honestly adapter_required');

  // C5 re-sync preserves the admin enabled state + updates metadata.
  const setEnabled = tables['cloudstream_extensions']!.find((row) => row['internal_name'] === 'MoviesDrive')!;
  setEnabled['enabled'] = true;
  const secondManifest = { ...NUPIO_MANIFEST, scrapers: [...NUPIO_MANIFEST.scrapers] };
  const fetcher2 = createFetcher({ [MANIFEST_URL]: jsonRoute(secondManifest) });
  await syncRepositoryById(client, repository.id, baseDeps(fetcher2));
  const driveAfter = (tables['cloudstream_extensions']! as Array<Record<string, unknown>>).find((row) => row['internal_name'] === 'MoviesDrive')!;
  ok(driveAfter['enabled'] === true, 'C: enabled state PRESERVED across Nuvio re-sync');

  // C6 duplicate URL rejection (canonical repository identity).
  const dupClient = createFakeClient();
  await createRepositoryFromUrl(dupClient.client, MANIFEST_URL, baseDeps(fetcher));
  await rejectsCode(() => createRepositoryFromUrl(dupClient.client, MANIFEST_URL, baseDeps(fetcher)), 'DUPLICATE_REPOSITORY', 'C: duplicate Nuvio manifest URL rejected');

  // C7 duplicate provider rows: same repository + same provider → one row.
  const dupManifest = {
    name: 'Dup',
    scrapers: [
      { id: 'Same', version: '1', supportedTypes: ['movie'] },
      { id: 'SAME', version: '2', supportedTypes: ['tv'] },
    ],
  };
  const dupFetch = createFetcher({ [MANIFEST_URL]: jsonRoute(dupManifest) });
  const { client: dupRowsClient, tables: dupTables } = createFakeClient();
  await createRepositoryFromUrl(dupRowsClient, MANIFEST_URL, baseDeps(dupFetch));
  const sameRows = (dupTables['cloudstream_extensions']! as Array<Record<string, unknown>>).filter((row) => row['internal_name'] === 'Same');
  ok(sameRows.length === 1, 'C: same repository + same provider never creates duplicate rows');
}

console.log(`A+B+C sections: ${passed} checks`);

// ===========================================================================
// D. CloudStream path unchanged + type-aware Downloader 2 eligibility
// ===========================================================================
{
  // D1 the CloudStream path is byte-identical: a CS.json still syncs the same way.
  const LIST_URL = 'https://csx.example/plugins.json';
  const CS_INDEX = {
    name: 'CSX',
    description: 'Example CloudStream repository',
    pluginLists: [LIST_URL],
  };
  const CS_ENTRIES = [
    { internalName: 'MoviesDrive', name: 'MoviesDrive', version: 44, tvTypes: ['Movie', 'TvSeries'] },
    { internalName: 'CineStream', name: 'CineStream', version: 3, tvTypes: ['Movie'] },
  ];
  const csFetcher = createFetcher({
    'https://csx.example/CS.json': jsonRoute(CS_INDEX),
    'https://csx.example/CS2.json': jsonRoute(CS_INDEX),
    [LIST_URL]: jsonRoute(CS_ENTRIES),
  });
  const { client: csClient, tables: csTables } = createFakeClient();
  const { repository: csRepo, outcome: csOutcome } = await createRepositoryFromUrl(csClient, 'https://csx.example/CS.json', baseDeps(csFetcher));
  ok(csRepo.integrationType === 'cloudstream', 'D: CloudStream repository records integration_type cloudstream');
  ok(csOutcome.discoveredCount === 2, 'D: CloudStream discovery unchanged');
  const csDrive = (csTables['cloudstream_extensions']! as Array<Record<string, unknown>>).find((row) => row['internal_name'] === 'MoviesDrive')!;
  ok(csDrive['integration_type'] === 'cloudstream', 'D: CloudStream extension rows typed cloudstream');
  ok(csDrive['adapter_state'] === 'native', 'D: registered CloudStream provider derives native state');
  ok(JSON.stringify(csDrive['media_types']) === JSON.stringify(['movie', 'tv']), 'D: CloudStream media types derived from TvTypes at sync');
  ok(csDrive['version'] === 44 && csDrive['version_text'] === null, 'D: CloudStream integer version column unchanged');
  const csCine = (csTables['cloudstream_extensions']! as Array<Record<string, unknown>>).find((row) => row['internal_name'] === 'CineStream')!;
  ok(csCine['adapter_state'] === 'adapter_required', 'D: unsupported CloudStream provider remains ADAPTER_REQUIRED');
  ok(csCine['adapter_status'] === 'adapter_required', 'D: legacy adapter_status unchanged for unregistered providers');

  // D2 native adapter discovery + registry pin.
  const adapters = listCloudStreamAdapters();
  ok(adapters.length === 3, 'D: the 3 native adapters (Bollyflix, MoviesDrive, VegaMovies) still registered');
  ok(adapters.every((adapter) => adapter.supports.movie || adapter.supports.series), 'D: native adapters declare media support');

  // D3 type-aware eligibility: the unified catalog carries BOTH rows.
  const nuvioFetch = createFetcher({ [MANIFEST_URL]: jsonRoute(NUPIO_MANIFEST) });
  const { client: mixedClient, tables: mixedTables } = createFakeClient();
  await createRepositoryFromUrl(mixedClient, 'https://csx.example/CS.json', baseDeps(csFetcher));
  await createRepositoryFromUrl(mixedClient, MANIFEST_URL, baseDeps(nuvioFetch));
  // Enable everything.
  for (const row of mixedTables['cloudstream_repositories']!) row['enabled'] = true;
  for (const row of mixedTables['cloudstream_extensions']!) row['enabled'] = true;

  const catalogRows = (mixedTables['cloudstream_extensions']! as Array<Record<string, unknown>>).map((row) => ({
    repository_id: row['repository_id'] as string,
    internal_name: row['internal_name'] as string,
    name: row['name'] as string | null,
    icon_url: row['icon_url'] as string | null,
    enabled: row['enabled'] as boolean,
    integration_type: row['integration_type'] as string,
  }));
  const repoRows = (mixedTables['cloudstream_repositories']! as Array<Record<string, unknown>>).map((row) => ({
    id: row['id'] as string,
    enabled: row['enabled'] as boolean,
    created_at: row['created_at'] as string,
  }));
  const catalog = { repositories: repoRows, extensions: catalogRows };

  const eligibleMovie = selectEligibleExtensions(catalog, 'movie');
  const eligibleNames = eligibleMovie.map(({ row }) => row.internal_name);
  ok(eligibleNames.includes('MoviesDrive'), 'D: cloudstream MoviesDrive eligible (native binding)');
  ok(!eligibleNames.includes('CineStream'), 'D: unregistered cloudstream provider not eligible');
  ok(!eligibleNames.some((name) => name === 'allanime' || name === 'allwish'), 'D: Nuvio providers never eligible in Phase 2');
  // The Nuvio MoviesDrive row collides by id with the native adapter — it must
  // not create a SECOND eligible entry (canonical dedup + type-awareness).
  ok(eligibleMovie.filter(({ row }) => row.internal_name.toLowerCase() === 'moviesdrive').length === 1, 'D: exactly ONE MoviesDrive eligible entry (canonical dedup, no Nuvio conflation)');

  // D4 canonical dedup across two CloudStream repositories.
  const { client: dup2Client, tables: dup2Tables } = createFakeClient();
  await createRepositoryFromUrl(dup2Client, 'https://csx.example/CS.json', baseDeps(csFetcher));
  await createRepositoryFromUrl(dup2Client, 'https://csx.example/CS2.json', baseDeps(csFetcher));
  for (const row of dup2Tables['cloudstream_repositories']!) row['enabled'] = true;
  for (const row of dup2Tables['cloudstream_extensions']!) row['enabled'] = true;
  const dup2Catalog = {
    repositories: (dup2Tables['cloudstream_repositories']! as Array<Record<string, unknown>>).map((row) => ({ id: row['id'] as string, enabled: row['enabled'] as boolean, created_at: row['created_at'] as string })),
    extensions: (dup2Tables['cloudstream_extensions']! as Array<Record<string, unknown>>).map((row) => ({
      repository_id: row['repository_id'] as string,
      internal_name: row['internal_name'] as string,
      name: row['name'] as string | null,
      icon_url: row['icon_url'] as string | null,
      enabled: row['enabled'] as boolean,
      integration_type: row['integration_type'] as string,
    })),
  };
  const dup2Eligible = selectEligibleExtensions(dup2Catalog, 'movie');
  ok(dup2Eligible.filter(({ row }) => row.internal_name.toLowerCase() === 'moviesdrive').length === 1, 'D: same provider in two repositories resolves exactly ONCE');

  // D5 batch resolution with an explicitly-selected Nuvio extension →
  // honest ADAPTER_NOT_AVAILABLE group (never executes anything).
  const resolveDeps = {
    loadContent: async () => ({ mediaType: 'movie' as const, tmdbId: '27205', title: 'Inception' }),
    loadCatalog: async () => catalog,
    fetcher: nuvioFetch,
    dnsResolver: publicResolver,
    adapterTimeoutMs: 500,
    overallTimeoutMs: 2000,
  };
  const resolved = await resolveCloudStreamDownloads(
    mixedClient,
    { mediaType: 'movie', contentId: 'mv-1' },
    { extensionIds: ['allanime'] },
    resolveDeps,
  );
  const nuvioGroup = resolved.groups.find((group) => group.extensionId === 'allanime');
  ok(nuvioGroup !== undefined && nuvioGroup.status === 'failed', 'D: explicitly-selected Nuvio provider fails honestly');
  ok(nuvioGroup?.errorCode === 'ADAPTER_NOT_AVAILABLE', 'D: Nuvio selection → ADAPTER_NOT_AVAILABLE (no execution)');
  ok(nuvioGroup?.links.length === 0, 'D: no links from a Nuvio provider in Phase 2');

  // D6 single-extension endpoint: Nuvio → ADAPTER_NOT_AVAILABLE envelope.
  const nuvioFetchSingle = createFetcher({ [MANIFEST_URL]: jsonRoute(NUPIO_MANIFEST) });
  let singleError: { code: string } | null = null;
  try {
    await resolveCloudStreamExtensionDownload(
      mixedClient,
      { mediaType: 'movie', contentId: 'mv-1' },
      'allanime',
      { ...resolveDeps, fetcher: nuvioFetchSingle },
    );
  } catch (error) {
    singleError = error as { code: string };
  }
  ok(singleError !== null && singleError.code === 'ADAPTER_NOT_AVAILABLE', 'D: single Nuvio extension → ADAPTER_NOT_AVAILABLE typed error');

  // D7 single-extension endpoint: a cloudstream native provider still resolves
  // (regression: existing behavior preserved end-to-end through the registry).
  const nativeFetch = createFetcher({
    // VegaMovies-style minimal fixture is not needed — the registry instance
    // resolves through the orchestrator with injected deps; use MoviesDrive's
    // real adapter with a network-free failure path (any bounded outcome is a
    // pass: the binding itself is the contract under test).
    [MANIFEST_URL]: jsonRoute(NUPIO_MANIFEST),
  });
  let nativeOutcome: 'resolved' | 'adapter-unavailable' = 'resolved';
  try {
    await resolveCloudStreamExtensionDownload(
      mixedClient,
      { mediaType: 'movie', contentId: 'mv-1' },
      'MoviesDrive',
      { ...resolveDeps, fetcher: nativeFetch },
    );
  } catch (error) {
    if ((error as { code: string }).code === 'ADAPTER_NOT_AVAILABLE') nativeOutcome = 'adapter-unavailable';
  }
  ok(nativeOutcome === 'resolved', 'D: cloudstream native extension still binds (not ADAPTER_NOT_AVAILABLE)');
}

console.log(`A+B+C+D sections: ${passed} checks`);

// ===========================================================================
// E. Security — the Nuvio path inherits the SSRF-safe pipeline + no code execution
// ===========================================================================
{
  // E1 private-IP manifest destination → BLOCKED_URL (SSRF pipeline inherited).
  const privateFetcher = createFetcher({ [MANIFEST_URL]: jsonRoute(NUPIO_MANIFEST) });
  const { client: ssrfClient } = createFakeClient();
  await rejectsCode(
    () => createRepositoryFromUrl(ssrfClient, 'https://private.example/manifest.json', { fetcher: privateFetcher, dnsResolver: privateResolver, now: () => NOW }),
    'BLOCKED_URL',
    'E: private-IP manifest destination blocked',
  );

  // E2 unsupported protocol rejected lexically.
  const { client: protoClient } = createFakeClient();
  await rejectsCode(
    () => createRepositoryFromUrl(protoClient, 'ftp://nuvio.example/manifest.json', baseDeps(createFetcher({}))),
    'INVALID_URL',
    'E: non-http(s) manifest protocol rejected',
  );

  // E3 oversized manifest → TOO_LARGE.
  const oversizedFetcher = createFetcher({
    [MANIFEST_URL]: () => new Response('x'.repeat(2 * 1024 * 1024), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const { client: largeClient } = createFakeClient();
  await rejectsCode(
    () => createRepositoryFromUrl(largeClient, MANIFEST_URL, { ...baseDeps(oversizedFetcher), maxBytes: 1024 }),
    'TOO_LARGE',
    'E: oversized manifest rejected by the size cap',
  );

  // E4 malformed JSON → INVALID_JSON (JSON-only content contract).
  const htmlFetcher = createFetcher({
    [MANIFEST_URL]: () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  const { client: htmlClient } = createFakeClient();
  await rejectsCode(
    () => createRepositoryFromUrl(htmlClient, MANIFEST_URL, baseDeps(htmlFetcher)),
    'INVALID_JSON',
    'E: non-JSON manifest body rejected',
  );

  // E5 static source pins: NO eval / new Function / dynamic import / shell /
  // Render / Oracle anywhere in the Phase 2 modules.
  const phase2Sources = [
    'src/lib/server/extensions/nuvio.ts',
    'src/lib/server/extensions/adapter-registry.ts',
    'src/lib/server/cloudstream/repository/service.ts',
    'src/lib/server/cloudstream/repository/parse.ts',
    'src/lib/server/cloudstream/extensions/service.ts',
    'src/lib/server/cloudstream/downloader/service.ts',
  ];
  for (const file of phase2Sources) {
    const source = read(file);
    ok(!/\beval\s*\(/.test(source), `E: no eval in ${file}`);
    ok(!/new\s+Function\s*\(/.test(source), `E: no new Function in ${file}`);
    ok(!/\bimport\s*\(/.test(source.replace(/await import\('\$lib\/server\/content\/service'\)/g, '')), `E: no dynamic import of remote code in ${file}`);
    ok(!/\b(render\.com|oracle\.com|onrender\.com)\b/i.test(source), `E: no Render/Oracle hostname reference in ${file}`);
    ok(!/child_process|execSync|spawn/.test(source), `E: no shell execution in ${file}`);
  }

  // E6 the migration never touches the download_providers registry and is additive.
  const migration = read('supabase/migrations/20261101000002_extension_phase2_unified_adapters.sql');
  const migrationSql = migration.replace(/--[^\n]*/g, '');
  ok(!/\bdownload_providers\b/.test(migrationSql), 'E: migration never references download_providers');
  ok(!/\b(drop\s+table|drop\s+policy|drop\s+column|truncate)\b/i.test(migrationSql), 'E: migration drops nothing');
  ok(migration.includes('add column if not exists'), 'E: migration columns are additive + idempotent');
  ok(migration.includes('alter table public.cloudstream_repositories') && migration.includes('alter table public.cloudstream_extensions'), 'E: migration extends both catalog tables');

  // E7 the shared + server type contracts pin the closed vocabulary.
  const sharedTypes = read('src/lib/shared/extension-adapter-types.ts');
  ok(sharedTypes.includes("'native'") && sharedTypes.includes("'generated'") && sharedTypes.includes("'adapter_required'"), 'E: lifecycle vocabulary pinned in shared types');
  ok(sharedTypes.includes("'runtime_required'") && sharedTypes.includes("'failed'") && sharedTypes.includes("'building'") && sharedTypes.includes("'testing'"), 'E: builder states reserved in the vocabulary');
}

console.log(`\ncloudstream_phase2_unified_adapters_test: ${passed} checks PASSED`);
