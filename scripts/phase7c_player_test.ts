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

assert.deepEqual(playbackSpeeds, [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
assert.equal(formatPlayerTime(0), '0:00');
assert.equal(formatPlayerTime(65), '1:05');
assert.equal(formatPlayerTime(3661), '1:01:01');

console.log('Phase 7C player contract tests passed.');
