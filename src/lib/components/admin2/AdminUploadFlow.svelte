<script lang="ts">
  /**
   * Admin 2.0 — Phase D — AdminUploadFlow
   *
   * The orchestrator for the entire upload/import workflow. Manages:
   *   - Step flowState machine (search → metadata → provider → source → review → progress → result)
   *   - URL flowState sync (deep-linkable, shareable)
   *   - Polling lifecycle (with POLL_MAX_ATTEMPTS cap + onDestroy cleanup)
   *   - Retry flow (no duplicate createOperation call)
   *   - Subtitle sub-flow (separate sheet, isolated success/failure)
   *   - Mobile vs desktop composition
   *
   * The flow uses existing backend services — no duplicate business
   * logic. The UI is purely a presentation + orchestration layer over:
   *   - /api/admin/media/upload (POST — create operation)
   *   - /api/admin/media/upload/[id]/upload-server (Vidara browser-direct)
   *   - /api/admin/media/upload/[id]/complete (Vidara completion)
   *   - /api/admin/media/upload/[id]/proxy-upload (Abyss server-proxied)
   *   - /api/admin/media/upload/[id]/status (GET + POST poll)
   *   - /api/admin/media/upload/[id]/cancel
   *   - /api/admin/media/upload/[id]/retry
   *   - /api/admin/media/upload/[id]/subtitle
   *
   * Step flowState machine:
   *   search → metadata → provider → source → review → uploading → processing → done
   *                                                                              ↘ failed
   *   Any step can go backward without losing completed data.
   *   If a previous step changes a dependency, downstream flowState is invalidated.
   */
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Upload, Search, FileVideo, Server, FileCheck, Loader, CheckCircle, AlertCircle, X, ChevronLeft, ChevronRight, RefreshCw, Subtitles, Library } from 'lucide-svelte';
  import type { ProviderCapabilities } from '$lib/server/hosting/types';

  // ============================================================
  // Types
  // ============================================================

  type UploadStep = 'search' | 'metadata' | 'provider' | 'source' | 'review' | 'uploading' | 'processing' | 'done';

  type TmdbResult = {
    id: string;          // e.g. "movie-12345" or "series-67890"
    tmdbId: string;      // e.g. "12345"
    title: string;
    year?: number;
    poster?: string;
    type: 'movie' | 'series' | 'anime';
    overview?: string;
    imdbId?: string | null;
  };

  type HostingSource = {
    id: string;
    name: string;
    providerId: string;
    providerName: string | null;
    adapterId: string | null;
    capabilities: ProviderCapabilities | null;
  };

  type UploadFlowState = {
    step: UploadStep;
    // Selected title
    selectedTitle: TmdbResult | null;
    // Metadata confirmation
    contentType: 'movie' | 'series' | 'anime';
    season: number | null;
    episode: number | null;
    episodeTitle: string;
    imdbId: string | null;
    // Provider
    providerSourceId: string;
    providerAdapterId: string;
    providerName: string;
    providerCapabilities: ProviderCapabilities | null;
    // Upload source
    uploadSource: 'local' | 'remote';
    remoteUrl: string;
    selectedFile: File | null;
    sourceQuality: string;
    // Operation
    operationId: string | null;
    operationStatus: string;
    operationError: string;
    errorCode: string;
    // Subtitle
    subtitleOpen: boolean;
    subtitleResult: '' | 'success' | 'failed';
    subtitleError: string;
  };

  // ============================================================
  // Props
  // ============================================================

  let {
    hostingSources = [] as HostingSource[],
    initialContext = null as {
      tmdbId: string;
      contentType: 'movie' | 'series' | 'anime' | null;
      season: number | null;
      episode: number | null;
    } | null,
    adminUserId = '' as string,
  }: {
    hostingSources?: HostingSource[];
    initialContext?: {
      tmdbId: string;
      contentType: 'movie' | 'series' | 'anime' | null;
      season: number | null;
      episode: number | null;
    } | null;
    adminUserId?: string;
  } = $props();

  // ============================================================
  // State
  // ============================================================

  const initialState: UploadFlowState = {
    step: 'search',
    selectedTitle: null,
    contentType: 'movie',
    season: null,
    episode: null,
    episodeTitle: '',
    imdbId: null,
    providerSourceId: '',
    providerAdapterId: '',
    providerName: '',
    providerCapabilities: null,
    uploadSource: 'local',
    remoteUrl: '',
    selectedFile: null,
    sourceQuality: '',
    operationId: null,
    operationStatus: '',
    operationError: '',
    errorCode: '',
    subtitleOpen: false,
    subtitleResult: '',
    subtitleError: '',
  };
  let flowState = $state<UploadFlowState>(initialState);

  let searchQuery = $state('');
  let searchType = $state<'movie' | 'series'>('movie');
  let searchResults = $state<TmdbResult[]>([]);
  let searching = $state(false);
  let searchError = $state('');
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let pollAttempts = $state(0);
  const POLL_MAX_ATTEMPTS = 60; // matches service constant
  const POLL_INTERVAL_MS = 10_000;

  let subtitleSheetOpen = $state(false);

  // ============================================================
  // Lifecycle — deep-link initialization
  // ============================================================

  onMount(async () => {
    if (initialContext?.tmdbId) {
      // Deep-link: skip search, fetch title from TMDB.
      searching = true;
      searchError = '';
      try {
        // Use the content API to fetch detail. The /api/content/[type]/[id]
        // endpoint returns an ENVELOPE: `{ ok: true, item: { ... } }` on
        // success or `{ ok: false, error: { code, message } }` on failure.
        // The previous implementation read fields directly from `json`
        // (`json.title`, `json.year`, …), so every field was `undefined`
        // and the title fell through to 'Unknown Title'. We now extract
        // `item` from the envelope first.
        const type = initialContext.contentType ?? 'movie';
        const res = await fetch(`/api/content/${type}/${initialContext.tmdbId}`);
        const json = await res.json();
        if (json.ok && json.item) {
          const item = json.item;
          flowState.selectedTitle = {
            id: `${type}-${initialContext.tmdbId}`,
            tmdbId: initialContext.tmdbId,
            title: item.title ?? item.name ?? 'Unknown Title',
            year: item.year ?? (item.releaseDate ? new Date(item.releaseDate).getFullYear() : undefined),
            poster: item.poster ?? item.posterSmall ?? undefined,
            type: type as 'movie' | 'series' | 'anime',
            overview: item.description ?? item.overview ?? undefined,
            imdbId: item.externalIds?.imdb ?? null,
          };
          flowState.contentType = (initialContext.contentType ?? 'movie') as 'movie' | 'series' | 'anime';
          flowState.season = initialContext.season;
          flowState.episode = initialContext.episode;
          flowState.imdbId = item.externalIds?.imdb ?? null;
          flowState.step = 'metadata';
        } else {
          // `json.ok === false` (or no item) — surface the API's safe
          // error message if present, otherwise fall back to a clear
          // prompt to search manually. The search step is preserved so
          // the admin can recover without losing context.
          searchError = json?.error?.message ?? 'Could not load title from TMDB. Please search manually.';
          flowState.step = 'search';
        }
      } catch (err) {
        searchError = err instanceof Error ? err.message : 'Failed to load title.';
        flowState.step = 'search';
      } finally {
        searching = false;
      }
    }
  });

  onDestroy(() => {
    stopPolling();
    if (searchDebounce) clearTimeout(searchDebounce);
  });

  // ============================================================
  // Step navigation
  // ============================================================

  const STEP_ORDER: UploadStep[] = ['search', 'metadata', 'provider', 'source', 'review', 'uploading', 'processing', 'done'];

  function currentStepIndex(): number {
    return STEP_ORDER.indexOf(flowState.step);
  }

  function canGoBack(): boolean {
    const idx = currentStepIndex();
    // Can go back from any step except search, but not from terminal states
    // (done/failed are terminal — going back would reset the operation).
    if (flowState.step === 'search' || flowState.step === 'done') return false;
    if (flowState.step === 'uploading' || flowState.step === 'processing') return false;
    return idx > 0;
  }

  function goBack() {
    if (!canGoBack()) return;
    const idx = currentStepIndex();
    const prevStep = STEP_ORDER[idx - 1];
    if (prevStep) {
      flowState.step = prevStep;
      syncUrl();
    }
  }

  // ============================================================
  // URL flowState sync
  // ============================================================

  let urlSyncDebounce: ReturnType<typeof setTimeout> | null = null;

  function syncUrl() {
    if (urlSyncDebounce) clearTimeout(urlSyncDebounce);
    urlSyncDebounce = setTimeout(() => {
      const params = new URLSearchParams();
      if (flowState.selectedTitle) {
        params.set('tmdbId', flowState.selectedTitle.tmdbId);
        params.set('contentType', flowState.contentType);
        if (flowState.season != null) params.set('season', String(flowState.season));
        if (flowState.episode != null) params.set('episode', String(flowState.episode));
      }
      const qs = params.toString();
      const url = qs ? `/admin/media/upload?${qs}` : '/admin/media/upload';
      goto(url, { replaceState: true, noScroll: true, keepFocus: true });
    }, 100);
  }

  // ============================================================
  // Step 1: TMDB search
  // ============================================================

  function handleSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    searchQuery = value;
    if (searchDebounce) clearTimeout(searchDebounce);
    if (!value.trim()) {
      searchResults = [];
      searchError = '';
      return;
    }
    searchDebounce = setTimeout(() => doSearch(), 300);
  }

  async function doSearch() {
    if (!searchQuery.trim()) return;
    searching = true;
    searchError = '';
    try {
      const res = await fetch(`/api/admin/media/search?q=${encodeURIComponent(searchQuery)}&type=${searchType}`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      }
      searchResults = (json.results ?? []).map((r: any) => ({
        id: r.id,
        tmdbId: String(r.id).replace(/^(movie|series|anime)-/, ''),
        title: r.title,
        year: r.year,
        poster: r.poster,
        type: r.type ?? (searchType === 'movie' ? 'movie' : 'series'),
        overview: r.overview ?? r.description,
        imdbId: r.externalIds?.imdb ?? null,
      }));
    } catch (err) {
      searchError = err instanceof Error ? err.message : 'Search failed.';
      searchResults = [];
    } finally {
      searching = false;
    }
  }

  function selectTitle(result: TmdbResult) {
    flowState.selectedTitle = result;
    flowState.contentType = result.type === 'anime' ? 'anime' : (result.type as 'movie' | 'series');
    flowState.imdbId = result.imdbId ?? null;
    // Invalidate downstream flowState — provider/source must be re-selected.
    flowState.providerSourceId = '';
    flowState.providerAdapterId = '';
    flowState.providerName = '';
    flowState.providerCapabilities = null;
    flowState.selectedFile = null;
    flowState.remoteUrl = '';
    flowState.sourceQuality = '';
    flowState.step = 'metadata';
    syncUrl();
  }

  // ============================================================
  // Step 2: Metadata confirmation
  // ============================================================

  function confirmMetadata() {
    // Validate episode context for series/anime.
    if ((flowState.contentType === 'series' || flowState.contentType === 'anime') && flowState.season != null && flowState.episode == null) {
      // Season without episode is invalid for an episode upload.
      return;
    }
    flowState.step = 'provider';
    syncUrl();
  }

  // ============================================================
  // Step 3: Provider selection
  // ============================================================

  function selectProvider(source: HostingSource) {
    flowState.providerSourceId = source.id;
    flowState.providerAdapterId = source.adapterId ?? '';
    flowState.providerName = source.name;
    flowState.providerCapabilities = source.capabilities;
    // Reset upload source based on capabilities.
    if (flowState.providerCapabilities) {
      if (!flowState.providerCapabilities.localUpload && flowState.providerCapabilities.remoteUpload) {
        flowState.uploadSource = 'remote';
      } else if (flowState.providerCapabilities.localUpload && !flowState.providerCapabilities.remoteUpload) {
        flowState.uploadSource = 'local';
      }
    }
    flowState.step = 'source';
    syncUrl();
  }

  // ============================================================
  // Step 4: Upload source selection
  // ============================================================

  function onFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      flowState.selectedFile = input.files[0];
    }
  }

  function clearFile() {
    flowState.selectedFile = null;
  }

  // Drag-and-drop
  function handleDrop(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer?.files && event.dataTransfer.files[0]) {
      flowState.selectedFile = event.dataTransfer.files[0];
    }
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
  }

  function confirmSource() {
    if (flowState.uploadSource === 'local' && !flowState.selectedFile) return;
    if (flowState.uploadSource === 'remote' && !flowState.remoteUrl.trim()) return;
    flowState.step = 'review';
  }

  // ============================================================
  // Step 5: Review + start upload
  // ============================================================

  let creating = $state(false);
  let createError = $state('');

  async function startUpload() {
    creating = true;
    createError = '';
    try {
      const body: Record<string, unknown> = {
        tmdbId: flowState.selectedTitle?.tmdbId,
        title: flowState.selectedTitle?.title,
        year: flowState.selectedTitle?.year ?? null,
        imdbId: flowState.imdbId ?? null,
        contentType: flowState.contentType,
        providerSourceId: flowState.providerSourceId,
        // providerAdapterId intentionally omitted — server derives it.
        uploadSource: flowState.uploadSource,
        sourceQuality: flowState.sourceQuality || undefined,
      };
      if (flowState.season != null) body.season = flowState.season;
      if (flowState.episode != null) body.episode = flowState.episode;
      if (flowState.episodeTitle) body.episodeTitle = flowState.episodeTitle;
      if (flowState.uploadSource === 'remote') body.remoteUrl = flowState.remoteUrl;
      if (flowState.uploadSource === 'local' && flowState.selectedFile) body.filename = flowState.selectedFile.name;

      const res = await fetch('/api/admin/media/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      }

      flowState.operationId = json.operation.id;
      flowState.operationStatus = json.operation.status;

      if (flowState.uploadSource === 'remote') {
        // Remote upload executed server-side — go straight to processing.
        flowState.step = 'processing';
        startPolling();
      } else {
        // Local upload — browser drives the file upload.
        flowState.step = 'uploading';
        await executeLocalUpload();
      }
    } catch (err) {
      createError = err instanceof Error ? err.message : 'Failed to start upload.';
      flowState.operationError = createError;
    } finally {
      creating = false;
    }
  }

  // ============================================================
  // Local upload execution (Vidara browser-direct / Abyss proxy)
  // ============================================================

  async function executeLocalUpload() {
    if (!flowState.operationId || !flowState.selectedFile) return;
    try {
      if (flowState.providerAdapterId === 'vidara') {
        // Vidara: browser-direct upload.
        // Step 1: get the upload server URL (server issues this with api_key appended).
        const serverRes = await fetch(`/api/admin/media/upload/${flowState.operationId}/upload-server`, { method: 'POST' });
        const serverJson = await serverRes.json();
        if (!serverRes.ok || !serverJson.ok) {
          throw new Error(serverJson?.error?.message ?? 'Failed to get upload server URL.');
        }
        const uploadUrl = serverJson.uploadUrl;

        // Step 2: POST the file directly to Vidara's upload server.
        const formData = new FormData();
        formData.append('file', flowState.selectedFile);
        const uploadRes = await fetch(uploadUrl, { method: 'POST', body: formData });
        if (!uploadRes.ok) {
          let errMsg = `Upload failed (HTTP ${uploadRes.status})`;
          try {
            const errJson = await uploadRes.json();
            errMsg = errJson?.message ?? errJson?.error ?? errMsg;
          } catch { /* non-JSON error */ }
          throw new Error(errMsg);
        }
        const providerResult = await uploadRes.json();

        // Step 3: complete the operation server-side.
        const completeRes = await fetch(`/api/admin/media/upload/${flowState.operationId}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerResult }),
        });
        const completeJson = await completeRes.json();
        if (!completeRes.ok || !completeJson.ok) {
          throw new Error(completeJson?.error?.message ?? 'Failed to complete upload.');
        }

        flowState.operationStatus = completeJson.operation.status;
        flowState.step = 'processing';
        startPolling();
      } else {
        // Abyss: server-proxied upload.
        const formData = new FormData();
        formData.append('file', flowState.selectedFile);
        formData.append('providerSourceId', flowState.providerSourceId);
        formData.append('providerAdapterId', flowState.providerAdapterId);

        const proxyRes = await fetch(`/api/admin/media/upload/${flowState.operationId}/proxy-upload`, {
          method: 'POST',
          body: formData,
        });
        const proxyJson = await proxyRes.json();
        if (!proxyRes.ok || !proxyJson.ok) {
          throw new Error(proxyJson?.error?.message ?? 'Proxy upload failed.');
        }

        flowState.operationStatus = proxyJson.operation.status;
        flowState.step = 'processing';
        startPolling();
      }
    } catch (err) {
      flowState.operationError = err instanceof Error ? err.message : 'Upload failed.';
      flowState.step = 'done';
    }
  }

  // ============================================================
  // Polling — with POLL_MAX_ATTEMPTS cap + error recovery
  // ============================================================

  function startPolling() {
    stopPolling();
    pollAttempts = 0;
    pollInterval = setInterval(() => pollOnce(), POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  let pollError = $state('');
  let pollStale = $state(false);

  async function pollOnce() {
    if (!flowState.operationId) return;
    pollAttempts++;
    if (pollAttempts > POLL_MAX_ATTEMPTS) {
      stopPolling();
      pollStale = true;
      return;
    }
    try {
      const res = await fetch(`/api/admin/media/upload/${flowState.operationId}/status`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error?.message ?? `Poll failed (HTTP ${res.status})`);
      }
      flowState.operationStatus = json.status;
      pollError = '';
      if (json.ready) {
        stopPolling();
        flowState.step = 'done';
      } else if (json.failed) {
        stopPolling();
        flowState.operationError = json.error?.message ?? 'Processing failed.';
        flowState.errorCode = json.error?.code ?? 'FAILED';
        flowState.step = 'done';
      }
    } catch (err) {
      // Don't kill polling on a single network error — surface it.
      pollError = err instanceof Error ? err.message : 'Poll failed.';
    }
  }

  // ============================================================
  // Cancel + Retry
  // ============================================================

  let cancelling = $state(false);

  async function cancelUpload() {
    if (!flowState.operationId) return;
    cancelling = true;
    try {
      stopPolling();
      const res = await fetch(`/api/admin/media/upload/${flowState.operationId}/cancel`, { method: 'POST' });
      const json = await res.json();
      if (res.ok && json.ok) {
        flowState.operationStatus = 'cancelled';
        flowState.step = 'done';
      }
    } catch { /* swallow */ } finally {
      cancelling = false;
    }
  }

  let retrying = $state(false);

  async function retryUpload() {
    if (!flowState.operationId) return;
    retrying = true;
    try {
      // The retry endpoint creates a new queued operation linked to the
      // original via parent_operation_id. Phase D fix: the service now
      // preserves source_url/filename/quality, so the client does NOT
      // need to call createOperation again — the new operation is
      // ready to drive directly.
      const res = await fetch(`/api/admin/media/upload/${flowState.operationId}/retry`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error?.message ?? 'Retry failed.');
      }
      flowState.operationId = json.operation.id;
      flowState.operationStatus = json.operation.status;
      flowState.operationError = '';
      flowState.errorCode = '';

      // FINDING-013 fix: for remote-URL retries, use the dedicated
      // /execute-remote endpoint instead of calling createOperation
      // again (which created a THIRD orphan operation row). The retry
      // operation already carries source_url from the parent — we just
      // need to tell the server to execute it.
      if (json.operation.source_url) {
        flowState.step = 'processing';
        startPolling();
        const execRes = await fetch(`/api/admin/media/upload/${flowState.operationId}/execute-remote`, { method: 'POST' });
        const execJson = await execRes.json();
        if (!execRes.ok || !execJson.ok) {
          throw new Error(execJson?.error?.message ?? 'Remote upload execution failed.');
        }
        flowState.operationStatus = execJson.operation.status;
      } else {
        // Local upload — re-drive the browser-direct/proxy flow.
        flowState.step = 'uploading';
        await executeLocalUpload();
      }
    } catch (err) {
      flowState.operationError = err instanceof Error ? err.message : 'Retry failed.';
    } finally {
      retrying = false;
    }
  }

  // ============================================================
  // Subtitle sub-flow
  // ============================================================

  let subtitleFile = $state<File | null>(null);
  let subtitleLanguage = $state('');
  let subtitleLabel = $state('');
  let subtitleUploading = $state(false);

  function openSubtitleSheet() {
    subtitleSheetOpen = true;
    flowState.subtitleOpen = true;
  }

  function closeSubtitleSheet() {
    subtitleSheetOpen = false;
    flowState.subtitleOpen = false;
  }

  function onSubtitleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      subtitleFile = input.files[0];
    }
  }

  async function uploadSubtitle() {
    if (!flowState.operationId || !subtitleFile || !subtitleLanguage.trim()) return;
    subtitleUploading = true;
    flowState.subtitleError = '';
    try {
      const formData = new FormData();
      formData.append('file', subtitleFile);
      formData.append('language', subtitleLanguage);
      if (subtitleLabel) formData.append('label', subtitleLabel);
      const res = await fetch(`/api/admin/media/upload/${flowState.operationId}/subtitle`, {
        method: 'POST',
        body: formData,
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error?.message ?? 'Subtitle upload failed.');
      }
      flowState.subtitleResult = 'success';
      // Close sheet after short delay so user sees the success flowState.
      setTimeout(() => closeSubtitleSheet(), 1200);
    } catch (err) {
      flowState.subtitleResult = 'failed';
      flowState.subtitleError = err instanceof Error ? err.message : 'Subtitle upload failed.';
    } finally {
      subtitleUploading = false;
    }
  }

  // ============================================================
  // Result actions
  // ============================================================

  function uploadAnother() {
    stopPolling();
    flowState = {
      step: 'search',
      selectedTitle: null,
      contentType: 'movie',
      season: null,
      episode: null,
      episodeTitle: '',
      imdbId: null,
      providerSourceId: '',
      providerAdapterId: '',
      providerName: '',
      providerCapabilities: null,
      uploadSource: 'local',
      remoteUrl: '',
      selectedFile: null,
      sourceQuality: '',
      operationId: null,
      operationStatus: '',
      operationError: '',
      errorCode: '',
      subtitleOpen: false,
      subtitleResult: '',
      subtitleError: '',
    };
    searchQuery = '';
    searchResults = [];
    searchError = '';
    syncUrl();
  }

  function goToMediaLibrary() {
    void goto('/admin/media/library');
  }

  function goToMediaDetail() {
    if (flowState.selectedTitle) {
      void goto(`/admin/media/library?selected=${flowState.selectedTitle.tmdbId}`);
    } else {
      goToMediaLibrary();
    }
  }

  // ============================================================
  // Derived helpers
  // ============================================================

  const isReady = $derived(flowState.step === 'done' && flowState.operationStatus === 'ready');
  const isFailed = $derived(flowState.step === 'done' && (flowState.operationStatus === 'failed' || flowState.operationError !== ''));
  const isCancelled = $derived(flowState.step === 'done' && flowState.operationStatus === 'cancelled');

  const steps = [
    { id: 'search', label: 'Search', icon: Search },
    { id: 'metadata', label: 'Metadata', icon: FileVideo },
    { id: 'provider', label: 'Provider', icon: Server },
    { id: 'source', label: 'Source', icon: FileCheck },
    { id: 'review', label: 'Review', icon: FileCheck },
    { id: 'uploading', label: 'Upload', icon: Upload },
    { id: 'processing', label: 'Processing', icon: Loader },
    { id: 'done', label: 'Done', icon: CheckCircle },
  ];

  function activeStepIndex(): number {
    // Map the actual step to the indicator index (skip 'review' in indicator).
    const indicatorSteps = ['search', 'metadata', 'provider', 'source', 'uploading', 'processing', 'done'];
    return indicatorSteps.indexOf(flowState.step);
  }
</script>

<div class="upload-flow">
  <!-- ============================================================
       STEP INDICATOR
       ============================================================ -->
  <div class="upload-steps" role="tablist" aria-label="Upload workflow steps">
    {#each steps as step, i (step.id)}
      {@const Icon = step.icon}
      {@const isActive = i === activeStepIndex()}
      {@const isPast = i < activeStepIndex()}
      <div
        class="upload-step"
        class:active={isActive}
        class:past={isPast}
        role="tab"
        aria-selected={isActive}
        aria-current={isActive ? 'step' : undefined}
      >
        <span class="upload-step-icon"><Icon size={14} /></span>
        <span class="upload-step-label">{step.label}</span>
        <span class="upload-step-num">{i + 1}</span>
      </div>
    {/each}
  </div>

  <!-- ============================================================
       WORKSPACE — split layout (desktop) / stacked (mobile)
       ============================================================ -->
  <div class="upload-workspace">
    <div class="upload-main">
      <!-- ============================================================
           STEP 1: SEARCH
           ============================================================ -->
      {#if flowState.step === 'search'}
        <section class="upload-section">
          <h2 class="upload-section-title">Search TMDB</h2>
          <p class="upload-section-desc">Find the movie or series you want to upload. Search uses the existing TMDB integration.</p>

          <div class="search-controls">
            <div class="search-type-toggle" role="radiogroup" aria-label="Search type">
              <button type="button" class:active={searchType === 'movie'} onclick={() => searchType = 'movie'} role="radio" aria-checked={searchType === 'movie'}>Movie</button>
              <button type="button" class:active={searchType === 'series'} onclick={() => searchType = 'series'} role="radio" aria-checked={searchType === 'series'}>Series</button>
            </div>
            <input
              type="text"
              class="search-input"
              placeholder="Search by title…"
              value={searchQuery}
              oninput={handleSearchInput}
              aria-label="Search TMDB"
            />
          </div>

          {#if searching}
            <div class="search-loading" aria-live="polite">
              {#each Array(3) as _, i (i)}
                <div class="search-result-skeleton" aria-hidden="true"></div>
              {/each}
            </div>
          {:else if searchError}
            <div class="search-error">
              <AlertCircle size={16} />
              <span>{searchError}</span>
            </div>
          {:else if searchResults.length === 0 && searchQuery}
            <div class="search-empty">
              <div class="search-empty-title">No results</div>
              <div class="search-empty-desc">Try a different search term.</div>
            </div>
          {:else if searchResults.length > 0}
            <div class="search-results">
              {#each searchResults as result (result.id)}
                <button type="button" class="search-result" onclick={() => selectTitle(result)}>
                  {#if result.poster}
                    <img src={result.poster} alt="" class="result-poster" loading="lazy" />
                  {:else}
                    <div class="result-poster result-poster-empty"><FileVideo size={20} /></div>
                  {/if}
                  <div class="result-info">
                    <div class="result-title">{result.title}</div>
                    <div class="result-meta">
                      <span class="result-type type-{result.type}">{result.type}</span>
                      {#if result.year}<span class="result-year">{result.year}</span>{/if}
                      {#if result.imdbId}<span class="result-imdb">IMDb: {result.imdbId}</span>{/if}
                    </div>
                    {#if result.overview}
                      <div class="result-overview">{result.overview}</div>
                    {/if}
                  </div>
                  <ChevronRight size={16} class="result-chevron" />
                </button>
              {/each}
            </div>
          {:else}
            <div class="search-hint">
              <Search size={20} />
              <div>Search for a movie or series to begin.</div>
            </div>
          {/if}
        </section>
      {/if}

      <!-- ============================================================
           STEP 2: METADATA CONFIRMATION
           ============================================================ -->
      {#if flowState.step === 'metadata'}
        <section class="upload-section">
          <h2 class="upload-section-title">Confirm Metadata</h2>
          <p class="upload-section-desc">Verify the content identity before selecting a provider.</p>

          {#if flowState.selectedTitle}
            <div class="metadata-card">
              {#if flowState.selectedTitle.poster}
                <img src={flowState.selectedTitle.poster} alt="" class="metadata-poster" loading="lazy" />
              {:else}
                <div class="metadata-poster metadata-poster-empty"><FileVideo size={32} /></div>
              {/if}
              <div class="metadata-info">
                <div class="metadata-title">{flowState.selectedTitle.title}</div>
                <div class="metadata-meta">
                  <span class="result-type type-{flowState.selectedTitle.type}">{flowState.selectedTitle.type}</span>
                  {#if flowState.selectedTitle.year}<span>{flowState.selectedTitle.year}</span>{/if}
                  {#if flowState.imdbId}<span>IMDb: {flowState.imdbId}</span>{/if}
                  <span>TMDB: {flowState.selectedTitle.tmdbId}</span>
                </div>
                {#if flowState.selectedTitle.overview}
                  <div class="metadata-overview">{flowState.selectedTitle.overview}</div>
                {/if}
              </div>
            </div>
          {/if}

          <div class="metadata-form">
            <label class="form-field">
              <span class="form-label">Content Type</span>
              <select class="form-select" bind:value={flowState.contentType}>
                <option value="movie">Movie</option>
                <option value="series">Series</option>
                <option value="anime">Anime</option>
              </select>
            </label>

            {#if flowState.contentType === 'series' || flowState.contentType === 'anime'}
              <div class="form-row">
                <label class="form-field">
                  <span class="form-label">Season</span>
                  <input type="number" min="0" max="1000" class="form-input" bind:value={flowState.season} placeholder="e.g. 1" />
                </label>
                <label class="form-field">
                  <span class="form-label">Episode</span>
                  <input type="number" min="1" max="10000" class="form-input" bind:value={flowState.episode} placeholder="e.g. 1" />
                </label>
              </div>
              <label class="form-field">
                <span class="form-label">Episode Title (optional)</span>
                <input type="text" class="form-input" bind:value={flowState.episodeTitle} placeholder="Episode title" />
              </label>
            {/if}

            <label class="form-field">
              <span class="form-label">Source Quality (optional)</span>
              <input type="text" class="form-input" bind:value={flowState.sourceQuality} placeholder="e.g. 720p, 1080p" />
            </label>
          </div>

          {#if createError}
            <div class="form-error"><AlertCircle size={14} /> {createError}</div>
          {/if}
        </section>
      {/if}

      <!-- ============================================================
           STEP 3: PROVIDER SELECTION
           ============================================================ -->
      {#if flowState.step === 'provider'}
        <section class="upload-section">
          <h2 class="upload-section-title">Select Provider</h2>
          <p class="upload-section-desc">Choose a hosting provider. Capabilities are shown so you can pick the right one for your content.</p>

          {#if hostingSources.length === 0}
            <div class="provider-empty">
              <AlertCircle size={20} />
              <div class="provider-empty-title">No providers configured</div>
              <div class="provider-empty-desc">Configure Vidara or Abyss in the Providers page before uploading.</div>
              <a class="provider-empty-link" href="/admin/hosting">Configure Providers</a>
            </div>
          {:else}
            <div class="provider-list">
              {#each hostingSources as source (source.id)}
                <button
                  type="button"
                  class="provider-card"
                  onclick={() => selectProvider(source)}
                >
                  <div class="provider-card-head">
                    <div class="provider-card-name">{source.providerName ?? source.name}</div>
                    <div class="provider-card-adapter">{source.adapterId}</div>
                  </div>
                  {#if source.capabilities}
                    <div class="provider-caps">
                      {#if source.capabilities.localUpload}<span class="cap">Local Upload</span>{/if}
                      {#if source.capabilities.remoteUpload}<span class="cap">Remote URL</span>{/if}
                      {#if source.capabilities.multiAudio}<span class="cap cap-multi">Multi-Audio</span>{/if}
                      {#if source.capabilities.subtitles}<span class="cap">Subtitles</span>{/if}
                      {#if source.capabilities.transcoding}<span class="cap">Transcoding</span>{/if}
                      {#if source.capabilities.qualityVariants}<span class="cap">Quality Variants</span>{/if}
                      {#if source.capabilities.processingStatus}<span class="cap">Processing Status</span>{/if}
                    </div>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </section>
      {/if}

      <!-- ============================================================
           STEP 4: UPLOAD SOURCE
           ============================================================ -->
      {#if flowState.step === 'source'}
        <section class="upload-section">
          <h2 class="upload-section-title">Select Upload Method</h2>
          <p class="upload-section-desc">
            {#if flowState.providerCapabilities?.remoteUpload}
              Choose how to upload. This provider supports both local file and remote URL upload.
            {:else}
              This provider supports local file upload only. Remote URL upload is not API-verified.
            {/if}
          </p>

          {#if flowState.providerCapabilities?.localUpload && flowState.providerCapabilities?.remoteUpload}
            <div class="source-toggle" role="radiogroup" aria-label="Upload method">
              <button type="button" class:active={flowState.uploadSource === 'local'} onclick={() => flowState.uploadSource = 'local'} role="radio" aria-checked={flowState.uploadSource === 'local'}>
                <Upload size={14} /> Local File
              </button>
              <button type="button" class:active={flowState.uploadSource === 'remote'} onclick={() => flowState.uploadSource = 'remote'} role="radio" aria-checked={flowState.uploadSource === 'remote'}>
                <FileVideo size={14} /> Remote URL
              </button>
            </div>
          {/if}

          {#if flowState.uploadSource === 'local' && flowState.providerCapabilities?.localUpload}
            <div class="source-block">
              {#if flowState.selectedFile}
                <div class="file-selected">
                  <FileCheck size={20} />
                  <div class="file-info">
                    <div class="file-name">{flowState.selectedFile.name}</div>
                    <div class="file-size">{(flowState.selectedFile.size / 1024 / 1024).toFixed(2)} MB</div>
                  </div>
                  <button type="button" class="file-clear" onclick={clearFile} aria-label="Remove file">
                    <X size={14} />
                  </button>
                </div>
              {:else}
                <div
                  class="file-dropzone"
                  role="button"
                  tabindex="0"
                  ondrop={handleDrop}
                  ondragover={handleDragOver}
                  onclick={() => document.getElementById('file-input')?.click()}
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('file-input')?.click(); } }}
                  aria-label="Select file to upload"
                >
                  <Upload size={28} />
                  <div class="dropzone-title">Drop file here or click to select</div>
                  <div class="dropzone-desc">
                    {#if flowState.providerAdapterId === 'abyss'}
                      Max 5 MB (server proxy limit). Larger files require direct upload support.
                    {:else}
                      No client-side limit — browser-direct upload to provider.
                    {/if}
                  </div>
                </div>
                <input id="file-input" type="file" class="file-input-hidden" onchange={onFileSelect} accept="video/*" />
              {/if}
            </div>
          {/if}

          {#if flowState.uploadSource === 'remote' && flowState.providerCapabilities?.remoteUpload}
            <div class="source-block">
              <label class="form-field">
                <span class="form-label">Remote URL</span>
                <input type="url" class="form-input" bind:value={flowState.remoteUrl} placeholder="https://example.com/video.mp4" />
              </label>
              <div class="form-hint">The provider will fetch this URL server-side. Must be a direct downloadable media file.</div>
            </div>
          {/if}
        </section>
      {/if}

      <!-- ============================================================
           STEP 5: REVIEW
           ============================================================ -->
      {#if flowState.step === 'review'}
        <section class="upload-section">
          <h2 class="upload-section-title">Review & Confirm</h2>
          <p class="upload-section-desc">Verify all details before starting the upload.</p>

          <div class="review-grid">
            <div class="review-block">
              <div class="review-label">Title</div>
              <div class="review-value">{flowState.selectedTitle?.title ?? '—'}</div>
            </div>
            <div class="review-block">
              <div class="review-label">Type</div>
              <div class="review-value">{flowState.contentType}</div>
            </div>
            <div class="review-block">
              <div class="review-label">Year</div>
              <div class="review-value">{flowState.selectedTitle?.year ?? '—'}</div>
            </div>
            <div class="review-block">
              <div class="review-label">TMDB ID</div>
              <div class="review-value mono">{flowState.selectedTitle?.tmdbId ?? '—'}</div>
            </div>
            {#if flowState.imdbId}
              <div class="review-block">
                <div class="review-label">IMDb ID</div>
                <div class="review-value mono">{flowState.imdbId}</div>
              </div>
            {/if}
            {#if flowState.season != null}
              <div class="review-block">
                <div class="review-label">Season</div>
                <div class="review-value">{flowState.season}</div>
              </div>
            {/if}
            {#if flowState.episode != null}
              <div class="review-block">
                <div class="review-label">Episode</div>
                <div class="review-value">{flowState.episode}</div>
              </div>
            {/if}
            {#if flowState.episodeTitle}
              <div class="review-block">
                <div class="review-label">Episode Title</div>
                <div class="review-value">{flowState.episodeTitle}</div>
              </div>
            {/if}
            <div class="review-block">
              <div class="review-label">Provider</div>
              <div class="review-value">{flowState.providerName} ({flowState.providerAdapterId})</div>
            </div>
            <div class="review-block">
              <div class="review-label">Upload Method</div>
              <div class="review-value">{flowState.uploadSource === 'local' ? 'Local File' : 'Remote URL'}</div>
            </div>
            {#if flowState.uploadSource === 'local' && flowState.selectedFile}
              <div class="review-block">
                <div class="review-label">File</div>
                <div class="review-value">{flowState.selectedFile.name} ({(flowState.selectedFile.size / 1024 / 1024).toFixed(2)} MB)</div>
              </div>
            {/if}
            {#if flowState.uploadSource === 'remote'}
              <div class="review-block review-block-full">
                <div class="review-label">Remote URL</div>
                <div class="review-value mono">{flowState.remoteUrl}</div>
              </div>
            {/if}
            {#if flowState.sourceQuality}
              <div class="review-block">
                <div class="review-label">Source Quality</div>
                <div class="review-value">{flowState.sourceQuality}</div>
              </div>
            {/if}
          </div>

          {#if createError}
            <div class="form-error"><AlertCircle size={14} /> {createError}</div>
          {/if}
        </section>
      {/if}

      <!-- ============================================================
           STEP 6: UPLOADING
           ============================================================ -->
      {#if flowState.step === 'uploading'}
        <section class="upload-section">
          <h2 class="upload-section-title">Uploading…</h2>
          <p class="upload-section-desc">Uploading to {flowState.providerName}. Do not close this page.</p>

          <div class="progress-block">
            <div class="progress-spinner" aria-hidden="true"></div>
            <div class="progress-info">
              <div class="progress-status">{flowState.selectedFile?.name ?? flowState.remoteUrl}</div>
              <div class="progress-provider">{flowState.providerName}</div>
            </div>
          </div>
        </section>
      {/if}

      <!-- ============================================================
           STEP 7: PROCESSING
           ============================================================ -->
      {#if flowState.step === 'processing'}
        <section class="upload-section">
          <h2 class="upload-section-title">Processing…</h2>
          <p class="upload-section-desc">
            The provider is processing the upload. This may take several minutes.
            {#if pollStale}
              <span class="poll-stale">Processing is taking longer than expected. You can wait or cancel.</span>
            {/if}
          </p>

          <div class="progress-block">
            <div class="progress-spinner" aria-hidden="true"></div>
            <div class="progress-info">
              <div class="progress-status">Status: {flowState.operationStatus}</div>
              <div class="progress-meta">
                {flowState.providerName} · Poll {pollAttempts}/{POLL_MAX_ATTEMPTS}
                {#if pollError}<span class="poll-error"> · {pollError}</span>{/if}
              </div>
            </div>
          </div>

          <button type="button" class="upload-action upload-action-secondary" onclick={cancelUpload} disabled={cancelling}>
            {#if cancelling}<Loader size={13} class="spin" />{:else}<X size={13} />{/if}
            {cancelling ? 'Cancelling…' : 'Cancel Upload'}
          </button>
        </section>
      {/if}

      <!-- ============================================================
           STEP 8: DONE (success / failed / cancelled)
           ============================================================ -->
      {#if flowState.step === 'done'}
        <section class="upload-section">
          {#if isReady}
            <div class="result-block result-success">
              <div class="result-icon"><CheckCircle size={32} /></div>
              <h2 class="result-title">Upload Complete</h2>
              <div class="result-desc">
                {flowState.selectedTitle?.title} is now ready on {flowState.providerName}.
              </div>
              <div class="result-meta">
                <div class="result-meta-row"><span>Status</span><strong>Ready</strong></div>
                <div class="result-meta-row"><span>Provider</span><strong>{flowState.providerName}</strong></div>
                {#if flowState.operationId}<div class="result-meta-row"><span>Operation</span><strong class="mono">{flowState.operationId.slice(0, 8)}…</strong></div>{/if}
              </div>

              {#if flowState.subtitleResult === 'success'}
                <div class="result-subtitle result-subtitle-success">Subtitles: Uploaded</div>
              {:else if flowState.subtitleResult === 'failed'}
                <div class="result-subtitle result-subtitle-failed">Subtitles: Failed — {flowState.subtitleError}</div>
              {/if}

              <div class="result-actions">
                <button type="button" class="upload-action" onclick={openSubtitleSheet}>
                  <Subtitles size={13} /> Upload Subtitle
                </button>
                <button type="button" class="upload-action upload-action-secondary" onclick={goToMediaDetail}>
                  <Library size={13} /> View in Library
                </button>
                <button type="button" class="upload-action upload-action-secondary" onclick={uploadAnother}>
                  <Upload size={13} /> Upload Another
                </button>
              </div>
            </div>
          {:else if isFailed}
            <div class="result-block result-failed">
              <div class="result-icon"><AlertCircle size={32} /></div>
              <h2 class="result-title">Upload Failed</h2>
              <div class="result-desc">
                {flowState.operationError || 'The upload failed during processing.'}
              </div>
              {#if flowState.errorCode}
                <div class="result-error-code mono">Error: {flowState.errorCode}</div>
              {/if}
              {#if flowState.errorCode === 'STALE_OPERATION' || flowState.errorCode === 'MISSING_ASSET_ID'}
                <div class="result-hint">
                  The provider upload did not produce a valid asset record. This is usually a
                  server-side data issue — retry the upload, and if it fails again, check the
                  Operations Center for the full error log.
                </div>
              {:else if flowState.errorCode === 'DUPLICATE_PROVIDER_ASSET'}
                <div class="result-hint">
                  A media asset with the same provider file ID already exists. Use
                  &ldquo;Link existing file&rdquo; in the Media Library detail drawer to attach
                  the existing asset to this title, or delete the duplicate first.
                </div>
              {:else if flowState.errorCode === 'PROVIDER_PROCESSING'}
                <div class="result-hint">
                  The provider (Vidara/Abyss) accepted the upload but failed during
                  transcoding. Check the provider&rsquo;s dashboard for details, then retry.
                </div>
              {/if}
              <div class="result-actions">
                <button type="button" class="upload-action" onclick={retryUpload} disabled={retrying}>
                  {#if retrying}<Loader size={13} class="spin" />{:else}<RefreshCw size={13} />{/if}
                  {retrying ? 'Retrying…' : 'Retry Upload'}
                </button>
                <button type="button" class="upload-action upload-action-secondary" onclick={goToMediaLibrary}>
                  Back to Library
                </button>
              </div>
            </div>
          {:else if isCancelled}
            <div class="result-block result-cancelled">
              <div class="result-icon"><X size={32} /></div>
              <h2 class="result-title">Upload Cancelled</h2>
              <div class="result-desc">The upload was cancelled. No media was created.</div>
              <div class="result-actions">
                <button type="button" class="upload-action" onclick={uploadAnother}>
                  <Upload size={13} /> Start New Upload
                </button>
                <button type="button" class="upload-action upload-action-secondary" onclick={goToMediaLibrary}>
                  Back to Library
                </button>
              </div>
            </div>
          {/if}
        </section>
      {/if}
    </div>

    <!-- ============================================================
         CONTEXTUAL SIDE PANEL (desktop only)
         ============================================================ -->
    <aside class="upload-side">
      {#if flowState.selectedTitle}
        <div class="side-card">
          <div class="side-label">Selected Title</div>
          <div class="side-title">{flowState.selectedTitle.title}</div>
          <div class="side-meta">
            <span class="result-type type-{flowState.selectedTitle.type}">{flowState.selectedTitle.type}</span>
            {#if flowState.selectedTitle.year}<span>{flowState.selectedTitle.year}</span>{/if}
          </div>
          <div class="side-meta-row">
            <span class="side-meta-label">TMDB</span>
            <span class="mono">{flowState.selectedTitle.tmdbId}</span>
          </div>
          {#if flowState.imdbId}
            <div class="side-meta-row">
              <span class="side-meta-label">IMDb</span>
              <span class="mono">{flowState.imdbId}</span>
            </div>
          {/if}
        </div>
      {/if}

      {#if flowState.providerName}
        <div class="side-card">
          <div class="side-label">Provider</div>
          <div class="side-title">{flowState.providerName}</div>
          {#if flowState.providerCapabilities}
            <div class="side-caps">
              {#if flowState.providerCapabilities.multiAudio}<span class="cap cap-multi">Multi-Audio</span>{/if}
              {#if flowState.providerCapabilities.subtitles}<span class="cap">Subtitles</span>{/if}
              {#if flowState.providerCapabilities.transcoding}<span class="cap">Transcoding</span>{/if}
              {#if flowState.providerCapabilities.qualityVariants}<span class="cap">Variants</span>{/if}
            </div>
          {/if}
        </div>
      {/if}

      {#if flowState.operationId}
        <div class="side-card">
          <div class="side-label">Operation</div>
          <div class="side-title mono">{flowState.operationId.slice(0, 8)}…</div>
          <div class="side-meta-row">
            <span class="side-meta-label">Status</span>
            <span>{flowState.operationStatus || '—'}</span>
          </div>
        </div>
      {/if}
    </aside>
  </div>

  <!-- ============================================================
       STICKY ACTION BAR
       ============================================================ -->
  {#if flowState.step !== 'uploading' && flowState.step !== 'processing' && flowState.step !== 'done'}
    <div class="upload-actionbar">
      {#if canGoBack()}
        <button type="button" class="upload-action upload-action-secondary" onclick={goBack}>
          <ChevronLeft size={14} /> Back
        </button>
      {/if}
      <div class="actionbar-spacer"></div>
      {#if flowState.step === 'metadata'}
        <button type="button" class="upload-action upload-action-primary" onclick={confirmMetadata}>
          Continue <ChevronRight size={14} />
        </button>
      {:else if flowState.step === 'source'}
        <button type="button" class="upload-action upload-action-primary" onclick={confirmSource} disabled={flowState.uploadSource === 'local' ? !flowState.selectedFile : !flowState.remoteUrl.trim()}>
          Continue <ChevronRight size={14} />
        </button>
      {:else if flowState.step === 'review'}
        <button type="button" class="upload-action upload-action-primary" onclick={startUpload} disabled={creating}>
          {#if creating}<Loader size={14} class="spin" />{:else}<Upload size={14} />{/if}
          {creating ? 'Starting…' : 'Start Upload'}
        </button>
      {/if}
    </div>
  {/if}
</div>

<!-- ============================================================
     SUBTITLE BOTTOM SHEET
     ============================================================ -->
{#if subtitleSheetOpen}
  <div class="subtitle-overlay" onclick={closeSubtitleSheet} aria-hidden="true"></div>
  <div class="subtitle-sheet a2-scroll" role="dialog" aria-modal="true" aria-label="Upload subtitle">
    <div class="subtitle-sheet-head">
      <span class="subtitle-sheet-title"><Subtitles size={14} /> Upload Subtitle</span>
      <button type="button" class="subtitle-sheet-close" onclick={closeSubtitleSheet} aria-label="Close">
        <X size={16} />
      </button>
    </div>
    <div class="subtitle-sheet-body">
      <label class="form-field">
        <span class="form-label">Subtitle File (.srt, .vtt, .ass)</span>
        <input type="file" class="form-input" accept=".srt,.vtt,.ass" onchange={onSubtitleFileSelect} />
      </label>
      <label class="form-field">
        <span class="form-label">Language (ISO 639-1, e.g. en, hi)</span>
        <input type="text" class="form-input" bind:value={subtitleLanguage} placeholder="en" />
      </label>
      <label class="form-field">
        <span class="form-label">Label (optional)</span>
        <input type="text" class="form-input" bind:value={subtitleLabel} placeholder="English" />
      </label>

      {#if flowState.subtitleResult === 'failed'}
        <div class="form-error"><AlertCircle size={14} /> {flowState.subtitleError}</div>
      {/if}
      {#if flowState.subtitleResult === 'success'}
        <div class="form-success"><CheckCircle size={14} /> Subtitle uploaded successfully.</div>
      {/if}

      <button type="button" class="upload-action upload-action-primary" onclick={uploadSubtitle} disabled={subtitleUploading || !subtitleFile || !subtitleLanguage.trim()}>
        {#if subtitleUploading}<Loader size={13} class="spin" />{:else}<Upload size={13} />{/if}
        {subtitleUploading ? 'Uploading…' : 'Upload Subtitle'}
      </button>
    </div>
  </div>
{/if}

<style>
  .upload-flow {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-5);
  }

  /* ============================================================
     STEP INDICATOR
     ============================================================ */
  .upload-steps {
    display: flex;
    align-items: center;
    gap: var(--a2-space-1);
    padding: var(--a2-space-3) var(--a2-space-4);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .upload-steps::-webkit-scrollbar { display: none; }

  .upload-step {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-1) var(--a2-space-2);
    color: var(--a2-text-dim);
    font-size: var(--a2-text-xs);
    font-weight: 500;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .upload-step.active {
    color: var(--a2-cyan);
  }
  .upload-step.past {
    color: var(--a2-green);
  }
  .upload-step-icon {
    display: grid;
    place-items: center;
  }
  .upload-step-num {
    font-family: var(--a2-font-mono);
    font-size: 9px;
    opacity: 0.6;
  }

  /* ============================================================
     WORKSPACE
     ============================================================ */
  .upload-workspace {
    display: grid;
    grid-template-columns: 1fr 280px;
    gap: var(--a2-space-4);
    min-height: 0;
  }

  .upload-main {
    min-width: 0;
  }

  .upload-section {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-4);
  }
  .upload-section-title {
    margin: 0;
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-xl);
    font-weight: 700;
    color: var(--a2-text-bright);
    letter-spacing: -0.02em;
  }
  .upload-section-desc {
    margin: 0;
    color: var(--a2-text-muted);
    font-size: var(--a2-text-sm);
    line-height: 1.5;
  }

  /* ============================================================
     SEARCH
     ============================================================ */
  .search-controls {
    display: flex;
    gap: var(--a2-space-3);
    align-items: center;
  }
  .search-type-toggle {
    display: inline-flex;
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    overflow: hidden;
  }
  .search-type-toggle button {
    padding: var(--a2-space-2) var(--a2-space-4);
    border: none;
    background: var(--a2-surface-2);
    color: var(--a2-text-muted);
    font-size: var(--a2-text-sm);
    font-weight: 600;
    cursor: pointer;
    transition: background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .search-type-toggle button.active {
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
  }
  .search-input {
    flex: 1;
    padding: var(--a2-space-2) var(--a2-space-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-2);
    color: var(--a2-text);
    font-size: var(--a2-text-sm);
    outline: none;
    transition: border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .search-input:focus {
    border-color: var(--a2-cyan-border);
  }

  .search-results {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-2);
  }
  .search-result {
    display: flex;
    align-items: flex-start;
    gap: var(--a2-space-3);
    width: 100%;
    padding: var(--a2-space-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-2);
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color var(--a2-motion-micro) var(--a2-ease-out),
                background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .search-result:hover {
    border-color: var(--a2-cyan-border);
    background: var(--a2-surface-3);
  }
  .result-poster {
    width: 48px;
    height: 72px;
    object-fit: cover;
    border-radius: var(--a2-radius-sm);
    flex-shrink: 0;
  }
  .result-poster-empty {
    display: grid;
    place-items: center;
    background: var(--a2-surface-3);
    color: var(--a2-text-dim);
  }
  .result-info {
    flex: 1;
    min-width: 0;
  }
  .result-title {
    font-size: var(--a2-text-base);
    font-weight: 600;
    color: var(--a2-text-bright);
    margin-bottom: var(--a2-space-1);
  }
  .result-meta {
    display: flex;
    gap: var(--a2-space-2);
    flex-wrap: wrap;
    font-size: var(--a2-text-xs);
    color: var(--a2-text-dim);
    margin-bottom: var(--a2-space-1);
  }
  .result-type {
    padding: 1px 6px;
    border-radius: var(--a2-radius-xs);
    background: var(--a2-surface-3);
    color: var(--a2-text-muted);
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .result-type.type-movie { color: var(--a2-cyan); }
  .result-type.type-series { color: var(--a2-blue); }
  .result-type.type-anime { color: var(--a2-amber); }
  .result-overview {
    font-size: var(--a2-text-xs);
    color: var(--a2-text-muted);
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .result-chevron {
    color: var(--a2-text-dim);
    flex-shrink: 0;
    margin-top: var(--a2-space-1);
  }

  .search-result-skeleton {
    height: 84px;
    border-radius: var(--a2-radius-md);
    background: linear-gradient(90deg, var(--a2-surface-2) 0%, var(--a2-surface-3) 50%, var(--a2-surface-2) 100%);
    background-size: 200% 100%;
    animation: a2-skel 1.6s ease-in-out infinite;
  }
  @keyframes a2-skel {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  .search-empty, .search-hint {
    padding: var(--a2-space-8);
    text-align: center;
    color: var(--a2-text-dim);
  }
  .search-empty-title, .search-hint div {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text);
    margin-top: var(--a2-space-2);
  }
  .search-error {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-3);
    border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-red-soft);
    color: var(--a2-red);
    font-size: var(--a2-text-sm);
  }

  /* ============================================================
     METADATA
     ============================================================ */
  .metadata-card {
    display: flex;
    gap: var(--a2-space-4);
    padding: var(--a2-space-4);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-2);
  }
  .metadata-poster {
    width: 96px;
    height: 144px;
    object-fit: cover;
    border-radius: var(--a2-radius-sm);
    flex-shrink: 0;
  }
  .metadata-poster-empty {
    display: grid;
    place-items: center;
    background: var(--a2-surface-3);
    color: var(--a2-text-dim);
  }
  .metadata-info {
    flex: 1;
    min-width: 0;
  }
  .metadata-title {
    font-size: var(--a2-text-xl);
    font-weight: 700;
    color: var(--a2-text-bright);
    margin-bottom: var(--a2-space-2);
  }
  .metadata-meta {
    display: flex;
    gap: var(--a2-space-2);
    flex-wrap: wrap;
    font-size: var(--a2-text-xs);
    color: var(--a2-text-muted);
    margin-bottom: var(--a2-space-2);
  }
  .metadata-overview {
    font-size: var(--a2-text-sm);
    color: var(--a2-text-muted);
    line-height: 1.5;
  }

  .metadata-form {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-3);
  }
  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--a2-space-3);
  }
  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-1);
  }
  .form-label {
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--a2-text-dim);
  }
  .form-input, .form-select {
    padding: var(--a2-space-2) var(--a2-space-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-2);
    color: var(--a2-text);
    font-size: var(--a2-text-sm);
    outline: none;
    transition: border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .form-input:focus, .form-select:focus {
    border-color: var(--a2-cyan-border);
  }

  .form-error {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-red-soft);
    color: var(--a2-red);
    font-size: var(--a2-text-xs);
  }
  .form-success {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    border: 1px solid var(--a2-green-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-green-soft);
    color: var(--a2-green);
    font-size: var(--a2-text-xs);
  }

  /* ============================================================
     PROVIDER
     ============================================================ */
  .provider-list {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-3);
  }
  .provider-card {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-2);
    padding: var(--a2-space-4);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-2);
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color var(--a2-motion-micro) var(--a2-ease-out),
                background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .provider-card:hover {
    border-color: var(--a2-cyan-border);
    background: var(--a2-surface-3);
  }
  .provider-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .provider-card-name {
    font-size: var(--a2-text-base);
    font-weight: 700;
    color: var(--a2-text-bright);
  }
  .provider-card-adapter {
    font-family: var(--a2-font-mono);
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .provider-caps {
    display: flex;
    gap: var(--a2-space-1);
    flex-wrap: wrap;
  }
  .cap {
    padding: 2px 8px;
    border-radius: var(--a2-radius-xs);
    background: var(--a2-surface-3);
    color: var(--a2-text-muted);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .cap-multi {
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
  }

  .provider-empty {
    padding: var(--a2-space-8);
    text-align: center;
    color: var(--a2-text-dim);
  }
  .provider-empty-title {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text);
    margin-top: var(--a2-space-2);
  }
  .provider-empty-desc {
    font-size: var(--a2-text-xs);
    margin-top: var(--a2-space-1);
  }
  .provider-empty-link {
    display: inline-block;
    margin-top: var(--a2-space-3);
    padding: var(--a2-space-2) var(--a2-space-4);
    border: 1px solid var(--a2-cyan-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
    text-decoration: none;
    font-size: var(--a2-text-sm);
    font-weight: 600;
  }

  /* ============================================================
     SOURCE
     ============================================================ */
  .source-toggle {
    display: inline-flex;
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    overflow: hidden;
    width: fit-content;
  }
  .source-toggle button {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-4);
    border: none;
    background: var(--a2-surface-2);
    color: var(--a2-text-muted);
    font-size: var(--a2-text-sm);
    font-weight: 600;
    cursor: pointer;
  }
  .source-toggle button.active {
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
  }

  .file-dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-8);
    border: 2px dashed var(--a2-border-strong);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-2);
    color: var(--a2-text-muted);
    cursor: pointer;
    transition: border-color var(--a2-motion-micro) var(--a2-ease-out),
                background var(--a2-motion-micro) var(--a2-ease-out);
    text-align: center;
  }
  .file-dropzone:hover, .file-dropzone:focus-visible {
    border-color: var(--a2-cyan-border);
    background: var(--a2-surface-3);
    outline: none;
  }
  .dropzone-title {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text);
  }
  .dropzone-desc {
    font-size: var(--a2-text-xs);
    color: var(--a2-text-dim);
  }
  .file-input-hidden {
    display: none;
  }

  .file-selected {
    display: flex;
    align-items: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-4);
    border: 1px solid var(--a2-green-border);
    border-radius: var(--a2-radius-md);
    background: var(--a2-green-soft);
    color: var(--a2-green);
  }
  .file-info {
    flex: 1;
  }
  .file-name {
    font-size: var(--a2-text-sm);
    font-weight: 600;
  }
  .file-size {
    font-size: var(--a2-text-xs);
    color: var(--a2-text-muted);
  }
  .file-clear {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: var(--a2-radius-sm);
    background: transparent;
    color: var(--a2-text-muted);
    cursor: pointer;
  }

  .form-hint {
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim);
    margin-top: var(--a2-space-1);
  }

  /* ============================================================
     REVIEW
     ============================================================ */
  .review-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--a2-space-3);
  }
  .review-block {
    padding: var(--a2-space-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-2);
  }
  .review-block-full {
    grid-column: 1 / -1;
  }
  .review-label {
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--a2-text-dim);
    margin-bottom: var(--a2-space-1);
  }
  .review-value {
    font-size: var(--a2-text-sm);
    color: var(--a2-text);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mono {
    font-family: var(--a2-font-mono);
    font-size: var(--a2-text-xs);
  }

  /* ============================================================
     PROGRESS
     ============================================================ */
  .progress-block {
    display: flex;
    align-items: center;
    gap: var(--a2-space-4);
    padding: var(--a2-space-6);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-2);
  }
  .progress-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--a2-surface-3);
    border-top-color: var(--a2-cyan);
    border-radius: 50%;
    animation: a2-spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes a2-spin {
    to { transform: rotate(360deg); }
  }
  .spin {
    animation: a2-spin 0.8s linear infinite;
  }
  .progress-status {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text);
  }
  .progress-provider, .progress-meta {
    font-size: var(--a2-text-xs);
    color: var(--a2-text-dim);
    margin-top: 2px;
  }
  .poll-error {
    color: var(--a2-amber);
  }
  .poll-stale {
    color: var(--a2-amber);
    font-weight: 600;
    display: block;
    margin-top: var(--a2-space-1);
  }

  /* ============================================================
     RESULT
     ============================================================ */
  .result-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-8);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-2);
    text-align: center;
  }
  .result-block.result-success {
    border-color: var(--a2-green-border);
    background: var(--a2-green-soft);
  }
  .result-block.result-failed {
    border-color: var(--a2-red-border);
    background: var(--a2-red-soft);
  }
  .result-block.result-cancelled {
    border-color: var(--a2-border-strong);
  }
  .result-icon {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    border-radius: 50%;
  }
  .result-success .result-icon { color: var(--a2-green); }
  .result-failed .result-icon { color: var(--a2-red); }
  .result-cancelled .result-icon { color: var(--a2-text-muted); }
  .result-title {
    margin: 0;
    font-size: var(--a2-text-xl);
    font-weight: 700;
    color: var(--a2-text-bright);
  }
  .result-desc {
    color: var(--a2-text-muted);
    font-size: var(--a2-text-sm);
    line-height: 1.5;
    max-width: 480px;
  }
  .result-error-code {
    color: var(--a2-red);
    font-size: var(--a2-text-xs);
    padding: var(--a2-space-1) var(--a2-space-2);
    border-radius: var(--a2-radius-xs);
    background: rgba(255, 77, 109, 0.1);
  }
  .result-hint {
    color: var(--a2-text-muted);
    font-size: var(--a2-text-xs);
    line-height: 1.5;
    padding: var(--a2-space-2) var(--a2-space-3);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    max-width: 480px;
  }
  .result-meta {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-1);
    margin-top: var(--a2-space-2);
  }
  .result-meta-row {
    display: flex;
    justify-content: space-between;
    gap: var(--a2-space-4);
    font-size: var(--a2-text-xs);
    color: var(--a2-text-muted);
  }
  .result-meta-row strong {
    color: var(--a2-text);
    font-weight: 600;
  }
  .result-subtitle {
    margin-top: var(--a2-space-2);
    padding: var(--a2-space-1) var(--a2-space-3);
    border-radius: var(--a2-radius-xs);
    font-size: var(--a2-text-xs);
    font-weight: 600;
  }
  .result-subtitle-success {
    background: var(--a2-green-soft);
    color: var(--a2-green);
  }
  .result-subtitle-failed {
    background: var(--a2-red-soft);
    color: var(--a2-red);
  }
  .result-actions {
    display: flex;
    gap: var(--a2-space-2);
    margin-top: var(--a2-space-4);
    flex-wrap: wrap;
    justify-content: center;
  }

  /* ============================================================
     SIDE PANEL
     ============================================================ */
  .upload-side {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-3);
  }
  .side-card {
    padding: var(--a2-space-4);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-2);
  }
  .side-label {
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--a2-text-dim);
    margin-bottom: var(--a2-space-1);
  }
  .side-title {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text-bright);
    margin-bottom: var(--a2-space-2);
  }
  .side-meta {
    display: flex;
    gap: var(--a2-space-2);
    font-size: var(--a2-text-xs);
    color: var(--a2-text-muted);
    margin-bottom: var(--a2-space-2);
  }
  .side-meta-row {
    display: flex;
    justify-content: space-between;
    font-size: var(--a2-text-xs);
    color: var(--a2-text-muted);
    padding: var(--a2-space-1) 0;
    border-top: 1px solid var(--a2-border);
  }
  .side-meta-label {
    color: var(--a2-text-dim);
  }
  .side-caps {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-top: var(--a2-space-1);
  }

  /* ============================================================
     ACTION BAR
     ============================================================ */
  .upload-actionbar {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-3) 0;
    border-top: 1px solid var(--a2-border);
  }
  .actionbar-spacer {
    flex: 1;
  }
  .upload-action {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-4);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-2);
    color: var(--a2-text);
    font-size: var(--a2-text-sm);
    font-weight: 600;
    cursor: pointer;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .upload-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .upload-action-primary {
    background: var(--a2-cyan-soft);
    border-color: var(--a2-cyan-border);
    color: var(--a2-cyan);
  }
  .upload-action-primary:hover:not(:disabled) {
    background: var(--a2-surface-3);
    border-color: var(--a2-cyan);
  }
  .upload-action-secondary {
    background: var(--a2-surface-2);
    color: var(--a2-text-muted);
  }
  .upload-action-secondary:hover:not(:disabled) {
    background: var(--a2-surface-3);
    color: var(--a2-text);
  }

  /* ============================================================
     SUBTITLE SHEET
     ============================================================ */
  .subtitle-overlay {
    position: fixed;
    inset: 0;
    z-index: 90;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
  }
  .subtitle-sheet {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    z-index: 91;
    max-height: 80dvh;
    overflow-y: auto;
    background: var(--a2-surface-2);
    border-top: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-xl) var(--a2-radius-xl) 0 0;
    padding: var(--a2-space-5) var(--a2-space-4) var(--a2-space-6);
    animation: a2-slide-up var(--a2-motion-slow) var(--a2-ease-out);
  }
  @keyframes a2-slide-up {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
  .subtitle-sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--a2-space-4);
  }
  .subtitle-sheet-title {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    font-size: var(--a2-text-lg);
    font-weight: 700;
    color: var(--a2-text-bright);
  }
  .subtitle-sheet-close {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-3);
    color: var(--a2-text-muted);
    cursor: pointer;
  }
  .subtitle-sheet-body {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-3);
  }
  .subtitle-sheet-body .upload-action {
    margin-top: var(--a2-space-2);
    justify-content: center;
  }

  /* ============================================================
     RESPONSIVE
     ============================================================ */
  @media (max-width: 1023px) {
    .upload-workspace {
      grid-template-columns: 1fr;
    }
    .upload-side {
      display: none;
    }
    .review-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 640px) {
    .search-controls {
      flex-direction: column;
      align-items: stretch;
    }
    .search-type-toggle {
      width: 100%;
    }
    .search-type-toggle button {
      flex: 1;
    }
    .metadata-card {
      flex-direction: column;
    }
    .metadata-poster {
      width: 100%;
      height: 200px;
    }
    .form-row {
      grid-template-columns: 1fr;
    }
    .upload-steps {
      padding: var(--a2-space-2);
    }
    .upload-step-label {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .progress-spinner, .spin { animation: none; }
    .search-result-skeleton { animation: none; }
    .subtitle-sheet { animation: none; }
    .upload-action, .search-result, .provider-card, .file-dropzone { transition: none; }
  }
</style>
