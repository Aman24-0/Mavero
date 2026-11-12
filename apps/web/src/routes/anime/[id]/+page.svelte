<script lang="ts">
  /**
   * Phase 5 — Legacy /anime/[id] route.
   *
   * This route is a permanent redirect to /anime-series/[id] (handled in
   * +page.server.ts). This +page.svelte exists only because SvelteKit
   * requires a page component for a route to be valid. The server loader
   * throws a redirect BEFORE this component ever renders.
   */
  // Component intentionally empty — the server loader always redirects.
</script>

<!-- This page never renders — the server loader redirects to /anime-series/[id]. -->
