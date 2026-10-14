<script lang="ts" module>
  /**
   * Deep-audit Section 6 — Compact adaptive Add File / Update Link sheet.
   *
   * REPLACES the previous 4-step wizard (search → episode → provider →
   * reference). The owner explicitly does NOT want a multi-step wizard:
   *
   *   State 1 "search" — one screen with the explicit content-type choice
   *   (Movie / TV Series / Anime Movie / Anime Series — replaces the
   *   ambiguous anime checkbox), the TMDB search input, and the results.
   *
   *   State 2 "edit"   — reached AUTOMATICALLY when a result is selected
   *   (no Continue/Back screens): selected title + the single edit form
   *   (provider + reference for movies; provider + season + episode +
   *   reference for series/anime series). Every series/anime link
   *   identifies exactly ONE episode — the series-level option is gone.
   *
   * Data contracts (Issue A — the previously broken calls):
   *   - Seasons:  GET /api/content/series/series-{tmdbId}
   *               → { ok, item } — seasons at item.seasonsData
   *               (the TMDB detail endpoint's Season[] shape; specials
   *               season 0 is already excluded server-side).
   *   - Episodes: GET /api/content/series/series-{tmdbId}/season/{n}
   *               → { ok, season } — episodes at season.episodes.
   *   The old code read top-level `seasonsData` / `seasons_list` /
   *   `episodes` — fields that do not exist on these responses — so the
   *   wizard always reported "No seasons found". Parsing now matches the
   *   real contracts and failures surface a RETRYABLE error with safe
   *   diagnostics (endpoint path + HTTP status — never credentials).
   *
   * The wizard POSTs to /api/admin/media/manual-link (secure endpoint,
   * canonical identity resolved server-side). No provider inventory APIs,
   * no upload, no remote-file deletion.
   *
   * Props:
   *   open              — bind to control visibility.
   *   providers         — provider source list (same shape as Media Library).
   *   preselectedMediaItem — optional: Missing Media demand item — the
   *                        wizard SKIPS search and opens the edit form.
   *   updateTarget      — optional: "Update link" mode — pre-fills the
   *                        current provider + reference.
   *   onclose           — closed via cancel / X / overlay / Escape.
   *   onsaved           — successful save; parent refreshes its list.
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
  import { Search, X, Loader2, Film, Tv, Sparkles, AlertCircle, Check, RotateCw, Image as ImageIcon } from 'lucide-svelte';

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

  // --- Content kinds (explicit — replaces the ambiguous anime checkbox) ---
  type ContentKind = 'movie' | 'anime-movie' | 'tv' | 'anime-series';
  const KINDS: Array<{ kind: ContentKind; label: string; searchType: 'movie' | 'series'; internalType: 'movie' | 'series' | 'anime'; episodic: boolean }> = [
    { kind: 'movie', label: 'Movie', searchType: 'movie', internalType: 'movie', episodic: false },
    { kind: 'tv', label: 'TV Series', searchType: 'series', internalType: 'series', episodic: true },
    { kind: 'anime-movie', label: 'Anime Movie', searchType: 'movie', internalType: 'movie', episodic: false },
    { kind: 'anime-series', label: 'Anime Series', searchType: 'series', internalType: 'anime', episodic: true },
  ];
  function kindMeta(kind: ContentKind) {
    return KINDS.find((k) => k.kind === kind) ?? KINDS[0];
  }
  function kindFromInternalType(contentType: string, episodic: boolean): ContentKind {
    if (contentType === 'anime') return 'anime-series';
    if (contentType === 'series') return 'tv';
    return episodic ? 'tv' : 'movie';
  }

  // --- Sheet state ---
  let mode = $state<'search' | 'edit'>('search');
  let kind = $state<ContentKind>('movie');
  let tmdbQuery = $state('');
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

  // --- Season + episode state (edit form) ---
  let seasonsLoading = $state(false);
  let seasonsError = $state<string | null>(null);
  let seasonsHttp = $state<string | null>(null);
  let seasonsValidationError = $state<string | null>(null);
  let seasons = $state<SeasonInfo[]>([]);
  let selectedSeason = $state<number | null>(null);
  let episodesLoading = $state(false);
  let episodesError = $state<string | null>(null);
  let episodesHttp = $state<string | null>(null);
  let episodesValidationError = $state<string | null>(null);
  let episodes = $state<EpisodeInfo[]>([]);
  let selectedEpisode = $state<EpisodeInfo | null>(null);
  let seasonFetchToken = 0;
  let episodeFetchToken = 0;
  // Stale-response protection: each new search/edit session bumps the
  // token; late responses from a previous session are discarded.
  let sessionToken = 0;

  // --- TMDB image helper ---
  const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';
  function posterUrl(path?: string): string | null {
    if (!path) return null;
    if (path.startsWith('http')) return path;
    return `${TMDB_IMAGE_BASE}${path}`;
  }
  /** Extract the RELATIVE TMDB poster path (/abc.jpg) from a full image URL. */
  function relativePosterPath(url?: string): string | null {
    if (!url) return null;
    if (url.startsWith('/')) return url;
    try {
      const parsed = new URL(url);
      const match = /^\/t\/p\/[^/]+(\/.+)$/.exec(parsed.pathname);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  // --- React to open / preselectedMediaItem / updateTarget changes ---
  $effect(() => {
    if (open) {
      resetSheet();
      if (updateTarget) {
        kind = kindFromInternalType(updateTarget.contentType, updateTarget.contentType !== 'movie');
        selectedTmdb = {
          id: `tmdb-${updateTarget.tmdbId}`,
          tmdbId: updateTarget.tmdbId,
          title: updateTarget.title,
          type: updateTarget.contentType === 'movie' ? 'movie' : 'series',
        };
        selectedProvider = updateTarget.providerName.toLowerCase().includes('vidara') ? 'vidara'
          : updateTarget.providerName.toLowerCase().includes('abyss') ? 'abyss' : null;
        providerReference = updateTarget.providerAssetId;
        enterEdit();
      } else if (preselectedMediaItem) {
        kind = kindFromInternalType(preselectedMediaItem.contentType, false);
        selectedTmdb = {
          id: `tmdb-${preselectedMediaItem.tmdbId}`,
          tmdbId: preselectedMediaItem.tmdbId,
          title: preselectedMediaItem.title,
          year: preselectedMediaItem.year ?? undefined,
          type: preselectedMediaItem.contentType === 'movie' ? 'movie' : 'series',
        };
        enterEdit();
        // Preselect the demand's season/episode, then load the season list
        // so the dropdowns render real data around the preselection.
        if (kindMeta(kind).episodic) {
          if (preselectedMediaItem.season != null) selectedSeason = preselectedMediaItem.season;
          if (preselectedMediaItem.episode != null) {
            selectedEpisode = {
              number: preselectedMediaItem.episode,
              title: preselectedMediaItem.episodeTitle ?? `Episode ${preselectedMediaItem.episode}`,
            };
          }
          void loadSeasons();
        }
      } else {
        mode = 'search';
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
    if (!q) { tmdbResults = []; tmdbError = null; return; }
    const token = ++sessionToken;
    tmdbSearching = true;
    tmdbError = null;
    try {
      // The explicit content-type choice drives the TMDB search kind:
      // movie search for Movie/Anime Movie, TV search for TV Series/Anime Series.
      const res = await fetch(`/api/admin/media/search?q=${encodeURIComponent(q)}&type=${kindMeta(kind).searchType}`);
      const json = await res.json();
      if (token !== sessionToken) return; // stale
      if (json.ok) {
        tmdbResults = (json.results ?? []).map((r: any) => ({
          id: r.id,
          tmdbId: String(r.id).replace(/^(movie|series|anime)-/, ''),
          title: r.title,
          year: r.year,
          poster: r.poster,
          type: r.type ?? (kindMeta(kind).searchType === 'movie' ? 'movie' : 'series'),
          overview: r.overview ?? r.description,
        }));
      } else {
        tmdbResults = [];
        tmdbError = json.error?.message ?? 'Search failed.';
      }
    } catch (err) {
      if (token !== sessionToken) return;
      tmdbResults = [];
      tmdbError = err instanceof Error ? err.message : 'Search failed.';
    } finally {
      if (token === sessionToken) tmdbSearching = false;
    }
  }

  function changeKind(next: ContentKind) {
    if (kind === next) return;
    kind = next;
    // The search type changes with the kind — clear stale results.
    tmdbResults = [];
    tmdbError = null;
    if (tmdbQuery.trim()) void doTmdbSearch();
  }

  // --- Edit form entry (AUTOMATIC on result selection — no Continue step) ---
  function selectTmdb(result: TmdbResult) {
    selectedTmdb = result;
    selectedEpisode = null;
    selectedSeason = null;
    episodes = [];
    seasons = [];
    seasonsError = null;
    episodesError = null;
    seasonsHttp = null;
    episodesHttp = null;
    enterEdit();
    if (kindMeta(kind).episodic) void loadSeasons();
  }

  function enterEdit() {
    mode = 'edit';
    referenceError = null;
    saveError = null;
    seasonsValidationError = null;
    episodesValidationError = null;
  }

  // --- Change action: back to a FRESH search state ---
  function changeTitle() {
    const token = ++sessionToken;
    void token;
    selectedTmdb = null;
    selectedProvider = null;
    providerReference = '';
    referenceError = null;
    saveError = null;
    tmdbQuery = '';
    tmdbResults = [];
    tmdbError = null;
    seasons = [];
    selectedSeason = null;
    seasonsError = null;
    seasonsHttp = null;
    seasonsValidationError = null;
    episodes = [];
    selectedEpisode = null;
    episodesError = null;
    episodesHttp = null;
    episodesValidationError = null;
    mode = 'search';
  }

  // --- Season + Episode loading (REAL TMDB data — Issue A contract) ---
  async function loadSeasons() {
    if (!selectedTmdb) return;
    const token = ++seasonFetchToken;
    seasonsLoading = true;
    seasonsError = null;
    seasonsHttp = null;
    seasons = [];
    try {
      // CORRECT CONTRACT: the detail endpoint returns { ok, item } and the
      // seasons live at item.seasonsData (Season[] — number/title/
      // episodeCount/airDate; specials season 0 already excluded).
      const endpoint = `/api/content/series/series-${encodeURIComponent(selectedTmdb.tmdbId)}`;
      const res = await fetch(endpoint);
      if (!res.ok) {
        if (token !== seasonFetchToken) return;
        seasonsHttp = `${endpoint} → HTTP ${res.status}`;
        seasonsError = `Could not load seasons (HTTP ${res.status}).`;
        return;
      }
      const json = await res.json();
      if (token !== seasonFetchToken) return; // stale — selection changed quickly
      const seasonsData = json?.item?.seasonsData;
      if (!Array.isArray(seasonsData) || seasonsData.length === 0) {
        seasonsError = 'TMDB returned no regular seasons for this title.';
        return;
      }
      seasons = seasonsData.map((s: any) => ({
        number: s.number ?? s.season_number ?? 0,
        title: s.title ?? s.name ?? `Season ${s.number ?? s.season_number ?? 0}`,
        episodeCount: s.episodeCount ?? s.episode_count ?? 0,
        airDate: s.airDate ?? s.air_date,
      }));
      // Default selection: the first REGULAR season (number > 0) — never
      // a fabricated list. If the preselected demand season exists in the
      // list, keep it selected and load its episodes.
      const preferred = selectedSeason != null && seasons.some((s) => s.number === selectedSeason)
        ? selectedSeason
        : (seasons.find((s) => s.number > 0) ?? seasons[0])?.number ?? null;
      selectedSeason = preferred;
      if (preferred != null) void loadEpisodes(preferred);
    } catch (err) {
      if (token !== seasonFetchToken) return;
      seasonsHttp = `/api/content/series/series-${selectedTmdb?.tmdbId ?? ''} → ${err instanceof Error ? err.message : 'network error'}`;
      seasonsError = 'Could not load seasons. Check the connection and retry.';
    } finally {
      if (token === seasonFetchToken) seasonsLoading = false;
    }
  }

  async function loadEpisodes(seasonNumber: number) {
    if (!selectedTmdb) return;
    const token = ++episodeFetchToken;
    episodesLoading = true;
    episodesError = null;
    episodesHttp = null;
    episodes = [];
    selectedEpisode = null;
    try {
      // CORRECT CONTRACT: the season endpoint returns { ok, season } and
      // the episodes live at season.episodes ({ id, number, season, title,
      // overview, airDate, runtime, still }).
      const endpoint = `/api/content/series/series-${encodeURIComponent(selectedTmdb.tmdbId)}/season/${seasonNumber}`;
      const res = await fetch(endpoint);
      if (!res.ok) {
        if (token !== episodeFetchToken) return;
        episodesHttp = `${endpoint} → HTTP ${res.status}`;
        episodesError = `Could not load episodes (HTTP ${res.status}).`;
        return;
      }
      const json = await res.json();
      if (token !== episodeFetchToken) return; // stale
      const eps = json?.season?.episodes;
      if (!Array.isArray(eps) || eps.length === 0) {
        episodesError = 'TMDB returned no episodes for this season.';
        return;
      }
      episodes = eps.map((e: any) => ({
        number: e.number ?? e.episode_number ?? 0,
        title: e.title ?? e.name ?? `Episode ${e.number ?? e.episode_number ?? 0}`,
        airDate: e.airDate ?? e.air_date,
        still: e.still ?? (e.still_path ? `https://image.tmdb.org/t/p/w300${e.still_path}` : undefined),
      }));
      // If the preselected demand episode exists in this season, restore it.
      if (preselectedMediaItem?.episode != null && seasonNumber === preselectedMediaItem.season) {
        const match = episodes.find((e) => e.number === preselectedMediaItem.episode);
        if (match) selectedEpisode = match;
      }
    } catch (err) {
      if (token !== episodeFetchToken) return;
      episodesHttp = `/api/content/series/series-${selectedTmdb?.tmdbId ?? ''}/season/${seasonNumber} → ${err instanceof Error ? err.message : 'network error'}`;
      episodesError = 'Could not load episodes. Check the connection and retry.';
    } finally {
      if (token === episodeFetchToken) episodesLoading = false;
    }
  }

  function selectSeason(seasonNumber: number) {
    selectedSeason = seasonNumber;
    selectedEpisode = null;
    seasonsValidationError = null;
    episodesValidationError = null;
    if (seasonNumber !== null) void loadEpisodes(seasonNumber);
  }

  // --- Save ---
  async function saveLink() {
    if (!selectedTmdb || !selectedProvider) return;
    const meta = kindMeta(kind);

    const ref = providerReference.trim();
    if (!ref) {
      referenceError = meta.internalType === 'movie' ? 'Provider reference is required.' : 'Provider reference is required.';
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(ref) && !ref.startsWith('http')) {
      referenceError = 'Reference must be alphanumeric (filecode/ID) or a full URL.';
      return;
    }
    // EVERY series/anime series link identifies exactly ONE episode —
    // validation sits next to the fields (dedicated field errors, never
    // replacing the data-error/retry display), and the series-level save
    // path no longer exists.
    if (meta.episodic && (selectedSeason == null || selectedEpisode == null)) {
      seasonsValidationError = selectedSeason == null ? 'Select a season.' : null;
      episodesValidationError = selectedEpisode == null ? 'Select an episode.' : null;
      return;
    }
    seasonsValidationError = null;
    episodesValidationError = null;
    referenceError = null;

    saving = true;
    saveError = null;
    try {
      const body: Record<string, string> = {
        contentType: meta.internalType,
        tmdbId: selectedTmdb.tmdbId,
        provider: selectedProvider,
        reference: ref,
        title: selectedTmdb.title,
      };
      if (selectedTmdb.year != null) body.year = String(selectedTmdb.year);
      if (meta.episodic && selectedSeason != null) body.season = String(selectedSeason);
      if (meta.episodic && selectedEpisode != null) {
        body.episode = String(selectedEpisode.number);
        if (selectedEpisode.title) body.episodeTitle = selectedEpisode.title;
      }
      // Persist the TMDB poster path (relative /path form) into
      // media_items.poster_path via the manual-link endpoint.
      const posterPath = relativePosterPath(selectedTmdb.poster);
      if (posterPath) body.posterPath = posterPath;

      if (updateTarget) body.mediaAssetId = updateTarget.mediaAssetId;

      const res = await fetch('/api/admin/media/manual-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.ok) {
        const savedId = json.mediaAssetId as string;
        closeSheet();
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

  // --- Sheet control ---
  function resetSheet() {
    mode = 'search';
    kind = 'movie';
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
    seasons = [];
    selectedSeason = null;
    seasonsLoading = false;
    seasonsError = null;
    seasonsHttp = null;
    seasonsValidationError = null;
    episodes = [];
    selectedEpisode = null;
    episodesLoading = false;
    episodesError = null;
    episodesHttp = null;
    episodesValidationError = null;
    sessionToken++;
    seasonFetchToken++;
    episodeFetchToken++;
    if (tmdbDebounce) { clearTimeout(tmdbDebounce); tmdbDebounce = null; }
  }

  function closeSheet() {
    open = false;
    resetSheet();
    onclose?.();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      closeSheet();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div class="wizard-overlay" onclick={closeSheet} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <div class="wizard-head">
        <h2 id="wizard-title">{updateTarget ? 'Update link' : 'Add file'}</h2>
        <button type="button" class="wizard-close" onclick={closeSheet} aria-label="Close"><X size={16} /></button>
      </div>

      {#if saveError}
        <div class="wizard-error" role="alert"><AlertCircle size={14} /> {saveError}</div>
      {/if}

      <!-- STATE 1 — Search: content type + query + results -->
      {#if mode === 'search'}
        <div class="wizard-step">
          <div class="field-label" id="kind-label">Content type</div>
          <div class="kind-grid" role="radiogroup" aria-labelledby="kind-label">
            {#each KINDS as k (k.kind)}
              <button
                type="button"
                class="kind-option"
                class:active={kind === k.kind}
                role="radio"
                aria-checked={kind === k.kind}
                onclick={() => changeKind(k.kind)}
              >
                {#if k.kind === 'movie'}<Film size={13} />{:else if k.kind === 'anime-movie' || k.kind === 'anime-series'}<Sparkles size={13} />{:else}<Tv size={13} />{/if}
                {k.label}
              </button>
            {/each}
          </div>

          <div class="search-input-wrap">
            <Search size={14} class="search-icon" />
            <input
              type="text"
              class="search-input"
              placeholder={kindMeta(kind).searchType === 'movie' ? 'Search TMDB movies by title…' : 'Search TMDB TV series by title…'}
              bind:value={tmdbQuery}
              oninput={onTmdbInput}
              autocomplete="off"
              aria-label="Search TMDB by title"
            />
            {#if tmdbSearching}<Loader2 size={14} class="spinner" />{/if}
          </div>

          <div class="results-list">
            {#if tmdbError}
              <div class="results-empty"><AlertCircle size={14} /> {tmdbError}</div>
            {:else if tmdbResults.length === 0 && !tmdbSearching}
              <div class="results-empty">{tmdbQuery.trim() ? `No results for "${tmdbQuery}".` : 'Start typing to search TMDB.'}</div>
            {/if}
            {#each tmdbResults as result (result.id)}
              <button type="button" class="result-row" onclick={() => selectTmdb(result)}>
                <div class="result-poster">
                  {#if posterUrl(result.poster)}
                    <img src={posterUrl(result.poster)} alt={result.title} loading="lazy" />
                  {:else}
                    {#if result.type === 'movie'}<Film size={14} />{:else if result.type === 'anime'}<Sparkles size={14} />{:else}<Tv size={14} />{/if}
                  {/if}
                </div>
                <div class="result-info">
                  <div class="result-title">{result.title}</div>
                  <div class="result-meta">{#if result.year}<span>{result.year}</span> · {/if}<span>TMDB {result.tmdbId}</span></div>
                </div>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- STATE 2 — Edit: ONE compact adaptive form (no steps) -->
      {#if mode === 'edit' && selectedTmdb}
        <div class="wizard-step">
          <div class="selected-title-bar">
            <div class="selected-identity">
              <div class="result-poster">
                {#if posterUrl(selectedTmdb.poster)}
                  <img src={posterUrl(selectedTmdb.poster)} alt={selectedTmdb.title} loading="lazy" />
                {:else}
                  <ImageIcon size={14} />
                {/if}
              </div>
              <div class="result-info">
                <div class="result-title">{selectedTmdb.title}</div>
                <div class="result-meta">
                  <span>{kindMeta(kind).label}</span>
                  {#if selectedTmdb.year}<span>· {selectedTmdb.year}</span>{/if}
                  <span>· TMDB {selectedTmdb.tmdbId}</span>
                </div>
              </div>
            </div>
            <button type="button" class="change-btn" onclick={changeTitle}>Change</button>
          </div>

          {#if kindMeta(kind).episodic}
            <!-- Season dropdown (real TMDB seasons, retryable on failure) -->
            <div class="field-group">
              <label class="field-label" for="season-select">Season</label>
              {#if seasonsLoading}
                <div class="field-status"><Loader2 size={13} class="spinner" /> Loading seasons…</div>
              {:else if seasonsError}
                <div class="field-status field-status-error" role="alert">
                  <AlertCircle size={13} /> {seasonsError}
                  {#if seasonsHttp}<span class="diag">{seasonsHttp}</span>{/if}
                  <button type="button" class="retry-inline" onclick={() => void loadSeasons()}><RotateCw size={11} /> Retry</button>
                </div>
              {:else}
                <select
                  id="season-select"
                  class="ref-input"
                  value={selectedSeason ?? ''}
                  onchange={(e) => selectSeason(Number((e.target as HTMLSelectElement).value))}
                >
                  {#if selectedSeason == null}<option value="" disabled>Select a season…</option>{/if}
                  {#each seasons as s (s.number)}
                    <option value={s.number}>{s.title} ({s.episodeCount} episodes)</option>
                  {/each}
                </select>
                {#if seasonsValidationError}<p class="field-error" role="alert"><AlertCircle size={11} /> {seasonsValidationError}</p>{/if}
              {/if}
            </div>

            <!-- Episode dropdown (refreshes with the season; stale-safe) -->
            <div class="field-group">
              <label class="field-label" for="episode-select">Episode</label>
              {#if !seasonsError && selectedSeason != null}
                {#if episodesLoading}
                  <div class="field-status"><Loader2 size={13} class="spinner" /> Loading episodes…</div>
                {:else if episodesError}
                  <div class="field-status field-status-error" role="alert">
                    <AlertCircle size={13} /> {episodesError}
                    {#if episodesHttp}<span class="diag">{episodesHttp}</span>{/if}
                    <button type="button" class="retry-inline" onclick={() => selectedSeason != null && void loadEpisodes(selectedSeason)}><RotateCw size={11} /> Retry</button>
                  </div>
                {:else}
                  <select
                    id="episode-select"
                    class="ref-input"
                    value={selectedEpisode?.number ?? ''}
                    onchange={(e) => {
                      const num = Number((e.target as HTMLSelectElement).value);
                      selectedEpisode = episodes.find((ep) => ep.number === num) ?? null;
                      episodesValidationError = null;
                    }}
                  >
                    {#if !selectedEpisode}<option value="" disabled>Select an episode…</option>{/if}
                    {#each episodes as ep (ep.number)}
                      <option value={ep.number}>E{String(ep.number).padStart(2, '0')} — {ep.title}</option>
                    {/each}
                  </select>
                  {#if episodesValidationError}<p class="field-error" role="alert"><AlertCircle size={11} /> {episodesValidationError}</p>{/if}
                {/if}
              {:else if !seasonsError}
                <div class="field-status">Select a season first.</div>
              {/if}
            </div>
          {/if}

          <!-- Provider selector -->
          <div class="field-group">
            <span class="field-label" id="provider-label">Provider</span>
            <div class="provider-cards" role="radiogroup" aria-labelledby="provider-label">
              <button type="button" class="provider-card" class:selected={selectedProvider === 'vidara'} role="radio" aria-checked={selectedProvider === 'vidara'} onclick={() => { selectedProvider = 'vidara'; }}>
                <div class="provider-name">Vidara</div>
                <div class="provider-desc">Filecode or embed URL from vidara.to</div>
              </button>
              <button type="button" class="provider-card" class:selected={selectedProvider === 'abyss'} role="radio" aria-checked={selectedProvider === 'abyss'} onclick={() => { selectedProvider = 'abyss'; }}>
                <div class="provider-name">Abyss</div>
                <div class="provider-desc">Resource ID or player URL from abyss.to</div>
              </button>
            </div>
          </div>

          <!-- Provider reference -->
          <div class="field-group">
            <label class="field-label" for="ref-input">
              {selectedProvider === 'vidara' ? 'Vidara filecode or URL' : selectedProvider === 'abyss' ? 'Abyss resource ID or URL' : 'Provider reference'}
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
              <p class="field-error" role="alert"><AlertCircle size={11} /> {referenceError}</p>
            {/if}
          </div>

          <div class="wizard-footer">
            <button type="button" class="btn btn-cancel" onclick={closeSheet} disabled={saving}>Cancel</button>
            <button type="button" class="btn btn-save" onclick={saveLink} disabled={saving || !selectedProvider || !providerReference.trim()}>
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

  .wizard-error { padding: 8px 12px; margin: 8px 20px 0; border: 1px solid rgba(220,60,60,0.3); border-radius: 8px; background: rgba(220,60,60,0.08); color: #c44; font-size: 0.75rem; display: flex; align-items: center; gap: 6px; }

  .wizard-step { padding: 14px 20px 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }

  /* Content type selector */
  .kind-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
  .kind-option { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 10px; border: 1px solid var(--a2-border, #222); border-radius: 8px; background: var(--a2-surface-3, #1a1a1a); color: var(--a2-text-muted, #888); font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: border-color 140ms ease, color 140ms ease; }
  .kind-option:hover { border-color: rgba(0,255,255,0.3); }
  .kind-option.active { border-color: #0ff; background: rgba(0,255,255,0.08); color: #0ff; }

  .search-input-wrap { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 38px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 8px; }
  .search-input-wrap:focus-within { border-color: #0ff; }
  .search-input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--a2-text, #ddd); font-size: 0.82rem; }
  .search-input::placeholder { color: var(--a2-text-dim, #555); }
  .search-icon { color: var(--a2-text-dim, #555); flex-shrink: 0; }
  .spinner { animation: spin 1s linear infinite; }

  .results-list { max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .results-empty { padding: 20px; text-align: center; color: var(--a2-text-dim, #555); font-size: 0.8rem; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .result-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 8px; cursor: pointer; text-align: left; transition: border-color 140ms ease; }
  .result-row:hover { border-color: rgba(0,255,255,0.3); }

  .result-poster { width: 34px; height: 51px; flex-shrink: 0; border-radius: 4px; overflow: hidden; display: grid; place-items: center; background: var(--a2-surface-4, #2a2a2a); color: var(--a2-text-dim, #555); }
  .result-poster img { width: 100%; height: 100%; object-fit: cover; }

  .result-info { flex: 1; min-width: 0; }
  .result-title { font-size: 0.8rem; color: var(--a2-text-bright, #f0f0f0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-meta { display: flex; gap: 4px; font-size: 0.6rem; color: var(--a2-text-dim, #555); text-transform: uppercase; letter-spacing: 0.04em; }

  /* Edit form */
  .selected-title-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; background: rgba(0,200,200,0.08); border-radius: 8px; }
  .selected-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .change-btn { background: transparent; border: 0; color: #0ff; font-size: 0.7rem; font-weight: 600; cursor: pointer; text-decoration: underline; white-space: nowrap; flex-shrink: 0; }

  .field-group { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--a2-text-muted, #888); }
  .field-status { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-radius: 8px; background: var(--a2-surface-3, #1a1a1a); color: var(--a2-text-muted, #888); font-size: 0.72rem; flex-wrap: wrap; }
  .field-status-error { color: #c44; background: rgba(220,60,60,0.06); border: 1px solid rgba(220,60,60,0.25); }
  .diag { font-family: var(--a2-font-mono, monospace); font-size: 0.6rem; color: var(--a2-text-dim, #555); word-break: break-all; }
  .retry-inline { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid var(--a2-border-strong, #333); border-radius: 6px; background: transparent; color: #0ff; font-size: 0.65rem; font-weight: 600; cursor: pointer; }
  .retry-inline:hover { background: rgba(0,200,200,0.08); }
  .field-error { margin: 0; font-size: 0.65rem; color: #c44; display: flex; align-items: center; gap: 4px; }

  .provider-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .provider-card { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border: 1px solid var(--a2-border, #222); border-radius: 8px; background: var(--a2-surface-3, #1a1a1a); cursor: pointer; text-align: left; transition: border-color 140ms ease; }
  .provider-card:hover { border-color: rgba(0,255,255,0.3); }
  .provider-card.selected { border-color: #0ff; background: rgba(0,255,255,0.08); }
  .provider-name { font-size: 0.85rem; font-weight: 700; color: var(--a2-text-bright, #f0f0f0); }
  .provider-desc { font-size: 0.65rem; color: var(--a2-text-dim, #555); }

  .ref-input { height: 40px; padding: 0 12px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 8px; color: var(--a2-text, #ddd); font-size: 0.82rem; outline: 0; }
  .ref-input:focus { border-color: #0ff; }
  .ref-hint { margin: 0; font-size: 0.65rem; color: var(--a2-text-dim, #555); line-height: 1.4; }

  .wizard-footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; flex-wrap: wrap; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid transparent; border-radius: 8px; font-size: 0.78rem; font-weight: 700; cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-cancel { background: var(--a2-surface-3, #1a1a1a); border-color: var(--a2-border, #222); color: var(--a2-text-muted, #888); }
  .btn-cancel:hover { color: var(--a2-text, #ddd); }
  .btn-save { background: rgba(53,214,143,0.12); border-color: rgba(53,214,143,0.3); color: #35d68f; }
  .btn-save:hover { background: rgba(53,214,143,0.2); }

  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

  @media (max-width: 640px) {
    .kind-grid { grid-template-columns: 1fr 1fr; }
    .provider-cards { grid-template-columns: 1fr; }
    .wizard-footer { flex-direction: column-reverse; }
    .btn { width: 100%; justify-content: center; }
  }
</style>
