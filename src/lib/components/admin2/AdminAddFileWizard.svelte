<script lang="ts" module>
  /**
   * MAV-FOCUSED — Shared Add File / Update Link wizard (Phase 3+7, 2026-10).
   *
   * Extracted from AdminMediaList.svelte so both Media Library and Missing
   * Media use the SAME manual-link workflow:
   *
   *   TMDB search → [episode selection for series/anime] → provider selection → reference entry → save
   *
   * The wizard calls /api/admin/media/manual-link (the secure endpoint
   * that resolves canonical identity server-side via CanonicalMediaService).
   * No provider inventory API calls, no upload, no Hosting Control.
   *
   * Props:
   *   open              — bind to control visibility.
   *   providers         — provider source list (same shape as Media Library).
   *   preselectedMediaItem — optional: when provided, the wizard SKIPS the
   *                        TMDB search step and goes directly to provider
   *                        selection. Used by Missing Media (the demand
   *                        row already knows the title + contentType +
   *                        tmdbId + season + episode + episodeTitle).
   *   updateTarget      — optional: when provided, the wizard is in
   *                        "Update link" mode — pre-fills with the
   *                        current provider + reference so the admin
   *                        can change them. Used by Media Library's
   *                        three-dot menu → "Update link".
   *   onclose           — called when the wizard is closed (cancel, X,
   *                        overlay click, or Escape).
   *   onsaved           — called on successful save with the mediaAssetId.
   *                        The parent should refresh its list.
   */

  export type PreselectedMediaItem = {
    title: string;
    contentType: string;  // 'movie' | 'series' | 'anime'
    tmdbId: string;
    season?: number | null;
    episode?: number | null;
    episodeTitle?: string | null;
    year?: number | null;
  };

  export type UpdateTarget = {
    mediaAssetId: string;
    title: string;
    contentType: string;
    tmdbId: string;
    providerName: string;
    providerAssetId: string;
  };

  export type TmdbResult = {
    id: string;
    tmdbId: string;
    title: string;
    year?: number;
    poster?: string;
    type: 'movie' | 'series' | 'anime';
    overview?: string;
  };

  export type SeasonInfo = {
    number: number;
    title: string;
    episodeCount: number;
    airDate?: string;
  };

  export type EpisodeInfo = {
    number: number;
    title: string;
    airDate?: string;
    still?: string;
  };
</script>

