<script lang="ts">
  import DiscoverPage from '$components/DiscoverPage.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

  <DiscoverPage featuredItem={data.featured} movies={data.movies} series={data.series} anime={data.anime} popularMovies={data.popularMovies} popularSeries={data.popularSeries} popularAnime={data.popularAnime} errorMessage={data.errorMessage ?? ''} />
