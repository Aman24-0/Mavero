/**
 * Task 1 regression (2026-10-15) — anime-series Add File save with a
 * parent that does not yet exist.
 *
 * Reported production failure: the Add File sheet searches Black Clover
 * (TMDB 73223), loads Season 2 + episodes, accepts a Vidara reference,
 * and Save fails with:
 *
 *   "Parent anime not found for TMDB ID 73223. Call ensureAnime first."
 *
 * Root cause: /api/admin/media/manual-link was the ONLY caller of
 * CanonicalMediaService that skipped the parent-ensure-first step every
 * other caller performs (missing/link, upload/service). This test pins
 * the fixed behavior using the REAL CanonicalMediaService (backed by an
 * in-memory Supabase postgrest emulation) and the REAL orchestrator
 * (resolveMediaItemId) the endpoint now uses:
 *
 *   §A  Exact reported scenario — anime-series save, no parent exists:
 *         1. save succeeds (no PARENT_NOT_FOUND)
 *         2. exactly ONE canonical parent for the anime TMDB ID
 *         3. the episode has the correct parent + season/episode identity
 *   §B  Idempotency — repeated save converges (same ids, no duplicates)
 *   §C  Update-link — updating the provider reference reuses the SAME
 *       parent/episode identity (no duplicate hierarchy)
 *   §D  Regular TV-series save regression (parent-first, same contract)
 *   §E  Movie save regression (unchanged)
 *   §F  Service-level validation still fails safely (invalid season /
 *       episode / tmdb id → typed MediaServiceError, HTTP-mappable)
 *   §G  Orchestration order — ensureAnime runs BEFORE ensureAnimeEpisode,
 *       ensureSeries BEFORE ensureEpisode (recording spy)
 *
 * No production data is touched — the "database" is an in-memory mock.
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_task1_anime_parent_ensure_test.ts
 */

import { CanonicalMediaService } from '../src/lib/server/hosting/media/service';
import { MediaServiceError } from '../src/lib/server/hosting/media/errors';
import { resolveMediaItemId } from '../src/lib/server/hosting/media/manual-link-identity';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// ---------------------------------------------------------------------------
// Minimal postgrest-js emulation for the EXACT query shapes
// CanonicalMediaService uses (upsert/select/update + eq/is/maybeSingle/single).
// Each from() returns a FRESH builder; every chain resolves against the
// table's shared rows on await/single/maybeSingle.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type ExecResult = { data: unknown; error: { message: string; code: string } | null };

class QueryBuilder {
  private op: 'select' | 'upsert' | 'update' = 'select';
  private filters: Array<(r: Row) => boolean> = [];
  private payload: Row | null = null;
  private onConflictKey: string | null = null;
  private selectCols: string | null = null;
  private expectSingle = false;
  private expectMaybe = false;
  constructor(private rows: Row[], private name: string, private nextId: () => string) {}

  // NOTE: in postgrest-js `.upsert(...).select(...)` still performs the
  // upsert (select only sets the projection) — op must NOT be overwritten.
  select(cols: string | null = null) { this.selectCols = cols; return this; }
  upsert(payload: Row, opts?: { onConflict?: string }) {
    this.op = 'upsert'; this.payload = payload; this.onConflictKey = opts?.onConflict ?? null; return this;
  }
  update(payload: Row) { this.op = 'update'; this.payload = payload; return this; }
  eq(field: string, value: unknown) { this.filters.push((r) => r[field] === value); return this; }
  is(field: string, value: null) { this.filters.push((r) => r[field] === value); return this; }
  single() { this.expectSingle = true; return this; }
  maybeSingle() { this.expectMaybe = true; return this; }

  private project(r: Row): Row {
    if (!this.selectCols) return { ...r };
    const cols = this.selectCols.split(',').map((c) => c.trim());
    const out: Row = {};
    for (const c of cols) if (c in r) out[c] = r[c];
    return out;
  }

  private exec(): ExecResult {
    if (this.op === 'select') {
      const found = this.rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.expectSingle) {
        if (found.length !== 1) return { data: null, error: { message: 'row not found', code: 'PGRST116' } };
        return { data: this.project(found[0]), error: null };
      }
      if (this.expectMaybe) {
        if (found.length === 0) return { data: null, error: null };
        return { data: this.project(found[0]), error: null };
      }
      return { data: found.map((r) => this.project(r)), error: null };
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
      return { data: this.project(row), error: null };
    }
    if (this.op === 'update' && this.payload) {
      for (const r of this.rows) {
        if (this.filters.every((f) => f(r))) Object.assign(r, this.payload);
      }
      return { data: null, error: null };
    }
    return { data: null, error: { message: 'unsupported op', code: 'X' } };
  }

  // postgrest-js builders are thenable — awaiting the chain executes it.
  then<T>(onFulfilled: (value: ExecResult) => T, onRejected?: (reason: unknown) => T): Promise<T> {
    return Promise.resolve(this.exec()).then(onFulfilled, onRejected);
  }
}

