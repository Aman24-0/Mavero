// PHASE F.3 — Upcoming TMDB live diagnostic (OPTIONAL, NOT part of the
// test suite — never registered in the package.json test chain).
//
// Purpose: prove on the REAL TMDB API exactly where October 2026+ movie
// candidates are lost, using control titles resolved through TMDB search
// (NEVER hardcoded TMDB IDs), and print a concise rejection table.
//
// Stages probed per control title:
//   A) the CURRENT F.3 candidate-source-A shape:
//      /discover/movie { region: 'IN', release_date.gte/lte, vote_count.gte=1,
//      include_adult=false, sort_by=popularity.desc } (no with_release_type)
//   A2) A + the transitional adult provider exclusion (without_watch_providers
//       + watch_region=IN, values resolved live from the India provider list)
//   B) A minus the region parameter (is the regional index the blocker?)
//   C) the F.3 candidate-source-B shape:
//      /discover/movie { primary_release_date.gte/lte, ... } (NO region)
//   D) /movie/{id}/release_dates — every India release event (type + date)
//   E) /movie/upcoming?region=IN — the documented list endpoint as an
//      alternative candidate source
//
// Rejection-stage classification (the seven stages a candidate can die at):
//   1 discover candidate   2 adult provider exclusion   3 release_dates lookup
//   4 IN country extraction   5 release type 2/3/4      6 month filter
//   7 adult classifier
//
// Usage:  npx tsx --tsconfig ./jsconfig.json scripts/upcoming_tmdb_diagnostic.ts
//         (optional env: DIAGNOSTIC_YEAR / DIAGNOSTIC_MONTH, default 2026-10)
//
// Requirements: TMDB_READ_ACCESS_TOKEN (v4) or TMDB_API_KEY (v3) in the
// environment. Credentials are NEVER printed. Without credentials this
// script states that clearly and exits without fabricating anything.
import { register } from 'node:module';

register(new URL('./upcoming_test_hooks.mjs', import.meta.url));

// Feed the SvelteKit env shim from the REAL process environment (the
// adapter reads `$env/dynamic/private`). Values are never printed.
(globalThis as Record<string, unknown>).__MAVERO_UPCOMING_TEST_ENV__ = {
  TMDB_READ_ACCESS_TOKEN: process.env.TMDB_READ_ACCESS_TOKEN ?? '',
  TMDB_API_KEY: process.env.TMDB_API_KEY ?? ''
};

type TmdbMovieRow = { id: number; title?: string; original_title?: string; release_date?: string; original_language?: string; popularity?: number };
type TmdbList = { page?: number; total_pages?: number; total_results?: number; results?: TmdbMovieRow[] };
type ReleaseDates = { results?: Array<{ iso_3166_1?: string; release_dates?: Array<{ release_date?: string; type?: number }> }> };

const { tmdbRequest, getTmdbIndiaProviders, getAdultProviderIds } = await import('../src/lib/server/content/adapters/tmdb.ts');

const hasCredential = Boolean(process.env.TMDB_READ_ACCESS_TOKEN || process.env.TMDB_API_KEY);
if (!hasCredential) {
  console.log('TMDB diagnostic NOT run: no TMDB credentials in this environment.');
  console.log('Set TMDB_READ_ACCESS_TOKEN (v4 read token) or TMDB_API_KEY (v3 key) and re-run:');
  console.log('  npx tsx --tsconfig ./jsconfig.json scripts/upcoming_tmdb_diagnostic.ts');
  console.log('No results are fabricated in the absence of credentials.');
  process.exit(0);
}

