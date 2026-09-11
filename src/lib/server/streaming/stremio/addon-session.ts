import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { validatePlaybackUrl } from '$lib/server/resolver/safe-url';
import type { PlayerQualityOption, PlayerSource } from '$lib/shared/player';
import { classifyStreamCompatibility, needsCompatibilityPath, type StreamCompatibilityInput } from '$lib/shared/media-compat';
import { MAVERO_AGGREGATE_STREAMS_PER_ADDON } from '$lib/shared/mavero-aggregate';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import type { ContentType } from '$lib/server/content/types';
import { normalizeContentIdentifiers } from '$lib/server/resolver/identifiers';
import { fetchStremioStreamResponse, STREAM_MAX_BYTES, STREAM_REQUEST_TIMEOUT_MS } from './stream-fetch';
import { asStreamServiceError, StreamServiceError, type StreamErrorCode } from './stream-errors';
import { normalizeStremioStreamResponse } from './stream-normalize';
import { planAddonStreamRequest, stremioStreamTypeFor, type StremioAddonStreamPlan, type StremioStreamType } from './stream-ids';
import { stremioStreamToPlayerSource } from './stream-player-source';
import { loadEnabledAddons } from './stream-resolver';
import { mapAddonRow } from '$lib/server/streaming/addons';
import { signAddonToken, verifyAddonToken, tokenMatchesRequest, signCompatToken, ADDON_TOKEN_TTL_SECONDS, type AddonTokenPayload } from './session-tokens';

/**
 * MAVERO Player — progressive Stremio addon resolution service (Phase 10,
 * GOALS 1–6).
 *
 * The Phase 4–9 aggregate endpoint resolves ALL addons behind ONE request
 * and ONE response, so a slow addon delays playback from every other addon
 * and a timeout risks losing entire addons (live-observed: DesiFlix late,
 * Pipe never appeared under load). Phase 10 splits resolution into:
 *
 *   1. `createAddonSession` — the server validates the content, loads the
 *      enabled addons, plans eligibility LOCALLY (pure, request-free) and
 *      returns ONE short-lived signed token per ELIGIBLE addon plus safe
 *      display metadata (name, ordering). NO manifest URL, NO addon
 *      configuration, NO proxy headers ever reach the client.
 *   2. `resolveAddonToken` — the client fires one INDEPENDENT request per
 *      token. The server re-verifies the token (signature, expiry, content/
 *      session binding), RE-LOADS the addon row (admin state may have
 *      changed mid-session), re-plans eligibility, fetches that ONE addon's
 *      streams through the EXISTING hardened pipeline (connect-time SSRF
 *      guard, body cap, timeout) and returns the validated, per-addon-capped
 *      PlayerSource list. One addon's failure is a per-addon response —
 *      never a session failure (GOAL 6/8 isolation).
 *
 * SECURITY MODEL (GOAL 24):
 *   * The token authorizes EXACTLY ONE (addon, content, mediaType,
 *     season/episode, session) tuple — unusable for arbitrary addon
 *     selection or content switching.
 *   * Addon eligibility is re-checked server-side on EVERY request; a valid
 *     token for a since-disabled addon yields `skipped`, not streams.
 *   * Per-addon failures are returned as `status: 'failed'` with the same
 *     closed StreamErrorCode vocabulary as Phase 3 — no internal detail.
 *   * Streams carry compatibility REFERENCES (signed) when the classifier
 *     says the format needs remux/transcode — the compatibility gateway can
 *     then never become an arbitrary URL proxy (GOAL 12/24).
 *
 * Both functions are pure-with-respect-to-env (secret/fetcher injected) and
 * unit-testable via tsx.
 */

/** Safe per-addon session entry returned to the client (GOAL 1/3). */
export type AddonSessionEntry = {
  /** Opaque short-lived signed token (the ONLY handle the client gets). */
  token: string;
  /** Addon DISPLAY name — safe presentation text. */
  name: string;
  /** Admin ordering — drives fair merge order on the client. */
  ordering: number;
  /** Initial status the client renders (always 'pending' at session time). */
  status: 'pending';
};

