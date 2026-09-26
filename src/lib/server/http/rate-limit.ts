/**
 * Phase 1 production hardening (audit SEC-003 / DL-5 / STM-11) —
 * application-level rate limiting for the highest-risk public endpoints.
 *
 * SCOPE (deliberately minimal — this is NOT a distributed rate-limit system):
 * The audited endpoints drive server-side upstream fetches (addon
 * resolution budgets of 30–40s, TMDB classification, 4K API calls) per
 * request. This module adds a bounded, per-instance fixed-window counter
 * so a single misbehaving client cannot drive unbounded upstream work.
 *
 * SERVERLESS HONESTY (required by the audit):
 * Instances of this Map are NOT shared across Netlify function instances —
 * per-instance memory is not a global guarantee. This is the smallest
 * practical in-process protection; the DEPLOYMENT-LEVEL control (Netlify
 * per-IP rate limits / WAF rules) is documented in DEPLOYMENT.md and is
 * the authoritative global layer. This module never pretends otherwise —
 * see the "Deployment" section of DEPLOYMENT.md.
 *
 * BOUNDED MEMORY:
 * The bucket map is hard-capped (MAX_TRACKED_BUCKETS). When the cap is hit,
 * expired buckets are evicted first, then the oldest-inserted ones — the
 * map can never grow without bound regardless of traffic shape.
 *
 * IDENTITY:
 * Authenticated users are keyed by user id (`u:<id>`) where the endpoint
 * already resolved a session; otherwise by the first trusted-proxy IP
 * (`ip:<x-forwarded-for>` as Netlify sets it). Endpoints that never resolve
 * a session fall back to IP-only identity. No identity material is logged.
 *
 * RESPONSE CONVENTION:
 * `limitExceeded` callers return a consistent 429 with a `retry-after`
 * header and the standard `{ ok: false, error: { code, message } }`
 * envelope (code RATE_LIMITED). No internal state is exposed.
 */

export type RateLimitRule = {
  /** Maximum requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

export type RateLimitVerdict = {
  allowed: boolean;
  /** Seconds until the window resets (for the retry-after header). */
  retryAfterSeconds: number;
  remaining: number;
};

export const RATE_LIMITED_ERROR_CODE = 'RATE_LIMITED';
export const RATE_LIMITED_MESSAGE = 'Too many requests. Please slow down and try again shortly.';

/**
 * Per-endpoint rules. Chosen to keep legitimate interactive use far above
 * the ceiling while capping the upstream cost a single client can drive:
 *   * resolve: 3 attempts ≤ 3× bounded fallbacks — 30/min is generous.
 *   * downloader batch: each call can spend a 40s upstream budget → 10/min.
 *   * downloader addon/tabs: the progressive UI fires one request per tab
 *     (≤20) → 30/min protects without breaking the flow.
 *   * 4k: one upstream fetch per call → 20/min.
 *   * json downloaders: one server-side API fetch per call → 20/min
 *     (mirrors the 4K ceiling; each call drives one upstream fetch).
 *   * search: TMDB classification per query → 30/min.
 *   * stremio session: token minting per play → 20/min.
 *   * pairing create: unauthenticated TV challenge creation → 10/min per IP
 *     (tighter than search because each challenge persists a row + secret_hash).
 *   * pairing poll: unauthenticated TV status polling → 60/min per IP+secret
 *     (the TV polls every 3s; 60/min accommodates 5min TTL with margin).
 *   * pairing approve: authenticated phone approval → 20/min per user
 *     (each approval calls Supabase generateLink which is rate-limited server-side).
 *   * pairing exchange: unauthenticated TV exchange → 10/min per IP
 *     (each exchange consumes a Supabase OTP).
 *   * pairing info: unauthenticated metadata lookup → 30/min per IP
 *     (called once per phone authorization page load; the secret is
 *     in the POST body, not the URL).
 *   * pairing cancel: unauthenticated cancellation → 20/min per IP
 *     (called once per cancel action; low-frequency but abuse-protected).
 *   * pairing code lookup (manual "Enter TV code" path): the 8-char
 *     short code has ~2^40 entropy — brute-force protection is
 *     mandatory. Dual buckets: 10/min per USER (abusive account) and
 *     30/min per IP (distributed probing). With these caps an attacker
 *     gets at most a few hundred guesses per 5-min code lifetime per IP
 *     against a 2^39 expected-guess space.
 */
