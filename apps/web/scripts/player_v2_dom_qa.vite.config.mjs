// Vite build config for the PlayerControls rendered-DOM QA harness.
// Bundles the REAL src component (same compiler pipeline as production)
// with $lib resolved, as a static page headless Chromium can mount.
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  root: resolve(dirname(fileURLToPath(import.meta.url)), 'harness'),
  base: './',
  plugins: [svelte({ compilerOptions: { compatibility: { componentApi: 4 } } })],
  resolve: {
    alias: {
      $lib: resolve(root, 'src/lib'),
    },
  },
  build: {
    outDir: '/tmp/mavero-controls-qa-dist',
    emptyOutDir: true,
    minify: false,
  },
});
