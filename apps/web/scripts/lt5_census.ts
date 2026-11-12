// LT-5 census — 150-channel sample: enumerate ALL source hosts, resolver DRM,
// MPD reachability, and MPD ContentProtection presence. Finds any channel that
// is ACTUALLY playable from this environment (reachable + unencrypted or clearkey).
// Never prints URLs/keys — only hosts, booleans, and counts.
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'https://livetgtv.lovable.app';

const catRes = await fetch(`${BASE}/api/public/channels`, { headers: { accept: 'application/json' } });
const cat = (await catRes.json()) as { channels?: Array<{ id?: unknown }> };
const ids = (Array.isArray(cat.channels) ? cat.channels : [])
  .map((c) => (typeof c?.id === 'string' ? c.id : null))
  .filter((x): x is string => x !== null);

const sample: string[] = ['151', '877', '143'];
const step = Math.max(1, Math.floor(ids.length / 77));
for (let i = 0; i < ids.length && sample.length < 80; i += step) {
  if (!sample.includes(ids[i])) sample.push(ids[i]);
}

type Info = { host: string; drm: string; status: number; cp: number; playable: boolean };
const results: Array<{ id: string } & Info> = [];
let throttled = 0;

for (const id of sample) {
  if (throttled >= 5) break;
  try {
    const res = await fetch(`${BASE}/api/public/channels/${encodeURIComponent(id)}`, {
      headers: { accept: 'application/json' }
    });
    if (res.status === 429) {
      throttled++;
      await sleep(3000);
      continue;
    }
    if (res.status !== 200) continue;
    const body = (await res.json()) as { sources?: unknown; drm?: { type?: unknown } };
    const sources = Array.isArray(body.sources) ? (body.sources as unknown[]) : [];
    const first = sources.find((s) => typeof s === 'string' && /^https?:\/\//.test(String(s))) as
      | string
      | undefined;
    const drm = body.drm && typeof body.drm === 'object' && (body.drm as { type?: unknown }).type
      ? String((body.drm as { type?: unknown }).type)
      : 'none';
    if (!first) continue;
    const host = new URL(first).host;
    let status = -2;
    let cp = -1;
    try {
      const get = await fetch(first, { headers: { accept: 'application/dash+xml' } });
      status = get.status;
      if (get.status === 200) {
        const text = await get.text();
        cp = (text.match(/<ContentProtection/g) ?? []).length;
      }
    } catch {
      status = -2;
    }
    const playable = status === 200 && cp === 0;
    results.push({ id, host, drm, status, cp, playable });
    if (status === 200) console.log(`  [live] id=${id} host=${host} drm=${drm} cp=${cp} playable=${playable}`);
  } catch {
    /* skip channel */
  }
  await sleep(380);
}

console.log(`census: ${results.length} channels resolved`);
const hosts = new Map<string, number>();
for (const r of results) hosts.set(r.host, (hosts.get(r.host) ?? 0) + 1);
for (const [h, n] of hosts) console.log(`host ${h}: ${n}`);

const ok = results.filter((r) => r.status === 200);
console.log(`\nMPD-reachable: ${ok.length}`);
for (const r of ok.slice(0, 20)) {
  console.log(`  id=${r.id} drm=${r.drm} contentProtection=${r.cp} playable=${r.playable}`);
}
const playable = results.filter((r) => r.playable);
console.log(`\nTRULY PLAYABLE (reachable + no ContentProtection): ${playable.length}`);
for (const r of playable.slice(0, 20)) console.log(`  id=${r.id} host=${r.host} drm=${r.drm}`);
