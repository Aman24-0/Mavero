// ============================================================================
// Adult leak hardening regression test (2026-10-07, second round).
//
// Locks the three production bugs this task fixed:
//   Bug #1 — adult content still leaked with Adult Mode OFF. Root causes:
//     (a) five Indian adult OTT networks were missing from the verified
//         registry (Hulchul 8209, Nuefliks 8211, Rabbit Movies 4575,
//         HotMasti 5093, Big Movie Zoo 4920);
//     (b) TMDB "orphan" entries — auto-scraped ecosystem titles with NO
//         networks[] field — could never be classified by ANY registry, so
//         they leaked through search/rails (Charmsukh Jane Anjane Mein
//         /tv/219035, Bhabhi Ji Suniya Na /tv/290352, Charmsukh Bidaai
//         Part 1 /tv/212935, ...).
//   Bug #2 — the Adult Discover Movies/TV selector showed an always-empty
//     Movies option (the movie half had no verifiable JustWatch source).
//     REMOVED: the type union is 'series' only; a stale type=movie
//     parameter is rejected.
//   Bug #3 — provider catalogs returned 1-3 titles because TMDB genuinely
//     has only that many NETWORKED titles per service (live-verified
//     evidence in the worklog); the attributed orphan supplement now
//     enriches the provider-filtered catalog.
//
// The test uses the REAL classifier, REAL registries, and metadata shapes
// captured from the LIVE TMDB records (2026-10-07 public-website audit).
// Deterministic, credential-free.
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { isAdultContent, isAdultProviderHomepage, isAdultProviderOverview } =
  await import('../src/lib/server/content/adult-providers.ts');
const { getAdultNetworkIds, getVerifiedAdultNetworks, getVerifiedAdultNetworkOptions, getVerifiedAdultProviderDomains } =
  await import('../src/lib/server/content/adult-networks.ts');
const {
  getAdultOrphanAttribution,
  getAdultOrphanAttributions,
  getAdultOrphanIdsForProvider,
  __setAdultOrphanRegistryForTest,
  __resetAdultOrphanRegistryForTest
} = await import('../src/lib/server/content/adult-orphans.ts');
const { isAdultDiscoverType, ADULT_DISCOVER_PROVIDER_ALL } = await import('../src/lib/server/content/adult-discover.ts');

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

// ---------------------------------------------------------------------------
// 1 — REGISTRY: the five newly verified networks are live-confirmed members.
// ---------------------------------------------------------------------------
{
  const ids = getAdultNetworkIds().sort((a, b) => a - b);
  assert.deepEqual(
    ids,
    [2112, 2902, 4573, 4575, 4623, 4920, 5093, 5094, 7355, 7905, 8209, 8211],
    'verified registry = 12 live-confirmed networks (both 2026-10 rounds)'
  );
  // Each new network classifies a title (adult=false) via the network signal.
  const newNetworks: Array<[number, string]> = [
    [8209, 'Hulchul'],
    [8211, 'Nuefliks'],
    [4575, 'Rabbit'],
    [5093, 'HotMasti'],
    [4920, 'Big Movie Zoo']
  ];
  for (const [id, name] of newNetworks) {
    assert.equal(
      isAdultContent(undefined, undefined, false, false, [{ id, name }]),
      true,
      `networked title on ${name} (${id}) classifies Adult`
    );
  }
  ok('1. five newly verified networks (Hulchul/Nuefliks/Rabbit/HotMasti/BigMovieZoo) classify their titles Adult');
}

