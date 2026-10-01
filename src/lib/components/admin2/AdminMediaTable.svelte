<script lang="ts">
  /**
   * Admin 2.0 — Phase C — AdminMediaTable
   *
   * Dense desktop results table. Each row is one canonical media item
   * with a nested provider-availability summary (Vidara status pill +
   * Abyss status pill). Clicking a row opens the detail drawer.
   *
   * Mobile does NOT use this component — AdminMediaCard handles
   * the narrow viewport. See plan §26 for the responsive data-view
   * strategy.
   */
  import { Film, Tv, Sparkles, ArrowRight } from 'lucide-svelte';
  import AdminAssetStatus from './AdminAssetStatus.svelte';
  import type { LibraryMediaItem } from '$lib/server/hosting/library/service';
  import { adapterIdForSource } from '$lib/shared/hosting-source-helpers';

  let {
    items = [] as LibraryMediaItem[],
    loading = false,
    selectedId = null as string | null,
    onselect = (() => {}) as (item: LibraryMediaItem) => void,
    hostingSources = [] as Array<{ id: string; name: string; adapterId: string | null }>,
  }: {
    items?: LibraryMediaItem[];
    loading?: boolean;
    selectedId?: string | null;
    onselect?: (item: LibraryMediaItem) => void;
    hostingSources?: Array<{ id: string; name: string; adapterId: string | null }>;
  } = $props();

  // Phase C audit fix: adapterIdForSource is now imported from the
  // shared $lib/shared/hosting-source-helpers module. This eliminates
  // the duplicated logic that existed in AdminMediaTable, AdminMediaCard,
  // and AdminMediaDetailDrawer. The shared helper is a pure function
  // over the hostingSources array — no DB access, no server imports.
  //
  // Local wrapper captures `hostingSources` so template call sites
  // don't need to pass it on every invocation.
  const resolveAdapter = (sourceId: string | null) => adapterIdForSource(hostingSources, sourceId);

  function formatYear(year: number | null): string {
    return year ? String(year) : '—';
  }

  function formatEpisode(season: number | null, episode: number | null): string {
    if (season == null && episode == null) return '';
    const s = season != null ? String(season).padStart(2, '0') : '—';
    const e = episode != null ? String(episode).padStart(2, '0') : '—';
    return `S${s}E${e}`;
  }

  function formatQualities(qualities: string[]): string {
    if (!qualities.length) return '';
    return qualities.slice(0, 3).join(' · ');
  }

  function formatAudio(audio: string[]): string {
    if (!audio.length) return '';
    if (audio.length === 1) return audio[0]!.toUpperCase();
    return `${audio[0]!.toUpperCase()} +${audio.length - 1}`;
  }

  function formatUpdated(iso: string): string {
    const date = new Date(iso);
    const now = Date.now();
    const diff = now - date.getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return date.toLocaleDateString();
  }

  function formatSize(bytes: number | null): string {
    if (!bytes) return '';
    if (bytes < 1_000_000) return `${Math.floor(bytes / 1000)} KB`;
    if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  }
</script>