export type AddonSession = {
  sessionId: string;
  mediaType: StremioStreamType;
  requestedMediaType: ContentType;
  contentId: string;
  season?: number;
  episode?: number;
  contentTitle?: string;
  /** Total addons CONSIDERED (enabled + usable) — the sheet's baseline. */
  consideredAddons: number;
  /** Eligible addon entries (tokens). Ineligible addons are NOT listed. */
  addons: AddonSessionEntry[];
  /** ISO expiry of the tokens (informational, for the client's UX copy). */
  expiresAt: string;
};

export type CreateAddonSessionRequest = {
  mediaType: ContentType;
  contentId: string;
  season?: number;
  episode?: number;
};

/**
 * The content fact the session pipeline needs: safe identifiers + optional
 * title. The default implementation runs the EXISTING content pipeline
 * (`getDetail` + `normalizeContentIdentifiers`); tests inject a stub so the
 * module stays env-free and tsx-testable (repo convention).
 */
export type ContentLookup = { title?: string; identifiers: { imdbId?: string; tmdbId?: string } };

async function defaultLoadContent(mediaType: ContentType, contentId: string): Promise<ContentLookup> {
  const { getDetail } = await import('$lib/server/content/service');
  const content = await getDetail(mediaType, contentId);
  const identifiers = normalizeContentIdentifiers(content, { sourceId: 'mavero-player', contentId, mediaType });
  return { ...(content.title ? { title: content.title } : {}), identifiers: { imdbId: identifiers.imdbId, tmdbId: identifiers.tmdbId } };
}

export type CreateAddonSessionDeps = {
  secret: string;
  ttlSeconds?: number;
  sessionId?: string;
  now?: Date;
  /** Injectable addon loader (tests); defaults to the enabled-addons query. */
  loadAddons?: (client: SupabaseClient<Database>) => Promise<StreamingAddon[]>;
  /** Injectable content lookup (tests); defaults to the content pipeline. */
  loadContent?: (mediaType: ContentType, contentId: string) => Promise<ContentLookup>;
};

/**
 * Creates one progressive resolution session. Throws a typed
 * `StreamServiceError` only for invalid requests or addon-infrastructure
 * failures — never for a specific addon's state.
 */
