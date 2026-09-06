import { discoverPublicPage } from '../src/lib/server/discovery/service';

const targets = [
  { label: 'movie', url: 'https://bingr.one/watch/movie/1493400' },
  { label: 'tv', url: 'https://bingr.one/watch/tv/95350/1/1' },
] as const;

for (const target of targets) {
  try {
    const result = await discoverPublicPage({ pageUrl: target.url, timeoutMs: 8000 });
    console.log(JSON.stringify({ ...target, streams: result.streams, diagnostics: result.diagnostics }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ ...target, error: error instanceof Error ? error.message : String(error) }, null, 2));
  }
}
