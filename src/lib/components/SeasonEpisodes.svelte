<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { AlertTriangle, ChevronRight, Download, LoaderCircle, Play } from 'lucide-svelte';
  import { appendReturnTo } from '$lib/shared/navigation';
  import { markEpisodeAsResumeTarget } from '$lib/client/progress/service';

  type Episode = { id: string; number: number; season: number; title: string; overview?: string; airDate?: string; runtime?: string; still?: string };
  type Season = { number: number; title: string; episodeCount: number; episodes?: Episode[] };

  export let id: string;
  export let seasonCount = 1;
  // Phase 7F+ (anime routing): the URL type segment for watch links.
  // Defaults to 'series'. For anime content loaded via /anime/ route,
  // pass 'anime' so episode links go to /watch/anime/{id}?season=1&episode=N.
  export let watchType: 'series' | 'anime' = 'series';
  // Phase 2 downloader refinement: optional callback the episode card fires
  // when the user clicks its Download button. DetailPage owns the
  // DownloadSheet, so this callback just forwards the clicked episode's
  // season + episode number to the parent. SeasonEpisodes does NOT
  // duplicate provider filtering, URL building, or iframe logic — the
  // existing downloader module stays the single source of truth.
  // The callback is optional so existing callers that don't supply it
  // (e.g. tests) keep working unchanged.
  export let onDownload: ((season: number, episode: number) => void) | undefined = undefined;
  // P3+P4: optional content snapshot for the parent's content item,
  // used by markEpisodeAsResumeTarget to create a zero-progress stub
  // when the episode has no existing progress record.
  export let contentSnapshot: { title: string; poster: string; backdrop?: string; year?: number; runtime?: string; rating?: number; genres?: string[]; description?: string } | undefined = undefined;
  let selectedSeason = 1;
  let season: Season | undefined;
  let loading = true;
  let errorMessage = '';

  async function loadSeason(number: number) {
    selectedSeason = number;
    loading = true;
    errorMessage = '';
    try {
      const response = await fetch(`/api/content/series/${encodeURIComponent(id)}/season/${number}`);
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message || 'Episodes are temporarily unavailable.');
      season = payload.season as Season;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Episodes are temporarily unavailable.';
      season = undefined;
    } finally {
      loading = false;
    }
  }

  $: returnTo = `${page.url.pathname}${page.url.search}${page.url.hash}`;

  onMount(() => { void loadSeason(1); });

  // Episode-card Download click handler. Forwards the EXACT selected
  // season + clicked episode number to the parent. The parent owns the
  // DownloadSheet + the download target state. We do NOT use the parent's
  // resume-episode state or fall back to S1E1 here — the user clicked a
  // specific episode, so that exact episode is what the download URL
  // must target.
  function handleEpisodeDownload(episode: Episode) {
    onDownload?.(selectedSeason, episode.number);
  }
</script>

