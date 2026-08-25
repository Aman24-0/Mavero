<script lang="ts">
  import type { MediaItem, ContentType } from '$data/content';
  import type { Episode, Season } from '$lib/server/content/types';
  import TvError from './TvError.svelte';
  import TvLoading from './TvLoading.svelte';
  import TvMediaRail from './TvMediaRail.svelte';

  type TvDetailItem = MediaItem & { recommendations?: MediaItem[] };
  type FavoriteStatus = 'watching' | 'planned' | 'completed' | null;

  let episodesToShow = $state(12);
  let episodeRenderReady = $state(false);
  let episodeIdleId: number | undefined;
  let episodeTimeoutId: ReturnType<typeof setTimeout> | undefined;

  type TVIdleWindow = Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };

  let {
    item,
    loading = false,
    errorMessage = '',
    favoriteStatus = null,
    saving = false,
    seasons = [],
    activeSeason = 1,
    episodesLoading = false,
    episodesError = '',
    recommendations = [],
    saveError = '',
    onBack,
    onRetry,
    onWatchNow,
    onToggleFavorite,
    onSeasonChange,
    onEpisodeSelect,
    onRecommendationSelect
  }: {
    item?: TvDetailItem;
    loading?: boolean;
    errorMessage?: string;
    favoriteStatus?: FavoriteStatus;
    saving?: boolean;
    seasons?: Season[];
    activeSeason?: number;
    episodesLoading?: boolean;
    episodesError?: string;
    recommendations?: MediaItem[];
    saveError?: string;
    onBack: (event: MouseEvent) => void;
    onRetry: (event: MouseEvent) => void;
    onWatchNow: (event: MouseEvent) => void;
    onToggleFavorite: (event: MouseEvent) => void;
    onSeasonChange: (season: number) => void;
    onEpisodeSelect: (episode: Episode, event: MouseEvent) => void;
    onRecommendationSelect: (item: MediaItem, event: MouseEvent, focusId: string) => void;
  } = $props();

  const formatType = (type: ContentType) => type === 'movie' ? 'Movie' : type === 'series' ? 'Series' : 'Anime';
  const statusLabel = (status: FavoriteStatus) => status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Add to My List';
  const activeSeasonData = () => seasons.find((season) => season.number === activeSeason) ?? seasons[0];
  const seasonCount = () => item?.type === 'series' ? item.seasons ?? 0 : 0;
  const activeEpisodes = () => activeSeasonData()?.episodes ?? [];

  function cancelEpisodePreparation() {
    if (episodeIdleId !== undefined && typeof window !== 'undefined') {
      (window as TVIdleWindow).cancelIdleCallback?.(episodeIdleId);
    }
    if (episodeTimeoutId !== undefined) clearTimeout(episodeTimeoutId);
    episodeIdleId = undefined;
    episodeTimeoutId = undefined;
  }

  function prepareEpisodeList() {
    cancelEpisodePreparation();
    episodeRenderReady = false;
    const reveal = () => {
      episodeRenderReady = true;
      episodeIdleId = undefined;
      episodeTimeoutId = undefined;
    };
    if (typeof window === 'undefined') {
      reveal();
      return;
    }
    const idleWindow = window as TVIdleWindow;
    if (idleWindow.requestIdleCallback) episodeIdleId = idleWindow.requestIdleCallback(reveal, { timeout: 400 });
    else episodeTimeoutId = setTimeout(reveal, 0);
  }

  function showMoreEpisodes() {
    episodesToShow += 12;
  }

  $effect(() => {
    const shouldPrepare = item?.type === 'series' && !episodesLoading && activeEpisodes().length > 0;
    episodesToShow = 12;
    cancelEpisodePreparation();
    if (!shouldPrepare) {
      episodeRenderReady = false;
      return;
    }
    prepareEpisodeList();
    return cancelEpisodePreparation;
  });
</script>

