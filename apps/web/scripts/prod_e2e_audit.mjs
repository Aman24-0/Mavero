// MAVERO — Player V2 remaining issues — PRODUCTION E2E audit v2 (read-only).
//
// v2: the site's disable-devtool protection kills headless documents (the
// DateToString/FuncToString/DebugLib detectors exploit console.* side
// effects). We therefore install an init script that REPLACES every console
// method with a recording no-op BEFORE page scripts run:
//   * the library's captured console references become no-ops → detectors
//     cannot fire → the document survives
//   * the app's own diagnostics ([mavero:subtitles] / [mavero:intro]) are
//     still captured — into window.__consoleLog
import { resolvePlaywright } from './mav_resolve_playwright.mjs';
const { chromium } = await resolvePlaywright();

const PROD = 'https://maveroweb.space';
let passed = 0, failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL - ${name}${detail ? ` — ${detail}` : ''}`); }
}

const INIT = `
window.__consoleLog = [];
window.__net = { vdrk: [], intro: [], vttProxy: [], bv: [] };
(() => {
  const record = (level) => (...args) => {
    try { window.__consoleLog.push(level + ': ' + args.map((a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } }).join(' ')); } catch {}
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'table', 'trace', 'dir']) {
    try { console[level] = record(level); } catch {}
  }
  try { console.clear = () => { window.__consoleLog.push('clear'); }; } catch {}
})();
`;

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

async function auditWatchPage(url, label, waitMs) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 },
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const failedRequests = [];
  page.on('request', (req) => {
    const u = req.url();
    if (/sub\.vdrk\.site/.test(u)) void window0;
  });
  // capture network via CDP
  const cdp = await context.newCDPSession(page);
  const vdrkReqs = [], introReqs = [], vttReqs = [], bvReqs = [];
  cdp.on('Network.requestWillBeSent', (e) => {
    const u = e.request.url;
    if (/sub\.vdrk\.site/.test(u)) vdrkReqs.push(`${e.request.method} ${u}`);
    if (/api\.theintrodb\.org/.test(u)) introReqs.push(`${e.request.method} ${u}`);
    if (/\/api\/content\/subtitles\/vtt\//.test(u)) vttReqs.push(`${e.request.method} ${u}`);
    if (/bluevelvet|zcdn/.test(u)) bvReqs.push(`${e.request.method} ${u.slice(0, 90)}`);
  });
  const failedResp = [];
  cdp.on('Network.responseReceived', (e) => {
    const u = e.response.url;
    if (/sub\.vdrk\.site|theintrodb|subtitles\/vtt/.test(u)) vttReqs.push(`RESP ${e.response.status} ${u}`);
  });
  cdp.on('Network.loadingFailed', (e) => { failedResp.push(e.errorText); });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.log(`goto error: ${e.message}`);
  }
  await page.waitForTimeout(waitMs);
  const state = await page.evaluate(() => ({
    logs: (window.__consoleLog ?? []).slice(0, 40),
    logCount: (window.__consoleLog ?? []).length,
    blocked: document.documentElement.textContent?.includes('permission to use') ?? false,
    selects: document.querySelectorAll('select').length,
    selectsText: [...document.querySelectorAll('select')].map((s) => [...s.options].map((o) => o.textContent).join('|')),
    hasVideo: !!document.querySelector('video'),
    hasIframe: !!document.querySelector('iframe'),
    bodySnippet: document.body.textContent?.slice(0, 200) ?? '',
  })).catch((e) => ({ evalError: e.message }));
  console.log(`\n===== ${label} (${url}) =====`);
  if (state.evalError) { console.log(`EVAL ERROR: ${state.evalError}`); await context.close(); return; }
  const subLogs = state.logs.filter((l) => /mavero:subtitles/.test(l));
  const introLogs = state.logs.filter((l) => /mavero:intro/.test(l));
  const cspLogs = state.logs.filter((l) => /Content Security Policy|security policy/i.test(l));
  console.log(`blocked-by-devtool-protection: ${state.blocked}`);
  console.log(`vdrk list requests: ${vdrkReqs.length ? vdrkReqs.join(' | ') : 'NONE'}`);
  console.log(`intro api requests: ${introReqs.length ? introReqs.join(' | ') : 'NONE'}`);
  console.log(`vtt proxy requests: ${vttReqs.length ? vttReqs.join(' | ') : 'NONE'}`);
  console.log(`[mavero:subtitles]: ${subLogs.join(' // ') || 'none'}`);
  console.log(`[mavero:intro]: ${introLogs.join(' // ') || 'none'}`);
  console.log(`CSP console messages: ${cspLogs.join(' || ') || 'none'}`);
  console.log(`selects (${state.selects}): ${JSON.stringify(state.selectsText)}`);
  console.log(`hasVideo=${state.hasVideo} hasIframe=${state.hasIframe}`);
  console.log(`app console (filtered, first 15): ${state.logs.filter((l) => !/^clear$/.test(l)).slice(0, 15).join(' || ')}`);
  await context.close();
  return { subLogs, introLogs, vdrkReqs };
}

const avengers = await auditWatchPage(`${PROD}/watch/movie/24428`, 'PROD Avengers movie/24428', 15000);
const gentlemen = await auditWatchPage(`${PROD}/watch/series/236235`, 'PROD The Gentlemen series/236235', 16000);

console.log(`\n===== E2E summary: ${passed} passed, ${failed} failed =====`);
await browser.close();
