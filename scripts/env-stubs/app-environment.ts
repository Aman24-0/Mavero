/**
 * Test-environment stub for SvelteKit's `$app/environment` virtual module
 * (see dynamic-private.ts for the rationale — tsx cannot resolve
 * SvelteKit's virtual `$app/*` modules).
 *
 * The real module's `dev` flag is baked at build time; in plain `tsx`
 * runs the PRODUCTION posture (dev=false) is what server code (e.g.
 * content/adult-policy.ts's secure-cookie flag) should assume in tests.
 */
export const browser = false;
export const dev = false;
export const building = false;
export const version = '';
