import assert from 'node:assert/strict';
import { formatPlayerTime, playbackSpeeds, type PlayerSource } from '$lib/shared/player';
import { isEmbedOriginAllowed, isPlayablePlayerSource, normalizePlayerSource, sourceIsExpired } from '$lib/shared/player-guards';
import { adjacentEpisode, clampSeek, stateForSource } from '$lib/shared/player-state';

const direct: PlayerSource = {
  type: 'direct',
  url: 'https://media.example.test/title.mp4',
  providerId: 'provider-direct',
  sourceId: 'source-direct',
  mediaType: 'movie',
  metadata: { protocol: 'mp4', sourceName: 'Mock direct' },
  subtitles: [{ url: 'https://media.example.test/title-en.vtt', language: 'en', label: 'English' }],
  qualities: [{ url: 'https://media.example.test/title-720.mp4', height: 720, label: '720p' }]
};

assert.equal(isPlayablePlayerSource(direct), true);
assert.deepEqual(normalizePlayerSource(direct), direct);
assert.equal(sourceIsExpired(direct), false);
assert.equal(isEmbedOriginAllowed(direct), false);

assert.equal(stateForSource(direct), 'preparing');
assert.equal(stateForSource({ ...direct, metadata: { protocol: 'hls' } }), 'preparing');
assert.equal(stateForSource(null), 'source-unavailable');
assert.equal(clampSeek(-5, 100), 0);
assert.equal(clampSeek(140, 100), 100);
assert.equal(clampSeek(12, 0), 12);

const episodes = [
  { id: 'e1', number: 1, season: 1, title: 'Arrival' },
  { id: 'e2', number: 2, season: 1, title: 'Signal' },
  { id: 'e3', number: 3, season: 1, title: 'Afterlight' }
];
assert.deepEqual(adjacentEpisode(episodes, { season: 1, episode: 2 }, -1), { season: 1, episode: 1, title: 'Arrival' });
assert.deepEqual(adjacentEpisode(episodes, { season: 1, episode: 2 }, 1), { season: 1, episode: 3, title: 'Afterlight' });
assert.equal(adjacentEpisode(episodes, { season: 1, episode: 1 }, -1), undefined);

const embed: PlayerSource = {
  type: 'embed',
  url: 'https://embed.example.test/watch/abc',
  providerId: 'provider-embed',
  sourceId: 'source-embed',
  mediaType: 'series',
  expiresAt: new Date(Date.now() + 60_000).toISOString()
};
assert.equal(isPlayablePlayerSource(embed), true);
assert.equal(isEmbedOriginAllowed(embed), true);
assert.equal(stateForSource(embed), 'embed-loading');
assert.equal(sourceIsExpired(embed), false);
assert.equal(sourceIsExpired({ ...embed, expiresAt: new Date(Date.now() - 60_000).toISOString() }), true);
assert.equal(stateForSource({ ...embed, expiresAt: new Date(Date.now() - 60_000).toISOString() }), 'source-unavailable');
assert.equal(stateForSource({ ...embed, url: 'http://embed.example.test/watch/abc' }), 'source-unavailable');

assert.equal(isPlayablePlayerSource({ ...direct, url: 'http://media.example.test/title.mp4' }), false);
assert.equal(isPlayablePlayerSource({ ...direct, url: 'javascript:alert(1)' }), false);
assert.equal(isPlayablePlayerSource({ ...direct, type: 'unavailable', url: null }), false);
assert.equal(normalizePlayerSource({ sourceId: 'arbitrary-client-url', url: 'https://attacker.example.test/video.mp4' }), null);

// Same-origin relative embed URLs (e.g. /api/playback/superembed?...) are valid
// for sources that use a server-side redirect bootstrap route. The browser
// resolves them against the page origin, so they are inherently same-origin
// and HTTPS when Mavero is served over HTTPS. This mirrors the server-side
// validatePlaybackUrl relative-URL allowance in safe-url.ts.
const relativeEmbed: PlayerSource = {
  type: 'embed',
  url: '/api/playback/superembed?video_id=522931&tmdb=1',
  providerId: 'provider-superembed-advanced',
  sourceId: 'source-superembed-advanced',
  mediaType: 'movie',
  sandboxPolicy: 'required',
};
assert.equal(isPlayablePlayerSource(relativeEmbed), true, 'relative same-origin embed URL must be playable');
assert.deepEqual(normalizePlayerSource(relativeEmbed), relativeEmbed);
assert.equal(isEmbedOriginAllowed(relativeEmbed), true, 'relative same-origin embed URL must be allowed');

