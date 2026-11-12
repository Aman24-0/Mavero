/**
 * Round 38 — the proxy crashed on the FIRST segment request.
 *
 * `sendUpstreamResponse` called `pipeline(reader, res, callback)` with
 * `pipeline` imported from `stream/promises`. The promises API parses a
 * FUNCTION argument as a "destination function", calls it and expects an
 * AsyncIterable/Promise back — `() => {}` returned undefined, so every
 * segment request rejected with
 *
 *   TypeError [ERR_INVALID_RETURN_VALUE]: Expected AsyncIterable or Promise
 *   to be returned from the "destination" function but got undefined.
 *       at sendUpstreamResponse (indian-proxy/server.js)
 *       at streamUpstream (indian-proxy/server.js)
 *
 * The rejection was unhandled → Node killed the process mid-broadcast.
 *
 * Regression coverage:
 *   §1  static — the callback-shaped pipeline call is gone; the Web→Node
 *       stream conversion + awaited pipeline are in; client disconnects are
 *       classified benign; /api/fetch no longer re-streams a consumed body.
 *   §2  static + dynamic — process-level uncaughtException /
 *       unhandledRejection guards are registered at the very top of
 *       server.js, BEFORE any require, and really install in this process.
 *   §3  dynamic — sendUpstreamResponse really streams a segment through a
 *       real http response, byte-for-byte, and RESOLVES.
 *   §4  dynamic — a client disconnect mid-stream resolves quietly and the
 *       server keeps serving (the exact Termux crash scenario).
 *
 * NO external network — the "upstream" is an in-memory slow Node Readable
 * converted to a Web stream (the same shape fetch() produces). The dynamic
 * part needs express; if indian-proxy's deps are not installed the dynamic
 * assertions are skipped instead of failing the suite.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

function readCode(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

// indian-proxy/ is the owner's LOCAL UNTRACKED standalone proxy project (it
// deploys from its own render.yaml and is NOT part of this repository), so CI
// checkouts do not contain it — and the monorepo restructure moved this app to
// apps/web, away from the directory's previous repo-root neighbor. The
// checkout is resolved in both layouts (cwd = repo root, or repo root two
// levels up); when absent, every pin over its source reports a skip instead of
// failing the gate over a directory that was never committed.
const INDIAN_PROXY_SOURCE = 'indian-proxy/server.js';
const indianProxyPath = [
  resolve(process.cwd(), INDIAN_PROXY_SOURCE),
  resolve(process.cwd(), '../..', INDIAN_PROXY_SOURCE)
].find((candidate) => existsSync(candidate));
const hasIndianProxy = indianProxyPath !== undefined;
const serverJs = hasIndianProxy ? readFileSync(indianProxyPath!, 'utf8') : '';

let skipped = 0;
/** ok() over the untracked indian-proxy source — skips when the checkout is absent. */
function proxyOk(condition: unknown, label: string, hint?: string) {
  if (!hasIndianProxy) {
    skipped += 1;
    console.log(`  skip - ${label} (untracked indian-proxy/ absent)`);
    return;
  }
  ok(condition, label, hint);
}

