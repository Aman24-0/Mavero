import type { PlayerQualityOption, PlayerSource } from '$lib/shared/player';
import { MAVERO_AGGREGATE_MAX_STREAMS, aggregateMaveroBuckets } from '$lib/shared/mavero-aggregate';

/**
 * MAVERO Player — progressive addon resolution controller (Phase 10,
 * GOALS 1–6, client half).
 *
 * Replaces the Phase 4 ONE-fetch aggregate flow:
 *
 *   resolveMaveroPlayerSource()        → ONE request, ONE response, ALL addons
 *   startMaveroProgressiveResolution() → session + INDEPENDENT per-addon
 *                                        requests merged LIVE
 *
 * Flow:
 *   1. `POST /api/playback/stremio/session` (content identifiers only) →
 *      per-addon opaque signed tokens + safe display metadata.
 *   2. ONE independent request per token — all in flight simultaneously,
 *      each with its OWN AbortController and its own timeout. A slow addon
 *      blocks nothing; a failed addon marks itself only (GOAL 2/6).
 *   3. Every result goes to `onResult` immediately. The watch route merges
 *      results into the aggregate PlayerSource and starts playback from the
 *      FIRST addon that yields streams — later results extend the pool
 *      without restarting the player (GOAL 2).
 *   4. `retry(addonKey)` re-runs exactly ONE addon with its existing token;
 *      no other addon is refetched and the video is untouched (GOAL 6).
 *
 * STALE PROTECTION (GOAL 5):
 *   * `generation` — monotonic; `start()` bumps it and every callback
 *     delivery is guarded by generation, so movie A's late responses can
 *     never reach movie B's handlers (A→B→A and movie↔episode switches).
 *   * Server-side, each token is bound to (session, addon, content,
 *     mediaType, season/episode) — a second, cryptographic layer.
 *   * `dispose()` aborts every in-flight request (route teardown).
 *
 * The client NEVER sees manifest URLs, addon configuration or proxy
 * headers — only opaque tokens, addon display names, ordering and already-
 * normalized PlayerSource data.
 */

/** Per-addon request timeout. Independent per addon (a slow addon never blocks others). */
export const ADDON_REQUEST_TIMEOUT_MS = 20_000;

/** Closed error codes the controller itself produces (Phase 3 vocabulary). */
export const ADDON_REQUEST_TIMEOUT_CODE = 'TIMEOUT';
export const ADDON_REQUEST_NETWORK_CODE = 'NETWORK';
/** Server-reported code when a token/session is no longer usable. */
export const ADDON_SESSION_EXPIRED_CODE = 'SESSION_EXPIRED';

/** Safe display + resolution state for ONE addon in the streams sheet (GOAL 3). */
export type MaveroAddonStatus = {
  /** Stable client key for this addon within the session. */
  key: string;
  addonName: string;
  ordering: number;
  status: 'pending' | 'loading' | 'ok' | 'failed' | 'skipped';
  streamCount: number;
  /** Closed error vocabulary (Phase 3 codes) — safe to display. */
  errorCode?: string;
};

/** One resolved stream entry delivered to the watch route. */
export type MaveroResolvedStream = {
  source: PlayerSource;
  quality: PlayerQualityOption;
  compatToken?: string;
  compatKind?: 'remux' | 'transcode';
};

/** One merged addon outcome delivered to the watch route. */
export type MaveroAddonResult = {
  key: string;
  addonName: string;
  ordering: number;
  status: 'ok' | 'failed' | 'skipped';
  streams: MaveroResolvedStream[];
  errorCode?: string;
};

export type MaveroSessionSummary = {
  sessionId: string;
  /** Addons the session tracks (eligible ones — the sheet's baseline). */
  addons: MaveroAddonStatus[];
  /** True when the session endpoint reported zero eligible addons. */
  empty: boolean;
};

export type ProgressiveResolutionCallbacks = {
  /** Session established (tokens known) — the sheet renders Loading rows. */
  onSession?: (summary: MaveroSessionSummary) => void;
  /** One addon finished (ok/failed/skipped) — merge + status update. */
  onResult: (result: MaveroAddonResult) => void;
  /** The session itself failed (network/500/expired) — graceful UX path. */
  onSessionError?: (code: string, message: string) => void;
};

