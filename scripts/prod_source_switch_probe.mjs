// Probe the REAL user flow: open watch page -> choose source -> select Blue Velvet
// -> observe VDRK subtitle fetch, video element, quality/subtitle selects.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
const INIT = `
window.__consoleLog = [];
(() => {
  const record = (level) => (...args) => {
    try { window.__consoleLog.push(level + ': ' + args.map((a) => { try { return typeof a === 'string' ? a.slice(0,300) : JSON.stringify(a)?.slice(0,200); } catch { return String(a); } }).join(' ')); } catch {}
  };
  for (const level of ['log','info','warn','error','debug','table','trace','dir']) { try { console[level] = record(level); } catch {} }
  try { console.clear = () => { window.__consoleLog.push('clear'); }; } catch {}
})();
`;
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Chrome-Lighthouse',
  viewport: { width: 390, height: 844 },
});
await context.addInitScript(INIT);
const page = await context.newPage();
page.setDefaultTimeout(25000);
const reqs = [], failed = [], responses = [];
page.on('request', (req) => {
  const u = req.url();
  if (/sub\.vdrk\.site|theintrodb|subtitles\/vtt|bluevelvet|zcdn|\.m3u8|api\/playback\/resolve/.test(u)) reqs.push(`${req.method()} ${u.slice(0, 140)}`);
});
page.on('requestfailed', (req) => {
  const u = req.url();
  if (/vdrk|introdb|bluevelvet|zcdn|m3u8|resolve/.test(u)) failed.push(`${u.slice(0, 120)} :: ${req.failure()?.errorText}`);
});
page.on('response', (r) => {
  const u = r.url();
  if (/vdrk|introdb|resolve|subtitles\/vtt/.test(u)) responses.push(`${r.status()} ${u.slice(0, 130)}`);
});
await page.goto('https://maveroweb.space/watch/movie/24428', { waitUntil: 'commit', timeout: 30000 });
await page.waitForTimeout(8000);
// Click "Choose source"
const chooseBtn = page.locator('button', { hasText: /Choose source/i });
if (await chooseBtn.count()) {
  console.log('clicking Choose source…');
  await chooseBtn.first().click();
  await page.waitForTimeout(3000);
  // list the source options in the opened sheet
  const opts = await page.evaluate(() => [...document.querySelectorAll('button, [role="option"], li, [role="button"]')].map((b) => (b.textContent || '').trim()).filter((t) => t && t.length < 60));
  console.log('options after click:', JSON.stringify([...new Set(opts)].slice(0, 30)));
  // click Blue Velvet
  const bv = page.locator('button, [role="option"], li').filter({ hasText: /Blue\s*Velvet/i });
  const bvCount = await bv.count();
  console.log('Blue Velvet options found:', bvCount);
  if (bvCount) {
    await bv.first().click();
    console.log('clicked Blue Velvet');
  }
} else {
  console.log('Choose source button not found');
}
await page.waitForTimeout(15000);
const state = await page.evaluate(() => ({
  logs: (window.__consoleLog ?? []).filter((l) => !/^clear$/.test(l)),
  iframeSrcs: [...document.querySelectorAll('iframe')].map((f) => f.src?.slice(0, 100)),
  hasVideo: !!document.querySelector('video'),
  videoSrc: document.querySelector('video')?.src?.slice(0, 100) ?? null,
  tracks: [...document.querySelectorAll('track')].map((t) => `${t.kind}:${t.label}:${(t.src || '').slice(0, 90)}`),
  selects: [...document.querySelectorAll('select')].map((s) => [...s.options].map((o) => o.textContent?.trim()).join('|')),
})).catch((e) => ({ evalError: e.message }));
console.log('LOGS:', JSON.stringify(state.logs, null, 1).slice(0, 2500));
console.log('iframes:', JSON.stringify(state.iframeSrcs), 'video:', state.hasVideo, 'src:', state.videoSrc);
console.log('tracks:', JSON.stringify(state.tracks));
console.log('selects:', JSON.stringify(state.selects));
console.log('REQS:', JSON.stringify(reqs, null, 1).slice(0, 2000));
console.log('FAILED:', JSON.stringify(failed));
console.log('RESPONSES:', JSON.stringify(responses));
await browser.close();
