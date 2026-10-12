// Vite build config for the PlayerShell behavioral QA harness.
// Bundles the REAL PlayerShell.svelte (same compiler pipeline as production).
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
      '$app/environment': resolve(dirname(fileURLToPath(import.meta.url)), 'harness/app-environment-stub.js'),
    },
  },
  build: {
    outDir: '/tmp/mavero-shell-qa-dist',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: {
        shell: resolve(dirname(fileURLToPath(import.meta.url)), 'harness/shell.html'),
      },
    },
  },
});
