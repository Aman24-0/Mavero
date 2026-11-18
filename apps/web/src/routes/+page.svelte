<script lang="ts">
  import { onMount } from 'svelte';
  import DiscoverPage from '$components/DiscoverPage.svelte';
  import { IS_WGT_BUILD } from '$lib/shared/build-mode';
  import { fetchTvDiscoverPayloadCached, type TvDiscoverPayload } from '$lib/tv/discover-payload';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // STAGE 2 (TV plan) — DATA WIRING. The static-SPA .wgt has NO server: its
  // stashed server load leaves `data = {}`, so DiscoverPage would render the
  // honest empty state forever. On the WIDGET BUILD ONLY, the payload is
  // rebuilt here from the DEPLOYED production API (/api/tv/home rails +
  // /api/content/discover/{movie,series,anime} — all credential-less, CORS
  // opened server-side). Never throws: the fetch is individually guarded and
  // the empty-state stays the fallback when every source fails. Production
  // SSR never evaluates this branch (IS_WGT_BUILD is compile-time false) and
  // keeps its server-provided data.
  //
  // STAGE 4 — the fetch goes through the module-level TTL cache / in-flight
  // dedupe (`fetchTvDiscoverPayloadCached`) and shares the promise with the
  // BOOT PREFETCH fired in hooks.client.ts: when the prefetch has already
  // landed, the first render is the real catalog — no mount-time roundtrip,
  // no empty-state flash.
  let tvPayload = $state<TvDiscoverPayload | null>(null);
  if (IS_WGT_BUILD) {
    onMount(() => {
      void fetchTvDiscoverPayloadCached().then((payload) => {
        tvPayload = payload;
      });
    });
  }

  // TV overrides first, server data unchanged on the web. The non-overridden
  // props are passed straight through (undefined on the TV is absorbed by
  // DiscoverPage's prop defaults).
  const tvFeaturedItem = $derived(tvPayload?.featuredItem ?? data.featured);
  const tvHeroItems = $derived(tvPayload?.heroItems ?? data.heroItems ?? []);
  const tvMovies = $derived(tvPayload?.movies ?? data.movies ?? []);
  const tvSeries = $derived(tvPayload?.series ?? data.series ?? []);
  const tvAnime = $derived(tvPayload?.anime ?? data.anime ?? []);
  const tvErrorMessage = $derived(tvPayload?.errorMessage ?? data.errorMessage ?? '');
  // STAGE 4 — skeleton state for the TV: while the payload is still in
  // flight, DiscoverPage renders TV skeleton rails instead of the "quiet
  // shelves" empty state (never a blank/waiting screen — the empty state
  // remains the fallback when the fetch eventually FAILS). Compile-time
  // false on production.
  const tvBooting = $derived(IS_WGT_BUILD && tvPayload === null);
</script>

<DiscoverPage featuredItem={tvFeaturedItem} heroItems={tvHeroItems} movies={tvMovies} series={tvSeries} anime={tvAnime} popularSeries={data.popularSeries} popularAnime={data.popularAnime} trendingHindiMovies={data.trendingHindiMovies} trendingRegionalMovies={data.trendingRegionalMovies} errorMessage={tvErrorMessage} tvBooting={tvBooting} />
