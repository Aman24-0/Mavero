// Live TV HLS stream proxy — deterministic tests for the PURE logic
// (manifest rewriting + the shared allowlist/URL helpers). No network.
import assert from 'node:assert/strict';
import { rewriteHlsManifest } from '../src/lib/server/livetv/hls-manifest';
import {
	isLivetvProxyHost,
	isLivetvProxyUrl,
	livetvStreamProxyUrl,
	LIVETV_STREAM_PROXY_PATH
} from '../src/lib/shared/livetv-proxy';

let passed = 0;
function ok(cond: boolean, name: string) {
	assert.ok(cond, name);
	passed += 1;
	console.log(`  ok ${passed} - ${name}`);
}

// ---- shared allowlist ----
ok(isLivetvProxyHost('live09p.hotstar.com'), 'host: subdomain of hotstar.com is proxied');
ok(isLivetvProxyHost('dishmt.slivcdn.com'), 'host: subdomain of slivcdn.com is proxied');
ok(isLivetvProxyHost('jiotvpllive.cdn.jio.com'), 'host: subdomain of jio.com is proxied (akindi HLS)');
ok(isLivetvProxyHost('hotstar.com'), 'host: bare allowlisted domain is proxied');
ok(!isLivetvProxyHost('evil.com'), 'host: unrelated domain is NOT proxied');
ok(!isLivetvProxyHost('nothotstar.com'), 'host: suffix-lookalike is NOT proxied');
ok(isLivetvProxyUrl('https://live09p.hotstar.com/x/master.m3u8'), 'url: allowlisted absolute URL is proxied');
ok(!isLivetvProxyUrl('not a url'), 'url: malformed input is NOT proxied');
ok(livetvStreamProxyUrl('https://a.hotstar.com/x.m3u8') === `${LIVETV_STREAM_PROXY_PATH}?u=${encodeURIComponent('https://a.hotstar.com/x.m3u8')}`, 'url: proxy URL shape');

// ---- manifest rewriting ----
const base = 'https://live09p.hotstar.com/live/abc/master.m3u8';

// media playlist: relative segment → proxied absolute
{
	const body = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', 'seg-1.ts', '#EXTINF:6.0,', 'seg-2.ts', '#EXT-X-ENDLIST'].join('\n');
	const out = rewriteHlsManifest(body, base);
	ok(out.includes(`u=${encodeURIComponent('https://live09p.hotstar.com/live/abc/seg-1.ts')}`), 'rewrite: relative segment resolved + proxied');
	ok(out.includes(`u=${encodeURIComponent('https://live09p.hotstar.com/live/abc/seg-2.ts')}`), 'rewrite: second relative segment proxied');
	ok(out.includes('#EXTM3U') && out.includes('#EXTINF:6.0,'), 'rewrite: tags preserved verbatim');
}

// absolute segment → proxied (still)
{
	const body = ['#EXTM3U', 'https://cdn.hotstar.com/abs/seg.ts'].join('\n');
	const out = rewriteHlsManifest(body, base);
	ok(out.includes(`u=${encodeURIComponent('https://cdn.hotstar.com/abs/seg.ts')}`), 'rewrite: absolute segment proxied');
}

// master playlist: variant URI line + EXT-X-KEY + EXT-X-MAP URIs
{
	const body = [
		'#EXTM3U',
		'#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
		'#EXT-X-MAP:URI="init.mp4"',
		'#EXT-X-STREAM-INF:BANDWIDTH=1280000',
		'v1/index.m3u8'
	].join('\n');
	const out = rewriteHlsManifest(body, base);
	ok(out.includes(`URI="${LIVETV_STREAM_PROXY_PATH}?u=${encodeURIComponent('https://live09p.hotstar.com/live/abc/key.bin')}"`), 'rewrite: EXT-X-KEY URI proxied');
	ok(out.includes(`URI="${LIVETV_STREAM_PROXY_PATH}?u=${encodeURIComponent('https://live09p.hotstar.com/live/abc/init.mp4')}"`), 'rewrite: EXT-X-MAP URI proxied');
	ok(out.includes(`u=${encodeURIComponent('https://live09p.hotstar.com/live/abc/v1/index.m3u8')}`), 'rewrite: variant playlist URI proxied');
	ok(out.includes('METHOD=AES-128'), 'rewrite: non-URI attributes preserved');
}

// blank lines + CRLF tolerated
{
	const out = rewriteHlsManifest('#EXTM3U\r\n\r\nseg.ts\r\n', base);
	ok(out.includes('u='), 'rewrite: CRLF handled');
}

// referer replay (&r=) — segments carry the SAME Referer that loaded the manifest
{
	const ref = 'https://premiumplugx.com/';
	const out = rewriteHlsManifest('#EXTM3U\nseg.ts\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin"', base, ref);
	const marker = `&r=${encodeURIComponent(ref)}`;
	ok(out.includes(marker), 'referer: &r= embedded on rewritten URIs');
	ok((out.split(marker).length - 1) >= 2, 'referer: &r= applied to every rewritten line (segment + key)');
}

console.log(`\nHLS stream proxy suite: ${passed} checks PASS`);
