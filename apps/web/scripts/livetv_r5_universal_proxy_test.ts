/**
 * Round 37 — Universal proxy, 1000-channel cap fix & proxy auth resilience.
 *
 * Regression coverage for the four owner-reported round-37 issues:
 *   §1  The 1000-channel cap (Supabase hosted `db-max-rows` clamp silently
 *       truncated the catalogue to exactly 1000 rows; unordered paging made
 *       ARBITRARY channels like &Pictures / Zee Cinema vanish).
 *   §2  The proxy's SYNCHRONOUS re-sync on upstream 401/403/451 blocked the
 *       failing request for seconds and timed the player out.
 *   §3  The proxy's hardcoded Jio-only host allowlist (universal now, SSRF
 *       kept).
 *   §4  The app routed only host-allowlisted URLs through the Indian proxy
 *       (now EVERY Live TV stream rides it when configured).
 *
 * NO network, NO database — pure code/source-text assertions over the
 * implementation, mirroring the established repo convention.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let passed = 0;
let skipped = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

function readCode(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

const userCatalogue = readCode('src/lib/server/livetv/user-catalogue.ts');
const sourceFirstCatalogue = readCode('src/lib/server/livetv/source-first-catalogue.ts');
const resolutionRouter = readCode('src/lib/client/live-tv/resolution-router.ts');
// indian-proxy/ is the owner's LOCAL UNTRACKED standalone proxy project (it
// deploys from its own render.yaml and is NOT part of this repository), so
// CI checkouts do not contain it — and the monorepo restructure moved this
// app to apps/web, away from the directory's previous repo-root neighbor.
// The §2/§3 pins below assert its source and can only run where the owner's
// checkout sits next to the repo root; elsewhere proxyOk() reports them as
// skips (counted toward the liveness gate) instead of red-flagging a
// directory that was never committed.
const INDIAN_PROXY_SOURCE = 'indian-proxy/server.js';
// The checkout sits next to the repo root — the pre-monorepo layout (cwd IS
// the repo root) or the monorepo layout (repo root two levels up).
const indianProxyPath = [
  resolve(process.cwd(), INDIAN_PROXY_SOURCE),
  resolve(process.cwd(), '../..', INDIAN_PROXY_SOURCE)
].find((candidate) => existsSync(candidate));
const hasIndianProxy = indianProxyPath !== undefined;
const serverJs = hasIndianProxy ? readFileSync(indianProxyPath!, 'utf8') : '';

/** ok() over the untracked indian-proxy source — skips when the checkout is absent. */
function proxyOk(condition: unknown, label: string, hint?: string) {
  if (!hasIndianProxy) {
    skipped += 1;
    passed += 1;
    console.log(`  skip ${passed} - ${label} (untracked indian-proxy/ absent)`);
    return;
  }
  ok(condition, label, hint);
}

