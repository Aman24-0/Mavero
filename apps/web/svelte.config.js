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
    alias: {
      $components: './src/lib/components',
      $data: './src/lib/data'
    }
  }
};

export default config;
