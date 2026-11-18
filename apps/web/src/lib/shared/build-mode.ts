/**
 * Compile-time build-target flag.
 *
 * `VITE_BUILD_TARGET` is statically defined ONLY in the widget build
 * (vite.config.ts sets it when BUILD_TARGET=wgt; .github/workflows/
 * build-wgt.yml owns that pipeline). The production Netlify/SSR build and
 * plain `vite dev` never set it, so `IS_WGT_BUILD` is false there — the
 * bundler dead-code-eliminates every `IS_WGT_BUILD` guard in production,
 * and production behaviour is provably unchanged.
 *
 * Use it for TV/widget-only behaviour: e.g. the DevTools-protection
 * detector is a web-app anti-inspection measure that has no meaning
 * inside a Tizen widget (no devtools, false-positive risk, wasted work).
 */
export const IS_WGT_BUILD =
  typeof import.meta.env === 'object' &&
  import.meta.env !== null &&
  import.meta.env.VITE_BUILD_TARGET === 'wgt';