<script lang="ts">
  import { Search, X, Loader2, Film, Tv, Sparkles, AlertCircle, Check, ChevronRight, Image as ImageIcon } from 'lucide-svelte';

  // --- Props ---
  let {
    open = $bindable(false),
    providers = [] as Array<{ adapterId: string; name: string; sourceId: string }>,
    preselectedMediaItem = null as PreselectedMediaItem | null,
    updateTarget = null as UpdateTarget | null,
    onclose = undefined as (() => void) | undefined,
    onsaved = undefined as ((mediaAssetId: string) => void) | undefined,
  }: {
    open?: boolean;
    providers?: Array<{ adapterId: string; name: string; sourceId: string }>;
    preselectedMediaItem?: PreselectedMediaItem | null;
    updateTarget?: UpdateTarget | null;
    onclose?: (() => void) | undefined;
    onsaved?: ((mediaAssetId: string) => void) | undefined;
  } = $props();

  // --- Wizard state ---
  let wizardStep = $state<'search' | 'episode' | 'provider' | 'reference' | 'saving'>('search');
  let tmdbQuery = $state('');
  let tmdbType = $state<'movie' | 'series'>('movie');
  let isAnimeChoice = $state(false);
  let tmdbSearching = $state(false);
  let tmdbResults = $state<TmdbResult[]>([]);
  let tmdbError = $state<string | null>(null);
  let tmdbDebounce: ReturnType<typeof setTimeout> | null = null;
  let selectedTmdb = $state<TmdbResult | null>(null);
  let selectedProvider = $state<'vidara' | 'abyss' | null>(null);
  let providerReference = $state('');
  let referenceError = $state<string | null>(null);
  let saving = $state(false);
  let saveError = $state<string | null>(null);

  // --- Episode selection state ---
  let seasonsLoading = $state(false);
  let seasonsError = $state<string | null>(null);
  let seasons = $state<SeasonInfo[]>([]);
  let selectedSeason = $state<number | null>(null);
  let episodesLoading = $state(false);
  let episodesError = $state<string | null>(null);
  let episodes = $state<EpisodeInfo[]>([]);
  let selectedEpisode = $state<EpisodeInfo | null>(null);
  let seasonFetchToken = 0;
  let episodeFetchToken = 0;

  // --- TMDB image helper ---
  const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';
  function posterUrl(path?: string): string | null {
    if (!path) return null;
    if (path.startsWith('http')) return path;
    return `${TMDB_IMAGE_BASE}${path}`;
  }

  // --- React to open / preselectedMediaItem / updateTarget changes ---
  $effect(() => {
    if (open) {
      resetWizard();
      if (updateTarget) {
        selectedTmdb = {
          id: `${updateTarget.contentType === 'anime' ? 'series' : updateTarget.contentType}-${updateTarget.tmdbId}`,
          tmdbId: updateTarget.tmdbId,
          title: updateTarget.title,
          type: updateTarget.contentType === 'movie' ? 'movie' : 'series',
        };
        isAnimeChoice = updateTarget.contentType === 'anime';
        selectedProvider = updateTarget.providerName.toLowerCase().includes('vidara') ? 'vidara'
          : updateTarget.providerName.toLowerCase().includes('abyss') ? 'abyss' : null;
        providerReference = updateTarget.providerAssetId;
        wizardStep = 'search';
      } else if (preselectedMediaItem) {
        selectedTmdb = {
          id: `${preselectedMediaItem.contentType === 'anime' ? 'series' : preselectedMediaItem.contentType}-${preselectedMediaItem.tmdbId}`,
          tmdbId: preselectedMediaItem.tmdbId,
          title: preselectedMediaItem.title,
          year: preselectedMediaItem.year ?? undefined,
          type: preselectedMediaItem.contentType === 'movie' ? 'movie' : 'series',
        };
        isAnimeChoice = preselectedMediaItem.contentType === 'anime';
        // If the preselected item has season+episode, set them.
        if (preselectedMediaItem.season != null) selectedSeason = preselectedMediaItem.season;
        if (preselectedMediaItem.episode != null) {
          selectedEpisode = {
            number: preselectedMediaItem.episode,
            title: preselectedMediaItem.episodeTitle ?? `Episode ${preselectedMediaItem.episode}`,
          };
        }
        wizardStep = 'provider';
      } else {
        wizardStep = 'search';
      }
    }
  });

  // --- TMDB Search ---
  function onTmdbInput() {
    if (tmdbDebounce) clearTimeout(tmdbDebounce);
    tmdbDebounce = setTimeout(() => void doTmdbSearch(), 300);
  }

  async function doTmdbSearch() {
    const q = tmdbQuery.trim();
    if (!q) { tmdbResults = []; return; }
    tmdbSearching = true;
    tmdbError = null;
    try {
      const res = await fetch(`/api/admin/media/search?q=${encodeURIComponent(q)}&type=${tmdbType}`);
      const json = await res.json();
      if (json.ok) {
        tmdbResults = (json.results ?? []).map((r: any) => ({
          id: r.id,
          tmdbId: String(r.id).replace(/^(movie|series|anime)-/, ''),
          title: r.title,
          year: r.year,
          poster: r.poster,
          type: r.type ?? (tmdbType === 'movie' ? 'movie' : 'series'),
          overview: r.overview ?? r.description,
        }));
      } else {
        tmdbResults = [];
        tmdbError = json.error?.message ?? 'Search failed.';
      }
    } catch (err) {
      tmdbResults = [];
      tmdbError = err instanceof Error ? err.message : 'Search failed.';
    } finally {
      tmdbSearching = false;
    }
  }

  function selectTmdb(result: TmdbResult) {
    selectedTmdb = result;
    selectedEpisode = null;
    selectedSeason = null;
    episodes = [];
    seasons = [];
    // For movies, skip episode selection. For series/anime, go to episode step.
    if (result.type === 'movie') {
      wizardStep = 'provider';
    } else {
      wizardStep = 'episode';
      void loadSeasons(result.tmdbId);
    }
  }

  // --- Season + Episode loading ---
  async function loadSeasons(tmdbId: string) {
    const token = ++seasonFetchToken;
    seasonsLoading = true;
    seasonsError = null;
    seasons = [];
    try {
      // Fetch the series detail to get seasons list.
      // The detail endpoint returns seasonsData with season metadata.
      const res = await fetch(`/api/content/series/${encodeURIComponent(`series-${tmdbId}`)}`);
      if (!res.ok) throw new Error(`Failed to load seasons (HTTP ${res.status}).`);
      const json = await res.json();
      const seasonsData = json.seasonsData ?? json.seasons_list ?? [];
      if (token !== seasonFetchToken) return; // stale
      if (Array.isArray(seasonsData) && seasonsData.length > 0) {
        seasons = seasonsData.map((s: any) => ({
          number: s.number ?? s.season_number ?? 0,
          title: s.title ?? s.name ?? `Season ${s.number ?? s.season_number ?? 0}`,
          episodeCount: s.episodeCount ?? s.episode_count ?? 0,
          airDate: s.airDate ?? s.air_date,
        }));
        // Auto-select the first non-specials season.
        const firstRegular = seasons.find(s => s.number > 0) ?? seasons[0];
        if (firstRegular) {
          selectedSeason = firstRegular.number;
          void loadEpisodes(tmdbId, firstRegular.number);
        }
      } else {
        seasonsError = 'No seasons found for this title. You can still link at the series level.';
      }
    } catch (err) {
      if (token !== seasonFetchToken) return;
      seasonsError = err instanceof Error ? err.message : 'Failed to load seasons.';
    } finally {
      if (token === seasonFetchToken) seasonsLoading = false;
    }
  }

  async function loadEpisodes(tmdbId: string, seasonNumber: number) {
    const token = ++episodeFetchToken;
    episodesLoading = true;
    episodesError = null;
    episodes = [];
    selectedEpisode = null;
    try {
      const res = await fetch(`/api/content/series/${encodeURIComponent(`series-${tmdbId}`)}/season/${seasonNumber}`);
      if (!res.ok) throw new Error(`Failed to load episodes (HTTP ${res.status}).`);
      const json = await res.json();
      if (token !== episodeFetchToken) return; // stale
      const eps = json.episodes ?? [];
      if (Array.isArray(eps) && eps.length > 0) {
        episodes = eps.map((e: any) => ({
          number: e.number ?? e.episode_number ?? 0,
          title: e.title ?? e.name ?? `Episode ${e.number ?? e.episode_number ?? 0}`,
          airDate: e.airDate ?? e.air_date,
          still: e.still ?? (e.still_path ? `https://image.tmdb.org/t/p/w300${e.still_path}` : undefined),
        }));
      } else {
        episodesError = 'No episodes found for this season. You can still link at the series level.';
      }
    } catch (err) {
      if (token !== episodeFetchToken) return;
      episodesError = err instanceof Error ? err.message : 'Failed to load episodes.';
    } finally {
      if (token === episodeFetchToken) episodesLoading = false;
    }
  }

  function selectSeason(seasonNumber: number) {
    selectedSeason = seasonNumber;
    selectedEpisode = null;
    if (selectedTmdb) {
      void loadEpisodes(selectedTmdb.tmdbId, seasonNumber);
    }
  }

  function selectEpisode(ep: EpisodeInfo) {
    selectedEpisode = ep;
  }

  function skipEpisodeSelection() {
    selectedEpisode = null;
    selectedSeason = null;
    wizardStep = 'provider';
  }

  // --- Provider selection ---
  function selectProvider(p: 'vidara' | 'abyss') {
    selectedProvider = p;
    wizardStep = 'reference';
  }

  // --- Save ---
  async function saveLink() {
    if (!selectedTmdb || !selectedProvider || !providerReference.trim()) return;

    const ref = providerReference.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(ref) && !ref.startsWith('http')) {
      referenceError = 'Reference must be alphanumeric (filecode/ID) or a full URL.';
      return;
    }
    referenceError = null;

    saving = true;
    saveError = null;
    try {
      // Determine the contentType: if the admin chose anime, use 'anime';
      // otherwise use the TMDB type. For series, the admin may choose anime.
      const contentType = isAnimeChoice ? 'anime' : (selectedTmdb.type === 'movie' ? 'movie' : 'series');
      const body: Record<string, string> = {
        contentType,
        tmdbId: selectedTmdb.tmdbId,
        provider: selectedProvider,
        reference: ref,
        title: selectedTmdb.title,
      };
      if (selectedTmdb.year != null) {
        body.year = String(selectedTmdb.year);
      }
      // Pass season + episode from the wizard's episode selection.
      if (selectedSeason != null) {
        body.season = String(selectedSeason);
      }
      if (selectedEpisode != null) {
        body.episode = String(selectedEpisode.number);
        if (selectedEpisode.title) {
          body.episodeTitle = selectedEpisode.title;
        }
      }
      // Also handle preselectedMediaItem (Missing Media flow).
      if (!selectedSeason && preselectedMediaItem?.season != null) {
        body.season = String(preselectedMediaItem.season);
      }
      if (!selectedEpisode && preselectedMediaItem?.episode != null) {
        body.episode = String(preselectedMediaItem.episode);
        if (preselectedMediaItem.episodeTitle) {
          body.episodeTitle = preselectedMediaItem.episodeTitle;
        }
      }
      // Pass poster path if available from search results.
      if (selectedTmdb.poster) {
        // Extract the relative path from the full URL.
        const match = selectedTmdb.poster.match(/\/p\/\w+\//);
        if (match) {
          const relativePath = selectedTmdb.poster.substring(selectedTmdb.poster.indexOf(match[0]) + match[0].length);
          if (relativePath) body.posterPath = relativePath;
        }
      }

      if (updateTarget) {
        body.mediaAssetId = updateTarget.mediaAssetId;
      }

      const res = await fetch('/api/admin/media/manual-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.ok) {
        const savedId = json.mediaAssetId as string;
        closeWizard();
        onsaved?.(savedId);
      } else {
        saveError = json.error?.message ?? 'Save failed.';
      }
    } catch (err) {
      saveError = err instanceof Error ? err.message : 'Network error during save.';
    } finally {
      saving = false;
    }
  }

  // --- Wizard control ---
  function resetWizard() {
    wizardStep = 'search';
    tmdbQuery = '';
    tmdbResults = [];
    tmdbError = null;
    tmdbSearching = false;
    selectedTmdb = null;
    selectedProvider = null;
    providerReference = '';
    referenceError = null;
    saveError = null;
    saving = false;
    isAnimeChoice = false;
    seasons = [];
    selectedSeason = null;
    seasonsLoading = false;
    seasonsError = null;
    episodes = [];
    selectedEpisode = null;
    episodesLoading = false;
    episodesError = null;
    if (tmdbDebounce) { clearTimeout(tmdbDebounce); tmdbDebounce = null; }
  }

  function closeWizard() {
    open = false;
    resetWizard();
    onclose?.();
  }

  // --- Helpers ---
  function contentTypeLabel(type: string): string {
    return type === 'movie' ? 'Movie' : type === 'series' ? 'TV Series' : type === 'anime' ? 'Anime' : type;
  }

  // Computed: is this a series-like title that needs episode selection?
  function needsEpisodeSelection(): boolean {
    if (!selectedTmdb) return false;
    return selectedTmdb.type !== 'movie';
  }