// ---------------------------------------------------------------------------
// 2 — THE LEAK MATRIX (the production screenshot titles, live TMDB shapes).
//     Adult Mode OFF => every one of these is classified Adult and can never
//     pass the search/rail/detail filters.
// ---------------------------------------------------------------------------
{
  // /tv/97072 "Charmsukh" — networks [Ullu 2902], adult=false (live record).
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 2902, name: 'Ullu' }]), true, 'Charmsukh (Ullu 2902) -> Adult');
  // /tv/119721 "Sweety Bhabhi" — networks [HotHit 5094], adult=false.
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 5094, name: 'HotHit' }]), true, 'Sweety Bhabhi (HotHit 5094) -> Adult');
  // /tv/122905 "Mohini Bhabhi" — networks [The CinemaDosti 4623], adult=false.
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 4623, name: 'The CinemaDosti' }]), true, 'Mohini Bhabhi (CinemaDosti 4623) -> Adult');
  // /tv/277729 "Bhabhi Ki Pathshala" — networks [NOTTY 7905], adult=false.
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 7905, name: 'NOTTY' }]), true, 'Bhabhi Ki Pathshala (NOTTY 7905) -> Adult');
  // /tv/289516 "Gharwali Baharwali" — networks [Hulchul 8209], adult=false.
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 8209, name: 'Hulchul' }]), true, 'Gharwali Baharwali (Hulchul 8209) -> Adult');
  ok('2. networked leak matrix: Charmsukh / Sweety Bhabhi / Mohini Bhabhi / Bhabhi Ki Pathshala / Gharwali Baharwali all Adult');
}

// ---------------------------------------------------------------------------
// 3 — THE ORPHAN LEAKS (networkless TMDB records). These were the titles
//     that leaked in production BECAUSE no network field exists on their
//     TMDB records. Covered now by: the orphan attribution registry (Signal
//     5), the homepage-domain signal (Signal 6) and the overview
//     provider-context signal (Signal 7).
// ---------------------------------------------------------------------------
{
  // /tv/219035 "Charmsukh Jane Anjane Mein": no networks; homepage =
  // https://ullu.app/; keywords sex+nudity; adult=false (public search
  // returns it, and the public search hides adult-flagged content).
  // (a) orphan registry signal:
  assert.equal(isAdultContent(undefined, undefined, false, false, undefined, { mediaType: 'series', tmdbId: 219035 }), true, 'orphan registry classifies /tv/219035 (Charmsukh Jane Anjane Mein) Adult');
  // (b) homepage-domain signal (independent of the registry):
  assert.equal(isAdultContent(undefined, undefined, false, false, undefined, { mediaType: 'series', tmdbId: 999999, homepage: 'https://ullu.app/' }), true, 'homepage ullu.app classifies Adult');
  assert.equal(isAdultProviderHomepage('https://ullu.app/#/home'), true, 'ullu.app/#/home homepage matches');
  assert.equal(isAdultProviderHomepage('https://www.altbalaji.com/show/307'), true, 'www.altbalaji.com homepage matches');
  assert.equal(isAdultProviderHomepage('https://ullu.app.evil.com/'), false, 'lookalike domain ullu.app.evil.com does NOT match (exact registrable-domain equality)');
  assert.equal(isAdultProviderHomepage('https://netflix.com'), false, 'non-adult domain does not match');
  assert.equal(isAdultProviderHomepage(''), false, 'empty homepage is no signal');
  assert.equal(isAdultProviderHomepage(null), false, 'null homepage is no signal');
  assert.equal(isAdultProviderHomepage('not a url at all'), false, 'malformed homepage is no signal (never throws)');

  // /tv/290352 "Bhabhi Ji Suniya Na": no networks, no homepage, overview =
  // "New Hulchul WebSeries" (the record names its own provider).
  // (a) orphan registry signal:
  assert.equal(isAdultContent(undefined, undefined, false, false, undefined, { mediaType: 'series', tmdbId: 290352 }), true, 'orphan registry classifies /tv/290352 (Bhabhi Ji Suniya Na) Adult');
  // (b) overview provider-context signal (independent of the registry):
  assert.equal(isAdultProviderOverview('New Hulchul WebSeries'), true, '"New Hulchul WebSeries" overview matches (provider + web-series context)');
  assert.equal(isAdultProviderOverview('Watch the all new Kooku originals now streaming'), true, 'Kooku + originals overview matches');
  assert.equal(isAdultContent(undefined, undefined, false, false, undefined, { mediaType: 'series', tmdbId: 888888, overview: 'New Hulchul WebSeries' }), true, 'overview-only attribution classifies Adult');

  // /tv/212935 "Charmsukh Bidaai Part 1": no networks; franchise entry.
  assert.equal(isAdultContent(undefined, undefined, false, false, undefined, { mediaType: 'series', tmdbId: 212935 }), true, 'orphan registry classifies /tv/212935 (Charmsukh Bidaai Part 1) Adult');

  // The remaining audited orphans.
  assert.equal(isAdultContent(undefined, undefined, false, false, undefined, { mediaType: 'series', tmdbId: 129152 }), true, 'Sarla Bhabhi /tv/129152 (Nuefliks attribution) -> Adult');
  assert.equal(isAdultContent(undefined, undefined, false, false, undefined, { mediaType: 'series', tmdbId: 128947 }), true, 'Nancy Bhabhi /tv/128947 (Flizmovies attribution) -> Adult');
  assert.equal(isAdultContent(undefined, undefined, false, false, undefined, { mediaType: 'series', tmdbId: 226804 }), true, 'Paglet /tv/226804 (PrimePlay attribution) -> Adult');
  assert.equal(isAdultContent(undefined, undefined, false, false, undefined, { mediaType: 'series', tmdbId: 291951 }), true, 'Raseeli Bhabhi /tv/291951 (ALTT attribution) -> Adult');
  assert.equal(isAdultContent(undefined, undefined, false, false, undefined, { mediaType: 'series', tmdbId: 208385 }), true, 'Malkin Bhabhi /tv/208385 (external adult listing) -> Adult');

  // Identity precision: unregistered ids never match.
  assert.equal(getAdultOrphanAttribution('series', 999999), undefined, 'unknown id has no attribution');
  assert.equal(getAdultOrphanAttribution('movie', 219035), undefined, 'movie-typed lookup of a series orphan has no attribution');
  assert.equal(getAdultOrphanAttribution('series', 0), undefined, 'id 0 has no attribution');
  assert.equal(getAdultOrphanAttribution(undefined, 219035), undefined, 'missing media type has no attribution');
  ok('3. orphan leak matrix (Charmsukh Jane Anjane Mein / Bhabhi Ji Suniya Na / Bidaai / Sarla / Nancy / Paglet / Raseeli / Malkin) all Adult via attribution signals');
}

