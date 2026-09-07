// ============================================================================
// Phase 3 behavioral tests — network-based TMDB catalog query construction
// (Adult Mode architecture rebuild; see Mavero_Adult_Mode_Rebuild_Worklog.md).
//
// REAL behavioral tests: they import the actual query-construction module
// (adult-catalog.ts) and the actual registry (adult-networks.ts) — the same
// modules the TMDB adapter uses — and assert the actual outputs. The adapter
// itself (adapters/tmdb.ts) imports $env/dynamic/private and cannot be
// imported under tsx; the wiring between the adapter and this module is
// therefore asserted statically in scripts/adult_mode_test.ts (sections E/F/
// G/S/X), while EVERYTHING about filter-value construction is asserted
// behaviorally here. Deterministic and credential-free.
//
// Covered scenarios (Phase 3 spec §14):
//   A. Normal TV catalog exclusion value/params include verified networks.
//   B. Adult catalog inclusion uses with_networks (all + selected service).
//   C. Values derive from the registry (registry change => value change).
//   D. Construction never emits watch-provider params (TV identity).
//   E. Construction is independent of Adult Mode / authorization.
//   F. Adult inclusion requires no JustWatch/flatrate/region prerequisites.
//   G. Unverified/claimed network IDs never reach a production filter value.
//   H. Empty verified registry produces NO malformed params ({}).
//   I. Construction never emits include_adult (normal rails keep false).
//   J. Anime catalog wiring stays free of adult network/provider filters.
// plus: real-registry value == "2902|4573|7355", key-based service lookup
// (verified keys resolve, unverified/unknown keys do not), deterministic
// sorted/deduped values for stable cache keys.
// ============================================================================

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  adultNetworkExclusionValue,
  withoutAdultNetworksParams,
  withAdultNetworksParams,
  getVerifiedAdultNetworkIdForKey,
  TMDB_NETWORK_OR_SEPARATOR
} from '../src/lib/server/content/adult-catalog.ts';
import {
  __setAdultNetworkRegistryForTest,
  __resetAdultNetworkRegistryForTest,
  getAdultNetworkIds
} from '../src/lib/server/content/adult-networks.ts';

const repoRoot = process.cwd();

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

// Deterministic test registry (same convention as the Phase 2 test).
const NET_A = { key: 'veritas-adult', name: 'Veritas Adult', tmdbNetworkId: 990002, verification: 'verified' as const };
const NET_B = { key: 'veritas-two', name: 'Veritas Two', tmdbNetworkId: 990001, verification: 'verified' as const };
const NET_UNVERIFIED_CLAIMED = { key: 'mystery-adult', name: 'Mystery Adult Net', tmdbNetworkId: 424242, verification: 'unverified' as const };

// ---------------------------------------------------------------------------
console.log('# Scenario block: deterministic registry override');
__setAdultNetworkRegistryForTest([NET_A, NET_B, NET_UNVERIFIED_CLAIMED]);

