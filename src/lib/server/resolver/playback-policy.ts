/**
 * Playback Ad / Redirect Policy
 * =============================
 *
 * Application-level playback protection layer. Runs on every resolved
 * playback URL (direct stream or provider embed) AFTER the structural
 * `validatePlaybackUrl()` security checks (HTTPS-only, no credentials,
 * non-private hosts, embed origin allowlisting) and BEFORE a source is
 * returned to the player. A rejected URL behaves exactly like any other
 * failed source, so the existing resolver fallback, health ranking,
 * default-source ordering, and manual source switching are preserved.
 *
 * Scope and limits (intentional):
 * - This is NOT a browser-level adblocker. It cannot see or intercept
 *   traffic inside a cross-origin provider iframe, and it must not try.
 * - It only decides whether a playback URL is allowed to enter the
 *   playback pipeline at all.
 * - Popup/top-level navigation protection comes from the existing iframe
 *   sandbox (`$lib/shared/sandbox-policy`), which intentionally omits
 *   `allow-popups` and `allow-top-navigation*` for sandboxed embeds.
 *
 * Conservatism contract:
 * - URL structural traits are NEVER signals here: query parameters, tokens
 *   (`token=`, `signature=`, `expires=`, `hash=`, `key=`, `Key-Pair-Id=`),
 *   signed CDN URLs, long/random pathnames, numeric segments, media
 *   extensions (`.m3u8`, `.mpd`, `.mp4`, `.m4v`, `.webm`), and
 *   provider-specific parameters are all legitimate streaming traits.
 * - There is NO keyword matching against the URL (no "ad", "ads", "banner",
 *   "track", "click", "redirect" path scanning). Some providers legitimately
 *   use download/redirect/bootstrap endpoints, and such words appear in
 *   fully legitimate playback paths.
 * - Blocking is hostname-classification based: a host is blocked only when
 *   it is (a) listed in the global sets of clearly dedicated ad / paid
 *   redirect infrastructure, or (b) listed by an explicit provider-specific
 *   rule. A host listed as `example-ad-network.com` blocks that domain and
 *   its SUBDOMAINS only — never sibling domains, never unrelated domains
 *   that merely contain a similar label, and never a whole parent domain
 *   unless the parent itself is classified.
 * - The global sets deliberately exclude every provider / embed / CDN
 *   domain currently configured in Mavero (audited against
 *   `supabase/migrations/*`). If a new provider is added whose domain
 *   collides with an entry below, the entry — not the provider — must be
 *   reconsidered by an admin before enabling that provider.
 */

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
 * startup via `registerProviderPlaybackPolicy`.
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
 * `core.ts` is responsible for diagnostics logging and for turning a
 * rejection into a normal resolver failure so fallback can continue.
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

  const input = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!input) return blockedDecision('empty-url', 'unsafe-navigation');

  if (isSameOriginRelativePath(input)) {
    // Provider-specific path rules still apply to same-origin bootstrap
    // routes; global host sets cannot (there is no remote host).
    const providerId = options?.providerId?.trim();
    const policy = providerId ? providerPolicies.get(providerId) : undefined;
    if (policy?.blockedPathPrefixes) {
      for (const prefix of policy.blockedPathPrefixes) {
        if (prefix && input.startsWith(prefix)) {
          return blockedDecision('provider-blocked-path', 'provider-rule');
        }
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

  // Provider-specific rules (exact scope: only this provider's id).
  const providerId = options?.providerId?.trim();
  const policy = providerId ? providerPolicies.get(providerId) : undefined;
  if (policy) {
    if (policy.blockedHosts && hostIsClassified(host, policy.blockedHosts)) {
      return blockedDecision('provider-blocked-host', 'provider-rule', host);
    }
    if (policy.blockedPathPrefixes) {
      for (const prefix of policy.blockedPathPrefixes) {
        if (prefix && url.pathname.startsWith(prefix)) {
          return blockedDecision('provider-blocked-path', 'provider-rule', host);
        }
      }
    }
  }

  return { allowed: true, reason: 'not-classified', host };
}