export type ProgressiveResolutionRequest = {
  contentId: string;
  mediaType: 'movie' | 'series' | 'anime';
  season?: number;
  episode?: number;
};

type AddonRun = {
  key: string;
  token: string;
  status: MaveroAddonStatus;
  controller: AbortController | null;
};

/** Shapes of the two endpoint payloads (structural, untrusted — narrowed below). */
type SessionPayload = { ok?: boolean; session?: { sessionId?: unknown; addons?: unknown }; error?: { code?: unknown; message?: unknown } };
type AddonPayload = { ok?: boolean; result?: { status?: unknown; streams?: unknown; errorCode?: unknown }; error?: { code?: unknown; message?: unknown } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ProgressiveSession = {
  /** Re-runs ONE addon (its existing token). Never touches other addons. */
  retry: (addonKey: string) => void;
  /** Aborts all in-flight addon requests and invalidates the session. */
  dispose: () => void;
  /** Current snapshot of per-addon statuses (safe display state). */
  statuses: () => MaveroAddonStatus[];
};

export function startMaveroProgressiveResolution(
  request: ProgressiveResolutionRequest,
  callbacks: ProgressiveResolutionCallbacks,
  deps: { fetcher?: typeof fetch; timeoutMs?: number } = {},
): ProgressiveSession {
  const fetcher = deps.fetcher ?? fetch;
  const timeoutMs = deps.timeoutMs ?? ADDON_REQUEST_TIMEOUT_MS;
  let generation = 0;
  let sessionId = '';
  const runs = new Map<string, AddonRun>();

  const withBody = (extra: Record<string, unknown>) => ({
    contentId: request.contentId,
    mediaType: request.mediaType,
    ...(request.season !== undefined ? { season: request.season } : {}),
    ...(request.episode !== undefined ? { episode: request.episode } : {}),
    ...extra,
  });

  async function postJson<T>(url: string, body: unknown, signal: AbortSignal): Promise<{ status: number; payload: T | null }> {
    const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload: payload as T | null };
  }

  async function resolveOne(run: AddonRun, runGeneration: number): Promise<void> {
    run.status = { ...run.status, status: 'loading' };
    const controller = new AbortController();
    run.controller = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { status, payload } = await postJson<AddonPayload>('/api/playback/stremio/addon', withBody({ sessionId, token: run.token }), controller.signal);
      if (runGeneration !== generation) return; // stale (GOAL 5) — drop
      if (status === 0 || !payload || payload.ok !== true || !isRecord(payload.result)) {
        const code = isRecord(payload?.error) && typeof payload.error.code === 'string' ? payload.error.code : status === 400 ? ADDON_SESSION_EXPIRED_CODE : ADDON_REQUEST_NETWORK_CODE;
        run.status = { ...run.status, status: 'failed', errorCode: code };
        callbacks.onResult({ key: run.key, addonName: run.status.addonName, ordering: run.status.ordering, status: 'failed', streams: [], errorCode: code });
        return;
      }
      const result = payload.result as { status?: unknown; streams?: unknown; errorCode?: unknown };
      if (result.status === 'ok' && Array.isArray(result.streams)) {
        const streams: MaveroResolvedStream[] = [];
        for (const entry of result.streams) {
          if (!isRecord(entry)) continue;
          const source = entry.source as PlayerSource | undefined;
          const quality = entry.quality as PlayerQualityOption | undefined;
          if (!source || typeof source.url !== 'string' || !quality) continue;
          const compat = isRecord(entry.compat) ? entry.compat : null;
          streams.push({
            source,
            quality,
            ...(compat && typeof compat.token === 'string' ? { compatToken: compat.token } : {}),
            ...(compat && (compat.kind === 'remux' || compat.kind === 'transcode') ? { compatKind: compat.kind } : {}),
          });
        }
        run.status = { ...run.status, status: 'ok', streamCount: streams.length, errorCode: undefined };
        callbacks.onResult({ key: run.key, addonName: run.status.addonName, ordering: run.status.ordering, status: 'ok', streams });
        return;
      }
      if (result.status === 'skipped') {
        run.status = { ...run.status, status: 'skipped', streamCount: 0, errorCode: undefined };
        callbacks.onResult({ key: run.key, addonName: run.status.addonName, ordering: run.status.ordering, status: 'skipped', streams: [] });
        return;
      }
      const code = typeof result.errorCode === 'string' ? result.errorCode : 'UNEXPECTED';
      run.status = { ...run.status, status: 'failed', errorCode: code };
      callbacks.onResult({ key: run.key, addonName: run.status.addonName, ordering: run.status.ordering, status: 'failed', streams: [], errorCode: code });
    } catch (error) {
      if (runGeneration !== generation) return; // aborted/stale — drop silently
      const timedOut = error instanceof DOMException && error.name === 'AbortError';
      run.status = { ...run.status, status: 'failed', errorCode: timedOut ? ADDON_REQUEST_TIMEOUT_CODE : ADDON_REQUEST_NETWORK_CODE };
      callbacks.onResult({ key: run.key, addonName: run.status.addonName, ordering: run.status.ordering, status: 'failed', streams: [], errorCode: run.status.errorCode });
    } finally {
      clearTimeout(timer);
      run.controller = null;
    }
  }

  const session: ProgressiveSession = {
    retry(addonKey: string) {
      const run = runs.get(addonKey);
      if (!run) return;
      // A loading addon cannot double-fire; an OK addon is never refetched
      // by a UI rerender (GOAL 18 — no duplicate addon resolution).
      if (run.status.status === 'loading' || run.status.status === 'ok') return;
      void resolveOne(run, generation);
    },
    dispose() {
      generation += 1;
      for (const run of runs.values()) {
        try {
          run.controller?.abort();
        } catch {
          /* abort must never throw */
        }
      }
    },
    statuses() {
      return [...runs.values()].map((run) => ({ ...run.status }));
    },
  };

  void (async () => {
    const thisGeneration = ++generation;
    try {
      const { status, payload } = await postJson<SessionPayload>('/api/playback/stremio/session', withBody({}), new AbortController().signal);
      if (thisGeneration !== generation) return;
      if (status === 0 || !payload || payload.ok !== true || !isRecord(payload.session) || typeof payload.session.sessionId !== 'string' || !payload.session.sessionId) {
        const code = isRecord(payload?.error) && typeof payload.error.code === 'string' ? payload.error.code : 'NETWORK';
        const message = isRecord(payload?.error) && typeof payload.error.message === 'string' ? payload.error.message : 'MAVERO Player could not start a resolution session. Try again or choose another source.';
        callbacks.onSessionError?.(code, message);
        return;
      }
      sessionId = payload.session.sessionId;
      const rawAddons = Array.isArray(payload.session.addons) ? payload.session.addons : [];
      const runsList: AddonRun[] = [];
      for (const entry of rawAddons) {
        if (!isRecord(entry) || typeof entry.token !== 'string' || typeof entry.name !== 'string' || typeof entry.ordering !== 'number') continue;
        const key = `addon-${runsList.length}`;
        runsList.push({ key, token: entry.token, status: { key, addonName: entry.name, ordering: entry.ordering, status: 'pending', streamCount: 0 }, controller: null });
      }
      for (const run of runsList) runs.set(run.key, run);
      callbacks.onSession?.({ sessionId, addons: runsList.map((run) => ({ ...run.status })), empty: runsList.length === 0 });
      // Fire EVERY addon independently — no aggregate await; one slow addon
      // never delays another (GOAL 1/2). Each result merges as it lands.
      for (const run of runsList) {
        if (thisGeneration !== generation) return;
        void resolveOne(run, thisGeneration);
      }
    } catch {
      if (thisGeneration !== generation) return;
      callbacks.onSessionError?.('NETWORK', 'MAVERO Player could not start a resolution session. Try again or choose another source.');
    }
  })();

  return session;
}

