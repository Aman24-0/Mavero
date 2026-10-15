/**
 * Test-environment stub for SvelteKit's `$env/dynamic/public` virtual
 * module — see dynamic-private.ts for the rationale. Only variables
 * with the PUBLIC_ prefix are exposed, matching the real module's
 * contract (public env must never leak server secrets).
 */
export const env: { [key: `PUBLIC_${string}`]: string | undefined } = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith('PUBLIC_'))
);
