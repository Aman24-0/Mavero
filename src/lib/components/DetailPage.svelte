<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { ArrowLeft, ArrowRight, Heart, Play, Share2, Star } from 'lucide-svelte';
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
  $: recommendations = recommendationItems.length ? recommendationItems : media.filter((candidate) => candidate.id !== item.id && candidate.type === type).slice(0, 6);
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

  function goBack(event: MouseEvent) {
    event.preventDefault();
    if (typeof window !== 'undefined' && window.history.length > 1) window.history.back();
    else void goto('/discover');
  }

  async function shareItem() {
    try {
      if (navigator.share) await navigator.share({ title: item.title, text: `Watch ${item.title} on MAVERO`, url: canonicalUrl });
      else await navigator.clipboard?.writeText(canonicalUrl);
    } catch { /* cancelled share */ }
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
  <div class="detail-backdrop" style={`background-image: url('${item.backdrop || item.poster}')`}></div>
  <div class="container-wide">
    <a class="back-link" href="/discover" onclick={goBack}><ArrowLeft size={15} /> Back</a>
    <section class="detail-layout" aria-labelledby="detail-title">
      <div class="detail-poster"><img src={item.poster} alt={`${item.title} poster`} /></div>
      <div class="detail-copy">
        <div class="eyebrow">{formatType(type)}{#if item.genres[0]} / {item.genres[0]}{/if}</div>
        <h1 id="detail-title">{item.title}</h1>
        <div class="meta-row"><strong>{item.year}</strong><span class="dot"></span><span>{item.runtime}</span><span class="dot"></span><span>{item.maturity}</span>{#if item.rating > 0}<span class="dot"></span><span class="rating"><Star size={12} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>{/if}</div>
        <p>{item.description}</p>
        <div class="detail-actions"><a class="btn btn-primary" href={`/watch/${type}/${item.id}`}><Play size={15} fill="currentColor" /> Watch now</a><button class="btn btn-secondary" onclick={toggleSaved} aria-pressed={saved}><Heart size={15} fill={saved ? 'currentColor' : 'none'} /> {saved ? 'Saved' : 'My list'}</button><button class="icon-btn action-icon" onclick={shareItem} aria-label={`Share ${item.title}`}><Share2 size={16} /></button></div>
        {#if saveError}<div class="save-error" role="status">{saveError}</div>{/if}
        <div class="detail-grid"><div class="detail-stat"><span>Genres</span><strong>{item.genres.slice(0, 2).join(' · ') || '—'}</strong></div><div class="detail-stat"><span>Audio</span><strong>Original · Sub</strong></div><div class="detail-stat"><span>Quality</span><strong>Full HD · 4K</strong></div></div>
        {#if type !== 'movie'}<div class="episode-strip"><div><div class="eyebrow">Episode guide</div><strong>{item.seasons ?? 1} season{item.seasons === 1 ? '' : 's'} · {item.episodes ?? 12} episodes</strong></div><a class="icon-btn" href={`/${type}/${item.id}#episodes`} aria-label="Open episode list"><ArrowRight size={16} /></a></div>{/if}
      </div>
    </section>
    {#if type === 'series'}<SeasonEpisodes id={item.id} seasonCount={item.seasons ?? 1} />{/if}
    {#if recommendations.length}<ContentRail title="You may also like" eyebrow="Keep exploring" items={recommendations} href="/discover" compact />{/if}
  </div>
</div>

<style>
  .detail-wrap { position: relative; overflow: hidden; padding-bottom: 48px; }
  .detail-backdrop { position: absolute; inset: 0 0 auto; z-index: -1; height: 520px; background-position: center; background-size: cover; opacity: .22; filter: saturate(.7); }
  .detail-wrap::before { content: ''; position: absolute; inset: 0 0 auto; z-index: -1; height: 600px; background: linear-gradient(90deg, var(--base) 5%, rgba(8,9,11,.78) 48%, rgba(8,9,11,.16) 100%), linear-gradient(0deg, var(--base), transparent 72%); }
  .back-link { display: inline-flex; align-items: center; gap: 7px; padding-top: 24px; color: var(--muted); font-size: .68rem; font-weight: 800; text-decoration: none; }
  .back-link:hover { color: var(--ink); }
  .detail-poster { overflow: hidden; border-radius: 14px; aspect-ratio: 2 / 3; background: var(--surface); box-shadow: 0 16px 45px rgba(0,0,0,.25); }
  .detail-poster img { width: 100%; height: 100%; object-fit: cover; }
  .detail-copy { min-width: 0; padding-top: 4px; }
  .detail-copy h1 { max-width: 820px; margin: 7px 0 10px; font-size: clamp(2.5rem, 5vw, 5.5rem); letter-spacing: -.08em; line-height: .92; }
  .detail-copy > p { max-width: 680px; margin: 18px 0 0; color: #b2b5be; font-size: .9rem; line-height: 1.68; }
  .rating { display: inline-flex; align-items: center; gap: 4px; color: #f6cf88; }
  .detail-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 20px; }
  .action-icon { border-color: var(--line); }
  .detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; max-width: 650px; margin: 18px 0 0; }
  .detail-stat { padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,.025); }
  .detail-stat span { display: block; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .54rem; text-transform: uppercase; }
  .detail-stat strong { display: block; margin-top: 4px; overflow: hidden; color: var(--ink); font-size: .7rem; text-overflow: ellipsis; white-space: nowrap; }
  .episode-strip { display: flex; align-items: center; justify-content: space-between; width: min(420px, 100%); margin-top: 14px; padding: 11px 13px; border: 1px solid var(--line); border-radius: 11px; background: rgba(255,255,255,.035); }
  .episode-strip strong { display: block; margin-top: 4px; color: var(--ink); font-size: .7rem; }
  .save-error { margin-top: 8px; color: #d4b27c; font-family: 'DM Mono', monospace; font-size: .57rem; }
  @media (max-width: 640px) { .detail-backdrop { height: 390px; } .detail-wrap::before { height: 470px; } .back-link { padding-top: 24px; } .detail-layout { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 14px; padding: 24px 0 28px; } .detail-copy { display: contents; } .detail-copy > .eyebrow, .detail-copy > h1, .detail-copy > .meta-row { grid-column: 2; } .detail-copy > p, .detail-copy > .detail-actions, .detail-copy > .detail-grid, .detail-copy > .episode-strip, .detail-copy > .save-error { grid-column: 1 / -1; } .detail-copy h1 { font-size: 2.35rem; } .detail-copy > p { margin-top: 15px; font-size: .84rem; } .detail-grid { gap: 6px; } .detail-stat { padding: 9px; } }
</style>
