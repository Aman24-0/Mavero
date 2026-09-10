/**
 * Playback Ad / Redirect Policy
 * ============================
 *
 * Third-Party Streaming Provider Playback Ad Protection — the URL
 * classification engine. Runs on a resolved playback URL (direct stream or
 * provider embed) AFTER the structural `validatePlaybackUrl()` security
 * checks (HTTPS-only, no credentials, non-private hosts, embed origin
 * allowlisting) and BEFORE a source is returned to the player — but ONLY
 * for providers/sources whose admin explicitly enabled Ad Protection
 * (see `$lib/shared/playback-ad-protection`). The resolver decides, per
 * source attempt, whether this evaluator runs at all. With the setting OFF
 * the evaluator is skipped entirely and playback behaves exactly as before
 * this module existed.
 *
 * Scope and limits (intentional):
 * - This is NOT a browser-level adblocker and NOT a global switch. It
 *   cannot see or intercept traffic inside a cross-origin provider iframe,
 *   and it must not try. It never affects home/search/discover/catalog/
 *   TMDB/admin traffic or Mavero's own (future) advertising.
 * - It only decides whether a playback URL is allowed to enter the
 *   playback pipeline for the provider/source being resolved.
 * - Popup/top-level navigation protection comes from the existing iframe
 *   sandbox (`$lib/shared/sandbox-policy`), which intentionally omits
 *   `allow-popups` and `allow-top-navigation*` for sandboxed embeds and
 *   stays fully independent of this module.
 *
 * Conservatism contract:
 * - URL structural traits are NEVER signals here: query parameters, tokens
 *   (`token=`, `signature=`, `expires=`, `hash=`, `key=`, `Key-Pair-Id=`),
 *   signed CDN URLs, long/random pathnames, numeric segments, media
 *   extensions (`.m3u8`, `.mpd`, `.mp4`, `.m4v`, `.webm`), and
 *   provider-specific parameters are all legitimate streaming traits.
 * - There is NO keyword matching against the URL (no "ad", "ads", "advert",
 *   "banner", "track", "click", "redirect", "download" path scanning). Some
 *   providers legitimately use download/redirect/bootstrap endpoints, and
 *   such words appear in fully legitimate playback paths.
 * - Blocking is hostname-classification based: a host is blocked only when
 *   (a) it is listed in the global sets of clearly dedicated ad / paid
 *   redirect infrastructure, (b) it matches the enabled provider/source's
 *   own scoped rules (capabilities or the curated registry), or (c) it hits
 *   a structural navigation hazard. A host listed as
 *   `example-ad-network.com` blocks that domain and its SUBDOMAINS only —
 *   never sibling domains, never unrelated domains that merely contain a
 *   similar label, and never a whole parent domain unless the parent itself
 *   is classified.
 * - The global sets deliberately exclude every provider / embed / CDN
 *   domain currently configured in Mavero (audited against
 *   `supabase/migrations/*`). If a new provider is added whose domain
 *   collides with an entry below, the entry — not the provider — must be
 *   reconsidered by an admin before enabling that provider.
 */

import type { PlaybackAdProtectionConfig } from '$lib/shared/playback-ad-protection';

export type PlaybackPolicyCategory = 'ad-domain' | 'redirect' | 'unsafe-navigation' | 'provider-rule';

export type PlaybackPolicyDecision = {
  allowed: boolean;
  reason?: string;
  category?: PlaybackPolicyCategory;
  /**
   * Hostname of the evaluated URL (or undefined for same-origin relative
   * paths / unparseable input). Hostname only — never the full URL — so it
   * is safe to log: signed query strings and path tokens are not included.
   */
  host?: string;
};

export type PlaybackUrlType = 'direct' | 'embed';

export type PlaybackPolicyContext = {
  providerId?: string;
  sourceId?: string;
  providerName?: string;
  sourceName?: string;
  /**
   * The effective Ad Protection configuration for THIS provider/source,
   * assembled by the resolver from trusted server-side capabilities (never
   * from the playback request). When supplied with `enabled: false` the
   * evaluator short-circuits to "allowed" — the resolver is expected to
   * skip the evaluation entirely in that case, this guard keeps direct
   * callers safe. When supplied with rules, they apply ONLY to this
   * provider/source, unioned with any curated registry rules for the same
   * provider id.
   */
  policy?: PlaybackAdProtectionConfig;
};

