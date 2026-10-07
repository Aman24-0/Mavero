<script lang="ts">
  // LT-4 — Now Playing / Up Next (presentation only).
  //
  // Renders ONLY actual guide fields (LT-2 LiveTvGuide: nowPlaying, upNext).
  // Nothing is fabricated: when the guide has no current/next programme, an
  // honest quiet state is shown — an empty schedule is a VALID state, never
  // an error (plan §12). Guide failure is non-blocking for playback; here it
  // becomes a compact retryable note (LT-4 brief §13).
  import { AlertCircle, Tv, Clock3, RefreshCw } from 'lucide-svelte';
  import { formatGuideClock } from '$lib/client/live-tv/epg';
  import type { LiveTvGuide } from '$lib/client/live-tv/types';

  let {
    guide = null,
    loading = false,
    errorMessage = null,
    onretry = () => {}
  }: {
    guide?: LiveTvGuide | null;
    loading?: boolean;
    /** Safe message for a guide failure (page-owned). */
    errorMessage?: string | null;
    onretry?: () => void;
  } = $props();

  const nowPlaying = $derived(guide?.nowPlaying ?? null);
  const upNext = $derived(guide?.upNext ?? null);
  const hasAnyProgramme = $derived(Boolean(nowPlaying || upNext));
</script>

<section class="ltv-now" aria-label="Now playing and up next">
  <h2 class="ltv-section-title">On air</h2>

  {#if loading}
    <div class="now-grid" aria-busy="true">
      <div class="now-card skeleton" aria-hidden="true"><span class="sk-line w60"></span><span class="sk-line w40"></span></div>
      <div class="now-card skeleton" aria-hidden="true"><span class="sk-line w50"></span><span class="sk-line w30"></span></div>
    </div>
  {:else if errorMessage}
    <div class="now-note error" role="alert">
      <span class="note-mark" aria-hidden="true"><AlertCircle size={15} /></span>
      <span class="note-text">{errorMessage}</span>
      <button class="note-retry" type="button" onclick={onretry}>
        <RefreshCw size={13} /> Retry
      </button>
    </div>
  {:else if hasAnyProgramme}
    <div class="now-grid">
      {#if nowPlaying}
        <article class="now-card current" aria-label="Now playing">
          <span class="card-flag" aria-hidden="true"><Tv size={13} /> Now playing</span>
          <h3 class="card-title">{nowPlaying.title}</h3>
          {#if nowPlaying.description}
            <p class="card-desc">{nowPlaying.description}</p>
          {/if}
          <span class="card-time" aria-hidden="true">
            <Clock3 size={12} />
            {formatGuideClock(nowPlaying.startSeconds)} – {formatGuideClock(nowPlaying.stopSeconds)}
            {#if nowPlaying.category}<span class="time-cat"> · {nowPlaying.category}</span>{/if}
          </span>
        </article>
      {/if}
      {#if upNext}
        <article class="now-card next" aria-label="Up next">
          <span class="card-flag" aria-hidden="true"><Clock3 size={13} /> Up next</span>
          <h3 class="card-title">{upNext.title}</h3>
          {#if upNext.description}
            <p class="card-desc">{upNext.description}</p>
          {/if}
          <span class="card-time" aria-hidden="true">
            <Clock3 size={12} />
            {formatGuideClock(upNext.startSeconds)} – {formatGuideClock(upNext.stopSeconds)}
          </span>
        </article>
      {/if}
    </div>
  {:else}
    <div class="now-note" role="status">
      <span class="note-text">No programme information for this channel right now.</span>
    </div>
  {/if}
</section>

<style>
  .ltv-now { display: grid; gap: 12px; min-width: 0; }

  .ltv-section-title {
    margin: 0;
    color: var(--color-text);
    font-size: clamp(1.05rem, 1.6vw, 1.3rem);
    font-weight: 800;
    letter-spacing: -.02em;
    line-height: 1.1;
  }

  .now-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px;
    min-width: 0;
  }

  .now-card {
    display: grid;
    gap: 8px;
    align-content: start;
    min-width: 0;
    padding: 14px 16px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .now-card.current {
    border-color: var(--color-primary-border);
    background: linear-gradient(160deg, var(--color-primary-soft), var(--color-surface) 55%);
    box-shadow: var(--glow-primary);
  }

  .card-flag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--color-text-muted);
    font-size: .62rem;
    font-weight: 800;
    letter-spacing: .12em;
    text-transform: uppercase;
  }
  .now-card.current .card-flag { color: var(--color-primary); }

  .card-title {
    margin: 0;
    color: var(--color-text);
    font-size: .95rem;
    font-weight: 800;
    letter-spacing: -.015em;
    line-height: 1.3;
    text-wrap: pretty;
  }

  .card-desc {
    margin: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    color: var(--color-text-muted);
    font-size: .78rem;
    line-height: 1.55;
    text-wrap: pretty;
  }

  .card-time {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--color-text-deep);
    font-size: .7rem;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .time-cat { overflow: hidden; text-overflow: ellipsis; }

  .now-note {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 12px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    color: var(--color-text-muted);
    font-size: .78rem;
  }
  .now-note.error {
    border-color: rgba(255, 77, 109, .28);
    color: var(--color-text);
  }
  .note-mark { display: grid; place-items: center; color: var(--color-danger); flex: 0 0 auto; }
  .note-text { min-width: 0; flex: 1 1 auto; line-height: 1.5; }
  .note-retry {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    min-height: 34px;
    padding: 0 14px;
    border: 1px solid var(--color-primary-border);
    border-radius: 999px;
    color: var(--color-primary);
    background: var(--color-primary-soft);
    font-size: .72rem;
    font-weight: 800;
    white-space: nowrap;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .note-retry:hover { background: rgba(0, 255, 156, .14); border-color: var(--color-primary); }
  .note-retry:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .now-card.skeleton {
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .sk-line {
    display: block;
    height: 12px;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--color-surface-raised), var(--color-surface-elevated), var(--color-surface-raised));
    background-size: 200% 100%;
    animation: ltv-shimmer 1.6s ease-in-out infinite;
  }
  .sk-line.w60 { width: 60%; }
  .sk-line.w50 { width: 50%; }
  .sk-line.w40 { width: 40%; }
  .sk-line.w30 { width: 30%; }
  @keyframes ltv-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .sk-line { animation: none; }
  }
</style>
