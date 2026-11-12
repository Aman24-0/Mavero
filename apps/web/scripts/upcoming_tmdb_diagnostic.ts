// Upcoming TMDB live diagnostic (OPTIONAL, NOT part of the test suite —
// never registered in the package.json test chain).
//
// Purpose: verify on the REAL TMDB API that the CineLog-proven
// date-range discovery model behaves as expected for a selected month,
// using control titles resolved through TMDB search (NEVER hardcoded
// TMDB IDs), and print a concise verification table.
//
// Stages probed per control title:
//   A) the CURRENT CineLog discovery shape (the ONE production query):
//      /discover/movie { region: 'IN', with_release_country: 'IN',
//      release_date.gte/lte, include_adult=false,
//      sort_by='release_date.asc' } — NO vote_count floor, NO
//      with_release_type, NO primary_release_date union
//   A2) A + the live-resolved adult provider exclusion
//       (without_watch_providers + watch_region=IN)
//   D) /movie/{id}/release_dates — every India release event (type +
//      date); this is the OPTIONAL releaseKinds enrichment, never a
//      candidate gate: a title missing here still renders from A
//   E) /movie/{id}/watch/providers results.IN.flatrate — the OTT icon
//      source (also never a gate)
//   F) /movie/upcoming?region=IN — context only (not used by Mavero)
//
// Verification stages:
//   1 discover candidate (the ONLY gate)   2 adult provider exclusion
//   3 enrichment lookup                    4 IN events (badge source)
//   5 India flatrate icons
//
// Usage:  npx tsx --tsconfig ./jsconfig.json scripts/upcoming_tmdb_diagnostic.ts
//         (optional env: DIAGNOSTIC_YEAR / DIAGNOSTIC_MONTH, default next month)
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
type WatchProviders = { results?: Record<string, { flatrate?: Array<{ provider_id?: number; provider_name?: string }> }> };

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

console.log(`\nTMDB Upcoming diagnostic — CineLog date-range model — window ${gte} .. ${lte}`);
console.log('Control titles resolved via /search/movie (no hardcoded IDs):');

const adultIds = getAdultProviderIds();
const providerExclusion = adultIds.length > 0 ? adultIds.join('|') : undefined;

const table: Array<{ title: string; id: number; inA: string; inA2: string; inUpcoming: string; inEvents: string; flatrate: string; reason: string }> = [];

for (const control of CONTROL_TITLES) {
  const row = await searchControl(control.query, control.yearHint);
  if (!row) {
    table.push({ title: control.query, id: 0, inA: '-', inA2: '-', inUpcoming: '-', inEvents: 'search: no result', flatrate: '-', reason: 'unresolved control title' });
    continue;
  }
  const id = row.id;
  // A) the CURRENT production discovery shape (the ONE CineLog query).
  const a = await discover({
    region: 'IN',
    with_release_country: 'IN',
    'release_date.gte': gte,
    'release_date.lte': lte,
    include_adult: false,
    sort_by: 'release_date.asc'
  });
  // A2) A + the live-resolved adult provider exclusion.
  const a2 = providerExclusion
    ? await discover({
        region: 'IN',
        with_release_country: 'IN',
        'release_date.gte': gte,
        'release_date.lte': lte,
        include_adult: false,
        sort_by: 'release_date.asc',
        without_watch_providers: providerExclusion,
        watch_region: 'IN'
      })
    : a;
  // D) release_dates — the OPTIONAL releaseKinds enrichment (never a gate).
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
  // E) India flatrate providers — the OTT icon source (never a gate).
  let flatrate = 'lookup failed';
  try {
    const wp = await tmdbRequest<WatchProviders>(`/movie/${id}/watch/providers`);
    const names = (wp.results?.IN?.flatrate ?? []).map((p) => p.provider_name).filter(Boolean);
    flatrate = names.length ? names.slice(0, 4).join(', ') : 'no IN flatrate';
  } catch {
    flatrate = 'lookup failed';
  }
  // F) documented list endpoint — context only (not used by Mavero).
  let inUpcoming = 'not probed';
  try {
    const upcoming = await tmdbRequest<TmdbList>('/movie/upcoming', { region: 'IN', page: 1 });
    const found = (upcoming.results ?? []).some((r) => r.id === id);
    inUpcoming = found ? `yes (of ${(upcoming.results ?? []).length}, page 1)` : `no (of ${(upcoming.results ?? []).length}, page 1)`;
  } catch {
    inUpcoming = 'lookup failed';
  }
  // Verification-stage classification.
  const inA = a.ids.has(id) ? `yes (${a.list.total_results ?? '?'} results, ${(a.rows.get(id)?.release_date ?? '?')})` : `no (${a.list.total_results ?? '?'} results)`;
  const inA2 = providerExclusion ? (a2.ids.has(id) ? 'yes' : 'NO — adult exclusion drops it') : 'n/a';
  let reason: string;
  if (!a.ids.has(id)) {
    reason = '1. not returned by the CineLog date-range query (no India release entry inside the window — check window/title)';
  } else if (!a2.ids.has(id)) {
    reason = '2. dropped by the adult provider exclusion (expected only for adult-rail titles)';
  } else if (!releaseDatesOk) {
    reason = 'renders WITHOUT kind badges (3. enrichment lookup failed — movie still qualifies: enrichment is optional)';
  } else if (inEvents === 'no IN entry') {
    reason = 'renders WITHOUT kind badges (4. no IN events in enrichment — movie still qualifies: enrichment is optional)';
  } else {
    reason = 'survives every stage — card date = discover release_date; badges derive from the IN events below';
  }
  const eventsText = inEventList.length > 0 ? inEventList.map((e) => `${e.date} T${e.type}`).join(' | ') : inEvents;
  table.push({ title: row.title ?? row.original_title ?? control.query, id, inA, inA2, inUpcoming, inEvents: eventsText, flatrate, reason });
}

console.log('\nDisplays: A = CineLog discovery (region=IN + with_release_country=IN + release_date window, release_date.asc, no vote floor),');
console.log('A2 = A + adult provider exclusion, D = IN release events (T2 theatrical-limited / T3 theatrical / T4 digital), E = India flatrate.\n');
const header = ['title', 'tmdbId', 'discover(A)', 'A2 adult-excl', '/movie/upcoming', 'IN release events', 'IN flatrate', 'final reason'];
const rowsOut = table.map((r) => [r.title, String(r.id), r.inA, r.inA2, r.inUpcoming, r.inEvents, r.flatrate, r.reason]);
const widths = header.map((h, i) => Math.max(h.length, ...rowsOut.map((r) => r[i].length)));
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join(' | ');
console.log(line(header));
console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
for (const r of rowsOut) console.log(line(r));
console.log('\nDiagnostic complete. This script is optional and never part of the test suite.');