// ============================================================
console.log('§1 — The 1000-channel cap: paged reads with deterministic order');
// ============================================================
{
  // 1.1 — the paging helper exists with a page size at/below the clamp.
  ok(userCatalogue.includes('export const QUERY_PAGE_SIZE = 1000;'), '§1.1 QUERY_PAGE_SIZE = 1000 (≤ the hosted db-max-rows clamp, so every page is full)');
  ok(userCatalogue.includes('export async function pagedSelect<'), '§1.2 pagedSelect loops .range() windows until a short page');
  ok(userCatalogue.includes('rows.push(...data);'), '§1.3 pagedSelect ACCUMULATES pages (the full pool, not the last window)');

  // 1.4 — the unified catalogue entries query is paged + ordered.
  ok(
    userCatalogue.includes(".from('livetv_source_channels')") &&
      /livetv_source_channels[\s\S]{0,400}?\.order\('id', \{ ascending: true \}\)[\s\S]{0,80}?\.range\(from, to\)/.test(userCatalogue),
    '§1.4 unified catalogue: livetv_source_channels read is ORDERED + RANGED (no silent 1000-row clamp)'
  );

  // 1.5 — the source-first catalogue (the path the app grid actually reads).
  ok(
    sourceFirstCatalogue.includes('pagedSelect') &&
      /livetv_source_channels[\s\S]{0,400}?\.order\('id', \{ ascending: true \}\)[\s\S]{0,80}?\.range\(from, to\)/.test(sourceFirstCatalogue),
    '§1.5 source-first catalogue: entries read is ORDERED + RANGED'
  );
  ok(
    /livetv_channels[\s\S]{0,400}?\.order\('name', \{ ascending: true \}\)[\s\S]{0,200}?\.range\(from, to\)/.test(sourceFirstCatalogue),
    '§1.6 source-first catalogue: canonical channels read is paged (deterministic order kept)'
  );

  // 1.7 — no bare over-clamped limits remain on the big reads.
  ok(!userCatalogue.includes('.limit(MAX_MAPPED_ENTRIES_LOAD)'), '§1.7 unified catalogue: no bare .limit(MAX_MAPPED_ENTRIES_LOAD) left (the clamp)');
  ok(!sourceFirstCatalogue.includes('.limit(MAX_MAPPED_ENTRIES_LOAD)'), '§1.8 source-first catalogue: no bare .limit(MAX_MAPPED_ENTRIES_LOAD) left');
  ok(!sourceFirstCatalogue.includes('.limit(MAX_CATALOGUE_CHANNELS)'), '§1.9 source-first catalogue: no bare .limit(MAX_CATALOGUE_CHANNELS) left');

  // 1.10 — the bound still exists and exceeds the requested 5000.
  ok(userCatalogue.includes('export const MAX_CATALOGUE_CHANNELS = 10000;'), '§1.10 MAX_CATALOGUE_CHANNELS = 10000 (≥ the requested 5000; the clamp was the real bug)');
}

