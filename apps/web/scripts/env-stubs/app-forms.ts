/**
 * Test-environment stub for SvelteKit's `$app/forms` virtual module —
 * see dynamic-private.ts for the rationale.
 */
export function enhance() { return () => {}; }
export function applyAction() { return Promise.resolve(); }
export function deserialize() { return { type: 'success', data: {} }; }
