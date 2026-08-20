<script lang="ts">
  import SkeletonRail from '$components/SkeletonRail.svelte';
</script>

<div class="route-loading" aria-busy="true" aria-label="Loading MAVERO content">
  <div class="loading-hero"><div class="eyebrow">MAVERO / Loading</div><div class="loading-title"></div><div class="loading-copy"></div><div class="loading-actions"></div></div>
  <SkeletonRail title="Loading your next story" />
</div>

<style>
  .route-loading { position: fixed; inset: 68px 0 0; z-index: 30; overflow: auto; padding: 0 max(20px, calc((100% - 1440px) / 2)); background: var(--base); }
  .loading-hero { min-height: 290px; padding: 55px 0 20px; }
  .loading-title, .loading-copy, .loading-actions { position: relative; overflow: hidden; margin-top: 17px; border-radius: 999px; background: #15171c; }
  .loading-title { width: min(460px, 70%); height: 54px; }
  .loading-copy { width: min(520px, 80%); height: 12px; }
  .loading-actions { width: 150px; height: 43px; margin-top: 26px; }
  .loading-title::after, .loading-copy::after, .loading-actions::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, rgba(255,255,255,.06), transparent); animation: shimmer 1.4s ease-in-out infinite; }
  @keyframes shimmer { 100% { transform: translateX(100%); } }
  @media (prefers-reduced-motion: reduce) { .loading-title::after, .loading-copy::after, .loading-actions::after { animation: none; } }
</style>
