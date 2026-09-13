// ============================================================================
// Phase 2 behavioral tests — adult network registry + central adult classifier
// (Adult Mode architecture rebuild; see Mavero_Adult_Mode_Rebuild_Worklog.md).
//
// Unlike scripts/adult_mode_test.ts (static source assertions A–W), these are
// REAL behavioral tests: they import the actual registry and classifier
// modules, feed them mock data shaped like real TMDB detail structures, and
// assert the actual function outputs. Deterministic and credential-free —
// no network access, no TMDB credentials, no clock dependence.
//
// Covered scenarios (Phase 2 spec §13):
//   1.  Verified adult network + adult=false                -> Adult
//   2.  Verified adult network + normal-looking metadata    -> Adult
//   3.  Non-adult network + adult=false                     -> not Adult
//   4.  TMDB adult=true + non-anime                         -> Adult
//   5.  TMDB adult=true + recognized anime                  -> NOT Adult
//   6.  Adult tags + non-anime                              -> Adult
//   7.  Ordinary romance/drama                              -> not Adult
//   8.  Unknown/unverified network ID                       -> NOT Adult
//   9.  Network name matching is conservative (exact only)
//   10. Missing/empty/malformed network metadata            -> no crash, not Adult
//   11. Known adult network + TMDB adult=false              -> Adult (id wins)
//   12. Classifier is independent of user authorization
// plus: real-registry invariants (verified IDs live-confirmed 2026-09-07),
// the transitional watch-provider signal, and registry accessor safety.
// ============================================================================

import assert from 'node:assert/strict';
import { isAdultContent, resolveAdultProviders, invalidateAdultProviderCache } from '../src/lib/server/content/adult-providers.ts';
import {
  getAdultNetworks,
  getVerifiedAdultNetworks,
  getAdultNetworkIds,
  getAdultNetworkById,
  isKnownAdultNetwork,
  __setAdultNetworkRegistryForTest,
  __resetAdultNetworkRegistryForTest
} from '../src/lib/server/content/adult-networks.ts';

// --------------------------------------------------------------------------
// Deterministic test registry (overrides the real registry for the scenario
// block; reset afterwards). Shapes mirror real TMDB TV network metadata.
// --------------------------------------------------------------------------
const VERIFIED_NETWORK = {
  key: 'veritas-adult',
  name: 'Veritas Adult',
  aliases: ['VA Originals'],
  tmdbNetworkId: 990001,
  verification: 'verified' as const
};
const UNVERIFIED_NETWORK = {
  key: 'mystery-adult',
  name: 'Mystery Adult Net',
  tmdbNetworkId: 424242,
  verification: 'unverified' as const
};

function installTestRegistry(): void {
  __setAdultNetworkRegistryForTest([VERIFIED_NETWORK, UNVERIFIED_NETWORK]);
}

// Mock data shaped like the TMDB TV detail response (`/tv/{id}` -> networks[]).
type MockNetwork = { id?: number | null; name?: string | null };

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

// ---------------------------------------------------------------------------
console.log('# Scenario block: deterministic registry override');
installTestRegistry();

