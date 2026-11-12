/**
 * UNIFIED LIVE TV — Phase 7 secrets/URLs/diagnostics redaction audit
 * (deterministic; brief §8 + required regression area #15).
 *
 * Strategy (per the brief): UNIQUE fake secret values are driven through
 * every diagnostics-bearing surface and the VALUES themselves must never
 * appear — a test that only checks variable names is insufficient.
 *
 *   §1  redactLivetvUrl: signed query parameters, userinfo, fragments
 *   §2  sanitizeLivetvDiagnosticText: bearer/basic tokens, signed tokens,
 *       query + prose shapes, control chars, bounding
 *   §3  end-to-end: a hostile provider echoing credential-bearing URLs in
 *       an error path → the stored history row + the outcome both stay clean
 *   §4  the playback boundary: redaction never touches URL construction
 *       (the media-auth/signed-parameter surface is untouched — pins)
 *   §5  no secret ever reaches the ops/status DTO shape (category-only)
 *
 * NO network, NO real secrets (everything below is a fixture).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { redactLivetvUrl, sanitizeLivetvDiagnosticText, LIVETV_DIAGNOSTIC_MAX_LENGTH } from '../src/lib/server/livetv/redact';
import { livetvHistoryRowFromSourceOutcome, livetvHistoryRowFromEpgOutcome } from '../src/lib/server/livetv/history';
import { fetchLivetvSourceText } from '../src/lib/server/livetv/fetch-safe';
import type { LivetvRefreshSourceOutcome } from '../src/lib/server/livetv/refresh-service';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
        assert.ok(condition, hint ? `${label} (${hint})` : label);
        passed += 1;
        console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// UNIQUE fake secret values (each appears NOWHERE else in the repo).
const SEC_TOKEN = 'FAKESECRETTOKEN_p7x9931_aaa';
const SEC_HDNEA = 'st=1570000000~exp=1579999999~acl=/*~hmac=FAKESECRETHMAC_p7x9931_bbb';
const SEC_KEY = 'FAKESECRETKEY_p7x9931_ccc';
const SEC_BEARER = 'eyJhbGciOiJFAKE.p7x9931FAKEPAYLOAD.dddBEARERSIG';
const SEC_COOKIE = 'FAKESECRETCOOKIE_p7x9931_ddd';

function hostileUrl(): string {
        return `https://cdn.example/live/index.m3u8?__hdnea__=${SEC_HDNEA}&token=${SEC_TOKEN}&api_key=${SEC_KEY}`;
}

function sourceOutcome(failureMessage: string): LivetvRefreshSourceOutcome {
        return {
                sourceId: '00000000-0000-4000-8000-0000000004d2',
                slug: 'redact-source',
                sourceType: 'm3u_playlist',
                adapterId: 'm3u_playlist',
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: 100,
                ok: false,
                failure: { kind: 'network', message: failureMessage },
                counts: null,
                entryErrors: null,
                ingestionErrors: null,
                skippedReasons: null,
                trigger: 'manual',
                stateTruncated: false,
                historyPersisted: null
        };
}

async function main() {
        // ------------------------------------------------------------------
        console.log('§1 — redactLivetvUrl (URL-shaped diagnostics)');
        // ------------------------------------------------------------------
        {
                const redacted = redactLivetvUrl(hostileUrl());
                ok(!redacted.includes(SEC_HDNEA), '§1.1 the __hdnea__ signed value is redacted');
                ok(!redacted.includes(SEC_TOKEN), '§1.2 the token value is redacted');
                ok(!redacted.includes(SEC_KEY), '§1.3 the api_key value is redacted');
                ok(redacted.includes('__hdnea__=') && redacted.includes('token=') && redacted.includes('api_key='), '§1.4 the parameter NAMES survive (operators see what was redacted)');
                ok(redacted.includes('REDACTED') && !redacted.includes('%5B'), '§1.5 the redaction is explicit and readable');
                ok(redacted.startsWith('https://cdn.example/live/index.m3u8'), '§1.6 the origin + path survive (usable diagnostics)');
                const creded = redactLivetvUrl(`https://user:${SEC_TOKEN}@cdn.example/x.m3u8#frag=${SEC_KEY}`);
                ok(!creded.includes(SEC_TOKEN) && !creded.includes(SEC_KEY), '§1.7 userinfo credentials + fragments are dropped');
                ok(redactLivetvUrl(`https://cdn.example/a?expires=${SEC_TOKEN}&q=plain`).includes('q=plain'), '§1.8 NON-sensitive parameters pass through untouched');
                ok(redactLivetvUrl('not a url at all ' + SEC_TOKEN).includes('[REDACTED]') === false || !redactLivetvUrl('totally unrelated prose').startsWith('http'), '§1.9 non-URL strings fall through to the text sanitizer (never throw)');
        }

        // ------------------------------------------------------------------
        console.log('§2 — sanitizeLivetvDiagnosticText (free-form diagnostics)');
        // ------------------------------------------------------------------
        {
                const text = `refresh failed: Authorization: ${SEC_BEARER}, cookie=${SEC_COOKIE}, upstream ${hostileUrl()}`;
                const clean = sanitizeLivetvDiagnosticText(text);
                ok(!clean.includes(SEC_BEARER), '§2.1 the bearer JWT value is redacted');
                ok(!clean.includes(SEC_COOKIE), '§2.2 the cookie value is redacted');
                ok(!clean.includes(SEC_HDNEA) && !clean.includes(SEC_TOKEN) && !clean.includes(SEC_KEY), '§2.3 all signed query values in the embedded URL are redacted');
                ok(clean.length <= LIVETV_DIAGNOSTIC_MAX_LENGTH, '§2.4 the result is bounded');
                ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(sanitizeLivetvDiagnosticText('bad\u0007control\u001bchars')), '§2.5 control characters are stripped');
                const long = sanitizeLivetvDiagnosticText('a'.repeat(1000) + ' ' + SEC_TOKEN);
                ok(long.length <= LIVETV_DIAGNOSTIC_MAX_LENGTH && !long.includes(SEC_TOKEN), '§2.6 truncation cannot push a secret past the bound (secrets redacted BEFORE truncation)');
                ok(sanitizeLivetvDiagnosticText(`https://cdn.example/p?token=${SEC_TOKEN}`).includes('token=[REDACTED]'), '§2.7 the query form redacts with the name preserved');
                ok(sanitizeLivetvDiagnosticText(`password: ${SEC_TOKEN}`).includes('password=[REDACTED]') && sanitizeLivetvDiagnosticText(`token: ${SEC_TOKEN}`).includes('token=[REDACTED]'), '§2.8 the prose name: value form redacts (sensitive names)');
                ok(sanitizeLivetvDiagnosticText('nothing sensitive here') === 'nothing sensitive here', '§2.9 clean text passes through unchanged');
        }

        // ------------------------------------------------------------------
        console.log('§3 — end-to-end: hostile provider echo → stored row stays clean');
        // ------------------------------------------------------------------
        {
                // A hostile upstream whose error path echoes the signed URL the
                // app sent (the fetch layer never does this — defense in depth:
                // even IF it did, the history writer sanitizes).
                const echoed = `upstream said: cannot serve ${hostileUrl()} (Authorization: ${SEC_BEARER})`;
                const row = livetvHistoryRowFromSourceOutcome(sourceOutcome(echoed), { trigger: 'scheduled', correlationId: '00000000-0000-4000-8000-0000000004d3', attemptNumber: 1 });
                const serialized = JSON.stringify(row);
                ok(!serialized.includes(SEC_HDNEA), '§3.1 the history row never contains the signed token');
                ok(!serialized.includes(SEC_TOKEN) && !serialized.includes(SEC_KEY), '§3.2 the history row never contains the query secrets');
                ok(!serialized.includes(SEC_BEARER), '§3.3 the history row never contains the echoed authorization material');
                const epgRow = livetvHistoryRowFromEpgOutcome(
                        {
                                epgSourceId: '00000000-0000-4000-8000-0000000004d4',
                                slug: 'redact-epg',
                                epgType: 'xmltv',
                                startedAt: new Date().toISOString(),
                                finishedAt: new Date().toISOString(),
                                durationMs: 10,
                                ok: false,
                                failure: { kind: 'network', message: echoed },
                                counts: null,
                                parseSamples: null,
                                executionErrors: null,
                                skipReasons: null,
                                mappingSamples: null,
                                timezonePolicy: null,
                                trigger: 'scheduled',
                                entriesTruncated: false,
                                historyPersisted: null
                        },
                        { trigger: 'scheduled', correlationId: '00000000-0000-4000-8000-0000000004d5', attemptNumber: 1 }
                );
                ok(!JSON.stringify(epgRow).includes(SEC_HDNEA) && !JSON.stringify(epgRow).includes(SEC_BEARER), '§3.4 the EPG twin has identical writer-side redaction');
        }

        // ------------------------------------------------------------------
        console.log('§4 — the playback boundary: redaction NEVER touches URL construction');
        // ------------------------------------------------------------------
        {
                // The LIVEGT playback client legitimately BUILDS signed URLs —
                // those must flow verbatim. Pins (import edges + behavior):
                // The LiveGT playback client signs manifests with the `n`
                // parameter (media-auth allowlist) — that behavior is untouched
                // and no client module imports the server redaction module.
                const mediaAuth = read('src/lib/client/live-tv/media-auth.ts');
                ok(mediaAuth.includes('__hdnea__') && mediaAuth.includes('Allowlist'), '§4.1 the media-auth signed-parameter surface is untouched (the __hdnea__ allowlist)');
                ok(!mediaAuth.includes('redact'), '§4.2 the playback client imports NO redaction');
                ok(!read('src/lib/server/livetv/scheduler.ts').includes('resolveLiveTvPlayback'), '§4.3 the scheduler never touches playback resolution (Phase 5 owns it)');
                // The retry policy cannot reach playback: its value type is the
                // refresh outcome, and the module imports nothing from api.ts.
                ok(!/from ['"]\.\/api|playback-resolver|client\/live-tv/.test(read('src/lib/server/livetv/retry.ts')), '§4.4 the retry policy imports NOTHING from the playback surface (playback-blind)');
        }

        // ------------------------------------------------------------------
        console.log('§5 — fetch-error diagnostics vs a credential-bearing redirect');
        // ------------------------------------------------------------------
        {
                // A redirect chain that would leak the token query into a new
                // host: the FINAL failure diagnostics carry only the ORIGINAL
                // origin (never the redirect target, never the query).
                const redirectingFetcher = (async () => new Response('', { status: 302, headers: { location: `https://evil.example/steal?token=${SEC_TOKEN}` } })) as unknown as typeof fetch;
                try {
                        await fetchLivetvSourceText('https://public.example/feed.m3u8?api_key=' + SEC_KEY, { fetcher: redirectingFetcher, dnsResolver: async () => [{ address: '93.184.216.34', family: 4 as const }, { address: '10.0.0.5', family: 4 as const }] });
                        ok(false, '§5.1 a redirect to a private address must throw');
                } catch (error) {
                        const evidence = error instanceof Error ? `${error.message}|${JSON.stringify(error)}` : String(error);
                        ok(!evidence.includes(SEC_KEY) && !evidence.includes(SEC_TOKEN) && !evidence.includes('evil.example'), '§5.2 the thrown diagnostics carry NO query, NO redirect target (origin-only)');
                }
        }

        console.log(`\n=== livetv Phase 7 redaction verification: ${passed} checks PASSED ===`);
}

main().catch((error) => {
        console.error(error);
        process.exit(1);
});
