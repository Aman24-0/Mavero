type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  staleUntil: number;
};

const entries = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

export type CachePolicy = {
  ttlMs: number;
  staleWhileRevalidateMs?: number;
};

export async function getOrSet<T>(key: string, policy: CachePolicy, loader: () => Promise<T>): Promise<{ value: T; stale: boolean }> {
  const now = Date.now();
  const cached = entries.get(key) as CacheEntry<T> | undefined;

  if (cached && cached.expiresAt > now) {
    return { value: cached.value, stale: false };
  }

  if (cached && cached.staleUntil > now) {
    void refresh(key, policy, loader);
    return { value: cached.value, stale: true };
  }

  return { value: await refresh(key, policy, loader), stale: false };
}

async function refresh<T>(key: string, policy: CachePolicy, loader: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = loader()
    .then((value) => {
      const now = Date.now();
      entries.set(key, {
        value,
        expiresAt: now + policy.ttlMs,
        staleUntil: now + policy.ttlMs + (policy.staleWhileRevalidateMs ?? 0)
      });
      return value;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

export function invalidate(prefix?: string) {
  if (!prefix) {
    entries.clear();
    return;
  }

  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

export function clearCache() {
  entries.clear();
  inFlight.clear();
}

export function cacheStats() {
  return { entries: entries.size, requestsInFlight: inFlight.size };
}