</script>

{#if open}
  <div class="wizard-overlay" onclick={closeWizard} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <div class="wizard-head">
        <h2 id="wizard-title">{updateTarget ? 'Update link' : 'Add file'}</h2>
        <button type="button" class="wizard-close" onclick={closeWizard} aria-label="Close"><X size={16} /></button>
      </div>

      {#if saveError}
        <div class="wizard-error" role="alert"><AlertCircle size={14} /> {saveError}</div>
      {/if}

      <!-- Step 1: TMDB Search -->
      {#if wizardStep === 'search'}
        <div class="wizard-step">
          <div class="step-label">Step 1 — Search for a title</div>
          <div class="search-bar">
            <div class="type-toggle" role="radiogroup" aria-label="Search type">
              <button type="button" class:active={tmdbType === 'movie'} onclick={() => tmdbType = 'movie'} role="radio" aria-checked={tmdbType === 'movie'}>Movie</button>
              <button type="button" class:active={tmdbType === 'series'} onclick={() => tmdbType = 'series'} role="radio" aria-checked={tmdbType === 'series'}>Series</button>
            </div>
            <div class="search-input-wrap">
              <Search size={14} class="search-icon" />
              <input type="text" class="search-input" placeholder="Search TMDB by title…" bind:value={tmdbQuery} oninput={onTmdbInput} autocomplete="off" />
              {#if tmdbSearching}<Loader2 size={14} class="spinner" />{/if}
            </div>
          </div>

          {#if updateTarget && selectedTmdb}
            <div class="current-selection">
              <span>Current: <strong>{selectedTmdb.title}</strong></span>
              <button type="button" class="skip-btn" onclick={() => { wizardStep = needsEpisodeSelection() ? 'episode' : 'provider'; }}>Keep current →</button>
            </div>
          {/if}

          <div class="results-list">
            {#if tmdbError}
              <div class="results-empty"><AlertCircle size={14} /> {tmdbError}</div>
            {:else if tmdbResults.length === 0 && !tmdbSearching}
              <div class="results-empty">{tmdbQuery.trim() ? `No results for "${tmdbQuery}".` : 'Start typing to search TMDB.'}</div>
            {/if}
            {#each tmdbResults as result (result.id)}
              <button type="button" class="result-row" class:selected={selectedTmdb?.tmdbId === result.tmdbId} onclick={() => selectTmdb(result)}>
                <div class="result-poster">
                  {#if posterUrl(result.poster)}
                    <img src={posterUrl(result.poster)} alt={result.title} loading="lazy" />
                  {:else}
                    {#if result.type === 'movie'}<Film size={14} />{:else if result.type === 'anime'}<Sparkles size={14} />{:else}<Tv size={14} />{/if}
                  {/if}
                </div>
                <div class="result-info">
                  <div class="result-title">{result.title}</div>
                  <div class="result-meta"><span>{result.type}</span>{#if result.year}<span>· {result.year}</span>{/if}<span>· TMDB {result.tmdbId}</span></div>
                </div>
                {#if selectedTmdb?.tmdbId === result.tmdbId}<span class="result-check"><Check size={14} /></span>{/if}
              </button>
            {/each}
          </div>

          {#if selectedTmdb}
            <!-- Anime classification toggle for series results -->
            {#if tmdbType === 'series'}
              <label class="anime-toggle">
                <input type="checkbox" bind:checked={isAnimeChoice} />
                <span>Classify as Anime (uses anime canonical identity)</span>
              </label>
            {/if}
            <div class="wizard-footer">
              <button type="button" class="btn btn-next" onclick={() => { wizardStep = needsEpisodeSelection() ? 'episode' : 'provider'; }}>
                Continue <ChevronRight size={14} />
              </button>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Step 1.5: Episode Selection (series/anime only) -->
      {#if wizardStep === 'episode'}
        <div class="wizard-step">
          <div class="step-label">Step 2 — Select episode</div>
          <div class="selected-title-bar">
            <span>Linking: <strong>{selectedTmdb?.title}</strong>{#if isAnimeChoice} (Anime){/if}</span>
            <button type="button" class="change-btn" onclick={() => { wizardStep = 'search'; }}>Change</button>
          </div>

          {#if seasonsLoading}
            <div class="results-empty"><Loader2 size={14} class="spinner" /> Loading seasons…</div>
          {:else if seasonsError}
            <div class="results-empty"><AlertCircle size={14} /> {seasonsError}</div>
          {:else if seasons.length > 0}
            <div class="season-selector">
              <label class="ref-label" for="season-select">Season</label>
              <select id="season-select" class="ref-input" value={selectedSeason} onchange={(e) => selectSeason(Number((e.target as HTMLSelectElement).value))}>
                {#each seasons as s}
                  <option value={s.number}>{s.title} ({s.episodeCount} episodes)</option>
                {/each}
              </select>
            </div>

            {#if episodesLoading}
              <div class="results-empty"><Loader2 size={14} class="spinner" /> Loading episodes…</div>
            {:else if episodesError}
              <div class="results-empty"><AlertCircle size={14} /> {episodesError}</div>
            {:else if episodes.length > 0}
              <div class="results-list">
                {#each episodes as ep (ep.number)}
                  <button type="button" class="result-row" class:selected={selectedEpisode?.number === ep.number} onclick={() => selectEpisode(ep)}>
                    <div class="episode-number">E{String(ep.number).padStart(2, '0')}</div>
                    <div class="result-info">
                      <div class="result-title">{ep.title}</div>
                      <div class="result-meta">{#if ep.airDate}<span>{ep.airDate}</span>{/if}</div>
                    </div>
                    {#if selectedEpisode?.number === ep.number}<span class="result-check"><Check size={14} /></span>{/if}
                  </button>
                {/each}
              </div>
            {/if}
          {/if}

          {#if selectedEpisode}
            <div class="current-selection">
              <span>Selected: <strong>{selectedTmdb?.title}</strong> — S{String(selectedSeason).padStart(2, '0')}E{String(selectedEpisode.number).padStart(2, '0')} — {selectedEpisode.title}</span>
            </div>
          {/if}

          <div class="wizard-footer">
            <button type="button" class="btn btn-back" onclick={() => { wizardStep = 'search'; }}>Back</button>
            <button type="button" class="btn btn-link-series" onclick={skipEpisodeSelection}>Link at series level</button>
            {#if selectedEpisode}
              <button type="button" class="btn btn-next" onclick={() => { wizardStep = 'provider'; }}>
                Continue <ChevronRight size={14} />
              </button>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Step 2/3: Provider Selection -->
      {#if wizardStep === 'provider'}
        <div class="wizard-step">
          <div class="step-label">{needsEpisodeSelection() ? 'Step 3' : 'Step 2'} — Select the host</div>
          <div class="selected-title-bar">
            <span>Linking: <strong>{selectedTmdb?.title}</strong>{#if selectedEpisode} — S{String(selectedSeason).padStart(2, '0')}E{String(selectedEpisode.number).padStart(2, '0')}{/if}</span>
            <button type="button" class="change-btn" onclick={() => { wizardStep = needsEpisodeSelection() ? 'episode' : 'search'; }}>Change</button>
          </div>
          <div class="provider-cards">
            <button type="button" class="provider-card" class:selected={selectedProvider === 'vidara'} onclick={() => selectProvider('vidara')}>
              <div class="provider-name">Vidara</div>
              <div class="provider-desc">Filecode or embed URL from vidara.to</div>
            </button>
            <button type="button" class="provider-card" class:selected={selectedProvider === 'abyss'} onclick={() => selectProvider('abyss')}>
              <div class="provider-name">Abyss</div>
              <div class="provider-desc">Resource ID or player URL from abyss.to</div>
            </button>
          </div>
          <div class="wizard-footer">
            <button type="button" class="btn btn-back" onclick={() => { wizardStep = needsEpisodeSelection() ? 'episode' : 'search'; }}>Back</button>
          </div>
        </div>
      {/if}

      <!-- Step 3/4: Reference Entry -->
      {#if wizardStep === 'reference'}
        <div class="wizard-step">
          <div class="step-label">{needsEpisodeSelection() ? 'Step 4' : 'Step 3'} — Enter the file reference</div>
          <div class="selected-title-bar">
            <span>Linking: <strong>{selectedTmdb?.title}</strong>{#if selectedEpisode} — S{String(selectedSeason).padStart(2, '0')}E{String(selectedEpisode.number).padStart(2, '0')}{/if} · {selectedProvider}</span>
            <button type="button" class="change-btn" onclick={() => { wizardStep = 'provider'; }}>Change</button>
          </div>
          <div class="ref-input-section">
            <label class="ref-label" for="ref-input">
              {selectedProvider === 'vidara' ? 'Vidara filecode or URL' : 'Abyss resource ID or URL'}
            </label>
            <input
              id="ref-input"
              type="text"
              class="ref-input"
              bind:value={providerReference}
              oninput={() => { referenceError = null; }}
              placeholder={selectedProvider === 'vidara' ? 'e.g. Vw0hY4n13k83 or https://vidara.to/e/Vw0hY4n13k83' : 'e.g. ltJEfKQxR or https://player.abyssplayer.com/ltJEfKQxR'}
              autocomplete="off"
            />
            <p class="ref-hint">
              {selectedProvider === 'vidara'
                ? 'Upload your video on the Vidara dashboard, then copy the filecode from the share/embed URL.'
                : 'Upload your video on the Abyss dashboard, then copy the resource ID from the player URL.'}
            </p>
            {#if referenceError}
              <p class="ref-error"><AlertCircle size={12} /> {referenceError}</p>
            {/if}
          </div>
          <div class="wizard-footer">
            <button type="button" class="btn btn-back" onclick={() => { wizardStep = 'provider'; }}>Back</button>
            <button type="button" class="btn btn-save" onclick={saveLink} disabled={saving || !providerReference.trim()}>
              {#if saving}<Loader2 size={12} class="spinner" /> Saving…{:else}{updateTarget ? 'Update' : 'Save'}{/if}
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .wizard-overlay { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; }
  .wizard { position: relative; z-index: 91; width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 64px); display: flex; flex-direction: column; background: var(--a2-surface-2, #1a1a1a); border: 1px solid var(--a2-border-strong, #333); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); overflow: hidden; }
  .wizard-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--a2-border, #222); }
  .wizard-head h2 { margin: 0; font-size: 1rem; font-weight: 700; color: var(--a2-text-bright, #f0f0f0); }
  .wizard-close { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--a2-text-muted, #888); cursor: pointer; }
  .wizard-close:hover { background: var(--a2-surface-3, #222); color: var(--a2-text, #ddd); }

  .wizard-error { padding: 8px 12px; margin: 8px 20px; border: 1px solid rgba(220,60,60,0.3); border-radius: 8px; background: rgba(220,60,60,0.08); color: #c44; font-size: 0.75rem; display: flex; align-items: center; gap: 6px; }

  .wizard-step { padding: 0 20px 8px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
  .step-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--a2-text-muted, #888); margin-top: 12px; }

  .search-bar { display: flex; flex-direction: column; gap: 8px; }
  .type-toggle { display: inline-flex; gap: 2px; border: 1px solid var(--a2-border, #222); border-radius: 8px; overflow: hidden; align-self: flex-start; }
  .type-toggle button { padding: 5px 12px; border: 0; background: transparent; color: var(--a2-text-muted, #888); font-size: 0.7rem; font-weight: 600; cursor: pointer; }
  .type-toggle button.active { background: rgba(0,200,200,0.12); color: #0ff; }
  .search-input-wrap { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 38px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 8px; }
  .search-input-wrap:focus-within { border-color: #0ff; }
  .search-input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--a2-text, #ddd); font-size: 0.82rem; }
  .search-input::placeholder { color: var(--a2-text-dim, #555); }
  .search-icon { color: var(--a2-text-dim, #555); flex-shrink: 0; }
  .spinner { animation: spin 1s linear infinite; }

  .current-selection { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; background: rgba(0,200,200,0.08); border-radius: 6px; font-size: 0.75rem; color: var(--a2-text, #ddd); }
  .skip-btn { background: transparent; border: 0; color: #0ff; font-size: 0.7rem; font-weight: 600; cursor: pointer; text-decoration: underline; white-space: nowrap; }

  .results-list { max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .results-empty { padding: 20px; text-align: center; color: var(--a2-text-dim, #555); font-size: 0.8rem; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .result-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 8px; cursor: pointer; text-align: left; transition: border-color 140ms ease; }
  .result-row:hover { border-color: rgba(0,255,255,0.3); }
  .result-row.selected { border-color: #0ff; background: rgba(0,255,255,0.08); }

  .result-poster { width: 34px; height: 51px; flex-shrink: 0; border-radius: 4px; overflow: hidden; display: grid; place-items: center; background: var(--a2-surface-4, #2a2a2a); color: var(--a2-text-dim, #555); }
  .result-poster img { width: 100%; height: 100%; object-fit: cover; }

  .episode-number { font-size: 0.7rem; font-weight: 700; color: #0ff; min-width: 36px; text-align: center; flex-shrink: 0; }

  .result-info { flex: 1; min-width: 0; }
  .result-title { font-size: 0.8rem; color: var(--a2-text-bright, #f0f0f0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-meta { display: flex; gap: 4px; font-size: 0.6rem; color: var(--a2-text-dim, #555); text-transform: uppercase; letter-spacing: 0.04em; }
  .result-check { color: #0ff; flex-shrink: 0; }

  .anime-toggle { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: rgba(168,85,247,0.08); border: 1px solid rgba(168,85,247,0.2); border-radius: 8px; font-size: 0.75rem; color: var(--a2-text, #ddd); cursor: pointer; }
  .anime-toggle input { accent-color: #a855f7; }

  .season-selector { display: flex; flex-direction: column; gap: 6px; }

  .selected-title-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; background: rgba(0,200,200,0.08); border-radius: 6px; font-size: 0.78rem; color: var(--a2-text, #ddd); }
  .change-btn { background: transparent; border: 0; color: #0ff; font-size: 0.7rem; font-weight: 600; cursor: pointer; text-decoration: underline; white-space: nowrap; }

  .provider-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .provider-card { display: flex; flex-direction: column; gap: 4px; padding: 14px; border: 1px solid var(--a2-border, #222); border-radius: 8px; background: var(--a2-surface-3, #1a1a1a); cursor: pointer; text-align: left; transition: border-color 140ms ease; }
  .provider-card:hover { border-color: rgba(0,255,255,0.3); }
  .provider-card.selected { border-color: #0ff; background: rgba(0,255,255,0.08); }
  .provider-name { font-size: 0.9rem; font-weight: 700; color: var(--a2-text-bright, #f0f0f0); }
  .provider-desc { font-size: 0.65rem; color: var(--a2-text-dim, #555); }

  .ref-input-section { display: flex; flex-direction: column; gap: 6px; }
  .ref-label { font-size: 0.75rem; font-weight: 600; color: var(--a2-text, #ddd); }
  .ref-input { height: 40px; padding: 0 12px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 8px; color: var(--a2-text, #ddd); font-size: 0.82rem; outline: 0; }
  .ref-input:focus { border-color: #0ff; }
  .ref-hint { margin: 0; font-size: 0.65rem; color: var(--a2-text-dim, #555); line-height: 1.4; }
  .ref-error { margin: 0; font-size: 0.65rem; color: #c44; display: flex; align-items: center; gap: 4px; }

  .wizard-footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 8px; flex-wrap: wrap; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid transparent; border-radius: 8px; font-size: 0.78rem; font-weight: 700; cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-next { background: rgba(0,200,200,0.12); border-color: rgba(0,200,200,0.3); color: #0ff; }
  .btn-next:hover { background: rgba(0,200,200,0.2); }
  .btn-back { background: var(--a2-surface-3, #1a1a1a); border-color: var(--a2-border, #222); color: var(--a2-text-muted, #888); }
  .btn-back:hover { color: var(--a2-text, #ddd); }
  .btn-save { background: rgba(53,214,143,0.12); border-color: rgba(53,214,143,0.3); color: #35d68f; }
  .btn-save:hover { background: rgba(53,214,143,0.2); }
  .btn-link-series { background: transparent; border-color: var(--a2-border, #222); color: var(--a2-text-muted, #888); font-size: 0.7rem; }
  .btn-link-series:hover { color: var(--a2-text, #ddd); border-color: var(--a2-border-strong, #444); }

  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

  @media (max-width: 640px) {
    .provider-cards { grid-template-columns: 1fr; }
    .wizard-footer { flex-direction: column-reverse; }
    .btn { width: 100%; justify-content: center; }
  }
</style>
