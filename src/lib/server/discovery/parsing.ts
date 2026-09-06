import type { DiscoveryCandidateType, DiscoveryQuality, MediaCandidate } from './types';
import type { SubtitleSource } from '$lib/server/resolver/types';

const TRACKING_PARAMS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']);

export function absolutePublicUrl(raw: string, baseUrl: string): string | null {
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function candidateTypeForMime(value: string | undefined): DiscoveryCandidateType | undefined {
  const normalized = value?.toLowerCase() ?? '';
  if (normalized.includes('mpegurl') || normalized.includes('m3u8')) return 'hls';
  if (normalized.includes('dash') || normalized.includes('mpd')) return 'dash';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('webm')) return 'webm';
  return undefined;
}

export function candidateTypeForUrl(raw: string): DiscoveryCandidateType {
  try {
    const url = new URL(raw);
    const value = `${url.pathname}${url.search}`.toLowerCase();
    if (value.includes('.m3u8')) return 'hls';
    if (value.includes('.mpd')) return 'dash';
    if (/\.(mp4|m4v)(?:$|[?#])/.test(value)) return 'mp4';
    if (/\.webm(?:$|[?#])/.test(value)) return 'webm';
    return 'media';
  } catch {
    return 'media';
  }
}

export function isDirectMediaType(type: DiscoveryCandidateType): boolean {
  return type === 'hls' || type === 'dash' || type === 'mp4' || type === 'webm' || type === 'media';
}

export function qualityFromText(value: string): DiscoveryQuality | undefined {
  const normalized = value.toLowerCase();
  const match = normalized.match(/(?:^|[^0-9])(2160|1440|1080|720|480|360)\s*p?(?:[^0-9]|$)/);
  if (match) return Number(match[1]) as DiscoveryQuality;
  if (/(?:^|[^a-z])4k(?:[^a-z]|$)/.test(normalized)) return 2160;
  return undefined;
}

export function normalizeLanguage(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/[\s_]+/g, '-');
  return normalized ? normalized.slice(0, 24) : undefined;
}

export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw.trim();
  }
}

export function subtitleFromAttributes(attributes: Record<string, string>): SubtitleSource | null {
  const rawUrl = attributes.src ?? attributes.href;
  if (!rawUrl) return null;
  return {
    url: rawUrl,
    language: normalizeLanguage(attributes.srclang ?? attributes['data-language'] ?? attributes.lang),
    label: attributes.label ?? attributes['data-label'],
  };
}

export function deduplicateCandidates(candidates: MediaCandidate[]): MediaCandidate[] {
  const byUrl = new Map<string, MediaCandidate>();
  for (const candidate of candidates) {
    const key = canonicalUrl(candidate.url);
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, { ...candidate, url: key });
      continue;
    }
    const preferred = candidate.confidence > existing.confidence ? candidate : existing;
    const subtitles = [...(existing.subtitles ?? []), ...(candidate.subtitles ?? [])];
    byUrl.set(key, {
      ...preferred,
      url: key,
      quality: preferred.quality ?? existing.quality ?? candidate.quality,
      language: preferred.language ?? existing.language ?? candidate.language,
      audioLanguage: preferred.audioLanguage ?? existing.audioLanguage ?? candidate.audioLanguage,
      subtitles: subtitles.length ? [...new Map(subtitles.map((item) => [canonicalUrl(item.url), item])).values()] : undefined,
      metadata: { ...existing.metadata, ...candidate.metadata },
    });
  }
  return [...byUrl.values()].sort((left, right) => right.confidence - left.confidence || left.url.localeCompare(right.url));
}
