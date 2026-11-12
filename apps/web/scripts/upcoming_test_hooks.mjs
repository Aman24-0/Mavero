// Module-resolution hooks for the Phase F.2 Upcoming mocked pipeline
// tests (scripts/upcoming_test.ts section 19).
//
// The real Upcoming pipeline (`src/lib/server/content/upcoming.ts`) runs
// on the SvelteKit server and imports `$env/dynamic/private`, a SvelteKit
// VIRTUAL module that does not exist outside `vite dev/build`. These
// hooks let plain tsx execute the REAL pipeline in-process by mapping
// that one specifier to a local test shim fed through globalThis.
// Nothing else is intercepted — every other module (including `$lib/*`
// aliases) resolves through the normal tsx/tsconfig path.
export async function resolve(specifier, context, next) {
  if (specifier === '$env/dynamic/private') {
    return { url: new URL('./upcoming_test_env_shim.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
