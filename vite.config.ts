import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  build: {
    // R-5: Shaka Player (the DASH/HLS engine) is ~820 kB minified and is
    // already dynamically imported (lazy-loaded only when the user visits
    // the Live TV page). It cannot be meaningfully reduced. The limit is
    // set to 900 kB so the justified Shaka chunk doesn't trigger a warning
    // while still catching genuinely unexpected large chunks.
    chunkSizeWarningLimit: 900
  }
});
