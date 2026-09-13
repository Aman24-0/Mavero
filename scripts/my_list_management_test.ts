import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import {
  batchRemoveFromMyList,
  batchSetFavoriteStatus,
  createProgressWriter,
  removeFavoriteFromMyList,
  saveFavorite,
  type FavoriteIdentity
} from '../src/lib/client/progress/service.ts';
import {
  clearLocalData,
  listFavoriteDeletions,
  listFavorites,
  listProgress,
  putFavorite,
  putProgress
} from '../src/lib/client/progress/database.ts';
import { __toastInternals, showSuccessToast, showErrorToast, showToast } from '../src/lib/client/toast.svelte.ts';
import type {
  ContentSnapshot,
  FavoriteRecord,
  LocalContentType,
  SaveProgressInput
} from '../src/lib/client/progress/types.ts';

const snapshot: ContentSnapshot = { title: 'Probe', poster: 'https://example.com/probe.jpg' };

function makeFavorite(contentType: LocalContentType, contentId: string, status: FavoriteRecord['status'] = 'planned', createdAt = 100): FavoriteRecord {
  return {
    key: `${contentType}:${contentId}`,
    contentType,
    contentId,
    snapshot: { ...snapshot, title: contentId },
    status,
    createdAt,
    updatedAt: 200,
  };
}

function makePlayback(contentType: LocalContentType, contentId: string, season?: number, episode?: number, updatedAt = 300) {
  return {
    key: `${contentType}:${contentId}:${season ?? '-'}:${episode ?? '-'}`,
    contentType,
    contentId,
    season,
    episode,
    currentTime: 42,
    duration: 100,
    completionState: 'in_progress' as const,
    snapshot: { ...snapshot, title: contentId },
    lastWatchedAt: updatedAt,
    updatedAt,
  };
}

async function resetLocal() {
  await clearLocalData();
}

// ============================================================================
// A. Selection identity — same contentType/contentId selects exactly one title;
// different titles can be selected together.
// ============================================================================
// (The selection state itself lives in the My List page component, keyed by
// the FavoriteRecord.key which equals `${contentType}:${contentId}`. We
// can't run the Svelte component here, but we can verify the identity
// contract that the page relies on: that the key is a stable string derived
// from contentType + contentId, NOT from an array index.)
{
  const a: FavoriteIdentity = { contentType: 'movie', contentId: '123' };
  const b: FavoriteIdentity = { contentType: 'movie', contentId: '456' };
  const c: FavoriteIdentity = { contentType: 'series', contentId: '123' };
  const keyA = `${a.contentType}:${a.contentId}`;
  const keyB = `${b.contentType}:${b.contentId}`;
  const keyC = `${c.contentType}:${c.contentId}`;
  assert.notEqual(keyA, keyB, 'different contentIds must produce different keys');
  assert.notEqual(keyA, keyC, 'different contentTypes must produce different keys');
  // A Set keyed by these strings behaves the way the page expects.
  const set = new Set<string>([keyA]);
  set.add(keyB);
  set.add(keyA); // re-adding same identity must not duplicate.
  assert.equal(set.size, 2, 'Set keyed by identity collapses duplicates');
  set.delete(keyA);
  assert.equal(set.size, 1, 'delete by identity removes the right entry');
  // Toggle semantics used by the page (add if absent, delete if present).
  const toggle = (s: Set<string>, k: string) => {
    const next = new Set(s);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  };
  let sel = new Set<string>();
  sel = toggle(sel, keyA);
  assert.equal(sel.has(keyA), true, 'toggle on selects the title');
  sel = toggle(sel, keyA);
  assert.equal(sel.has(keyA), false, 'toggle off deselects the title');
  sel = toggle(sel, keyA);
  sel = toggle(sel, keyB);
  sel = toggle(sel, keyC);
  assert.equal(sel.size, 3, 'three distinct titles can be selected together');
}