// ---------------------------------------------------------------------------
// 4 — FALSE-POSITIVE CONTROLS (the do-not-over-block contract). These are
//     REAL TMDB records whose titles contain "Bhabhi"/"Bhabiji"-like words
//     but whose metadata says mainstream — they must STAY available with
//     Adult Mode OFF. Classification is metadata-based, never title-based.
// ---------------------------------------------------------------------------
{
  // /tv/308964 "Bhabiji Ghar Par Hain 2.0" (2025) — networks [&TV 1566,
  // Zee5 2590] (live record). Mainstream metadata -> NOT adult.
  assert.equal(
    isAdultContent(undefined, undefined, false, false, [{ id: 1566, name: '&TV' }, { id: 2590, name: 'Zee5' }], { mediaType: 'series', tmdbId: 308964, overview: 'The beloved neighbors are back.' }),
    false,
    'Bhabiji Ghar Par Hain 2.0 (&TV + Zee5 networks) is NOT adult'
  );
  // /tv/14310 "Bhabhi" (2005, Star Plus) — mainstream Hindi serial.
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 159, name: 'Star Plus' }]), false, 'Bhabhi (Star Plus) is NOT adult');
  // /tv/65532 "Woh Teri Bhabhi Hai Pagle" (2016) — no networks, no signals,
  // no provider context. Sparse-but-clean metadata is legitimately not adult.
  assert.equal(isAdultContent(undefined, undefined, false, false, undefined, { mediaType: 'series', tmdbId: 65532, overview: 'A light-hearted comedy.' }), false, 'Woh Teri Bhabhi Hai Pagle (no signals) is NOT adult');
  // /tv/334239 "Hamari Bhabhi Number 1" (2026, Dangal TV).
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 6169, name: 'Dangal TV' }]), false, 'Hamari Bhabhi Number 1 (Dangal TV) is NOT adult');
  // The 2004 Bollywood movie "Hulchul": the provider name appears in normal
  // overview prose WITHOUT web-series context — the co-occurrence guard must
  // keep it safe.
  assert.equal(isAdultProviderOverview('Hulchul is a story of a family of con artists...'), false, 'Hulchul (2004) overview without web-series context does NOT match');
  assert.equal(isAdultProviderOverview('An ullu (owl) watches over the forest'), false, '"ullu" as the Hindi word for owl does NOT match');
  assert.equal(isAdultProviderOverview(''), false, 'empty overview is no signal');
  assert.equal(isAdultProviderOverview(null), false, 'null overview is no signal');
  // Attribution signals are inert for clean records.
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 213, name: 'Netflix' }], { mediaType: 'series', tmdbId: 1399, homepage: 'https://www.hbo.com/game-of-thrones', overview: 'Nine noble families fight for control.' }), false, 'Game of Thrones-shaped record with attribution evidence is NOT adult');
  ok('4. false-positive controls: Bhabiji Ghar Par Hain 2.0 / Bhabhi (Star Plus) / Woh Teri Bhabhi Hai Pagle / Hamari Bhabhi Number 1 / Hulchul (2004) all stay available');
}

