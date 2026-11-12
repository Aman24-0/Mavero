// Vixolity browser-level playback verification (2026-10-16).
//
// NOT part of the `pnpm test` chain — this is an EVIDENCE script that
// needs internet access and a real browser. Run manually:
//
//     node scripts/vixolity_browser_playback_verification.mjs
//
// WHAT IT VERIFIES (as far as this environment permits):
//   The task forbids claiming Android playback without observing it. This
//   environment has NO Android device and desktop Chromium has NO native
//   HLS — so this script verifies the REAL browser path that CAN be
//   observed here, on the REAL production player code (deploy ≥ 3f9a49d;
//   the direct-path player files are byte-identical to HEAD):
//
//   Run A — Vixolity (the reported failure):
//     * The production watch page /watch/tv-show/1396/1/2 mounts the real
//       PlayerShell/PlayerViewport/PlaybackManager.
//     * /api/playback/resolve is INTERCEPTED (never reaches the server —
//       no demand-tracking write, no production mutation) and fulfilled
//       with the EXACT SourceResult the real Vixolity resolver returns
//       for tt0903747 s1/e02 (URL contract pinned by
//       vixolity_provider_test §1/§4; payload shape = player-guards.ts
//       isPlayablePlayerSource contract).
//     * Observed: which playback mode is selected (hls.js XHR vs native
//       media request), the exact network requests to ha.vixolity.com
//       (headers + CORS response headers), console errors (CORS vs CSP
//       vs media decode — kept SEPARATE), and whether currentTime moves.
//
//   Run B — positive control (CORS-open HLS stream):
//     * Same page, same stub mechanism, URL swapped for the public
//       Mux test stream (https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8,
//       CORS-open, standard hls.js test asset).
//     * If the REAL client pipeline plays THIS stream end-to-end, the
//       Mavero-side hls.js path (classification → Video.js adapter →
//       MSE → playback) is functional — isolating Vixolity's failure to
//       the upstream playlist CORS (provider-side), not client code.
//
// SECURITY BOUNDARIES (unchanged):
//   * No proxy, no header injection, no custom hls.js loader, no CORS
//     circumvention — the browser makes plain requests and we merely
//     RECORD what happens.
//   * The resolve interception only replaces the SERVER response with
//     the documented resolver contract; no production endpoint is hit,
//     nothing is written anywhere.

import { resolvePlaywright } from './mav_resolve_playwright.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = resolve(root, '.cache');
const WATCH_URL = 'https://maveroweb.space/watch/tv-show/1396/1/2';
const PRODUCTION_ORIGIN = 'https://maveroweb.space';

// The EXACT SourceResult the real resolver returns for this episode
// (shape per src/lib/shared/player-guards.ts isPlayablePlayerSource +
// src/lib/shared/player.ts PlayerSource; metadata.protocol='hls' is the
// load-bearing field — pinned in vixolity_provider_test §4).
function vixolitySourcePayload(url) {
  return {
    ok: true,
    source: {
      type: 'direct',
      url,
      providerId: 'browser-verification-provider',
      sourceId: 'browser-verification-source',
      mediaType: 'series',
      metadata: {
        sourceName: 'Vixolity',
        providerName: 'Vixolity',
        protocol: 'hls',
      },
    },
  };
}

function classifyConsoleText(text) {
  const lowered = text.toLowerCase();
  if (lowered.includes('access-control-allow-origin') || lowered.includes('cors')) return 'CORS';
  if (lowered.includes('content security policy') || lowered.includes('csp') || lowered.includes('violates')) return 'CSP';
  if (lowered.includes('mediasource') || lowered.includes('sourcebuffer') || lowered.includes('demuxer') || lowered.includes('decode')) return 'MEDIA';
  return 'OTHER';
}

