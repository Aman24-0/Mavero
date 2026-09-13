import type { PlayerProtocol, PlayerSource } from '$lib/shared/player';
import type { StremioResolvedStream } from './stream-resolver';

/**
 * MAVERO Stremio stream resolver — PlayerSource adapter (Phase 3).
 *
 * Pure mapping from a resolved Stremio stream into the EXISTING shared
 * `PlayerSource` model — no second competing source representation
 * (spec §18). Phase 3 ships the resolver output + this adapter ONLY:
 * nothing wires it into the player yet, and no PlayerShell /
 * PlayerViewport / PlaybackManager code is touched.
 *
 * Representation choices:
 *   * `type: 'direct'` — every accepted Stremio stream is a direct
 *     HTTP/HLS media URL (spec §18).
 *   * `providerId` = the `streaming_addons` row id — a real database uuid;
 *     no fake source ids are invented.
 *   * `sourceId` = a deterministic synthetic key `stremio:{slug}:{index}`.
 *     The existing player treats `sourceId` as an opaque selection key and
 *     Stremio addons have no `streaming_sources` row, so a stable synthetic
 *     key is the safest existing-compatible representation.
 *   * `headers` is intentionally NEVER populated: header-dependent streams
 *     are excluded upstream (spec §16), and Mavero does not proxy media.
 *   * `sandboxPolicy` is not set — Stremio direct streams are not embeds.
 *   * The URL is preserved verbatim (spec §13): no silent http→https
 *     rewrite; `metadata.protocol` + the transport note carry the
 *     HTTP/HTTPS distinction for later UI/player phases.
 */

export const STREMIO_SOURCE_ID_PREFIX = 'stremio';

/** Deterministic, collision-free synthetic source key for one addon stream. */
export function stremioSourceId(addonSlug: string, streamIndex: number): string {
  return `${STREMIO_SOURCE_ID_PREFIX}:${addonSlug}:${streamIndex}`;
}

export function stremioStreamToPlayerSource(stream: StremioResolvedStream): PlayerSource {
  const protocol: PlayerProtocol = stream.protocol;
  // Phase 9: addon-provided subtitle tracks flow through the EXISTING
  // `PlayerSource.subtitles` mechanism. URLs were shape-checked at
  // normalization; the playback boundary (https-only) applies below before
  // any track reaches the client — a non-https track is dropped silently.
  const subtitles = (stream.subtitles ?? [])
    .filter((track) => track.url.startsWith('https://'))
    .slice(0, 8)
    .map((track) => ({ url: track.url, ...(track.language ? { language: track.language } : {}), ...(track.label ? { label: track.label } : {}) }));
  return {
    type: 'direct',
    url: stream.url,
    providerId: stream.addonId,
    sourceId: stremioSourceId(stream.addonSlug, stream.streamIndex),
    mediaType: stream.mediaType,
    qualities: [
      {
        url: stream.url,
        label: stream.quality.label,
        ...(stream.quality.height !== undefined ? { height: stream.quality.height } : {}),
        ...(stream.quality.bitrate !== undefined ? { bitrate: stream.quality.bitrate } : {}),
      },
    ],
    ...(subtitles.length ? { subtitles } : {}),
    metadata: {
      title: stream.streamTitle ?? stream.streamName,
      sourceName: stream.addonName,
      providerName: stream.addonName,
      protocol,
      note: `Stremio HTTP addon (${stream.transport.toUpperCase()}) · ${stream.videoId}`,
      // Phase 9: rich addon-supplied metadata, preserved verbatim — the
      // aggregate composer copies these into the stream's quality option.
      ...(stream.description ? { streamDescription: stream.description } : {}),
      ...(stream.audioLanguages ? { audioLanguages: stream.audioLanguages } : {}),
      ...(stream.container ? { streamContainer: stream.container } : {}),
      ...(stream.codec ? { streamCodec: stream.codec } : {}),
      ...(stream.filename ? { filename: stream.filename } : {}),
      ...(stream.videoSize ? { videoSize: stream.videoSize } : {}),
    },
  };
}