// ---------------------------------------------------------------------------
// 5 — ORPHAN REGISTRY CONTRACT: provider-scoped access for the Adult
//     Discover injection + evidence invariants + test override.
// ---------------------------------------------------------------------------
{
  const all = getAdultOrphanAttributions();
  assert.ok(all.length >= 8, `at least 8 audited orphan attributions (${all.length})`);
  for (const entry of all) {
    assert.ok(Number.isInteger(entry.tmdbId) && entry.tmdbId > 0, `entry ${entry.tmdbId} carries a positive integer id`);
    assert.ok(entry.mediaType === 'movie' || entry.mediaType === 'series', `entry ${entry.tmdbId} carries a canonical media type`);
    assert.ok(entry.evidence.length > 0, `entry ${entry.tmdbId} records its evidence class`);
    assert.ok(entry.note.length > 20, `entry ${entry.tmdbId} records a real evidence note`);
    if (entry.providerKey !== undefined) {
      assert.ok(typeof entry.providerKey === 'string' && entry.providerKey.length > 2, `entry ${entry.tmdbId} provider key well-formed`);
    }
  }
  // Provider-scoped injection sets.
  const ulluIds = getAdultOrphanIdsForProvider('ullu').map((x) => x.tmdbId).sort((a, b) => a - b);
  assert.deepEqual(ulluIds, [212935, 219035], 'ullu-attributed orphans = Charmsukh Bidaai + Charmsukh Jane Anjane Mein');
  const hulchulIds = getAdultOrphanIdsForProvider('hulchul').map((x) => x.tmdbId);
  assert.deepEqual(hulchulIds, [290352], 'hulchul-attributed orphans = Bhabhi Ji Suniya Na');
  const nuefliksIds = getAdultOrphanIdsForProvider('nuefliks').map((x) => x.tmdbId).sort((a, b) => a - b);
  assert.deepEqual(nuefliksIds, [128947, 129152], 'nuefliks-attributed orphans = Nancy Bhabhi + Sarla Bhabhi');
  const primeplayIds = getAdultOrphanIdsForProvider('primeplay').map((x) => x.tmdbId);
  assert.deepEqual(primeplayIds, [226804], 'primeplay-attributed orphans = Paglet (provider key is an UNVERIFIED network candidate: classification applies, provider-scoped injection never fires because the route union only serves verified keys)');
  const alttIds = getAdultOrphanIdsForProvider('altt').map((x) => x.tmdbId);
  assert.deepEqual(alttIds, [291951], 'altt-attributed orphans = Raseeli Bhabhi');
  // Malkin Bhabhi: external-adult-listing WITHOUT a provider key — never
  // injected into any provider query.
  const malkin = getAdultOrphanAttribution('series', 208385);
  assert.equal(malkin?.providerKey, undefined, 'Malkin Bhabhi carries no provider key (platform unconfirmed)');
  // 'all' returns the full set; unknown providers return nothing.
  assert.equal(getAdultOrphanIdsForProvider(ADULT_DISCOVER_PROVIDER_ALL).length, all.length, "'all' returns every attributed orphan");
  assert.deepEqual(getAdultOrphanIdsForProvider('hothit'), [], 'no orphan attributed to hothit (TMDB genuinely has only the 1 networked Sweety Bhabhi — live-verified)');
  assert.deepEqual(getAdultOrphanIdsForProvider('hunters'), [], 'unverified candidate key returns no injection set');
  // Test override hooks.
  __setAdultOrphanRegistryForTest([{ mediaType: 'series', tmdbId: 777, evidence: 'tmdb-overview', note: 'controlled test entry' }]);
  try {
    assert.equal(getAdultOrphanAttribution('series', 777)?.tmdbId, 777, 'test override installs a controlled registry');
    assert.equal(isAdultContent(undefined, undefined, false, false, undefined, { mediaType: 'series', tmdbId: 777 }), true, 'override entry classifies Adult');
    assert.deepEqual(getAdultOrphanIdsForProvider(ADULT_DISCOVER_PROVIDER_ALL), [{ mediaType: 'series', tmdbId: 777 }], 'override drives the provider accessor');
  } finally {
    __resetAdultOrphanRegistryForTest();
  }
  assert.equal(getAdultOrphanAttribution('series', 777), undefined, 'override fully reset');
  assert.equal(getAdultOrphanAttribution('series', 219035)?.tmdbId, 219035, 'production registry restored');
  ok('5. orphan registry contract: evidence invariants, provider-scoped injection sets, test override');
}

