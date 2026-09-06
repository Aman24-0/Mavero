<script lang="ts">
  import SkeletonCard from '$components/SkeletonCard.svelte';
  export let count = 6;
  export let title = 'Loading your collection';
</script>

<section class="section" aria-busy="true" aria-label={title}>
  <div class="section-head"><div><div class="eyebrow">MAVERO / Loading</div><h2 class="section-title">{title}</h2></div></div>
  <div class="rail">{#each Array(count) as _}<SkeletonCard />{/each}</div>
</section>