const relativeEpisode: PlayerSource = {
  type: 'embed',
  url: '/api/playback/superembed?video_id=60625&tmdb=1&s=5&e=5',
  providerId: 'provider-superembed-advanced',
  sourceId: 'source-superembed-advanced',
  mediaType: 'series',
  sandboxPolicy: 'required',
};
assert.equal(isPlayablePlayerSource(relativeEpisode), true);
assert.equal(isEmbedOriginAllowed(relativeEpisode), true);

// Protocol-relative URLs (//evil.com/...) must NOT be treated as same-origin.
assert.equal(isPlayablePlayerSource({ ...relativeEmbed, url: '//evil.example.test/path' }), false, 'protocol-relative URL must be rejected');
assert.equal(isEmbedOriginAllowed({ ...relativeEmbed, url: '//evil.example.test/path' }), false);
// Whitespace / backslash / overly-long relative URLs must be rejected.
assert.equal(isPlayablePlayerSource({ ...relativeEmbed, url: '/api/playback/\tsuperembed' }), false, 'relative URL with whitespace must be rejected');
assert.equal(isPlayablePlayerSource({ ...relativeEmbed, url: '/api/' + 'a'.repeat(2100) }), false, 'overly-long relative URL must be rejected');
assert.equal(isPlayablePlayerSource({ ...relativeEmbed, url: '/api/playback/\\superembed' }), false, 'relative URL with backslash must be rejected');

// Exhaustive FAIL cases for the embed context (mirrors the user's requirement list).
assert.equal(isPlayablePlayerSource({ ...relativeEmbed, url: '//evil.example.com/path' }), false, 'protocol-relative must fail');
assert.equal(isPlayablePlayerSource({ ...relativeEmbed, url: 'http://evil.example.com/path' }), false, 'http must fail');
assert.equal(isPlayablePlayerSource({ ...relativeEmbed, url: 'javascript:alert(1)' }), false, 'javascript must fail');
assert.equal(isPlayablePlayerSource({ ...relativeEmbed, url: 'file:///etc/passwd' }), false, 'file must fail');
assert.equal(isPlayablePlayerSource({ ...relativeEmbed, url: '/api/play back' }), false, 'whitespace must fail');
assert.equal(isPlayablePlayerSource({ ...relativeEmbed, url: '/api/play\\back' }), false, 'backslash must fail');
assert.equal(isPlayablePlayerSource({ ...relativeEmbed, url: '/' + 'a'.repeat(2100) }), false, 'excessive length must fail');

// Explicit reproduction of the production bug: normalizePlayerSource must return
// a valid PlayerSource (not null) for the SuperEmbed Advanced relative URL.
const productionMovie = normalizePlayerSource({
  type: 'embed',
  url: '/api/playback/superembed?video_id=522931&tmdb=1',
  providerId: 'provider-superembed-advanced',
  sourceId: 'source-superembed-advanced',
  mediaType: 'movie',
  sandboxPolicy: 'required',
});
assert.ok(productionMovie !== null, 'normalizePlayerSource must not return null for the Advanced movie URL');
assert.equal(productionMovie?.url, '/api/playback/superembed?video_id=522931&tmdb=1');
assert.equal(isEmbedOriginAllowed(productionMovie!), true, 'isEmbedOriginAllowed must return true for the Advanced movie URL');

const productionEpisode = normalizePlayerSource({
  type: 'embed',
  url: '/api/playback/superembed?video_id=60625&tmdb=1&s=5&e=5',
  providerId: 'provider-superembed-advanced',
  sourceId: 'source-superembed-advanced',
  mediaType: 'series',
  sandboxPolicy: 'required',
});
assert.ok(productionEpisode !== null, 'normalizePlayerSource must not return null for the Advanced episode URL');
assert.equal(productionEpisode?.url, '/api/playback/superembed?video_id=60625&tmdb=1&s=5&e=5');
assert.equal(isEmbedOriginAllowed(productionEpisode!), true, 'isEmbedOriginAllowed must return true for the Advanced episode URL');

assert.deepEqual(playbackSpeeds, [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
assert.equal(formatPlayerTime(0), '0:00');
assert.equal(formatPlayerTime(65), '1:05');
assert.equal(formatPlayerTime(3661), '1:01:01');

console.log('Phase 7C player contract tests passed.');
