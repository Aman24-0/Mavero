export type PlayerSourceType = 'direct' | 'embed' | 'unavailable' | 'error';
import type { SandboxPolicy } from './sandbox-policy';

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
};

export type PlayerAudioTrack = {
  id: string;
  language?: string;
  label?: string;
  default?: boolean;
};

export type PlayerSource = {
  type: PlayerSourceType;
  url: string | null;
  providerId: string;
  sourceId: string;
  mediaType: 'movie' | 'series' | 'anime';
  subtitles?: PlayerSubtitleTrack[];
  qualities?: PlayerQualityOption[];
  audioTracks?: PlayerAudioTrack[];
  headers?: { referer?: string; origin?: string };
  sandboxPolicy?: SandboxPolicy;
  expiresAt?: string;
  metadata?: {
    title?: string;
    sourceName?: string;
    providerName?: string;
    protocol?: PlayerProtocol;
    note?: string;
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