/**
 * Extensible per-provider rule set. Rules are keyed by the provider's
 * `streaming_providers.id` and are evaluated IN ADDITION to the global
 * sets, only for that provider. Adding a rule never touches the player
 * components: the resolver pipeline re-evaluates every playback URL on
 * every resolve, so a newly registered rule takes effect immediately.
 */
export type ProviderPlaybackPolicy = {
  blockedHosts?: readonly string[];
  blockedPathPrefixes?: readonly string[];
};

/**
 * Clearly dedicated ad-delivery / popunder networks. Every entry is a
 * registrable (apex) domain whose only purpose is advertising. Subdomain
 * matching is automatic (`serve.popads.net` → `popads.net`). None of these
 * host legitimate Mavero provider, embed, or stream-CDN traffic (audited).
 */
const blockedAdHosts: ReadonlySet<string> = new Set<string>([
  // Popunder / popup ad networks common on streaming sites.
  'popads.net',
  'popcash.net',
  'popmyads.com',
  'popunder.net',
  'onclickads.net',
  'onclickalgo.com',
  'onclickperformance.com',
  'onclickmega.com',
  'propellerads.com',
  'clickadu.com',
  'exoclick.com',
  'exosrv.com',
  'exdynsrv.com',
  'juicyads.com',
  // Native / display ad serving infrastructure.
  'mgid.com',
  'revcontent.com',
  'taboola.com',
  'outbrain.com',
  'media.net',
  'teads.tv',
  'sharethrough.com',
  // Programmatic ad serving endpoints (ad exchanges / SSPs).
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adnxs.com',
  'adsrvr.org',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'casalemedia.com',
  'indexww.com',
  'smartadserver.com',
  'adform.net',
  'criteo.com',
  'criteo.net',
  'amazon-adsystem.com',
]);

/**
 * Explicitly classified paid-link / monetized redirect gateways. These
 * domains exist to bounce visitors through monetized interstitials and are
 * never legitimate playback hosts. Note that the policy does NOT infer
 * "redirect" from URL shape — only this explicit classification triggers
 * the `redirect` category, because some providers legitimately use redirect
 * or bootstrap endpoints to hand out real streams.
 */
const blockedRedirectHosts: ReadonlySet<string> = new Set<string>([
  'adf.ly',
  'shorte.st',
]);

/**
 * Provider-specific policies. Starts intentionally EMPTY: no currently
 * configured Mavero provider needs one, and inventing rules without
 * auditing the provider would risk false positives. Register rules at
 * startup via `registerProviderPlaybackPolicy`. Rules registered here are
 * scoped to exactly one provider id and NEVER leak to other providers.
 */
const providerPolicies = new Map<string, ProviderPlaybackPolicy>();

export function registerProviderPlaybackPolicy(providerId: string, policy: ProviderPlaybackPolicy): void {
  const id = providerId.trim();
  if (!id) throw new Error('registerProviderPlaybackPolicy requires a non-empty providerId');
  providerPolicies.set(id, policy);
}

export function unregisterProviderPlaybackPolicy(providerId: string): boolean {
  return providerPolicies.delete(providerId.trim());
}

export function providerPlaybackPolicyFor(providerId: string | undefined): ProviderPlaybackPolicy | undefined {
  if (!providerId) return undefined;
  return providerPolicies.get(providerId.trim());
}

function normalizeHost(hostname: string): string {
  // `new URL().hostname` is already punycode + lowercase for most inputs;
  // lowercase again for defense and strip a single trailing dot (FQDN form)
  // so `popads.net.` matches the same classification as `popads.net`.
  return hostname.toLowerCase().replace(/\.$/, '');
}

/**
 * Subdomain-aware classification match: `host === entry` or `host` is a
 * proper subdomain of `entry` (dot-boundary suffix). The leading-dot anchor
 * guarantees that sibling lookalikes never match: `notpopads.net` and
 * `popads.net.evil-mirror.test` do NOT match entry `popads.net`.
 */
function hostMatchesEntry(host: string, entry: string): boolean {
  const candidate = normalizeHost(entry);
  if (!candidate) return false;
  return host === candidate || host.endsWith(`.${candidate}`);
}

function hostIsClassified(host: string, entries: Iterable<string>): boolean {
  for (const entry of entries) {
    if (hostMatchesEntry(host, entry)) return true;
  }
  return false;
}

/**
 * Same-origin relative embed URLs (paths starting with "/" — used by
 * server-side redirect/bootstrap routes such as the SuperEmbed flow) are
 * first-party infrastructure: the hostname is our own deployment, so global
 * ad-host classification cannot apply. They are allowed unless an explicit
 * provider-specific path prefix rule matches them.
 */
