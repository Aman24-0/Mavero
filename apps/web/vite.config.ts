import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

// BUILD_TARGET=wgt — the Tizen .wgt static-SPA build (see svelte.config.js).
// Exposes the target to client code as a COMPILE-TIME constant so wgt-only
// branches (e.g. skipping the DevTools-protection detector) are dead-code-
// eliminated from the production bundle. The Netlify build never sets
// BUILD_TARGET, so production behaviour is unchanged.
const isWgtBuild = process.env.BUILD_TARGET === 'wgt';

// BUILD_TARGET=wgt — CLASSIC (non-module) BUNDLE OUTPUT.
//
// The Tizen web engine refuses to execute ES modules from the widget's
// file:// origin (origin "null"): static `type="module"` scripts, dynamic
// import() and modulepreload links are all blocked (confirmed ON the TV via
// the boot-diagnostics overlay — the chunk files exist but are refused).
// The earlier PoC proved plain classic scripts load fine from file://.
//
// With kit.output.bundleStrategy='single' (svelte.config.js) SvelteKit
// already collapses the client build to ONE entry chunk with
// inlineDynamicImports — but it still emits it as an ES module. This plugin
// runs its `config` hook AFTER SvelteKit's (plugin order: declared after
// sveltekit(); SvelteKit's hook is order:'pre') and overrides exactly the
// output keys that matter, so `vite build` emits ONE classic IIFE file:
//
//   - format 'iife'      — classic script: no import()/import.meta in the
//                          output, executable via <script src> (PoC-proven
//                          on this TV).
//   - entryFileNames     — 'app.js' at the client output root = the widget
//                          root after adapter-static copies it out.
//   - name               — IIFE global for the bundle's exports
//                          (kit.start is invoked through it by the classic
//                          boot script injected by scripts/wgt_patch_shell.mjs).
//   - inlineDynamicImports — explicit belt-and-braces: every route node,
//                          lazy Shaka chunk and env module is inlined into
//                          app.js; there are no other chunks to fetch.
//
// kit's chunkFileNames/assetFileNames stay in effect (the merged single CSS
// asset keeps its _app/immutable/assets/… path, which
// scripts/wgt_patch_shell.mjs rewrites to relative).
//
// The Netlify build (BUILD_TARGET unset) never adds this plugin —
// production output is byte-for-byte unchanged (verified by hashing the
// full .svelte-kit/output + .netlify + netlify/functions trees before and
// after this change).
const wgtClassicBundlePlugin: Plugin = {
  name: 'mavero-wgt-classic-bundle',
  config(config) {
    // `vite build` runs the SSR build FIRST (SvelteKit treats the CLI
    // invocation as the server build and then kicks off the client build
    // itself from its writeBundle hook, re-running every config hook with
    // build.ssr=false). The server build has MANY inputs (one per endpoint
    // / node / hook) and must keep SvelteKit's ESM output — overriding its
    // output here would fail with "multiple inputs are not supported when
    // output.inlineDynamicImports is true". Kit's setup plugin (order:
    // 'pre') has already resolved build.ssr by the time this hook runs, so
    // this check scopes the IIFE override to the client build only.
    if (config.build?.ssr) return;
    return {
      build: {
        // cssCodeSplit must be OFF for the single classic bundle: Vite 7
        // emits NO css assets at all when cssCodeSplit=true meets
        // inlineDynamicImports (the per-dynamic-chunk css extraction finds
        // no async chunks — observed empirically: the client build emitted
        // app.js with zero .css files, so the TV would boot an unstyled
        // app). cssCodeSplit:false emits ONE merged stylesheet asset (the
        // same mechanism kit's own 'inline' bundleStrategy relies on);
        // scripts/wgt_patch_shell.mjs links it into the shell.
        cssCodeSplit: false,
        rollupOptions: {
          output: {
            format: 'iife',
            inlineDynamicImports: true,
            entryFileNames: 'app.js',
            name: '__mavero_wgt_app'
          }
        }
      }
    };
  }
};

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(), ...(isWgtBuild ? [wgtClassicBundlePlugin] : [])],
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
