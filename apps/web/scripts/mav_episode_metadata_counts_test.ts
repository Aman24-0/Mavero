/**
 * Task 1 regression (2026-10-15) — honest linked-episode counts.
 *
 * Reported production problem: "Dark has three seasons and 28 episodes;
 * after linking ONE episode the card reads 1/1 linked." The denominator
 * was derived from the LINKED media_items rows (which only exist for
 * episodes that were linked at least once) instead of the complete
 * season/episode metadata.
 *
 * Fix under test: MediaLibraryService gains an injectable season-metadata
 * resolver (default: the cached TMDB detail path). episode_summary
 * becomes { season_count, episode_count, linked_episode_count,
 * metadata_available }:
 *   - episode_count = the COMPLETE TMDB metadata total (never invented),
 *   - metadata_available=false when the metadata is unavailable → the UI
 *     must NOT render a "linked/total" fraction (local count is a lower
 *     bound of LINKED episodes only),
 *   - linked_episode_count counts episodes with >=1 ACTIVE asset (rows
 *     persist after unlink, so the raw row count over-reports).
 *
 * Uses the REAL MediaLibraryService backed by the in-memory postgrest
 * emulation (mav_task2 pattern) + a stub metadata resolver:
 *
 *   §A  list() metadata denominators
 *         A1  1 linked of 28 → 1/28 (metadata_available)
 *         A2  3 linked of 28 → 3/28
 *         A3  multi-season distinct totals (10 + 18 = 28)
 *         A4  zero linked of 28 → 0/28
 *         A5  link → delete keeps the denominator, drops the numerator
 *         A6  movies get NO episode_summary (no fabricated counts)
 *         A7  anime parents use the same contract
 *         A8  resolver failure → metadata_available=false, local fallback
 *         A9  local rows in seasons the metadata does not know are ADDED
 *         A10 ONE resolver call per parent (no per-episode N+1)
 *   §B  episodes() parent summary uses the same contract
 *
 * No production data is touched — the "database" is an in-memory mock.
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_episode_metadata_counts_test.ts
 */