<div class="media-table-wrap a2-scroll" role="region" aria-label="Media library results">
  {#if loading}
    <div class="media-table-loading">
      {#each Array(8) as _, i (i)}
        <div class="media-row-skeleton" aria-hidden="true"></div>
      {/each}
    </div>
  {:else if items.length === 0}
    <div class="media-table-empty">
      <div class="media-empty-icon"><Film size={20} /></div>
      <div class="media-empty-title">No media</div>
      <div class="media-empty-desc">No media items match the current filters.</div>
    </div>
  {:else}
    <table class="media-table">
      <thead>
        <tr>
          <th class="col-type">Type</th>
          <th class="col-title">Title</th>
          <th class="col-year">Year</th>
          <th class="col-vidara">Vidara</th>
          <th class="col-abyss">Abyss</th>
          <th class="col-qualities">Quality</th>
          <th class="col-audio">Audio</th>
          <th class="col-updated">Updated</th>
          <th class="col-arrow"></th>
        </tr>
      </thead>
      <tbody>
        {#each items as item (item.id)}
          {@const vidaraAsset = item.assets.find(a => resolveAdapter(a.provider_source_id) === 'vidara')}
          {@const abyssAsset = item.assets.find(a => resolveAdapter(a.provider_source_id) === 'abyss')}
          {@const Icon = item.content_type === 'movie' ? Film : item.content_type === 'anime' ? Sparkles : Tv}
          <tr
            class="media-row"
            class:selected={selectedId === item.id}
            onclick={() => onselect(item)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onselect(item); } }}
            tabindex="0"
            role="button"
            aria-label="Open detail for {item.title}"
          >
            <td class="col-type">
              <span class="type-pill type-{item.content_type}">
                <Icon size={11} />
                <span class="type-label">{item.content_type}</span>
              </span>
            </td>
            <td class="col-title">
              <div class="title-block">
                <div class="title-main">{item.title}</div>
                {#if item.episode_title}
                  <div class="title-episode">{item.episode_title}</div>
                {/if}
                {#if item.season != null || item.episode != null}
                  <div class="title-episode-code">{formatEpisode(item.season, item.episode)}</div>
                {/if}
                {#if item.demand && item.demand.request_count > 0 && item.demand.status === 'open'}
                  <div class="title-demand" title="Missing media demand — {item.demand.request_count} requests">
                    {item.demand.request_count} demand
                  </div>
                {/if}
              </div>
            </td>
            <td class="col-year">{formatYear(item.year)}</td>
            <td class="col-vidara">
              {#if vidaraAsset}
                <div class="provider-cell">
                  <AdminAssetStatus status={vidaraAsset.status} maveroStatus={vidaraAsset.mavero_status} />
                  {#if vidaraAsset.status === 'ready' && vidaraAsset.mavero_status === 'available'}
                    <div class="provider-meta">
                      {#if vidaraAsset.source_quality}<span>{vidaraAsset.source_quality}</span>{/if}
                      {#if vidaraAsset.audio_languages.length > 1}<span>· {vidaraAsset.audio_languages.length} audio</span>{/if}
                      {#if vidaraAsset.has_subtitles}<span>· subs</span>{/if}
                    </div>
                  {/if}
                </div>
              {:else}
                <div class="provider-cell provider-cell-empty">Not linked</div>
              {/if}
            </td>
            <td class="col-abyss">
              {#if abyssAsset}
                <div class="provider-cell">
                  <AdminAssetStatus status={abyssAsset.status} maveroStatus={abyssAsset.mavero_status} />
                  {#if abyssAsset.status === 'ready' && abyssAsset.mavero_status === 'available'}
                    <div class="provider-meta">
                      {#if abyssAsset.available_qualities.length}<span>{formatQualities(abyssAsset.available_qualities)}</span>{/if}
                      {#if abyssAsset.has_subtitles}<span>· subs</span>{/if}
                    </div>
                  {/if}
                </div>
              {:else}
                <div class="provider-cell provider-cell-empty">Not linked</div>
              {/if}
            </td>
            <td class="col-qualities">
              {#if vidaraAsset && vidaraAsset.source_quality}
                {vidaraAsset.source_quality}
              {:else if abyssAsset && abyssAsset.available_qualities.length}
                {formatQualities(abyssAsset.available_qualities)}
              {:else}
                <span class="cell-dim">—</span>
              {/if}
            </td>
            <td class="col-audio">
              {#if vidaraAsset && vidaraAsset.audio_languages.length}
                {formatAudio(vidaraAsset.audio_languages)}
              {:else if abyssAsset && abyssAsset.audio_languages.length}
                {formatAudio(abyssAsset.audio_languages)}
              {:else}
                <span class="cell-dim">—</span>
              {/if}
            </td>
            <td class="col-updated">{formatUpdated(item.updated_at)}</td>
            <td class="col-arrow">
              <span class="row-arrow"><ArrowRight size={14} /></span>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .media-table-wrap {
    width: 100%;
    overflow-x: auto;
  }

  .media-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm);
  }

  .media-table thead {
    background: var(--a2-surface-2);
    border-bottom: 1px solid var(--a2-border-strong);
  }
  .media-table th {
    padding: var(--a2-space-2) var(--a2-space-3);
    text-align: left;
    font-weight: 700;
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .col-type { width: 100px; }
  .col-title { min-width: 220px; }
  .col-year { width: 70px; }
  .col-vidara, .col-abyss { width: 160px; }
  .col-qualities, .col-audio { width: 110px; }
  .col-updated { width: 100px; }
  .col-arrow { width: 40px; }

  .media-row {
    border-bottom: 1px solid var(--a2-border);
    cursor: pointer;
    transition: background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .media-row:hover {
    background: var(--a2-surface-2);
  }
  .media-row.selected {
    background: var(--a2-cyan-soft);
  }
  .media-row.selected:hover {
    background: var(--a2-cyan-soft);
  }
  .media-row:focus-visible {
    outline: 2px solid var(--a2-cyan);
    outline-offset: -2px;
  }
  .media-row td {
    padding: var(--a2-space-3);
    vertical-align: middle;
  }

  .type-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: var(--a2-radius-xs);
    background: var(--a2-surface-3);
    color: var(--a2-text-muted);
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .type-pill.type-movie { color: var(--a2-cyan); }
  .type-pill.type-series { color: var(--a2-blue); }
  .type-pill.type-anime { color: var(--a2-amber); }
  .type-pill .type-label { font-size: 9px; }

  .title-block {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title-main {
    color: var(--a2-text-bright);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title-episode {
    color: var(--a2-text-muted);
    font-size: var(--a2-text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title-episode-code {
    color: var(--a2-text-dim);
    font-family: var(--a2-font-mono);
    font-size: var(--a2-text-2xs);
    letter-spacing: 0.04em;
  }
  .title-demand {
    display: inline-block;
    width: fit-content;
    margin-top: 2px;
    padding: 1px 6px;
    border-radius: var(--a2-radius-xs);
    background: var(--a2-amber-soft);
    border: 1px solid var(--a2-amber-border);
    color: var(--a2-amber);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .provider-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .provider-cell-empty {
    color: var(--a2-text-dim);
    font-size: var(--a2-text-xs);
    font-style: italic;
  }
  .provider-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    color: var(--a2-text-dim);
    font-size: 9px;
    font-family: var(--a2-font-mono);
  }

  .cell-dim {
    color: var(--a2-text-dim);
  }

  .row-arrow {
    display: inline-flex;
    color: var(--a2-text-dim);
    opacity: 0;
    transition: opacity var(--a2-motion-micro) var(--a2-ease-out),
                color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .media-row:hover .row-arrow {
    opacity: 1;
    color: var(--a2-cyan);
  }

  .media-table-loading {
    padding: var(--a2-space-3);
  }
  .media-row-skeleton {
    height: 44px;
    margin-bottom: var(--a2-space-2);
    border-radius: var(--a2-radius-sm);
    background: linear-gradient(90deg, var(--a2-surface-2) 0%, var(--a2-surface-3) 50%, var(--a2-surface-2) 100%);
    background-size: 200% 100%;
    animation: a2-row-skeleton 1.6s ease-in-out infinite;
  }
  @keyframes a2-row-skeleton {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  .media-table-empty {
    padding: var(--a2-space-10) var(--a2-space-4);
    text-align: center;
  }
  .media-empty-icon {
    display: inline-grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin-bottom: var(--a2-space-3);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-3);
    color: var(--a2-text-dim);
  }
  .media-empty-title {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text);
  }
  .media-empty-desc {
    font-size: var(--a2-text-xs);
    color: var(--a2-text-dim);
    margin-top: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .media-row { transition: none; }
    .media-row-skeleton { animation: none; }
    .row-arrow { transition: none; }
  }
</style>
