<script lang="ts">
  // Phase 4 — Custom OTT-style control bar for the Scraper player.
  //
  // This component replaces the native <video controls> attribute with
  // a premium, Mavero-styled control overlay. It provides:
  //   * Play/Pause toggle
  //   * Timeline scrubber (seek bar)
  //   * Quality selector (maps hls.js levels)
  //   * Audio track switcher (maps hls.js audioTracks)
  //   * Subtitle track switcher (maps hls.js subtitleTracks)
  //   * Sources button (triggers the source switcher in the parent)
  //
  // DESIGN CONTRACTS:
  //   * Uses Mavero's existing CSS variables — no hardcoded colors.
  //   * Auto-hides after 4s of inactivity (showControls prop).
  //   * Does NOT import or depend on PlaybackManager or PlayerShell.
  //   * Receives all HLS state + video element via props from ScraperViewport.

  import { Play, Pause, Settings, Volume2, VolumeX, Subtitles, ListVideo, ChevronDown, Download } from 'lucide-svelte';

  // Props — all state owned by the parent ScraperViewport
  let {
    isPlaying = false,
    currentTime = 0,
    duration = 0,
    buffered = 0,
    muted = false,
    showControls = true,
    qualities = [] as { height: number; bitrate: number; name?: string; index?: number }[],
    currentLevel = -1,
    audioTracks = [] as { id: number; name?: string; lang?: string; enabled?: boolean }[],
    currentAudioTrack = -1,
    subtitleTracks = [] as { id: number; name?: string; lang?: string; mode?: string }[],
    currentSubtitleTrack = -1,
    activeProvider = '',
    mediaWorkerUrl = '',
    activeStreamUrl = '',
    ontoggleplay = () => {},
    onseek = (_time: number) => {},
    ontogglemute = () => {},
    onsetquality = (_level: number) => {},
    onsetaudio = (_trackId: number) => {},
    onsetsubtitle = (_trackId: number) => {},
    onopensources = () => {},
  }: {
    isPlaying?: boolean;
    currentTime?: number;
    duration?: number;
    buffered?: number;
    muted?: boolean;
    showControls?: boolean;
    qualities?: { height: number; bitrate: number; name?: string; index?: number }[];
    currentLevel?: number;
    audioTracks?: { id: number; name?: string; lang?: string; enabled?: boolean }[];
    currentAudioTrack?: number;
    subtitleTracks?: { id: number; name?: string; lang?: string; mode?: string }[];
    currentSubtitleTrack?: number;
    activeProvider?: string;
    /**
     * Phase 5 — Base URL of the media-worker that exposes
     * GET /api/download?streamUrl=...&quality=... — the Download
     * sheet uses this to construct the file-download URL.
     */
    mediaWorkerUrl?: string;
    /**
     * Phase 5 — The HLS stream URL currently loaded in the player.
     * Forwarded to /api/download as the `streamUrl` query param.
     */
    activeStreamUrl?: string;
    ontoggleplay?: () => void;
    onseek?: (time: number) => void;
    ontogglemute?: () => void;
    onsetquality?: (level: number) => void;
    onsetaudio?: (trackId: number) => void;
    onsetsubtitle?: (trackId: number) => void;
    onopensources?: () => void;
  } = $props();

  // Local UI state
  let activeMenu = $state<'quality' | 'audio' | 'subtitles' | null>(null);
  let isScrubbing = $state(false);
  let scrubValue = $state(0);

  // Phase 5 — Download modal state.
  let showDownloadModal = $state(false);

  // Format time as MM:SS or H:MM:SS
  function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Quality label (e.g., "1080p", "Auto")
  function qualityLabel(level: { height: number; name?: string }, index: number): string {
    if (index === -1) return 'Auto';
    if (level.name) return level.name;
    return level.height ? `${level.height}p` : `Level ${index}`;
  }

  // Audio track label
  function audioLabel(track: { id: number; name?: string; lang?: string }): string {
    if (track.name) return track.name;
    if (track.lang) return track.lang.toUpperCase();
    return `Track ${track.id}`;
  }

  // Subtitle label
  function subtitleLabel(track: { id: number; name?: string; lang?: string }): string {
    if (track.name) return track.name;
    if (track.lang) return track.lang.toUpperCase();
    return `Track ${track.id}`;
  }

  function toggleMenu(menu: 'quality' | 'audio' | 'subtitles') {
    activeMenu = activeMenu === menu ? null : menu;
  }

  // ============================================================
  // Phase 5 — Download handlers
  // ============================================================

  /**
   * Returns a sanitized quality token for the download URL's
   * `quality` query param (also used in the saved filename).
   * Examples: 'auto' (master), '1080p', '720p', 'level2'.
   */
  function downloadQualityToken(level: { height: number; name?: string } | undefined, index: number): string {
    if (index === -1 || !level) return 'auto';
    if (level.name) return level.name.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    return level.height ? `${level.height}p` : `level${index}`;
  }

  function openDownloadModal() {
    showDownloadModal = true;
  }

  function closeDownloadModal() {
    showDownloadModal = false;
  }

  /**
   * Constructs the media-worker /api/download URL and triggers a file
   * download using a HIDDEN ANCHOR tag (`<a download>`). This is the
   * UX-correct alternative to `window.open`:
   *
   *   * No new tab is opened (so there is no blank tab to dismiss and
   *     no `about:blank` flicker for short streams).
   *   * Aggressive popup blockers (which often intercept `window.open`
   *     when the call is not the direct result of a user gesture, or
   *     when the destination is cross-origin) do not fire — clicking
   *     an anchor with the `download` attribute is the same path the
   *     browser uses for any other file link, so it is always allowed.
   *
   * The actual saved filename is decided by the backend's
   * `Content-Disposition: attachment; filename=...` header — the
   * `download=""` attribute here is just a hint that the resource
   * MUST be downloaded rather than rendered inline.
   *
   * The anchor is created, appended, clicked, and removed
   * synchronously inside the click handler so the browser treats it
   * as a direct user-initiated navigation (preserving the user-gesture
   * activation that `Content-Disposition` downloads require).
   */
  function triggerDownload(level: { height: number; name?: string } | undefined, index: number) {
    if (!activeStreamUrl || !mediaWorkerUrl) {
      closeDownloadModal();
      return;
    }
    const qualityToken = downloadQualityToken(level, index);
    const downloadUrl = `${mediaWorkerUrl}/api/download?streamUrl=${encodeURIComponent(activeStreamUrl)}&quality=${qualityToken}`;

    // Hidden anchor pattern — preferred over `window.open` for downloads.
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.setAttribute('download', '');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    closeDownloadModal();
  }

  // Derived: whether the Download button should be enabled.
  let canDownload = $derived(Boolean(activeStreamUrl && mediaWorkerUrl));

  function handleScrubStart() {
    isScrubbing = true;
    scrubValue = currentTime;
  }

  function handleScrubMove(e: Event) {
    if (!isScrubbing) return;
    const input = e.target as HTMLInputElement;
    scrubValue = Number(input.value);
  }

  function handleScrubEnd() {
    if (isScrubbing) {
      onseek(scrubValue);
      isScrubbing = false;
    }
  }

  // Progress percentage for the visual fill
  let progressPercent = $derived(duration > 0 ? ((isScrubbing ? scrubValue : currentTime) / duration) * 100 : 0);
  let bufferedPercent = $derived(duration > 0 ? (buffered / duration) * 100 : 0);
