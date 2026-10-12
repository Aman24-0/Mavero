// One-off LIVE probe (not in the test chain): the REAL variant parser
// against the REAL resolved BV master URL (via BV_MASTER).
import { discoverBlueVelvetVariants, parseBlueVelvetVariants } from '$lib/server/resolver/bluevelvet';

const master = process.env.BV_MASTER ?? '';
if (!master) { console.error('BV_MASTER not set'); process.exit(2); }
const body = await (await fetch(master)).text();
console.log('master bytes:', body.length);
const parsed = parseBlueVelvetVariants(master, body);
console.log('parsed variants:', parsed.length);
for (const v of parsed) console.log(' -', `${v.height}p`, v.bitrate, v.url.pathname);
const discovered = await discoverBlueVelvetVariants(master);
console.log('discover():', JSON.stringify(discovered.map((q) => ({ label: q.label, height: q.height }))));