// ---------------------------------------------------------------------------
// 6 — MOVIE/TV SELECTOR REMOVAL (Bug #2): TV-only contract + stale
//     parameter rejection.
// ---------------------------------------------------------------------------
{
  assert.equal(isAdultDiscoverType('series'), true, "type 'series' is the ONLY valid Adult Discover type");
  assert.equal(isAdultDiscoverType('movie'), false, "stale type='movie' is REJECTED (removed selector cannot be reactivated)");
  assert.equal(isAdultDiscoverType('tv'), false, "type 'tv' rejected");
  // The route rejects type=movie BEFORE any catalog access (wiring).
  const endpoint = readFileSync(new URL('../src/routes/api/content/adult-discover/+server.ts', import.meta.url), 'utf8');
  assert.match(endpoint, /isAdultDiscoverType\(typeParam\)/, 'the route validates the type against the TV-only union');
  assert.match(endpoint, /INVALID_TYPE/, 'a stale movie type answers 400 INVALID_TYPE');
  // The UI no longer renders a media-type selector.
  const section = readFileSync(new URL('../src/lib/components/AdultDiscoverSection.svelte', import.meta.url), 'utf8');
  assert.doesNotMatch(section, /TYPE_OPTIONS|changeType|label="TV Shows"/, 'the UI renders NO Movies/TV selector');
  // The adapter has no movie branch.
  const adapter = readFileSync(new URL('../src/lib/server/content/adapters/tmdb.ts', import.meta.url), 'utf8');
  const fn = adapter.match(/export async function getTmdbAdultDiscover[\s\S]*?^}/m);
  assert.ok(fn, 'getTmdbAdultDiscover found');
  assert.doesNotMatch(fn![0], /with_watch_providers|watch_region|providerInclusion/, 'the Adult Discover adapter has no movie/JustWatch branch');
  assert.match(fn![0], /buildOrphanCandidateRows\(selectedProviderKey\)/, 'the TV path injects the attributed orphan supplement');
  ok('6. Movies/TV selector REMOVED: TV-only union, stale type=movie rejected, UI selector gone, adapter movie branch gone');
}

