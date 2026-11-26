import { PLAYER_AUTO_QUALITY_ID, type PlayerInternalQualityOption } from '$lib/shared/player';
// The audio-track OPTION shape is the hls engine's public contract — the
// shell/controls consume `enginequality` payloads whose `audioTracks` field
// is typed `HlsAudioTrackLike[]` regardless of WHICH engine is live. A
// type-only import keeps this module decoupled from the hls ENGINE itself
// (no runtime dependency — the hls path stays byte-for-byte unchanged).
import type { HlsAudioTrackLike } from '$lib/client/player/hls-engine';
// The shaka-player 5.2.12 module the Live TV path already imports — SAME
// build, SAME memoized browser-guarded loader, no new dependency and no
// change to the Live TV path. Only types + the loader + the stable public
// error enum numbers are consumed here (all exported by that module).
import {
  loadShakaModule,
  SHAKA_ERROR_CODE,
  SHAKA_ERROR_SEVERITY,
  type ShakaErrorEventLike,
  type ShakaErrorLike,
  type ShakaModuleLoader,
  type ShakaPlayerLike,
} from '$lib/client/live-tv/player';

/**
 * Shaka VOD playback engine — round 42 (2026-11), VidBox (DASH/.mpd).
 *
 * A SMALL adapter for the EXISTING direct `<video>` path, mirroring the
 * PUBLIC SURFACE of the hls engine (`hls-engine.ts`) EXACTLY — same
 * methods, same getters, the same `enginequality` event contract
 * PlayerViewport/PlayerShell already consume:
 *
 *   PlaybackManager → PlayerShell → PlayerViewport
 *     → direct MP4 / native HLS  → existing `<video src>` path (unchanged)
 *     → non-native HLS           → hls engine (hls-engine.ts, unchanged)
 *     → DASH (.mpd)              → THIS engine → SAME `<video>`
 *
 * PlayerViewport picks the engine by protocol ('dash' → shaka, 'hls' → the
 * existing hls engine). Everything above the engines is untouched: the
 * `<video>` element still fires loadedmetadata/timeupdate/play/pause/…, so
 * PlayerShell's pendingSeek/position restore, progress reporting, Media
 * Session, PiP, fullscreen and Wake Lock keep working unchanged.
 *
 * DOCUMENTED INTEGRATION CONTRACT (same sequence the Live TV engine uses,
 * audited against shaka-player 5.2.12):
 *
 *   const player = new shaka.Player();
 *   await player.attach(video);
 *   await player.load(url);   // bare load — no MIME; shaka sniffs .mpd
 *
 * QUALITY (verified against the installed shaka-player 5.2.12 typings):
 *   * `getVariantTracks()` returns the manifest's variant tracks; each
 *     carries `height`, `bandwidth`/`videoBandwidth`, `language`, `active`.
 *     Tracks are deduped per height into `PlayerInternalQualityOption`s
 *     (label "<height>p"); the Quality menu therefore ALWAYS reflects the
 *     MPD's real levels — never a hand-built list.
 *   * Picking a level = `configure({ abr: { enabled: false } })` +
 *     `selectVariantTrack(track, true)` (a buffer switch — the stream keeps
 *     playing, the engine is NEVER recreated).
 *   * AUTO re-enables ABR: `configure({ abr: { enabled: true } })`.
 *   * AUTO uses the reserved PLAYER_AUTO_QUALITY_ID (same as the hls engine).
 *
 * AUDIO (shaka-player 5.2.12 API — `getAudioLanguages`/`selectAudioLanguage`
 * no longer exist in this major; the installed typings expose
 * `getAudioTracks(): AudioTrack[]` + `selectAudioTrack(track)` instead,
 * which is what this engine drives):
 *   * `getAudioTracks()` → audioTracks in the SAME shape as the hls engine
 *     (`{ id, lang, name, default }` — `id` is the index into this list).
 *   * `getSelectedAudioTrack()` → the `active` track's index, or null.
 *   * `selectAudioTrack(index)` → `selectAudioTrack(rawTrack)` — never
 *     recreates the engine.
 *
 * NO subtitle pipeline here — the existing PlayerShell <track> path stays
 * (VidBox SRTs are converted to VTT server-side by
 * /api/content/subtitles/vtt/proxy).
 *
 * SSR BOUNDARY: this module is CLIENT-ONLY. It contains no top-level
 * browser globals and no top-level side effects, so importing it during
 * SSR is safe; the shaka bundle itself is loaded exclusively through the
 * browser-guarded dynamic `loadShakaModule()` loader.
 *
 * RACE PROTECTION: every `attach()` bumps a generation token — a slow
 * initialization for source A is invalidated when the source switches to B
 * (destroy/attach), and stale load continuations or stale events can never
 * reach the current video element or callbacks.
 *
 * ERROR HANDLING: bounded and classified — RECOVERABLE-severity shaka
 * errors are left to shaka's internal handling; LOAD_INTERRUPTED /
 * OPERATION_ABORTED are teardown races (silent); everything else destroys
 * the instance and surfaces a generic player error through the SAME
 * `onFatalError` callback the hls engine uses (round 43: the RAW shaka
 * error rides along as `detail` so the player wiring logs the single
 * '[player] dash error' line with the real code + message — this engine
 * itself stays log-free). No retry loops.
 */

