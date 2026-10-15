/**
 * Test-environment stub for SvelteKit's `$app/navigation` virtual module
 * (see dynamic-private.ts for the rationale). The navigation functions
 * only make sense inside a running SvelteKit app; tests that transitively
 * import them get inert no-ops.
 */
export function goto() { return Promise.resolve(); }
export function invalidate() { return Promise.resolve(); }
export function invalidateAll() { return Promise.resolve(); }
export function preloadData() { return Promise.resolve({ type: 'data', data: {} }); }
export function preloadCode() { return Promise.resolve(); }
export function beforeNavigate() {}
export function afterNavigate() {}
export function onNavigate() { return Promise.resolve(); }
