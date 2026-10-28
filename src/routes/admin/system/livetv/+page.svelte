<script lang="ts">
  /**
   * Admin 2.0 — Unified Live TV workspace (Phase 4; R-1 source-first workflow).
   *
   * The PRIMARY interface is exactly three things:
   *   * the "Live TV" heading (AdminPage),
   *   * ONE "Add Source" button (top-right),
   *   * the source list — one row per source: name + type, a persisted
   *     ON/OFF toggle (bound to the `enabled` column, NEVER the operational
   *     `status`), and Edit.
   *
   * The five-tab workflow, the overview dashboard and every mapping/EPG
   * control are REMOVED from the primary interface. The advanced backend
   * capabilities (entry enable/mapping, canonical channels, candidates, EPG)
   * remain implemented server-side in +page.server.ts / admin-service.ts —
   * nothing was deleted; the primary UI simply no longer exposes them.
   *
   * Add Source → compact sheet (existing source types + their established
   * config contracts; the R-0 fix preserved: the per-type Configuration
   * fields key on the SELECTED type, so the required fields appear during
   * creation). The server's `validateLivetvSourceConfig` + SSRF guard remain
   * the only authority — client `required` is UX, never the gate.
   *
   * Edit → the source sheet: (1) the configuration form, (2) a divider,
   * (3) the source's OWN channel section — bounded, paginated, searchable,
   * with loading/empty/error states, served by the admin-gated
   * `?/sourceChannels` read action. A result renders ONLY while its
   * `sourceId` still matches the open sheet's source (no cross-source leak).
   *
   * CONVENTIONS: AdminAppShell + AdminPage + AdminSheet + AdminConfirmDialog
   * + AdminStatusBadge (no competing dialog/toast/form patterns); every
   * mutation is a server action (use:enhance); deletes confirm with impact.
   * SOURCE TYPES ≠ PLAYBACK ENGINES (registry contract).
   */

  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { invalidateAll } from '$app/navigation';
  import { formatLocalDateTimeWithZone } from '$lib/shared/datetime';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import AdminFormSection from '$lib/components/admin/AdminFormSection.svelte';
  import AdminConfirmDialog from '$lib/components/admin2/AdminConfirmDialog.svelte';
  import { Plus, RefreshCw, Eye, Pencil, Trash2, LoaderCircle } from 'lucide-svelte';
  import type { PageData, ActionData } from './$types';
  import type { LivetvAdminSourceRow, LivetvSourceChannelPage, LivetvSourceLatestHistory } from '$lib/server/livetv/admin-service';
  import type { LivetvRefreshSourceOutcome } from '$lib/server/livetv/refresh-service';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // R-7 — Refresh/Preview loading state.
  let refreshing = $state(false);
  let previewing = $state(false);

  // Chunked "Fetch & Save" — large playlists (e.g. akindi ~648 channels) that
  // exceed the server fetch timeout. The BROWSER downloads the playlist, splits
  // it into ~50-channel chunks, and POSTs each to the ingest-chunk endpoint.
  let chunkNotice = $state<{ kind: 'ok' | 'error'; message: string } | null>(null);
  let chunkSaving = $state<{ id: string; done: number; total: number } | null>(null);

  function splitM3uIntoChunks(text: string, perChunk = 50): string[] {
    const lines = text.split(/\r?\n/);
    const firstExtinf = lines.findIndex((line) => line.startsWith('#EXTINF'));
    const headerLines = (firstExtinf > 0 ? lines.slice(0, firstExtinf) : lines).filter((line) => line.startsWith('#'));
    const header = headerLines.length > 0 ? headerLines.join('\n') : '#EXTM3U';
    const body = firstExtinf >= 0 ? lines.slice(firstExtinf) : [];
    const entries: string[] = [];
    let current: string[] = [];
    for (const line of body) {
      if (line.startsWith('#EXTINF')) {
        if (current.length) entries.push(current.join('\n'));
        current = [line];
      } else if (current.length) {
        current.push(line);
      }
    }
    if (current.length) entries.push(current.join('\n'));
    if (entries.length === 0) return [];
    const chunks: string[] = [];
    for (let i = 0; i < entries.length; i += perChunk) {
      chunks.push(`${header}\n${entries.slice(i, i + perChunk).join('\n')}`);
    }
    return chunks;
  }

  // 2026-10 round 8 — Task 1: detect uploaded-file sources (no URL).
  // A source whose playlistUrl is empty or 'uploaded_file' was created
  // via file upload — it has no URL to fetch. The Fetch & Save button
  // is hidden for these sources; the Edit sheet shows only the Upload
  // tab (no URL input).
  function isUploadedSource(source: LivetvAdminSourceRow): boolean {
    const url = typeof source.config?.playlistUrl === 'string' ? source.config.playlistUrl : '';
    return !url || url === 'uploaded_file';
  }

  async function fetchAndSaveChunked(source: LivetvAdminSourceRow) {
    // 2026-10 round 8 — Task 1: uploaded sources have no URL — skip
    // Fetch & Save entirely (the button is hidden, but this guard is
    // defense in depth).
    if (isUploadedSource(source)) {
      chunkNotice = { kind: 'error', message: 'This source was uploaded from a file. Use "Replace File" in the Edit sheet to update channels.' };
      return;
    }
    const playlistUrl = typeof source.config?.playlistUrl === 'string' ? source.config.playlistUrl : '';
    if (!playlistUrl) {
      chunkNotice = { kind: 'error', message: 'This source has no playlist URL.' };
      return;
    }
    chunkNotice = null;
    chunkSaving = { id: source.id, done: 0, total: 0 };
    try {
      const playlistResponse = await fetch(playlistUrl, { headers: { accept: 'text/plain,*/*' } });
      if (!playlistResponse.ok) throw new Error(`Playlist fetch failed (${playlistResponse.status}).`);
      const chunks = splitM3uIntoChunks(await playlistResponse.text(), 50);
      if (chunks.length === 0) throw new Error('The playlist had no channels.');
      chunkSaving = { id: source.id, done: 0, total: chunks.length };
      let parsed = 0;
      let entryWrites = 0;
      let endpointWrites = 0;
      for (let i = 0; i < chunks.length; i += 1) {
        const response = await fetch('/api/admin/livetv/sources/ingest-chunk', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourceId: source.id, text: chunks[i] })
        });
        const result = (await response.json().catch(() => null)) as { ok?: boolean; parsed?: number; entryWrites?: number; endpointWrites?: number; error?: { message?: string } } | null;
        if (!response.ok || !result?.ok) throw new Error(result?.error?.message ?? `Chunk ${i + 1} failed.`);
        parsed += result.parsed ?? 0;
        entryWrites += result.entryWrites ?? 0;
        endpointWrites += result.endpointWrites ?? 0;
        chunkSaving = { id: source.id, done: i + 1, total: chunks.length };
      }
      chunkNotice = { kind: 'ok', message: `Saved ${parsed} channels (${entryWrites} writes, ${endpointWrites} endpoints).` };
      await invalidateAll();
    } catch (error) {
      chunkNotice = { kind: 'error', message: error instanceof Error ? error.message : 'Fetch & Save failed.' };
    } finally {
      chunkSaving = null;
    }
  }

  // 2026-10 round 8 — Task 1: Upload M3U file → create source + ingest.
  // FIXED: the upload flow now creates the source via a DEDICATED API
  // endpoint (not the form action), gets the sourceId from the response,
  // then ingests the chunks with that EXACT sourceId. No ghost sources,
  // no name-matching, no invalidateAll race conditions.
  async function uploadAndCreateSource() {
    if (!uploadFile) {
      sheetFormError = 'Please select an .m3u or .m3u8 file.';
      return;
    }
    sheetFormError = null;
    uploadProgress = { done: 0, total: 0, phase: 'Reading file…' };
    try {
      const text = await uploadFile.text();
      if (!text.includes('#EXTM3U') && !text.includes('#EXTINF')) {
        throw new Error('The file does not appear to be a valid M3U playlist.');
      }
      const chunks = splitM3uIntoChunks(text, 50);
      if (chunks.length === 0) throw new Error('The playlist had no channels.');

      // Step 1: create the source via the dedicated upload endpoint.
      // 2026-10 round 9 — Task 2: use the DISPLAY NAME from the form
      // input (the "name" field the admin typed). Fall back to the file
      // name only if the display name is empty.
      uploadProgress = { done: 0, total: chunks.length, phase: 'Creating source…' };
      const nameInput = document.querySelector('input[name="name"]') as HTMLInputElement | null;
      const displayName = nameInput?.value?.trim() ?? '';
      const sourceName = displayName || uploadFile.name.replace(/\.m3u8?$/i, '');
      const createResponse = await fetch('/api/admin/livetv/sources/upload-playlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: sourceName, fileName: uploadFile.name })
      });
      const createResult = (await createResponse.json().catch(() => null)) as { ok?: boolean; sourceId?: string; error?: { message?: string } } | null;
      if (!createResponse.ok || !createResult?.ok || !createResult.sourceId) {
        throw new Error(createResult?.error?.message ?? 'Failed to create the source.');
      }
      const sourceId = createResult.sourceId;

      // Step 2: ingest the chunks concurrently (3 at a time).
      // 2026-10 round 9 — Task 4: removed the 500ms delay. Instead,
      // send up to 3 chunks concurrently using a simple pool. Per-chunk
      // try/catch: one failure logs and continues, no crash.
      uploadProgress = { done: 0, total: chunks.length, phase: 'Ingesting channels…' };
      let parsed = 0;
      let entryWrites = 0;
      let endpointWrites = 0;
      let failedChunks = 0;
      let completed = 0;
      const CONCURRENCY = 3;

      async function ingestChunk(index: number): Promise<void> {
        try {
          const response = await fetch('/api/admin/livetv/sources/ingest-chunk', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sourceId, text: chunks[index] })
          });
          const result = (await response.json().catch(() => null)) as { ok?: boolean; parsed?: number; entryWrites?: number; endpointWrites?: number; error?: { message?: string } } | null;
          if (!response.ok || !result?.ok) {
            console.error(`[upload] Chunk ${index + 1}/${chunks.length} failed:`, result?.error?.message ?? 'unknown');
            failedChunks++;
          } else {
            parsed += result.parsed ?? 0;
            entryWrites += result.entryWrites ?? 0;
            endpointWrites += result.endpointWrites ?? 0;
          }
        } catch (chunkError) {
          console.error(`[upload] Chunk ${index + 1}/${chunks.length} threw:`, chunkError);
          failedChunks++;
        }
        completed++;
        uploadProgress = { done: completed, total: chunks.length, phase: 'Ingesting channels…' };
      }

      // Simple concurrency pool: process chunks in batches of CONCURRENCY.
      for (let i = 0; i < chunks.length; i += CONCURRENCY) {
        const batch = chunks.slice(i, i + CONCURRENCY).map((_, j) => ingestChunk(i + j));
        await Promise.all(batch);
      }

      const failMsg = failedChunks > 0 ? ` (${failedChunks} chunk(s) failed — check console)` : '';
      chunkNotice = { kind: failedChunks > 0 ? 'error' : 'ok', message: `Uploaded and saved ${parsed} channels (${entryWrites} writes, ${endpointWrites} endpoints).${failMsg}` };
      uploadFile = null;
      uploadProgress = null;
      closeSheets();
      await invalidateAll();
    } catch (error) {
      sheetFormError = error instanceof Error ? error.message : 'Upload failed.';
      uploadProgress = null;
    }
  }

  function handleFileSelect(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    uploadFile = input.files?.[0] ?? null;
  }

  // 2026-10 round 8 — Task 1: Replace playlist for an EXISTING uploaded
  // source. Reads the new file, then ingests the chunks into the EXISTING
  // sourceId (no new source is created). Used from the Edit sheet's
  // "Replace File" button.
  async function uploadAndReplacePlaylist(sourceId: string) {
    if (!uploadFile) {
      sheetFormError = 'Please select an .m3u or .m3u8 file.';
      return;
    }
    sheetFormError = null;
    uploadProgress = { done: 0, total: 0, phase: 'Reading file…' };
    try {
      const text = await uploadFile.text();
      if (!text.includes('#EXTM3U') && !text.includes('#EXTINF')) {
        throw new Error('The file does not appear to be a valid M3U playlist.');
      }
      const chunks = splitM3uIntoChunks(text, 50);
      if (chunks.length === 0) throw new Error('The playlist had no channels.');

      // 2026-10 round 9 — Task 4: concurrent chunks (3 at a time), no delay.
      uploadProgress = { done: 0, total: chunks.length, phase: 'Replacing channels…' };
      let parsed = 0;
      let entryWrites = 0;
      let endpointWrites = 0;
      let failedChunks = 0;
      let completed = 0;
      const CONCURRENCY = 3;

      async function replaceChunk(index: number): Promise<void> {
        try {
          const response = await fetch('/api/admin/livetv/sources/ingest-chunk', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sourceId, text: chunks[index] })
          });
          const result = (await response.json().catch(() => null)) as { ok?: boolean; parsed?: number; entryWrites?: number; endpointWrites?: number; error?: { message?: string } } | null;
          if (!response.ok || !result?.ok) {
            console.error(`[replace] Chunk ${index + 1}/${chunks.length} failed:`, result?.error?.message ?? 'unknown');
            failedChunks++;
          } else {
            parsed += result.parsed ?? 0;
            entryWrites += result.entryWrites ?? 0;
            endpointWrites += result.endpointWrites ?? 0;
          }
        } catch (chunkError) {
          console.error(`[replace] Chunk ${index + 1}/${chunks.length} threw:`, chunkError);
          failedChunks++;
        }
        completed++;
        uploadProgress = { done: completed, total: chunks.length, phase: 'Replacing channels…' };
      }

      for (let i = 0; i < chunks.length; i += CONCURRENCY) {
        const batch = chunks.slice(i, i + CONCURRENCY).map((_, j) => replaceChunk(i + j));
        await Promise.all(batch);
      }

      const failMsg = failedChunks > 0 ? ` (${failedChunks} chunk(s) failed — check console)` : '';
      chunkNotice = { kind: failedChunks > 0 ? 'error' : 'ok', message: `Replaced with ${parsed} channels (${entryWrites} writes, ${endpointWrites} endpoints).${failMsg}` };
      uploadFile = null;
      uploadProgress = null;
      await invalidateAll();
    } catch (error) {
      sheetFormError = error instanceof Error ? error.message : 'Replace failed.';
      uploadProgress = null;
    }
  }

  const refreshEnhance: SubmitFunction = () => {
    refreshing = true;
    return async ({ update }) => {
      refreshing = false;
      await update({ reset: false });
    };
  };

  const previewEnhance: SubmitFunction = () => {
    previewing = true;
    return async ({ update }) => {
      previewing = false;
      await update({ reset: false });
    };
  };

  // --- shared vocabularies (display-only; the server validates everything) ---
  const SOURCE_TYPE_LABELS: Record<string, string> = {
    builtin_livegt_v1: 'Built-in LiveGT V1',
    m3u_playlist: 'Playlist (M3U/M3U8)',
    api_provider: 'API catalogue',
    embed_provider: 'Embed provider',
    manual_stream: 'Manual direct stream'
  };
  const SOURCE_STATUS_LABELS: Record<string, string> = {
    active: 'Active',
    disabled: 'Disabled',
    maintenance: 'Maintenance',
    experimental: 'Experimental',
    unavailable: 'Unavailable'
  };
  const SOURCE_STATUSES = ['active', 'experimental', 'maintenance', 'disabled', 'unavailable'];
  const CREATE_TYPES = ['m3u_playlist', 'api_provider', 'embed_provider', 'manual_stream'];

  function statusTone(status: string): 'good' | 'neutral' | 'warn' | 'bad' | 'info' {
    if (status === 'active') return 'good';
    if (status === 'experimental' || status === 'maintenance') return 'info';
    if (status === 'disabled') return 'neutral';
    return 'bad';
  }

  function formatCount(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : String(value);
  }

  function formatTime(iso: string | null | undefined): string {
    // LOCAL (device) timezone with its abbreviation — e.g. "25/10/2026, 11:21 am IST".
    return formatLocalDateTimeWithZone(iso);
  }

  // --- sheet state ---
  let sourceSheetOpen = $state(false);
  let editingSource: LivetvAdminSourceRow | null = $state(null);
  /**
   * The SELECTED source type of the CREATE sheet — real form state, bound to
   * the create `<select>` (the R-0 fix: the per-type Configuration fields
   * must key on what the admin SELECTED, not on `editingSource`, which is
   * always null while creating). Edit mode keys on the immutable row type.
   */
  let newSourceType: string = $state(CREATE_TYPES[0]);
  // 2026-10 round 6 — Task 3: dual-mode Add Source (URL input vs File upload).
  // When the source type is 'm3u_playlist' AND we're in CREATE mode, the
  // Configuration section shows a tab toggle: [ URL Input ] [ Upload File ].
  // 'url' keeps the existing playlistUrl input. 'upload' shows a file picker
  // that reads the M3U text in the browser, creates the source (via the
  // existing ?/createSource action), then ingests the channels via the
  // existing chunked-ingestion endpoint (reusing splitM3uIntoChunks).
  let playlistInputMode: 'url' | 'upload' = $state('url');
  let uploadFile: File | null = $state(null);
  let uploadProgress: { done: number; total: number; phase: string } | null = $state(null);
  /**
   * The source type whose Configuration fields the sheet renders right now:
   * edit mode keys on the immutable row type; create mode keys on the live
   * select binding (a plain function, so the template call site stays
   * reactive and the row type is never top-level-narrowed to its initial
   * value).
   */
  function effectiveSourceType(): string {
    return editingSource !== null ? editingSource.source_type : newSourceType;
  }
  /** Sheet-local save error (kept beside the form; cleared on open/close). */
  let sheetFormError = $state<string | null>(null);

  // --- the persisted-state toggle (per-source optimistic override) ---
  /**
   * `id → the in-flight target value`. While an entry exists the switch
   * shows the TARGET (busy, disabled — rapid repeats cannot stack), and the
   * row's hidden input carries that target. Clearing the override re-renders
   * the PERSISTED value from `data.sources`: on failure the switch falls
   * back automatically (never stuck on the failed intent), on success the
   * invalidated load renders the database state.
   */
  let sourceToggleOverrides = $state<Record<string, boolean>>({});

  function displayedEnabled(source: LivetvAdminSourceRow): boolean {
    const override = sourceToggleOverrides[source.id];
    return override === undefined ? source.enabled : override;
  }
  function isToggling(source: LivetvAdminSourceRow): boolean {
    return sourceToggleOverrides[source.id] !== undefined;
  }

  const toggleEnhanceFor = (source: LivetvAdminSourceRow): SubmitFunction =>
    ({ formData, cancel }) => {
      if (isToggling(source)) {
        cancel();
        return async () => {};
      }
      const target = formData.get('enabled') === 'true';
      // 2026-10 round 9 — Task 5: Optimistic UI — the override is set
      // BEFORE the request. The switch flips instantly. No invalidateAll.
      sourceToggleOverrides = { ...sourceToggleOverrides, [source.id]: target };
      return async ({ update, result }) => {
        const overrides = { ...sourceToggleOverrides };
        delete overrides[source.id];
        sourceToggleOverrides = overrides;
        // 2026-10 round 9 — Task 5: do NOT call update() on success —
        // it triggers a full invalidateAll that refetches all channel
        // data. The optimistic override already shows the correct state.
        // Only update on failure (to revert the switch).
        if (result.type === 'failure') {
          await update({ reset: false });
        }
      };
    };

  // --- the Edit sheet's channel section (per-source, bounded) ---
  let channelsFormEl: HTMLFormElement | undefined = $state(undefined);
  let channelsPage = $state(0);
  let channelsSearchDraft = $state('');
  let channelsLoading = $state(false);
  let channelsError = $state<string | null>(null);
  let channelsData = $state<(LivetvSourceChannelPage & { sourceId: string }) | null>(null);
  let pendingChannelsLoad = $state(false);

  /**
   * The loaded page, ONLY while it belongs to the sheet's current source.
   * (Plain functions — the R-0 documented script-scope narrowing quirk:
   * a top-level `$state(null)` narrows to its initial value inside script
   * expressions; inside a function body the declared type applies.)
   */
  function channelsForOpenSource(): (LivetvSourceChannelPage & { sourceId: string }) | null {
    if (channelsData === null || editingSource === null) return null;
    return channelsData.sourceId === editingSource.id ? channelsData : null;
  }

  /** Durable + instance-local last-refresh slices for the OPEN source. */
  function openSourceLatestHistory(): LivetvSourceLatestHistory | null {
    if (editingSource === null) return null;
    return data.latestSourceHistory?.get(editingSource.id) ?? null;
  }
  function openSourceLatestLocal(): LivetvRefreshSourceOutcome | null {
    if (editingSource === null) return null;
    return data.sourceOutcomes.find((outcome) => outcome.sourceId === editingSource!.id) ?? null;
  }

  /** Adopts a `?/sourceChannels` result — never another source's entries. */
  $effect(() => {
    const result = form && 'sourceChannels' in form ? form.sourceChannels : null;
    if (!result) return;
    if (!editingSource || result.sourceId !== editingSource.id) return;
    channelsData = result;
    channelsLoading = false;
    channelsError = null;
  });

  /** The initial bounded load when a source sheet opens (once per open). */
  $effect(() => {
    if (!pendingChannelsLoad) return;
    if (!sourceSheetOpen || editingSource === null) return;
    const formEl = channelsFormEl;
    if (!formEl) return;
    pendingChannelsLoad = false;
    channelsLoading = true;
    channelsError = null;
    formEl.requestSubmit();
  });

  function setChannelsPageValue(page: number): void {
    channelsPage = page;
    const pageInput = channelsFormEl?.querySelector<HTMLInputElement>('input[name="page"]');
    if (pageInput) pageInput.value = String(page);
  }

  function submitChannelsPage(page: number): void {
    setChannelsPageValue(page);
    channelsFormEl?.requestSubmit();
  }

  function retryChannels(): void {
    channelsError = null;
    pendingChannelsLoad = true;
  }

  const channelsEnhance: SubmitFunction = () => {
    channelsLoading = true;
    channelsError = null;
    return async ({ update, result }) => {
      channelsLoading = false;
      if (result.type === 'failure') {
        const message = (result.data as { message?: string } | undefined)?.message;
        channelsError = typeof message === 'string' && message.length > 0 ? message : 'Unable to load the source channels.';
      }
      await update({ reset: false });
    };
  };

  // --- open/close ---
  function resetChannelsState(): void {
    channelsPage = 0;
    channelsSearchDraft = '';
    channelsLoading = false;
    channelsError = null;
    channelsData = null;
    pendingChannelsLoad = false;
  }
  function openCreateSource() {
    editingSource = null;
    newSourceType = CREATE_TYPES[0];
    sheetFormError = null;
    playlistInputMode = 'url';
    uploadFile = null;
    uploadProgress = null;
    resetChannelsState();
    sourceSheetOpen = true;
  }
  function openEditSource(source: LivetvAdminSourceRow) {
    editingSource = source;
    sheetFormError = null;
    resetChannelsState();
    pendingChannelsLoad = true; // the bounded channels load fires once the sheet is mounted
    sourceSheetOpen = true;
  }
  function closeSheets() {
    sourceSheetOpen = false;
    editingSource = null;
    sheetFormError = null;
    resetChannelsState();
  }

  /** The save/create sheet: close ONLY on success; keep the form on failure. */
  const sourceFormEnhance: SubmitFunction = () =>
    async ({ update, result }) => {
      if (result.type === 'success') {
        sheetFormError = null;
        setTimeout(closeSheets, 0);
      } else if (result.type === 'failure') {
        const message = (result.data as { message?: string } | undefined)?.message;
        sheetFormError = typeof message === 'string' && message.length > 0 ? message : 'The source could not be saved.';
      }
      await update({ reset: false });
    };

  // --- confirmed delete (impact preview; the data.impacts map is preloaded) ---
  let pendingDelete = $state<{ id: string; name: string; impact: string } | null>(null);
  let deleteFormEl: HTMLFormElement | undefined = $state(undefined);

  function openDeleteSource(source: LivetvAdminSourceRow) {
    const impact = data.impacts?.get(source.id);
    pendingDelete = {
      id: source.id,
      name: source.name,
      impact: `Deletes this source and its ${formatCount(impact?.entries)} imported channel entries, ${formatCount(impact?.endpoints)} endpoints and ${formatCount(impact?.candidates)} playback-candidate rows (cascade). This cannot be undone.`
    };
  }
  function confirmDelete() {
    deleteFormEl?.requestSubmit();
    pendingDelete = null;
  }

  /** Refresh-kind guard for the outcome render block (ActionData is a union). */
  const refreshOutcome = $derived(
    form && 'refreshKind' in form && (form.refreshKind === 'source' || form.refreshKind === 'source-preview') && 'outcome' in form && form.outcome
      ? { kind: form.refreshKind, outcome: form.outcome }
      : null
  );