export async function createAddonSession(client: SupabaseClient<Database>, request: CreateAddonSessionRequest, deps: CreateAddonSessionDeps): Promise<AddonSession> {
  const now = deps.now ?? new Date();
  const ttl = deps.ttlSeconds ?? ADDON_TOKEN_TTL_SECONDS;

  // Content validation through the EXISTING pipeline (same identifiers the
  // aggregate endpoint uses — no second id logic, GOAL 13 reuse).
  let contentTitle: string | undefined;
  let identifiers: { imdbId?: string; tmdbId?: string };
  try {
    const lookup = await (deps.loadContent ?? defaultLoadContent)(request.mediaType, request.contentId);
    contentTitle = lookup.title;
    identifiers = lookup.identifiers;
  } catch {
    throw new StreamServiceError('INVALID_REQUEST', { message: 'This title could not be loaded for playback.' });
  }

  let addons: StreamingAddon[];
  try {
    addons = await (deps.loadAddons ?? loadEnabledAddons)(client);
  } catch (error) {
    throw new StreamServiceError('UNEXPECTED', { cause: error });
  }

  const streamType = stremioStreamTypeFor(request.mediaType);
  const expires = new Date(now.getTime() + ttl * 1000);
  const expSeconds = Math.floor(expires.getTime() / 1000);
  const addonsOut: AddonSessionEntry[] = [];
  for (const addon of addons) {
    const plan = planAddonStreamRequest(addon, streamType, { imdbId: identifiers.imdbId, tmdbId: identifiers.tmdbId }, request.season, request.episode);
    // Ineligible addons are skipped WITHOUT a token — the client never sees
    // them (they cannot resolve for this content; listing them would imply
    // a playable opportunity that does not exist).
    if (!plan.ok) {
      // Phase 11 (GOAL C) — loss-point diagnostics: a Stremio-visible addon
      // disappearing from MAVERO must be explainable from server logs. The
      // log carries the typed skip reason and the addon's display identity
      // ONLY — never the manifest URL, identifiers or addon configuration.
      console.warn(`[StremioSession] addon skipped addon=${addon.slug} reason=${plan.reason} mediaType=${streamType}`);
      continue;
    }
    addonsOut.push({
      token: signAddonToken(
        {
          s: deps.sessionId ?? '',
          a: addon.id,
          c: request.contentId,
          m: request.mediaType,
          ...(request.season !== undefined ? { se: request.season } : {}),
          ...(request.episode !== undefined ? { ep: request.episode } : {}),
          exp: expSeconds,
        },
        deps.secret,
      ),
      name: addon.name,
      ordering: addon.ordering,
      status: 'pending',
    });
  }

  return {
    sessionId: deps.sessionId ?? '',
    mediaType: streamType,
    requestedMediaType: request.mediaType,
    contentId: request.contentId,
    ...(request.season !== undefined ? { season: request.season } : {}),
    ...(request.episode !== undefined ? { episode: request.episode } : {}),
    ...(contentTitle ? { contentTitle } : {}),
    consideredAddons: addons.length,
    addons: addonsOut,
    expiresAt: expires.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Per-addon resolution
// ---------------------------------------------------------------------------

/** Safe per-addon compatibility reference (signed) — GOAL 12. */
export type AddonStreamCompatReference = {
  /** Opaque signed token for /api/playback/compat/manifest (URL embedded). */
  token: string;
  kind: 'remux' | 'transcode';
};

/** One resolved stream entry as the per-addon endpoint returns it. */
export type AddonResolvedStream = {
  source: PlayerSource;
  quality: PlayerQualityOption;
  compat?: AddonStreamCompatReference;
};

export type AddonResolutionResult =
  | { status: 'ok'; addonName: string; addonOrdering: number; streamCount: number; streams: AddonResolvedStream[] }
  | { status: 'skipped'; addonName: string; addonOrdering: number; reason: string }
  | { status: 'failed'; addonName: string; addonOrdering: number; errorCode: StreamErrorCode };

export type ResolveAddonTokenDeps = {
  secret: string;
  fetcher?: typeof fetch;
  dnsResolver?: import('./ssrf').SafeDnsResolver;
  timeoutMs?: number;
  maxBytes?: number;
  /** Injectable single-addon loader (tests). */
  loadAddonById?: (client: SupabaseClient<Database>, id: string) => Promise<StreamingAddon | null>;
  /** Injectable content lookup (tests); defaults to the content pipeline. */
  loadContent?: (mediaType: ContentType, contentId: string) => Promise<ContentLookup>;
  compatSecret?: string;
  now?: Date;
};

/**
 * Body the client posts to /api/playback/stremio/addon: the opaque token
 * plus the session id it belongs to. Nothing else — no addon ids, no URLs.
 */
export type ResolveAddonRequest = {
  sessionId: string;
  token: string;
};

function parseResolveAddonRequest(input: unknown): ResolveAddonRequest | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0 || record.sessionId.length > 128) return null;
  if (typeof record.token !== 'string' || record.token.length === 0 || record.token.length > 4096) return null;
  return { sessionId: record.sessionId, token: record.token };
}

export { parseResolveAddonRequest };

/**
 * Resolves ONE addon's streams for ONE bound content item. NEVER throws for
 * addon-level problems — every outcome is a typed result. Throws only for
 * infrastructure failures (DB outage), which the endpoint maps to 503.
 */