try {
  // --- A. Normal TV catalog exclusion ---------------------------------------
  const exclusionValue = adultNetworkExclusionValue();
  assert.equal(exclusionValue, '990001|990002', 'exclusion value is pipe-joined verified ids (sorted, deduped)');
  const exclusionParams = withoutAdultNetworksParams();
  assert.deepEqual(exclusionParams, { without_networks: '990001|990002' }, 'normal TV exclusion params carry without_networks');
  ok('A. normal TV catalog exclusion = without_networks with verified ids');

  // --- B. Adult catalog inclusion -------------------------------------------
  assert.deepEqual(withAdultNetworksParams(), { with_networks: '990001|990002' }, 'adult inclusion covers all verified networks');
  assert.deepEqual(withAdultNetworksParams(990001), { with_networks: '990001' }, 'adult inclusion narrows to a selected verified network');
  ok('B. adult catalog uses with_networks (all networks + per-service narrowing)');

  // --- C. Values derive from the registry -----------------------------------
  const before = adultNetworkExclusionValue();
  __setAdultNetworkRegistryForTest([{ key: 'solo', name: 'Solo Net', tmdbNetworkId: 7777, verification: 'verified' as const }]);
  assert.equal(adultNetworkExclusionValue(), '7777', 'value follows registry changes (registry is the single source)');
  __setAdultNetworkRegistryForTest([NET_A, NET_B, NET_UNVERIFIED_CLAIMED]);
  assert.equal(adultNetworkExclusionValue(), before, 'value restores with the registry');
  ok('C. filter values are sourced live from the registry');

  // --- D. No watch-provider params in network construction ------------------
  for (const fragment of [withoutAdultNetworksParams(), withAdultNetworksParams(), withAdultNetworksParams(990001)]) {
    const keys = Object.keys(fragment);
    assert.ok(keys.every((k) => k === 'with_networks' || k === 'without_networks'), `only network keys emitted, got: ${keys.join(',')}`);
  }
  assert.equal(TMDB_NETWORK_OR_SEPARATOR, '|', 'OR separator matches the codebase pipe convention');
  // The emitted values are exactly the registry's NETWORK ids — never a
  // provider-id list (no provider id space exists in this module at all).
  assert.deepEqual(
    (adultNetworkExclusionValue() as string).split('|').map(Number).sort((a, b) => a - b),
    getAdultNetworkIds().sort((a, b) => a - b),
    'emitted ids are exactly the registry network ids'
  );
  ok('D. construction never emits watch-provider params (network ids only)');

  // --- E. Independent of Adult Mode / authorization -------------------------
  // The functions take no authorization input (arity guard) and repeated
  // evaluation is deterministic — Adult Mode ON/OFF cannot change them.
  assert.equal(adultNetworkExclusionValue.length, 0, 'exclusion value takes no auth/mode parameter');
  assert.equal(withoutAdultNetworksParams.length, 0, 'exclusion params take no auth/mode parameter');
  assert.deepEqual(withAdultNetworksParams(990001), withAdultNetworksParams(990001), 'deterministic across calls');
  ok('E. construction is independent of Adult Mode / authorization state');

  // --- F. No JustWatch/flatrate prerequisites in adult inclusion ------------
  const inclusion = withAdultNetworksParams();
  assert.ok(!('watch_region' in inclusion), 'no watch_region prerequisite');
  assert.ok(!('with_watch_monetization_types' in inclusion), 'no flatrate prerequisite');
  assert.ok(!('with_watch_providers' in inclusion), 'no watch-provider prerequisite');
  ok('F. adult network inclusion requires no JustWatch/flatrate availability');

  // --- G. Unverified/claimed ids never reach production values --------------
  // NET_UNVERIFIED_CLAIMED carries a nonzero claimed id (424242) — exactly
  // the "guessed id" shape that must never become a production filter.
  assert.equal(getAdultNetworkIds().includes(424242), false, 'claimed unverified id excluded from production ids');
  assert.equal(adultNetworkExclusionValue()?.includes('424242'), false, 'claimed unverified id absent from filter value');
  assert.deepEqual(withAdultNetworksParams(424242), {}, 'unverified selected id produces NO filter');
  ok('G. unverified/claimed network ids never reach production filters');

  // --- H. Empty registry -> no malformed params ------------------------------
  __setAdultNetworkRegistryForTest([]);
  assert.equal(adultNetworkExclusionValue(), undefined, 'empty registry -> undefined value');
  assert.deepEqual(withoutAdultNetworksParams(), {}, 'empty registry -> no without_networks param at all');
  assert.deepEqual(withAdultNetworksParams(), {}, 'empty registry -> no with_networks param at all');
  ok('H. empty verified registry produces no malformed TMDB params');

  __setAdultNetworkRegistryForTest([NET_A, NET_B, NET_UNVERIFIED_CLAIMED]);

  // --- I. Construction never touches include_adult ---------------------------
  // include_adult is a caller concern: normal rails keep false, the adult
  // rail sets true behind its own authorization. The construction layer
  // emits neither.
  assert.ok(!('include_adult' in withoutAdultNetworksParams()), 'exclusion fragment has no include_adult');
  assert.ok(!('include_adult' in withAdultNetworksParams()), 'inclusion fragment has no include_adult');
  ok('I. construction never emits include_adult (normal rails keep false)');

  // --- K. Service key -> verified network id --------------------------------
  assert.equal(getVerifiedAdultNetworkIdForKey('veritas-adult'), 990002, 'verified key resolves to its network id');
  assert.equal(getVerifiedAdultNetworkIdForKey('mystery-adult'), undefined, 'unverified service key resolves to nothing');
  assert.equal(getVerifiedAdultNetworkIdForKey('netflix'), undefined, 'unknown key resolves to nothing');
  assert.equal(getVerifiedAdultNetworkIdForKey(undefined), undefined, 'no key -> no filter narrowing');
  ok('K. key-based service lookup is verified-only');

  __resetAdultNetworkRegistryForTest();

  // ---------------------------------------------------------------------------
  console.log('# Real registry block: shipped configuration');
  {
    assert.equal(adultNetworkExclusionValue(), '2902|4573|7355', 'real registry value is exactly the verified Ullu/Kooku/Atrangii set');
    assert.deepEqual(withoutAdultNetworksParams(), { without_networks: '2902|4573|7355' }, 'real normal-TV exclusion params');
    assert.deepEqual(withAdultNetworksParams(), { with_networks: '2902|4573|7355' }, 'real adult-rail inclusion params');
    assert.equal(getVerifiedAdultNetworkIdForKey('ullu'), 2902, 'ullu key -> verified network 2902');
    assert.equal(getVerifiedAdultNetworkIdForKey('kooku'), 4573, 'kooku key -> verified network 4573');
    assert.equal(getVerifiedAdultNetworkIdForKey('atrangii'), 7355, 'atrangii key -> verified network 7355');
    assert.equal(getVerifiedAdultNetworkIdForKey('altt'), undefined, 'altt (unverified network) resolves to nothing');
    passed++;
    console.log(`  ok ${passed} - real registry values (2902|4573|7355; verified key lookup; ALTT inert)`);

    // No literal network ids outside the registry module (single source of
    // truth): the bridge module and the adapter must not hardcode them.
    const bridge = await readFile(path.join(repoRoot, 'src/lib/server/content/adult-catalog.ts'), 'utf8');
    assert.doesNotMatch(bridge, /\b(2902|4573|7355)\b/, 'adult-catalog.ts contains no hardcoded network ids');
    const adapter = await readFile(path.join(repoRoot, 'src/lib/server/content/adapters/tmdb.ts'), 'utf8');
    assert.doesNotMatch(adapter, /\b(2902|4573|7355)\b/, 'tmdb.ts contains no hardcoded network ids');
    passed++;
    console.log(`  ok ${passed} - no hardcoded network ids outside the registry module`);
  }

  // ---------------------------------------------------------------------------
  console.log('# Wiring block: adapter-level invariants (source-level, complementary)');
  {
    // J. Anime catalog remains free of adult filters (behavioral guarantee is
    // "anime queries unchanged"; the anime function builds its params inline
    // in the adapter, so this specific invariant is checked at source level
    // and re-asserted in adult_mode_test.ts sections L/V).
    const adapter = await readFile(path.join(repoRoot, 'src/lib/server/content/adapters/tmdb.ts'), 'utf8');
    const animeFn = adapter.match(/export async function getTmdbAnimeMerged[\s\S]*?^}/m);
    assert.ok(animeFn, 'getTmdbAnimeMerged found');
    assert.doesNotMatch(animeFn![0], /without_networks|with_networks|without_watch_providers|with_watch_providers/, 'anime queries carry NO adult filters (networks or providers)');
    assert.match(animeFn![0], /include_adult: false/, 'anime keeps include_adult: false');
    ok('J. anime catalog behavior unchanged (no adult network/provider filters)');

    // TV branches of the migrated rails use the network exclusion; movie
    // branches keep the transitional provider exclusion (documented).
    const collectionFn = adapter.match(/export async function getTmdbCollection[\s\S]*?^}/m);
    assert.ok(collectionFn && collectionFn[0].includes('without_networks: networkExclusion'), 'collection TV branch excludes adult networks');
    assert.ok(collectionFn && collectionFn[0].includes("'without_watch_providers': providerExclusion"), 'collection movie branch keeps transitional provider exclusion');
    const popularFn = adapter.match(/export async function getTmdbPopularByLanguage[\s\S]*?^}/m);
    assert.ok(popularFn && popularFn[0].includes('without_networks: networkExclusion'), 'popular TV branch excludes adult networks');
    const topRatedFn = adapter.match(/export async function getTmdbTopRated[\s\S]*?^}/m);
    assert.ok(topRatedFn && topRatedFn[0].includes('without_networks: networkExclusion'), 'top-rated TV branch excludes adult networks');
    const newOttFn = adapter.match(/export async function getTmdbNewOnOtt[\s\S]*?^}/m);
    assert.ok(newOttFn && newOttFn[0].includes('without_networks: networkExclusion'), 'new-ott TV branch excludes adult networks');
    // Adult rail: TV = with_networks; movie half = transitional with_watch_providers.
    const adultFn = adapter.match(/export async function getTmdbAdultShows[\s\S]*?^}/m);
    assert.ok(adultFn && adultFn[0].includes('...networkInclusion'), 'adult rail TV params spread the network inclusion');
    assert.ok(adultFn && adultFn[0].includes('with_watch_providers: watchProviders'), 'adult rail movie half keeps the documented transitional provider query');
    // The adult TV params block must not contain provider/region/flatrate prerequisites.
    const tvParamsBlock = adultFn![0].match(/const tvParams[\s\S]*?};/m)?.[0] ?? '';
    assert.ok(tvParamsBlock.length > 0, 'adult rail tvParams block found');
    assert.doesNotMatch(tvParamsBlock, /with_watch_providers|watch_region|with_watch_monetization_types/, 'adult TV query has NO JustWatch prerequisites');
    assert.match(tvParamsBlock, /include_adult: true/, 'adult TV query keeps include_adult: true');
    passed++;
    console.log(`  ok ${passed} - adapter wiring: TV=networks, movies=transitional providers, adult rail split verified`);
  }

  console.log(`Adult catalog network tests passed (${passed} checks): network exclusion/inclusion construction, registry-sourced verified ids, unverified-id safety, empty-registry safety, no JustWatch prerequisites, authorization independence, anime invariance, adapter wiring.`);
  process.exit(0);
} catch (error) {
  __resetAdultNetworkRegistryForTest();
  console.error('Adult catalog network tests FAILED:', error);
  process.exit(1);
}