export const RATE_LIMIT_RULES = {
  resolve: { limit: 30, windowMs: 60_000 },
  downloaderMavero: { limit: 10, windowMs: 60_000 },
  downloaderAddon: { limit: 30, windowMs: 60_000 },
  downloaderTabs: { limit: 30, windowMs: 60_000 },
  downloader4k: { limit: 20, windowMs: 60_000 },
  downloaderJson: { limit: 20, windowMs: 60_000 },
  search: { limit: 30, windowMs: 60_000 },
  stremioSession: { limit: 20, windowMs: 60_000 },
  pairingCreate: { limit: 10, windowMs: 60_000 },
  pairingPoll: { limit: 60, windowMs: 60_000 },
  pairingApprove: { limit: 20, windowMs: 60_000 },
  pairingExchange: { limit: 10, windowMs: 60_000 },
  pairingInfo: { limit: 30, windowMs: 60_000 },
  pairingCancel: { limit: 20, windowMs: 60_000 },
  pairingCodeLookupUser: { limit: 10, windowMs: 60_000 },
  pairingCodeLookupIp: { limit: 30, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitBucketName = keyof typeof RATE_LIMIT_RULES;

/** Hard cap on tracked buckets (bounded memory regardless of traffic). */
export const MAX_TRACKED_BUCKETS = 10_000;

const buckets = new Map<string, { count: number; windowStart: number }>();

/** Test seam — clears every bucket. */
export function resetRateLimitsForTests(): void {
  buckets.clear();
}

function evictExpired(now: number): void {
  // All current rules use 60s windows, so entries older than 60s cannot be
  // active for any rule; if a future rule used a longer window this sweep
  // would need the per-rule length. Kept simple + bounded.
  for (const [key, entry] of buckets) {
    if (now - entry.windowStart >= 60_000) buckets.delete(key);
  }
}

/**
 * Checks (and counts) one request against a rule. Fixed-window counting;
 * lazily resets on first hit of a new window.
 */
export function checkRateLimit(bucket: RateLimitBucketName, identity: string, now = Date.now()): RateLimitVerdict {
  const rule = RATE_LIMIT_RULES[bucket];
  const key = `${bucket}:${identity}`;

  if (buckets.size >= MAX_TRACKED_BUCKETS) {
    evictExpired(now);
    if (buckets.size >= MAX_TRACKED_BUCKETS) {
      // Still full: drop the OLDEST inserted entries (Map preserves
      // insertion order) until there is room — bounded by construction.
      for (const keyToDelete of buckets.keys()) {
        buckets.delete(keyToDelete);
        if (buckets.size < MAX_TRACKED_BUCKETS) break;
      }
    }
  }

  const entry = buckets.get(key);
  if (!entry || now - entry.windowStart >= rule.windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSeconds: 0, remaining: rule.limit - 1 };
  }

  entry.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((entry.windowStart + rule.windowMs - now) / 1000));
  if (entry.count > rule.limit) {
    return { allowed: false, retryAfterSeconds, remaining: 0 };
  }
  return { allowed: true, retryAfterSeconds: 0, remaining: rule.limit - entry.count };
}

/**
 * Extracts the caller identity: the authenticated user id when the endpoint
 * already resolved a session, otherwise the proxy IP (Netlify sets
 * x-forwarded-for). Falls back to 'unknown' when neither is available —
 * such callers share one conservative bucket instead of bypassing the limit.
 */
export function clientIdentity(headers: Headers, userId?: string | null): string {
  if (userId) return `u:${userId}`;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return `ip:${first}`;
  }
  const realIp = headers.get('x-nf-client-connection-ip');
  if (realIp) return `ip:${realIp.trim()}`;
  return 'ip:unknown';
}
