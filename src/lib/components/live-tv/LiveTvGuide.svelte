<script lang="ts">
  // LT-4 — programme guide / EPG list (presentation only).
  //
  // A robust V1 guide (LT-4 brief §15): a vertical schedule list — no
  // over-engineered TV grid. Every value shown comes from actual guide data:
  //   * entries are the LT-2 `schedule` (provider data), sorted by start for
  //     display determinism;
  //   * the current programme is marked ONLY when its real [start, stop)
  //     window contains `nowSeconds` (absolute Unix seconds — no timezone
  //     assumption; LT-2 types + epg.ts contract);
  //   * finished programmes are omitted (an honest "what's on from now" list);
  //   * times render in the viewer's locale from absolute instants.
  // An empty schedule is a VALID state, never an error (plan §12).
  import { AlertCircle, RefreshCw, Clock3 } from 'lucide-svelte';
  import {
    formatGuideClock,
    formatGuideDateTime,
    programmeIsToday,
    programmeStatusAt
  } from '$lib/client/live-tv/epg';
  import type { LiveTvGuide, LiveTvGuideProgramme } from '$lib/client/live-tv/types';

  let {
    guide = null,
    nowSeconds = 0,
    loading = false,
    errorMessage = null,
    onretry = () => {}
  }: {
    guide?: LiveTvGuide | null;
    /** Page-supplied current Unix seconds (drives the honest current marker). */
    nowSeconds?: number;
    loading?: boolean;
    /** Safe message for a guide failure (page-owned). */
    errorMessage?: string | null;
    onretry?: () => void;
  } = $props();

  // Finished programmes are not listed; remaining entries sort by start.
  // Deterministic: derived purely from guide data + nowSeconds.
  const upcomingEntries = $derived.by(() => {
    if (!guide || !Array.isArray(guide.schedule)) return [];
    const now = Number.isFinite(nowSeconds) ? nowSeconds : Number.POSITIVE_INFINITY;
    const live: LiveTvGuideProgramme[] = [];
    for (const entry of guide.schedule) {
      if (!entry || typeof entry.stopSeconds !== 'number') continue;
      if (entry.stopSeconds <= now) continue; // already finished
      live.push(entry);
    }
    live.sort((a, b) => a.startSeconds - b.startSeconds);
    return live;
  });

  function statusOf(entry: LiveTvGuideProgramme): 'current' | 'future' {
    return programmeStatusAt(entry, nowSeconds) === 'current' ? 'current' : 'future';
  }

  function timeLabel(entry: LiveTvGuideProgramme): string {
    if (programmeIsToday(entry, nowSeconds)) {
      return `${formatGuideClock(entry.startSeconds)} – ${formatGuideClock(entry.stopSeconds)}`;
    }
    return `${formatGuideDateTime(entry.startSeconds)} – ${formatGuideClock(entry.stopSeconds)}`;
  }
</script>

<section class="ltv-guide" aria-label="Programme guide">
  <div class="guide-head">
    <h2 class="ltv-section-title">Guide</h2>
    {#if !loading && !errorMessage && guide}
      <span class="guide-count">{upcomingEntries.length} upcoming</span>
    {/if}
  </div>

  {#if loading}
    <div class="guide-list" aria-busy="true">
      {#each Array(5) as _, i (i)}
        <div class="guide-row skeleton" aria-hidden="true">
          <span class="sk-time"></span>
          <span class="sk-lines"><span class="sk-line w70"></span><span class="sk-line w45"></span></span>
        </div>
      {/each}
    </div>
  {:else if errorMessage}
    <div class="guide-note error" role="alert">
      <span class="note-mark" aria-hidden="true"><AlertCircle size={15} /></span>
      <span class="note-text">{errorMessage}</span>
      <button class="note-retry" type="button" onclick={onretry}>
        <RefreshCw size={13} /> Retry
      </button>
    </div>
  {:else if upcomingEntries.length === 0}
    <div class="guide-note" role="status">
      <span class="note-text">No upcoming programmes listed for this channel right now.</span>
    </div>
  {:else}
    <ol class="guide-list">
      {#each upcomingEntries as entry (entry.startSeconds + ':' + entry.title)}
        {@const status = statusOf(entry)}
        <li class="guide-row {status}" class:is-current={status === 'current'}>
          <span class="row-time" aria-hidden="true">
            <Clock3 size={12} />
            {timeLabel(entry)}
          </span>
          <span class="row-copy">
            <span class="row-title">
              {entry.title}
              {#if status === 'current'}<span class="on-air" aria-label="Currently on air">On air</span>{/if}
            </span>
            {#if entry.description}
              <span class="row-desc">{entry.description}</span>
            {/if}
            {#if entry.category}
              <span class="row-cat">{entry.category}</span>
            {/if}
          </span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .ltv-guide { display: grid; gap: 12px; min-width: 0; }

  .guide-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .ltv-section-title {
    margin: 0;
    color: var(--color-text);
    font-size: clamp(1.05rem, 1.6vw, 1.3rem);
    font-weight: 800;
    letter-spacing: -.02em;
    line-height: 1.1;
  }
  .guide-count {
    color: var(--color-text-deep);
    font-size: .7rem;
    font-weight: 700;
    white-space: nowrap;
  }

  .guide-list {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    min-width: 0;
    list-style: none;
  }

  .guide-row {
    display: grid;
    grid-template-columns: minmax(96px, auto) 1fr;
    gap: 12px;
    align-items: start;
    min-width: 0;
    padding: 12px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .guide-row.is-current {
    border-color: var(--color-primary-border);
    background: linear-gradient(160deg, var(--color-primary-soft), var(--color-surface) 60%);
    box-shadow: var(--glow-primary);
  }

  .row-time {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding-top: 2px;
    color: var(--color-text-deep);
    font-size: .7rem;
    font-weight: 700;
    white-space: nowrap;
  }
  .guide-row.is-current .row-time { color: var(--color-primary); }

  .row-copy { display: grid; gap: 4px; min-width: 0; }
  .row-title {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    color: var(--color-text);
    font-size: .84rem;
    font-weight: 700;
    letter-spacing: -.01em;
    line-height: 1.35;
  }
  .row-desc {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    color: var(--color-text-muted);
    font-size: .74rem;
    line-height: 1.5;
    text-wrap: pretty;
  }
  .row-cat {
    color: var(--color-text-deep);
    font-size: .66rem;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
  }

  .on-air {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border: 1px solid rgba(255, 77, 109, .35);
    border-radius: 999px;
    color: #ff8fa3;
    background: rgba(255, 77, 109, .1);
    font-size: .56rem;
    font-weight: 800;
    letter-spacing: .12em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .guide-note {
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
  .guide-note.error { border-color: rgba(255, 77, 109, .28); color: var(--color-text); }
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

  .guide-row.skeleton { grid-template-columns: 110px 1fr; align-items: center; }
  .sk-time { display: block; width: 84px; height: 10px; border-radius: 5px; background: var(--color-surface-raised); }
  .sk-lines { display: grid; gap: 8px; }
  .sk-line {
    display: block;
    height: 11px;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--color-surface-raised), var(--color-surface-elevated), var(--color-surface-raised));
    background-size: 200% 100%;
    animation: ltv-shimmer 1.6s ease-in-out infinite;
  }
  .sk-line.w70 { width: 70%; }
  .sk-line.w45 { width: 45%; }
  @keyframes ltv-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  @media (max-width: 640px) {
    .guide-row { grid-template-columns: 1fr; gap: 6px; padding: 11px 12px; }
    .row-time { padding-top: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .sk-line { animation: none; }
  }
</style>