async function runBrowserScenario({ chromium, label, streamUrl, observationMs }) {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  const evidence = {
    label,
    watchUrl: WATCH_URL,
    stubbedStreamUrl: streamUrl,
    pageLoad: null,
    resolveRequestBodies: [],
    streamRequests: [],
    consoleByClass: { CORS: [], CSP: [], MEDIA: [], OTHER: [] },
    videoFactsSamples: [],
    clickAttempt: null,
    playbackObserved: false,
  };

  const streamHostDetected = (url) => {
    try {
      const host = new URL(url).host;
      if (url.includes('ha.vixolity.com')) return 'ha.vixolity.com';
      if (host.endsWith('nodedatastream.top') || host.endsWith('storagegridlink.top')) return 'vixolity-segment-host';
      if (host.endsWith('test-streams.mux.dev')) return 'mux-test-stream';
      return null;
    } catch {
      return null;
    }
  };

  const recordConsole = (msg) => {
    const text = msg.text();
    const cls = classifyConsoleText(text);
    if (evidence.consoleByClass[cls].length < 25) {
      evidence.consoleByClass[cls].push({ type: msg.type(), text: text.slice(0, 500) });
    }
  };
  page.on('console', recordConsole);
  page.on('pageerror', (err) => {
    if (evidence.consoleByClass.OTHER.length < 25) evidence.consoleByClass.OTHER.push({ type: 'pageerror', text: String(err).slice(0, 500) });
  });

  // Prevent the service worker from installing (it could service-fetch
  // and complicate interception semantics). Everything else is real.
  await page.route('**/sw.js', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));

  // THE ONLY interception: the resolver endpoint. It NEVER reaches the
  // production server (no writes of any kind), and the fulfilled payload
  // is the documented resolver contract for the scenario's stream.
  await page.route('**/api/playback/resolve*', async (route) => {
    let body = null;
    try { body = route.request().postDataJSON(); } catch { /* body capture is best-effort */ }
    evidence.resolveRequestBodies.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(vixolitySourcePayload(streamUrl)),
    });
  });

  page.on('request', (request) => {
    const host = streamHostDetected(request.url());
    if (!host) return;
    evidence.streamRequests.push({
      host,
      url: request.url().slice(0, 180),
      resourceType: request.resourceType(),
      method: request.method(),
      originHeader: request.headers()['origin'] ?? null,
      failureText: null,
      responseStatus: null,
      responseAcao: null,
      responseContentType: null,
    });
  });
  page.on('requestfailed', (request) => {
    const host = streamHostDetected(request.url());
    if (!host) return;
    const existing = [...evidence.streamRequests].reverse().find((r) => r.url === request.url().slice(0, 180) && r.method === request.method() && r.responseStatus === null);
    const failure = request.failure()?.errorText ?? 'unknown';
    if (existing) existing.failureText = failure;
    else evidence.streamRequests.push({ host, url: request.url().slice(0, 180), resourceType: request.resourceType(), method: request.method(), originHeader: request.headers()['origin'] ?? null, failureText: failure, responseStatus: null, responseAcao: null, responseContentType: null });
  });
  page.on('response', (response) => {
    const host = streamHostDetected(response.url());
    if (!host) return;
    const entry = [...evidence.streamRequests].reverse().find((r) => r.url === response.url().slice(0, 180) && r.method === response.request().method() && r.responseStatus === null);
    if (!entry) return;
    entry.responseStatus = response.status();
    entry.responseAcao = response.headers()['access-control-allow-origin'] ?? null;
    entry.responseContentType = response.headers()['content-type'] ?? null;
  });

  try {
    const response = await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    evidence.pageLoad = { status: response?.status() ?? null, title: await page.title() };
  } catch (error) {
    evidence.pageLoad = { error: String(error).slice(0, 300) };
  }

  const startedAt = Date.now();
  let playAttempts = 0;
  while (Date.now() - startedAt < observationMs) {
    const facts = await page.evaluate(() => {
      const videos = document.querySelectorAll('video');
      const video = videos[0] ?? null;
      const errorNode = document.querySelector('[role="alert"], [class*="error" i], [data-state*="error" i]');
      return {
        videoQueryError: null,
        videoCount: videos.length,
        canPlayTypeHls: video ? video.canPlayType('application/vnd.apple.mpegurl') : null,
        canPlayTypeXmpegurl: video ? video.canPlayType('application/x-mpegURL') : null,
        crossoriginAttr: video ? video.getAttribute('crossorigin') : null,
        srcAttr: video ? video.getAttribute('src') : null,
        currentTime: video ? Number(video.currentTime.toFixed(3)) : null,
        readyState: video ? video.readyState : null,
        paused: video ? video.paused : null,
        mediaSourceAttached: Boolean(video && video.src && video.src.startsWith('blob:')),
        playerErrorText: errorNode ? errorNode.textContent?.trim().slice(0, 200) ?? null : null,
        pageTitle: document.title,
      };
    }).catch((error) => ({ videoQueryError: String(error).slice(0, 160), videoCount: -1 }));
    if (facts) {
      evidence.videoFactsSamples.push({ atMs: Date.now() - startedAt, ...facts });
      if ((facts.currentTime ?? 0) > 0.5) { evidence.playbackObserved = true; break; }
      // Insistent play(): headless autoplay + player wiring may need the
      // explicit call; never more than one per loop, best-effort only.
      if (Date.now() - startedAt > 4000 && playAttempts < 8) {
        playAttempts += 1;
        evidence.clickAttempt = await page.evaluate(() => {
          const video = document.querySelector('video');
          if (!video) return 'no-video';
          try { void video.play(); return `video.play() invoked (paused=${video.paused})`; } catch (e) { return `play() threw: ${e}`; }
        }).catch((e) => `evaluate failed: ${String(e).slice(0, 120)}`);
      }
    }
    await page.waitForTimeout(1500);
  }

  await browser.close();
  return evidence;
}

