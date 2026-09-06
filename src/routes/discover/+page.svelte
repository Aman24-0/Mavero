<script lang="ts">
  import DiscoverPage from '$components/DiscoverPage.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

  <DiscoverPage
    featuredItem={data.featured}
    movies={data.movies}
    series={data.series}
    anime={data.anime}
    popularSeries={data.popularSeries}
    popularAnime={data.popularAnime}
    trendingHindiMovies={data.trendingHindiMovies}
    trendingRegionalMovies={data.trendingRegionalMovies}
    topRatedMovies={data.topRatedMovies}
    topRatedSeries={data.topRatedSeries}
    topRatedAnime={data.topRatedAnime}
    newMovies={data.newMovies}
    genreCollections={data.genreCollections}
    errorMessage={data.errorMessage ?? ''}
  />