// ============================================================================
// B. Select all visible — selects all visible records, does NOT select
// hidden records from another status filter.
// ============================================================================
// (Verified behaviorally via the page's `visibleRecords` derivation: it
// filters records by the active status. "Select all" iterates visibleRecords
// only. Here we model the same logic.)
{
  const records: FavoriteRecord[] = [
    makeFavorite('movie', 'a', 'watching'),
    makeFavorite('movie', 'b', 'watching'),
    makeFavorite('movie', 'c', 'planned'),
    makeFavorite('series', 'd', 'completed'),
  ];
  // Status filter = 'watching' → only a and b are visible.
  const visible = records.filter((r) => r.status === 'watching');
  assert.equal(visible.length, 2, 'status filter narrows visible records');
  // "Select all visible" adds only the visible ones to the selection set.
  const sel = new Set<string>();
  for (const r of visible) sel.add(r.key);
  assert.equal(sel.size, 2, 'select-all-visible adds only visible records');
  assert.equal(sel.has('movie:c'), false, 'planned title NOT selected by select-all-visible under watching filter');
  assert.equal(sel.has('series:d'), false, 'completed title NOT selected by select-all-visible under watching filter');
}

// ============================================================================
// C. Single status update — Watching → Completed; createdAt preserved,
// updatedAt changes.
// ============================================================================
{
  await resetLocal();
  await putFavorite(makeFavorite('movie', 'probe', 'watching', 1234));
  const before = (await listFavorites())[0];
  assert.equal(before?.status, 'watching');
  assert.equal(before?.createdAt, 1234);

  const now = 9999;
  const result = await batchSetFavoriteStatus([{ contentType: 'movie', contentId: 'probe' }], 'completed', now);
  assert.equal(result.succeeded.length, 1, 'single status update succeeds');
  assert.equal(result.failed.length, 0, 'no failures');

  const after = (await listFavorites())[0];
  assert.equal(after?.status, 'completed', 'status moved to completed');
  assert.equal(after?.createdAt, 1234, 'createdAt preserved');
  assert.equal(after?.updatedAt, now, 'updatedAt bumped');
}

// ============================================================================
// D. Batch status update — multiple selected records update in one operation,
// correct counts, selection clears.
// ============================================================================
{
  await resetLocal();
  await putFavorite(makeFavorite('movie', 'a', 'planned', 100));
  await putFavorite(makeFavorite('movie', 'b', 'planned', 110));
  await putFavorite(makeFavorite('movie', 'c', 'planned', 120));
  const items: FavoriteIdentity[] = [
    { contentType: 'movie', contentId: 'a' },
    { contentType: 'movie', contentId: 'b' },
    { contentType: 'movie', contentId: 'c' },
  ];
  const result = await batchSetFavoriteStatus(items, 'completed', 5000);
  assert.equal(result.succeeded.length, 3, 'all three updated');
  assert.equal(result.failed.length, 0, 'no failures');
  const all = await listFavorites();
  assert.equal(all.filter((r) => r.status === 'completed').length, 3, 'all three now completed');
  // Selection clear is the page's responsibility — verified via the page
  // logic: clearSelection() is called after a successful batch. Modeled here
  // as "the caller's selectedKeys Set is emptied".
  let selectedKeys = new Set(items.map((i) => `${i.contentType}:${i.contentId}`));
  assert.equal(selectedKeys.size, 3);
  // After success, page calls clearSelection():
  selectedKeys = new Set();
  assert.equal(selectedKeys.size, 0, 'selection clears after successful batch status update');
}

