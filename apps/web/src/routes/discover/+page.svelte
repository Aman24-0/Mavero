<script lang="ts">
  import { onMount } from 'svelte';
  import DiscoverPage from '$components/DiscoverPage.svelte';
  import { IS_WGT_BUILD } from '$lib/shared/build-mode';
  import { fetchTvDiscoverPayloadCached, type TvDiscoverPayload } from '$lib/tv/discover-payload';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // STAGE 2 (TV plan) — DATA WIRING: identical to the root (/) page. The
  // widget build rebuilds the DiscoverPage payload from the deployed
  // production API (never throws; the empty state stays the fallback);
  // production SSR keeps its server-provided data untouched.
  //
  // STAGE 4 — cache-backed + boot-prefetch (see the root page) and the
  // tvBooting skeleton flag: while the payload is in flight the page shows
  // skeleton rails instead of the "quiet shelves" empty state. Compile-time
  // false on production.
  let tvPayload = $state<TvDiscoverPayload | null>(null);
  if (IS_WGT_BUILD) {
    onMount(() => {
      void fetchTvDiscoverPayloadCached().then((payload) => {
        tvPayload = payload;
      });
    });
  }

  const tvFeaturedItem = $derived(tvPayload?.featuredItem ?? data.featured);
  const tvHeroItems = $derived(tvPayload?.heroItems ?? data.heroItems ?? []);
  const tvMovies = $derived(tvPayload?.movies ?? data.movies ?? []);
  const tvSeries = $derived(tvPayload?.series ?? data.series ?? []);
  const tvAnime = $derived(tvPayload?.anime ?? data.anime ?? []);
  const tvErrorMessage = $derived(tvPayload?.errorMessage ?? (data.errorMessage ?? ''));
  const tvBooting = $derived(IS_WGT_BUILD && tvPayload === null);
</script>

  <DiscoverPage
    featuredItem={tvFeaturedItem}
    heroItems={tvHeroItems}
    movies={tvMovies}
    series={tvSeries}
    anime={tvAnime}
    popularSeries={data.popularSeries}
    popularAnime={data.popularAnime}
    trendingHindiMovies={data.trendingHindiMovies}
    trendingRegionalMovies={data.trendingRegionalMovies}
    topRatedMovies={data.topRatedMovies}
    topRatedSeries={data.topRatedSeries}
    topRatedAnime={data.topRatedAnime}
    newMovies={data.newMovies}
    genreCollections={data.genreCollections}
    errorMessage={tvErrorMessage}
    appConfig={data.appConfig ?? null}
    tvBooting={tvBooting}
  />
