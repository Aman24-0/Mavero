import { absolutePublicUrl, candidateTypeForMime, candidateTypeForUrl, isDirectMediaType, normalizeLanguage, qualityFromText, subtitleFromAttributes } from './parsing';
import type { DiscoveryDetector, MediaCandidate, DiscoveryPage } from './types';

function attributesFromTag(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.matchAll(pattern)) {
    const key = match[1]?.toLowerCase();
    if (!key || key === 'video' || key === 'audio' || key === 'source' || key === 'track' || key === 'iframe' || key === 'script') continue;
    attributes[key] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function candidateFromUrl(rawUrl: string, page: DiscoveryPage, resolverId: string, discoveryMethod: MediaCandidate['discoveryMethod'], context = ''): MediaCandidate | null {
  const url = absolutePublicUrl(rawUrl, page.url);
  if (!url) return null;
  const type = candidateTypeForUrl(url);
  return {
    url,
    type: discoveryMethod === 'embed-url' ? 'embed' : type,
    originUrl: page.url,
    discoveryMethod,
    resolverId,
    confidence: discoveryMethod === 'direct-media-url' || discoveryMethod === 'manifest-url' ? 0.86 : 0.72,
    quality: qualityFromText(`${url} ${context}`),
    language: normalizeLanguage(context.match(/(?:lang|language)[=:"'\s]+([a-z]{2,3}(?:[-_][a-z]{2,4})?)/i)?.[1]),
    metadata: context ? { context: context.slice(0, 300) } : undefined,
  };
}

function directMediaCandidates(page: DiscoveryPage): MediaCandidate[] {
  const candidates: MediaCandidate[] = [];
  const decodedHtml = page.html.replaceAll('\\/', '/').replaceAll('&amp;', '&');
  const urlPattern = /https?:[^\s"'<>\\]+/gi;
  for (const match of decodedHtml.matchAll(urlPattern)) {
    const raw = match[0].replace(/[),.;]+$/, '');
    const type = candidateTypeForUrl(raw);
    if (!['hls', 'dash', 'mp4', 'webm'].includes(type) || !isDirectMediaType(type)) continue;
    const candidate = candidateFromUrl(raw, page, 'generic-manifest', type === 'hls' || type === 'dash' ? 'manifest-url' : 'direct-media-url', match[0]);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function mediaElementCandidates(page: DiscoveryPage): MediaCandidate[] {
  const candidates: MediaCandidate[] = [];
  const mediaTags = page.html.match(/<(?:video|audio|source)\b[^>]*>/gi) ?? [];
  const mediaBlocks = page.html.match(/<(?:video|audio)\b[^>]*>[\s\S]*?<\/(?:video|audio)>/gi) ?? [];
  for (const tag of [...mediaTags, ...mediaBlocks]) {
    const openingTag = tag.slice(0, tag.indexOf('>') + 1);
    const attributes = attributesFromTag(openingTag);
    const rawUrl = attributes.src ?? attributes['data-src'] ?? attributes['data-url'] ?? attributes['data-file'];
    if (!rawUrl) continue;
    const context = `${attributes.title ?? ''} ${attributes.label ?? ''} ${attributes['data-quality'] ?? ''} ${attributes['data-language'] ?? ''}`;
    const candidate = candidateFromUrl(rawUrl, page, 'generic-html-media', 'html-media', context);
    if (!candidate) continue;
    candidate.type = candidateTypeForMime(attributes.type) ?? candidate.type;
    candidate.confidence = 0.94;
    candidate.quality = qualityFromText(`${context} ${rawUrl}`);
    candidate.language = normalizeLanguage(attributes.srclang ?? attributes['data-language'] ?? attributes.lang);
    candidates.push(candidate);
  }
  for (const tag of page.html.match(/<track\b[^>]*>/gi) ?? []) {
    const attributes = attributesFromTag(tag);
    const subtitle = subtitleFromAttributes(attributes);
    if (!subtitle) continue;
    const url = absolutePublicUrl(subtitle.url, page.url);
    if (!url) continue;
    for (const candidate of candidates) candidate.subtitles = [...(candidate.subtitles ?? []), { ...subtitle, url }];
  }
  return candidates;
}

function embedCandidates(page: DiscoveryPage): MediaCandidate[] {
  const candidates: MediaCandidate[] = [];
  for (const tag of page.html.match(/<iframe\b[^>]*>/gi) ?? []) {
    const attributes = attributesFromTag(tag);
    const rawUrl = attributes.src ?? attributes['data-src'] ?? attributes['data-embed'];
    if (!rawUrl) continue;
    const candidate = candidateFromUrl(rawUrl, page, 'generic-embed', 'embed-url', attributes.title ?? 'iframe embed');
    if (candidate) candidates.push(candidate);
  }
  const embedPattern = /(?:"|')?(?:embed(?:_url)?|player(?:_url)?|watch(?:_url)?)(?:"|')?\s*:\s*(?:"|')([^"']+)(?:"|')/gi;
  for (const match of page.html.replaceAll('\\/', '/').matchAll(embedPattern)) {
    const candidate = candidateFromUrl(match[1], page, 'generic-runtime-embed', 'runtime-metadata', 'public runtime embed reference');
    if (candidate) {
      candidate.type = 'embed';
      candidates.push(candidate);
    }
  }
  return candidates;
}

function publicApiReferenceCandidates(page: DiscoveryPage): MediaCandidate[] {
  const candidates: MediaCandidate[] = [];
  const apiPattern = /(?:api|manifest|source|media)(?:[_-]?(?:url|src|file|endpoint))?\s*[:=]\s*(?:"|')([^"']+)(?:"|')/gi;
  for (const match of page.html.replaceAll('\\/', '/').matchAll(apiPattern)) {
    const candidate = candidateFromUrl(match[1], page, 'generic-public-api-reference', 'public-api', match[0]);
    if (candidate && ['hls', 'dash', 'mp4', 'webm'].includes(candidate.type)) candidates.push(candidate);
  }
  return candidates;
}

function runtimeMetadataCandidates(page: DiscoveryPage): MediaCandidate[] {
  const candidates: MediaCandidate[] = [];
  const attributePattern = /\b(?:data-(?:video|media|stream|source)(?:-url)?|(?:video|media|stream|source)(?:Url|URL))\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/g;
  for (const match of page.html.matchAll(attributePattern)) {
    const raw = match[1] ?? match[2] ?? match[3];
    if (!raw) continue;
    const candidate = candidateFromUrl(raw, page, 'generic-runtime-metadata', 'runtime-metadata', match[0]);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export const genericDiscoveryDetectors: DiscoveryDetector[] = [
  { id: 'generic-html-media', method: 'html-media', detect: mediaElementCandidates },
  { id: 'generic-manifest', method: 'manifest-url', detect: directMediaCandidates },
  { id: 'generic-embed', method: 'embed-url', detect: embedCandidates },
  { id: 'generic-public-api-reference', method: 'public-api', detect: publicApiReferenceCandidates },
  { id: 'generic-runtime-metadata', method: 'runtime-metadata', detect: runtimeMetadataCandidates },
];