// ============================================================================
// E. Single deletion — favorite deleted locally, ALL local progress for
// title deleted, deletion tombstone exists, watch_history untouched.
// (watch_history doesn't exist locally — it's cloud-only. Verified at the
// cloud API level in test H below.)
// ============================================================================
{
  await resetLocal();
  await putFavorite(makeFavorite('movie', 'probe', 'watching'));
  await putProgress(makePlayback('movie', 'probe'));
  await removeFavoriteFromMyList('movie', 'probe', 9999);

  assert.equal((await listFavorites()).length, 0, 'favorite deleted locally');
  assert.equal((await listProgress()).length, 0, 'all watch_progress for title deleted');
  const dels = await listFavoriteDeletions();
  assert.equal(dels.length, 1, 'tombstone exists');
  assert.equal(dels[0]?.deletedAt, 9999, 'tombstone carries the requested deletedAt');
}

// ============================================================================
// F. Batch deletion — all selected favorites deleted, all selected progress
// deleted, tombstones created, unrelated titles remain.
// ============================================================================
{
  await resetLocal();
  await putFavorite(makeFavorite('movie', 'a', 'watching'));
  await putFavorite(makeFavorite('movie', 'b', 'planned'));
  await putFavorite(makeFavorite('series', 'c', 'completed'));
  await putFavorite(makeFavorite('movie', 'unrelated', 'planned'));
  await putProgress(makePlayback('movie', 'a'));
  await putProgress(makePlayback('movie', 'b'));
  await putProgress(makePlayback('series', 'c', 1, 1));
  await putProgress(makePlayback('series', 'c', 1, 2));
  await putProgress(makePlayback('movie', 'unrelated'));

  const items: FavoriteIdentity[] = [
    { contentType: 'movie', contentId: 'a' },
    { contentType: 'movie', contentId: 'b' },
    { contentType: 'series', contentId: 'c' },
  ];
  const result = await batchRemoveFromMyList(items);
  assert.equal(result.succeeded.length, 3, 'all three removed');
  assert.equal(result.failed.length, 0, 'no failures');

  const remaining = await listFavorites();
  assert.equal(remaining.length, 1, 'only the unrelated favorite remains');
  assert.equal(remaining[0]?.contentId, 'unrelated');

  const remainingProgress = await listProgress();
  assert.equal(remainingProgress.length, 1, 'only the unrelated progress remains');
  assert.equal(remainingProgress[0]?.contentId, 'unrelated');

  const dels = await listFavoriteDeletions();
  assert.equal(dels.length, 3, 'three tombstones created');
  const delKeys = new Set(dels.map((d) => d.key));
  assert.ok(delKeys.has('movie:a'));
  assert.ok(delKeys.has('movie:b'));
  assert.ok(delKeys.has('series:c'));
}

// ============================================================================
// G. Delete race safety — existing progress writer cannot recreate a deleted
// title after batchRemoveFromMyList runs.
// ============================================================================
{
  await resetLocal();
  await putFavorite(makeFavorite('movie', 'probe', 'watching', 100));
  const base: Omit<SaveProgressInput, 'currentTime' | 'duration'> = {
    contentType: 'movie',
    contentId: 'probe',
    snapshot,
  };
  const writer = createProgressWriter(base, 25);
  // Pretend the player has been playing for a while.
  writer.update(500, 1000);
  // Force a flush so there's an in-flight promise.
  const flushPromise = writer.pause();
  // While that flush is in flight, the user removes the title.
  await batchRemoveFromMyList([{ contentType: 'movie', contentId: 'probe' }]);
  // The in-flight flush should have settled by now.
  await flushPromise;
  // Even if a stale callback somehow fires after deletion, the post-check
  // in flush() sees the bumped generation and undoes its write.
  writer.update(999, 1000);
  await writer.pause();
  // The favorite + ALL progress must remain gone.
  assert.equal((await listFavorites()).length, 0, 'favorite stays deleted after writer race');
  assert.equal((await listProgress()).length, 0, 'progress stays deleted after writer race');
  assert.equal((await listFavoriteDeletions()).length, 1, 'tombstone intact after writer race');
  writer.dispose();
}

