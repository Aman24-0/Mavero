/**
 * Test stub for SvelteKit's virtual module `$app/environment`.
 * Only used when running behavioral tests OUTSIDE the SvelteKit runtime
 * (tsx with tsconfig.behavioral.json). Both flags are false in a hermetic
 * server-side test run — exactly what the server modules under test expect
 * (they branch on `dev` for dev-only behaviour and `browser` for client-only
 * behaviour; neither must ever be truthy under tsx).
 */
export const dev: boolean = false;
export const browser: boolean = false;
export const building: boolean = false;
export const version: string = 'test-stub';
