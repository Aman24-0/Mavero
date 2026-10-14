import { favoriteKey, normalizeWatchlistStatus, type FavoriteDeletionRecord, type FavoriteRecord, type WatchProgressRecord, type CloudProgressRecord, type SourceRuntimeEntry } from '$lib/client/progress/types';
import { getLatestResumeTarget } from '$lib/client/progress/presenter';
import { resolvePositionConflict } from './progress-conflict';

// Phase 9: merge sourceRuntimes from both sides. For each source ID, prefer
// the entry with the newer updatedAt. This preserves runtimes from both
// local and cloud even if the record itself was chosen from one side.
function mergeSourceRuntimes(
  winner: WatchProgressRecord,
  loser: WatchProgressRecord | undefined,
): Record<string, SourceRuntimeEntry> | undefined {
  if (!loser?.sourceRuntimes) return winner.sourceRuntimes;
  if (!winner.sourceRuntimes) return loser.sourceRuntimes;
  const merged: Record<string, SourceRuntimeEntry> = { ...loser.sourceRuntimes };
  for (const [sourceId, entry] of Object.entries(winner.sourceRuntimes)) {
    const existing = merged[sourceId];
    if (!existing || entry.updatedAt >= existing.updatedAt) {
      merged[sourceId] = entry;
    }
  }
  return merged;
}