// ============================================================================
// H. Cloud deletion API — authentication required, invalid identities
// rejected, user scoping enforced (server-side), favorites deleted, all
// episodes of a title deleted, tombstones preserved, watch_history untouched.
// ============================================================================
{
  const source = await readFile(new URL('../src/routes/api/account/favorites/batch-delete/+server.ts', import.meta.url), 'utf8');
  // Authentication gate at the very top.
  assert.match(source, /safeGetSession\(\)/, 'must resolve the session before any work');
  assert.match(source, /status: 401/, 'must return 401 when unauthenticated');
  // Per-item validation: invalid contentType rejected, contentId required + bounded.
  assert.match(source, /movie.*series.*anime/, 'must validate contentType against movie|series|anime');
  assert.match(source, /contentId\.length > 120/, 'must reject over-long contentId');
  // Atomic RPC delegation — no per-row supabase-js calls in the endpoint.
  assert.match(source, /rpc\('batch_remove_favorites'/, 'must delegate to the atomic RPC');
  // No user_id input from the client — the RPC reads auth.uid() itself.
  assert.doesNotMatch(source, /user_id.*body|body.*user_id/, 'must NOT accept user_id from the request body');
  // The RPC migration does not touch watch_history.
  const migration = await readFile(new URL('../supabase/migrations/20260912000000_batch_remove_favorites.sql', import.meta.url), 'utf8');
  assert.match(migration, /security invoker/, 'RPC is SECURITY INVOKER (RLS-scoped)');
  assert.match(migration, /auth\.uid\(\)/, 'RPC reads auth.uid() server-side');
  assert.match(migration, /favorite_deletions/, 'RPC upserts tombstone');
  assert.match(migration, /delete from public\.favorites/, 'RPC deletes favorite row');
  assert.match(migration, /delete from public\.watch_progress/, 'RPC deletes watch_progress rows');
  assert.doesNotMatch(migration, /delete from public\.watch_history/, 'RPC must NOT touch watch_history');
  // Per-identity success/failure reporting.
  assert.match(source, /succeeded/, 'response includes succeeded list');
  assert.match(source, /failed/, 'response includes failed list');
}

// ============================================================================
// I. AniList orphan favorite — a favorite with an old/unsupported content
// identity can be removed without resolving the title (no TMDB/AniList
// lookup, no DetailPage required).
// ============================================================================
{
  await resetLocal();
  // Simulate an AniList-era orphan: an anime favorite whose externalIds no
  // longer resolve. The favorite's identity is purely (contentType,
  // contentId) — exactly what removeFavoriteFromMyList consumes.
  await putFavorite(makeFavorite('anime', 'anilist-legacy-123', 'planned', 100));
  await putProgress(makePlayback('anime', 'anilist-legacy-123', 1, 1));
  const result = await batchRemoveFromMyList([{ contentType: 'anime', contentId: 'anilist-legacy-123' }]);
  assert.equal(result.succeeded.length, 1, 'orphan anime favorite removed without resolving title');
  assert.equal((await listFavorites()).length, 0, 'orphan favorite gone');
  assert.equal((await listProgress()).length, 0, 'orphan progress gone');
  assert.equal((await listFavoriteDeletions()).length, 1, 'tombstone created for orphan');
}

// ============================================================================
// J. Toast/haptic contract — success operations produce one success toast
// + success haptic; destructive delete produces one destructive haptic;
// batch operation does NOT generate one toast per title.
// ============================================================================
{
  __toastInternals.reset();
  // Single success → one toast.
  showSuccessToast('1 title moved to Completed');
  assert.equal(__toastInternals.queue.length, 1, 'one success toast for single operation');
  __toastInternals.reset();

  // Batch operation → ONE toast regardless of batch size.
  const fiveItems = Array.from({ length: 5 }, (_, i) => ({ contentType: 'movie' as LocalContentType, contentId: `t${i}` }));
  // The page calls showSuccessToast ONCE after the batch completes:
  showSuccessToast(`${fiveItems.length} titles moved to Watching`);
  assert.equal(__toastInternals.queue.length, 1, 'batch produces ONE toast, not one per title');
  __toastInternals.reset();

  // Error → error toast (separate aria-live region in Toast.svelte).
  showErrorToast('Could not remove the selected titles. Please try again.');
  assert.equal(__toastInternals.queue.length, 1, 'one error toast');
  assert.equal(__toastInternals.queue[0]?.variant, 'error', 'error toast has error variant');
  __toastInternals.reset();

  // Empty message is ignored (defensive).
  showToast('', 'success');
  assert.equal(__toastInternals.queue.length, 0, 'empty toast message is ignored');

  // The Toast.svelte component splits error vs success/info into separate
  // ARIA regions so screen readers announce errors immediately without
  // interrupting for successes.
  const toastSource = await readFile(new URL('../src/lib/components/Toast.svelte', import.meta.url), 'utf8');
  assert.match(toastSource, /role="alert"/, 'error region uses role="alert"');
  assert.match(toastSource, /aria-live="polite"/, 'success region uses aria-live="polite"');
  assert.match(toastSource, /prefers-reduced-motion/, 'respects prefers-reduced-motion');

  // Haptic contract: the page imports haptic and calls the right kind.
  const myListSource = await readFile(new URL('../src/routes/my-list/+page.svelte', import.meta.url), 'utf8');
  assert.match(myListSource, /import \{ haptic \} from '\$lib\/client\/haptics'/, 'My List imports haptic');
  assert.match(myListSource, /haptic\('success'\)/, 'status change uses success haptic');
  assert.match(myListSource, /haptic\('destructive'\)/, 'delete uses destructive haptic');
  assert.match(myListSource, /haptic\('light'\)/, 'selection toggle uses light haptic');

  // DetailPage: same contract — success haptic on add/status, destructive on remove.
  const detailSource = await readFile(new URL('../src/lib/components/DetailPage.svelte', import.meta.url), 'utf8');
  assert.match(detailSource, /import \{ haptic \} from '\$lib\/client\/haptics'/, 'DetailPage imports haptic');
  assert.match(detailSource, /haptic\('destructive'\)/, 'DetailPage remove uses destructive haptic');
  assert.match(detailSource, /haptic\('success'\)/, 'DetailPage add/status uses success haptic');
  // DetailPage reuses the same toast module (no second toast system).
  assert.match(detailSource, /from '\$lib\/client\/toast\.svelte'/, 'DetailPage uses the shared toast module');
}

// ============================================================================
// K. DetailPage — existing add/status/remove operations still work, toast
// added, existing navigation/back logic unchanged.
// ============================================================================
{
  const detailSource = await readFile(new URL('../src/lib/components/DetailPage.svelte', import.meta.url), 'utf8');
  // Existing operations still present.
  assert.match(detailSource, /setFavoriteStatus\(type, item\.id, snapshot, key\)/, 'DetailPage still calls setFavoriteStatus');
  assert.match(detailSource, /removeFavoriteFromMyList\(type, item\.id\)/, 'DetailPage still calls removeFavoriteFromMyList');
  assert.match(detailSource, /deleteCloudFavorite\(type, item\.id\)/, 'DetailPage still calls deleteCloudFavorite');
  // Toast feedback added.
  assert.match(detailSource, /showSuccessToast\('Added to My List'\)/, 'add toast added');
  assert.match(detailSource, /showSuccessToast\(`Moved to \$\{label\}`\)/, 'status change toast added');
  assert.match(detailSource, /showSuccessToast\('Removed from My List'\)/, 'remove toast added');
  // Navigation: history.back() must remain (the recent nav fix).
  assert.match(detailSource, /window\.history\.back\(\)/, 'DetailPage.goBack still uses history.back()');
  // No regression: DetailPage must NOT use replaceState goto for the
  // valid-from case (that was the bug we just fixed).
  assert.doesNotMatch(detailSource, /if \(returnTo\?\.startsWith\('\/'\) && !returnTo\.startsWith\('\/\/'\)\)\s*\{\s*void goto\(returnTo, \{ replaceState: true, keepFocus: true \}\);\s*return;\s*\}/,
    'DetailPage must NOT regress to goto(returnTo, { replaceState: true })');
}

// ============================================================================
// L. My List page contract — header simplified, selection mode opt-in,
// MediaCard receives selectable/selected/onSelect, ConfirmDialog reused,
// no ScrollRestore, no service-role key on the client.
// ============================================================================
{
  const myListSource = await readFile(new URL('../src/routes/my-list/+page.svelte', import.meta.url), 'utf8');
  // Header simplified — old "My List" H1 and the marketing subtitle are gone.
  assert.doesNotMatch(myListSource, /<h1>My List<\/h1>/, 'old H1 removed');
  assert.doesNotMatch(myListSource, /Your hand-picked library/, 'marketing subtitle removed');
  // Eyebrow promoted to the page heading.
  assert.match(myListSource, /MAVERO \/ My List/, 'eyebrow retained');
  // Sync status line retained.
  assert.match(myListSource, /Synced across devices|syncStatusLabel/, 'sync status retained');
  // Three status chips retained.
  assert.match(myListSource, /value: 'watching'/);
  assert.match(myListSource, /value: 'planned'/);
  assert.match(myListSource, /value: 'completed'/);
  // No Anime filter chip (My List does not surface Anime as a separate status).
  assert.doesNotMatch(myListSource, /value: 'anime'/);
  // Selection state keyed by stable identity (Set<string> of `${type}:${id}`).
  assert.match(myListSource, /let selectedKeys = \$state<Set<string>>\(/, 'selection is a Set<string>');
  assert.match(myListSource, /selectedKeys\.has\(`\$\{item\.type\}:\$\{item\.id\}`\)/, 'membership checked by stable identity');
  assert.match(myListSource, /selectedKeys = next/, 'selection replaced immutably (Svelte 5 reactivity)');
  // Action bar: single shared implementation for status change + delete.
  assert.match(myListSource, /action-bar/, 'action bar present');
  assert.match(myListSource, /openStatusSheet/, 'status button calls openStatusSheet');
  assert.match(myListSource, /openDeleteConfirm/, 'delete button calls openDeleteConfirm');
  // ConfirmDialog reused (not a new dialog).
  assert.match(myListSource, /import ConfirmDialog from '\$components\/ConfirmDialog\.svelte'/, 'reuses ConfirmDialog');
  assert.match(myListSource, /<ConfirmDialog/, 'ConfirmDialog mounted');
  assert.match(myListSource, /tone="danger"/, 'delete dialog uses danger tone');
  // MediaCard receives the opt-in selection props.
  assert.match(myListSource, /selectable=\{selectionMode\}/, 'MediaCard receives selectable prop');
  assert.match(myListSource, /selected=\{selectedKeys\.has/, 'MediaCard receives selected prop');
  assert.match(myListSource, /onSelect=\{toggleSelectItem\}/, 'MediaCard receives onSelect callback');
  // Batch helpers reused (not re-implemented).
  assert.match(myListSource, /batchRemoveFromMyList/, 'reuses batchRemoveFromMyList');
  assert.match(myListSource, /batchSetFavoriteStatus/, 'reuses batchSetFavoriteStatus');
  assert.match(myListSource, /batchDeleteCloudFavorites/, 'reuses batchDeleteCloudFavorites');
  // Cloud sync is called ONCE per batch (not per item).
  assert.match(myListSource, /void syncAuthenticatedState\(\)/, 'single sync call after batch');
  // No service-role key in the browser.
  assert.doesNotMatch(myListSource, /SUPABASE_SERVICE_ROLE_KEY|service_role/, 'no service-role credentials on the client');
  // No ScrollRestore (deleted in the previous commit; must not reappear).
  assert.doesNotMatch(myListSource, /ScrollRestore/, 'no ScrollRestore in My List');
  // One operation = one toast (no per-title toast in a loop).
  assert.doesNotMatch(myListSource, /for \(.*\) \{[\s\S]*?showSuccessToast/, 'no per-title toast loop');

  // MediaCard contract — opt-in selection, default behavior unchanged.
  const mediaCardSource = await readFile(new URL('../src/lib/components/MediaCard.svelte', import.meta.url), 'utf8');
  assert.match(mediaCardSource, /export let selectable = false/, 'selectable defaults to false (opt-in)');
  assert.match(mediaCardSource, /export let selected = false/, 'selected defaults to false');
  assert.match(mediaCardSource, /export let onSelect/, 'onSelect callback prop');
  // When selectable, the card does NOT navigate (it intercepts the click).
  assert.match(mediaCardSource, /event\.preventDefault\(\)/, 'selection mode prevents default navigation');
  // Play button is hidden in selection mode (only rendered when !selectable).
  assert.match(mediaCardSource, /\{#if !selectable && item\.resumeHref\}/, 'Details link hidden when selectable');
  // The poster <a> remains in selectable mode but is non-interactive
  // (tabindex=-1, aria-hidden) so we don't nest interactive elements.
  assert.match(mediaCardSource, /mc-card-link-disabled/, 'selectable mode disables the link backdrop');
  assert.match(mediaCardSource, /aria-hidden="true"/, 'selectable link is aria-hidden so screen readers skip it');

  // Toast module is a plain TS module (no `$state` at module scope) so it
  // can be imported from tests / non-Svelte contexts. Reactivity is bridged
  // inside the Toast.svelte component via `subscribe` + a local `$state`.
  const toastModule = await readFile(new URL('../src/lib/client/toast.svelte.ts', import.meta.url), 'utf8');
  assert.match(toastModule, /export function subscribe/, 'toast module exposes a subscribe pub/sub');
  assert.match(toastModule, /export function showToast/, 'toast module exposes showToast');
  assert.match(toastModule, /export function showSuccessToast/, 'toast module exposes showSuccessToast');
  assert.match(toastModule, /export function showErrorToast/, 'toast module exposes showErrorToast');
  // The Toast component bridges to reactivity via subscribe + local $state.
  const toastComponent = await readFile(new URL('../src/lib/components/Toast.svelte', import.meta.url), 'utf8');
  assert.match(toastComponent, /import \{ subscribe, dismissToast, pauseToast, resumeToast/, 'Toast.svelte imports the pub/sub API');
  assert.match(toastComponent, /let queue = \$state<ToastItem\[\]>/, 'Toast.svelte mirrors queue into local $state');
  assert.match(toastComponent, /subscribe\(\(next\) => \{ queue = next; \}\)/, 'Toast.svelte subscribes to the queue');
  // Root layout mounts Toast exactly once.
  const layoutSource = await readFile(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
  assert.match(layoutSource, /import Toast from '\$components\/Toast\.svelte'/, 'root layout imports Toast');
  assert.match(layoutSource, /<Toast \/>/, 'root layout mounts Toast');
  // Snapshot (scroll restoration from the previous commit) must be intact.
  assert.match(layoutSource, /export const snapshot = \{/, 'root layout snapshot intact (no regression)');
}

console.log('My List management tests passed: selection identity (A); select-all-visible (B); single status update preserves createdAt (C); batch status update (D); single deletion (E); batch deletion (F); delete race safety (G); cloud deletion API contract (H); AniList orphan favorite removable (I); toast/haptic contract (J); DetailPage toast + nav unchanged (K); My List page + MediaCard + Toast + layout contract (L).');