function isSameOriginRelativePath(rawUrl: string): boolean {
  return rawUrl.startsWith('/') && !rawUrl.startsWith('//');
}

function blockedDecision(reason: string, category: PlaybackPolicyCategory, host?: string): PlaybackPolicyDecision {
  return { allowed: false, reason, category, host };
}

/**
 * Evaluate a resolved playback URL against the playback ad/redirect policy.
 *
 * Pure function: no logging, no side effects. The resolver integration in
 * `core.ts` is responsible for gating (it invokes this ONLY when the
 * trusted per-source Ad Protection setting is ON), diagnostics logging,
 * and for turning a rejection into a normal resolver failure so fallback
 * can continue.
 *
 * The `type` parameter ('direct' | 'embed') is accepted for API symmetry
 * with `validatePlaybackUrl()`; current classification rules are
 * type-agnostic because a classified ad host is not a legitimate target for
 * either playback mode. It remains part of the contract so future
 * type-specific rules (if ever needed) do not change the call signature.
 */
export function evaluatePlaybackUrl(
  rawUrl: string,
  type: PlaybackUrlType,
  options?: PlaybackPolicyContext,
): PlaybackPolicyDecision {
  void type;

  // Provider/source scoping: the resolver passes the effective config for
  // the source being resolved. An explicit `enabled: false` short-circuits
  // to "allowed" so a disabled provider/source can never be blocked by any
  // rule channel, regardless of how the evaluator was invoked.
  const scopedPolicy = options?.policy;
  if (scopedPolicy && scopedPolicy.enabled === false) return { allowed: true, reason: 'protection-disabled-for-source' };

  const input = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!input) return blockedDecision('empty-url', 'unsafe-navigation');

  if (isSameOriginRelativePath(input)) {
    // Provider-specific path rules still apply to same-origin bootstrap
    // routes; global host sets cannot (there is no remote host).
    const providerId = options?.providerId?.trim();
    const policy = providerId ? providerPolicies.get(providerId) : undefined;
    const prefixes = [...(policy?.blockedPathPrefixes ?? []), ...(scopedPolicy?.blockedPathPrefixes ?? [])];
    for (const prefix of prefixes) {
      if (prefix && input.startsWith(prefix)) {
        return blockedDecision('provider-blocked-path', 'provider-rule');
      }
    }
    return { allowed: true, reason: 'same-origin-bootstrap' };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return blockedDecision('unparseable-url', 'unsafe-navigation');
  }

  // Structural navigation hazards. These duplicate guarantees that
  // `validatePlaybackUrl()` already enforces in the resolver pipeline; the
  // policy keeps them so the module stays safe as a standalone guard.
  if (url.protocol !== 'https:') return blockedDecision('non-https-scheme', 'unsafe-navigation');
  if (url.username || url.password) return blockedDecision('embedded-credentials', 'unsafe-navigation');

  const host = normalizeHost(url.hostname);
  if (!host) return blockedDecision('empty-host', 'unsafe-navigation');

  // Global classification sets (subdomain-aware).
  if (hostIsClassified(host, blockedAdHosts)) return blockedDecision('known-ad-host', 'ad-domain', host);
  if (hostIsClassified(host, blockedRedirectHosts)) return blockedDecision('known-redirect-host', 'redirect', host);

  // Provider-specific rules — scoped to exactly this provider: curated
  // registry rules for the provider id, plus the runtime-supplied scoped
  // config (capabilities-derived) passed by the resolver. Neither channel
  // ever applies to a different provider.
  const providerId = options?.providerId?.trim();
  const registryPolicy = providerId ? providerPolicies.get(providerId) : undefined;
  const scopedHosts = [...(registryPolicy?.blockedHosts ?? []), ...(scopedPolicy?.blockedHosts ?? [])];
  const scopedPrefixes = [...(registryPolicy?.blockedPathPrefixes ?? []), ...(scopedPolicy?.blockedPathPrefixes ?? [])];
  if (scopedHosts.length && hostIsClassified(host, scopedHosts)) {
    return blockedDecision('provider-blocked-host', 'provider-rule', host);
  }
  for (const prefix of scopedPrefixes) {
    if (prefix && url.pathname.startsWith(prefix)) {
      return blockedDecision('provider-blocked-path', 'provider-rule', host);
    }
  }

  return { allowed: true, reason: 'not-classified', host };
}