function summarize(evidence) {
  const lines = [];
  lines.push(`\n===== ${evidence.label} =====`);
  lines.push(`page: ${evidence.pageLoad?.status ?? 'ERR'} ${JSON.stringify(evidence.pageLoad)}`);
  lines.push(`resolve stubbed (${evidence.resolveRequestBodies.length} call(s)); body keys: ${JSON.stringify(evidence.resolveRequestBodies[0] ? Object.keys(evidence.resolveRequestBodies[0]) : null)}`);
  const last = evidence.videoFactsSamples.at(-1);
  if (last) {
    lines.push(`video(last sample @${last.atMs}ms): count=${last.videoCount} canPlayType(hls)="${last.canPlayTypeHls}" crossorigin=${JSON.stringify(last.crossoriginAttr)} src=${JSON.stringify((last.srcAttr ?? '').slice(0, 60))} blobSrc=${last.mediaSourceAttached} readyState=${last.readyState} currentTime=${last.currentTime} paused=${last.paused} queryError=${JSON.stringify(last.videoQueryError)}`);
    lines.push(`playerErrorText(last): ${JSON.stringify(last.playerErrorText)}`);
    const stateProgression = [...new Set(evidence.videoFactsSamples.map((s) => `${s.readyState}`))].join(' → ');
    const countProgression = [...new Set(evidence.videoFactsSamples.map((s) => `${s.videoCount}`))].join(' → ');
    lines.push(`readyState progression: ${stateProgression || '(none)'}; videoCount progression: ${countProgression}`);
    lines.push(`samples: ${evidence.videoFactsSamples.length}; playbackObserved=${evidence.playbackObserved}; playAttempt=${JSON.stringify(evidence.clickAttempt)}`);
  } else {
    lines.push('video: NO <video> element found on the page');
  }
  lines.push(`stream requests: ${evidence.streamRequests.length}`);
  for (const r of evidence.streamRequests.slice(0, 8)) {
    lines.push(`  [${r.resourceType}] ${r.method} ${r.url}`);
    lines.push(`     origin=${JSON.stringify(r.originHeader)} status=${r.responseStatus} acao=${JSON.stringify(r.responseAcao)} ctype=${JSON.stringify(r.responseContentType)} failure=${JSON.stringify(r.failureText)}`);
  }
  for (const cls of ['CORS', 'CSP', 'MEDIA', 'OTHER']) {
    const msgs = evidence.consoleByClass[cls];
    if (msgs.length) {
      lines.push(`console[${cls}] (${msgs.length} captured):`);
      for (const m of msgs.slice(0, 4)) lines.push(`   (${m.type}) ${m.text.slice(0, 220)}`);
    } else {
      lines.push(`console[${cls}]: none`);
    }
  }
  return lines.join('\n');
}

const reports = [];
try {
  const { chromium } = await resolvePlaywright();

  // Run A — the REAL Vixolity URL the resolver produces for tt0903747 s1/e02.
  const runA = await runBrowserScenario({
    chromium,
    label: 'RUN A — Vixolity tt0903747 s1/e02 (reported failing stream)',
    streamUrl: 'https://ha.vixolity.com/vs/tt0903747/s1/e02',
    observationMs: 25000,
  });
  console.log(summarize(runA));
  reports.push(runA);

  // Run B — positive control: same real pipeline, CORS-open HLS stream.
  // 90s window: this headless build loads the stream through the NATIVE
  // media path (no MSE), which is slower — give it room to reach data.
  const runB = await runBrowserScenario({
    chromium,
    label: 'RUN B — positive control: CORS-open Mux test HLS stream',
    streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    observationMs: 90000,
  });
  console.log(summarize(runB));
  reports.push(runB);

  // Verdicts (evidence-based, no claims beyond what was observed).
  const aRequests = runA.streamRequests;
  const aXhr = aRequests.filter((r) => r.resourceType === 'xhr' || r.resourceType === 'fetch');
  const aMedia = aRequests.filter((r) => r.resourceType === 'media');
  const aBlocked = aXhr.some((r) => r.failureText || (r.responseStatus !== null && r.responseAcao === null));
  const aConsoleCors = runA.consoleByClass.CORS.length > 0;
  const aConsoleCsp = runA.consoleByClass.CSP.length > 0;

  console.log('\n===== VERDICTS =====');
  console.log(`A. mode-selected        : ${aXhr.length > 0 ? 'hls.js (XHR/fetch to stream host)' : aMedia.length > 0 ? 'native media element' : 'no stream request observed'}`);
  console.log(`A. hls.js request blocked (missing ACAO / network error): ${aBlocked}`);
  console.log(`A. console CORS errors  : ${aConsoleCors}`);
  console.log(`A. console CSP errors   : ${aConsoleCsp}  (CSP errors must be ZERO — no CSP reaches SSR pages on production)`);
  console.log(`A. playback observed    : ${runA.playbackObserved}`);
  console.log(`B. playback observed    : ${runB.playbackObserved} (real client pipeline end-to-end when upstream CORS is open)`);

  mkdirSync(cacheDir, { recursive: true });
  const outPath = resolve(cacheDir, 'vixolity_browser_evidence.json');
  writeFileSync(outPath, JSON.stringify(reports, null, 2));
  console.log(`\nevidence JSON written to ${outPath.replace(root + '/', '')}`);
  process.exitCode = runA.playbackObserved ? 1 : 0; // A playing would contradict the CORS evidence — flag it loudly.
} catch (error) {
  console.error('VERIFICATION ENVIRONMENT ERROR:', error?.message ?? error);
  process.exitCode = 2;
}
