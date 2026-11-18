import adapter from '@sveltejs/adapter-netlify';
import adapterStatic from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// ============================================================================
// BUILD_TARGET=wgt — Tizen .wgt static-SPA build (TV app packaging).
//
// The production web app is SSR (adapter-netlify) and MUST stay exactly as
// it is. The Tizen .wgt, however, is a static ZIP with no server, so the
// TV packaging pipeline (.github/workflows/build-wgt.yml) builds the app
// with BUILD_TARGET=wgt and gets a pure static SPA:
//
//   - @sveltejs/adapter-static with fallback 'index.html' — every route
//     serves the SPA shell and SvelteKit's client router renders it.
//   - prerender stays OFF (no route opt-ins exist) — nothing is executed
//     at build time and no server-only data leaks into the widget.
//   - strict: false — the SPA intentionally keeps its dynamic routes
//     (all served through the fallback), and +server.ts API endpoints are
//     deliberately NOT emitted: the widget calls the deployed production
//     API (https://maveroweb.space/api/…) cross-origin instead.
//
// The Netlify build (BUILD_TARGET unset) never enters this branch — the
// production adapter, its output and its semantics are unchanged.
// Route-level server modules are additionally stashed away by
// scripts/wgt_spa_prepare.mjs during the wgt build (see that file for
// why the stash is required on top of adapter-static).
// ============================================================================

const isWgtBuild = process.env.BUILD_TARGET === 'wgt';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: isWgtBuild
      ? adapterStatic({
          // SPA fallback: every unknown route serves this shell, and the
          // client router takes over (TV D-pad navigation = SPA routes).
          fallback: 'index.html',
          // The widget intentionally keeps dynamic routes behind the
          // fallback and drops +server.ts endpoints; skip the
          // "everything prerendered" audit of this adapter branch only.
          strict: false
        })
      : adapter(),
    // BUILD_TARGET=wgt — RELATIVE asset URLs. The widget is opened from a
    // file:// origin, where an absolute "/_app/…" asset URL resolves
    // against the FILESYSTEM ROOT (not the widget directory): every
    // stylesheet/module request 404s and the TV shows a blank grey
    // screen. Ask SvelteKit to emit relative URLs for everything it
    // controls. NOTE: the adapter-static FALLBACK shell still emits
    // absolute links + absolute dynamic import specifiers — those are
    // rewritten at pack time by scripts/wgt_patch_shell.mjs, and
    // build-wgt.yml asserts the packed shell contains no "/_app/
    // references.
    ...(isWgtBuild ? { paths: { relative: true } } : {}),
    // BUILD_TARGET=wgt — SINGLE-BUNDLE strategy. The default 'split' strategy
    // emits the client router + one chunk per route node and loads them with
    // ES module dynamic import() + modulepreload links. The Tizen web engine
    // BLOCKS ES module loading from the widget's file:// origin (origin
    // "null" — the TV overlay proved the chunk files EXIST but are refused),
    // so the widget must ship ONE self-contained CLASSIC script instead.
    // 'single' collapses the client build to a single entry input
    // (_app bundle.js) with inlineDynamicImports — vite.config.ts then
    // switches that single entry to an IIFE (classic) bundle named app.js,
    // and scripts/wgt_patch_shell.mjs boots it with a plain
    // <script src="./app.js" defer> tag. Production (BUILD_TARGET unset)
    // keeps the default split strategy untouched.
    ...(isWgtBuild ? { output: { bundleStrategy: 'single' } } : {}),
    // BUILD_TARGET=wgt — HASH ROUTING. The default pathname router derives
    // every route id from location.pathname and mutates history with
    // pushState/replaceState on every navigation. On the widget's file://
    // origin BOTH are hostile: the pathname is a deep install path
    // (/opt/usr/apps/<package>/res[/index.html]) that never matches a
    // route (the app would boot onto the router's 404 page), and stock
    // Chromium-family engines throw SecurityError for history URL
    // mutations on file:// (verified in headless Chromium). With
    // router.type 'hash' the route id comes from location.hash — the
    // widget boots directly onto its HOME route from ANY install path,
    // and SPA navigation is a plain location.hash change, which file://
    // always allows. Production (BUILD_TARGET unset) keeps the pathname
    // router untouched.
    ...(isWgtBuild ? { router: { type: 'hash' } } : {}),
    alias: {
      $components: './src/lib/components',
      $data: './src/lib/data'
    }
  }
};

export default config;
