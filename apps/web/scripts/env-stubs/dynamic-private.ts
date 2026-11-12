/**
 * Test-environment stub for SvelteKit's `$env/dynamic/private` virtual
 * module (2026-10-15).
 *
 * WHY THIS EXISTS: the repo's test chain runs suites with plain `tsx`,
 * which cannot resolve SvelteKit's VIRTUAL modules (`$env/*`). Any test
 * that imports a server module whose import chain reaches a config file
 * reading `$env/dynamic/private` (vidara/config, abyss/config,
 * extensions/builder, content adapters, …) crashed with
 * `ERR_MODULE_NOT_FOUND: Cannot find package '$env'` — including the
 * abyss inventory regression and the cloudstream Phase 4 manager suite,
 * which had been failing since they were introduced.
 *
 * MAPPING: `jsconfig.json` maps `$env/dynamic/private` to THIS file for
 * non-SvelteKit (tsx) resolution. SvelteKit's own build/check pipeline
 * resolves the virtual module FIRST, so production code is unaffected;
 * the ambient declarations in `.svelte-kit/ambient.d.ts` provide the
 * same index-signature shape (`[key: ${string}]: string | undefined`)
 * for type-checking, so svelte-check behavior is unchanged.
 *
 * RUNTIME SEMANTICS: mirror `process.env` (read at import time). Tests
 * that need credentials inject them via process.env; a missing variable
 * reads as undefined — exactly the dev-without-credentials behavior the
 * fail-closed config getters expect (getVidaraConfigOrNull → null).
 *
 * MOCKED-PIPELINE TESTS (upcoming_test §19, upcoming_chronological,
 * upcoming_stream_identity): those suites execute the REAL
 * src/lib/server/content/upcoming.ts pipeline in-process with a
 * deterministic fetch mock and inject a fake TMDB token through
 * `globalThis.__MAVERO_UPCOMING_TEST_ENV__` (set BEFORE import, read at
 * import time — same snapshot semantics). They originally delivered it
 * via a node:module hook that maps the specifier to
 * scripts/upcoming_test_env_shim.mjs, but under tsx the jsconfig paths
 * mapping resolves the specifier HERE first, so the injection is merged
 * into this stub too. The merge is test-only: production never resolves
 * $env/dynamic/private to this file (SvelteKit's virtual module wins).
 */
export const env: { [key: string]: string | undefined } = {
  ...process.env,
  ...(globalThis as { __MAVERO_UPCOMING_TEST_ENV__?: Record<string, string> }).__MAVERO_UPCOMING_TEST_ENV__,
};
