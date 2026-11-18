/**
 * TV API base — the SINGLE config constant every TV fetch is built from.
 *
 * The .wgt runs from a file:// origin (no server): all API calls go
 * cross-origin to the DEPLOYED production deployment. Overridable at build
 * time with TV_API_BASE (vite.config.ts defines it into the wgt bundle as
 * `import.meta.env.VITE_TV_API_BASE`); defaults to production.
 *
 * WIDGET BUILD ONLY — production never references this module's value at
 * runtime (every consumer is behind an IS_WGT_BUILD guard; on the web the
 * app keeps fetching its same-origin /api/... paths).
 */
export const TV_API_BASE: string = (
  (import.meta.env.VITE_TV_API_BASE as string | undefined) ?? 'https://maveroweb.space'
).replace(/\/+$/, '');