export async function resolveAddonToken(client: SupabaseClient<Database>, input: unknown, context: { contentId: string; mediaType: ContentType; season?: number; episode?: number }, deps: ResolveAddonTokenDeps): Promise<{ request: ResolveAddonRequest; result: AddonResolutionResult }> {
  const parsed = parseResolveAddonRequest(input);
  if (!parsed) throw new StreamServiceError('INVALID_REQUEST', { message: 'The addon resolution request is invalid.' });

  const verification = verifyAddonToken(parsed.token, deps.secret);
  if (!verification.ok) {
    // Distinguish only the user-meaningful cases; a bad signature/expiry is
    // the same "start a new session" outcome for the client.
    throw new StreamServiceError('INVALID_REQUEST', { message: 'The addon resolution session expired. Start playback again.' });
  }
  const payload = verification.payload;
  if (!tokenMatchesRequest(payload, { sessionId: parsed.sessionId, contentId: context.contentId, mediaType: context.mediaType, season: context.season, episode: context.episode })) {
    throw new StreamServiceError('INVALID_REQUEST', { message: 'The addon resolution session does not match this playback.' });
  }

  // Load the addon row FRESH — the token proves the session bound it, the
  // database decides whether it is still eligible (GOAL 1: admin state wins).
  let addon: StreamingAddon | null;
  try {
    addon = deps.loadAddonById
      ? await deps.loadAddonById(client, payload.a)
      : await loadAddonById(client, payload.a);
  } catch (error) {
    throw new StreamServiceError('UNEXPECTED', { cause: error });
  }
  const display = addonDisplayName(addon, payload.a);
  const ordering = addon?.ordering ?? Number.MAX_SAFE_INTEGER;
  if (!addon || !addon.enabled || !(addon.status === 'active' || addon.status === 'experimental')) {
    return { request: parsed, result: { status: 'skipped', addonName: display, addonOrdering: ordering, reason: 'addon-unavailable' } };
  }

  const streamType = stremioStreamTypeFor(context.mediaType);
  let identifiers: { imdbId?: string; tmdbId?: string };
  {
    // Rebuild the identifiers the token was minted FROM. The token binds
    // contentId; the identifiers derive from it deterministically via the
    // same content pipeline (already validated at session time).
    try {
      const lookup = await (deps.loadContent ?? defaultLoadContent)(context.mediaType, context.contentId);
      identifiers = lookup.identifiers;
    } catch {
      return { request: parsed, result: { status: 'skipped', addonName: display, addonOrdering: ordering, reason: 'content-unavailable' } };
    }
  }

  const plan: StremioAddonStreamPlan | null = (() => {
    const result = planAddonStreamRequest(addon, streamType, identifiers, context.season, context.episode);
    return result.ok ? result.plan : null;
  })();
  if (!plan) {
    return { request: parsed, result: { status: 'skipped', addonName: display, addonOrdering: ordering, reason: 'addon-ineligible' } };
  }

  // Fetch + normalize through the EXISTING hardened single-addon pipeline.
  try {
    const body = await fetchStremioStreamResponse(plan.endpointUrl, {
      fetcher: deps.fetcher,
      dnsResolver: deps.dnsResolver,
      timeoutMs: deps.timeoutMs ?? STREAM_REQUEST_TIMEOUT_MS,
      maxBytes: deps.maxBytes ?? STREAM_MAX_BYTES,
    });
    const normalized = normalizeStremioStreamResponse(body);
    if (!normalized.valid) {
      return { request: parsed, result: { status: 'failed', addonName: display, addonOrdering: ordering, errorCode: 'INVALID_RESPONSE' } };
    }
    const streams: AddonResolvedStream[] = [];
    for (const stream of normalized.streams) {
      const resolved = resolvedStreamOf(addon, plan, streamType, stream);
      if (!resolved) continue;
      // Playback boundary FIRST (HTTPS-only direct policy) — a stream that
      // cannot play directly never consumes budget or gets a compat ref.
      if (!resolved.source.url) continue;
      try {
        validatePlaybackUrl(resolved.source.url, 'direct');
      } catch {
        continue;
      }
      const compat = compatReferenceOf(resolved.quality, context, payload, deps);
      streams.push({ source: resolved.source, quality: resolved.quality, ...(compat ? { compat } : {}) });
      if (streams.length >= MAVERO_AGGREGATE_STREAMS_PER_ADDON) break;
    }
    return { request: parsed, result: { status: 'ok', addonName: display, addonOrdering: ordering, streamCount: streams.length, streams } };
  } catch (error) {
    const serviceError = asStreamServiceError(error);
    if (serviceError.code === 'UNEXPECTED') {
      console.warn('[StremioAddon] unexpected addon stream failure', serviceError.code);
    }
    return { request: parsed, result: { status: 'failed', addonName: display, addonOrdering: ordering, errorCode: serviceError.code } };
  }
}

/** Deterministic addon display fallback — never a manifest URL or id. */
function addonDisplayName(addon: StreamingAddon | null, addonId: string): string {
  if (addon?.name && addon.name.trim()) return addon.name.trim();
  // Opaque, bounded fallback (id fragment only — never a URL).
  return `Addon ${addonId.slice(0, 8)}`;
}