/** One engine-agnostic quality level (mirrors HlsEngineLevel). */
export type ShakaVodEngineLevel = {
  index: number;
  height?: number;
  bitrate?: number;
  label: string;
};

/** Structural shape of one shaka variant track the engine inspects. */
export type ShakaVariantTrackLike = {
  id?: number;
  active?: boolean;
  height?: number | null;
  bandwidth?: number;
  videoBandwidth?: number | null;
  language?: string;
};

/** Structural shape of one shaka audio track (shaka-player 5.2.12). */
export type ShakaAudioTrackLike = {
  active?: boolean;
  language?: string;
  label?: string | null;
  primary?: boolean;
};

/**
 * The shaka.Player surface THIS engine drives — the Live TV structural type
 * plus the 5.2.12 audio-track API and the generic event-listener signature
 * ('error' + 'trackschanged' both arrive as FakeEvents with a `detail`).
 */
export type ShakaVodPlayerLike = Omit<ShakaPlayerLike, 'addEventListener' | 'removeEventListener'> & {
  addEventListener(type: string, listener: (event: ShakaErrorEventLike) => void): void;
  removeEventListener(type: string, listener: (event: ShakaErrorEventLike) => void): void;
  getAudioTracks?(): unknown[];
  selectAudioTrack?(track: unknown, safeMargin?: number): void;
};

/** Engine callbacks — the same contract the hls engine exposes. */
export type ShakaVodEngineCallbacks = {
  onState?: (state: 'loading' | 'manifest-loaded' | 'error') => void;
  /** Unrecoverable failure — the video cannot play this source. Round 43:
   *  the RAW shaka error (code/message) rides along as `detail` when there
   *  is one, so the player wiring can log ONE '[player] dash error' line
   *  with the real code — the engine itself no longer logs (the callback
   *  is the single error surface). */
  onFatalError?: (message: string, detail?: ShakaErrorLike & { message?: unknown }) => void;
  /** The manifest's quality levels became known (once per attach + on
   *  'trackschanged'). */
  onQualityLevels?: (levels: ShakaVodEngineLevel[]) => void;
  /** The internal quality MODE/level changed (AUTO id or level index). */
  onQualitySelection?: (selection: string, levels: ShakaVodEngineLevel[]) => void;
};

export type ShakaVodEngineOptions = {
  /** Injectable module loader (tests); defaults to the shared loader. */
  shakaLoader?: ShakaModuleLoader;
};

export const SHAKA_VOD_UNRECOVERABLE_MESSAGE = 'This stream could not be played. Try another source.';
export const SHAKA_VOD_UNSUPPORTED_MESSAGE = 'DASH playback is not supported in this browser. Try another source.';

/**
 * Safe quality label derivation (mirrors hlsLevelLabel):
 *   height 1080      → "1080p"
 *   bitrate 1500000  → "1.5 Mbps" / bitrate 800000 → "800 kbps"
 *   neither          → "Auto"
 */
export function shakaVodLevelLabel(track: ShakaVariantTrackLike): string {
  const height = typeof track?.height === 'number' && Number.isFinite(track.height) && track.height > 0 ? track.height : undefined;
  if (height !== undefined) return `${Math.round(height)}p`;
  const bitrate = typeof track?.bandwidth === 'number' && Number.isFinite(track.bandwidth) && track.bandwidth > 0
    ? track.bandwidth
    : typeof track?.videoBandwidth === 'number' && Number.isFinite(track.videoBandwidth) && track.videoBandwidth > 0
      ? track.videoBandwidth
      : undefined;
  if (bitrate !== undefined) {
    const kbps = Math.round(bitrate / 1000);
    if (kbps >= 1000) {
      const mbps = kbps / 1000;
      return `${Number.isInteger(mbps) ? mbps : Number(mbps.toFixed(1))} Mbps`;
    }
    return `${kbps} kbps`;
  }
  return 'Auto';
}

