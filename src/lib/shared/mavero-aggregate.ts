import type { PlayerSource } from './player';

/**
 * MAVERO Player — fair bounded aggregation (Phase 9 server composer,
 * Phase 10 shared client merger).
 *
 * Phase 10 moved the pure round-robin composition into `$lib/shared` so the
 * SAME budgets and fairness guarantees apply on BOTH sides of the
 * progressive-loading boundary:
 *
 *   * the SERVER still composes the legacy one-shot aggregate
 *     (`/api/playback/stremio`) and each per-addon response;
 *   * the CLIENT re-composes the aggregate LIVE as progressively arriving
 *     addon results extend the stream pool (Phase 10 GOAL 2/4) — without a
 *     shared implementation the two paths would drift apart.
 *
 * Guarantees (identical on both sides):
 *   * every addon bucket with >=1 stream is represented — the sweep touches
 *     EVERY bucket before any bucket gets a second entry, so an early/prolific
 *     addon can never starve a later one (the DesiFlix/Pipe fix);
 *   * one addon can never contribute more than `streamsPerAddon` entries;
 *   * the aggregate never exceeds `maxStreams` entries (bounded payload);
 *   * the result is deterministic given the same bucket order (addon
 *     ordering → resolver order inside each pass).
 *
 * Pure module: no DOM, no network, no `$env`, no server imports.
 */

/** Total upper bound of addon streams in the composed aggregate. */
export const MAVERO_AGGREGATE_MAX_STREAMS = 100;

/** Per-addon upper bound — no addon can fill the aggregate alone. */
export const MAVERO_AGGREGATE_STREAMS_PER_ADDON = 40;

/** One addon's validated playable stream bucket (deterministic order). */
export type MaveroAddonBucket<T> = {
  addonName: string;
  firstAppearance: number;
  sources: T[];
};

/**
 * Round-robin composer. Repeatedly sweeps the addon buckets in deterministic
 * order, taking ONE stream per addon per pass, until the per-addon budget,
 * the total budget or the buckets are exhausted.
 */
export function aggregateMaveroBuckets<T>(buckets: Array<MaveroAddonBucket<T>>, maxStreams = MAVERO_AGGREGATE_MAX_STREAMS, streamsPerAddon = MAVERO_AGGREGATE_STREAMS_PER_ADDON): T[] {
  const totalCap = Math.max(0, maxStreams);
  const perAddonCap = Math.max(0, streamsPerAddon);
  const picked: T[] = [];
  const cursors = new Array<number>(buckets.length).fill(0);
  let exhausted = buckets.length === 0;
  while (!exhausted && picked.length < totalCap) {
    let tookAny = false;
    for (let index = 0; index < buckets.length && picked.length < totalCap; index++) {
      const bucket = buckets[index];
      if (cursors[index] >= Math.min(bucket.sources.length, perAddonCap)) continue;
      picked.push(bucket.sources[cursors[index]]);
      cursors[index] += 1;
      tookAny = true;
    }
    exhausted = !tookAny;
  }
  return picked;
}

/**
 * Buckets playable PlayerSource entries by addon display name, preserving
 * first-appearance order of both groups and streams (server: the resolver's
 * deterministic order; client: the merge arrival order extends the same
 * buckets). Entries without a URL are dropped.
 */
export function bucketMaveroSources(sources: PlayerSource[]): Array<MaveroAddonBucket<PlayerSource>> {
  const buckets: Array<MaveroAddonBucket<PlayerSource>> = [];
  const byName = new Map<string, MaveroAddonBucket<PlayerSource>>();
  for (const source of sources) {
    if (!source?.url) continue;
    const name = typeof source.metadata?.providerName === 'string' && source.metadata.providerName.trim() ? source.metadata.providerName.trim() : 'Addon';
    let bucket = byName.get(name);
    if (!bucket) {
      bucket = { addonName: name, firstAppearance: buckets.length, sources: [] };
      byName.set(name, bucket);
      buckets.push(bucket);
    }
    bucket.sources.push(source);
  }
  return buckets;
}