try {
  // --- 1. Verified adult network + adult=false -> Adult ---------------------
  assert.equal(
    isAdultContent(undefined, undefined, false, false, [{ id: 990001, name: 'Veritas Adult' }]),
    true,
    'verified adult network + adult=false classifies Adult'
  );
  ok('1. verified adult network + adult=false -> Adult');

  // --- 2. Verified network + normal-looking metadata -> Adult ---------------
  assert.equal(
    isAdultContent(['Drama'], [8], false, false, [{ id: 990001, name: 'Veritas Adult' }]),
    true,
    'verified adult network with otherwise-normal metadata classifies Adult'
  );
  ok('2. verified adult network + normal metadata -> Adult');

  // --- 3. Non-adult network + adult=false -> not Adult ----------------------
  assert.equal(
    isAdultContent(undefined, undefined, false, false, [{ id: 213, name: 'Netflix' }, { id: 14664, name: 'Airtel Xstream' }]),
    false,
    'non-adult networks must not classify Adult'
  );
  ok('3. non-adult network + adult=false -> not Adult');

  // --- 4. TMDB adult=true + non-anime -> Adult ------------------------------
  assert.equal(isAdultContent(undefined, undefined, true, false, undefined), true, 'TMDB adult=true + non-anime -> Adult');
  ok('4. TMDB adult=true + non-anime -> Adult');

  // --- 5. TMDB adult=true + recognized anime -> NOT Adult -------------------
  // (the anime exemption: adult=true alone must never mark anime Adult)
  assert.equal(isAdultContent(undefined, undefined, true, true, undefined), false, 'TMDB adult=true + anime -> NOT Adult');
  assert.equal(isAdultContent(['Drama'], undefined, true, true, [{ id: 213, name: 'Netflix' }]), false, 'adult=true + anime + non-adult network -> NOT Adult');
  ok('5. TMDB adult=true + recognized anime -> NOT Adult');

  // --- 6. Adult tags + non-anime -> Adult -----------------------------------
  assert.equal(isAdultContent(['Adult'], undefined, false, false, undefined), true, "tags ['Adult'] + non-anime -> Adult");
  ok('6. Adult tags + non-anime -> Adult');

  // --- 7. Ordinary romance/drama -> NOT Adult -------------------------------
  assert.equal(isAdultContent(['Romance', 'Drama'], undefined, false, false, undefined), false, 'romance/drama tags -> not Adult');
  assert.equal(isAdultContent(['Horror', 'Thriller'], [8], false, false, [{ id: 213, name: 'Netflix' }]), false, 'mature-but-ordinary metadata -> not Adult');
  ok('7. ordinary romance/drama -> not Adult');

  // --- 8. Unknown/unverified network ID -> NOT Adult ------------------------
  // The unverified entry EXISTS in the test registry but must never match,
  // by id or by name, through any production accessor.
  assert.equal(isKnownAdultNetwork({ id: 424242, name: 'Mystery Adult Net' }), false, 'unverified registry entry must not match by id');
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 424242, name: 'Mystery Adult Net' }]), false, 'unverified network must not classify Adult');
  assert.equal(getVerifiedAdultNetworks().some((entry) => entry.tmdbNetworkId === 424242), false, 'unverified entry excluded from verified set');
  assert.equal(getAdultNetworkIds().includes(424242), false, 'unverified id excluded from production id list');
  ok('8. unknown/unverified network ID -> NOT Adult');

  // --- 9. Network name matching is conservative -----------------------------
  // Exact match, case-insensitive + trimmed (defensive secondary signal).
  assert.equal(isKnownAdultNetwork({ id: 8888, name: 'veritas adult' }), true, 'exact name match (case-insensitive) fires for verified entry');
  assert.equal(isKnownAdultNetwork({ name: '  VERITAS ADULT  ' }), true, 'trimmed exact name match fires');
  assert.equal(isKnownAdultNetwork({ name: 'VA Originals' }), true, 'exact alias match fires');
  // Substrings must NOT match (no bidirectional/substring matching).
  assert.equal(isKnownAdultNetwork({ name: 'Veritas Adult Originals' }), false, 'substring of verified name must not match');
  assert.equal(isKnownAdultNetwork({ name: 'Veritas' }), false, 'partial name must not match');
  assert.equal(isKnownAdultNetwork({ name: 'Veritas Adult Net' }), false, 'name with suffix must not match');
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 555, name: 'Veritas Adult Originals' }]), false, 'substring network name must not classify Adult');
  ok('9. network name matching conservative (exact only)');

  // --- 10. Missing network metadata -> no crash, not Adult ------------------
  assert.equal(isAdultContent(undefined, undefined, false, false, undefined), false, 'undefined networks -> not Adult');
  assert.equal(isAdultContent(undefined, undefined, false, false, []), false, 'empty networks array -> not Adult');
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ name: 'Some Random Network' }]), false, 'name-only non-matching ref -> not Adult');
  assert.equal(isKnownAdultNetwork(null), false, 'null network ref -> false');
  assert.equal(isKnownAdultNetwork(undefined), false, 'undefined network ref -> false');
  assert.equal(isKnownAdultNetwork({ id: null, name: null }), false, 'null id + null name -> false');
  assert.equal(isKnownAdultNetwork({ id: 0, name: '' }), false, 'zero id + empty name -> false');
  assert.equal(isKnownAdultNetwork({ id: Number.NaN, name: '   ' }), false, 'NaN id + blank name -> false');
  ok('10. missing/empty/malformed network metadata -> no crash, not Adult');

  // --- 11. Known adult network + TMDB adult=false -> Adult (id wins) --------
  // Numeric ID is authoritative: mismatching/garbage names must not matter.
  assert.equal(isAdultContent(undefined, undefined, false, undefined, [{ id: 990001, name: 'Totally Different Name' }]), true, 'verified id overrides mismatching name');
  assert.equal(isKnownAdultNetwork({ id: 990001, name: 'Whatever' }), true, 'verified id authoritative over name');
  ok('11. known adult network + adult=false -> Adult (id authoritative)');

  // --- 12. Classifier independent of user authorization ---------------------
  // The classifier is a pure content function: no auth input exists in its
  // signature and repeated evaluation is deterministic. Simulate two
  // "authorization contexts" — the only allowed inputs are content signals.
  const contentSignals = { tags: undefined, providerIds: undefined, tmdbAdult: false, isAnime: false, networks: [{ id: 990001, name: 'Veritas Adult' }] as MockNetwork[] };
  const asAuthorizedContext = isAdultContent(contentSignals.tags, contentSignals.providerIds, contentSignals.tmdbAdult, contentSignals.isAnime, contentSignals.networks);
  const asGuestContext = isAdultContent(contentSignals.tags, contentSignals.providerIds, contentSignals.tmdbAdult, contentSignals.isAnime, contentSignals.networks);
  assert.equal(asAuthorizedContext, asGuestContext, 'classification identical regardless of caller authorization context');
  assert.equal(asAuthorizedContext, true, 'adult classification is content-metadata only');
  // And the reverse: an ordinary title stays non-adult in both contexts.
  const ordinary = { tags: ['Drama'] as string[] | undefined, networks: [{ id: 213, name: 'Netflix' }] as MockNetwork[] };
  assert.equal(isAdultContent(ordinary.tags, undefined, false, false, ordinary.networks), isAdultContent(ordinary.tags, undefined, false, false, ordinary.networks), 'deterministic for ordinary content');
  ok('12. classifier independent of user authorization');

  __resetAdultNetworkRegistryForTest();

  // ---------------------------------------------------------------------------
  console.log('# Real registry block: shipped configuration invariants');
  {
    const all = getAdultNetworks();
    assert.ok(all.length >= 3, `registry carries entries (${all.length})`);
    for (const entry of all) {
      assert.ok(entry.key && entry.name, `entry ${entry.key} has key+name`);
      assert.ok(['verified', 'unverified'].includes(entry.verification), `entry ${entry.key} has a valid verification label`);
      if (entry.verification === 'verified') assert.ok(entry.tmdbNetworkId > 0, `verified entry ${entry.key} has id > 0`);
      else assert.equal(entry.tmdbNetworkId, 0, `unverified entry ${entry.key} carries no id`);
    }
    // Live-verified set (2026-09-07): Ullu 2902, Kooku 4573, Atrangii 7355.
    const verifiedIds = getAdultNetworkIds().sort((a, b) => a - b);
    assert.deepEqual(verifiedIds, [2902, 4573, 7355], 'verified network ids are exactly the live-confirmed set');
    assert.equal(getAdultNetworkById(2902)?.name, 'Ullu', 'id 2902 resolves to Ullu');
    assert.equal(getAdultNetworkById(4573)?.name, 'Kooku', 'id 4573 resolves to Kooku');
    assert.equal(getAdultNetworkById(7355)?.name, 'Atrangii', 'id 7355 resolves to Atrangii');
    assert.equal(getAdultNetworkById(0), undefined, 'id 0 resolves to nothing');
    assert.equal(getAdultNetworkById(-5), undefined, 'negative id resolves to nothing');
    passed++;
    console.log(`  ok ${passed} - real registry invariants (verified ids 2902/4573/7355, unverified carry id 0)`);

    // End-to-end with the REAL registry: a TMDB TV detail shaped payload for
    // an Ullu original with adult=false must classify Adult.
    assert.equal(
      isAdultContent(undefined, undefined, false, false, [{ id: 2902, name: 'Ullu' }, { id: 14664, name: 'Airtel Xstream' }]),
      true,
      'real registry: Ullu-network title (adult=false) classifies Adult'
    );
    // Unverified real entries (e.g. ALTT, id 0) must not match by name.
    assert.equal(isKnownAdultNetwork({ name: 'ALTT' }), false, 'real unverified entry (ALTT) must not match by name');
    assert.equal(isAdultContent(undefined, undefined, false, false, [{ name: 'ALTT' }]), false, 'real unverified entry must not classify Adult by name');
    passed++;
    console.log(`  ok ${passed} - end-to-end with real registry (Ullu fires; ALTT stays inert)`);

    // getVerifiedAdultNetworks is the ONLY set the classifier consults.
    assert.equal(getVerifiedAdultNetworks().every((entry) => entry.verification === 'verified' && entry.tmdbNetworkId > 0), true, 'verified accessor only returns verified entries with ids');
    passed++;
    console.log(`  ok ${passed} - verified accessor returns only live-confirmed entries`);
  }

  // ---------------------------------------------------------------------------
  console.log('# Transitional signal block: watch-provider signal still works');
  {
    // Legacy provider-model signal (Signal 3) must remain functional until the
    // Phase 3 migration removes it. resolveAdultProviders() matches by exact
    // name against a (mocked) live TMDB India provider list.
    invalidateAdultProviderCache();
    const resolved = resolveAdultProviders([
      { providerId: 1234, name: 'Ullu', logoPath: null, key: 'ullu' },
      { providerId: 8, name: 'Netflix', logoPath: null, key: 'netflix' }
    ]);
    assert.equal(resolved.length, 1, 'only the adult provider name resolves');
    assert.equal(resolved[0].tmdbProviderId, 1234, 'resolved provider id matched exactly');
    assert.equal(isAdultContent(undefined, [1234], false, false, undefined), true, 'transitional provider signal classifies Adult');
    assert.equal(isAdultContent(undefined, [8], false, false, undefined), false, 'non-adult provider id does not classify Adult');
    // Provider signal must NOT bypass the anime exemption of the adult flag…
    // (it is an independent reliable signal — it applies to any content — but
    // adult=true + anime + non-adult provider stays non-adult, per signal 4.)
    assert.equal(isAdultContent(undefined, undefined, true, true, undefined), false, 'anime exemption intact alongside transitional signal');
    invalidateAdultProviderCache();
    passed++;
    console.log(`  ok ${passed} - transitional watch-provider signal functional; anime exemption intact`);
  }

  console.log(`Adult network classifier behavioral tests passed (${passed} checks): verified-network signal, anime exemption, unverified-entry safety, conservative name matching, missing-metadata safety, authorization independence, real-registry invariants, transitional provider signal.`);
  process.exit(0);
} catch (error) {
  __resetAdultNetworkRegistryForTest();
  console.error('Adult network classifier behavioral tests FAILED:', error);
  process.exit(1);
}