const now = new Date();
const year = Number(process.env.DIAGNOSTIC_YEAR) || now.getFullYear();
const month = Number(process.env.DIAGNOSTIC_MONTH) || (now.getMonth() + 2 > 12 ? 1 : now.getMonth() + 2);
const pad = (n: number) => String(n).padStart(2, '0');
const gte = `${year}-${pad(month)}-01`;
const lte = `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;

// Control titles are resolved through TMDB SEARCH — never hardcoded IDs.
const CONTROL_TITLES: Array<{ query: string; yearHint?: number }> = [
  { query: 'Jailer 2', yearHint: 2026 },
  { query: 'Drishyam: The Conclusion', yearHint: 2026 }
];

async function searchControl(query: string, yearHint?: number): Promise<TmdbMovieRow | undefined> {
  const result = await tmdbRequest<TmdbList>('/search/movie', { query, include_adult: false });
  const rows = result.results ?? [];
  return rows.find((r) => (r.title ?? r.original_title ?? '').toLowerCase().includes(query.toLowerCase().split(':')[0]))
    ?? rows.find((r) => (yearHint && r.release_date?.startsWith(String(yearHint))))
    ?? rows[0];
}

async function discover(params: Record<string, string | number | boolean>): Promise<{ list: TmdbList; ids: Set<number>; rows: Map<number, TmdbMovieRow> }> {
  const list = await tmdbRequest<TmdbList>('/discover/movie', params);
  const ids = new Set<number>();
  const rows = new Map<number, TmdbMovieRow>();
  for (const row of list.results ?? []) if (row.id) { ids.add(row.id); rows.set(row.id, row); }
  return { list, ids, rows };
}

function typeLabel(type: number | undefined): string {
  return ({ 1: 'Premiere', 2: 'Theatrical (limited)', 3: 'Theatrical', 4: 'Digital', 5: 'Physical', 6: 'TV' } as Record<number, string>)[type ?? 0] ?? `Type ${type}`;
}

console.log(`\nTMDB Upcoming diagnostic — window ${gte} .. ${lte}`);
console.log('Control titles resolved via /search/movie (no hardcoded IDs):');

const adultIds = getAdultProviderIds();
const providerExclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;

const table: Array<{ title: string; id: number; inA: string; inA2: string; inB: string; inC: string; inUpcoming: string; inEvents: string; reason: string }> = [];

for (const control of CONTROL_TITLES) {
  const row = await searchControl(control.query, control.yearHint);
  if (!row) {
    table.push({ title: control.query, id: 0, inA: '-', inA2: '-', inB: '-', inC: '-', inUpcoming: '-', inEvents: 'search: no result', reason: 'unresolved control title' });
    continue;
  }
  const id = row.id;
  // A) current source-A shape (region-aware, no with_release_type).
  const a = await discover({ region: 'IN', 'release_date.gte': gte, 'release_date.lte': lte, sort_by: 'popularity.desc', 'vote_count.gte': 1, include_adult: false });
  // A2) A + the live-resolved adult provider exclusion.
  const a2 = providerExclusion
    ? await discover({ region: 'IN', 'release_date.gte': gte, 'release_date.lte': lte, sort_by: 'popularity.desc', 'vote_count.gte': 1, include_adult: false, without_watch_providers: providerExclusion, watch_region: 'IN' })
    : a;
  // B) A minus region — isolates the regional release-date index.
  const b = await discover({ 'release_date.gte': gte, 'release_date.lte': lte, sort_by: 'popularity.desc', 'vote_count.gte': 1, include_adult: false });
  // C) source-B shape — primary release-date window (no region).
  const c = await discover({ 'primary_release_date.gte': gte, 'primary_release_date.lte': lte, sort_by: 'popularity.desc', 'vote_count.gte': 1, include_adult: false });
  // D) release_dates truth — every India event.
  let inEvents = 'lookup failed';
  let releaseDatesOk = false;
  const inEventList: Array<{ date: string; type: number }> = [];
  try {
    const rd = await tmdbRequest<ReleaseDates>(`/movie/${id}/release_dates`);
    releaseDatesOk = true;
    const country = (rd.results ?? []).find((entry) => entry.iso_3166_1 === 'IN');
    if (!country) inEvents = 'no IN entry';
    for (const event of country?.release_dates ?? []) {
      if (event.release_date) inEventList.push({ date: event.release_date.slice(0, 10), type: event.type ?? 0 });
    }
    if (country) inEvents = `${inEventList.length} IN event(s)`;
  } catch {
    releaseDatesOk = false;
  }
  // E) documented list endpoint as an alternative candidate source.
  let inUpcoming = 'not probed';
  try {
    const upcoming = await tmdbRequest<TmdbList>('/movie/upcoming', { region: 'IN', page: 1 });
    const found = (upcoming.results ?? []).some((r) => r.id === id);
    inUpcoming = found ? `yes (of ${(upcoming.results ?? []).length}, page 1)` : `no (of ${(upcoming.results ?? []).length}, page 1)`;
  } catch {
    inUpcoming = 'lookup failed';
  }
  // Rejection-stage classification.
  const inA = a.ids.has(id) ? `yes (${a.list.total_results ?? '?'} results, ${(a.rows.get(id)?.release_date ?? '?')})` : `no (${a.list.total_results ?? '?'} results)`;
  const inA2 = providerExclusion ? (a2.ids.has(id) ? 'yes' : 'NO — adult exclusion drops it') : 'n/a';
  const inB = b.ids.has(id) ? `yes (${b.list.total_results ?? '?'} results)` : `no (${b.list.total_results ?? '?'} results)`;
  const inC = c.ids.has(id) ? `yes (${c.list.total_results ?? '?'} results)` : `no (${c.list.total_results ?? '?'} results)`;
  let reason: string;
  if (!a.ids.has(id) && !b.ids.has(id) && !c.ids.has(id)) {
    reason = '1. lost at Discover candidate stage in EVERY documented shape (check window/title)';
  } else if (a.ids.has(id) && !a2.ids.has(id)) {
    reason = '2. dropped by the adult provider exclusion';
  } else if (!a.ids.has(id) && (b.ids.has(id) || c.ids.has(id))) {
    reason = '1. region-aware Discover starvation (IN regional date not indexed) — source B recovers it';
  } else if (!releaseDatesOk) {
    reason = '3. release_dates lookup failed';
  } else if (inEvents === 'no IN entry') {
    reason = '4. no IN country entry in release_dates';
  } else if (inEventList.length > 0 && !inEventList.some((e) => [2, 3, 4].includes(e.type))) {
    reason = `5. IN events exist but none of type 2/3/4 (${inEventList.map((e) => typeLabel(e.type)).join(', ')})`;
  } else if (inEventList.length > 0 && !inEventList.some((e) => [2, 3, 4].includes(e.type) && e.date >= gte && e.date <= lte)) {
    reason = `6. qualifying IN type 2/3/4 events exist but OUTSIDE ${gte}..${lte} (${inEventList.filter((e) => [2, 3, 4].includes(e.type)).map((e) => `${e.date} ${typeLabel(e.type)}`).join('; ') || 'none'})`;
  } else {
    reason = 'survives every stage — should render (verify classifier/adult flag if missing in UI)';
  }
  const eventsText = inEventList.length > 0 ? inEventList.map((e) => `${e.date} T${e.type}`).join(' | ') : inEvents;
  table.push({ title: row.title ?? row.original_title ?? control.query, id, inA, inA2, inB, inC, inUpcoming, inEvents: eventsText, reason });
}

console.log('\nDisplays: A = F.3 source A (region=IN + release_date window), A2 = A + adult provider exclusion,');
console.log('B = A minus region, C = source B (primary_release_date window, no region), D = IN release events (T2 theatrical-limited / T3 theatrical / T4 digital).\n');
const header = ['title', 'tmdbId', 'discover-current(A)', 'A2 adult-excl', 'discover-noRegion(B)', 'discover-broader(C)', '/movie/upcoming', 'IN release events', 'final reason'];
const rowsOut = table.map((r) => [r.title, String(r.id), r.inA, r.inA2, r.inB, r.inC, r.inUpcoming, r.inEvents, r.reason]);
const widths = header.map((h, i) => Math.max(h.length, ...rowsOut.map((r) => r[i].length)));
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join(' | ');
console.log(line(header));
console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
for (const r of rowsOut) console.log(line(r));
console.log('\nDiagnostic complete. This script is optional and never part of the test suite.');