</script>

<svelte:head>
  <title>Live TV — Admin — Mavero</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell>
  <AdminPage eyebrow="Mavero / System" title="Live TV" accent="cyan">
    <!-- Single header row: heading on the left (AdminPage), controls on the right. -->
    {#snippet actions()}
      <form method="POST" action="?/setNavVisibility" class="nav-toggle-form" title={data.navVisible ? 'Live TV is shown in the nav for everyone. Click to hide it from guests/users (admins still see it).' : 'Live TV is hidden from guests/users (admins still see it). Click to show it for everyone.'}>
        <input type="hidden" name="visible" value={data.navVisible ? 'false' : 'true'} />
        <button type="submit" class="a2-btn" aria-pressed={data.navVisible} aria-label="Toggle Live TV nav visibility">
          {data.navVisible ? 'Nav: Visible' : 'Nav: Hidden (admins only)'}
        </button>
      </form>
      <button type="button" class="a2-btn a2-btn-primary" onclick={openCreateSource}><Plus size={15} /> Add Source</button>
    {/snippet}
    {#if form?.notice}
      <div class="notice notice-ok" role="status">{form.notice}</div>
    {:else if form?.message}
      <div class="notice notice-error" role="alert">{form.message}</div>
    {/if}
    {#if chunkNotice}
      <div class="notice" class:notice-ok={chunkNotice.kind === 'ok'} class:notice-error={chunkNotice.kind === 'error'} role="status">{chunkNotice.message}</div>
    {/if}

    <!-- ===== The ONE toolbar action (top-right) + the source list ===== -->

    {#if data.sources.length === 0}
      <section class="a2-section source-empty">
        <p class="a2-muted">No Live TV sources configured. Add one to bring its channels into Mavero.</p>
      </section>
    {:else}
      <ul class="source-list">
        {#each data.sources as source (source.id)}
          <li class="source-row">
            <div class="source-main">
              <div class="a2-cell-title">{source.name} {#if source.builtin}<span class="a2-chip">built-in</span>{/if}</div>
              <div class="a2-cell-sub">{SOURCE_TYPE_LABELS[source.source_type] ?? source.source_type}</div>
            </div>
            <div class="source-controls">
              <form method="POST" action="?/toggleSource" use:enhance={toggleEnhanceFor(source)} class="source-toggle-form">
                <input type="hidden" name="id" value={source.id} />
                <input type="hidden" name="enabled" value={displayedEnabled(source) ? 'false' : 'true'} />
                <button
                  type="submit"
                  class="switch"
                  class:on={displayedEnabled(source)}
                  disabled={isToggling(source)}
                  role="switch"
                  aria-checked={displayedEnabled(source)}
                  aria-label="{displayedEnabled(source) ? 'Disable' : 'Enable'} source {source.name}"
                  title={displayedEnabled(source) ? 'ON — click to disable' : 'OFF — click to enable'}
                >
                  <span class="switch-text" aria-hidden="true">{isToggling(source) ? '…' : displayedEnabled(source) ? 'ON' : 'OFF'}</span>
                  <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
                </button>
              </form>
              <button type="button" class="a2-btn" onclick={() => openEditSource(source)}><Pencil size={14} /> Edit</button>
              {#if source.source_type === 'm3u_playlist' && !isUploadedSource(source)}
                <button
                  type="button"
                  class="a2-btn"
                  disabled={chunkSaving?.id === source.id}
                  onclick={() => void fetchAndSaveChunked(source)}
                  title="Download this playlist in the browser and save it in ~50-channel chunks (bypasses the server fetch timeout)"
                >
                  {chunkSaving?.id === source.id ? `Saving ${chunkSaving.done}/${chunkSaving.total}…` : 'Fetch & Save'}
                </button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    <!-- ==================== Source create/edit sheet ==================== -->
    <AdminSheet open={sourceSheetOpen} title={editingSource ? `Edit source — ${editingSource.name}` : 'Add source'} onClose={closeSheets} size="wide">
      <form method="POST" action={editingSource ? '?/updateSource' : '?/createSource'} use:enhance={sourceFormEnhance}>
        {#if editingSource}<input type="hidden" name="id" value={editingSource.id} />{/if}
        <AdminFormSection heading="Identity" description="Slug and type are immutable after creation. Source types are provider identities; playback engines (DASH/HLS/iframe) are derived from the typed endpoint kind, never configured here.">
          <label class="a2-field"><span>Display name *</span>
            <input class="a2-input" type="text" name="name" value={editingSource?.name ?? ''} maxlength="120" required />
          </label>
          {#if !editingSource}
            <label class="a2-field"><span>Slug (optional — derived from the name)</span>
              <input class="a2-input" type="text" name="slug" value="" maxlength="120" pattern="[a-z0-9]+(-[a-z0-9]+)*" />
            </label>
            <label class="a2-field"><span>Source type *</span>
              <select class="a2-input" name="sourceType" required bind:value={newSourceType}>
                {#each CREATE_TYPES as type}
                  <option value={type}>{SOURCE_TYPE_LABELS[type]}</option>
                {/each}
              </select>
            </label>
          {:else}
            <input type="hidden" name="sourceType" value={editingSource.source_type} />
            <div class="a2-field"><span>Type</span><div>{SOURCE_TYPE_LABELS[editingSource.source_type] ?? editingSource.source_type}</div></div>
          {/if}
        </AdminFormSection>
        <AdminFormSection heading="Configuration" description="https-only, SSRF-guarded. A playlist URL may be a PHP script with a query string — the body is validated.">
          {#if effectiveSourceType() === 'm3u_playlist'}
            {#if !editingSource}
              <!-- 2026-10 round 6 — Task 3: dual-mode Add Source (URL vs Upload) -->
              <div class="playlist-mode-tabs" role="tablist">
                <button type="button" role="tab" class:active={playlistInputMode === 'url'} onclick={() => (playlistInputMode = 'url')} aria-selected={playlistInputMode === 'url'}>URL Input</button>
                <button type="button" role="tab" class:active={playlistInputMode === 'upload'} onclick={() => (playlistInputMode = 'upload')} aria-selected={playlistInputMode === 'upload'}>Upload File</button>
              </div>
            {/if}
            {#if editingSource && isUploadedSource(editingSource)}
              <!-- 2026-10 round 8 — Task 1: uploaded sources have no URL.
                   The Edit sheet shows ONLY the "Replace File" upload UI
                   (no URL input, no tab toggle). The hidden playlistUrl
                   field preserves the 'uploaded_file' sentinel. -->
              <input type="hidden" name="playlistUrl" value="uploaded_file" />
              <div class="upload-zone">
                <p class="a2-muted">This source was uploaded from a file. Select a new file to replace the channels.</p>
                <label class="a2-field a2-field-wide">
                  <span>Select .m3u or .m3u8 file</span>
                  <input type="file" accept=".m3u,.m3u8" onchange={handleFileSelect} class="a2-input" />
                </label>
                {#if uploadFile}
                  <p class="upload-file-name">Selected: {uploadFile.name} ({Math.round(uploadFile.size / 1024)} KB)</p>
                {/if}
                {#if uploadProgress}
                  <div class="upload-progress" role="status" aria-live="polite">
                    <div class="upload-progress-bar">
                      <div class="upload-progress-fill" style="width: {uploadProgress.total > 0 ? Math.round((uploadProgress.done / uploadProgress.total) * 100) : 0}%"></div>
                    </div>
                    <p class="upload-progress-text">{uploadProgress.phase} {uploadProgress.total > 0 ? `(${uploadProgress.done}/${uploadProgress.total})` : ''}</p>
                  </div>
                {/if}
                <button type="button" class="a2-btn a2-btn-primary" onclick={() => editingSource && void uploadAndReplacePlaylist(editingSource.id)} disabled={!uploadFile || uploadProgress !== null || !editingSource}>
                  {uploadProgress ? 'Replacing…' : 'Replace File'}
                </button>
              </div>
            {:else if playlistInputMode === 'url' || editingSource}
              <label class="a2-field a2-field-wide"><span>Playlist URL (https){editingSource ? '' : ' *'}</span>
                <input class="a2-input" type="url" name="playlistUrl" required={editingSource !== null} value={String((editingSource?.config as Record<string, unknown> | null)?.playlistUrl ?? '')} maxlength="2048" placeholder="https://example.com/playlist.m3u8" />
              </label>
            {:else if playlistInputMode === 'upload'}
              <!-- Hidden empty playlistUrl so the form action receives the field -->
              <input type="hidden" name="playlistUrl" value="" />
              <!-- Upload File tab: file picker + progress bar + upload button -->
              <div class="upload-zone">
                <label class="a2-field a2-field-wide">
                  <span>Select .m3u or .m3u8 file *</span>
                  <input type="file" accept=".m3u,.m3u8" onchange={handleFileSelect} class="a2-input" />
                </label>
                {#if uploadFile}
                  <p class="upload-file-name">Selected: {uploadFile.name} ({Math.round(uploadFile.size / 1024)} KB)</p>
                {/if}
                {#if uploadProgress}
                  <div class="upload-progress" role="status" aria-live="polite">
                    <div class="upload-progress-bar">
                      <div class="upload-progress-fill" style="width: {uploadProgress.total > 0 ? Math.round((uploadProgress.done / uploadProgress.total) * 100) : 0}%"></div>
                    </div>
                    <p class="upload-progress-text">{uploadProgress.phase} {uploadProgress.total > 0 ? `(${uploadProgress.done}/${uploadProgress.total})` : ''}</p>
                  </div>
                {/if}
                <button type="button" class="a2-btn a2-btn-primary" onclick={() => void uploadAndCreateSource()} disabled={!uploadFile || uploadProgress !== null}>
                  {uploadProgress ? 'Uploading…' : 'Upload & Create Source'}
                </button>
              </div>
            {/if}
          {/if}
          {#if effectiveSourceType() === 'api_provider'}
            <label class="a2-field a2-field-wide"><span>API base URL (https) *</span>
              <input class="a2-input" type="url" name="baseUrl" required value={String((editingSource?.config as Record<string, unknown> | null)?.baseUrl ?? '')} maxlength="2048" placeholder="https://api.example.com" />
            </label>
          {/if}
          {#if effectiveSourceType() === 'embed_provider'}
            <label class="a2-field a2-field-wide"><span>Allowed embed origins (https origins, whitespace/comma separated) *</span>
              <input class="a2-input" type="text" name="allowedOrigins" required value={Array.isArray((editingSource?.config as Record<string, unknown> | null)?.allowedOrigins) ? ((editingSource!.config as Record<string, unknown>).allowedOrigins as string[]).join(', ') : ''} placeholder="https://player.example.com, https://embed.example.net" />
            </label>
          {/if}
          {#if effectiveSourceType() === 'manual_stream' || effectiveSourceType() === 'builtin_livegt_v1'}
            <p class="a2-muted a2-field-wide">No server-side config for this source type.</p>
          {/if}
        </AdminFormSection>
        <AdminFormSection heading="Availability & registry state">
          <label class="a2-field"><span>Status</span>
            <select class="a2-input" name="status">
              {#each SOURCE_STATUSES as status}
                <option value={status} selected={(editingSource?.status ?? 'experimental') === status}>{SOURCE_STATUS_LABELS[status]}</option>
              {/each}
            </select>
          </label>
          <label class="a2-field"><span>Show on Live TV page (visibility)</span>
            <select class="a2-input" name="visibility">
              <option value="public" selected={editingSource ? editingSource.visibility === 'public' : true}>public — eligible when ON</option>
              <option value="internal" selected={editingSource ? editingSource.visibility === 'internal' : false}>internal (admin diagnostics)</option>
              <option value="hidden" selected={editingSource?.visibility === 'hidden'}>hidden</option>
            </select>
          </label>
          <label class="a2-field"><span>Default priority (0 = first)</span>
            <input class="a2-input" type="number" name="priority" value={editingSource?.priority ?? 100} min="0" max="100000" step="1" />
          </label>
          {#if !editingSource}
            <label class="a2-field a2-checkbox-field"><input type="checkbox" name="enabled" /> <span>Enabled immediately (OFF is the safe default — the list's ON/OFF toggle can enable it anytime)</span></label>
          {/if}
          <label class="a2-field a2-field-wide"><span>Description</span>
            <input class="a2-input" type="text" name="description" value={editingSource?.description ?? ''} maxlength="1000" />
          </label>
        </AdminFormSection>
        {#if sheetFormError}
          <div class="notice notice-error" role="alert">{sheetFormError}</div>
        {/if}
        <!-- 2026-10 round 9 — Task 2: hide the form submit buttons when in
             upload mode (the "Upload & Create Source" button handles both
             creating the source AND starting the chunking process). -->
        {#if !(!editingSource && effectiveSourceType() === 'm3u_playlist' && playlistInputMode === 'upload')}
          <div class="a2-toolbar">
            <button type="submit" class="a2-btn a2-btn-primary">{editingSource ? 'Save source' : 'Create source'}</button>
            <button type="button" class="a2-btn" onclick={closeSheets}>Cancel</button>
          </div>
        {/if}
      </form>

      {#if editingSource}
        {@const sourceId = editingSource.id}
        <hr class="sheet-divider" />

        <!-- ======== The source's OWN channels (bounded, paginated) ======== -->
        <section class="sheet-channels" aria-label="Channels from this source">
          <div class="a2-row-head">
            <h3 class="a2-h3">Channels{channelsForOpenSource() ? ` (${formatCount(channelsForOpenSource()!.total)})` : ''}</h3>
            <div class="a2-actions">
              {#if editingSource?.source_type !== 'm3u_playlist'}
                <!-- m3u_playlist sources use "Fetch & Save" on the card; the old
                     server-side Refresh times out (HTML 504). Keep Refresh only
                     for builtin / API sources. -->
                <form method="POST" action="?/refreshSource" use:enhance={refreshEnhance}>
                  <input type="hidden" name="id" value={sourceId} />
                  <button type="submit" class="a2-btn a2-btn-sm" disabled={refreshing || previewing} title="Refresh this source (fetches its upstream catalogue and writes entries/endpoints)" aria-label="Refresh source {editingSource.name}">
                    {#if refreshing}<span class="spinner-icon"><LoaderCircle size={14} aria-hidden="true" /></span> Refreshing…{:else}<RefreshCw size={14} /> Refresh{/if}
                  </button>
                </form>
              {/if}
              <form method="POST" action="?/previewSource" use:enhance={previewEnhance}>
                <input type="hidden" name="id" value={sourceId} />
                <button type="submit" class="a2-btn a2-btn-sm" disabled={refreshing || previewing} title="Preview this source (dry run — nothing is written)" aria-label="Preview source {editingSource.name}">
                  {#if previewing}<span class="spinner-icon"><LoaderCircle size={14} aria-hidden="true" /></span> Previewing…{:else}<Eye size={14} /> Preview{/if}
                </button>
              </form>
            </div>
          </div>
          <p class="a2-muted">
            Last refresh: {openSourceLatestHistory() ? `${openSourceLatestHistory()!.status} · ${formatTime(openSourceLatestHistory()!.finishedAt)} · ${openSourceLatestHistory()!.trigger}` : openSourceLatestLocal() ? `${openSourceLatestLocal()!.ok ? 'ok' : (openSourceLatestLocal()!.failure?.kind ?? 'failed')} · ${formatTime(openSourceLatestLocal()!.finishedAt)} · instance-local` : '—'}
          </p>

          <form method="POST" action="?/sourceChannels" use:enhance={channelsEnhance} bind:this={channelsFormEl} class="channels-form">
            <input type="hidden" name="sourceId" value={sourceId} />
            <input type="hidden" name="page" value={channelsPage} />
            <input class="a2-input" type="search" name="q" bind:value={channelsSearchDraft} maxlength="80" placeholder="Search channels…" aria-label="Search this source's channels" />
            <button type="submit" class="a2-btn a2-btn-sm" onclick={() => setChannelsPageValue(0)}>Search</button>
          </form>

          {#if channelsLoading}
            <p class="a2-muted" role="status">Loading channels…</p>
          {:else if channelsError}
            <div class="notice notice-error" role="alert">{channelsError}</div>
            <div class="a2-toolbar">
              <button type="button" class="a2-btn a2-btn-sm" onclick={retryChannels}>Retry</button>
            </div>
          {:else if channelsForOpenSource()}
            {@const pageData = channelsForOpenSource()!}
            {#if pageData.rows.length === 0}
              <p class="a2-muted">
                {#if channelsSearchDraft.trim() !== ''}
                  No channels match this search.
                {:else}
                  No channels imported yet — {editingSource?.source_type === 'm3u_playlist' ? 'use Fetch & Save on the source card to import this playlist.' : "run Refresh (top-right) to fetch this source's catalogue."}
                {/if}
              </p>
            {:else}
              <ul class="channel-list">
                {#each pageData.rows as channel (channel.id)}
                  <li class="channel-row">
                    <span class="channel-logo" aria-hidden="true">
                      {#if channel.logo_url}
                        <img src={channel.logo_url} alt="" loading="lazy" />
                      {:else}
                        <span class="channel-initials">{channel.name.slice(0, 2).toUpperCase()}</span>
                      {/if}
                    </span>
                    <div class="channel-main">
                      <div class="a2-cell-title">{channel.name}</div>
                      <div class="a2-cell-sub">{channel.category ?? '—'}{channel.mapped ? ' · mapped' : ''}</div>
                    </div>
                    <AdminStatusBadge label={channel.enabled ? 'enabled' : 'disabled'} tone={channel.enabled ? 'good' : 'neutral'} />
                    <div class="channel-kinds">
                      {#each channel.streamKinds as kind (kind)}
                        <span class="a2-chip">{kind}</span>
                      {/each}
                      {#if channel.streamKinds.length === 0}
                        {#if editingSource?.source_type === 'builtin_livegt_v1'}
                          <!-- Builtin sources synthesize their endpoints at resolve
                               time, so they legitimately have no DB endpoint rows. -->
                          <span class="a2-cell-sub">Built-in (synthesized at runtime)</span>
                        {:else}
                          <span class="a2-cell-sub">no usable stream</span>
                        {/if}
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
              <div class="a2-toolbar">
                {#if pageData.page > 0}
                  <button type="button" class="a2-btn a2-btn-sm" onclick={() => submitChannelsPage(pageData.page - 1)}>Previous</button>
                {/if}
                <span class="a2-cell-sub">Page {pageData.page + 1}{pageData.total > pageData.pageSize ? ` of ${Math.max(1, Math.ceil(pageData.total / pageData.pageSize))}` : ''}</span>
                {#if (pageData.page + 1) * pageData.pageSize < pageData.total}
                  <button type="button" class="a2-btn a2-btn-sm" onclick={() => submitChannelsPage(pageData.page + 1)}>Next</button>
                {/if}
              </div>
            {/if}
          {/if}
        </section>

        {#if refreshOutcome}
          {@const outcome = refreshOutcome.outcome}
          <section class="sheet-channels" aria-label="Refresh result">
            <h3 class="a2-h3">{refreshOutcome.kind === 'source-preview' ? 'Preview result' : 'Refresh result'}</h3>
            {#if refreshOutcome.kind === 'source-preview'}
              <p class="a2-muted">Dry run — nothing was written.</p>
            {/if}
            {#if outcome.ok && outcome.counts && 'discovered' in outcome.counts}
              {@const c = outcome.counts}
              <p class="a2-muted">
                {refreshOutcome.kind === 'source-preview' ? 'Preview' : 'Refresh'} complete: {c.discovered} channels, {c.skipped} skipped{c.failed > 0 ? `, ${c.failed} write failures` : ''}.
              </p>
              {#if 'skippedReasons' in outcome && outcome.skippedReasons && Object.keys(outcome.skippedReasons).length > 0}
                <div class="a2-chip-row" aria-label="Skip reasons">
                  {#each Object.entries(outcome.skippedReasons).slice(0, 6) as [reason, count]}
                    <span class="a2-chip">{reason}: {count}</span>
                  {/each}
                </div>
              {/if}
              {#if c.discovered > 0 && c.entriesInserted === 0 && c.entriesUpdated === 0}
                <p class="a2-cell-sub">No entries imported.</p>
              {:else if (c.entriesInserted + c.entriesUpdated) > 0 && c.endpointsInserted === 0 && c.endpointsUpdated === 0}
                <p class="a2-cell-sub">Entries imported without usable endpoints.</p>
              {/if}
            {:else if outcome.failure}
              <div class="notice notice-error" role="alert">{refreshOutcome.kind === 'source-preview' ? 'Preview' : 'Refresh'} failed — {outcome.failure.kind}.</div>
            {/if}
          </section>
        {/if}

        <!-- ======== Danger zone (impact-confirmed delete) ======== -->
        <section class="sheet-danger" aria-label="Danger zone">
          <h3 class="a2-h3">Danger zone</h3>
          <p class="a2-muted">Deleting removes this source together with its imported entries, endpoints and playback candidates (database cascade). This cannot be undone.</p>
          <button type="button" class="a2-btn" disabled={editingSource.builtin} onclick={() => openDeleteSource(editingSource!)}>
            <Trash2 size={14} /> Delete source…
          </button>
          {#if editingSource.builtin}
            <p class="a2-cell-sub">The built-in source is delete-protected.</p>
          {/if}
        </section>
      {/if}
    </AdminSheet>

    <!-- ==================== Confirmed delete (impact preview) ==================== -->
    <AdminConfirmDialog
      open={pendingDelete !== null}
      title="Delete source?"
      description={pendingDelete?.impact ?? ''}
      confirmLabel="Delete"
      cancelLabel="Cancel"
      tone="danger"
      onconfirm={confirmDelete}
      oncancel={() => (pendingDelete = null)}
    >
      <form method="POST" action="?/deleteSource" bind:this={deleteFormEl}>
        <input type="hidden" name="id" value={pendingDelete?.id ?? ''} />
      </form>
      <p class="a2-muted">The database cascades/foreign keys remain the final safety net; the counts above were computed live at page load.</p>
    </AdminConfirmDialog>
  </AdminPage>
</AdminAppShell>

<style>
  /* 2026-10 round 6 — Task 3: dual-mode Add Source (URL + Upload) tabs. */
  .playlist-mode-tabs { display: flex; gap: 0; margin-bottom: 12px; border-bottom: 1px solid var(--a2-border); }
  .playlist-mode-tabs button {
    flex: 1 1 auto; padding: 10px 16px; border: 0; border-bottom: 2px solid transparent;
    background: transparent; color: var(--a2-text-muted); font-size: var(--a2-text-sm);
    font-weight: 600; cursor: pointer; transition: color 150ms ease, border-color 150ms ease;
  }
  .playlist-mode-tabs button:hover { color: var(--a2-text); }
  .playlist-mode-tabs button.active { color: var(--a2-cyan); border-bottom-color: var(--a2-cyan); }
  .playlist-mode-tabs button:focus-visible { outline: 2px solid var(--a2-cyan); outline-offset: -2px; }

  .upload-zone { display: flex; flex-direction: column; gap: 12px; }
  .upload-file-name { margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text-muted); }
  .upload-progress { display: flex; flex-direction: column; gap: 6px; }
  .upload-progress-bar { height: 6px; border-radius: 3px; background: var(--a2-surface-3); overflow: hidden; }
  .upload-progress-fill { height: 100%; background: var(--a2-cyan); border-radius: 3px; transition: width 200ms ease; }
  .upload-progress-text { margin: 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }

  /* Shared Admin2-consistent styles for the Live TV workspace (R-1). */
  .notice {
    padding: var(--a2-space-3) var(--a2-space-4);
    border-radius: var(--a2-radius-md);
    font-size: var(--a2-text-sm);
    border: 1px solid var(--a2-border-strong);
  }
  .notice-ok {
    background: var(--a2-green-soft);
    border-color: var(--a2-green-border);
    color: var(--a2-green);
  }
  .notice-error {
    background: var(--a2-red-soft);
    border-color: var(--a2-red-border);
    color: var(--a2-red);
  }

  .a2-section { margin-bottom: var(--a2-space-6); }
  .a2-row-head { display: flex; align-items: center; justify-content: space-between; gap: var(--a2-space-3); flex-wrap: wrap; margin-bottom: var(--a2-space-2); }
  .a2-h3 { margin: var(--a2-space-4) 0 var(--a2-space-2); font-size: var(--a2-text-md); font-weight: 600; color: var(--a2-text); }
  .a2-muted { color: var(--a2-text-muted); font-size: var(--a2-text-sm); line-height: 1.55; margin: 0 0 var(--a2-space-2); }

  .a2-chip-row { display: flex; flex-wrap: wrap; gap: var(--a2-space-2); margin-top: var(--a2-space-2); }
  .a2-chip {
    display: inline-flex; align-items: center;
    padding: 2px var(--a2-space-2);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: 999px;
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-muted);
    max-width: 100%;
    overflow-wrap: anywhere;
  }

  .source-empty { border: 1px dashed var(--a2-border); border-radius: var(--a2-radius-md); padding: var(--a2-space-5); }

  .source-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .source-row {
    display: flex; flex-direction: column; align-items: stretch; justify-content: flex-start; gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    /* R-2 — compact, content-based height. The row stays horizontal on
       every breakpoint; long source names wrap internally rather than
       flipping the row to a tall column on mobile. */
    min-height: 0;
  }
  .source-main { min-width: 0; flex: 1 1 auto; width: 100%; display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
  .source-main .a2-cell-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .source-main .a2-cell-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .source-controls { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: var(--a2-space-2); width: 100%; flex: 0 0 auto; }
  .source-toggle-form { display: inline-flex; }

  /* The ON/OFF switch (bound to the persisted enabled column). */
  .switch {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    padding: 4px 10px 4px 6px;
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: 999px;
    color: var(--a2-text-muted);
    font-size: var(--a2-text-xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: background var(--a2-motion-micro) var(--a2-ease-out), border-color var(--a2-motion-micro) var(--a2-ease-out), color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .switch:hover { border-color: var(--a2-border-strong); color: var(--a2-text); }
  .switch:focus-visible { outline: 2px solid var(--a2-cyan); outline-offset: 2px; }
  .switch:disabled { opacity: 0.55; cursor: progress; }
  .switch-track {
    position: relative;
    width: 34px; height: 18px;
    border-radius: 999px;
    background: var(--a2-surface-4);
    border: 1px solid var(--a2-border-strong);
    transition: background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .switch-thumb {
    position: absolute; top: 1px; left: 1px;
    width: 14px; height: 14px;
    border-radius: 999px;
    background: var(--a2-text-muted);
    transition: transform var(--a2-motion-micro) var(--a2-ease-out), background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .switch.on { color: var(--a2-green); }
  .switch.on .switch-track { background: var(--a2-green-soft); }
  .switch.on .switch-thumb { transform: translateX(16px); background: var(--a2-green); }

  .a2-toolbar { display: flex; align-items: center; gap: var(--a2-space-2); flex-wrap: wrap; margin: var(--a2-space-3) 0; }
  .a2-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-size: var(--a2-text-sm);
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
    transition: background var(--a2-motion-micro) var(--a2-ease-out), border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-btn:hover { background: var(--a2-surface-4); border-color: var(--a2-border-strong); }
  .a2-btn:focus-visible { outline: 2px solid var(--a2-cyan); outline-offset: 2px; }
  .a2-btn-primary { background: var(--a2-cyan-soft); border-color: var(--a2-cyan); color: var(--a2-cyan); }
  .a2-btn-primary:hover { background: var(--a2-cyan-soft); filter: brightness(1.08); }
  .a2-btn-sm { padding: 4px var(--a2-space-2); font-size: var(--a2-text-xs); }

  .a2-actions { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
  .a2-actions form { display: inline-flex; }

  .a2-input {
    padding: var(--a2-space-2);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-size: var(--a2-text-sm);
  }
  .a2-input:focus-visible { outline: 2px solid var(--a2-cyan); outline-offset: 1px; }
  .a2-field { display: flex; flex-direction: column; gap: 4px; font-size: var(--a2-text-sm); color: var(--a2-text-muted); }
  .a2-checkbox-field { flex-direction: row; align-items: center; gap: var(--a2-space-2); color: var(--a2-text); }

  .a2-cell-title { color: var(--a2-text); font-weight: 500; }
  .a2-cell-sub { color: var(--a2-text-dim); font-size: var(--a2-text-xs); overflow-wrap: anywhere; }

  .sheet-divider { border: none; border-top: 1px solid var(--a2-border-strong); margin: var(--a2-space-5) 0; }
  .sheet-channels { margin-bottom: var(--a2-space-5); }
  .channels-form { display: flex; align-items: center; gap: var(--a2-space-2); flex-wrap: wrap; margin: var(--a2-space-3) 0; }
  .channels-form input[type='search'] { min-width: 220px; }

  .channel-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .channel-row {
    display: flex; align-items: center; gap: var(--a2-space-3);
    padding: var(--a2-space-2) 0;
    border-bottom: 1px solid var(--a2-border);
    flex-wrap: wrap;
  }
  .channel-row:last-child { border-bottom: none; }
  .channel-logo { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; flex: 0 0 auto; border-radius: var(--a2-radius-xs); background: var(--a2-surface-3); overflow: hidden; }
  .channel-logo img { width: 100%; height: 100%; object-fit: contain; }
  .channel-initials { font-size: var(--a2-text-xs); font-weight: 600; color: var(--a2-text-muted); }
  .channel-main { min-width: 0; flex: 1 1 200px; }
  .channel-kinds { display: flex; align-items: center; gap: var(--a2-space-1); flex-wrap: wrap; }

  .sheet-danger { border-top: 1px solid var(--a2-border); padding-top: var(--a2-space-4); }

  @media (max-width: 640px) {
    /* R-2 — the source row stays horizontal on mobile. The name truncates
       with ellipsis; the ON/OFF switch and Edit button stay on the right
       at their touch-target sizes. The row never flips to a tall column. */
    .source-row { padding: 8px 10px; gap: 8px; }
    .source-main { min-width: 0; }
    .source-controls { gap: 6px; }
    .channels-form input[type='search'] { min-width: 0; flex: 1 1 160px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .a2-btn, .switch, .switch-track, .switch-thumb { transition: none; }
  }
  /* R-7 — Refresh/Preview spinner animation. */
  .spinner-icon { animation: spin 1s linear infinite; display: inline-flex; align-items: center; }
  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
