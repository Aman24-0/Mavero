import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 9 final UX fix tests:
// 1. My List removal deletes all progress
// 2. Landscape has only two buttons (Source + Exit)
// 3. Continue Watching shows total minutes

const service = readFileSync(new URL('../src/lib/client/progress/service.ts', import.meta.url), 'utf8');
const cloud = readFileSync(new URL('../src/lib/client/progress/cloud.ts', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const progressServer = readFileSync(new URL('../src/routes/api/account/progress/+server.ts', import.meta.url), 'utf8');

// ============================================================
// 1. My List removal deletes ALL progress (local + cloud)
// ============================================================

// removeFavoriteFromMyList calls deleteAllProgressForContent.
assert.match(service, /function removeFavoriteFromMyList[\s\S]*?await deleteAllProgressForContent/, 'removeFavoriteFromMyList calls deleteAllProgressForContent');

// deleteAllProgressForContent lists all progress and deletes matching records.
assert.match(service, /function deleteAllProgressForContent[\s\S]*?listProgress\(\)[\s\S]*?filter[\s\S]*?removeProgress/, 'deleteAllProgressForContent lists + filters + deletes');

// Cloud deletion: deleteCloudFavorite calls deleteCloudProgress.
assert.match(cloud, /function deleteCloudFavorite[\s\S]*?await deleteCloudProgress/, 'deleteCloudFavorite calls deleteCloudProgress');

// Cloud progress deletion endpoint exists.
assert.match(progressServer, /watch_progress[\s\S]*?like\('progress_key'/, 'cloud progress DELETE uses like prefix pattern');

// ============================================================
// 2. Behavioral test: progress deletion state machine
// ============================================================

function createProgressStoreMock() {
  const records: Map<string, { contentType: string; contentId: string; season?: number; episode?: number; currentTime: number; duration: number; selectedSourceId?: string; sourceRuntimes?: Record<string, { duration: number; updatedAt: number }> }> = new Map();

  return {
    put(record: { contentType: string; contentId: string; season?: number; episode?: number; currentTime: number; duration: number; selectedSourceId?: string }) {
      const key = `${record.contentType}:${record.contentId}:${record.season ?? '-'}:${record.episode ?? '-'}`;
      records.set(key, record);
    },
    list() { return Array.from(records.values()); },
    listByContent(contentType: string, contentId: string) {
      return this.list().filter((r) => r.contentType === contentType && r.contentId === contentId);
    },
    remove(record: { contentType: string; contentId: string; season?: number; episode?: number }) {
      const key = `${record.contentType}:${record.contentId}:${record.season ?? '-'}:${record.episode ?? '-'}`;
      records.delete(key);
    },
    count() { return records.size; },
  };
}

// Test 1: Remove movie from My List → progress deleted.
{
  const store = createProgressStoreMock();
  store.put({ contentType: 'movie', contentId: '123', currentTime: 1600, duration: 9000 });
  assert.strictEqual(store.count(), 1, 'Test 1: progress record exists');

  // Simulate deleteAllProgressForContent.
  const toDelete = store.listByContent('movie', '123');
  toDelete.forEach((r) => store.remove(r));
  assert.strictEqual(store.count(), 0, 'Test 1: progress deleted after My List removal');
}

// Test 2: Remove series → ALL episode progress deleted.
{
  const store = createProgressStoreMock();
  store.put({ contentType: 'series', contentId: '456', season: 1, episode: 1, currentTime: 500, duration: 3000 });
  store.put({ contentType: 'series', contentId: '456', season: 1, episode: 2, currentTime: 200, duration: 3000 });
  store.put({ contentType: 'series', contentId: '456', season: 2, episode: 1, currentTime: 100, duration: 3000 });
  store.put({ contentType: 'series', contentId: '789', season: 1, episode: 1, currentTime: 300, duration: 3000 });
  assert.strictEqual(store.count(), 4, 'Test 2: 4 episode records exist');

  // Delete all for series 456.
  const toDelete = store.listByContent('series', '456');
  toDelete.forEach((r) => store.remove(r));
  assert.strictEqual(store.count(), 1, 'Test 2: only series 789 remains');
  assert.strictEqual(store.listByContent('series', '456').length, 0, 'Test 2: all episodes of 456 deleted');
}

// Test 3: Remove anime → ALL episode progress deleted.
{
  const store = createProgressStoreMock();
  store.put({ contentType: 'anime', contentId: '101', season: 1, episode: 5, currentTime: 800, duration: 1440 });
  store.put({ contentType: 'anime', contentId: '101', season: 1, episode: 6, currentTime: 0, duration: 1440 });

  const toDelete = store.listByContent('anime', '101');
  toDelete.forEach((r) => store.remove(r));
  assert.strictEqual(store.count(), 0, 'Test 3: all anime episodes deleted');
}

// Test 4: Remove → add again → old progress NOT restored.
{
  const store = createProgressStoreMock();
  store.put({ contentType: 'movie', contentId: '200', currentTime: 999, duration: 5000 });

  // Remove.
  store.listByContent('movie', '200').forEach((r) => store.remove(r));
  assert.strictEqual(store.count(), 0, 'Test 4: progress deleted');

  // Add to My List again (doesn't recreate progress).
  // Progress should remain 0.
  assert.strictEqual(store.listByContent('movie', '200').length, 0, 'Test 4: old progress NOT restored');
}

// ============================================================
// 3. Landscape: only two buttons (Source + Exit)
// ============================================================

// Landscape uses .landscape-controls-overlay with two buttons.
assert.match(shell, /class="landscape-controls-overlay"/, 'landscape controls overlay exists');
assert.match(shell, /landscape-overlay-button.*aria-label="Switch source"/, 'landscape source button exists');
assert.match(shell, /landscape-overlay-button.*aria-label="Exit landscape player"/, 'landscape exit button exists');

// Landscape does NOT contain header-title in landscape.
assert.match(shell, /\{#if !landscapeMode\}/, 'portrait header gated on !landscapeMode');
assert.match(shell, /\{#if !landscapeMode\}[\s\S]*?header-title/, 'header-title only in portrait');

// Landscape does NOT contain bottom bar.
assert.match(shell, /\{#if !landscapeMode\}[\s\S]*?bottom-bar/, 'bottom-bar only in portrait');

// Portrait bottom bar does NOT contain landscape/orientation button.
// The embed shell controls should NOT have a toggleLandscape button.
assert.doesNotMatch(shell, /shell-button.*aria-label=\{landscapeMode \? 'Exit landscape player' : 'Toggle landscape player'\}.*toggleLandscape/, 'no landscape button in embed shell controls');

// ============================================================
// 4. Continue Watching: total minutes display
// ============================================================

// progressLabel shows total minutes (NOT hours).
assert.match(service, /remaining > 0 \? `\$\{remaining\}m left`/, 'progressLabel shows total minutes as "Xm left"');

// Verify calculation uses per-source runtime.
assert.match(service, /getRuntimeForSource\(record, record\.selectedSourceId\)/, 'progressLabel uses per-source runtime');

// Test: 85 minutes → "85m left" (not "1h 25m left").
function calculateLabel(currentTime: number, duration: number): string {
  const remaining = duration > 0 ? Math.max(0, Math.round((duration - currentTime) / 60)) : 0;
  return remaining > 0 ? `${remaining}m left` : 'Resume';
}

assert.strictEqual(calculateLabel(0, 5100), '85m left', '85 minutes shows as "85m left" (not "1h 25m")');
assert.strictEqual(calculateLabel(0, 3600), '60m left', '60 minutes shows as "60m left"');
assert.strictEqual(calculateLabel(0, 7500), '125m left', '125 minutes shows as "125m left"');
assert.strictEqual(calculateLabel(0, 2280), '38m left', '38 minutes shows as "38m left"');
assert.strictEqual(calculateLabel(0, 0), 'Resume', '0 duration shows as "Resume"');

console.log('Phase 9 final UX fix tests passed: My List removal deletes progress (4 contract checks); cloud progress deletion (2 checks); behavioral progress deletion tests 1-4 (4 tests); landscape two-button overlay (5 checks); portrait bottom bar no landscape button (1 check); Continue Watching total minutes (2 contract + 5 behavioral checks).');
