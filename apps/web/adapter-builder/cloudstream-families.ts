/**
 * MAVERO Adapter Builder — CloudStream FAMILY knowledge base (plan §7).
 *
 * CloudStream `.cs3` packages are Android/JVM plugin bundles: the Builder
 * NEVER fetches or executes them. Convertibility instead comes from the
 * source-verified FAMILY structures — the exact site structures the CS-2
 * native ports (Bollyflix/MoviesDrive/VegaMovies) verified against the real
 * providers. A CloudStream row whose internal_name matches a family keyword
 * AND is not already natively bound can be converted into a declarative DSL
 * adapter generated from the family template. Everything else is honestly
 * REQUIRES_RUNTIME — the .cs3 cannot be analyzed server-side.
 *
 * NATIVE PRECEDENCE (plan §16): natively-bound rows never enter the Builder;
 * generated adapters never override healthy native bindings (the Mavero-side
 * orchestration enforces this before calling the Builder at all).
 *
 * Every family template is validated by the Builder-side LIVE TEST through
 * the shared DSL interpreter — a template is only persisted as an artifact
 * when the representative movie/tv cases actually resolve. A template that
 * does not fit a specific clone site fails the test honestly (the row stays
 * failed with a closed reason, never a fake adapter).
 */

import type { DeclarativeAdapterSpec } from '$lib/shared/adapter-artifact';

/** The shared dynamic-domains document the native ports verified. */
export const SHARED_DYNAMIC_URLS_DOCUMENT =
  'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';

/** One source-verified provider family. */
export type CloudStreamFamily = {
  /** Registry keyword (lowercase; matched by containment in internal_name). */
  key: 'bollyflix' | 'moviesdrive' | 'vegamovies';
  /** Human label for analysis notes. */
  label: string;
  /** urls.json key the family's current domain rotates under. */
  dynamicKey: string;
  /** Baked-in fallback base (used when the domains document fails). */
  fallbackUrl: string;
  /** Primary content language of the family's sites. */
  language: string;
  /** Emits the family's DSL spec specialized for one provider. */
  buildSpec(providerName: string): DeclarativeAdapterSpec;
};

/** Standard bounded fan-out the native ports use. */
const STANDARD_LIMITS = { maxCandidates: 20, maxLinks: 24 };

/** match.strategy is fixed vocabulary in schema v1. */
const STANDARD_MATCH = { strategy: 'rank-title-year' as const, maxCandidates: STANDARD_LIMITS.maxCandidates };

const STANDARD_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

/** Movie/episode resolution shared by the JSON-search families. */
const HOST_LINK_RESOLUTION = [
  { kind: 'extractor' as const },
  { kind: 'passthrough' as const, includes: ['.mp4', '.mkv', '.m3u8', '.torrent'] },
];

/** h5-sibling episode walk shared by the moviesdrive structure family. */
const H5_EPISODE_WALK = {
  container: 'h5, span',
  seasonPattern: 'Season\\s*0?{season}\\b',
  episodePattern: 'Ep(?:isode)?\\s*0?{episode}\\b',
  linkAttr: 'href',
};

