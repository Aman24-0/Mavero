<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { ArrowLeft, ArrowUpRight, Heart, Play, Plus, Share2, Star } from 'lucide-svelte';
  import type { ContentType } from '$data/content';
  import { getMedia, media, formatType, type MediaItem } from '$data/content';
  import ContentRail from '$components/ContentRail.svelte';
  import SeasonEpisodes from '$components/SeasonEpisodes.svelte';
  import { isFavorite, toggleFavorite } from '$lib/client/progress/service';
  import { deleteCloudFavorite, syncAuthenticatedState } from '$lib/client/progress/cloud';

  export let id = 'afterlight';
  export let type: ContentType = 'movie';
  export let dataItem: MediaItem | undefined = undefined;
  export let recommendationItems: MediaItem[] = [];
  let saved = false;
  let saveError = '';
  $: item = dataItem ?? getMedia(id);
  $: recommendations = recommendationItems.length ? recommendationItems : media.filter((candidate) => candidate.id !== item.id && candidate.type === type).slice(0, 4);
  $: canonicalUrl = `${page.url.origin}/${type}/${item.id}`;
  $: structuredData = JSON.stringify({ '@context': 'https://schema.org', '@type': type === 'movie' ? 'Movie' : 'TVSeries', name: item.title, description: item.description, image: item.backdrop || item.poster, dateCreated: String(item.year), aggregateRating: { '@type': 'AggregateRating', ratingValue: item.rating, bestRating: 10, ratingCount: 1 } });

  onMount(() => {
    let active = true;
    void isFavorite(type, item.id).then((value) => { if (active) saved = value; });
    return () => { active = false; };
  });

  async function toggleSaved() {
    try {
      const result = await toggleFavorite(type, item.id, { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description });
      saved = result.saved;
      if (page.data.user) {
        if (result.saved) void syncAuthenticatedState();
        else void deleteCloudFavorite(type, item.id);
      }
      saveError = '';
    } catch {
      saveError = 'This device could not update your local list.';
    }
  }
</script>

<svelte:head>
  <title>{item.title} — Mavero</title>
  <meta name="description" content={item.description} />
  <link rel="canonical" href={canonicalUrl} />
  <meta property="og:type" content="video.movie" />
  <meta property="og:title" content={`${item.title} — Mavero`} />
  <meta property="og:description" content={item.description} />
  <meta property="og:url" content={canonicalUrl} />
  <meta property="og:image" content={item.backdrop || item.poster} />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={`${item.title} — Mavero`} />
  <meta name="twitter:description" content={item.description} />
  <meta name="twitter:image" content={item.backdrop || item.poster} />
  <script type="application/ld+json">{structuredData}</script>
</svelte:head>

<div class="detail-wrap">
  <div class="detail-backdrop" style={`background-image: url('${item.backdrop}')`}></div>
  <div class="container-wide">
    <a class="back-link" href="/discover"><ArrowLeft size={15} /> Back to Discover</a>
    <section class="detail-layout">
      <div class="detail-poster"><img src={item.poster} alt={`${item.title} poster`} /></div>
      <div class="detail-copy">
        <div class="eyebrow">{formatType(type)} / {item.genres[0]}</div>
        <h1>{item.title}</h1>
        <div class="meta-row"><strong>{item.year}</strong><span class="dot"></span><span>{item.runtime}</span><span class="dot"></span><span>{item.maturity}</span><span class="dot"></span><span class="rating"><Star size={12} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span></div>
        <p>{item.description}</p>
        <div class="detail-grid"><div class="detail-stat"><span>Genres</span><strong>{item.genres.join(' · ')}</strong></div><div class="detail-stat"><span>Audio</span><strong>Original · Sub</strong></div><div class="detail-stat"><span>Experience</span><strong>Full HD · 4K</strong></div></div>
        {#if type !== 'movie'}<div class="episode-strip"><div><div class="eyebrow">Now available</div><strong>{item.seasons ?? 1} season{item.seasons === 1 ? '' : 's'} · {item.episodes ?? 12} episodes</strong></div><button class="icon-btn" aria-label="Open episode list"><ArrowUpRight size={16} /></button></div>{/if}
        <div class="hero-actions"><a class="btn btn-primary" href={`/watch/${type}/${item.id}`}><Play size={15} fill="currentColor" /> Watch now</a><button class="btn btn-secondary" onclick={toggleSaved} aria-pressed={saved}><Plus size={15} /> {saved ? 'In my list' : 'My list'}</button><button class="icon-btn" aria-label={`Share ${item.title}`}><Share2 size={16} /></button><button class="icon-btn" aria-label={saved ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`} aria-pressed={saved} onclick={toggleSaved}><Heart size={16} fill={saved ? 'currentColor' : 'none'} /></button></div>{#if saveError}<div class="save-error" role="status">{saveError}</div>{/if}
      </div>
    </section>
    {#if type === 'series'}<SeasonEpisodes id={item.id} seasonCount={item.seasons ?? 1} />{/if}
    <ContentRail title="You may also like" eyebrow="Keep exploring" items={recommendations} href="/discover" compact />
  </div>
</div>

<style>
  .detail-wrap { position: relative; min-height: calc(100dvh - 76px); overflow: hidden; padding-bottom: 70px; }
  .detail-backdrop { position: absolute; inset: 0 0 auto; z-index: -1; height: 620px; background-position: center; background-size: cover; opacity: .26; filter: saturate(.7); }
  .detail-wrap::before { content: ''; position: absolute; inset: 0 0 auto; z-index: -1; height: 720px; background: linear-gradient(90deg, var(--base) 4%, rgba(8,9,11,.77) 42%, rgba(8,9,11,.16) 100%), linear-gradient(0deg, var(--base), transparent 70%); }
  .back-link { display: inline-flex; align-items: center; gap: 8px; padding-top: 32px; color: var(--muted); font-size: .72rem; font-weight: 800; text-decoration: none; }
  .back-link:hover { color: var(--ink); }
  .rating { display: inline-flex; align-items: center; gap: 4px; color: #f6cf88; }
  .episode-strip { display: flex; align-items: center; justify-content: space-between; width: min(420px, 100%); margin-top: 22px; padding: 13px 15px; border: 1px solid var(--line); border-radius: 13px; background: rgba(255,255,255,.035); }
  .episode-strip strong { display: block; margin-top: 5px; color: var(--ink); font-size: .73rem; }
  .save-error { margin-top: 10px; color: #d4b27c; font-family: 'DM Mono', monospace; font-size: .58rem; }
  @media (max-width: 640px) { .detail-backdrop { height: 460px; } .detail-wrap::before { height: 540px; } .back-link { padding-top: 102px; } }
</style>