// ---------------------------------------------------------------------------
// 7 — PROVIDER LOGOS (Bug #4B): every verified network carries a logo path
//     EXCEPT the two that genuinely have none on TMDB (CinemaDosti 4623 and
//     Hulchul 8209 — live-checked 2026-10-07: their network pages render the
//     empty logo template). Those fall back to the existing label-only UI.
// ---------------------------------------------------------------------------
{
  const options = getVerifiedAdultNetworkOptions();
  assert.equal(options.length, 12, '12 verified provider options served to the dropdown');
  const withLogos = options.filter((o) => o.logoPath);
  const logoKeys = withLogos.map((o) => o.key).sort();
  assert.deepEqual(logoKeys, ['altt', 'atrangii', 'big-movie-zoo', 'hothit', 'hotmasti', 'kooku', 'notty', 'nuefliks', 'rabbit-movies', 'ullu'], '10 providers carry TMDB-sourced logos (incl. the previously logo-less ALTT/HotHit/NOTTY)');
  const logoless = options.filter((o) => !o.logoPath).map((o) => o.key).sort();
  assert.deepEqual(logoless, ['cinemadosti', 'hulchul'], 'only CinemaDosti and Hulchul are logo-less (genuinely absent on TMDB — safe label-only fallback, never a fabricated logo)');
  for (const option of withLogos) {
    assert.match(option.logoPath as string, /^\/[a-zA-Z0-9_-]+\.(png|jpg)$/, `logo path is a TMDB image path (${option.key})`);
  }
  // Provider domains (homepage signal source): only TMDB-record-evidenced domains.
  assert.deepEqual(getVerifiedAdultProviderDomains(), ['ullu.app', 'altbalaji.com'], 'provider domains are exactly the two TMDB-record-evidenced ones');
  ok('7. provider logos: ALTT/HotHit/NOTTY/Nuefliks/Rabbit/HotMasti/BigMovieZoo logos added; CinemaDosti+Hulchul use the documented safe fallback');
}

// ---------------------------------------------------------------------------
// 8 — WIRING: the detail path feeds the attribution evidence (the signal
//     entry point that makes every surface orphan-safe).
// ---------------------------------------------------------------------------
{
  const adapter = readFileSync(new URL('../src/lib/server/content/adapters/tmdb.ts', import.meta.url), 'utf8');
  assert.match(adapter, /const attribution: AdultAttributionInput \| undefined = \{/, 'getTmdbDetail builds the attribution evidence object');
  assert.match(adapter, /homepage: \(raw as TmdbMovie\)\.homepage \?\? null/, 'the record homepage feeds the provider-domain signal');
  assert.match(adapter, /overview: asString\(raw\.overview\) \|\| null/, 'the record overview feeds the provider-context signal');
  assert.match(adapter, /isAdultContent\(item\.tags, providerIds, tmdbAdult, item\.isAnime, networks, attribution\)/, 'the central classifier receives the attribution evidence');
  // Search TV rows classify through the detail path (orphan signals apply).
  assert.match(adapter, /async function classifySearchRow[\s\S]*?getTmdbDetail\('series', tmdbId\)/, 'search TV rows still classify through the cached detail path (orphan/homepage/overview signals apply)');
  // The classifier module consults the orphan registry.
  const providers = readFileSync(new URL('../src/lib/server/content/adult-providers.ts', import.meta.url), 'utf8');
  assert.match(providers, /getAdultOrphanAttribution\(attribution\.mediaType, attribution\.tmdbId\)/, 'the classifier consults the orphan attribution registry');
  assert.match(providers, /isAdultProviderHomepage\(attribution\.homepage\)/, 'the classifier consults the homepage-domain signal');
  assert.match(providers, /isAdultProviderOverview\(attribution\.overview\)/, 'the classifier consults the overview provider-context signal');
  ok('8. wiring: detail attribution evidence -> central classifier -> every surface (search, rails, detail, recommendations)');
}

console.log(`\nAdult orphan leak regression tests passed: ${passed} check groups.`);
