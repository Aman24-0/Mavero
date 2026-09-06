import type { PlaybackProtocol, ResolverMediaType, SafePlaybackHeaders, SubtitleSource } from '$lib/server/resolver/types';

export type DiscoveryMethod =
  | 'html-media'
  | 'media-source'
  | 'manifest-url'
  | 'direct-media-url'
  | 'embed-url'
  | 'runtime-metadata'
  | 'public-api';

export type DiscoveryCandidateType = 'hls' | 'dash' | 'mp4' | 'webm' | 'media' | 'embed';

export type DiscoveryQuality = 2160 | 1440 | 1080 | 720 | 480 | 360 | 'unknown';

export type MediaCandidate = {
  url: string;
  type: DiscoveryCandidateType;
  originUrl: string;
  discoveryMethod: DiscoveryMethod;
  resolverId: string;
  confidence: number;
  quality?: DiscoveryQuality;
  language?: string;
  audioLanguage?: string;
  subtitles?: SubtitleSource[];
  headers?: SafePlaybackHeaders;
  metadata?: Record<string, string | number | boolean | null>;
};

export type NormalizedStreamResult = {
  id: string;
  type: 'direct' | 'embed';
  url: string;
  protocol: PlaybackProtocol;
  sourceUrl: string;
  resolverId: string;
  discoveryMethod: DiscoveryMethod;
  confidence: number;
  quality: DiscoveryQuality;
  language?: string;
  audioLanguage?: string;
  subtitles: SubtitleSource[];
  headers?: SafePlaybackHeaders;
  metadata?: Record<string, string | number | boolean | null>;
};

export type DiscoveryErrorCode =
  | 'SOURCE_NOT_FOUND'
  | 'DISCOVERY_FAILED'
  | 'RESOLUTION_FAILED'
  | 'TIMEOUT'
  | 'INVALID_MEDIA'
  | 'UNSUPPORTED_FORMAT'
  | 'BLOCKED_SOURCE'
  | 'CANCELLED';

export type DiscoveryDiagnostic = {
  resolverId: string;
  stage: 'discovery' | 'resolution' | 'validation';
  durationMs: number;
  candidateCount: number;
  resultCount: number;
  errorCode?: DiscoveryErrorCode;
};

export type DiscoveryDiagnostics = {
  pageUrl: string;
  methodsAttempted: DiscoveryMethod[];
  candidatesFound: number;
  resolversAttempted: string[];
  successfulResults: number;
  failures: DiscoveryDiagnostic[];
  durationMs: number;
  finalStreamCount: number;
};

export type DiscoveryRequest = {
  pageUrl: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type DiscoveryPage = {
  url: string;
  html: string;
  contentType: string;
  status: number;
};

export type UniversalResolverContext = {
  page: DiscoveryPage;
  candidates: MediaCandidate[];
  signal: AbortSignal;
};

export type DiscoveryResolver = {
  id: string;
  name: string;
  priority: number;
  timeoutMs: number;
  enabled?: boolean;
  supportedMediaTypes?: ResolverMediaType[];
  urlPatterns?: string[];
  supports: (candidate: MediaCandidate, context: UniversalResolverContext) => boolean;
  resolve: (candidate: MediaCandidate, context: UniversalResolverContext) => Promise<NormalizedStreamResult | null>;
};

export type DiscoveryDetector = {
  id: string;
  method: DiscoveryMethod;
  enabled?: boolean;
  detect: (page: DiscoveryPage) => MediaCandidate[];
};

export type DiscoveryRegistry = {
  detectors: DiscoveryDetector[];
  resolvers: DiscoveryResolver[];
};

export type DiscoveryResult = {
  streams: NormalizedStreamResult[];
  diagnostics: DiscoveryDiagnostics;
};

export type PlayerCompatibleDiscoverySource = {
  type: 'direct' | 'embed';
  url: string;
  providerId: string;
  sourceId: string;
  mediaType: ResolverMediaType;
  subtitles?: SubtitleSource[];
  headers?: SafePlaybackHeaders;
  metadata?: {
    sourceName?: string;
    providerName?: string;
    protocol?: PlaybackProtocol;
    note?: string;
  };
};
