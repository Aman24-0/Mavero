import type { ContentType, NormalizedMediaItem } from '$lib/server/content/types';
import type { IntegrationType, StreamingProviderRow, StreamingSourceRow } from '$lib/server/streaming/types';

export type ResolverMediaType = ContentType;
export type ResolverResultType = 'direct' | 'embed' | 'unavailable' | 'error';
export type PlaybackProtocol = 'hls' | 'dash' | 'mp4' | 'file' | 'unknown';

export type ResolverRequest = {
  sourceId: string;
  contentId: string;
  mediaType: ResolverMediaType;
  season?: number;
  episode?: number;
};

export type ContentIdentifiers = {
  internalId: string;
  tmdbId?: string;
  imdbId?: string;
  anilistId?: string;
  malId?: string;
  slug: string;
};

export type SafePlaybackHeaders = {
  referer?: string;
  origin?: string;
};

export type SubtitleSource = {
  url: string;
  language?: string;
  label?: string;
};

export type QualitySource = {
  url: string;
  label?: string;
  height?: number;
  bitrate?: number;
};

export type SafeSourceMetadata = {
  title?: string;
  sourceName?: string;
  providerName?: string;
  protocol?: PlaybackProtocol;
  note?: string;
};

export type ResolverErrorCode =
  | 'INVALID_REQUEST'
  | 'SOURCE_NOT_FOUND'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_DISABLED'
  | 'SOURCE_DISABLED'
  | 'SOURCE_MAINTENANCE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'MISSING_IDENTIFIER'
  | 'INVALID_TEMPLATE'
  | 'INVALID_SOURCE_URL'
  | 'INVALID_PROVIDER_ENDPOINT'
  | 'PROVIDER_RESPONSE_INVALID'
  | 'SOURCE_EXPIRED'
  | 'RESOLUTION_UNAVAILABLE'
  | 'INTERNAL_RESOLUTION_ERROR';

export type ResolverErrorShape = {
  code: ResolverErrorCode;
  message: string;
  status: number;
};

export type SourceResult = {
  type: ResolverResultType;
  url: string | null;
  providerId: string;
  sourceId: string;
  mediaType: ResolverMediaType;
  subtitles?: SubtitleSource[];
  qualities?: QualitySource[];
  headers?: SafePlaybackHeaders;
  expiresAt?: string;
  metadata?: SafeSourceMetadata;
  error?: ResolverErrorShape;
};

export type TrustedResolutionConfig = {
  provider: Pick<StreamingProviderRow, 'id' | 'name' | 'status' | 'enabled' | 'integration_type' | 'adapter_id' | 'capabilities'>;
  source: Pick<StreamingSourceRow, 'id' | 'provider_id' | 'name' | 'status' | 'enabled' | 'visibility' | 'integration_type' | 'capabilities' | 'movie_template' | 'series_template' | 'anime_template' | 'identifier_mode' | 'audio_languages' | 'subtitle_capability' | 'quality_capability'>;
};

export type ResolverContext = {
  request: ResolverRequest;
  content: NormalizedMediaItem;
  identifiers: ContentIdentifiers;
  config: TrustedResolutionConfig;
};

export type AdapterResult = {
  type: Exclude<ResolverResultType, 'error' | 'unavailable'>;
  url: string;
  protocol?: PlaybackProtocol;
  headers?: SafePlaybackHeaders;
  subtitles?: SubtitleSource[];
  qualities?: QualitySource[];
  expiresAt?: string;
  metadata?: SafeSourceMetadata;
};

export interface ProviderAdapter {
  readonly integrationType: IntegrationType;
  readonly adapterId?: string;
  resolve(context: ResolverContext): Promise<AdapterResult | null>;
}

export type ResolverDependencies = {
  loadContent?: (request: ResolverRequest) => Promise<NormalizedMediaItem>;
  loadConfig?: (request: ResolverRequest) => Promise<TrustedResolutionConfig>;
  adapters?: Partial<Record<IntegrationType, ProviderAdapter>>;
  adaptersById?: Record<string, ProviderAdapter>;
};