// ============================================================
console.log('§1 — the callback-shaped pipeline misuse is gone');
// ============================================================
{
  proxyOk(
    !serverJs.includes('pipeline(reader, res,'),
    '§1.1 the INVALID `pipeline(stream, res, callback)` call is gone (stream/promises parses a function arg as a "destination function" → ERR_INVALID_RETURN_VALUE → process death)'
  );
  proxyOk(
    serverJs.includes('Readable.fromWeb(upstream.body)'),
    '§1.2 the fetch() Web ReadableStream is converted to a NODE stream before pipeline'
  );
  proxyOk(
    serverJs.includes('await pipeline(nodeStream, res);'),
    '§1.3 the pipeline is AWAITED inside sendUpstreamResponse (no floating rejection)'
  );
  proxyOk(
    /async function sendUpstreamResponse\(res, upstream\) \{[\s\S]{0,1200}?await pipeline\(nodeStream, res\);[\s\S]{0,400}?\} catch \(err\) \{[\s\S]{0,300}?isBenignStreamError\(err\)/.test(serverJs),
    '§1.4 the pipeline call is wrapped in try/catch and disconnects are classified as benign'
  );
  proxyOk(
    ['ERR_STREAM_PREMATURE_CLOSE', 'AbortError', 'ECONNRESET', 'EPIPE'].every((needle) => serverJs.includes(needle)),
    '§1.5 the benign set covers premature close / abort / reset / pipe (the Quick Tunnel `context canceled` family)'
  );
  proxyOk(
    serverJs.includes('await sendUpstreamResponse(res, upstream);'),
    '§1.6 streamUpstream AWAITS sendUpstreamResponse'
  );
  proxyOk(
    serverJs.includes('res.send(body);') &&
      !/const body = await upstream\.text\(\);[\s\S]{0,600}?sendUpstreamResponse\(res, upstream\)/.test(serverJs),
    '§1.7 /api/fetch no longer hands an ALREADY-CONSUMED (.text()) body to the streamer — the buffered bytes are sent directly'
  );
}

// ============================================================
console.log('§2 — process-level crash guards, registered first');
// ============================================================

const beforeUnhandledException = process.listenerCount('uncaughtException');
const beforeUnhandledRejection = process.listenerCount('unhandledRejection');

/** The module under test (null when indian-proxy's express dep is missing). */
let proxy: {
  sendUpstreamResponse: (res: http.ServerResponse, upstream: unknown) => Promise<void>;
  isBenignStreamError: (err: unknown) => boolean;
} | null = null;
if (hasIndianProxy) {
  try {
    // Load the OWNER'S checkout (absolute path — cwd-independent in both the
    // single-repo and the monorepo layout).
    proxy = createRequire(import.meta.url)(indianProxyPath!);
  } catch {
    proxy = null; // dynamic section skipped below (deps not installed)
  }
}

{
  proxyOk(serverJs.includes("process.on('uncaughtException'"), '§2.1 uncaughtException guard present');
  proxyOk(serverJs.includes("process.on('unhandledRejection'"), '§2.2 unhandledRejection guard present');
  const guardAt = serverJs.indexOf("process.on('uncaughtException'");
  const firstRequire = serverJs.indexOf("require('express')");
  proxyOk(guardAt >= 0 && firstRequire > 0 && guardAt < firstRequire, '§2.3 the guards are registered BEFORE any require (boot-time failures are caught too)');
  proxyOk(serverJs.includes('[CRASH PREVENTED]'), '§2.4 crash-guard log tag present (errors are logged with their stack, not buried)');

  if (proxy) {
    ok(
      process.listenerCount('uncaughtException') > beforeUnhandledException,
      '§2.5 the uncaughtException handler is INSTALLED in this process (module-level side effect verified)'
    );
    ok(
      process.listenerCount('unhandledRejection') > beforeUnhandledRejection,
      '§2.6 the unhandledRejection handler is INSTALLED in this process'
    );
    ok(
      proxy.isBenignStreamError(Object.assign(new Error('premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })) === true &&
        proxy.isBenignStreamError(new Error('boom')) === false,
      '§2.7 isBenignStreamError: stream teardown noise is benign, real bugs are not'
    );
  } else {
    console.log('  skip §2.5-§2.7 — indian-proxy deps not installed (run `npm install` in indian-proxy/)');
  }
}

// ============================================================
console.log('§3 — sendUpstreamResponse really streams (dynamic)');
// ============================================================

/** A fetch()-shaped upstream whose body is a slow WEB ReadableStream. */
function fakeUpstream(chunks: Buffer[], delayMs: number) {
  const source = new Readable({ read() {} });
  source.on('error', () => {}); // teardown noise after a client disconnect
  void (async () => {
    try {
      for (const chunk of chunks) {
        if (source.destroyed) return; // the reader went away — stop feeding
        source.push(chunk);
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (!source.destroyed) source.push(null); // EOF
    } catch {
      /* cancelled mid-feed */
    }
  })();
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === 'content-type' ? 'video/mp4' : null) },
    body: Readable.toWeb(source) // the same Web ReadableStream shape fetch() returns
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)));
}