// ============================================================
console.log('§2 — Proxy auth failures: fast 403 + BACKGROUND re-sync');
// ============================================================
{
  // 2.1 — the re-sync is fire-and-forget with the 5s cooldown.
  proxyOk(serverJs.includes('const AUTO_RESYNC_COOLDOWN_MS = 5_000;'), '§2.1 the background re-sync cooldown is 5 seconds');
  proxyOk(serverJs.includes('syncPlaylist().catch(() => {});'), '§2.2 scheduleAuthResync is FIRE-AND-FORGET (never awaited by the request)');

  // 2.3 — the old blocking call is GONE.
  proxyOk(!serverJs.includes('await maybeAutoResync()'), '§2.3 no `await maybeAutoResync()` — the synchronous re-sync that timed players out is gone');
  proxyOk(!serverJs.includes('fetchUpstreamResilient'), '§2.4 the old fetch+inline-retry helper is fully replaced by fetchUpstream');

  // 2.5 — fetchUpstream marks auth failures and schedules the background sync.
  proxyOk(/if \(AUTH_FAILURE_STATUSES\.has\(res\.status\)\) \{[\s\S]{0,200}?scheduleAuthResync\([\s\S]{0,120}?res\.authFailure = true;/.test(serverJs), '§2.5 fetchUpstream marks 401/403/451 as auth failures and schedules the background re-sync');

  // 2.6 — the failure is answered FAST: 403 + retryable + retry hint.
  proxyOk(/function authFailureResponse\(res, upstream\) \{[\s\S]{0,300}?status\(403\)[\s\S]{0,300}?retryable: true,/.test(serverJs), '§2.6 authFailureResponse answers 403 + retryable (the client player retries after a short delay)');

  // 2.7 — all three upstream handlers use the fast path.
  const handlersUsingFastPath = (serverJs.match(/upstream\.authFailure\) authFailureResponse\(res, upstream\)/g) ?? []).length;
  proxyOk(handlersUsingFastPath === 3, '§2.7 segment + manifest + generic handlers all answer auth failures via the fast path', `found ${handlersUsingFastPath}/3`);

  // 2.8 — streaming: pipeline tears down on either side's error (never buffered).
  //       Round 38: the old callback-shaped call (`pipeline(reader, res, cb)`)
  //       fed a FUNCTION to stream/promises' pipeline — it rejected with
  //       ERR_INVALID_RETURN_VALUE and the unhandled rejection KILLED the
  //       process on the first segment request. The call must stay awaited,
  //       over a Node stream, with no function argument.
  proxyOk(
    serverJs.includes("require('stream/promises')") &&
      serverJs.includes('await pipeline(nodeStream, res);') &&
      !serverJs.includes('pipeline(reader, res,'),
    '§2.8 segment streaming AWAITS stream.pipeline over a NODE stream (backpressure + cleanup, nothing buffered, no callback misuse)'
  );
  proxyOk(serverJs.includes('Readable.fromWeb(upstream.body)'), '§2.9 segments stream via Readable.fromWeb (byte-for-byte, Range preserved)');
}

// ============================================================
console.log('§3 — Universal proxy: any public host, SSRF kept');
// ============================================================
{
  // 3.1 — the allowlist defaults to universal.
  proxyOk(serverJs.includes("process.env.SEGMENT_HOST_ALLOWLIST || '*'"), '§3.1 SEGMENT_HOST_ALLOWLIST defaults to * (universal — Jio, Sony, Hotstar, Akindi, …)');
  proxyOk(serverJs.includes('const ALLOW_ANY_HOST = HOST_ALLOWLIST.includes'), '§3.2 universal mode is an explicit, single flag');
  proxyOk(/if \(ALLOW_ANY_HOST\) return true;/.test(serverJs), '§3.3 hostAllowed allows ANY public DNS host in universal mode');

  // 3.4 — SSRF protection is UNCHANGED (+ bare IPv6 literals now refused).
  proxyOk(serverJs.includes("h === 'localhost' || h.endsWith('.localhost')"), '§3.4 SSRF: localhost/.localhost/.local refused');
  proxyOk(serverJs.includes('/^127\\./.test(h)') && serverJs.includes('/^192\\.168\\./.test(h)') && serverJs.includes('/^169\\.254\\./.test(h)'), '§3.5 SSRF: loopback/private/link-local IPv4 refused');
  proxyOk(serverJs.includes("if (h.includes(':')) return true;"), '§3.6 SSRF: bare IPv6 literals refused');
  proxyOk(serverJs.includes("parsed.protocol !== 'https:' && parsed.protocol !== 'http:'"), '§3.7 only http(s) targets are proxied');
  proxyOk(/res\.url && res\.url !== url && !hostAllowed\(res\.url, entry\)/.test(serverJs), '§3.8 redirect hops are re-validated against the same host policy');

  // 3.9 — the extra provider hosts are mapped for Referer/Origin.
  for (const suffix of ['hotstar.com', 'slivcdn.com', 'premiumplugx.com', 'akindi.lovable.app']) {
    proxyOk(serverJs.includes(`suffix: '${suffix}'`), `§3.9 Referer/Origin mapped for ${suffix}`);
  }

  // 3.10 — unknown hosts get NO spoofed Jio referer anymore.
  proxyOk(
    !/refererForHost\(host\) \|\| DEFAULT_JIO_REFERER/.test(serverJs),
    '§3.10 unknown hosts no longer get the Jio Referer fallback (a wrong Referer breaks hotstar/sonyliv)'
  );
}

// ============================================================
console.log('§4 — The app routes EVERY Live TV stream through the proxy');
// ============================================================
{
  // 4.1 — the indian wrap no longer requires the host-suffix gate.
  ok(
    resolutionRouter.includes("wrap.kind === 'indian' || isLivetvProxyUrl(firstUrl)"),
    '§4.1 the indian proxy wrap is UNIVERSAL (any host); the Worker keeps its CDN gate'
  );

  // 4.2 — the fail-fast skip only applies when NO proxy is configured.
  ok(
    resolutionRouter.includes('!this.indianProxyBase && isLivetvGeoblockedUrl(firstUrl)'),
    '§4.2 the geo-block skip stays gated on "no indian proxy configured"'
  );

  // 4.3 — the by-url contract + format steering are intact.
  ok(resolutionRouter.includes('indianProxyManifestUrl(raw, wrap.base, format)'), '§4.3 proxied URLs keep the by-url manifest contract + format extension');
  ok(resolutionRouter.includes("candidate.streamFormat ?? livetvStreamFormatForUrl(raw)"), '§4.4 the format falls back to the URL sniff (extensionless URLs still route)');
}

console.log(`\nRound 37 universal proxy + paging summary: ${passed} passed (${skipped} skipped — untracked indian-proxy/ absent), 0 failed`);
if (passed < 25) {
  console.error('Expected at least 25 assertions — the suite itself is broken');
  process.exit(1);
}
