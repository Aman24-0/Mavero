// LT-5 diagnostic — channel 151 resolution variance + MPD ContentProtection.
// Prints: host, drm field, HTTP status of the MPD, and the ContentProtection
// elements (key system IDs only — never URLs, never key values).
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'https://livetgtv.lovable.app';

for (let round = 1; round <= 3; round++) {
  const res = await fetch(`${BASE}/api/public/channels/151`, { headers: { accept: 'application/json' } });
  const body = (await res.json()) as {
    sources?: unknown;
    drm?: { type?: unknown; keyId?: unknown; key?: unknown };
  };
  const sources = Array.isArray(body.sources) ? (body.sources as unknown[]) : [];
  const mpd = sources.find((s) => typeof s === 'string' && String(s).includes('.mpd')) as string | undefined;
  const drm = body.drm && typeof body.drm === 'object' ? body.drm : null;
  const drmType = drm ? String((drm as { type?: unknown }).type) : 'none';
  const hasKeyId = drm ? typeof (drm as { keyId?: unknown }).keyId === 'string' : false;
  const host = mpd ? new URL(mpd).host : '-';
  console.log(`round ${round}: resolve=${res.status} host=${host} drm=${drmType} keyId-present=${hasKeyId}`);

  if (mpd) {
    const mpdRes = await fetch(mpd, { headers: { accept: 'application/dash+xml' } });
    const text = mpdRes.status === 200 ? await mpdRes.text() : '';
    const cps = [...text.matchAll(/<ContentProtection[^>]*>/g)].map((m) => m[0]);
    console.log(`  mpd: HTTP ${mpdRes.status} bytes=${text.length} ContentProtection-count=${cps.length}`);
    for (const cp of cps) {
      const scheme = /schemeIdUri="([^"]*)"/.exec(cp)?.[1] ?? '?';
      const value = /value="([^"]*)"/.exec(cp)?.[1] ?? '';
      const cencDefault = cp.includes('cenc:default_KID') ? 'default_KID=yes' : '';
      console.log(`    scheme=${scheme} value=${value} ${cencDefault}`);
    }
  }
  await sleep(1500);
}