<section class="tv-detail" aria-labelledby="tv-detail-title" aria-busy={loading}>
  {#if loading}
    <TvLoading label="Loading title details…" />
  {:else if errorMessage}
    <TvError message={errorMessage} onRetry={onRetry} />
  {:else if item}
    <button class="tv-focusable detail-back" data-tv-focusable="true" data-tv-focus-id="tv-detail-back" data-tv-focus-group="tv-detail-top" type="button" onclick={onBack}>← Back to {item.type === 'movie' ? 'browse' : 'titles'}</button>

    {#if saveError}<div class="detail-save-error" role="status">{saveError}</div>{/if}

    <article class="detail-hero" aria-labelledby="tv-detail-title">
      <div class="detail-backdrop" style={`background-image: linear-gradient(90deg, rgba(6,8,13,.98) 0%, rgba(6,8,13,.88) 42%, rgba(6,8,13,.3) 100%), linear-gradient(0deg, rgba(6,8,13,.98) 0%, transparent 56%), url('${item.backdrop || item.poster}')`}></div>
      <div class="detail-content">
        <div class="detail-poster"><img src={item.poster} alt={`${item.title} poster`} loading="eager" decoding="async" sizes="(max-width: 760px) 38vw, 220px" /></div>
        <div class="detail-copy">
          <p class="eyebrow">{formatType(item.type)}{#if item.genres[0]} / {item.genres[0]}{/if}</p>
          <h1 id="tv-detail-title">{item.title}</h1>
          <div class="detail-meta" aria-label="Title metadata">
            <strong>{item.year}</strong><span aria-hidden="true">•</span><span>{item.runtime}</span><span aria-hidden="true">•</span><span>{item.maturity ?? '13+'}</span>{#if item.rating > 0}<span aria-hidden="true">•</span><span class="rating">★ {item.rating.toFixed(1)}</span>{/if}
          </div>
          <p class="detail-description">{item.description}</p>
          {#if item.genres.length}<div class="genre-row" aria-label="Genres">{#each item.genres.slice(0, 4) as genre}<span>{genre}</span>{/each}</div>{/if}
          <div class="detail-actions">
            <button class="tv-focusable detail-watch" data-tv-focusable="true" data-tv-focus-id="tv-detail-watch-now" data-tv-focus-group="tv-detail-actions" type="button" onclick={onWatchNow}>Watch Now</button>
            <button class="tv-focusable detail-save" class:saved={favoriteStatus} disabled={saving} data-tv-focusable="true" data-tv-focus-id="tv-detail-my-list" data-tv-focus-group="tv-detail-actions" type="button" onclick={onToggleFavorite}>{saving ? 'Saving…' : statusLabel(favoriteStatus)}</button>
          </div>
          {#if item.type === 'series'}
            <div class="series-summary"><strong>{item.seasons ?? 1} season{item.seasons === 1 ? '' : 's'} · {item.episodes ?? '—'} episodes</strong>{#if item.status}<span>{item.status}</span>{/if}</div>
          {/if}
        </div>
      </div>
    </article>

    {#if item.type === 'series'}
      <section class="episode-section" aria-labelledby="tv-episodes-title" data-tv-series-guide="true">
        <div class="section-heading"><div><p class="eyebrow">Series guide</p><h2 id="tv-episodes-title">Seasons and episodes</h2></div><span class="direction-hint">← → choose · Enter open</span></div>
        {#if seasonCount() > 0}
          <div class="season-row" role="list" aria-label="Seasons">
            {#each Array.from({ length: seasonCount() }, (_, index) => index + 1) as seasonNumber}
              <button class="tv-focusable season-button" class:active={seasonNumber === activeSeason} data-tv-focusable="true" data-tv-focus-id={`tv-detail-season-${seasonNumber}`} data-tv-focus-group="tv-detail-seasons" type="button" aria-pressed={seasonNumber === activeSeason} onclick={() => onSeasonChange(seasonNumber)}>Season {seasonNumber}</button>
            {/each}
          </div>
        {/if}
        {#if episodesLoading}
          <TvLoading label={`Loading Season ${activeSeason} episodes…`} />
        {:else if episodesError}
          <TvError message={episodesError} onRetry={onRetry} />
        {:else if activeEpisodes().length}
          {#if !episodeRenderReady}
            <TvLoading label="Preparing episode guide…" />
          {:else}
            {#key activeSeason}
              <div id="tv-detail-episode-list" class="episode-list" role="list" aria-label={`Season ${activeSeason} episodes`}>
                {#each activeEpisodes().slice(0, episodesToShow) as episode (episode.id)}
                  <button class="tv-focusable episode-card" data-tv-focusable="true" data-tv-focus-id={`tv-detail-episode-${episode.season}-${episode.number}`} data-tv-focus-group="tv-detail-episodes" type="button" onclick={(event) => onEpisodeSelect(episode, event)}>
                    <span class="episode-number">E{String(episode.number).padStart(2, '0')}</span>
                    <span class="episode-copy"><strong>{episode.title}</strong><span>{episode.runtime ?? 'Runtime unavailable'}{#if episode.airDate} · {episode.airDate}{/if}</span>{#if episode.overview}<small>{episode.overview}</small>{/if}</span>
                    <span class="episode-arrow" aria-hidden="true">→</span>
                  </button>
                {/each}
              </div>
              {#if activeEpisodes().length > episodesToShow}
                <button class="tv-focusable episode-more" aria-controls="tv-detail-episode-list" aria-expanded={episodesToShow >= activeEpisodes().length} data-tv-focusable="true" data-tv-focus-id="tv-detail-episodes-more" data-tv-focus-group="tv-detail-episodes" type="button" onclick={showMoreEpisodes}>Show 12 more episodes</button>
              {/if}
            {/key}
          {/if}
        {:else}
          <div class="detail-empty" role="status">No episode data is available for this season.</div>
        {/if}
      </section>
    {/if}

    {#if recommendations.length}
      <TvMediaRail title="You may also like" eyebrow="Keep exploring" railId="tv-detail-recommendations" items={recommendations} onSelect={onRecommendationSelect} />
    {/if}
  {/if}
</section>

<style>
  .tv-detail { --tv-detail-muted: #d6dbea; padding-top: 12px; }
  .detail-save-error { margin-top: 14px; padding: 12px 15px; border: 1px solid rgba(255,82,112,.48); border-radius: 10px; color: #fff; background: rgba(255,62,94,.18); font-size: .95rem; font-weight: 750; }
  .detail-back { min-height: 54px; padding: 12px 17px; border: 1px solid rgba(255,255,255,.24); border-radius: 11px; color: var(--tv-ink); background: rgba(255,255,255,.08); font-size: .98rem; font-weight: 850; cursor: pointer; }
  .detail-back:hover { background: rgba(255,255,255,.14); }
  .detail-hero { position: relative; min-height: 560px; margin-top: 18px; overflow: hidden; border: 1px solid var(--tv-line); border-radius: 20px; background: var(--tv-surface); }
  .detail-backdrop { position: absolute; inset: 0; background-position: center; background-size: cover; }
  .detail-content { position: relative; display: grid; grid-template-columns: 230px minmax(0, 760px); gap: 38px; align-items: end; min-height: 560px; padding: 48px; }
  .detail-poster { width: 230px; aspect-ratio: 2 / 3; overflow: hidden; border: 2px solid rgba(255,255,255,.22); border-radius: 15px; background: var(--tv-surface-soft); box-shadow: 0 20px 60px rgba(0,0,0,.36); }
  .detail-poster img { width: 100%; height: 100%; object-fit: cover; }
  .detail-copy { min-width: 0; padding-bottom: 5px; }
  .detail-copy h1 { max-width: 820px; margin: 0; color: var(--tv-ink); font-size: clamp(2.5rem, 5vw, 5.2rem); font-weight: 950; letter-spacing: -.065em; line-height: .96; text-wrap: balance; }
  .detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 11px; margin-top: 17px; color: var(--tv-detail-muted); font-size: clamp(1rem, 1.5vw, 1.25rem); font-weight: 750; }
  .rating { color: #ffd45d; }
  .detail-description { max-width: 760px; margin: 22px 0 0; color: var(--tv-detail-muted); font-size: clamp(1rem, 1.35vw, 1.2rem); font-weight: 600; line-height: 1.65; }
  .genre-row { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 18px; }
  .genre-row span { padding: 8px 11px; border: 1px solid rgba(255,255,255,.22); border-radius: 999px; color: var(--tv-ink); background: rgba(255,255,255,.1); font-size: .92rem; font-weight: 800; }
  .detail-actions { display: flex; gap: 12px; margin-top: 24px; }
  .detail-watch, .detail-save { min-width: 190px; min-height: 58px; padding: 13px 19px; border: 2px solid var(--tv-accent); border-radius: 12px; color: #fff; background: var(--tv-accent); font-size: 1rem; font-weight: 900; cursor: pointer; }
  .detail-watch { border-color: #ffd45d; color: #171019; background: #ffd45d; }
  .detail-save.saved { color: #171019; background: #ffd45d; border-color: #ffd45d; }
  .detail-save:disabled { cursor: wait; opacity: .72; }
  .series-summary { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 17px; color: var(--tv-detail-muted); font-size: 1rem; font-weight: 700; }
  .series-summary span { color: #ffd45d; }
  .episode-section { padding-top: 44px; }
  .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin: 0 6px 15px; }
  .section-heading h2 { margin: 0; color: var(--tv-ink); font-size: clamp(1.8rem, 3vw, 2.7rem); font-weight: 900; letter-spacing: -.055em; }
  .direction-hint { color: var(--tv-detail-muted); font-size: .9rem; font-weight: 700; }
  .season-row { display: flex; gap: 10px; overflow-x: auto; padding: 4px 6px 18px; scrollbar-width: none; }
  .season-row::-webkit-scrollbar { display: none; }
  .season-button { min-height: 55px; padding: 12px 18px; border: 1px solid rgba(255,255,255,.25); border-radius: 11px; color: var(--tv-detail-muted); background: rgba(255,255,255,.08); font-size: 1rem; font-weight: 850; white-space: nowrap; cursor: pointer; }
  .season-button.active { color: #171019; border-color: #ffd45d; background: #ffd45d; }
  .episode-list { display: grid; gap: 10px; }
  .episode-more { display: block; min-height: 56px; margin-top: 12px; padding: 12px 16px; border: 2px solid var(--tv-line); border-radius: 12px; color: var(--tv-ink); background: var(--tv-surface-soft); font-size: 1rem; font-weight: 900; cursor: pointer; }
  .episode-card { display: grid; grid-template-columns: 72px minmax(0, 1fr) 30px; gap: 18px; align-items: center; width: 100%; min-height: 100px; padding: 16px 20px; border: 1px solid var(--tv-line); border-radius: 13px; color: var(--tv-ink); background: var(--tv-surface); text-align: left; cursor: pointer; }
  .episode-card:hover { background: rgba(255,255,255,.1); }
  .episode-number { color: #ffd45d; font-size: 1rem; font-weight: 950; letter-spacing: .08em; }
  .episode-copy { display: grid; gap: 5px; min-width: 0; }
  .episode-copy strong { overflow: hidden; font-size: 1.1rem; font-weight: 900; text-overflow: ellipsis; white-space: nowrap; }
  .episode-copy span { color: var(--tv-detail-muted); font-size: .92rem; font-weight: 700; }
  .episode-copy small { overflow: hidden; color: var(--tv-detail-muted); font-size: .87rem; font-weight: 600; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
  .episode-arrow { color: var(--tv-accent); font-size: 1.4rem; font-weight: 900; }
  .detail-empty { padding: 25px; border: 1px dashed var(--tv-line); border-radius: 14px; color: var(--tv-detail-muted); background: var(--tv-surface); font-size: 1rem; font-weight: 650; }
  @media (max-width: 840px) { .detail-content { grid-template-columns: 150px minmax(0, 1fr); gap: 22px; min-height: 470px; padding: 28px; } .detail-poster { width: 150px; } }
  @media (max-width: 640px) { .detail-content { grid-template-columns: 105px minmax(0, 1fr); gap: 16px; min-height: 500px; padding: 20px; align-items: end; } .detail-poster { width: 105px; border-radius: 10px; } .detail-copy h1 { font-size: clamp(2rem, 10vw, 3.3rem); } .episode-card { grid-template-columns: 54px minmax(0, 1fr) 24px; gap: 10px; padding-inline: 13px; } .episode-copy small { display: none; } .section-heading { align-items: start; flex-direction: column; } }
</style>