// ---------------------------------------------------------------------------
// LIVE AGGREGATE MERGE (GOALS 2/4)
// ---------------------------------------------------------------------------

/**
 * Merges progressively-arriving addon results into ONE aggregate
 * PlayerSource using the SAME fair round-robin budgets as the server
 * composer (`$lib/shared/mavero-aggregate` — GOAL 4 parity).
 *
 * `currentUrl` (the stream the player is ALREADY playing, if any) always
 * leads the aggregate — merging NEVER retargets or restarts playback
 * (GOAL 2). Before playback starts, the deterministic first stream leads.
 *
 * Pure function: no state, no player coupling — the watch route owns
 * sequencing through the generation guards of this module.
 */
export function mergeMaveroResults(
  results: MaveroAddonResult[],
  context: { sourceId: string; sourceName: string; mediaType: 'movie' | 'series' | 'anime'; contentTitle?: string },
  currentUrl: string | null,
): PlayerSource | null {
  const okResults = results.filter((result) => result.status === 'ok' && result.streams.length > 0);
  if (!okResults.length) return null;

  // Phase 10: compat references ride the URL → token map so the merged
  // quality options carry the signed references (the shell's compat path
  // needs them at selection time).
  const compatByUrl = new Map<string, { token: string; kind: 'remux' | 'transcode' }>();
  for (const result of okResults) {
    for (const entry of result.streams) {
      if (entry.compatToken && typeof entry.source.url === 'string' && !compatByUrl.has(entry.source.url)) {
        compatByUrl.set(entry.source.url, { token: entry.compatToken, kind: entry.compatKind ?? 'transcode' });
      }
    }
  }

  const ordered = [...okResults].sort((a, b) => a.ordering - b.ordering || a.addonName.localeCompare(b.addonName));
  const buckets = ordered.map((result) => ({ addonName: result.addonName, firstAppearance: 0, sources: result.streams.map((entry) => entry.source) }));
  const picked = aggregateMaveroBuckets(buckets, MAVERO_AGGREGATE_MAX_STREAMS);
  if (!picked.length) return null;

  const primary = (currentUrl ? picked.find((source) => source.url === currentUrl) : undefined) ?? picked[0];
  const qualities = picked.map((source) => {
    const option = qualityOptionOfSource(source);
    const compat = typeof source.url === 'string' ? compatByUrl.get(source.url) : undefined;
    if (compat) {
      option.compatToken = compat.token;
      option.compatKind = compat.kind;
    }
    return option;
  });
  return {
    type: 'direct',
    url: primary.url,
    providerId: context.sourceId,
    sourceId: context.sourceId,
    mediaType: context.mediaType,
    qualities,
    metadata: {
      ...(context.contentTitle ? { title: context.contentTitle } : {}),
      sourceName: context.sourceName,
      providerName: context.sourceName,
      ...(primary.metadata?.protocol ? { protocol: primary.metadata.protocol } : {}),
      note: `MAVERO Player · ${picked.length} addon stream${picked.length === 1 ? '' : 's'}`,
    },
  };
}

