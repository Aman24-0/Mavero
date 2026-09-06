<script lang="ts">
  export let compact = false;
</script>

<div class:compact class="skeleton-card" aria-hidden="true">
  <div class="skeleton-poster"></div>
  <div class="skeleton-line skeleton-title"></div>
  <div class="skeleton-line skeleton-meta"></div>
</div>

<style>
  .skeleton-card { min-width: 0; }
  .skeleton-poster { aspect-ratio: 2 / 3; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-2); overflow: hidden; position: relative; }
  .skeleton-poster::after, .skeleton-line::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, rgba(245,246,250,.07), transparent); animation: shimmer 1.4s ease-in-out infinite; }
  .skeleton-line { position: relative; overflow: hidden; height: 8px; margin-top: 10px; border-radius: 999px; background: var(--surface-2); }
  .skeleton-title { width: 78%; }
  .skeleton-meta { width: 52%; height: 6px; margin-top: 7px; }
  @keyframes shimmer { 100% { transform: translateX(100%); } }
  @media (prefers-reduced-motion: reduce) { .skeleton-poster::after, .skeleton-line::after { animation: none; } }
</style>
