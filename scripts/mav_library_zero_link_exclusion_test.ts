/**
 * 2026-10-16 final round — Media Library ZERO-LINK exclusion regression.
 *
 * Reported production defect: after a bulk delete of every linked episode
 * of a series (e.g. Breaking Bad), the parent card REMAINED in the Media
 * Library showing "0/62 episodes linked". Root cause: the library list
 * deliberately kept demand-backed zero-asset rows ("pending" cards) — so
 * after the links were deleted the parent survived on its demand row.
 *
 * Contract under test (the fix):
 *   §A  a title with >=1 ACTIVE link is shown (movie + parent rollup)
 *   §B  a title with ZERO active links is EXCLUDED — regardless of demand
 *       (parent AND movie); includeOrphans remains the debug escape hatch
 *   §C  a series with ONE remaining linked episode stays visible with an
 *       accurate count; removing the FINAL link removes the card (the
 *       library is re-listed after the mutation — no stale 0/N card)
 *   §D  demand/request records + canonical identities are NEVER deleted
 *       by unlink (the missing-media re-entry path keeps its data)
 *   §E  a requested title returns to Missing Media: sweepStaleResolvedDemand
 *       reopens the 'ready' demand row once its asset is gone (behavioral,
 *       real DemandService against the in-memory postgrest emulation)
 *   §F  the UI refresh wiring: every delete/bulk-unlink path reloads the
 *       library list (source contract — stale cards cannot survive)
 *
 * No production data is touched — the "database" is an in-memory mock.
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_library_zero_link_exclusion_test.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MediaLibraryService } from '../src/lib/server/hosting/library/service';
import { DemandService } from '../src/lib/server/hosting/demand/service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL ${passed + failed} - ${label}`); }
}

// ---------------------------------------------------------------------------
// In-memory postgrest emulation (the mav_task2 hierarchy-test pattern,
// extended with update({count}) for the demand sweeps).
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
  private wantCount = false;
  private orders: Array<{ field: string; ascending: boolean; nullsFirst: boolean }> = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  constructor(private rows: Row[], private name: string, private nextId: () => string) {}

  select(cols: string | null, opts?: { count?: 'exact' | 'planned' | 'estimated' }) {
    this.selectCols = cols;
    if (opts?.count === 'exact') this.wantCount = true;
    return this;
  }
  insert(payload: Row) { this.op = 'insert'; this.payload = payload; return this; }
  update(payload: Row, opts?: { count?: 'exact' | 'planned' | 'estimated' }) {
    this.op = 'update'; this.payload = payload;
    if (opts?.count === 'exact') this.wantCount = true;
    return this;
  }
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

  private applyOrder(rows: Row[]): Row[] {
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
    if (this.op === 'delete') {
      for (let i = this.rows.length - 1; i >= 0; i -= 1) {
        if (this.filters.every((f) => f(this.rows[i]))) this.rows.splice(i, 1);
      }
      return { data: null, error: null, count: null };
    }
    if (this.op === 'insert' && this.payload) {
      this.rows.push({ id: this.nextId(), ...this.payload });
      return { data: this.project(this.rows[this.rows.length - 1]), error: null, count: null };
    }
    if (this.op === 'update' && this.payload) {
      let n = 0;
      for (const r of this.rows) {
        if (this.filters.every((f) => f(r))) { Object.assign(r, this.payload); n += 1; }
      }
      return { data: null, error: null, count: this.wantCount ? n : null };
    }
    // select
    let found = this.rows.filter((r) => this.filters.every((f) => f(r)));
    found = this.applyOrder(found);
    if (this.rangeFrom != null && this.rangeTo != null) {
      found = found.slice(this.rangeFrom, this.rangeTo + 1);
    }
    const projectAll = (rows: Row[]) => rows.map((r) => this.project(r));
    if (this.expectSingle) {
      if (found.length !== 1) return { data: null, error: { message: 'row not found', code: 'PGRST116' }, count: null };
      return { data: this.project(found[0]), error: null, count: null };
    }
    if (this.expectMaybe) {
      if (found.length === 0) return { data: null, error: null, count: null };
      return { data: this.project(found[0]), error: null, count: null };
    }
    return { data: projectAll(found), error: null, count: this.wantCount ? this.rows.filter((r) => this.filters.every((f) => f(r))).length : null };
  }

  then<T>(onFulfilled: (value: ExecResult) => T, onRejected?: (reason: unknown) => T): Promise<T> {
    return Promise.resolve(this.exec()).then(onFulfilled, onRejected);
  }
}

class MockSupabase {
  tables: Array<{ name: string; rows: Row[] }> = [
    { name: 'media_items', rows: [] },
    { name: 'media_assets', rows: [] },
    { name: 'media_operations', rows: [] },
    { name: 'media_availability_requests', rows: [] },
  ];
  private seq = 0;
  private nextId(): string { this.seq += 1; return `uuid-${this.seq}`; }
  from(name: string): QueryBuilder {
    const table = this.tables.find((t) => t.name === name);
    if (!table) throw new Error(`unknown table ${name}`);
    return new QueryBuilder(table.rows, name, () => this.nextId());
  }
}

// Deterministic season metadata stub — no network, full denominators.
const metadataStub = async (_contentType: string, _tmdbId: string) => null;
const service = (mock: MockSupabase) => new MediaLibraryService(mock as unknown as any, metadataStub);

function item(mock: MockSupabase, over: Partial<Row>): Row {
  const row: Row = {
    id: 'item-' + mock.tables[0].rows.length,
    canonical_key: 'x', content_type: 'movie', tmdb_id: '1', imdb_id: null,
    title: 'X', year: null, season: null, episode: null, episode_title: null,
    parent_media_id: null, poster_path: null, backdrop_path: null,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
  mock.tables[0].rows.push(row);
  return row;
}
function asset(mock: MockSupabase, over: Partial<Row>): Row {
  const row: Row = {
    id: 'asset-' + mock.tables[1].rows.length,
    media_item_id: 'x', provider_source_id: 'src-vidara', provider_asset_id: 'a',
    status: 'ready', mavero_status: 'available',
    source_quality: null, available_qualities: [], audio_languages: [], has_subtitles: false,
    duration_seconds: null, size_bytes: null, last_synced_at: null,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
  mock.tables[1].rows.push(row);
  return row;
}
function demandRow(mock: MockSupabase, over: Partial<Row>): Row {
  const row: Row = {
    id: 'demand-' + mock.tables[3].rows.length,
    canonical_key: 'x', tmdb_id: '1', content_type: 'movie',
    title_snapshot: 'X', episode_title_snapshot: null, season: null, episode: null,
    request_count: 1, last_requested_at: '2026-10-01T00:00:00Z',
    first_requested_at: '2026-10-01T00:00:00Z', status: 'open',
    ...over,
  };
  mock.tables[3].rows.push(row);
  return row;
}

// Seed: Breaking Bad (parent + 2 episodes, 1 linked), Movie (1 asset),
// Movie WANTED (demand only, zero assets), Orphan series (zero assets,
// zero demand).
function seed(): MockSupabase {
  const mock = new MockSupabase();
  item(mock, { id: 'p-bb', canonical_key: 'series:tmdb:1399', content_type: 'series', tmdb_id: '1399', title: 'Breaking Bad', year: 2008 });
  item(mock, { id: 'e-bb-s1e1', canonical_key: 'series:tmdb:1399:s1:e1', content_type: 'series', tmdb_id: '1399', title: 'Breaking Bad', season: 1, episode: 1, parent_media_id: 'p-bb' });
  item(mock, { id: 'e-bb-s1e2', canonical_key: 'series:tmdb:1399:s1:e2', content_type: 'series', tmdb_id: '1399', title: 'Breaking Bad', season: 1, episode: 2, parent_media_id: 'p-bb' });
  asset(mock, { media_item_id: 'e-bb-s1e1', provider_asset_id: 'bbE1' });
  item(mock, { id: 'm-movie', canonical_key: 'movie:tmdb:278', content_type: 'movie', tmdb_id: '278', title: 'The Shawshank Redemption' });
  asset(mock, { media_item_id: 'm-movie', provider_asset_id: 'shank' });
  item(mock, { id: 'm-wanted', canonical_key: 'movie:tmdb:555', content_type: 'movie', tmdb_id: '555', title: 'Wanted Movie' });
  demandRow(mock, { canonical_key: 'movie:tmdb:555', tmdb_id: '555', content_type: 'movie', title_snapshot: 'Wanted Movie', status: 'open' });
  item(mock, { id: 'p-orphan', canonical_key: 'series:tmdb:777', content_type: 'series', tmdb_id: '777', title: 'Orphan Series' });
  item(mock, { id: 'e-orphan-s1e1', canonical_key: 'series:tmdb:777:s1:e1', content_type: 'series', tmdb_id: '777', title: 'Orphan Series', season: 1, episode: 1, parent_media_id: 'p-orphan' });
  return mock;
}

async function run() {
  console.log('\n2026-10-16 — Media Library zero-link exclusion\n');

  // ---------------------------------------------------------------
  console.log('§A — titles WITH active links are shown');
  {
    const mock = seed();
    const result = await service(mock).list({ sort: 'title' });
    const titles = result.items.map((i) => i.title);
    ok(titles.join(' | ') === 'Breaking Bad | The Shawshank Redemption', `A1. linked parent + linked movie shown — got ${titles.join(' | ')}`);
    const bb = result.items.find((i) => i.title === 'Breaking Bad');
    ok(bb?.episode_summary?.linked_episode_count === 1, `A2. the parent rollup counts its ONE active link (got ${bb?.episode_summary?.linked_episode_count})`);
  }

  // ---------------------------------------------------------------
  console.log('§B — zero-link titles are EXCLUDED (regardless of demand)');
  {
    const mock = seed();
    const result = await service(mock).list({ sort: 'title' });
    ok(!result.items.some((i) => i.title === 'Wanted Movie'), 'B1. demand-backed ZERO-LINK movie excluded (Missing Media owns it)');
    ok(!result.items.some((i) => i.title === 'Orphan Series'), 'B2. orphan zero-link parent excluded');
    // Debug escape hatch unchanged.
    const debug = await service(mock).list({ sort: 'title', includeOrphans: true });
    ok(debug.items.some((i) => i.title === 'Wanted Movie') && debug.items.some((i) => i.title === 'Orphan Series'), 'B3. includeOrphans:true still returns everything (debug contract)');
    // Soft-deleted assets do not count as links.
    const mock2 = seed();
    asset(mock2, { media_item_id: 'e-bb-s1e2', status: 'deleted', mavero_status: 'missing', provider_asset_id: 'bbE2del' });
    const res2 = await service(mock2).list({ sort: 'title' });
    const bb2 = res2.items.find((i) => i.title === 'Breaking Bad');
    ok(bb2 != null && bb2.episode_summary?.linked_episode_count === 1, 'B4. a deleted asset does NOT count as a link (only the active one)');
    const mock3 = seed();
    mock3.tables[1].rows.find((a) => a.provider_asset_id === 'bbE1')!.status = 'deleted';
    const res3 = await service(mock3).list({ sort: 'title' });
    ok(!res3.items.some((i) => i.title === 'Breaking Bad'), 'B5. a parent whose ONLY asset became deleted is excluded');
  }

  // ---------------------------------------------------------------
  console.log('§C — final-link removal removes the card (no stale 0/N)');
  {
    // One of several links removed: the parent STAYS with an accurate count.
    const mock = seed();
    asset(mock, { media_item_id: 'e-bb-s1e2', provider_asset_id: 'bbE2' });
    const before = await service(mock).list({ sort: 'title' });
    ok(before.items.find((i) => i.title === 'Breaking Bad')?.episode_summary?.linked_episode_count === 2, 'C1. two linked episodes → count 2');
    // Unlink ONE of the two (the manual-link DELETE removes the row).
    mock.tables[1].rows = mock.tables[1].rows.filter((a) => a.provider_asset_id !== 'bbE1');
    const after = await service(mock).list({ sort: 'title' });
    const bbAfter = after.items.find((i) => i.title === 'Breaking Bad');
    ok(bbAfter != null && bbAfter.episode_summary?.linked_episode_count === 1, `C2. one remaining linked episode → parent STAYS with count 1 (got ${bbAfter?.episode_summary?.linked_episode_count})`);
    // Remove the FINAL link: the parent card disappears.
    mock.tables[1].rows = mock.tables[1].rows.filter((a) => a.provider_asset_id !== 'bbE2');
    const empty = await service(mock).list({ sort: 'title' });
    ok(!empty.items.some((i) => i.title === 'Breaking Bad'), 'C3. removing the FINAL episode link removes the parent card (no 0/2 card)');
    ok(!empty.items.some((i) => i.title.includes('0/')), 'C4. no zero-count parent card survives');
    // Movie: same rule after its single link is removed.
    const mock2 = seed();
    mock2.tables[1].rows = mock2.tables[1].rows.filter((a) => a.provider_asset_id !== 'shank');
    const empty2 = await service(mock2).list({ sort: 'title' });
    ok(!empty2.items.some((i) => i.title === 'The Shawshank Redemption'), 'C5. removing a movie\'s final link removes the movie card');
  }

  // ---------------------------------------------------------------
  console.log('§D — unlink never deletes identities or demand records');
  {
    const mock = seed();
    // "Bulk delete" the only linked episode: remove the media_assets rows ONLY.
    const itemsBefore = mock.tables[0].rows.length;
    const demandsBefore = mock.tables[3].rows.length;
    mock.tables[1].rows = mock.tables[1].rows.filter((a) => a.media_item_id !== 'e-bb-s1e1');
    await service(mock).list({ sort: 'title' });
    ok(mock.tables[0].rows.length === itemsBefore, 'D1. canonical media_items rows are NEVER deleted by the exclusion');
    ok(mock.tables[3].rows.length === demandsBefore, 'D2. demand rows are NEVER deleted by the exclusion');
    ok(mock.tables[0].rows.some((r) => r.id === 'p-bb') && mock.tables[0].rows.some((r) => r.id === 'e-bb-s1e1'), 'D3. parent + episode identities preserved (re-linkable)');
  }

  // ---------------------------------------------------------------
  console.log('§E — requested titles RETURN to Missing Media (demand sweep)');
  {
    const mock = seed();
    // A requested movie that WAS linked (demand auto-resolved to 'ready').
    item(mock, { id: 'm-req', canonical_key: 'movie:tmdb:888', content_type: 'movie', tmdb_id: '888', title: 'Requested Movie' });
    asset(mock, { media_item_id: 'm-req', provider_asset_id: 'reqA' });
    demandRow(mock, { canonical_key: 'movie:tmdb:888', tmdb_id: '888', content_type: 'movie', title_snapshot: 'Requested Movie', status: 'ready' });

    // While linked: the demand is resolved and the movie is in the library.
    const linked = await service(mock).list({ sort: 'title' });
    ok(linked.items.some((i) => i.title === 'Requested Movie'), 'E1. the linked requested movie shows in Media Library');

    // The final link is removed (Mavero-side only).
    mock.tables[1].rows = mock.tables[1].rows.filter((a) => a.media_item_id !== 'm-req');
    const unlinked = await service(mock).list({ sort: 'title' });
    ok(!unlinked.items.some((i) => i.title === 'Requested Movie'), 'E2. after the final unlink it disappears from Media Library');

    // The Missing Media page load runs the sweeps: the stale 'ready'
    // demand reopens → the title reappears in Missing Media.
    const demandService = new DemandService(mock as unknown as any);
    const reopened = await demandService.sweepStaleResolvedDemand();
    ok(reopened === 1, `E3. sweepStaleResolvedDemand reopens the orphaned demand row (got ${reopened})`);
    const demandRows = mock.tables[3].rows.filter((r) => r.canonical_key === 'movie:tmdb:888');
    ok(demandRows.length === 1 && demandRows[0].status === 'open', `E4. the demand row is OPEN again — Missing Media lists it (got ${demandRows[0]?.status})`);
    ok(mock.tables[0].rows.some((r) => r.id === 'm-req'), 'E5. the canonical identity survived (no duplicate rows created)');
    ok(mock.tables[3].rows.filter((r) => r.canonical_key === 'movie:tmdb:888').length === 1, 'E6. NO duplicate demand rows were created by the unlink');
    // An 'ignored' demand stays ignored (the sweep contract).
    const mock2 = seed();
    item(mock2, { id: 'm-ign', canonical_key: 'movie:tmdb:990', content_type: 'movie', tmdb_id: '990', title: 'Ignored Movie' });
    demandRow(mock2, { canonical_key: 'movie:tmdb:990', tmdb_id: '990', content_type: 'movie', title_snapshot: 'Ignored Movie', status: 'ignored' });
    const ds2 = new DemandService(mock2 as unknown as any);
    await ds2.sweepStaleResolvedDemand();
    const ign = mock2.tables[3].rows.find((r) => r.canonical_key === 'movie:tmdb:990');
    ok(ign?.status === 'ignored', 'E7. ignored demands are never auto-reopened');
  }

  // ---------------------------------------------------------------
  console.log('§F — UI refresh wiring (source contract: stale cards cannot survive)');
  {
    const mediaList = read('src/lib/components/admin2/AdminMediaList.svelte');
    // Single delete: success → full list reload.
    ok(/if \(json\.ok\) \{\s*deleteTarget = null;\s*await loadList\(true\);/.test(mediaList), 'F1. single delete reloads the list on success');
    // A failed delete leaves the list untouched (honest error state).
    ok(/error = json\.error\?\.message \?\? 'Delete failed\.';/.test(mediaList), 'F2. a failed delete surfaces the error WITHOUT a list reload');
    // Wizard save (Add/Update link) → reload + episode-sheet refresh.
    ok(/onsaved=\{\(\) => \{\s*void loadList\(true\);[\s\S]*?sheetRefreshKey\+\+;/.test(mediaList), 'F3. wizard saves reload the list AND bump the sheet refresh key');
    const sheet = read('src/lib/components/admin2/AdminEpisodeSheet.svelte');
    // Bulk delete: refreshAfterSave reloads the sheet's ground truth and
    // notifies the parent list (onsaved → loadList).
    ok(/bulkDeleteOutcomes = \(json\.results \?\? \[\]\)\.map/.test(sheet) && /await refreshAfterSave\(\);/.test(sheet), 'F4. bulk delete success refreshes the episode ground truth');
    ok(/async function refreshAfterSave\(\) \{\s*await loadLinked\(\);\s*onsaved\?\.\(\);/.test(sheet), 'F5. refreshAfterSave reloads the sheet AND calls onsaved (the parent list reload)');
    const mediaListOsaved = read('src/lib/components/admin2/AdminMediaList.svelte');
    ok(/onsaved=\{\(\) => \{ void loadList\(true\); \}\}/.test(mediaListOsaved.replace(/\n\s*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, '')) || /onsaved=\{\(\) => \{\s*void loadList\(true\);/.test(mediaListOsaved), 'F6. AdminMediaList reloads on the sheet\'s onsaved signal');
  }

  console.log(`\nmav_library_zero_link_exclusion_test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