class MockSupabase {
  media_items: Row[] = [];
  media_folders: Row[] = [];
  private seq = 0;
  private nextId(): string {
    this.seq += 1;
    return `uuid-${this.seq}`;
  }

  from(name: string): QueryBuilder {
    const rows = name === 'media_items' ? this.media_items : name === 'media_folders' ? this.media_folders : (() => { throw new Error(`unexpected table ${name}`); })();
    return new QueryBuilder(rows, name, () => this.nextId());
  }
}

async function run() {
  console.log('\nTask 1 — anime-series Add File save (parent-ensure-first)\n');

  console.log('§A — exact reported scenario: first-time anime-series save');
  {
    const mock = new MockSupabase();
    const service = new CanonicalMediaService(mock as unknown as any);

    const BLACK_CLOVER_TMDB = '73223';
    let mediaItemId: string | null = null;
    let caught: unknown = null;
    try {
      mediaItemId = await resolveMediaItemId(service, {
        contentType: 'anime', tmdbId: BLACK_CLOVER_TMDB, title: 'Black Clover', year: 2017,
        seasonNum: 2, episodeNum: 1, episodeTitle: 'The Wizard King',
        posterPath: '/black-clover.jpg', backdropPath: '/black-clover-bd.jpg',
      });
    } catch (err) { caught = err; }

    ok(caught === null && typeof mediaItemId === 'string', 'A1. save succeeds (no PARENT_NOT_FOUND)');
    if (caught) console.log('       error:', caught instanceof Error ? caught.message : caught);
    const parentRows = mock.media_items.filter((r) => r.tmdb_id === BLACK_CLOVER_TMDB && r.season === null && r.episode === null);
    ok(parentRows.length === 1, 'A2. exactly ONE canonical parent for the anime TMDB ID');
    ok(parentRows[0]?.content_type === 'anime', 'A2b. parent row has content_type=anime');
    ok(parentRows[0]?.poster_path === '/black-clover.jpg', 'A2c. parent preserves the selected poster path');
    const episodeRows = mock.media_items.filter((r) => r.tmdb_id === BLACK_CLOVER_TMDB && r.season === 2 && r.episode === 1);
    ok(episodeRows.length === 1, 'A3. exactly ONE episode row for S2E1');
    ok(episodeRows[0]?.content_type === 'anime', 'A3b. episode row has content_type=anime');
    ok(episodeRows[0]?.parent_media_id === parentRows[0]?.id, 'A3c. episode parent_media_id points at the canonical parent');
    ok(episodeRows[0]?.title === 'Black Clover', 'A3d. episode inherits the parent title');
    ok(episodeRows[0]?.episode_title === 'The Wizard King', 'A3e. episode title preserved');
    const animeFolders = mock.media_folders.filter((r) => r.tmdb_id === BLACK_CLOVER_TMDB && r.kind === 'series');
    ok(animeFolders.length === 1, 'A4. exactly ONE anime folder for the title');
    const seasonFolders = mock.media_folders.filter((r) => r.tmdb_id === BLACK_CLOVER_TMDB && r.kind === 'season' && r.season === 2);
    ok(seasonFolders.length === 1, 'A5. exactly ONE Season 02 folder');
  }

  console.log('\n§B — idempotency: repeated save converges');
  {
    const mock = new MockSupabase();
    const service = new CanonicalMediaService(mock as unknown as any);
    const args = { contentType: 'anime', tmdbId: '73223', title: 'Black Clover', year: 2017, seasonNum: 2, episodeNum: 1, episodeTitle: 'The Wizard King' } as const;
    const id1 = await resolveMediaItemId(service, { ...args });
    const id2 = await resolveMediaItemId(service, { ...args });
    ok(id1 === id2, 'B1. repeated save returns the SAME episode media item id');
    ok(mock.media_items.filter((r) => r.tmdb_id === '73223' && r.season === null).length === 1, 'B2. still exactly ONE parent row');
    ok(mock.media_items.filter((r) => r.tmdb_id === '73223' && r.season === 2 && r.episode === 1).length === 1, 'B3. still exactly ONE episode row');
    ok(mock.media_folders.filter((r) => r.tmdb_id === '73223' && r.kind === 'series').length === 1, 'B4. still exactly ONE anime folder');
  }

  console.log('\n§C — update-link: same identity, no duplicate hierarchy');
  {
    const mock = new MockSupabase();
    const service = new CanonicalMediaService(mock as unknown as any);
    const base = { contentType: 'anime', tmdbId: '73223', title: 'Black Clover', year: 2017, seasonNum: 2, episodeNum: 1 } as const;
    const firstId = await resolveMediaItemId(service, { ...base });
    // The "Update link" flow re-resolves the identity for the SAME
    // TMDB/season/episode before updating the media_assets row.
    const secondId = await resolveMediaItemId(service, { ...base, episodeTitle: 'Updated title' });
    ok(firstId === secondId, 'C1. update-link resolves the SAME episode item');
    ok(mock.media_items.length === 2, 'C2. still exactly 2 media_items rows (parent + episode)');
    const episodeRow = mock.media_items.find((r) => r.season === 2 && r.episode === 1);
    ok(episodeRow?.episode_title === 'Updated title', 'C3. episode title refreshed by the update');
  }

  console.log('\n§D — regular TV-series save regression');
  {
    const mock = new MockSupabase();
    const service = new CanonicalMediaService(mock as unknown as any);
    let id: string | null = null; let caught: unknown = null;
    try {
      id = await resolveMediaItemId(service, { contentType: 'series', tmdbId: '1396', title: 'Breaking Bad', year: 2008, seasonNum: 5, episodeNum: 6 });
    } catch (err) { caught = err; }
    ok(caught === null && typeof id === 'string', 'D1. first-time series-episode save succeeds');
    const parent = mock.media_items.find((r) => r.tmdb_id === '1396' && r.season === null);
    const episode = mock.media_items.find((r) => r.tmdb_id === '1396' && r.season === 5 && r.episode === 6);
    ok(parent?.content_type === 'series' && episode?.parent_media_id === parent?.id, 'D2. episode parented to the series row');
  }

  console.log('\n§E — movie save regression');
  {
    const mock = new MockSupabase();
    const service = new CanonicalMediaService(mock as unknown as any);
    const id = await resolveMediaItemId(service, { contentType: 'movie', tmdbId: '278', title: 'The Shawshank Redemption', year: 1994, seasonNum: null, episodeNum: null, posterPath: '/278.jpg' });
    ok(typeof id === 'string', 'E1. movie save succeeds');
    ok(mock.media_items[0]?.content_type === 'movie', 'E2. content_type=movie preserved');
  }

  console.log('\n§F — invalid input still fails safely (service validation contract)');
  {
    const mock = new MockSupabase();
    const service = new CanonicalMediaService(mock as unknown as any);
    const invalids: Array<[string, () => Promise<unknown>]> = [
      'F1. invalid season (-1) rejected as INVALID_SEASON',
    ];
    void invalids;
    let e1: unknown = null;
    try { await resolveMediaItemId(service, { contentType: 'anime', tmdbId: '73223', title: 'X', year: 2017, seasonNum: -1, episodeNum: 1 }); } catch (err) { e1 = err; }
    ok(e1 instanceof MediaServiceError && (e1 as MediaServiceError).code === 'INVALID_SEASON', 'F1. invalid season (-1) → INVALID_SEASON');
    let e2: unknown = null;
    try { await resolveMediaItemId(service, { contentType: 'anime', tmdbId: '73223', title: 'X', year: 2017, seasonNum: 2, episodeNum: 0 }); } catch (err) { e2 = err; }
    ok(e2 instanceof MediaServiceError && (e2 as MediaServiceError).code === 'INVALID_EPISODE', 'F2. invalid episode (0) → INVALID_EPISODE');
    let e3: unknown = null;
    try { await resolveMediaItemId(service, { contentType: 'movie', tmdbId: 'not-a-number', title: 'X', year: null, seasonNum: null, episodeNum: null }); } catch (err) { e3 = err; }
    ok(e3 instanceof MediaServiceError && (e3 as MediaServiceError).code === 'INVALID_TMDB_ID', 'F3. invalid tmdb id → INVALID_TMDB_ID');
    ok(mock.media_items.length === 0, 'F4. failed validations leave NO partial canonical rows (validation runs before the parent ensure)');
  }

  console.log('\n§G — orchestration ORDER: parent ensure strictly first');
  {
    const order: string[] = [];
    const recordingService = {
      ensureMovie: async () => { order.push('ensureMovie'); return { mediaItemId: 'm', folderId: 'f' }; },
      ensureSeries: async () => { order.push('ensureSeries'); return { mediaItemId: 's', folderId: 'f' }; },
      ensureEpisode: async () => { order.push('ensureEpisode'); return { mediaItemId: 'e', folderId: 'f' }; },
      ensureAnime: async () => { order.push('ensureAnime'); return { mediaItemId: 'a', folderId: 'f' }; },
      ensureAnimeEpisode: async () => { order.push('ensureAnimeEpisode'); return { mediaItemId: 'ae', folderId: 'f' }; },
    } as unknown as CanonicalMediaService;
    await resolveMediaItemId(recordingService, { contentType: 'anime', tmdbId: '73223', title: 'X', year: 2017, seasonNum: 2, episodeNum: 1 });
    ok(order.join(',') === 'ensureAnime,ensureAnimeEpisode', 'G1. anime: ensureAnime runs BEFORE ensureAnimeEpisode');
    order.length = 0;
    await resolveMediaItemId(recordingService, { contentType: 'series', tmdbId: '1396', title: 'X', year: 2008, seasonNum: 5, episodeNum: 6 });
    ok(order.join(',') === 'ensureSeries,ensureEpisode', 'G2. series: ensureSeries runs BEFORE ensureEpisode');
    order.length = 0;
    await resolveMediaItemId(recordingService, { contentType: 'movie', tmdbId: '278', title: 'X', year: 1994, seasonNum: null, episodeNum: null });
    ok(order.join(',') === 'ensureMovie', 'G3. movie path unchanged (single ensureMovie)');
  }

  console.log(`\nTask 1 result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
