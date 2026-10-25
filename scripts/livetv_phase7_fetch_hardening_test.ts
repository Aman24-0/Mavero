/**
 * UNIFIED LIVE TV — Phase 7 SSRF / redirect / fetch-hardening re-audit
 * (deterministic; brief §7 + required regression areas #12/#13/#14).
 *
 * The protections themselves live in fetch-safe.ts (stage-1 URL guard +
 * stage-2 DNS guard per hop + connect-time guard + caps). This suite
 * RE-AUDITS them behaviorally with deterministic test doubles (mock
 * fetcher/resolver — never real infrastructure) and pins the module's
 * monopoly (NO second weaker fetch path may appear).
 *
 *   §1  transport + URL policy (https-only, credentials, length, control chars)
 *   §2  private/loopback/link-local/reserved address rejection (IPv4 + IPv6
 *       + hex/octal/decimal/IPv4-mapped/NAT64 encodings)
 *   §3  redirect re-validation on EVERY hop (public→private blocked), cap
 *   §4  content-type gates (HTML is never a feed — per mode)
 *   §5  compressed/decompressed body bounds (streaming cap abort + cleanup)
 *   §6  deadline + external cancellation propagation
 *   §7  the ONE-fetcher monopoly (source scans)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchLivetvSourceText, fetchLivetvSourceJson, fetchLivetvSourceBytes, LivetvSourceFetchError } from '../src/lib/server/livetv/fetch-safe';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
        assert.ok(condition, hint ? `${label} (${hint})` : label);
        passed += 1;
        console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const PUBLIC_IP = '93.184.216.34';
const PUBLIC_RESOLVER = async () => [{ address: PUBLIC_IP, family: 4 as const }];

/** A mock fetcher that always answers 200 with the given body/type. */
function okFetcher(body: string, contentType = 'audio/x-mpegurl') {
        return (async () => new Response(body, { headers: { 'content-type': contentType } })) as unknown as typeof fetch;
}

/** A mock fetcher answering a redirect to the given location. */
function redirectFetcher(location: string, status = 302) {
        return (async () => new Response('', { status, headers: { location } })) as unknown as typeof fetch;
}

async function expectKind(promise: Promise<unknown>, kind: string, label: string, hint?: string) {
        try {
                await promise;
                ok(false, `${label} — expected a ${kind} error but the fetch succeeded`);
        } catch (error) {
                ok(error instanceof LivetvSourceFetchError && error.kind === kind, label, hint ?? (error instanceof LivetvSourceFetchError ? `got ${error.kind}` : String(error)));
        }
}