import { MediaLibraryService } from '../src/lib/server/hosting/library/service';
import type { SeriesSeasonMetadata } from '../src/lib/server/hosting/library/season-metadata';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL ${passed + failed} - ${label}`); }
}

// ---------------------------------------------------------------------------
// In-memory postgrest emulation (mav_task2 pattern, + neq() for the
// asset-status filters the count rollups use).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type ExecResult = { data: unknown; error: { message: string; code: string } | null; count: number | null };

class QueryBuilder {
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private filters: Array<(r: Row) => boolean> = [];
  private payload: Row | null = null;
  private selectCols: string | null = null;
  private expectSingle = false;
  private expectMaybe = false;
  private orders: Array<{ field: string; ascending: boolean; nullsFirst: boolean }> = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private wantCount = false;
  constructor(private rows: Row[], private name: string, private nextId: () => string) {}

  select(cols: string | null, opts?: { count?: 'exact' | 'planned' | 'estimated' }) {
    this.selectCols = cols;
    if (opts?.count === 'exact') this.wantCount = true;
    return this;
  }
  insert(payload: Row) { this.op = 'insert'; this.payload = payload; return this; }
  update(payload: Row) { this.op = 'update'; this.payload = payload; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(field: string, value: unknown) { this.filters.push((r) => r[field] === value); return this; }
  neq(field: string, value: unknown) { this.filters.push((r) => r[field] !== value); return this; }
  is(field: string, value: null) { this.filters.push((r) => r[field] === value); return this; }
  in(field: string, values: unknown[]) { this.filters.push((r) => values.includes(r[field])); return this; }
  ilike(field: string, pattern: string) {
    const rx = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i');
    this.filters.push((r) => typeof r[field] === 'string' && rx.test(r[field] as string));
    return this;
  }
  order(field: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orders.push({ field, ascending: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst ?? true });
    return this;
  }
  range(from: number, to: number) { this.rangeFrom = from; this.rangeTo = to; return this; }
  single() { this.expectSingle = true; return this; }
  maybeSingle() { this.expectMaybe = true; return this; }

  private project(r: Row): Row {
    if (!this.selectCols) return { ...r };
    const cols = this.selectCols.split(',').map((c) => c.trim());
    const out: Row = {};
    for (const c of cols) if (c in r) out[c] = r[c];
    return out;
  }

  private sortRows(rows: Row[]): Row[] {
    let sorted = [...rows];
    for (const o of [...this.orders].reverse()) {
      sorted = sorted.sort((a, b) => {
        const av = a[o.field]; const bv = b[o.field];
        const an = av == null; const bn = bv == null;
        if (an && bn) return 0;
        if (an) return o.nullsFirst ? -1 : 1;
        if (bn) return o.nullsFirst ? 1 : -1;
        const cmp = av! > bv! ? 1 : av! < bv! ? -1 : 0;
        return o.ascending ? cmp : -cmp;
      });
    }
    return sorted;
  }

  private exec(): ExecResult {
    if (this.op === 'select') {
      let found = this.rows.filter((r) => this.filters.every((f) => f(r)));
      const total = found.length;
      found = this.sortRows(found);
      if (this.rangeFrom != null && this.rangeTo != null) {
        found = found.slice(this.rangeFrom, this.rangeTo + 1);
      }
      const countOut = this.wantCount ? total : null;
      if (this.expectSingle) {
        if (found.length !== 1) return { data: null, error: { message: 'row not found', code: 'PGRST116' }, count: countOut };
        return { data: this.project(found[0]), error: null, count: countOut };
      }
      if (this.expectMaybe) {
        if (found.length === 0) return { data: null, error: null, count: countOut };
        return { data: this.project(found[0]), error: null, count: countOut };
      }
      return { data: found.map((r) => this.project(r)), error: null, count: countOut };
    }
    if (this.op === 'insert' && this.payload) {
      this.rows.push({ id: this.nextId(), ...this.payload });
      const row = this.rows[this.rows.length - 1];
      return { data: this.project(row), error: null, count: null };
    }
    if (this.op === 'update' && this.payload) {
      for (const r of this.rows) {
        if (this.filters.every((f) => f(r))) Object.assign(r, this.payload);
      }
      return { data: null, error: null, count: null };
    }
    if (this.op === 'delete') {
      for (let i = this.rows.length - 1; i >= 0; i -= 1) {
        if (this.filters.every((f) => f(this.rows[i]))) this.rows.splice(i, 1);
      }
      return { data: null, error: null, count: null };
    }
    return { data: null, error: { message: 'unsupported op', code: 'X' }, count: null };
  }

  then<T>(onFulfilled: (value: ExecResult) => T, onRejected?: (reason: unknown) => T): Promise<T> {
    return Promise.resolve(this.exec()).then(onFulfilled, onRejected);
  }
}

type Table = { name: string; rows: Row[] };

class MockSupabase {
  tables: Table[] = [
    { name: 'media_items', rows: [] },
    { name: 'media_assets', rows: [] },
    { name: 'media_folders', rows: [] },
    { name: 'media_availability_requests', rows: [] },
    { name: 'media_operations', rows: [] },
    { name: 'streaming_providers', rows: [] },
    { name: 'streaming_sources', rows: [] },
  ];
  private seq = 0;
  private nextId(): string { this.seq += 1; return `uuid-${this.seq}`; }

  from(name: string): QueryBuilder {
    const table = this.tables.find((t) => t.name === name);
    if (!table) throw new Error(`unexpected table ${name}`);
    return new QueryBuilder(table.rows, name, () => this.nextId());
  }
}

// ---------------------------------------------------------------------------
// Fixture builders — "Dark": 3 seasons, 28 total episodes (10 + 8 + 10).
// ---------------------------------------------------------------------------

const DARK_METADATA: SeriesSeasonMetadata = {
  seasonCount: 3,
  episodeCount: 28,
  seasonEpisodeCounts: new Map([[1, 10], [2, 8], [3, 10]]),
};

function resolverCallsTracker(metadata: SeriesSeasonMetadata | null) {
  const calls: Array<{ contentType: string; tmdbId: string }> = [];
  const resolver = async (contentType: string, tmdbId: string) => {
    calls.push({ contentType, tmdbId });
    return metadata;
  };
  return { resolver, calls };
}

function item(mock: MockSupabase, over: Partial<Row>): Row {
  const id = over.id as string ?? `uuid-${mock.tables[0].rows.length + 1}`;
  const row: Row = {
    id,
    canonical_key: `series:tmdb:${over.tmdb_id ?? '46648'}:s${over.season ?? 0}:e${over.episode ?? 0}`,
    content_type: 'series',
    tmdb_id: '46648',
    imdb_id: null,
    title: 'Dark',
    year: 2017,
    season: null,
    episode: null,
    episode_title: null,
    parent_media_id: null,
    poster_path: null,
    backdrop_path: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
  mock.tables[0].rows.push(row);
  return row;
}

function asset(mock: MockSupabase, mediaItemId: string, over: Partial<Row> = {}): Row {
  const row: Row = {
    id: `asset-${mock.tables[1].rows.length + 1}`,
    media_item_id: mediaItemId,
    provider_source_id: 'src-vidara-1',
    provider_asset_id: `code-${mock.tables[1].rows.length + 1}`,
    status: 'ready',
    mavero_status: 'available',
    source_quality: null,
    available_qualities: [],
    audio_languages: [],
    has_subtitles: false,
    duration_seconds: null,
    size_bytes: null,
    last_synced_at: '2026-10-01T00:00:00Z',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
  mock.tables[1].rows.push(row);
  return row;
}

/** Seeds Dark with ONE linked episode (S1E1) out of the 28 metadata total. */
function seedOneLinked(mock: MockSupabase): { parentId: string } {
  const parent = item(mock, { id: 'parent-dark', canonical_key: 'series:tmdb:46648', parent_media_id: null, season: null, episode: null });
  const ep1 = item(mock, { id: 'dark-s1e1', canonical_key: 'series:tmdb:46648:s1:e1', parent_media_id: 'parent-dark', season: 1, episode: 1, episode_title: 'Secrets' });
  asset(mock, ep1.id as string);
  return { parentId: parent.id as string };
}

// ===========================================================================
console.log('§A — list() metadata denominators');
// ===========================================================================

// A1 — one linked of 28 → 1/28.
{
  const mock = new MockSupabase();
  seedOneLinked(mock);
  const { resolver, calls } = resolverCallsTracker(DARK_METADATA);
  const service = new MediaLibraryService(mock as never, resolver);
  const result = await service.list({ includeOrphans: true });
  const parent = result.items.find((i) => i.id === 'parent-dark')!;
  ok(parent.episode_summary != null, 'A1a. parent carries episode_summary');
  ok(parent.episode_summary!.episode_count === 28, `A1b. denominator is the METADATA total (28), got ${parent.episode_summary!.episode_count}`);
  ok(parent.episode_summary!.linked_episode_count === 1, `A1c. linked count is 1 (was the "1/1" bug), got ${parent.episode_summary!.linked_episode_count}`);
  ok(parent.episode_summary!.metadata_available === true, 'A1d. metadata_available=true');
  ok(parent.episode_summary!.season_count === 3, `A1e. season count from metadata (3, not episodes), got ${parent.episode_summary!.season_count}`);
  ok(calls.length === 1, `A1f. ONE resolver call for the parent (bounded), got ${calls.length}`);
}

// A2 — three linked of 28 → 3/28.
{
  const mock = new MockSupabase();
  const parent = item(mock, { id: 'parent-dark', canonical_key: 'series:tmdb:46648' });
  for (const [s, e] of [[1, 1], [1, 2], [3, 4]] as const) {
    const ep = item(mock, { id: `dark-s${s}e${e}`, canonical_key: `series:tmdb:46648:s${s}:e${e}`, parent_media_id: 'parent-dark', season: s, episode: e });
    asset(mock, ep.id as string);
  }
  const service = new MediaLibraryService(mock as never, resolverCallsTracker(DARK_METADATA).resolver);
  const result = await service.list({ includeOrphans: true });
  const summary = result.items.find((i) => i.id === 'parent-dark')!.episode_summary!;
  ok(summary.linked_episode_count === 3, `A2a. 3 linked across seasons, got ${summary.linked_episode_count}`);
  ok(summary.episode_count === 28, `A2b. denominator stays 28, got ${summary.episode_count}`);
  ok(summary.season_count === 3, 'A2b2. seasons are NOT confused with episodes (3 seasons, 28 episodes)');
}

// A3 — multi-season distinct totals.
{
  const mock = new MockSupabase();
  item(mock, { id: 'parent-show', tmdb_id: '999', canonical_key: 'series:tmdb:999' });
  const ep = item(mock, { id: 'show-s1e1', tmdb_id: '999', canonical_key: 'series:tmdb:999:s1:e1', parent_media_id: 'parent-show', season: 1, episode: 1 });
  asset(mock, ep.id as string);
  const distinct: SeriesSeasonMetadata = {
    seasonCount: 2,
    episodeCount: 10 + 18,
    seasonEpisodeCounts: new Map([[1, 10], [2, 18]]),
  };
  const service = new MediaLibraryService(mock as never, resolverCallsTracker(distinct).resolver);
  const result = await service.list({ includeOrphans: true });
  const summary = result.items.find((i) => i.id === 'parent-show')!.episode_summary!;
  ok(summary.episode_count === 28, `A3a. distinct season totals summed (10+18=28), got ${summary.episode_count}`);
  ok(summary.season_count === 2, `A3b. distinct season count (2), got ${summary.season_count}`);
}

// A4 — zero linked of 28 → 0/28 (parent shows via includeOrphans).
{
  const mock = new MockSupabase();
  item(mock, { id: 'parent-dark', canonical_key: 'series:tmdb:46648' });
  const service = new MediaLibraryService(mock as never, resolverCallsTracker(DARK_METADATA).resolver);
  const result = await service.list({ includeOrphans: true });
  const summary = result.items.find((i) => i.id === 'parent-dark')!.episode_summary!;
  ok(summary.linked_episode_count === 0, `A4a. zero linked, got ${summary.linked_episode_count}`);
  ok(summary.episode_count === 28, `A4b. denominator still the metadata total, got ${summary.episode_count}`);
}

// A5 — link → delete keeps the denominator, drops the numerator (the
// media_items row PERSISTS after unlink — only the asset row is gone).
{
  const mock = new MockSupabase();
  seedOneLinked(mock);
  const service = new MediaLibraryService(mock as never, resolverCallsTracker(DARK_METADATA).resolver);
  let summary = (await service.list({ includeOrphans: true })).items.find((i) => i.id === 'parent-dark')!.episode_summary!;
  ok(summary.linked_episode_count === 1 && summary.episode_count === 28, 'A5a. before delete: 1/28');

  // Unlink: delete the media_assets row ONLY (the manual-link DELETE
  // contract — the media_items row is never deleted).
  mock.tables[1].rows.length = 0;
  summary = (await service.list({ includeOrphans: true })).items.find((i) => i.id === 'parent-dark')!.episode_summary!;
  ok(summary.linked_episode_count === 0, `A5b. after delete: linked drops to 0, got ${summary.linked_episode_count}`);
  ok(summary.episode_count === 28, `A5c. after delete: denominator unchanged (28), got ${summary.episode_count}`);
}

// A6 — movies get NO episode_summary (no fabricated counts).
{
  const mock = new MockSupabase();
  const movie = item(mock, { id: 'movie-1', canonical_key: 'movie:tmdb:12345', content_type: 'movie', tmdb_id: '12345', title: 'Dune' });
  asset(mock, movie.id as string);
  const { resolver, calls } = resolverCallsTracker(DARK_METADATA);
  const service = new MediaLibraryService(mock as never, resolver);
  const result = await service.list({ includeOrphans: true });
  const movieItem = result.items.find((i) => i.id === 'movie-1')!;
  ok(movieItem.episode_summary == null, 'A6a. movie carries NO episode_summary');
  ok(movieItem.assets.length === 1, 'A6b. movie keeps its own asset list');
  ok(calls.length === 0, `A6c. NO metadata resolution for movies, got ${calls.length} calls`);
}

// A7 — anime parents use the same contract.
{
  const mock = new MockSupabase();
  item(mock, { id: 'parent-anime', content_type: 'anime', canonical_key: 'series:tmdb:46648', title: 'Dark (anime)' });
  const ep = item(mock, { id: 'anime-s1e1', canonical_key: 'series:tmdb:46648:s1:e1', parent_media_id: 'parent-anime', season: 1, episode: 1 });
  asset(mock, ep.id as string);
  const { resolver, calls } = resolverCallsTracker(DARK_METADATA);
  const service = new MediaLibraryService(mock as never, resolver);
  const result = await service.list({ includeOrphans: true });
  const summary = result.items.find((i) => i.id === 'parent-anime')!.episode_summary!;
  ok(summary.episode_count === 28 && summary.linked_episode_count === 1 && summary.metadata_available === true, 'A7a. anime parent: 1/28 with metadata');
  ok(calls[0]?.contentType === 'anime', 'A7b. resolver receives the anime content type');
}

// A8 — resolver failure/absence → metadata_available=false, local fallback.
{
  const mock = new MockSupabase();
  seedOneLinked(mock);
  const service = new MediaLibraryService(mock as never, resolverCallsTracker(null).resolver);
  const result = await service.list({ includeOrphans: true });
  const summary = result.items.find((i) => i.id === 'parent-dark')!.episode_summary!;
  ok(summary.metadata_available === false, 'A8a. metadata_available=false on resolver failure');
  ok(summary.episode_count === 1, `A8b. episode_count falls back to the LOCAL row count (lower bound), got ${summary.episode_count}`);
  ok(summary.linked_episode_count === 1, 'A8c. linked count unaffected');
}

// A9 — local rows in seasons the metadata does not know are ADDED to the
// total (linked <= total must always hold).
{
  const mock = new MockSupabase();
  item(mock, { id: 'parent-dark', canonical_key: 'series:tmdb:46648' });
  const partialMetadata: SeriesSeasonMetadata = {
    seasonCount: 2,
    episodeCount: 18,
    seasonEpisodeCounts: new Map([[1, 10], [2, 8]]),
  };
  // A linked episode in season 3, which the metadata does not know.
  const ep = item(mock, { id: 'dark-s3e7', canonical_key: 'series:tmdb:46648:s3:e7', parent_media_id: 'parent-dark', season: 3, episode: 7 });
  asset(mock, ep.id as string);
  const service = new MediaLibraryService(mock as never, resolverCallsTracker(partialMetadata).resolver);
  const result = await service.list({ includeOrphans: true });
  const summary = result.items.find((i) => i.id === 'parent-dark')!.episode_summary!;
  ok(summary.episode_count === 18 + 1, `A9a. local unknown-season row added to the metadata total (19), got ${summary.episode_count}`);
  ok(summary.season_count === 3, `A9b. season union (metadata 2 + local 1 = 3), got ${summary.season_count}`);
  ok(summary.linked_episode_count <= summary.episode_count, 'A9c. linked <= total invariant holds');
}

// A10 — ONE resolver call per parent per list() (no per-episode N+1),
// also across MULTIPLE parents.
{
  const mock = new MockSupabase();
  for (const [pid, tid] of [['parent-a', '111'], ['parent-b', '222']] as const) {
    item(mock, { id: pid, tmdb_id: tid, canonical_key: `series:tmdb:${tid}` });
    const ep = item(mock, { id: `${pid}-s1e1`, tmdb_id: tid, canonical_key: `series:tmdb:${tid}:s1:e1`, parent_media_id: pid, season: 1, episode: 1 });
    asset(mock, ep.id as string);
    const ep2 = item(mock, { id: `${pid}-s1e2`, tmdb_id: tid, canonical_key: `series:tmdb:${tid}:s1:e2`, parent_media_id: pid, season: 1, episode: 2 });
    asset(mock, ep2.id as string);
  }
  const { resolver, calls } = resolverCallsTracker(DARK_METADATA);
  const service = new MediaLibraryService(mock as never, resolver);
  await service.list({ includeOrphans: true });
  ok(calls.length === 2, `A10a. ONE call per parent (2 parents, 4 episodes → 2 calls), got ${calls.length}`);
}

// ===========================================================================
console.log('§B — episodes() parent summary uses the same contract');
// ===========================================================================

// B1 — the sheet's parent summary: 1/28 + metadata.
{
  const mock = new MockSupabase();
  const { parentId } = seedOneLinked(mock);
  const { resolver, calls } = resolverCallsTracker(DARK_METADATA);
  const service = new MediaLibraryService(mock as never, resolver);
  const result = await service.episodes(parentId);
  ok(result != null, 'B1a. episodes() returns the parent + children');
  ok(result!.parent.episode_summary != null, 'B1b. parent carries the rollup');
  const summary = result!.parent.episode_summary!;
  ok(summary.episode_count === 28 && summary.linked_episode_count === 1 && summary.metadata_available === true, `B1c. episodes() summary: 1/28 with metadata, got ${summary.episode_count}/${summary.linked_episode_count}`);
  ok(summary.season_count === 3, 'B1d. season count 3');
  ok(calls.length === 1, `B1e. ONE resolver call, got ${calls.length}`);
}

// B2 — episodes() fallback when metadata unavailable.
{
  const mock = new MockSupabase();
  const { parentId } = seedOneLinked(mock);
  const service = new MediaLibraryService(mock as never, resolverCallsTracker(null).resolver);
  const result = await service.episodes(parentId);
  const summary = result!.parent.episode_summary!;
  ok(summary.metadata_available === false && summary.episode_count === 1, 'B2a. episodes() fallback: local count + metadata_available=false');
}

// B3 — the injected resolver is optional: the DEFAULT resolver exists and
// returns null for non-numeric ids without throwing (dev fixtures).
{
  const { tmdbSeasonMetadataResolver } = await import('../src/lib/server/hosting/library/season-metadata');
  const fixtureResult = await tmdbSeasonMetadataResolver('series', 'nocturne-city');
  ok(fixtureResult === null, 'B3a. default resolver: non-numeric ids → null (no invented totals)');
}

console.log(`\nmav_episode_metadata_counts_test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
