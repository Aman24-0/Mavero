import { normalizePlayerSource } from '$lib/shared/player-guards';
import { sandboxPolicyFromCapabilities } from '$lib/shared/sandbox-policy';
import type { PlayerSource, PlayerSourceOption } from '$lib/shared/player';
import type { PlaybackContext } from '$lib/client/progress/types';

export type TVPlaybackMediaType = 'movie' | 'series' | 'anime';

type CapabilityBag = Record<string, unknown> | null | undefined;

type StreamingConfigResponse = {
  ok?: boolean;
  config?: {
    providers?: Array<{ id: string; name: string; capabilities?: CapabilityBag }>;
    sources?: Array<{ id: string; provider_id: string; name: string; status?: string; visibility?: string; integration_type?: string | null; capabilities?: CapabilityBag }>;
  };
  error?: { message?: string };
};

type ResolverResponse = {
  ok?: boolean;
  source?: unknown;
  error?: { code?: string; message?: string };
};

export class TVPlaybackError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'TVPlaybackError';
    this.code = code;
  }
}

function capabilityAllows(capabilities: CapabilityBag, mediaType: TVPlaybackMediaType) {
  return capabilities?.[mediaType] !== false;
}

export async function loadTVSourceOptions(mediaType: TVPlaybackMediaType, signal?: AbortSignal): Promise<PlayerSourceOption[]> {
  const response = await fetch('/api/streaming/config', { signal, headers: { accept: 'application/json' } });
  let payload: StreamingConfigResponse = {};
  try {
    payload = await response.json() as StreamingConfigResponse;
  } catch {
    throw new TVPlaybackError('Streaming configuration could not be read.');
  }
  if (!response.ok || !payload.ok || !payload.config) {
    throw new TVPlaybackError(payload.error?.message ?? 'Streaming configuration is temporarily unavailable.');
  }

  const providers = new Map((payload.config.providers ?? []).map((provider) => [provider.id, provider]));
  return (payload.config.sources ?? []).flatMap((source) => {
    const provider = providers.get(source.provider_id);
    if (!provider || source.visibility !== 'public' || source.status === 'disabled' || source.status === 'unavailable') return [];
    if (!capabilityAllows(provider.capabilities, mediaType) || !capabilityAllows(source.capabilities, mediaType)) return [];
    const capabilities = source.capabilities ?? {};
    return [{
      id: source.id,
      name: `${source.name} · ${provider.name}`,
      status: source.status,
      integrationType: source.integration_type ?? undefined,
      sandboxPolicy: sandboxPolicyFromCapabilities(provider.capabilities, capabilities)
    }];
  });
}

export async function resolveTVSource(context: PlaybackContext, sourceId: string, allowFallback = true, signal?: AbortSignal): Promise<PlayerSource> {
  const response = await fetch('/api/playback/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sourceId,
      contentId: context.contentId,
      mediaType: context.contentType,
      season: context.season,
      episode: context.episode,
      enableFallback: allowFallback
    }),
    signal
  });

  let payload: ResolverResponse = {};
  try {
    payload = await response.json() as ResolverResponse;
  } catch {
    throw new TVPlaybackError('The playback resolver returned an invalid response.');
  }

  const safeSource = normalizePlayerSource(payload.source);
  if (!response.ok || !payload.ok || !safeSource) {
    throw new TVPlaybackError(payload.error?.message ?? 'This source is currently unavailable.', payload.error?.code);
  }
  return safeSource;
}
