/**
 * Shim for `$env/dynamic/private` in the standalone executor bundle
 * (see scripts/build_executor_function.mjs). In the SvelteKit app this
 * module is provided by the framework; in the bundled Netlify background
 * function the runtime env is plain process.env (Netlify injects the
 * site's environment variables into every function).
 */

export const env = process.env as Record<string, string | undefined>;
