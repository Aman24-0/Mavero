// Test shim for the SvelteKit virtual module `$env/dynamic/private`
// (see scripts/upcoming_test_hooks.mjs). The env object is supplied by
// the test through globalThis.__MAVERO_UPCOMING_TEST_ENV__ BEFORE the
// pipeline module graph is imported, so no real credential is needed
// and no real network call can succeed silently.
export const env = globalThis.__MAVERO_UPCOMING_TEST_ENV__ ?? {};