/** True for shaka failures the engine must NOT surface (teardown races /
 *  shaka-internal recoveries). */
function isSilentShakaFailure(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const error = raw as ShakaErrorLike;
  const severity = typeof error.severity === 'number' ? error.severity : NaN;
  if (severity === SHAKA_ERROR_SEVERITY.RECOVERABLE) return true; // shaka retries internally
  const code = typeof error.code === 'number' ? error.code : NaN;
  return code === SHAKA_ERROR_CODE.LOAD_INTERRUPTED || code === SHAKA_ERROR_CODE.OPERATION_ABORTED;
}

export class ShakaVodEngine {
  private loader: ShakaModuleLoader;
  /** Generation token — bumped on every attach/destroy; stale continuations drop. */
  private generation = 0;
  private instance: ShakaVodPlayerLike | null = null;
  private active = false;
  private destroyed = false;
  /** True while shaka ABR owns the level selection (the AUTO mode flag). */
  private abrEnabled = true;
  /** The manually selected level index (null while AUTO). */
  private manualLevel: number | null = null;

  constructor(options: ShakaVodEngineOptions = {}) {
    this.loader = options.shakaLoader ?? loadShakaModule;
  }

  /** True while a shaka instance is attached (or initializing) for a source. */
  isActive(): boolean {
    return this.active;
  }

  /** Test/inspection hook: the live shaka instance, if any. */
  getInstance(): ShakaVodPlayerLike | null {
    return this.instance;
  }

  // ----- internal quality levels (generic, library-free surface) -----

