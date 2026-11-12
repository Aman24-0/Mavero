/**
 * Test stub for the SvelteKit virtual module `$env/dynamic/private`.
 * Only used when running behavioral tests OUTSIDE the SvelteKit runtime
 * (tsx). The real module is server-only; this stub provides an empty env
 * so config resolvers see "not configured" (null configs) — exactly what
 * the services under test expect in a hermetic run.
 */
export const env: Record<string, string | undefined> = {};