async function main() {
        // ------------------------------------------------------------------
        console.log('§1 — transport + URL policy');
        // ------------------------------------------------------------------
        {
                await expectKind(fetchLivetvSourceText('http://upstream.example/feed.m3u8', { fetcher: okFetcher('x'), dnsResolver: PUBLIC_RESOLVER }), 'invalid_url', '§1.1 plain http is rejected (https-only re-assertion)');
                // The guard classifies embedded credentials as INVALID_URL (the
                // URL is malformed for transport, not merely blocked).
                await expectKind(fetchLivetvSourceText('https://user:pass@upstream.example/feed.m3u8', { fetcher: okFetcher('x'), dnsResolver: PUBLIC_RESOLVER }), 'invalid_url', '§1.2 credentials embedded in the URL are rejected');
                await expectKind(fetchLivetvSourceText('ftp://upstream.example/feed.m3u8', { fetcher: okFetcher('x'), dnsResolver: PUBLIC_RESOLVER }), 'invalid_url', '§1.3 non-http(s) schemes are rejected');
                // A query string is NOT a credential shape (real feeds carry
                // token query parameters legitimately) — it must fetch fine,
                // and diagnostics must never ECHO it.
                const withQuery = await fetchLivetvSourceText('https://upstream.example/feed.m3u8?api_key=SECRETTOKENVALUE', { fetcher: okFetcher('#EXTM3U'), dnsResolver: PUBLIC_RESOLVER });
                ok(withQuery.text === '#EXTM3U', '§1.4 a token-bearing query is fetchable (query ≠ credential shape)');
                const qFetcher = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
                try {
                        await fetchLivetvSourceText('https://upstream.example/feed.m3u8?api_key=SECRETTOKENVALUE', { fetcher: qFetcher, dnsResolver: PUBLIC_RESOLVER });
                        ok(false, '§1.5 a 500 must throw');
                } catch (error) {
                        const message = error instanceof Error ? `${error.message}|${JSON.stringify(Object.getOwnPropertyNames(error).map((k) => (error as never as Record<string, unknown>)[k]))}` : String(error);
                        ok(!message.includes('SECRETTOKENVALUE'), '§1.5 the typed error NEVER echoes the query (diagnostics discipline)');
                }
                const good = await fetchLivetvSourceText('https://upstream.example/feed.m3u8', { fetcher: okFetcher('#EXTM3U'), dnsResolver: PUBLIC_RESOLVER });
                ok(good.text === '#EXTM3U' && good.finalOrigin === 'https://upstream.example', '§1.6 a clean https fetch succeeds with its final origin');
        }

        // ------------------------------------------------------------------
        console.log('§2 — private/loopback/link-local/reserved rejection (stage-2 DNS)');
        // ------------------------------------------------------------------
        {
                for (const [host, ip, label] of [
                        ['loopback.example', '127.0.0.1', 'loopback'],
                        ['private10.example', '10.1.2.3', 'private 10/8'],
                        ['private172.example', '172.16.0.9', 'private 172.16/12'],
                        ['private192.example', '192.168.1.1', 'private 192.168/16'],
                        ['linklocal.example', '169.254.169.254', 'link-local (cloud metadata range)'],
                        ['metadata.example', '169.254.169.254', 'the cloud metadata endpoint'],
                        ['cganat.example', '100.64.0.1', 'CGNAT 100.64/10'],
                        ['bogon.example', '240.0.0.1', 'reserved class E'],
                        ['unspecified.example', '0.0.0.0', 'the unspecified address']
                ] as const) {
                        await expectKind(fetchLivetvSourceText(`https://${host}/feed.m3u8`, { fetcher: okFetcher('x'), dnsResolver: async () => [{ address: ip as string, family: 4 as const }] }), 'blocked_url', `§2.1 ${label} is rejected at the DNS stage`);
                }
                for (const [host, ip, label] of [
                        ['v6loop.example', '::1', 'IPv6 loopback'],
                        ['v6linklocal.example', 'fe80::1', 'IPv6 link-local'],
                        ['v6ula.example', 'fc00::1', 'IPv6 unique-local'],
                        ['v6mapped.example', '::ffff:10.0.0.1', 'IPv4-mapped IPv6 (bypass attempt)'],
                        ['v6nat64.example', '64:ff9b::a00:1', 'NAT64-encoded IPv4 (bypass attempt)']
                ] as const) {
                        await expectKind(fetchLivetvSourceText(`https://${host}/feed.m3u8`, { fetcher: okFetcher('x'), dnsResolver: async () => [{ address: ip as string, family: 6 as const }] }), 'blocked_url', `§2.2 ${label} is rejected`);
                }
                // Mixed answers: ONE private answer among several must reject.
                await expectKind(
                        fetchLivetvSourceText('https://mixed.example/feed.m3u8', {
                                fetcher: okFetcher('x'),
                                dnsResolver: async () => [
                                        { address: PUBLIC_IP, family: 4 as const },
                                        { address: '10.9.9.9', family: 4 as const }
                                ]
                        }),
                        'blocked_url',
                        '§2.3 a single private answer among public ones rejects the destination'
                );
                // A polluted resolver for ONE label must also reject (rebinding shape).
                await expectKind(
                        fetchLivetvSourceText('https://rebind.example/feed.m3u8', {
                                fetcher: okFetcher('x'),
                                dnsResolver: async () => [{ address: PUBLIC_IP, family: 4 as const }, { address: PUBLIC_IP, family: 4 as const }, { address: '192.168.0.77', family: 4 as const }]
                        }),
                        'blocked_url',
                        '§2.4 the rebinding shape (public answer + private answer) is rejected'
                );
        }

        // ------------------------------------------------------------------
        console.log('§3 — redirect re-validation on EVERY hop + cap');
        // ------------------------------------------------------------------
        {
                // A public host redirecting to a PRIVATE address must be blocked
                // before the next fetch happens (the stage-2 guard runs per hop).
                let nextHopFetched = false;
                const hopFetcher = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
                        if (String(_url).includes('private.example')) {
                                nextHopFetched = true;
                                return new Response('secret', { headers: { 'content-type': 'text/plain' }, signal: init?.signal }) as unknown as Response;
                        }
                        return new Response('', { status: 302, headers: { location: 'https://private10.example/next' } }) as unknown as Response;
                }) as unknown as typeof fetch;
                await expectKind(fetchLivetvSourceText('https://public.example/feed.m3u8', { fetcher: hopFetcher, dnsResolver: async (host: string) => (host.includes('private') ? [{ address: '10.1.2.3', family: 4 as const }] : [{ address: PUBLIC_IP, family: 4 as const }]) }), 'blocked_url', '§3.1 a public→private redirect is blocked (per-hop stage-2)');
                ok(nextHopFetched === false, '§3.2 the private hop was NEVER fetched');

                // A public→public redirect chain succeeds but respects the cap.
                let hops = 0;
                const chainFetcher = (async () => {
                        hops += 1;
                        return new Response('', { status: 302, headers: { location: `https://public.example/hop${hops}` } }) as unknown as Response;
                }) as unknown as typeof fetch;
                await expectKind(fetchLivetvSourceText('https://public.example/feed.m3u8', { fetcher: chainFetcher, dnsResolver: PUBLIC_RESOLVER }), 'network', '§3.3 the redirect loop hits the bounded cap');
                ok(hops === 4, '§3.4 exactly maxRedirects+1 requests were made (bounded count)', String(hops));

                // A redirect without a Location header fails closed.
                await expectKind(fetchLivetvSourceText('https://public.example/feed.m3u8', { fetcher: (async () => new Response('', { status: 302 })) as unknown as typeof fetch, dnsResolver: PUBLIC_RESOLVER }), 'network', '§3.5 a locationless redirect fails closed');

                // A redirect that downgrades to http is rejected by the per-hop policy.
                await expectKind(fetchLivetvSourceText('https://public.example/feed.m3u8', { fetcher: redirectFetcher('http://public.example/downgrade'), dnsResolver: PUBLIC_RESOLVER }), 'invalid_url', '§3.6 an https→http redirect is rejected (no transport downgrade)');
        }

        // ------------------------------------------------------------------
        console.log('§4 — content-type gates (HTML is never a feed)');
        // ------------------------------------------------------------------
        {
                const htmlFetcher = okFetcher('<html><body>error page</body></html>', 'text/html; charset=utf-8');
                await expectKind(fetchLivetvSourceText('https://upstream.example/feed.m3u8', { fetcher: htmlFetcher, dnsResolver: PUBLIC_RESOLVER }), 'unsupported_media_type', '§4.1 an HTML playlist response is rejected (text mode)');
                await expectKind(fetchLivetvSourceJson('https://upstream.example/api.json', { fetcher: htmlFetcher, dnsResolver: PUBLIC_RESOLVER }), 'unsupported_media_type', '§4.2 an HTML catalogue response is rejected (json mode)');
                await expectKind(fetchLivetvSourceBytes('https://upstream.example/guide.xml', { fetcher: htmlFetcher, dnsResolver: PUBLIC_RESOLVER }), 'unsupported_media_type', '§4.3 an HTML guide response is rejected (binary mode)');
                const xmlFetcher = okFetcher('<?xml version="1.0"?><tv></tv>', 'application/xml');
                const bytes = await fetchLivetvSourceBytes('https://upstream.example/guide.xml', { fetcher: xmlFetcher, dnsResolver: PUBLIC_RESOLVER });
                ok(bytes.bytes.byteLength > 0 && bytes.contentType === 'application/xml', '§4.4 a real XML document passes the binary gate');
                const jsonOk = await fetchLivetvSourceJson('https://upstream.example/api.json', { fetcher: okFetcher('{"ok":true}', 'application/json'), dnsResolver: PUBLIC_RESOLVER });
                ok((jsonOk.body as { ok: boolean }).ok === true, '§4.5 a real JSON document passes the json gate');
        }

        // ------------------------------------------------------------------
        console.log('§5 — body bounds (streaming cap + cleanup)');
        // ------------------------------------------------------------------
        {
                // A body that overflows the cap mid-stream aborts the connection
                // (the controller aborts → the stream's cancel path runs).
                const CHUNK = 'x'.repeat(64 * 1024);
                let cancelled = false;
                const overflowStream = new ReadableStream<Uint8Array>({
                        pull(controller) {
                                controller.enqueue(new TextEncoder().encode(CHUNK));
                        },
                        cancel() {
                                cancelled = true;
                        }
                });
                const overflowResponse = new Response(overflowStream, { headers: { 'content-type': 'audio/x-mpegurl' } });
                const cappedFetcher = (async () => overflowResponse) as unknown as typeof fetch;
                await expectKind(fetchLivetvSourceText('https://upstream.example/big.m3u8', { fetcher: cappedFetcher, dnsResolver: PUBLIC_RESOLVER, maxBytes: 128 * 1024 }), 'too_large', '§5.1 an oversized stream is capped mid-read');
                // Give the abort microtasks a moment, then verify the cleanup ran.
                await new Promise((resolve) => setTimeout(resolve, 20));
                ok(cancelled, '§5.2 the overflowing stream was CANCELLED (connection released, no unbounded buffering)');

                // A content-length lie larger than the cap is rejected before reading.
                const lyingFetcher = (async () => new Response('small', { headers: { 'content-type': 'audio/x-mpegurl', 'content-length': String(64 * 1024 * 1024) } })) as unknown as typeof fetch;
                await expectKind(fetchLivetvSourceText('https://upstream.example/lie.m3u8', { fetcher: lyingFetcher, dnsResolver: PUBLIC_RESOLVER }), 'too_large', '§5.3 a declared content-length beyond the cap rejects BEFORE reading');
        }

        // ------------------------------------------------------------------
        console.log('§6 — deadline + cancellation propagation');
        // ------------------------------------------------------------------
        {
                // The overall deadline aborts a hanging fetch. The test double
                // honors the signal the way undici does (abort rejects the
                // pending body read).
                const hangFetcher = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
                        const stream = new ReadableStream<Uint8Array>({
                                pull() {
                                        return new Promise<never>((_resolve, reject) => {
                                                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                                        });
                                },
                                cancel() {}
                        });
                        return new Response(stream, { headers: { 'content-type': 'audio/x-mpegurl' } }) as unknown as Response;
                }) as unknown as typeof fetch;
                await expectKind(fetchLivetvSourceText('https://upstream.example/hang.m3u8', { fetcher: hangFetcher, dnsResolver: PUBLIC_RESOLVER, timeoutMs: 40 }), 'timeout', '§6.1 a hanging body hits the deadline (typed timeout)');

                // An externally aborted signal is honored and typed 'cancelled'.
                const controller = new AbortController();
                const slowFetcher = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
                        await new Promise((resolve, reject) => {
                                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
                                setTimeout(resolve, 500);
                        });
                        return new Response('late', { headers: { 'content-type': 'audio/x-mpegurl' } }) as unknown as Response;
                }) as unknown as typeof fetch;
                setTimeout(() => controller.abort(), 10);
                await expectKind(fetchLivetvSourceText('https://upstream.example/slow.m3u8', { fetcher: slowFetcher, dnsResolver: PUBLIC_RESOLVER, signal: controller.signal }), 'cancelled', '§6.2 an external cancellation propagates (typed cancelled)');
        }

        // ------------------------------------------------------------------
        console.log('§7 — the ONE-fetcher monopoly (source scans)');
        // ------------------------------------------------------------------
        {
                ok(read('src/lib/server/livetv/fetch-safe.ts').includes("import { ssrfSafeFetch } from '../streaming/stremio/connect-guard'"), '§7.1 fetch-safe delegates to the audited connect-guard fetch (no weaker reimplementation)');
                // Every server livetv module must go through fetch-safe: no direct
                // fetch/http imports outside it.
                const { execFileSync } = await import('node:child_process');
                const files = execFileSync('rg', ['--files', 'src/lib/server/livetv'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
                const offenders = files.filter((file) => {
                        if (file.endsWith('fetch-safe.ts')) return false;
                        const src = read(file.replace(/^src\//, 'src/'));
                        return /\bfetch\(|from ['"]undici['"]|node:https?['"]/.test(src) && !/fetcher|deps\.fetch|typeof fetch|fetchLivetv|\/\/ |fetch-safe/.test(src.split('\n').filter((line) => /\bfetch\(|undici|node:https?/.test(line)).join('\n'));
                });
                ok(offenders.length === 0, '§7.2 NO other livetv server module performs raw fetches (the monopoly holds)', offenders.join(', ') || 'none');
                // The Phase 5 playback wire must NOT import the redaction module
                // (redaction is diagnostics-only; playback URLs stay verbatim —
                // import-edge pin, prose mentions of "redact" are irrelevant).
                ok(!/from ['"]\.\/redact['"]|from ['"]\$lib\/server\/livetv\/redact['"]/.test(read('src/lib/server/livetv/playback-resolver.ts')), '§7.3 the playback resolver never IMPORTS redaction (signed params preserved verbatim)');
                                // The playback CLIENT surface (the LiveGT api/player modules)
                // never imports the server redaction module at all.
                for (const clientFile of ['src/lib/client/live-tv/api.ts', 'src/lib/client/live-tv/player.ts', 'src/lib/client/live-tv/resolution-router.ts']) {
                        ok(!read(clientFile).includes('livetv/redact'), `§7.4 ${clientFile} never imports redaction (signed material flows verbatim)`);
                }
        }

        console.log(`\n=== livetv Phase 7 fetch-hardening verification: ${passed} checks PASSED ===`);
}

main().catch((error) => {
        console.error(error);
        process.exit(1);
});