  /** The raw variant tracks of the loaded manifest (empty when unavailable). */
  private readVariantTracks(): ShakaVariantTrackLike[] {
    const player = this.instance;
    if (this.destroyed || !player || typeof player.getVariantTracks !== 'function') return [];
    try {
      const tracks = player.getVariantTracks();
      return Array.isArray(tracks) ? (tracks as ShakaVariantTrackLike[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Dedupe the variant tracks into one level per distinct quality, keeping
   * the variant to select for each level:
   *   * dedupe key = height (fallback: bandwidth) — a multi-audio or
   *     multi-codec MPD yields several variants per height, the Quality
   *     menu must list the height ONCE;
   *   * per level, prefer the ACTIVE variant, then one whose language
   *     matches the active variant's language (a manual level pick must
   *     never silently switch audio language), then the first seen.
   * Levels keep first-seen (manifest) order, mirroring the hls engine.
   */
  private computeLevels(): { levels: ShakaVodEngineLevel[]; tracks: ShakaVariantTrackLike[] } {
    const tracks = this.readVariantTracks();
    const activeLanguage = tracks.find((track) => track?.active === true)?.language;
    const levels: ShakaVodEngineLevel[] = [];
    const chosen: ShakaVariantTrackLike[] = [];
    const seen = new Set<string>();
    const score = (track: ShakaVariantTrackLike): number => {
      if (track?.active === true) return 3;
      if (activeLanguage !== undefined && track?.language === activeLanguage) return 2;
      return 1;
    };
    for (const track of tracks) {
      if (!track || typeof track !== 'object') continue;
      const height = typeof track.height === 'number' && Number.isFinite(track.height) && track.height > 0 ? Math.round(track.height) : undefined;
      const bitrate = typeof track.bandwidth === 'number' && Number.isFinite(track.bandwidth) && track.bandwidth > 0 ? Math.round(track.bandwidth) : undefined;
      const key = height !== undefined ? `h${height}` : `b${bitrate ?? 0}`;
      const existing = seen.has(key);
      if (existing) {
        // Keep the BETTER variant for this level (active > same-language > first).
        const index = levels.findIndex((level) => (height !== undefined ? level.height === height : level.bitrate === bitrate));
        if (index >= 0 && score(track) > score(chosen[index]!)) {
          chosen[index] = track;
          levels[index] = {
            index,
            label: shakaVodLevelLabel(track),
            ...(height !== undefined ? { height } : {}),
            ...(bitrate !== undefined ? { bitrate } : {}),
          };
        }
        continue;
      }
      seen.add(key);
      levels.push({
        index: levels.length,
        label: shakaVodLevelLabel(track),
        ...(height !== undefined ? { height } : {}),
        ...(bitrate !== undefined ? { bitrate } : {}),
      });
      chosen.push(track);
    }
    return { levels, tracks: chosen };
  }

  /** All quality levels of the loaded manifest, in manifest order. */
  getQualityLevels(): ShakaVodEngineLevel[] {
    if (this.destroyed) return [];
    return this.computeLevels().levels;
  }

  /**
   * The current generic selection id: AUTO while ABR is in control, else
   * the manually selected level index as a string. `null` when no instance
   * is live. Mirrors the hls engine's getQualitySelection contract.
   */
  getQualitySelection(): string | null {
    if (!this.instance || this.destroyed) return null;
    if (this.abrEnabled || this.manualLevel === null) return PLAYER_AUTO_QUALITY_ID;
    return String(this.manualLevel);
  }

  /** Engine-agnostic quality options for the UI (empty when unavailable). */
  getQualityOptions(): PlayerInternalQualityOption[] {
    return this.getQualityLevels().map((level) => ({ id: String(level.index), label: level.label }));
  }

  /** Re-enable ABR (AUTO). Never throws; a failed configure keeps the
   *  current mode — the ABR default remains authoritative. */
  setAutoQualityLevel(): void {
    const player = this.instance;
    if (!player || this.destroyed) return;
    let configured = false;
    try {
      configured = player.configure({ abr: { enabled: true } });
    } catch {
      configured = false;
    }
    if (!configured) return;
    this.abrEnabled = true;
    this.manualLevel = null;
  }

  /**
   * Select one quality level manually: disable ABR + selectVariantTrack
   * (a buffer switch — the engine instance is NEVER recreated). On a
   * failed switch the engine falls back to AUTO instead of destroying the
   * instance (same contract as the hls engine, spec §35).
   */
  setQualityLevel(index: number): void {
    const player = this.instance;
    if (!player || this.destroyed || typeof player.selectVariantTrack !== 'function') return;
    const { levels, tracks } = this.computeLevels();
    if (!Number.isSafeInteger(index) || index < 0 || index >= levels.length) return;
    try {
      if (!player.configure({ abr: { enabled: false } })) return;
      player.selectVariantTrack(tracks[index]!, true);
    } catch {
      // Fall back to AUTO — a failed selection never breaks playback.
      try {
        if (player.configure({ abr: { enabled: true } })) {
          this.abrEnabled = true;
          this.manualLevel = null;
        }
      } catch {
        // give up silently — the ABR default remains authoritative
      }
      return;
    }
    this.abrEnabled = false;
    this.manualLevel = index;
  }

  // ----- audio tracks — only when the stream HAS them -----

  /** The raw shaka audio tracks (empty when unavailable — never throws). */
  private readAudioTracks(): ShakaAudioTrackLike[] {
    const player = this.instance;
    if (this.destroyed || !player || typeof player.getAudioTracks !== 'function') return [];
    try {
      const tracks = player.getAudioTracks();
      return Array.isArray(tracks) ? (tracks as ShakaAudioTrackLike[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * The stream's audio tracks in the SAME shape as the hls engine exposes
   * them ({ id: index, lang, name, default }) — labels are the
   * manifest-provided label/language verbatim (never invented). EMPTY when
   * the stream has none; the UI renders no selector for a single track.
   */
  getAudioTracks(): HlsAudioTrackLike[] {
    const raw = this.readAudioTracks();
    return raw.map((track, index) => ({
      id: index,
      lang: typeof track?.language === 'string' ? track.language : '',
      name: (typeof track?.label === 'string' && track.label.trim()) || (typeof track?.language === 'string' ? track.language : '') || '',
      ...(track?.primary === true ? { default: true } : {}),
    }));
  }

  /** The currently playing audio track index (the `active` track), or null. */
  getSelectedAudioTrack(): number | null {
    const raw = this.readAudioTracks();
    const index = raw.findIndex((track) => track?.active === true);
    return index >= 0 ? index : null;
  }

  /** Selects one audio track by index. Never recreates the engine. */
  selectAudioTrack(index: number): void {
    const player = this.instance;
    if (!player || this.destroyed || typeof player.selectAudioTrack !== 'function') return;
    const raw = this.readAudioTracks();
    if (!Number.isSafeInteger(index) || index < 0 || index >= raw.length) return;
    try {
      player.selectAudioTrack(raw[index]!);
    } catch {
      // selection failure is non-fatal — the current track keeps playing
    }
  }

  // ----- lifecycle -----

  /**
   * Attach the engine to a video element and load `url` through shaka
   * (documented sequence: attach → load, bare load — shaka sniffs the .mpd
   * extension and picks the DASH parser). Safe to call repeatedly for
   * source switches: the previous instance is always destroyed first, so
   * exactly ONE shaka instance is ever attached to the video element.
   */
  async attach(video: HTMLMediaElement, url: string, callbacks: ShakaVodEngineCallbacks = {}): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    // Never allow two instances on the same video element.
    this.destroyInstance();
    this.abrEnabled = true;
    this.manualLevel = null;
    this.active = true;
    callbacks.onState?.('loading');

    const module = await this.loader();
    // Stale attach: a newer attach/destroy superseded this one.
    if (this.destroyed || generation !== this.generation) return;
    if (!module || typeof module.Player.isBrowserSupported === 'function' && !module.Player.isBrowserSupported()) {
      this.active = false;
      callbacks.onState?.('error');
      callbacks.onFatalError?.(SHAKA_VOD_UNSUPPORTED_MESSAGE);
      return;
    }

    const player = new module.Player() as unknown as ShakaVodPlayerLike;
    this.instance = player;

    // Fatal-error listener — bridges shaka 'error' FakeEvents onto the SAME
    // generic fatal-error surface the hls engine exposes. Stale events (a
    // newer attach took over) never reach the callbacks.
    const onPlayerError = (event: ShakaErrorEventLike) => {
      if (generation !== this.generation || this.destroyed) return;
      if (this.instance !== player) return;
      const detail = event?.detail ?? null;
      if (!detail || isSilentShakaFailure(detail)) return;
      // Round 43 — no local log: the raw detail rides the fatal-error
      // callback and the player wiring logs the single
      // '[player] dash error' line (code + message).
      this.fail(callbacks, SHAKA_VOD_UNRECOVERABLE_MESSAGE, detail);
    };
    // Late track changes (manifest updates) refresh the quality surface —
    // generation-guarded like every other listener.
    const onTracksChanged = () => {
      if (generation !== this.generation || this.destroyed) return;
      if (this.instance !== player) return;
      callbacks.onQualityLevels?.(this.getQualityLevels());
      callbacks.onQualitySelection?.(this.getQualitySelection() ?? PLAYER_AUTO_QUALITY_ID, this.getQualityLevels());
    };
    try {
      player.addEventListener('error', onPlayerError);
      player.addEventListener('trackschanged', onTracksChanged);
    } catch {
      // listener registration must never throw
    }

    try {
      await player.attach(video);
      if (this.destroyed || generation !== this.generation || this.instance !== player) return;
      await player.load(url);
      if (this.destroyed || generation !== this.generation || this.instance !== player) return;
    } catch (error) {
      if (this.destroyed || generation !== this.generation || this.instance !== player) return;
      if (isSilentShakaFailure(error)) return; // teardown race / shaka-internal abort
      // Round 43 — no local log: the raw error rides the fatal-error
      // callback and the player wiring logs the single
      // '[player] dash error' line (code + message).
      this.fail(callbacks, SHAKA_VOD_UNRECOVERABLE_MESSAGE, error as ShakaErrorLike & { message?: unknown });
      return;
    }

    // Ready — surface the manifest's real levels (a single-quality manifest
    // yields a one-entry list; the UI stays hidden for those).
    callbacks.onState?.('manifest-loaded');
    onTracksChanged();
  }

  /**
   * Tear the engine down completely (component unmount / switch to another
   * engine). After `destroy()` the engine is inert: no stale event or
   * in-flight load continuation can touch the video element. shaka owns
   * its instance lifecycle and destroys it asynchronously — the promise is
   * absorbed here so `destroy()` stays synchronous like the hls engine's.
   */
  destroy(): void {
    this.destroyed = true;
    this.generation += 1;
    this.destroyInstance();
    this.active = false;
  }

  /** Destroy only the active instance (used before a new attach). */
  private destroyInstance(): void {
    const player = this.instance;
    this.instance = null;
    if (!player) return;
    try {
      void Promise.resolve(player.destroy()).catch(() => {
        // destroy must never throw — internals may already be torn down
      });
    } catch {
      // must never throw
    }
  }

  /** Stop all recovery, destroy the instance and surface a generic error.
   *  Round 43: `detail` (when the failure came from a shaka error object)
   *  is forwarded so the caller can log the real code/message. */
  private fail(callbacks: ShakaVodEngineCallbacks, message: string, detail?: ShakaErrorLike & { message?: unknown }): void {
    this.destroyInstance();
    this.active = false;
    callbacks.onState?.('error');
    callbacks.onFatalError?.(message, detail);
  }
}