</script>

<!-- Control overlay — covers the full video area, shows/hides via showControls -->
{#if showControls}
  <div class="controls-overlay">
    <!-- Click-to-toggle-play zone (center area, not on controls) -->
    <div class="play-zone" onclick={() => ontoggleplay()} role="button" tabindex="0" aria-label={isPlaying ? 'Pause' : 'Play'} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ontoggleplay(); } }}></div>

    <!-- Bottom control bar -->
    <div class="control-bar">
      <!-- Progress bar / Timeline -->
      <div class="timeline-row">
        <span class="time-label">{formatTime(isScrubbing ? scrubValue : currentTime)}</span>
        <div class="timeline-track">
          <div class="timeline-buffered" style="width: {bufferedPercent}%"></div>
          <div class="timeline-progress" style="width: {progressPercent}%"></div>
          <input
            type="range"
            min="0"
            max={duration || 0}
            step="0.1"
            value={isScrubbing ? scrubValue : currentTime}
            class="timeline-input"
            aria-label="Seek"
            onpointerdown={handleScrubStart}
            oninput={handleScrubMove}
            onpointerup={handleScrubEnd}
            onpointerleave={() => { if (isScrubbing) handleScrubEnd(); }}
          />
        </div>
        <span class="time-label">{formatTime(duration)}</span>
      </div>

      <!-- Buttons row -->
      <div class="buttons-row">
        <!-- Play/Pause -->
        <button class="ctrl-btn" type="button" aria-label={isPlaying ? 'Pause' : 'Play'} onclick={() => ontoggleplay()}>
          {#if isPlaying}<Pause size={20} />{:else}<Play size={20} fill="currentColor" />{/if}
        </button>

        <!-- Mute -->
        <button class="ctrl-btn" type="button" aria-label={muted ? 'Unmute' : 'Mute'} onclick={() => ontogglemute()}>
          {#if muted}<VolumeX size={18} />{:else}<Volume2 size={18} />{/if}
        </button>

        <!-- Spacer -->
        <div class="ctrl-spacer"></div>

        <!-- Provider name (display only) -->
        {#if activeProvider}
          <span class="provider-tag">{activeProvider}</span>
        {/if}

        <!-- Subtitles -->
        {#if subtitleTracks.length > 0}
          <div class="dropdown-wrap">
            <button class="ctrl-btn" class:active={activeMenu === 'subtitles'} type="button" aria-label="Subtitles" onclick={() => toggleMenu('subtitles')}>
              <Subtitles size={18} />
              <ChevronDown size={12} />
            </button>
            {#if activeMenu === 'subtitles'}
              <div class="dropdown-menu" role="menu" aria-label="Subtitle tracks">
                <button class="dropdown-item" class:active={currentSubtitleTrack === -1} type="button" role="menuitem" onclick={() => { onsetsubtitle(-1); activeMenu = null; }}>Off</button>
                {#each subtitleTracks as track (track.id)}
                  <button class="dropdown-item" class:active={currentSubtitleTrack === track.id} type="button" role="menuitem" onclick={() => { onsetsubtitle(track.id); activeMenu = null; }}>
                    {subtitleLabel(track)}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        <!-- Audio -->
        {#if audioTracks.length > 1}
          <div class="dropdown-wrap">
            <button class="ctrl-btn" class:active={activeMenu === 'audio'} type="button" aria-label="Audio track" onclick={() => toggleMenu('audio')}>
              <span class="audio-icon">Audio</span>
              <ChevronDown size={12} />
            </button>
            {#if activeMenu === 'audio'}
              <div class="dropdown-menu" role="menu" aria-label="Audio tracks">
                {#each audioTracks as track (track.id)}
                  <button class="dropdown-item" class:active={currentAudioTrack === track.id} type="button" role="menuitem" onclick={() => { onsetaudio(track.id); activeMenu = null; }}>
                    {audioLabel(track)}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        <!-- Quality -->
        {#if qualities.length > 0}
          <div class="dropdown-wrap">
            <button class="ctrl-btn" class:active={activeMenu === 'quality'} type="button" aria-label="Quality" onclick={() => toggleMenu('quality')}>
              <Settings size={18} />
              <ChevronDown size={12} />
            </button>
            {#if activeMenu === 'quality'}
              <div class="dropdown-menu" role="menu" aria-label="Quality levels">
                <button class="dropdown-item" class:active={currentLevel === -1} type="button" role="menuitem" onclick={() => { onsetquality(-1); activeMenu = null; }}>Auto</button>
                {#each qualities as level, i (i)}
                  <button class="dropdown-item" class:active={currentLevel === i} type="button" role="menuitem" onclick={() => { onsetquality(i); activeMenu = null; }}>
                    {qualityLabel(level, i)}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        <!-- Sources -->
        <button class="ctrl-btn" type="button" aria-label="Switch source" onclick={() => onopensources()}>
          <ListVideo size={18} />
        </button>

        <!-- Phase 5: Download — opens the quality download modal -->
        <button
          class="ctrl-btn"
          type="button"
          aria-label="Download"
          disabled={!canDownload}
          onclick={openDownloadModal}
        >
          <Download size={18} />
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Phase 5: Download sheet (rendered outside the auto-hide overlay so it
     stays open regardless of inactivity timeout) -->
{#if showDownloadModal}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="download-overlay" role="presentation" onclick={closeDownloadModal} onkeydown={(e) => { if (e.key === 'Escape') closeDownloadModal(); }}>
    <div class="download-panel" role="dialog" aria-modal="true" aria-label="Download quality" tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <div class="download-head">
        <span class="download-title">Download</span>
        <button class="download-close" type="button" aria-label="Close" onclick={closeDownloadModal}>✕</button>
      </div>
      <p class="download-hint">Choose a quality — the file is remuxed into MP4 on the fly.</p>
      <div class="download-list">
        <button
          class="download-item"
          type="button"
          onclick={() => triggerDownload(undefined, -1)}
        >
          <div class="download-item-icon">★</div>
          <span class="download-item-name">Auto (best available)</span>
          <span class="download-item-tag">MP4</span>
        </button>
        {#each qualities as level, i (i)}
          <button
            class="download-item"
            type="button"
            onclick={() => triggerDownload(level, i)}
          >
            <div class="download-item-icon">↓</div>
            <span class="download-item-name">{qualityLabel(level, i)}</span>
            <span class="download-item-tag">MP4</span>
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .controls-overlay {
    position: absolute;
    inset: 0;
    z-index: 15;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    pointer-events: none;
  }

  /* Click-to-toggle zone — fills the area above the control bar */
  .play-zone {
    flex: 1;
    pointer-events: auto;
    cursor: pointer;
  }

  /* Bottom control bar */
  .control-bar {
    pointer-events: auto;
    background: linear-gradient(to top, rgba(0, 0, 0, .85), rgba(0, 0, 0, .4), transparent);
    padding: 12px 16px max(12px, env(safe-area-inset-bottom)) 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* Timeline */
  .timeline-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .time-label {
    font-size: .65rem;
    font-weight: 600;
    color: rgba(255, 255, 255, .7);
    font-variant-numeric: tabular-nums;
    min-width: 36px;
    text-align: center;
  }

  .timeline-track {
    flex: 1;
    position: relative;
    height: 4px;
    border-radius: 99px;
    background: rgba(255, 255, 255, .15);
    cursor: pointer;
  }

  .timeline-buffered {
    position: absolute;
    inset: 0;
    border-radius: 99px;
    background: rgba(255, 255, 255, .2);
    transition: width 150ms linear;
  }

  .timeline-progress {
    position: absolute;
    inset: 0;
    border-radius: 99px;
    background: var(--accent, #f5f5f5);
    transition: width 50ms linear;
  }

  .timeline-input {
    position: absolute;
    inset: -8px 0;
    width: 100%;
    height: 20px;
    opacity: 0;
    cursor: pointer;
    margin: 0;
    -webkit-appearance: none;
    appearance: none;
  }

  /* Buttons */
  .buttons-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ctrl-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: rgba(255, 255, 255, .85);
    cursor: pointer;
    font: inherit;
    font-size: .65rem;
    font-weight: 700;
    transition: background 150ms ease, color 150ms ease;
  }
  .ctrl-btn:hover {
    background: rgba(255, 255, 255, .1);
    color: #fff;
  }
  .ctrl-btn:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
  .ctrl-btn.active {
    background: rgba(255, 255, 255, .15);
    color: #fff;
  }

  .ctrl-spacer { flex: 1; }

  .provider-tag {
    font-size: .6rem;
    font-weight: 700;
    color: rgba(255, 255, 255, .4);
    text-transform: uppercase;
    letter-spacing: .04em;
    margin-right: 4px;
  }

  .audio-icon { font-size: .62rem; font-weight: 800; letter-spacing: .02em; }

  /* Dropdowns */
  .dropdown-wrap {
    position: relative;
  }

  .dropdown-menu {
    position: absolute;
    bottom: calc(100% + 8px);
    right: 0;
    min-width: 140px;
    max-height: 240px;
    overflow-y: auto;
    background: rgba(13, 13, 13, .95);
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: var(--radius-md, 12px);
    padding: 4px;
    backdrop-filter: blur(16px);
    box-shadow: 0 8px 32px rgba(0, 0, 0, .5);
    z-index: 20;
  }

  .dropdown-item {
    display: block;
    width: 100%;
    padding: 8px 12px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: rgba(255, 255, 255, .7);
    font: inherit;
    font-size: .7rem;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    transition: background 100ms ease, color 100ms ease;
  }
  .dropdown-item:hover {
    background: rgba(255, 255, 255, .08);
    color: #fff;
  }
  .dropdown-item.active {
    background: rgba(255, 255, 255, .12);
    color: #fff;
  }
  .dropdown-item:focus-visible {
    outline: 2px solid #fff;
    outline-offset: -2px;
  }

  /* Mobile */
  @media (max-width: 480px) {
    .control-bar { padding: 10px 12px max(10px, env(safe-area-inset-bottom)) 12px; }
    .ctrl-btn { padding: 6px; }
    .time-label { font-size: .6rem; min-width: 32px; }
    .provider-tag { display: none; }
    .dropdown-menu { min-width: 120px; }
  }

  /* Phase 5 — Download sheet (mirrors the source-switcher look in ScraperViewport) */
  .download-overlay {
    position: absolute;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, .7);
    backdrop-filter: blur(8px);
  }

  .download-panel {
    width: min(100%, 380px);
    max-height: 70vh;
    overflow-y: auto;
    border: 1px solid rgba(255, 255, 255, .14);
    border-radius: var(--radius-md, 12px);
    background: rgba(13, 13, 13, .96);
    padding: 16px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, .6);
  }

  .download-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .download-title {
    font-size: .85rem;
    font-weight: 800;
    color: #fff;
    letter-spacing: -.01em;
  }

  .download-close {
    border: 0;
    background: transparent;
    color: rgba(255, 255, 255, .55);
    font-size: 1.1rem;
    cursor: pointer;
    padding: 4px;
    line-height: 1;
  }
  .download-close:hover { color: #fff; }

  .download-hint {
    margin: 0 0 12px;
    font-size: .68rem;
    color: rgba(255, 255, 255, .55);
    line-height: 1.45;
  }

  .download-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .download-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: rgba(255, 255, 255, .8);
    font: inherit;
    font-size: .72rem;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    transition: background 100ms ease, color 100ms ease;
  }
  .download-item:hover {
    background: rgba(255, 255, 255, .08);
    color: #fff;
  }
  .download-item:focus-visible {
    outline: 2px solid #fff;
    outline-offset: -2px;
  }

  .download-item-icon {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    color: var(--accent, #f5f5f5);
    font-size: .8rem;
    font-weight: 800;
  }

  .download-item-name { flex: 1; }

  .download-item-tag {
    font-size: .55rem;
    font-weight: 700;
    color: rgba(255, 255, 255, .45);
    text-transform: uppercase;
    letter-spacing: .04em;
  }
</style>