<section class="ep-section" aria-labelledby="ep-heading">
  <div class="ep-head">
    <div>
      <div class="ep-eyebrow">MAVERO / Series guide</div>
      <h2 class="ep-title" id="ep-heading">Episodes</h2>
    </div>
    {#if seasonCount > 1}
      <div class="season-tabs" role="group" aria-label="Select season">
        {#each Array(Math.max(seasonCount, 1)) as _, index}
          <button class:active={selectedSeason === index + 1} aria-pressed={selectedSeason === index + 1} onclick={() => loadSeason(index + 1)}>S{index + 1}</button>
        {/each}
      </div>
    {/if}
  </div>

  {#if loading}
    <div class="ep-loading"><LoaderCircle size={15} /> Loading episodes…</div>
  {:else if errorMessage}
    <div class="ep-error" role="alert"><AlertTriangle size={15} /> {errorMessage}<button class="retry-btn" onclick={() => loadSeason(selectedSeason)}>Try again</button></div>
  {:else if season?.episodes?.length}
    <div class="ep-list">
      {#each season.episodes as episode}
        <article class="ep-row">
          <!-- Thumbnail is the primary visual anchor on every
               breakpoint. The episode number overlays the top-left
               corner of the still so the row stays compact without a
               dedicated number column. -->
          <div class="ep-thumb-wrap">
            {#if episode.still}
              <img src={episode.still} alt={`${episode.title} still`} loading="lazy" width="320" height="180" />
            {:else}
              <div class="ep-still" aria-hidden="true"></div>
            {/if}
            <span class="ep-num" aria-hidden="true">{String(episode.number).padStart(2, '0')}</span>
          </div>
          <div class="ep-copy">
            <h3>{episode.title}</h3>
            <div class="ep-meta">{episode.runtime ?? 'Episode'}{#if episode.airDate}<span>·</span>{episode.airDate}{/if}</div>
            <p>{episode.overview || 'Episode details are not available yet.'}</p>
          </div>
          <div class="ep-actions">
            <button
              type="button"
              class="ep-play"
              aria-label={`Watch ${episode.title}`}
              onclick={async (e) => {
                // P3+P4: persist the episode as the latest resume target
                // BEFORE navigation. This prevents the episode selection
                // from being lost if the component is destroyed during
                // navigation. Local IndexedDB write first; cloud sync
                // happens asynchronously after.
                e.preventDefault();
                e.stopPropagation();
                if (contentSnapshot) {
                  try {
                    await markEpisodeAsResumeTarget(
                      { contentType: watchType, contentId: id, season: selectedSeason, episode: episode.number },
                      contentSnapshot,
                    );
                  } catch { /* local persistence failure is non-fatal — navigation still proceeds */ }
                }
                void goto(appendReturnTo(`/watch/${watchType}/${id}?season=${selectedSeason}&episode=${episode.number}`, returnTo));
              }}
            >
              <Play size={13} fill="currentColor" strokeWidth={0} />
            </button>
            {#if onDownload}
              <button
                type="button"
                class="ep-download"
                onclick={() => handleEpisodeDownload(episode)}
                aria-label={`Download ${episode.title}`}
                title={`Download ${episode.title}`}
              >
                <Download size={12} />
              </button>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {:else}
    <div class="ep-empty">No episode metadata is available for this season yet.</div>
  {/if}
</section>

<style>
  .ep-section { margin-top: clamp(28px, 4vw, 40px); }
  .ep-head {
    display: flex; align-items: end; justify-content: space-between;
    gap: 16px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--color-border);
  }
  .ep-eyebrow {
    display: inline-flex; align-items: center; gap: 7px;
    color: var(--color-primary);
    font-size: .58rem; font-weight: 800;
    letter-spacing: .12em; text-transform: uppercase;
    text-shadow: 0 0 10px rgba(0, 255, 156, .3);
  }
  .ep-title {
    color: var(--color-text);
    font-size: clamp(1.1rem, 1.6vw, 1.3rem);
    font-weight: 800; letter-spacing: -.02em;
    margin: 4px 0 0;
  }

  .season-tabs {
    display: flex; gap: 4px;
    max-width: 58%; overflow-x: auto;
    padding: 4px;
    border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm);
    background: rgba(0, 255, 156, .03);
    scrollbar-width: none;
  }
  .season-tabs::-webkit-scrollbar { display: none; }
  .season-tabs button {
    flex: 0 0 auto;
    border: 0; border-radius: 4px;
    padding: 6px 12px;
    color: var(--color-text-muted);
    background: transparent;
    font: inherit; font-size: .6rem; font-weight: 700;
    cursor: pointer;
    transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
  }
  .season-tabs button.active {
    color: #050708; background: var(--color-primary);
    box-shadow: var(--glow-primary);
  }
  .season-tabs button:hover:not(.active) {
    color: var(--color-text); background: rgba(0, 255, 156, .08);
  }
  .season-tabs button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .ep-loading, .ep-error, .ep-empty {
    display: flex; align-items: center; gap: 9px;
    padding: 22px 0;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text-muted);
    font-size: .76rem;
  }
  .ep-error { color: var(--color-warning); }
  .retry-btn {
    margin-left: auto;
    border: 1px solid var(--color-border-strong); border-radius: 999px;
    padding: 4px 10px;
    background: transparent;
    cursor: pointer;
    color: var(--color-text);
    font-size: .68rem; font-weight: 700;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .retry-btn:hover { background: var(--color-primary-soft); border-color: var(--color-primary-border); }
  .retry-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .ep-list { padding-top: 8px; }
  /* Desktop episode row: a single horizontal composition with thumbnail,
     copy, and actions aligned to the row center. The row is wider on
     large viewports but bounded so very wide screens don't stretch
     the description line indefinitely. */
  .ep-row {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr) auto;
    align-items: center; gap: 20px;
    padding: 14px 12px;
    border-bottom: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    transition: background var(--motion-fast) var(--ease-out);
  }
  .ep-row:hover { background: rgba(0, 255, 156, .03); }
  .ep-row:focus-within {
    background: rgba(0, 255, 156, .04);
    /* TV / keyboard focus: lift the row slightly with a cyber-green
       left rail so the focused episode is unambiguous. */
    box-shadow: inset 2px 0 0 var(--color-primary);
  }

  /* Thumbnail wrapper — preserves aspect-ratio so images never cause
     layout shift, and the episode number overlays its top-left corner. */
  .ep-thumb-wrap {
    position: relative;
    aspect-ratio: 16 / 9;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--color-surface-elevated);
  }
  .ep-thumb-wrap img, .ep-still {
    width: 100%; height: 100%; object-fit: cover;
    transition: transform 320ms var(--ease-out);
  }
  .ep-row:hover .ep-thumb-wrap img { transform: scale(1.04); }
  .ep-still {
    background:
      radial-gradient(circle at 30% 30%, rgba(0,255,156,.05), transparent 55%),
      var(--color-surface-elevated);
  }
  .ep-num {
    position: absolute; top: 6px; left: 6px;
    padding: 2px 7px; border-radius: 4px;
    color: rgba(242,255,248,.88);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .58rem; font-weight: 700;
    letter-spacing: .04em;
    background: rgba(5,7,8,.7); backdrop-filter: blur(6px);
    border: 1px solid var(--color-border-strong);
  }

  .ep-copy { min-width: 0; }
  .ep-copy h3 {
    margin: 0 0 4px;
    color: var(--color-text);
    font-size: .82rem; font-weight: 700;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ep-meta {
    display: flex; gap: 6px;
    color: var(--color-text-deep);
    font-size: .6rem; font-weight: 600;
  }
  .ep-copy p {
    /* Description stays visible at every breakpoint but clamps to a
       bounded number of lines on small viewports so the row stays
       compact. */
    max-width: 580px;
    margin: 6px 0 0;
    overflow: hidden;
    color: var(--color-text-muted);
    font-size: .72rem; line-height: 1.55;
    display: -webkit-box; -webkit-box-orient: vertical;
    -webkit-line-clamp: 2; line-clamp: 2;
  }
  /* Episode action cluster: Play + Download sit side-by-side so the
     layout doesn't grow taller. Both share the same circular shape +
     30px footprint (base mobile size); Download is visually
     secondary (outline style, smaller icon) so Play remains the
     primary CTA. Larger viewports scale both up via media queries. */
  .ep-actions { display: inline-flex; align-items: center; gap: 8px; }
  .ep-play {
    display: grid; place-items: center;
    width: 30px; height: 30px; border-radius: 50%;
    color: #050708; background: var(--color-primary);
    box-shadow: 0 4px 14px rgba(0,0,0,.4), var(--glow-primary);
    text-decoration: none;
    transition: transform var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out);
  }
  .ep-play:hover { filter: brightness(1.08); transform: scale(1.08); }
  .ep-play:active { transform: scale(.94); }
  .ep-play:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }
  .ep-download {
    display: grid; place-items: center;
    width: 30px; height: 30px; border-radius: 50%;
    border: 1px solid var(--color-border-strong);
    color: var(--color-text);
    background: rgba(255,255,255,.03);
    cursor: pointer;
    transition: transform var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .ep-download:hover {
    transform: scale(1.08);
    background: var(--color-primary-soft);
    border-color: var(--color-primary-border);
  }
  .ep-download:active { transform: scale(.94); }
  .ep-download:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* ---- TABLET ---- */
  @media (min-width: 641px) and (max-width: 1024px) {
    .ep-row { grid-template-columns: 180px minmax(0, 1fr) auto; gap: 16px; padding: 12px 8px; }
    .ep-copy p { -webkit-line-clamp: 2; line-clamp: 2; }
  }

  /* ---- DESKTOP / TV ---- */
  @media (min-width: 1025px) {
    .ep-row { grid-template-columns: 260px minmax(0, 1fr) auto; gap: 24px; padding: 16px 14px; }
    .ep-copy h3 { font-size: .9rem; }
    .ep-copy p { font-size: .76rem; -webkit-line-clamp: 2; line-clamp: 2; max-width: 720px; }
    .ep-play, .ep-download { width: 40px; height: 40px; }
  }
  @media (min-width: 1900px) {
    .ep-row { grid-template-columns: 320px minmax(0, 1fr) auto; gap: 32px; }
    .ep-copy h3 { font-size: .96rem; }
    .ep-copy p { font-size: .8rem; max-width: 820px; -webkit-line-clamp: 3; line-clamp: 3; }
  }

  /* ---- MOBILE ----
     Compact card layout: thumbnail with play overlay, title beneath,
     description collapses to 1 line so multiple episodes fit on the
     screen. The play affordance becomes a small overlay on the
     thumbnail so the row stays single-tap-target-friendly. */
  @media (max-width: 640px) {
    .ep-head { flex-direction: column; align-items: start; gap: 12px; }
    .season-tabs { max-width: 100%; width: 100%; }
    .ep-list { padding-top: 4px; }
    .ep-row {
      grid-template-columns: 96px minmax(0, 1fr) auto;
      gap: 12px; padding-inline: 4px; padding-block: 10px;
    }
    .ep-thumb-wrap { border-radius: 8px; }
    .ep-num { top: 4px; left: 4px; font-size: .52rem; padding: 1px 5px; }
    .ep-copy h3 { font-size: .76rem; }
    .ep-meta { font-size: .56rem; }
    .ep-copy p { font-size: .68rem; -webkit-line-clamp: 1; line-clamp: 1; }
    .ep-play, .ep-download { width: 32px; height: 32px; }
    .ep-actions { gap: 6px; }
  }

  /* ---- LANDSCAPE MOBILE (short viewport) ----
     The episode row stays compact so multiple episodes remain
     visible without scrolling. */
  @media (max-width: 1024px) and (orientation: landscape) and (max-height: 480px) {
    .ep-row { grid-template-columns: 120px minmax(0, 1fr) auto; gap: 12px; padding-block: 8px; }
    .ep-copy p { -webkit-line-clamp: 1; line-clamp: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ep-row, .ep-play, .ep-download, .season-tabs button, .ep-thumb-wrap img { transition: none; }
    .ep-row:hover .ep-thumb-wrap img { transform: none; }
  }
</style>
