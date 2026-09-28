<script lang="ts">
  /**
   * Phase 6 — Admin upload wizard.
   *
   * Multi-step upload workflow:
   *   1. Search TMDB
   *   2. Select title
   *   3. Select content type / season / episode
   *   4. Select provider
   *   5. Select upload source (local file / remote URL)
   *   6. Optional subtitle configuration
   *   7. Review
   *   8. Upload
   *   9. Processing status
   *  10. Ready / Failed
   */

  import { goto } from '$app/navigation';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminFormSection from '$lib/components/admin/AdminFormSection.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import type { PageData } from './$types';

  export let data: PageData;

  type Step = 'search' | 'select' | 'content-type' | 'provider' | 'upload-source' | 'review' | 'uploading' | 'processing' | 'done';
  let step: Step = 'search';

  // TMDB search state.
  let searchQuery = '';
  let searchType: 'movie' | 'series' = 'movie';
  let searchResults: Array<{ id: string; title: string; year?: number; poster?: string; type: string }> = [];
  let searching = false;
  let searchError = '';

  // Selected title.
  let selectedTmdbId = '';
  let selectedTitle = '';
  let selectedYear: number | null = null;
  let selectedContentType: 'movie' | 'series' | 'anime' = 'movie';
  let selectedImdbId: string | null = null;

  // Episode selection.
  let selectedSeason: number | null = null;
  let selectedEpisode: number | null = null;
  let episodeTitle = '';

  // Provider selection.
  let selectedProviderSourceId = '';
  let selectedProviderAdapterId = '';
  let selectedProviderName = '';

  // Upload source.
  let uploadSource: 'local' | 'remote' = 'local';
  let remoteUrl = '';
  let selectedFile: File | null = null;
  let sourceQuality = '';

  // Operation state.
  let operationId: string | null = null;
  let operationStatus = '';
  let operationError = '';
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let progressPercent: number | null = null;
  let providerStatus: string | null = null;

  // Subtitle state.
  let subtitleFile: File | null = null;
  let subtitleLanguage = '';
  let subtitleLabel = '';
  let subtitleUploading = false;
  let subtitleResult: '' | 'success' | 'failed' = '';
  let subtitleError = '';

  // --- Step 1: Search TMDB ---
  async function doSearch() {
    if (!searchQuery.trim()) return;
    searching = true;
    searchError = '';
    try {
      const res = await fetch(`/api/admin/media/search?q=${encodeURIComponent(searchQuery)}&type=${searchType}`);
      const data = await res.json();
      if (data.ok) {
        searchResults = (data.results?.items ?? []).map((item: { id: string; title: string; year?: number; poster?: string; type: string }) => ({
          id: item.id,
          title: item.title,
          year: item.year,
          poster: item.poster,
          type: item.type,
        }));
      } else {
        searchError = data.error?.message ?? 'Search failed.';
      }
    } catch {
      searchError = 'Network error.';
    }
    searching = false;
  }

  // --- Step 2: Select title ---
  function selectTitle(result: { id: string; title: string; year?: number }) {
    selectedTmdbId = result.id.replace(/^(movie|series|anime)-/, '');
    selectedTitle = result.title;
    selectedYear = result.year ?? null;
    selectedContentType = searchType === 'series' ? 'series' : 'movie';
    step = 'content-type';
  }

  // --- Step 3: Content type / season / episode ---
  function confirmContentType() {
    step = 'provider';
  }

  // --- Step 4: Provider selection ---
  function selectProvider(source: { id: string; name: string; adapterId: string | null }) {
    selectedProviderSourceId = source.id;
    selectedProviderName = source.name;
    selectedProviderAdapterId = source.adapterId ?? '';
    step = 'upload-source';
  }

  // --- Step 5: Upload source ---
  function onFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      selectedFile = input.files[0];
    }
  }

  function confirmUploadSource() {
    step = 'review';
  }

  // --- Step 7: Review ---
  function startUpload() {
    step = 'uploading';
    createOperation();
  }

  // --- Step 8: Create operation + execute ---
  async function createOperation() {
    try {
      const body: Record<string, unknown> = {
        tmdbId: selectedTmdbId,
        title: selectedTitle,
        year: selectedYear,
        contentType: selectedContentType,
        providerSourceId: selectedProviderSourceId,
        providerAdapterId: selectedProviderAdapterId,
        uploadSource,
        filename: selectedFile?.name ?? undefined,
        sourceQuality: sourceQuality || undefined,
      };

      if (selectedContentType === 'series' || selectedContentType === 'anime') {
        if (selectedSeason != null) body.season = selectedSeason;
        if (selectedEpisode != null) body.episode = selectedEpisode;
        if (episodeTitle) body.episodeTitle = episodeTitle;
      }

      if (uploadSource === 'remote') {
        body.remoteUrl = remoteUrl;
      }

      const res = await fetch('/api/admin/media/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!data.ok) {
        operationError = data.error?.message ?? 'Upload failed.';
        step = 'done';
        return;
      }

      operationId = data.operation.id;
      operationStatus = data.operation.status;

      if (uploadSource === 'remote') {
        // Remote upload was executed server-side.
        operationStatus = data.operation.status;
        if (operationStatus === 'processing' || operationStatus === 'uploaded') {
          step = 'processing';
          startPolling();
        } else if (operationStatus === 'ready') {
          step = 'done';
        } else if (operationStatus === 'failed') {
          operationError = data.operation.error_message ?? 'Upload failed.';
          step = 'done';
        }
      } else {
        // Local upload — browser uploads directly to provider (Vidara) or
        // through a proxy route (Abyss). For Phase 6, we handle Vidara
        // browser-direct upload here.
        await executeLocalUpload();
      }
    } catch (err) {
      operationError = err instanceof Error ? err.message : 'Unknown error.';
      step = 'done';
    }
  }

  async function executeLocalUpload() {
    if (!selectedFile || !operationId) {
      operationError = 'No file selected or operation ID missing.';
      step = 'done';
      return;
    }

    // For Vidara: get the upload server URL, then upload directly.
    // For Abyss: proxy through the server (documented Netlify body limit).
    if (selectedProviderAdapterId === 'vidara') {
      try {
        // Get the upload server URL via the admin API.
        const serverRes = await fetch(`/api/admin/media/upload/${operationId}/upload-server`, { method: 'POST' });
        const serverData = await safeJsonParse(serverRes, 'Failed to get upload server URL.');
        if (!serverData.ok) throw new Error(serverData.error?.message ?? 'Failed to get upload server URL.');
        const uploadUrl = serverData.uploadUrl as string | undefined;
        if (!uploadUrl || typeof uploadUrl !== 'string') throw new Error('Upload server URL missing from response.');

        // Upload directly to Vidara's upload server.
        const formData = new FormData();
        formData.append('file', selectedFile);
        const uploadRes = await fetch(uploadUrl, { method: 'POST', body: formData });
        const uploadData = await safeJsonParse(uploadRes, 'Vidara upload returned an unexpected response.');

        // Report the result back to the server.
        const completeRes = await fetch(`/api/admin/media/upload/${operationId}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerResult: uploadData }),
        });
        const completeData = await safeJsonParse(completeRes, 'Upload completion returned an unexpected response.');

        if (completeData.ok) {
          operationStatus = (completeData.operation as { status?: string } | undefined)?.status ?? 'processing';
          step = 'processing';
          startPolling();
        } else {
          operationError = completeData.error?.message ?? 'Upload completion failed.';
          step = 'done';
        }
      } catch (err) {
        operationError = err instanceof Error ? err.message : 'Local upload failed.';
        step = 'done';
      }
    } else {
      // Abyss: server-proxied upload (limited by Netlify serverless function body limit).
      // For larger files, the admin should use remote URL upload (not yet
      // supported for Abyss — documented limitation).
      try {
        // Upload through the server proxy.
        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('providerSourceId', selectedProviderSourceId);
        formData.append('providerAdapterId', selectedProviderAdapterId);

        const uploadRes = await fetch(`/api/admin/media/upload/${operationId}/proxy-upload`, {
          method: 'POST',
          body: formData,
        });

        // CRITICAL: the proxy-upload route ALWAYS returns structured
        // JSON — even on error. The fixed safeJsonParse now parses the
        // JSON body EVEN on error status codes, so the actual
        // server-side error message (e.g. "File is 9.2 MB. Server-
        // proxied upload is limited to 6 MB...") is surfaced to the
        // user. If Netlify ITSELF rejects the request (before the route
        // runs), the response will be non-JSON — safeJsonParse falls
        // back to a status-specific message.
        const uploadData = await safeJsonParse(uploadRes, 'Abyss upload failed.', {
          413: 'The upload request was rejected because the file exceeds the platform request-body limit. Use a smaller file.',
          504: 'The upload request timed out. Try again with a smaller file.',
        });

        if (uploadData.ok) {
          operationStatus = (uploadData.operation as { status?: string } | undefined)?.status ?? 'processing';
          step = 'processing';
          startPolling();
        } else {
          operationError = uploadData.error?.message ?? 'Abyss upload failed.';
          step = 'done';
        }
      } catch (err) {
        operationError = err instanceof Error ? err.message : 'Abyss local upload failed.';
        step = 'done';
      }
    }
  }

  /**
   * Safely parses a fetch response as JSON, handling empty bodies,
   * non-JSON responses (e.g. Netlify HTML error pages), and network
   * errors. NEVER throws "Unexpected end of JSON input" — produces a
   * meaningful error message instead.
   *
   * CRITICAL FIX: this function now parses the JSON body EVEN when the
   * HTTP status is not 2xx. The previous version checked `!res.ok` first
   * and returned a generic message WITHOUT parsing the body — this
   * SWALLOWED the actual server-side error code/message that the route
   * deliberately returned in its JSON body (e.g. { ok: false, error:
   * { code: 'AUTHENTICATION', message: 'Provider authentication
   * failed...' } }). The user saw "Failed to get upload server URL.
   * (HTTP 502)" instead of the actual "Provider authentication failed."
   * message.
   *
   * Now the function ALWAYS attempts to parse the JSON body first. If
   * the body is valid JSON and contains `error.message`, that message is
   * used. If the body is not JSON (e.g. Netlify's HTML error page for
   * oversized requests), the status-specific fallback message is used.
   *
   * @param res The fetch Response to parse.
   * @param fallbackMessage The error message to use when the response is not JSON or is empty.
   * @param statusMessages Optional status-code-specific messages (e.g. { 413: 'File too large' }).
   * @returns The parsed JSON object (may have { ok: false, error: { message } } on failure).
   */
  async function safeJsonParse(res: Response, fallbackMessage: string, statusMessages?: Record<number, string>): Promise<{ ok: boolean; error?: { message: string; code?: string }; [key: string]: unknown }> {
    let raw: string | null = null;
    try {
      raw = await res.text();
    } catch {
      // Body could not be read (network error, stream error).
    }

    // If the body is empty AND the HTTP status is an error, produce a
    // status-specific message. This handles the case where Netlify
    // itself rejects the request (e.g. 413 for oversized body) and
    // returns an empty or non-JSON response.
    if (!raw || !raw.trim()) {
      if (!res.ok) {
        const statusMessage = statusMessages?.[res.status];
        const message = statusMessage ?? `${fallbackMessage} (HTTP ${res.status})`;
        return { ok: false, error: { message } };
      }
      return { ok: false, error: { message: `${fallbackMessage} (empty response body)` } };
    }

    // Attempt JSON parse — EVEN on error status codes. The server
    // deliberately returns structured JSON errors with HTTP error
    // status codes (e.g. 502 with { ok: false, error: { code:
    // 'AUTHENTICATION', message: '...' } }). We MUST parse the body
    // to surface the actual error message instead of a generic
    // "(HTTP xxx)" message.
    try {
      const parsed = JSON.parse(raw) as { ok: boolean; error?: { message: string; code?: string }; [key: string]: unknown };
      // If the parsed JSON has an error message, use it. This is the
      // actual server-side error message — NOT a generic fallback.
      if (!parsed.ok && parsed.error?.message) {
        return parsed;
      }
      return parsed;
    } catch {
      // Non-JSON response (e.g. HTML error page from Netlify).
      if (!res.ok) {
        const statusMessage = statusMessages?.[res.status];
        const message = statusMessage ?? `${fallbackMessage} (HTTP ${res.status})`;
        return { ok: false, error: { message } };
      }
      return { ok: false, error: { message: `${fallbackMessage} (non-JSON response)` } };
    }
  }

  // --- Step 9: Processing status polling ---
  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
      if (!operationId) return;
      try {
        const res = await fetch(`/api/admin/media/upload/${operationId}/status`, { method: 'POST' });
        // Use safe JSON parsing — never throws on empty/non-JSON (Abyss fix §3).
        const data = await safeJsonParse(res, 'Processing status check failed.');
        if (data.ok) {
          operationStatus = (data.status as string) ?? '';
          progressPercent = (data.progressPercent as number | null) ?? null;
          providerStatus = (data.providerStatus as string | null) ?? null;
          if (data.ready) {
            step = 'done';
            stopPolling();
          } else if (data.failed) {
            operationError = 'Provider processing failed.';
            step = 'done';
            stopPolling();
          }
        }
      } catch {
        // Network error — keep polling.
      }
    }, 10_000); // 10 second interval.
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  // --- Cancel ---
  async function cancelUpload() {
    if (!operationId) return;
    stopPolling();
    try {
      await fetch(`/api/admin/media/upload/${operationId}/cancel`, { method: 'POST' });
    } catch {
      // Ignore.
    }
    step = 'done';
    operationStatus = 'cancelled';
  }

  // --- Retry ---
  async function retryUpload() {
    if (!operationId) return;
    try {
      const res = await fetch(`/api/admin/media/upload/${operationId}/retry`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        operationId = data.operation.id;
        operationStatus = 'queued';
        operationError = '';
        step = 'uploading';
        createOperation();
      }
    } catch {
      // Ignore.
    }
  }

  // --- Subtitle upload ---
  async function uploadSubtitle() {
    if (!subtitleFile || !subtitleLanguage.trim() || !operationId) return;
    subtitleUploading = true;
    subtitleResult = '';
    subtitleError = '';
    try {
      const formData = new FormData();
      formData.append('file', subtitleFile);
      formData.append('language', subtitleLanguage.trim());
      if (subtitleLabel.trim()) formData.append('label', subtitleLabel.trim());

      const res = await fetch(`/api/admin/media/upload/${operationId}/subtitle`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.ok) {
        subtitleResult = 'success';
      } else {
        subtitleResult = 'failed';
        subtitleError = data.error?.message ?? 'Subtitle upload failed.';
      }
    } catch {
      subtitleResult = 'failed';
      subtitleError = 'Network error during subtitle upload.';
    }
    subtitleUploading = false;
  }

  function onSubtitleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      subtitleFile = input.files[0];
    }
  }

  // --- Reset ---
  function reset() {
    stopPolling();
    step = 'search';
    searchQuery = '';
    searchResults = [];
    selectedTmdbId = '';
    selectedTitle = '';
    selectedYear = null;
    selectedSeason = null;
    selectedEpisode = null;
    episodeTitle = '';
    selectedProviderSourceId = '';
    selectedProviderName = '';
    uploadSource = 'local';
    remoteUrl = '';
    selectedFile = null;
    sourceQuality = '';
    operationId = null;
    operationStatus = '';
    operationError = '';
    progressPercent = null;
    providerStatus = null;
  }

  function onDestroy() {
    stopPolling();
  }
</script>

<svelte:head><title>Upload — Mavero Admin</title></svelte:head>

<AdminPageHeader eyebrow="Hosting" title="Upload Media" description="TMDB-first upload to Vidara or Abyss" />

<div class="upload-wizard" role="main">
  <!-- Step indicator -->
  <div class="step-indicator" aria-hidden="true">
    {#each ['Search', 'Select', 'Details', 'Provider', 'Source', 'Review', 'Upload'] as label, i}
      <span class="step-dot" class:active={step === label.toLowerCase().replace(' ', '-') || (i === 0 && step === 'search')}>{i + 1}. {label}</span>
    {/each}
  </div>

  {#if step === 'search'}
    <!-- Step 1: Search TMDB -->
    <AdminFormSection heading="Search TMDB">
      <div class="search-row">
        <select bind:value={searchType} class="select">
          <option value="movie">Movies</option>
          <option value="series">TV Shows</option>
        </select>
        <input type="text" bind:value={searchQuery} placeholder="Search for a title..." class="input" onkeydown={(e) => { if (e.key === 'Enter') doSearch(); }} />
        <button class="btn btn-primary" onclick={doSearch} disabled={searching || !searchQuery.trim()}>{searching ? 'Searching...' : 'Search'}</button>
      </div>
      {#if searchError}<p class="error">{searchError}</p>{/if}
      {#if searchResults.length > 0}
        <div class="search-results">
          {#each searchResults as result}
            <button class="search-result" onclick={() => selectTitle(result)}>
              {#if result.poster}<img src={result.poster} alt="" class="result-poster" />{/if}
              <div class="result-info"><strong>{result.title}</strong>{#if result.year}<span> ({result.year})</span>{/if}</div>
            </button>
          {/each}
        </div>
      {/if}
    </AdminFormSection>

  {:else if step === 'content-type'}
    <!-- Step 3: Content type / season / episode -->
    <AdminFormSection heading="Content Details">
      <p class="selected-title"><strong>{selectedTitle}</strong>{#if selectedYear} ({selectedYear}){/if}</p>
      <p class="selected-id">TMDB ID: {selectedTmdbId}</p>

      <label class="form-label">Content Type</label>
      <select bind:value={selectedContentType} class="select">
        <option value="movie">Movie</option>
        <option value="series">Series</option>
        <option value="anime">Anime</option>
      </select>

      {#if selectedContentType === 'series' || selectedContentType === 'anime'}
        <div class="episode-fields">
          <label class="form-label">Season</label>
          <input type="number" bind:value={selectedSeason} min="0" max="1000" class="input" placeholder="Season number" />

          <label class="form-label">Episode</label>
          <input type="number" bind:value={selectedEpisode} min="1" max="10000" class="input" placeholder="Episode number" />

          <label class="form-label">Episode Title (optional)</label>
          <input type="text" bind:value={episodeTitle} class="input" placeholder="Episode title" />
        </div>
        <p class="hint">Leave season/episode empty to upload the series as a whole (not an episode).</p>
      {/if}

      <div class="button-row">
        <button class="btn btn-secondary" onclick={() => step = 'search'}>Back</button>
        <button class="btn btn-primary" onclick={confirmContentType}>Continue</button>
      </div>
    </AdminFormSection>

  {:else if step === 'provider'}
    <!-- Step 4: Provider selection -->
    <AdminFormSection heading="Select Provider">
      <div class="provider-list">
        {#each data.hostingSources as source}
          <button class="provider-card" onclick={() => selectProvider(source)}>
            <strong>{source.name}</strong>
            <span class="provider-adapter">{source.adapterId}</span>
          </button>
        {/each}
      </div>
      {#if data.hostingSources.length === 0}
        <p class="error">No hosting providers found. Make sure Phase 4 migration was applied.</p>
      {/if}
      <div class="button-row">
        <button class="btn btn-secondary" onclick={() => step = 'content-type'}>Back</button>
      </div>
    </AdminFormSection>

  {:else if step === 'upload-source'}
    <!-- Step 5: Upload source -->
    <AdminFormSection heading="Upload Source">
      <div class="source-options">
        <label class="radio-option">
          <input type="radio" bind:group={uploadSource} value="local" />
          <span>Local File Upload</span>
        </label>
        {#if selectedProviderAdapterId === 'vidara'}
          <label class="radio-option">
            <input type="radio" bind:group={uploadSource} value="remote" />
            <span>Remote URL Upload (Vidara fetches the URL)</span>
          </label>
        {:else}
          <p class="hint">Remote URL upload is not supported by Abyss (not API-verified).</p>
        {/if}
      </div>

      {#if uploadSource === 'local'}
        <label class="form-label">Select File</label>
        <input type="file" accept="video/*" onchange={onFileSelect} class="input" />
        {#if selectedFile}
          <p class="hint">Selected: {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(1)} MB)</p>
        {/if}
        <label class="form-label">Source Quality (optional)</label>
        <input type="text" bind:value={sourceQuality} class="input" placeholder="e.g. 720p, 1080p" />
      {:else if uploadSource === 'remote'}
        <label class="form-label">Remote URL</label>
        <input type="url" bind:value={remoteUrl} class="input" placeholder="https://example.com/video.mp4" />
        <p class="hint">The URL must be a direct downloadable media file URL.</p>
        <label class="form-label">Filename (optional)</label>
        <input type="text" bind:value={sourceQuality} class="input" placeholder="e.g. 720p" />
      {/if}

      <div class="button-row">
        <button class="btn btn-secondary" onclick={() => step = 'provider'}>Back</button>
        <button class="btn btn-primary" onclick={confirmUploadSource} disabled={uploadSource === 'local' && !selectedFile}>Continue</button>
      </div>
    </AdminFormSection>

  {:else if step === 'review'}
    <!-- Step 7: Review -->
    <AdminFormSection heading="Review">
      <dl class="review-list">
        <dt>Title</dt><dd>{selectedTitle}</dd>
        <dt>TMDB ID</dt><dd>{selectedTmdbId}</dd>
        <dt>Content Type</dt><dd>{selectedContentType}</dd>
        {#if selectedSeason != null}<dt>Season</dt><dd>{selectedSeason}</dd>{/if}
        {#if selectedEpisode != null}<dt>Episode</dt><dd>{selectedEpisode}</dd>{/if}
        <dt>Provider</dt><dd>{selectedProviderName} ({selectedProviderAdapterId})</dd>
        <dt>Upload Source</dt><dd>{uploadSource === 'local' ? 'Local File' : 'Remote URL'}</dd>
        {#if uploadSource === 'local' && selectedFile}<dt>File</dt><dd>{selectedFile.name}</dd>{/if}
        {#if uploadSource === 'remote'}<dt>URL</dt><dd>{remoteUrl}</dd>{/if}
        {#if sourceQuality}<dt>Quality</dt><dd>{sourceQuality}</dd>{/if}
      </dl>
      <div class="button-row">
        <button class="btn btn-secondary" onclick={() => step = 'upload-source'}>Back</button>
        <button class="btn btn-primary" onclick={startUpload}>Start Upload</button>
      </div>
    </AdminFormSection>

  {:else if step === 'uploading'}
    <!-- Step 8: Uploading -->
    <AdminFormSection heading="Uploading...">
      <div class="status-block">
        <p class="status-label">Status: <AdminStatusBadge label={operationStatus || 'uploading'} tone={operationStatus === 'ready' ? 'good' : operationStatus === 'failed' ? 'bad' : 'info'} /></p>
        <p class="hint">Uploading to {selectedProviderName}...</p>
        <button class="btn btn-secondary" onclick={cancelUpload}>Cancel</button>
      </div>
    </AdminFormSection>

  {:else if step === 'processing'}
    <!-- Step 9: Processing -->
    <AdminFormSection heading="Processing...">
      <div class="status-block">
        <p class="status-label">Status: <AdminStatusBadge label={operationStatus || 'processing'} tone={operationStatus === 'ready' ? 'good' : operationStatus === 'failed' ? 'bad' : 'info'} /></p>
        {#if progressPercent != null}<p class="hint">Progress: {progressPercent}%</p>{/if}
        {#if providerStatus}<p class="hint">Provider status: {providerStatus}</p>{/if}
        <p class="hint">Polling every 10 seconds...</p>
        <button class="btn btn-secondary" onclick={cancelUpload}>Cancel</button>
      </div>
    </AdminFormSection>

  {:else if step === 'done'}
    <!-- Step 10: Done -->
    <AdminFormSection heading={operationStatus === 'ready' ? 'Upload Complete' : operationStatus === 'cancelled' ? 'Cancelled' : 'Upload Failed'}>
      <div class="status-block">
        {#if operationStatus === 'ready'}
          <p>The media has been uploaded and processed successfully.</p>
        {:else if operationStatus === 'cancelled'}
          <p>The upload was cancelled.</p>
        {:else}
          <p class="error">{operationError}</p>
        {/if}
        <div class="button-row">
          {#if operationStatus === 'failed'}
            <button class="btn btn-primary" onclick={retryUpload}>Retry</button>
          {/if}
          <button class="btn btn-secondary" onclick={reset}>New Upload</button>
          <button class="btn btn-secondary" onclick={() => goto('/admin')}>Back to Admin</button>
        </div>

        <!-- Subtitle upload (available when upload is ready or processing) -->
        {#if operationStatus === 'ready' || operationStatus === 'processing'}
          <div class="subtitle-section">
            <h3 class="subtitle-title">Subtitles</h3>
            {#if subtitleResult === 'success'}
              <p class="subtitle-success">Subtitle uploaded successfully.</p>
            {:else if subtitleResult === 'failed'}
              <p class="error">{subtitleError}</p>
              <p class="hint">The media upload was NOT affected by this subtitle failure.</p>
            {/if}
            <label class="form-label">Subtitle File</label>
            <input type="file" accept=".srt,.vtt,.ass" onchange={onSubtitleFileSelect} class="input" />
            <label class="form-label">Language (e.g. en, hi)</label>
            <input type="text" bind:value={subtitleLanguage} class="input" placeholder="en" />
            <label class="form-label">Label (optional)</label>
            <input type="text" bind:value={subtitleLabel} class="input" placeholder="English" />
            <button class="btn btn-primary" onclick={uploadSubtitle} disabled={subtitleUploading || !subtitleFile || !subtitleLanguage.trim()}>
              {subtitleUploading ? 'Uploading...' : 'Upload Subtitle'}
            </button>
          </div>
        {/if}
      </div>
    </AdminFormSection>
  {/if}
</div>

<style>
  .upload-wizard { max-width: 800px; margin: 0 auto; padding: 1rem; }
  .step-indicator { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; flex-wrap: wrap; font-size: 0.75rem; color: var(--muted); }
  .step-dot { padding: 0.25rem 0.5rem; border-radius: 4px; }
  .step-dot.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .search-row { display: flex; gap: 0.5rem; align-items: center; }
  .search-results { display: grid; gap: 0.5rem; margin-top: 1rem; }
  .search-result { display: flex; gap: 0.75rem; align-items: center; padding: 0.5rem; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; background: transparent; text-align: left; width: 100%; }
  .search-result:hover { border-color: var(--accent); background: var(--accent-soft); }
  .result-poster { width: 40px; height: 60px; object-fit: cover; border-radius: 4px; }
  .result-info { font-size: 0.9rem; }
  .selected-title { font-size: 1.1rem; }
  .selected-id { color: var(--muted); font-size: 0.8rem; }
  .episode-fields { display: grid; gap: 0.5rem; margin-top: 1rem; }
  .form-label { display: block; margin-top: 0.75rem; margin-bottom: 0.25rem; font-size: 0.8rem; color: var(--muted); }
  .input, .select { width: 100%; padding: 0.5rem; border: 1px solid var(--line); border-radius: 6px; font: inherit; font-size: 0.9rem; }
  .btn { padding: 0.5rem 1rem; border-radius: 6px; border: none; cursor: pointer; font: inherit; }
  .btn-primary { background: var(--accent); color: white; }
  .btn-secondary { background: var(--line); color: var(--ink); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .button-row { display: flex; gap: 0.5rem; margin-top: 1rem; }
  .provider-list { display: grid; gap: 0.5rem; }
  .provider-card { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; background: transparent; }
  .provider-card:hover { border-color: var(--accent); background: var(--accent-soft); }
  .provider-adapter { font-size: 0.75rem; color: var(--muted); }
  .source-options { display: grid; gap: 0.5rem; margin-bottom: 1rem; }
  .radio-option { display: flex; gap: 0.5rem; align-items: center; }
  .hint { font-size: 0.75rem; color: var(--muted); margin-top: 0.25rem; }
  .error { color: #ef4444; font-size: 0.85rem; }
  .review-list { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem; margin: 1rem 0; }
  .review-list dt { font-weight: 600; color: var(--muted); font-size: 0.85rem; }
  .review-list dd { margin: 0; }
  .status-block { padding: 1rem; text-align: center; }
  .status-label { margin-bottom: 0.5rem; }
  .subtitle-section { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  .subtitle-title { font-size: 1rem; margin-bottom: 0.5rem; }
  .subtitle-success { color: var(--accent); font-size: 0.85rem; }
</style>
