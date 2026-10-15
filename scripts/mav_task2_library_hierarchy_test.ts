/**
 * Task 2 regression (2026-10-15) — Media Library parent/episode hierarchy.
 *
 * Reported production problem: MediaLibraryService.list() returned EVERY
 * media_items row flat, so a series with N linked episodes rendered N
 * admin cards ("Show — Episode 1", "Show — Episode 2", …). The parent
 * row itself (which owns no assets) was FILTERED OUT client-side
 * (mediaAssetId === ''), so the library never showed a series card at
 * all — only per-episode fragments.
 *
 * Fix under test: list() returns TOP-LEVEL rows only
 * (parent_media_id IS NULL) with an episode_summary rollup on parents;
 * a new episodes(parentId) read serves the episode sheet.
 *
 * This test pins the fixed behavior using the REAL MediaLibraryService
 * backed by an in-memory Supabase postgrest emulation (the same pattern
 * as mav_task1_anime_parent_ensure_test.ts, extended with .in()/.order()/
 * .range()/count for the library query shapes):
 *
 *   §A  list() hierarchy
 *         A1  one parent card, ZERO per-episode cards
 *         A2  episode_summary rollup (seasons / episodes / linked)
 *         A3  linked_episode_count ignores deleted assets
 *         A4  parent hosting_state rolls up from episodes (hosted)
 *         A5  movies unchanged (own assets, flat cards)
 *         A6  orphan parents dropped (no linked episodes + no demand)
 *         A7  parent with demand shows as pending
 *         A8  provider filter matches parents via EPISODE assets
 *   §B  episodes(parentId)
 *         B1  parent + children ordered by season then episode
 *         B2  each child carries its OWN assets
 *         B3  the returned parent carries the rollup
 *         B4  a movie id returns an empty episode list
 *         B5  an unknown id returns null
 *   §C  pagination + sort preserved on the top-level page
 *         C1  page 2 slices correctly (episodes never consume a slot)
 *         C2  title sort orders the parent cards
 *
 * No production data is touched — the "database" is an in-memory mock.
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_task2_library_hierarchy_test.ts
 */

