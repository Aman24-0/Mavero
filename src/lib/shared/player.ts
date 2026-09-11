export type PlayerSourceType = 'direct' | 'embed' | 'unavailable' | 'error';
import type { SandboxPolicy, SandboxPolicyRuntime } from './sandbox-policy';

export type PlayerProtocol = 'hls' | 'dash' | 'mp4' | 'file' | 'unknown';

export type PlayerSubtitleTrack = {
  url: string;
  language?: string;
  label?: string;
};

export type PlayerQualityOption = {
  url: string;
  label?: string;
  height?: number;
  bitrate?: number;
  /**
   * Phase 6 (MAVERO Player): safe presentation metadata for one resolved
   * addon stream. `addonName` is the addon DISPLAY name (never a manifest
   * URL, database id or internal identifier) and `protocol` is the already
   * normalized playback protocol of THIS stream. Both are optional —
   * provider sources never populate them, and the source-sheet grouping
   * falls back gracefully when they are missing.
   */
  addonName?: string;
  protocol?: PlayerProtocol;
  /**
   * Phase 9 (MAVERO Player): rich ADDON-SUPPLIED stream metadata, preserved
   * verbatim from the addon response and displayed only when present. Every
   * field is untrusted plain text (rendered through Svelte's auto-escaping,
   * never raw-HTML rendered); Mavero NEVER fabricates a value for any of them —
   * a missing field stays absent so the UI can omit it entirely.
   */
  /** Addon-provided stream title (`stream.title`), when supplied. */
  title?: string;
  /** Addon-provided stream description (first line), when supplied. */
  description?: string;
  /** Audio languages detected in addon-supplied labels (e.g. ["Hindi"]). */
  audioLanguages?: string[];
  /** Container/format label derived from the addon filename/URL (e.g. "MKV"). */
  container?: string;
  /** Video codec label detected in addon-supplied text (e.g. "HEVC"). */
  codec?: string;
  /** Addon-provided filename (behaviorHints.filename), when supplied. */
  filename?: string;
  /** Addon-provided file size in bytes (behaviorHints.videoSize). */
  videoSize?: number;
  /** Addon-provided subtitle tracks (URLs already https-validated server-side). */
  subtitles?: PlayerSubtitleTrack[];
  /**
   * Phase 10 (GOAL 12): the SIGNED compatibility reference issued with this
   * stream when the classifier routes it to remux/transcode. Opaque to the
   * client — it authorizes exactly ONE worker-backed conversion of exactly
   * THIS stream. Streams without a reference never touch the compat path.
   */
  compatToken?: string;
  compatKind?: 'remux' | 'transcode';
};

/**
 * Phase 6: ONE internal quality option of the ACTIVE playback engine
 * (e.g. an hls.js ABR level). Engine-agnostic by design — the UI never
 * sees hls.js types (`Hls.Level`, `Hls.Events`, …). `id` is the stable
 * selection key handed back to the engine; `label` is pre-derived, safe
 * presentation text (height → "720p", bitrate fallback, else "Auto").
 */
export type PlayerInternalQualityOption = {
  id: string;
  label: string;
};

/**
 * Phase 6: generic quality-controller contract (spec §31). The active
 * playback engine exposes its internal quality selection through THIS
 * shape — currently implemented by PlayerViewport on top of the Phase 5
 * HLS engine. AUTO is the reserved id `PLAYER_AUTO_QUALITY_ID`.
 */
export type PlayerQualityController = {
  getOptions(): PlayerInternalQualityOption[];
  getSelected(): string | null;
  select(id: string): void;
};

/** Reserved selection id for automatic quality (HLS ABR) — spec §10/§34. */
export const PLAYER_AUTO_QUALITY_ID = 'auto';

export type PlayerSource = {
  type: PlayerSourceType;
  url: string | null;
  providerId: string;
  sourceId: string;
  mediaType: 'movie' | 'series' | 'anime';
  subtitles?: PlayerSubtitleTrack[];
  qualities?: PlayerQualityOption[];
  headers?: { referer?: string; origin?: string };
  sandboxPolicy?: SandboxPolicy;
  /**
   * Phase 11 (GOAL D): the FULL sandbox resolution provenance for embed
   * sources — configured (source-level, null = inherit) + provider-level +
   * EFFECTIVE policy. The playback runtime applies ONLY
   * `effectiveSandboxPolicy`; absent for direct/Stremio sources (no iframe).
   */
  sandboxRuntime?: SandboxPolicyRuntime;
  expiresAt?: string;
  metadata?: {
    title?: string;
    sourceName?: string;
    providerName?: string;
    protocol?: PlayerProtocol;
    note?: string;
    /**
     * Phase 7F (MegaPlay): the variants this source exposes at runtime
     * (e.g. ['sub','dub']). Populated by adapters that support
     * multiple audio tracks behind one source row.
     */
    variants?: string[];
    /**
     * Phase 7F (MegaPlay): the variant currently resolved into `url`
     * (e.g. 'sub' or 'dub'). Lets the source selector highlight the
     * active variant button without re-resolving.
     */
    selectedVariant?: string;
    /**
     * Phase 9 (MAVERO Player streams): rich ADDON-SUPPLIED metadata for ONE
     * resolved Stremio stream, carried by the Phase 3 per-stream adapter.
     * All fields are optional, untrusted plain text, and never invented —
     * the aggregate composer copies them into the stream's quality option
     * only when the addon actually supplied them.
     */
    streamDescription?: string;
    audioLanguages?: string[];
    streamContainer?: string;
    streamCodec?: string;
    filename?: string;
    videoSize?: number;
  };
  error?: {
    code: string;
    message: string;
    status?: number;
  };
};

export type PlayerSourceOption = {
  id: string;
  name: string;
  status?: string;
  integrationType?: string;
  sandboxPolicy?: SandboxPolicy;
  /**
   * Phase 7F (MegaPlay): optional playback variants exposed by a single
   * source. When present, the source selector renders inline variant
   * toggle buttons (e.g. SUB | DUB) inside this source option — both
   * variants belong to the SAME provider/source, just different audio
   * tracks. Switching variant does NOT switch providers; it asks the
   * resolver to re-resolve with a different `variant` field on the
   * request. Only providers that explicitly expose variants
   * (currently only MegaPlay) populate this field.
   */
  variants?: string[];
};

export type PlayerEpisode = {
  id: string;
  number: number;
  season: number;
  title: string;
  overview?: string;
  runtime?: string;
  still?: string;
};

export type PlayerEpisodeTarget = {
  season: number;
  episode: number;
  title?: string;
};

export type PlayerContentContext = {
  id: string;
  type: 'movie' | 'series' | 'anime';
  title: string;
  poster?: string;
  backdrop?: string;
};

export type PlayerProgressEvent = {
  currentTime: number;
  duration: number;
  completed: boolean;
  reason: 'progress' | 'pause' | 'source-change' | 'ended' | 'close' | 'visibility';
};

export type PlayerPlaybackState =
  | 'initial-loading'
  | 'resolving'
  | 'preparing'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'seeking'
  | 'switching-source'
  | 'completed'
  | 'error'
  | 'source-unavailable'
  | 'unsupported-format'
  | 'embed-loading'
  | 'embed-unavailable'
  | 'provider-error'
  | 'unsupported'
  | 'unavailable'
  | 'offline';

export const playbackSpeeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export function formatPlayerTime(value: number) {
  const safe = Math.max(0, Math.round(value || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}