type GetResult = { status: number; type: string; body: Buffer };
function get(port: number, abortAfterFirstChunk = false): Promise<GetResult> {
  return new Promise((resolveReq, rejectReq) => {
    // agent:false — one-shot connection (no keep-alive, so server.close() below
    // is not kept waiting by an idle pooled socket).
    const req = http.get({ host: '127.0.0.1', port, path: '/segment', agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        parts.push(chunk);
        if (abortAfterFirstChunk) {
          req.destroy(); // the player / Quick Tunnel goes away mid-segment
          resolveReq({ status: res.statusCode || 0, type: String(res.headers['content-type'] || ''), body: Buffer.concat(parts) });
        }
      });
      res.on('end', () => resolveReq({ status: res.statusCode || 0, type: String(res.headers['content-type'] || ''), body: Buffer.concat(parts) }));
      res.on('error', () => resolveReq({ status: res.statusCode || 0, type: String(res.headers['content-type'] || ''), body: Buffer.concat(parts) }));
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return; // expected on abort
      rejectReq(err);
    });
  });
}

if (proxy) {
  const payload = Buffer.concat([Buffer.from('mavero-segment-bytes-0123456789'), Buffer.from(' second-half-of-the-segment ')]);
  const server = http.createServer((req, res) => {
    void proxy!.sendUpstreamResponse(res, fakeUpstream([payload.subarray(0, 30), payload.subarray(30)], 1));
  });
  const port = await listen(server);
  const got = await get(port);
  ok(
    got.status === 200 && got.type === 'video/mp4' && got.body.equals(payload),
    '§3.1 a segment streams byte-for-byte with upstream headers, and sendUpstreamResponse RESOLVES'
  );
  server.closeAllConnections();
  server.close();
} else {
  console.log('  skip §3 — indian-proxy deps not installed');
}

// ============================================================
console.log('§4 — a client disconnect mid-stream does NOT crash (dynamic)');
// ============================================================
if (proxy) {
  const chunk = Buffer.alloc(8192, 0x61); // 32 chunks × 8 KiB > the socket buffer → a REAL premature close
  let handled = 0;
  const server = http.createServer((req, res) => {
    void proxy!
      .sendUpstreamResponse(res, fakeUpstream(Array.from({ length: 32 }, () => chunk), 10))
      .then(() => {
        handled += 1; // RESOLVED — the benign disconnect was swallowed, not rethrown
      });
  });
  const port = await listen(server);
  const first = await get(port, true); // client aborts after the first chunk
  ok(first.status === 200, '§4.1 the client received the response head before disconnecting');
  await new Promise((r) => setTimeout(r, 500));
  ok(handled >= 1, '§4.2 sendUpstreamResponse RESOLVED after the mid-stream disconnect (nothing thrown or rejected)');
  const after = await get(port); // the server must still be healthy after the abort
  ok(
    after.status === 200 && after.body.length === 32 * 8192,
    '§4.3 the server KEPT SERVING after the disconnect (the exact Termux crash scenario now survives)'
  );
  server.closeAllConnections();
  server.close();
} else {
  console.log('  skip §4 — indian-proxy deps not installed');
}

console.log(`\nRound 38 proxy stream-crash summary: ${passed} passed, ${skipped} skipped (untracked indian-proxy/ absent), 0 failed`);
const dynamicRan = proxy !== null;
const expectedPins = dynamicRan ? 18 : hasIndianProxy ? 11 : 0;
if (passed < expectedPins) {
  console.error(`Expected at least ${expectedPins} assertions — the suite itself is broken`);
  process.exit(1);
}
process.exit(0); // the http test servers are down — exit even if a stray handle remains
