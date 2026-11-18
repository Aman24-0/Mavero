import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// BUILD_TARGET=wgt — the Tizen .wgt static-SPA build (see svelte.config.js).
// Exposes the target to client code as a COMPILE-TIME constant so wgt-only
// branches (e.g. skipping the DevTools-protection detector) are dead-code-
// eliminated from the production bundle. The Netlify build never sets
// BUILD_TARGET, so production behaviour is unchanged.
const isWgtBuild = process.env.BUILD_TARGET === 'wgt';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  define: isWgtBuild
    ? { 'import.meta.env.VITE_BUILD_TARGET': JSON.stringify('wgt') }
    : undefined,
  build: {
    // R-5: Shaka Player (the DASH/HLS engine) is ~820 kB minified and is
    // already dynamically imported (lazy-loaded only when the user visits
    // the Live TV page). It cannot be meaningfully reduced. The limit is
    // set to 900 kB so the justified Shaka chunk doesn't trigger a warning
    // while still catching genuinely unexpected large chunks.
    chunkSizeWarningLimit: 900,
    // BUILD_TARGET=wgt — Tizen 6.0 (Samsung UA43AUE60AKLXL) ships a
    // Chromium 69–76-era web engine. The default Vite client target emits
    // ES2020+ syntax (optional chaining `?.`, nullish coalescing `??`,
    // class static blocks) which is a hard SyntaxError there: the entry
    // chunk dies before the app boots and the TV shows a blank grey
    // screen. es2019 makes esbuild downlevel all of it. Production
    // (BUILD_TARGET unset) keeps the default target — kit resolves its
    // own client target and 'node18.13' for the SSR build.
    ...(isWgtBuild ? { target: 'es2019' } : {})
  }
});
