import { createHash } from 'node:crypto';
import { validatePlaybackUrl, protocolForUrl } from '$lib/server/resolver/safe-url';
import { DiscoveryError } from './errors';
import { canonicalUrl, deduplicateCandidates, qualityFromText } from './parsing';
import type { DiscoveryQuality, MediaCandidate, NormalizedStreamResult } from './types';

function qualityForCandidate(candidate: MediaCandidate): DiscoveryQuality {
  return candidate.quality ?? qualityFromText(`${candidate.url} ${JSON.stringify(candidate.metadata ?? {})}`) ?? 'unknown';
}

function streamId(candidate: MediaCandidate): string {
  return createHash('sha256').update(`${canonicalUrl(candidate.url)}|${candidate.discoveryMethod}`).digest('hex').slice(0, 20);
}

function safeSubtitleTracks(candidate: MediaCandidate): NonNullable<NormalizedStreamResult['subtitles']> {
  const tracks: NonNullable<NormalizedStreamResult['subtitles']> = [];
  for (const track of candidate.subtitles ?? []) {
    try {
      const url = validatePlaybackUrl(track.url, 'direct');
      if (!tracks.some((existing) => canonicalUrl(existing.url) === canonicalUrl(url))) tracks.push({ ...track, url });
    } catch {
      // A malformed subtitle must not invalidate an otherwise valid stream.
    }
  }
  return tracks;
}

export function normalizeCandidate(candidate: MediaCandidate): NormalizedStreamResult {
  const isEmbed = candidate.type === 'embed';
  const url = validatePlaybackUrl(candidate.url, isEmbed ? 'embed' : 'direct', isEmbed ? [new URL(candidate.url).origin] : []);
  const protocol = isEmbed
    ? 'unknown'
    : candidate.type === 'hls'
      ? 'hls'
      : candidate.type === 'dash'
        ? 'dash'
        : candidate.type === 'mp4'
          ? 'mp4'
          : candidate.type === 'webm'
            ? 'file'
          : protocolForUrl(url);
  if (!isEmbed && protocol === 'unknown') throw new DiscoveryError('UNSUPPORTED_FORMAT');
  return {
    id: streamId(candidate),
    type: isEmbed ? 'embed' : 'direct',
    url,
    protocol,
    sourceUrl: candidate.originUrl,
    resolverId: candidate.resolverId,
    discoveryMethod: candidate.discoveryMethod,
    confidence: Math.max(0, Math.min(1, candidate.confidence)),
    quality: qualityForCandidate(candidate),
    language: candidate.language,
    audioLanguage: candidate.audioLanguage,
    subtitles: safeSubtitleTracks(candidate),
    audioTracks: candidate.audioTracks ?? [],
    headers: candidate.headers,
    metadata: candidate.metadata,
  };
}

export function normalizeCandidates(candidates: MediaCandidate[]): NormalizedStreamResult[] {
  const normalized: NormalizedStreamResult[] = [];
  for (const candidate of deduplicateCandidates(candidates)) {
    try {
      const result = normalizeCandidate(candidate);
      if (!normalized.some((existing) => existing.id === result.id || canonicalUrl(existing.url) === canonicalUrl(result.url))) normalized.push(result);
    } catch {
      // Candidate-level validation errors are isolated; other candidates remain usable.
    }
  }
  return normalized.sort((left, right) => right.confidence - left.confidence || left.url.localeCompare(right.url));
}