/** Presentation quality option for one stream's PlayerSource (label parity with the server composer). */
function qualityOptionOfSource(source: PlayerSource): PlayerQualityOption {
  const url = source.url as string;
  const quality = source.qualities?.[0];
  const addonName = source.metadata?.providerName ?? 'Addon';
  const qualityLabel = quality?.label ?? (quality?.height ? `${quality.height}p` : 'Auto');
  const protocol = source.metadata?.protocol;
  const subtitleTracks = (source.subtitles ?? []).slice(0, 8);
  return {
    url,
    label: `${addonName} · ${qualityLabel}`,
    ...(quality?.height !== undefined ? { height: quality.height } : {}),
    ...(quality?.bitrate !== undefined ? { bitrate: quality.bitrate } : {}),
    ...(addonName ? { addonName } : {}),
    ...(protocol ? { protocol } : {}),
    ...(source.metadata?.title ? { title: source.metadata.title } : {}),
    ...(source.metadata?.streamDescription ? { description: source.metadata.streamDescription } : {}),
    ...(source.metadata?.audioLanguages ? { audioLanguages: source.metadata.audioLanguages } : {}),
    ...(source.metadata?.streamContainer ? { container: source.metadata.streamContainer } : {}),
    ...(source.metadata?.streamCodec ? { codec: source.metadata.streamCodec } : {}),
    ...(source.metadata?.filename ? { filename: source.metadata.filename } : {}),
    ...(source.metadata?.videoSize ? { videoSize: source.metadata.videoSize } : {}),
    ...(subtitleTracks.length ? { subtitles: subtitleTracks } : {}),
  };
}