export function mergeProgress(local: WatchProgressRecord[], cloud: CloudProgressRecord[]) {
  const merged = new Map<string, WatchProgressRecord>();
  for (const record of [...local, ...cloud]) {
    const existing = merged.get(record.key);
    if (!existing) {
      merged.set(record.key, record);
    } else {
      // Cross-device conflict resolution: use the SHARED pure helper
      // (resolvePositionConflict) — the same ordering used by the
      // server-side compare-and-swap in /api/account/sync. This
      // guarantees client and server agree on which position wins.
      //
      // Ordering:
      //   1. Higher positionUpdatedAt wins.
      //   2. If equal, higher currentTime wins.
      //   3. If both equal, existing wins (preserve — never regress).
      //
      // Backward compatibility: when either side has positionUpdatedAt
      // = 0 (pre-migration records), the helper returns 'backward-compat'
      // and we fall back to the old updatedAt-based comparison.
      const recordPosTs = record.positionUpdatedAt ?? 0;
      const existingPosTs = existing.positionUpdatedAt ?? 0;
      const verdict = resolvePositionConflict(recordPosTs, existingPosTs, record.currentTime, existing.currentTime);
      let recordWins: boolean;
      if (verdict === 'backward-compat') {
        // Old behavior: compare by updatedAt, tiebreak by currentTime.
        recordWins = record.updatedAt > existing.updatedAt || (record.updatedAt === existing.updatedAt && record.currentTime > existing.currentTime);
      } else {
        recordWins = verdict === 'incoming-wins';
      }
      if (recordWins) {
        // New record wins — merge sourceRuntimes from the losing record.
        const mergedRuntimes = mergeSourceRuntimes(record, existing);
        merged.set(record.key, { ...record, sourceRuntimes: mergedRuntimes });
      } else {
        // Existing record wins — merge sourceRuntimes from the losing record.
        const mergedRuntimes = mergeSourceRuntimes(existing, record);
        merged.set(record.key, { ...existing, sourceRuntimes: mergedRuntimes });
      }
    }
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function mergeFavoriteDeletions(local: FavoriteDeletionRecord[], cloud: FavoriteDeletionRecord[]) {
  const merged = new Map<string, FavoriteDeletionRecord>();
  for (const record of [...local, ...cloud]) {
    const existing = merged.get(record.key);
    if (!existing || record.deletedAt > existing.deletedAt) merged.set(record.key, record);
  }
  return [...merged.values()].sort((a, b) => b.deletedAt - a.deletedAt);
}

export function mergeFavorites(local: FavoriteRecord[], cloud: FavoriteRecord[], deletions: FavoriteDeletionRecord[] = []) {
  // Deep-audit Section 4 — deterministic ANIME-SERIES identity merge.
  //
  // The same show could be favorited from two surfaces with two different
  // internal types: rails/heroes pass type='series' (TMDB classification)
  // while the /anime-series/{id} detail page passes type='anime'. The old
  // merge was keyed by the EXACT `${contentType}:${contentId}` string, so
  // the two records coexisted — duplicate My List entries and a heart
  // state that flipped between surfaces.
  //
  // Records are now grouped by the FAMILY + bare TMDB ID (series/anime are
  // one family — both are TMDB TV; movie keeps its own family). Within a
  // family:
  //   - the CATEGORY is DETERMINISTIC, never "whichever is newer": an
  //     anime-flagged record (snapshot.isAnime or contentType 'anime')
  //     makes the family's canonical identity 'anime';
  //   - the RECORD CONTENT (status/timestamps/snapshot payload) comes from
  //     the family's NEWEST record — recency decides the STATUS, never the
  //     CATEGORY (so a newer legacy 'watching' favorite is not demoted to
  //     an older 'planned' by the identity rule);
  //   - the winner's key/contentType/snapshot anime flags are re-keyed to
  //     that canonical identity.
  // Unrelated content is never merged: the bare TMDB ID must match.
  const familyKeyOf = (record: { contentType: FavoriteRecord['contentType']; contentId: string }): string => {
    const bareId = record.contentId.replace(/^(movie|series|anime)-/, '');
    const family = record.contentType === 'movie' ? 'movie' : 'series';
    return `${family}:${bareId}`;
  };
  const isAnimeIdentity = (record: FavoriteRecord): boolean =>
    record.contentType === 'anime' || record.snapshot?.isAnime === true;

  interface FamilyGroup {
    newest: FavoriteRecord;
    isAnime: boolean;
  }
  const byFamily = new Map<string, FamilyGroup>();
  for (const rawRecord of [...local, ...cloud]) {
    const record: FavoriteRecord = { ...rawRecord, status: normalizeWatchlistStatus(rawRecord.status) };
    const familyKey = familyKeyOf(record);
    const existing = byFamily.get(familyKey);
    if (!existing) {
      byFamily.set(familyKey, { newest: record, isAnime: isAnimeIdentity(record) });
      continue;
    }
    if (isAnimeIdentity(record)) existing.isAnime = true;
    // Newest record wins the CONTENT (existing recency ordering).
    if (record.updatedAt > existing.newest.updatedAt || (record.updatedAt === existing.newest.updatedAt && record.createdAt < existing.newest.createdAt)) {
      existing.newest = record;
    }
  }

  // Deletion suppression is FAMILY-WIDE: removing the show from one
  // surface (either family key) must suppress the merged record, or the
  // un-deleted legacy key would resurrect the entry on the next sync.
  const suppressionByFamily = new Map<string, number>();
  for (const deletion of deletions) {
    const bareId = deletion.contentId.replace(/^(movie|series|anime)-/, '');
    const family = deletion.contentType === 'movie' ? 'movie' : 'series';
    const key = `${family}:${bareId}`;
    const existing = suppressionByFamily.get(key);
    if (existing === undefined || deletion.deletedAt > existing) suppressionByFamily.set(key, deletion.deletedAt);
  }

  const merged: FavoriteRecord[] = [];
  for (const [familyKey, group] of byFamily) {
    const suppressedAt = suppressionByFamily.get(familyKey);
    if (suppressedAt !== undefined && group.newest.updatedAt <= suppressedAt) continue;
    const winner = group.newest;
    if (group.isAnime && winner.contentType !== 'anime') {
      // Canonical identity override — the family is anime. The record is
      // re-keyed so the title exists under exactly ONE identity.
      merged.push({
        ...winner,
        key: favoriteKey('anime', winner.contentId),
        contentType: 'anime',
        snapshot: { ...winner.snapshot, isAnime: true, animeFormat: winner.snapshot?.animeFormat ?? 'series' },
      });
    } else {
      merged.push(winner);
    }
  }
  return merged.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function mergeFavoritesWithProgress(favorites: FavoriteRecord[], progress: WatchProgressRecord[], deletions: FavoriteDeletionRecord[] = []) {
  const merged = new Map(mergeFavorites(favorites, [], deletions).map((record) => [record.key, { ...record, status: normalizeWatchlistStatus(record.status) }]));
  for (const record of progress) {
    if (record.completionState === 'completed') continue;
    // P16 fix: do NOT skip zero-progress series records — a user can
    // manually select an episode (creating a progress record with
    // currentTime=0) and that should still promote the favorite to
    // "watching" status. For movies, currentTime=0 means nothing
    // was actually watched — skip those.
    const isSeriesLike = record.contentType === 'series' || record.contentType === 'anime';
    if (!isSeriesLike && record.currentTime <= 0) continue;
    // For series: require valid season+episode OR currentTime > 0
    if (isSeriesLike && record.currentTime <= 0 && (record.season === undefined || record.episode === undefined)) continue;
    const key = favoriteKey(record.contentType, record.contentId);
    if (deletions.some((deletion) => deletion.key === key)) continue;
    const existing = merged.get(key);
    const timestamp = Math.max(record.updatedAt, record.lastWatchedAt);
    const createdAt = existing?.createdAt ?? timestamp;
    const updatedAt = Math.max(existing?.updatedAt ?? 0, timestamp);
    if (existing) continue;
    merged.set(key, {
      key,
      contentType: record.contentType,
      contentId: record.contentId,
      snapshot: record.snapshot,
      status: 'watching',
      createdAt,
      updatedAt,
    });
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function continueWatchingRecords(progress: WatchProgressRecord[], favorites: FavoriteRecord[]) {
  // P6+P7: ONE Continue Watching entry per title.
  // For series/anime: use getLatestResumeTarget() to find the latest
  // episode (even with currentTime=0). For movies: require currentTime > 0.
  // The old code filtered currentTime > 0 and created synthetic
  // manualWatching records WITHOUT season/episode — losing episode context.
  //
  // Deep-audit Section 4 — DETERMINISTIC CATEGORY RULE (no "newer record
  // wins the category"):
  //
  // Records are grouped by FAMILY + bare TMDB ID (series/anime are one
  // family — both are TMDB TV; movie keeps its own). The family's DISPLAY
  // category is a content fact, decided ONCE per family:
  //   - 'anime' when ANY record in the family carries the anime identity
  //     (snapshot.isAnime === true, or the legacy 'anime' contentType for
  //     series-family records),
  //   - otherwise the family base type ('series' / 'movie').
  // The RESUME POSITION (season/episode/time) is still the most recent
  // record's — recency decides the POSITION, never the CATEGORY. For the
  // position target we evaluate getLatestResumeTarget for every distinct
  // (contentType, contentId) pair in the family and keep the most recent
  // eligible target, so a legacy 'series:series-30984' record and an
  // 'anime:series-30984' record both contribute their latest episode.
  //
  // The display record is then RE-KEYED to the canonical identity:
  //   - series-family anime  → contentType 'anime',  contentId 'series-{bare}'
  //   - series-family normal → contentType 'series', contentId 'series-{bare}'
  //   - movie-family anime   → contentType 'movie',  contentId 'movie-{bare}'
  //     with snapshot.isAnime=true + animeFormat='movie' (the presenter
  //     then renders the canonical /anime-movie/ URLs)
  //   - movie-family normal  → contentType 'movie',  contentId 'movie-{bare}'
  // so ONE entry per title with the correct, stable category and the
  // correct latest season/episode resume target.
  const bareIdOf = (contentId: string): string => contentId.replace(/^(movie|series|anime)-/, '');
  const familyOf = (contentType: WatchProgressRecord['contentType']): 'movie' | 'series' =>
    contentType === 'movie' ? 'movie' : 'series';
  const recordIsAnime = (record: WatchProgressRecord): boolean =>
    record.snapshot?.isAnime === true || record.contentType === 'anime';
  // Only REAL TMDB ids (numeric) are re-keyed to the canonical prefixed
  // identity. Non-numeric ids (fixtures/tests) pass through verbatim —
  // re-keying them would fabricate a prefixed id nothing else recognizes.
  const isCanonicalId = (bareId: string): boolean => /^\d{1,20}$/.test(bareId);

  type Family = {
    bareId: string;
    family: 'movie' | 'series';
    isAnime: boolean;
    pairs: Set<string>;          // 'contentType:contentId' pairs in this family
    latest: WatchProgressRecord; // most recent record (position candidate)
  };
  const families = new Map<string, Family>();
  for (const record of progress) {
    if (record.completionState === 'completed') continue;
    const bareId = bareIdOf(record.contentId);
    const family = familyOf(record.contentType);
    const familyKey = `${family}:${bareId}`;
    let entry = families.get(familyKey);
    if (!entry) {
      entry = { bareId, family, isAnime: false, pairs: new Set(), latest: record };
      families.set(familyKey, entry);
    }
    if (recordIsAnime(record)) entry.isAnime = true;
    entry.pairs.add(`${record.contentType}:${record.contentId}`);
    const existingTime = Math.max(entry.latest.updatedAt, entry.latest.lastWatchedAt);
    const recordTime = Math.max(record.updatedAt, record.lastWatchedAt);
    if (recordTime > existingTime || (recordTime === existingTime && record.currentTime > entry.latest.currentTime)) {
      entry.latest = record;
    }
  }

  const result: WatchProgressRecord[] = [];
  for (const entry of families.values()) {
    // Resume target: the most recent eligible target across the family's
    // (contentType, contentId) pairs — episode correctness is preserved.
    let target: WatchProgressRecord | undefined;
    for (const pair of entry.pairs) {
      const [pairType, pairContentId] = pair.split(':');
      const candidate = getLatestResumeTarget(pairType as WatchProgressRecord['contentType'], pairContentId, progress);
      if (!candidate) continue;
      if (!target) { target = candidate; continue; }
      const targetTime = Math.max(target.updatedAt, target.lastWatchedAt);
      const candidateTime = Math.max(candidate.updatedAt, candidate.lastWatchedAt);
      if (candidateTime > targetTime || (candidateTime === targetTime && candidate.currentTime > target.currentTime)) target = candidate;
    }
    // Fallback: a movie with currentTime > 0 that getLatestResumeTarget
    // rejected (or a series record that didn't match its filter).
    if (!target) {
      if (entry.latest.currentTime > 0) target = entry.latest;
      else continue;
    }

    // Canonical display identity — deterministic category override.
    // Numeric TMDB ids only: non-numeric (fixture) ids pass through
    // VERBATIM (old passthrough behavior — no identity re-keying).
    if (!isCanonicalId(entry.bareId)) {
      result.push(target);
      continue;
    }
    const displayType: 'movie' | 'series' | 'anime' = entry.family === 'movie'
      ? 'movie'
      : (entry.isAnime ? 'anime' : 'series');
    const displayContentId = `${entry.family === 'movie' ? 'movie' : 'series'}-${entry.bareId}`;
    const animeFormat: 'movie' | 'series' | undefined = entry.isAnime
      ? (entry.family === 'movie' ? 'movie' : 'series')
      : undefined;
    result.push({
      ...target,
      contentType: displayType,
      contentId: displayContentId,
      snapshot: { ...target.snapshot, isAnime: entry.isAnime, animeFormat },
    });
  }

  // Also include manual "watching" favorites that have NO progress records at all
  // (series the user added to My List as "watching" but never started).
  // Family-aware: a legacy 'series:' favorite for an anime show must not
  // duplicate the family entry already contributed by its progress records.
  const progressFamilyKeys = new Set(result.map((r) => `${familyOf(r.contentType)}:${bareIdOf(r.contentId)}`));
  const syntheticSeen = new Set<string>();
  for (const fav of favorites) {
    if (normalizeWatchlistStatus(fav.status) !== 'watching') continue;
    const familyKey = `${familyOf(fav.contentType)}:${bareIdOf(fav.contentId)}`;
    if (progressFamilyKeys.has(familyKey)) continue;
    if (syntheticSeen.has(familyKey)) continue; // one entry per title family
    syntheticSeen.add(familyKey);
    const favIsAnime = fav.snapshot?.isAnime === true || fav.contentType === 'anime';
    // Non-numeric (fixture) ids: the synthetic record keeps the favorite's
    // own identity verbatim (old passthrough behavior).
    const canonical = isCanonicalId(bareIdOf(fav.contentId));
    const displayType: 'movie' | 'series' | 'anime' = !canonical
      ? fav.contentType
      : familyOf(fav.contentType) === 'movie'
        ? 'movie'
        : (favIsAnime ? 'anime' : 'series');
    const animeFormat: 'movie' | 'series' | undefined = !canonical
      ? fav.snapshot?.animeFormat
      : favIsAnime
        ? (familyOf(fav.contentType) === 'movie' ? 'movie' : 'series')
        : undefined;
    // Synthetic record for "watching" with no progress — S1E1 for series.
    result.push({
      key: `${familyKey}:watching`,
      contentType: displayType,
      contentId: canonical ? `${familyOf(fav.contentType) === 'movie' ? 'movie' : 'series'}-${bareIdOf(fav.contentId)}` : fav.contentId,
      season: familyOf(fav.contentType) !== 'movie' ? 1 : undefined,
      episode: familyOf(fav.contentType) !== 'movie' ? 1 : undefined,
      currentTime: 0,
      duration: 0,
      completionState: 'in_progress' as const,
      snapshot: { ...fav.snapshot, isAnime: canonical ? favIsAnime : (fav.snapshot?.isAnime ?? false), animeFormat },
      lastWatchedAt: fav.updatedAt,
      updatedAt: fav.updatedAt,
      positionUpdatedAt: 0,
    });
  }
  return result.sort((a, b) => Math.max(b.updatedAt, b.lastWatchedAt) - Math.max(a.updatedAt, a.lastWatchedAt));
}
