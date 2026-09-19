/**
 * Phase 2 — Scraper extraction engine: shared types.
 *
 * Each scraper module exports a function that simulates a network delay
 * (randomized 2–8 seconds) and resolves with a mock stream result. In a
 * future phase these will be replaced with real extraction logic.
 */

export type ExtractResult = {
  provider: string;
  url: string;
  type: 'hls' | 'mp4' | 'embed';
};

export type ExtractError = {
  provider: string;
  error: string;
};

export type ExtractParams = {
  tmdbId: string;
  mediaType: 'movie' | 'series';
  season?: number;
  episode?: number;
};

/**
 * Dummy extract helper — shared by all Phase 2 scrapers.
 * Returns a promise that resolves after a randomized 2–8 second delay
 * with a mock ExtractResult, or rejects with an ExtractError.
 *
 * In Phase 2, 80% of calls succeed and 20% fail (to exercise both
 * card states in the frontend).
 */
export function dummyExtract(
  providerName: string,
  mockUrl: string = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
): Promise<ExtractResult> {
  const delay = 2000 + Math.random() * 6000; // 2–8 seconds
  const shouldSucceed = Math.random() > 0.2; // 80% success rate

  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (shouldSucceed) {
        resolve({ provider: providerName, url: mockUrl, type: 'hls' });
      } else {
        reject({ provider: providerName, error: 'No stream found' });
      }
    }, delay);
  });
}