import { MediaLibraryService } from '../src/lib/server/hosting/library/service';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL ${failed} - ${label}`); }
}

// ---------------------------------------------------------------------------
// Minimal postgrest-js emulation for the query shapes MediaLibraryService
// uses: select + eq / is / in / ilike / order / range / maybeSingle /
// single, upsert/update for the write paths, count:'exact' support.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type ExecResult = { data: unknown; error: { message: string; code: string } | null; count: number | null };

class QueryBuilder {
  private op: 'select' | 'upsert' | 'update' | 'delete' = 'select';
  private filters: Array<(r: Row) => boolean> = [];
  private payload: Row | null = null;
  private onConflictKey: string | null = null;
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
  upsert(payload: Row, opts?: { onConflict?: string }) {
    this.op = 'upsert'; this.payload = payload; this.onConflictKey = opts?.onConflict ?? null; return this;
  }
  update(payload: Row) { this.op = 'update'; this.payload = payload; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(field: string, value: unknown) { this.filters.push((r) => r[field] === value); return this; }
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
    if (this.op === 'upsert' && this.payload) {
      const conflictField = (this.onConflictKey ?? 'id').split(',')[0].trim();
      const idx = this.rows.findIndex((r) => r[conflictField] === this.payload![conflictField]);
      if (idx >= 0) {
        this.rows[idx] = { ...this.rows[idx], ...this.payload };
      } else {
        this.rows.push({ id: this.nextId(), ...this.payload });
      }
      const row = this.rows.find((r) => r[conflictField] === this.payload![conflictField])!;
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
// Fixture builders
// ---------------------------------------------------------------------------

function item(mock: MockSupabase, over: Partial<Row>): Row {
  const id = over.id as string ?? `uuid-${mock.tables[0].rows.length + 1}`;
  const row: Row = {
    id,
    canonical_key: `series:tmdb:${over.tmdb_id}:s${over.season ?? 0}:e${over.episode ?? 0}`,
    content_type: 'series',
    tmdb_id: '1399',
    imdb_id: null,
    title: 'Untitled',
    year: null,
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

function asset(mock: MockSupabase, over: Partial<Row>): Row {
  const row: Row = {
    id: `asset-${mock.tables[1].rows.length + 1}`,
    media_item_id: '',
    provider_source_id: 'src-vidara',
    provider_asset_id: `code${mock.tables[1].rows.length + 1}`,
    status: 'ready',
    mavero_status: 'available',
    source_quality: null,
    available_qualities: [],
    audio_languages: [],
    has_subtitles: false,
    duration_seconds: null,
    size_bytes: null,
    last_synced_at: null,
    created_at: '2026-10-02T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    ...over,
  };
  mock.tables[1].rows.push(row);
  return row;
}

function demand(mock: MockSupabase, over: Partial<Row>): Row {
  const row: Row = {
    canonical_key: '',
    request_count: 3,
    last_requested_at: '2026-10-03T00:00:00Z',
    status: 'open',
    ...over,
  };
  mock.tables[3].rows.push(row);
  return row;
}

// A rich catalog:
//   Breaking Bad (series parent)      S1E1-E2 + S2E1-E2  (4 episodes;
//                                     S1E1 + S2E1 linked, S1E2 deleted
//                                     asset, S2E2 unlinked)
//   The Wire (series parent)          1 episode, linked
//   Cinderella (movie)                1 row, own asset
//   Ghost Orphan (series parent)      1 episode, NO assets, NO demand  → orphan
//   Wanted Show (series parent)       1 episode, NO assets, demand     → pending
async function seedCatalog(mock: MockSupabase): Promise<void> {
  // Breaking Bad family
  const bb = item(mock, { id: 'p-bb', canonical_key: 'series:tmdb:1399', content_type: 'series', tmdb_id: '1399', title: 'Breaking Bad', year: 2008, poster_path: '/bb.jpg' });
  const bbS1E1 = item(mock, { id: 'e-bb-s1e1', canonical_key: 'series:tmdb:1399:s1:e1', season: 1, episode: 1, episode_title: 'Pilot', parent_media_id: 'p-bb', title: 'Breaking Bad' });
  const bbS1E2 = item(mock, { id: 'e-bb-s1e2', canonical_key: 'series:tmdb:1399:s1:e2', season: 1, episode: 2, episode_title: "Cat's in the Bag...", parent_media_id: 'p-bb', title: 'Breaking Bad' });
  const bbS2E1 = item(mock, { id: 'e-bb-s2e1', canonical_key: 'series:tmdb:1399:s2:e1', season: 2, episode: 1, episode_title: 'Seven Thirty-Seven', parent_media_id: 'p-bb', title: 'Breaking Bad' });
  const bbS2E2 = item(mock, { id: 'e-bb-s2e2', canonical_key: 'series:tmdb:1399:s2:e2', season: 2, episode: 2, episode_title: 'Grilled', parent_media_id: 'p-bb', title: 'Breaking Bad' });
  asset(mock, { media_item_id: 'e-bb-s1e1', provider_source_id: 'src-vidara', provider_asset_id: 'bbE1' });
  asset(mock, { media_item_id: 'e-bb-s1e2', status: 'deleted', mavero_status: 'missing', provider_asset_id: 'bbE2del' });
  asset(mock, { media_item_id: 'e-bb-s2e1', provider_source_id: 'src-abyss', provider_asset_id: 'bbS2E1' });

  // The Wire family
  const wire = item(mock, { id: 'p-wire', canonical_key: 'series:tmdb:1438', content_type: 'series', tmdb_id: '1438', title: 'The Wire', year: 2002 });
  item(mock, { id: 'e-wire-s1e1', canonical_key: 'series:tmdb:1438:s1:e1', season: 1, episode: 1, episode_title: 'The Target', parent_media_id: 'p-wire', title: 'The Wire' });
  asset(mock, { media_item_id: 'e-wire-s1e1', provider_source_id: 'src-vidara', provider_asset_id: 'wireE1' });

  // Cinderella movie
  const cin = item(mock, { id: 'm-cin', canonical_key: 'movie:tmdb:1124', content_type: 'movie', tmdb_id: '1124', title: 'Cinderella', year: 2015 });
  asset(mock, { media_item_id: 'm-cin', provider_asset_id: 'cinA' });

  // Ghost orphan parent (dropped from the default list)
  const ghost = item(mock, { id: 'p-ghost', canonical_key: 'series:tmdb:9999', content_type: 'series', tmdb_id: '9999', title: 'Ghost Orphan', year: 2020 });
  item(mock, { id: 'e-ghost-s1e1', canonical_key: 'series:tmdb:9999:s1:e1', season: 1, episode: 1, episode_title: 'Boo', parent_media_id: 'p-ghost', title: 'Ghost Orphan' });

  // Wanted show (demand, pending)
  const wanted = item(mock, { id: 'p-wanted', canonical_key: 'series:tmdb:8888', content_type: 'series', tmdb_id: '8888', title: 'Wanted Show', year: 2021 });
  item(mock, { id: 'e-wanted-s1e1', canonical_key: 'series:tmdb:8888:s1:e1', season: 1, episode: 1, episode_title: 'Pilot', parent_media_id: 'p-wanted', title: 'Wanted Show' });
  demand(mock, { canonical_key: 'series:tmdb:8888' });

  // Reference the ids so TS doesn't complain about unused locals.
  void bb; void bbS1E1; void bbS1E2; void bbS2E1; void bbS2E2; void wire; void cin; void ghost; void wanted;
}

async function run() {
  console.log('\nTask 2 — Media Library parent/episode hierarchy\n');

  // -----------------------------------------------------------------
  console.log('§A — list() returns ONE parent card per series/anime (episodes roll up)');
  {
    const mock = new MockSupabase();
    await seedCatalog(mock);
    const service = new MediaLibraryService(mock as unknown as any);

    const result = await service.list({ sort: 'title' });

    ok(result.items.length === 4, `A1. one card per top-level row (parents + movies) — got ${result.items.length} (Breaking Bad, Cinderella, The Wire, Wanted Show)`);
    const titles = result.items.map((i) => `${i.title}${i.episode_summary != null ? ' [parent]' : ' [movie]'}`);
    ok(titles.join(' | ') === 'Breaking Bad [parent] | Cinderella [movie] | The Wire [parent] | Wanted Show [parent]', `A1b. NO per-episode cards, no orphan parent — ${titles.join(' | ')}`);
    const bb = result.items.find((i) => i.title === 'Breaking Bad');
    ok(bb != null && bb.episode_summary != null, 'A2. the parent carries an episode_summary rollup');
    if (bb?.episode_summary) {
      ok(bb.episode_summary.season_count === 2, `A2a. season_count = 2 (got ${bb.episode_summary.season_count})`);
      ok(bb.episode_summary.episode_count === 4, `A2b. episode_count = 4 (got ${bb.episode_summary.episode_count})`);
      ok(bb.episode_summary.linked_episode_count === 2, `A3. linked_episode_count = 2 — the DELETED asset episode does NOT count (got ${bb.episode_summary.linked_episode_count})`);
    }
    ok(bb?.hosting_state === 'hosted', `A4. parent hosting_state rolls up from episodes → 'hosted' (got ${bb?.hosting_state})`);
    const cin = result.items.find((i) => i.title === 'Cinderella');
    ok(cin != null && cin.episode_summary == null && cin.assets.length === 1, 'A5. movies unchanged — flat row with its own asset, no rollup');
    const wanted = result.items.find((i) => i.title === 'Wanted Show');
    ok(wanted != null && wanted.hosting_state === 'pending', `A7. parent with demand but no links → 'pending' (got ${wanted?.hosting_state})`);
    ok(result.total === 5, `A1c. total counts top-level rows including the orphan (got ${result.total})`);
  }

  console.log('\n§A2 — provider/status filters see THROUGH the parent to its episodes');
  {
    const mock = new MockSupabase();
    await seedCatalog(mock);
    const service = new MediaLibraryService(mock as unknown as any);

    const byAbyss = await service.list({ provider_source_id: 'src-abyss', sort: 'title' });
    // Only Breaking Bad has an abyss asset (on episode S2E1).
    ok(byAbyss.items.length === 1 && byAbyss.items[0].title === 'Breaking Bad',
      `A8. provider filter matches the parent via its EPISODE assets (got ${byAbyss.items.map((i) => i.title).join(', ')})`);

    const byStatus = await service.list({ status: 'missing', sort: 'title' });
    ok(byStatus.items.length === 1 && byStatus.items[0].title === 'Breaking Bad',
      `A8b. mavero_status=missing filter surfaces the parent whose episode carries a missing/deleted asset (same inclusion as the old flat episode cards) — got ${byStatus.items.map((i) => i.title).join(', ')}`);
    const byProcessing = await service.list({ status: 'processing', sort: 'title' });
    ok(byProcessing.items.length === 0, `A8c. a status matching no episode asset matches no parent (got ${byProcessing.items.length})`);
  }

  console.log('\n§B — episodes(parentId) serves the episode sheet');
  {
    const mock = new MockSupabase();
    await seedCatalog(mock);
    const service = new MediaLibraryService(mock as unknown as any);

    const result = await service.episodes('p-bb');
    ok(result != null, 'B1. episodes() resolves the parent');
    if (result) {
      ok(result.parent.title === 'Breaking Bad' && result.parent.episode_summary != null, 'B3. the returned parent carries the rollup');
      ok(result.parent.episode_summary?.episode_count === 4 && result.parent.episode_summary?.linked_episode_count === 2, 'B3b. rollup counts match the list() view');
      ok(result.episodes.length === 4, `B1b. all four episode children returned (got ${result.episodes.length})`);
      const order = result.episodes.map((e) => `S${e.season}E${e.episode}`).join(' ');
      ok(order === 'S1E1 S1E2 S2E1 S2E2', `B1c. ordered by season then episode (got ${order})`);
      const s2e1 = result.episodes.find((e) => e.season === 2 && e.episode === 1);
      ok(s2e1 != null && s2e1.assets.length === 1 && s2e1.assets[0].provider_asset_id === 'bbS2E1', 'B2. each child carries its OWN assets (per-episode provider reference)');
      const s1e2 = result.episodes.find((e) => e.season === 1 && e.episode === 2);
      ok(s1e2 != null && s1e2.assets.every((a) => a.status === 'deleted'), 'B2b. the deleted-asset episode reports its (deleted) assets honestly');
    }

    const movie = await service.episodes('m-cin');
    ok(movie != null && movie.episodes.length === 0, 'B4. a movie id returns an empty episode list');

    const missing = await service.episodes('nope-unknown-id');
    ok(missing === null, 'B5. an unknown id returns null (404 at the API layer)');
  }

  console.log('\n§C — pagination + sort operate on the TOP-LEVEL page');
  {
    const mock = new MockSupabase();
    await seedCatalog(mock);
    const service = new MediaLibraryService(mock as unknown as any);

    const page1 = await service.list({ sort: 'title', page: 1, limit: 2 });
    const page2 = await service.list({ sort: 'title', page: 2, limit: 2 });
    const page3 = await service.list({ sort: 'title', page: 3, limit: 2 });
    // Page 2 = [Ghost Orphan, The Wire] — the orphan is filtered
    // JS-side (the pre-existing FINDING-003 contract), so ONE card shows.
    ok(page1.items.length === 2 && page2.items.length === 1 && page3.items.length === 1,
      'C1. pages slice the top-level page; the JS-side orphan filter removes a card from page 2 (episodes never consume a card slot)');
    ok(page1.items.every((i) => i.parent_media_id === null) && page2.items.every((i) => i.parent_media_id === null) && page3.items.every((i) => i.parent_media_id === null), 'C1b. every carded row is a top-level row');
    // The SQL total counts 5 top-level rows (including the orphan — the
    // pre-existing behavior), so has_more stays true through page 2 and
    // turns false only past the last top-level row.
    ok(page1.has_more === true && page2.has_more === true && page3.has_more === false, 'C1c. has_more follows the SQL top-level count (orphan-filtered pages keep scrolling — the FINDING-003 contract)');
    const all = [...page1.items, ...page2.items, ...page3.items];
    const sorted = all.every((i, idx) => idx === 0 || all[idx - 1].title <= i.title);
    ok(sorted, 'C2. title sort orders the parent/movie cards');

    const bb1 = page1.items.find((i) => i.title === 'Breaking Bad');
    const bb2 = page2.items.find((i) => i.title === 'Breaking Bad');
    ok((bb1 != null) !== (bb2 != null), 'C2b. a parent appears exactly once across pages');
  }

  console.log(`\nmav_task2_library_hierarchy_test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('unexpected failure:', err);
  process.exit(1);
});
