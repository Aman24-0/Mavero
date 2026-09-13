// Generic bounded-concurrency mapper (Adult Mode rebuild, Phase 4).
//
// Extracted verbatim from adapters/tmdb.ts so that BOTH the TMDB adapter
// and the pure search-classification orchestrator (search-classify.ts,
// which must stay importable under tsx and therefore cannot import the
// adapter) share ONE implementation. Behavioral tests prove the bound:
// with N workers started at most `concurrency` promises are ever in
// flight (scripts/adult_search_test.ts, case M).

/**
 * Map `items` through `worker` with at most `concurrency` promises in
 * flight at any moment. Results keep the input order. The concurrency
 * limit is deterministic and independent of item count.
 */
export async function mapWithConcurrency<T, R>(items: T[], worker: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item);
    }
  });
  await Promise.all(workers);
  return results;
}
