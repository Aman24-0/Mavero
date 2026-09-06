import type { ContentType, NormalizedMediaItem } from '$lib/server/content/types';
import type { SandboxPolicy } from '$lib/shared/sandbox-policy';
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
  allowFallback?: boolean;
  /**
   * Phase 2: admin-configured per-content-type default source id. When
   * `allowFallback !== false` and this is provided AND the default source
   * appears in the fallback candidate list, the resolver sorts it to the
   * front of the candidate order so it is attempted first. The default
   * is NOT given an artificial health-score boost — it just wins the
   * `sourceOrder ASC` tiebreaker within its score bucket in the existing
   * `rankProviderSourceList` sort. If the default is ineligible (disabled,
   * in cooldown, unsupported media type, etc.), the existing ranking gates
   * exclude it and the resolver proceeds with the remaining candidates.
   */
  defaultSourceId?: string;
  /**
   * Phase 7F (MegaPlay): optional playback variant requested by the user.
   * Currently only consumed by the MegaPlay anime adapter to switch
   * between SUB and DUB audio. Adapters that do not support variants
   * ignore this field. The value is provider-specific (e.g. 'sub' or
   * 'dub' for MegaPlay).
   */
  variant?: string;
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
  /**
   * Phase 7F (MegaPlay): variants exposed by this source at runtime
   * (e.g. ['sub','dub']). Forwarded into PlayerSource.metadata.variants
   * so the source selector can render inline variant toggles.
   */
  variants?: string[];
  /**
   * Phase 7F (MegaPlay): the variant currently encoded in `url`
   * (e.g. 'sub' or 'dub'). Forwarded into PlayerSource.metadata.selectedVariant.
   */
  selectedVariant?: string;
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
  sandboxPolicy?: SandboxPolicy;
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
  sandboxPolicy?: SandboxPolicy;
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
  /**
   * Phase 7: when `true`, the resolver MUST NOT mutate
   * `streaming_provider_health` (the `recordRuntimeSuccess` /
   * `recordRuntimeFailure` callbacks become no-ops). Default is `false` —
   * production behavior (the anonymous /api/playback/resolve endpoint) is
   * unchanged. Used by the admin source-test endpoint to test a source
   * without polluting production health state.
   */
  skipHealthMutation?: boolean;
};