const FAMILIES: readonly CloudStreamFamily[] = [
  {
    key: 'moviesdrive',
    label: 'MoviesDrive family (search.php JSON + h5 button walk)',
    dynamicKey: 'moviesdrive',
    fallbackUrl: 'https://new5.moviesdrive.christmas',
    language: 'hi',
    buildSpec(providerName: string): DeclarativeAdapterSpec {
      return {
        baseUrl: {
          kind: 'dynamic',
          fallbackUrl: this.fallbackUrl,
          domainsUrl: SHARED_DYNAMIC_URLS_DOCUMENT,
          key: this.dynamicKey,
        },
        headers: { ...STANDARD_HEADERS },
        search: {
          // The family's search.php JSON API (verified in the native port).
          urlTemplate: '{base}/search.php?q={query}&page=1',
          extraction: {
            kind: 'json',
            listPath: 'hits',
            titlePath: 'document.post_title',
            hrefPath: 'document.permalink',
          },
        },
        match: STANDARD_MATCH,
        movie: {
          // h5 anchors that already carry host links go straight through
          // the extractor registry (hubcloud/gdflix/gdlink ports).
          links: { container: 'h5 a', hrefAttr: 'href', includes: ['hubcloud', 'gdflix', 'gdlink'] },
          resolution: HOST_LINK_RESOLUTION,
        },
        episode: {
          ...H5_EPISODE_WALK,
          links: { container: 'h5 a', hrefAttr: 'href', includes: ['hubcloud', 'gdflix', 'gdlink'] },
          resolution: HOST_LINK_RESOLUTION,
        },
        output: { sourceName: providerName },
        limits: STANDARD_LIMITS,
      };
    },
  },
  {
    key: 'bollyflix',
    label: 'Bollyflix family (HTML card search + quality-button walk)',
    dynamicKey: 'bollyflix',
    fallbackUrl: 'https://new.bollyflix.vote',
    language: 'hi',
    buildSpec(providerName: string): DeclarativeAdapterSpec {
      return {
        baseUrl: {
          kind: 'dynamic',
          fallbackUrl: this.fallbackUrl,
          domainsUrl: SHARED_DYNAMIC_URLS_DOCUMENT,
          key: this.dynamicKey,
        },
        headers: { ...STANDARD_HEADERS },
        search: {
          // The family's HTML card search (verified in the native port).
          urlTemplate: '{base}/search/{query}/page/1/',
          extraction: {
            kind: 'html',
            container: 'div.post-cards > article',
            titleAttr: 'title',
            anchorSelector: 'a',
          },
        },
        match: STANDARD_MATCH,
        movie: {
          // Quality buttons; direct host URLs on the target page are
          // regex-extracted, anything already direct passes through, and
          // known extractor hosts dispatch through the registry.
          links: { container: 'a:has(button.dwd-button)', hrefAttr: 'href', includes: [] },
          resolution: [
            { kind: 'regex-extract', pattern: 'https?:\\/\\/[a-z0-9.-]*(?:hubcloud|gdflix|gdlink|fastdlserver)[a-z0-9\\/-]*', group: 1 },
            { kind: 'extractor' },
            { kind: 'passthrough', includes: ['.mp4', '.mkv', '.m3u8'] },
          ],
        },
        episode: {
          container: 'h3, h5',
          seasonPattern: '(?:Season|S)\\s*0?{season}\\b',
          episodePattern: 'Ep(?:isode)?\\s*0?{episode}\\b',
          linkAttr: 'href',
          links: { container: 'a:has(button.dwd-button)', hrefAttr: 'href', includes: [] },
          resolution: [
            { kind: 'regex-extract', pattern: 'https?:\\/\\/[a-z0-9.-]*(?:hubcloud|gdflix|gdlink|fastdlserver)[a-z0-9\\/-]*', group: 1 },
            { kind: 'extractor' },
          ],
        },
        output: { sourceName: providerName },
        limits: STANDARD_LIMITS,
      };
    },
  },
  {
    key: 'vegamovies',
    label: 'VegaMovies family (search.php JSON + quality-tag walk)',
    dynamicKey: 'vegamovies',
    fallbackUrl: 'https://vegamovies.gallery',
    language: 'hi',
    buildSpec(providerName: string): DeclarativeAdapterSpec {
      return {
        baseUrl: {
          kind: 'dynamic',
          fallbackUrl: this.fallbackUrl,
          domainsUrl: SHARED_DYNAMIC_URLS_DOCUMENT,
          key: this.dynamicKey,
        },
        headers: { ...STANDARD_HEADERS },
        search: {
          // The family's search.php JSON API (verified in the native port).
          urlTemplate: '{base}/search.php?q={query}&page=1',
          extraction: {
            kind: 'json',
            listPath: 'hits',
            titlePath: 'document.post_title',
            hrefPath: 'document.permalink',
          },
        },
        match: STANDARD_MATCH,
        movie: {
          links: { container: 'a:has(button.dwd-button)', hrefAttr: 'href', includes: [] },
          resolution: [
            { kind: 'regex-extract', pattern: 'https?:\\/\\/[a-z0-9.-]*(?:hubcloud|gdflix|gdlink|fastdlserver|vcloud)[a-z0-9\\/-]*', group: 1 },
            { kind: 'extractor' },
            { kind: 'passthrough', includes: ['.mp4', '.mkv', '.m3u8'] },
          ],
        },
        episode: {
          container: 'h3, h5',
          seasonPattern: '(?:Season|S)\\s*0?{season}\\b',
          episodePattern: 'Ep(?:isode)?\\s*0?{episode}\\b',
          linkAttr: 'href',
          links: { container: 'a:has(button.dwd-button)', hrefAttr: 'href', includes: [] },
          resolution: [
            { kind: 'regex-extract', pattern: 'https?:\\/\\/[a-z0-9.-]*(?:hubcloud|gdflix|gdlink|fastdlserver|vcloud)[a-z0-9\\/-]*', group: 1 },
            { kind: 'extractor' },
          ],
        },
        output: { sourceName: providerName },
        limits: STANDARD_LIMITS,
      };
    },
  },
];

/**
 * Matches a CloudStream provider id against the family knowledge base.
 * Containment matching (normalized, case-insensitive): clone providers like
 * 'MoviesDrive.Sbs' or 'BollyFlix Hub' match their family keyword. Returns
 * null when no family matches — the honest REQUIRES_RUNTIME case.
 */
export function matchCloudStreamFamily(internalName: string): CloudStreamFamily | null {
  if (typeof internalName !== 'string' || internalName.length === 0) return null;
  const normalized = internalName.trim().toLowerCase();
  for (const family of FAMILIES) {
    if (normalized.includes(family.key)) return family;
  }
  return null;
}

/** Lists the supported family keys (deterministic; tests/diagnostics). */
export function listCloudStreamFamilyKeys(): string[] {
  return FAMILIES.map((family) => family.key);
}

/** Builds the family's DSL spec for one provider (display name bounded). */
export function buildFamilySpec(family: CloudStreamFamily, providerName: string): DeclarativeAdapterSpec {
  return family.buildSpec(providerName.slice(0, 120));
}