async function loadAddonById(client: SupabaseClient<Database>, id: string): Promise<StreamingAddon | null> {
  const { data, error } = await client.from('streaming_addons').select('*').eq('id', id).eq('enabled', true).in('status', ['active', 'experimental']).limit(1);
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  return mapAddonRow(row as Parameters<typeof mapAddonRow>[0]);
}

type NormalizedStreamShape = ReturnType<typeof normalizeStremioStreamResponse>['streams'][number];

/** Maps one normalized stream through the Phase 3 adapter + quality option. */
function resolvedStreamOf(addon: StreamingAddon, plan: StremioAddonStreamPlan, streamType: StremioStreamType, stream: NormalizedStreamShape): { source: PlayerSource; quality: PlayerQualityOption } | null {
  const resolved = {
    addonId: addon.id,
    addonSlug: addon.slug,
    addonName: addon.name,
    addonOrdering: addon.ordering,
    streamIndex: stream.index,
    streamName: stream.name,
    streamTitle: stream.title,
    url: stream.url,
    protocol: stream.protocol,
    transport: stream.transport,
    mediaType: streamType,
    videoId: plan.videoId,
    idProperty: plan.idProperty,
    quality: stream.quality,
    bingeGroup: stream.bingeGroup,
    filename: stream.filename,
    videoSize: stream.videoSize,
    ...(stream.description ? { description: stream.description } : {}),
    ...(stream.audioLanguages ? { audioLanguages: stream.audioLanguages } : {}),
    ...(stream.container ? { container: stream.container } : {}),
    ...(stream.codec ? { codec: stream.codec } : {}),
    ...(stream.subtitles ? { subtitles: stream.subtitles } : {}),
  };
  const source = stremioStreamToPlayerSource(resolved);
  if (!source.url) return null;
  const quality = qualityOptionOf(source, addon.name);
  return { source, quality };
}

/** Same quality-option mapping as the aggregate composer (label parity). */
function qualityOptionOf(source: PlayerSource, addonName: string): PlayerQualityOption {
  const url = source.url as string;
  const quality = source.qualities?.[0];
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

function compatSecretOf(deps: ResolveAddonTokenDeps): string | null {
  const secret = deps.compatSecret ?? deps.secret;
  return typeof secret === 'string' && secret.length > 0 ? secret : null;
}

/**
 * Issues a signed compatibility reference for streams the classifier routes
 * to remux/transcode (GOAL 11→12). Only for non-HLS candidates that already
 * passed the playback boundary. The EXACT validated URL is carried INSIDE
 * the signed token — the compatibility endpoint accepts nothing but this
 * reference, so it can never act as an arbitrary URL proxy (GOAL 12/24).
 */
function compatReferenceOf(quality: PlayerQualityOption, context: { contentId: string; mediaType: string; season?: number; episode?: number }, payload: AddonTokenPayload, deps: ResolveAddonTokenDeps): AddonStreamCompatReference | null {
  const secret = compatSecretOf(deps);
  if (!secret) return null;
  const url = quality.url;
  if (typeof url !== 'string' || !url.startsWith('https://') || url.length > 2048) return null;
  const input: StreamCompatibilityInput = {
    protocol: quality.protocol,
    container: quality.container,
    codec: quality.codec,
    filename: quality.filename,
  };
  const verdict = classifyStreamCompatibility(input);
  if (!needsCompatibilityPath(verdict)) return null;
  const exp = Math.floor((deps.now ?? new Date()).getTime() / 1000) + ADDON_TOKEN_TTL_SECONDS;
  try {
    const token = signCompatToken(
      {
        s: payload.s,
        a: payload.a,
        c: context.contentId,
        m: context.mediaType,
        ...(context.season !== undefined ? { se: context.season } : {}),
        ...(context.episode !== undefined ? { ep: context.episode } : {}),
        u: url,
        k: verdict.action === 'remux' ? 'remux' : 'transcode',
        exp,
      },
      secret,
    );
    return { token, kind: verdict.action === 'remux' ? 'remux' : 'transcode' };
  } catch {
    // Reference issuance must never fail the stream — direct playback
    // remains available regardless.
    return null;
  }
}
