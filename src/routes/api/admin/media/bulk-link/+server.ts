/**
 * Task 2 (2026-10-15) — Bulk episode link API.
 * POST /api/admin/media/bulk-link
 *
 * Links MULTIPLE episodes of ONE season of ONE series/anime in a single
 * request. Each episode carries its OWN provider reference — bulk link
 * is explicitly NOT "one reference copied to N episodes": every
 * { episode, reference } pair becomes its own media_assets row keyed by
 * its own provider_asset_id, exactly as if the admin had submitted the
 * manual-link endpoint N times.
 *
 * Body:
 *   {
 *     contentType: 'series' | 'anime',   // bulk link is episodic-only
 *     tmdbId: string,
 *     season: number,                    // >= 1
 *     provider: 'vidara' | 'abyss',
 *     title?: string,                    // client-supplied series title
 *                                         // (skips the TMDB detail fetch)
 *     year?: number | string,
 *     posterPath?: string,
 *     backdropPath?: string,
 *     items: Array<{                     // 1..100 items
 *       episode: number,                 // >= 1
 *       reference: string,              // per-episode provider reference
 *       episodeTitle?: string,           // TMDB episode title (optional)
 *     }>
 *   }
 *
 * Response (always 200 for a well-formed batch — per-item outcomes):
 *   {
 *     ok: true,
 *     season, provider, contentType, tmdbId,
 *     total, succeeded, failed,
 *     results: Array<{
 *       episode, ok,
 *       mediaAssetId?, mode?,            // 'insert' | 'relink' | 'update' | 'idempotent'
 *       code?, message?                  // per-item failure reason
 *     }>
 *   }
 *
 * Structural problems (bad shape, duplicates, unknown provider) reject
 * the WHOLE batch with 400 BEFORE any write — the admin fixes the input
 * and resubmits; no partial state is created by an invalid request.
 * Per-episode problems (unreleased episode, bad reference, DB failure)
 * fail ONLY that episode; the rest of the batch proceeds.
 *
 * Contract sharing: every check and every write path is imported from
 * src/lib/server/hosting/media/manual-link-contract.ts — the SAME
 * normalization, allowlist, release-eligibility gate, provider-source
 * resolution, and asset upsert/audit logic the single-episode
 * manual-link endpoint uses. One definition, two endpoints.
 *
 * Security: admin-only (requireAdmin). Service-role client.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { resolveMediaItemId } from '$lib/server/hosting/media/manual-link-identity';
import {
  validateReference,
  normalizeReference,
  batchEpisodeEligibility,
  resolveProviderSource,
  upsertLinkAsset,
} from '$lib/server/hosting/media/manual-link-contract';
import { getDetail } from '$lib/server/content/service';
import type { ContentType } from '$lib/server/content/types';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

/** Hard cap so one request can never turn into an unbounded write loop. */
const MAX_BULK_ITEMS = 100;

type BulkItem = { episode: number; reference: string; episodeTitle?: string };

type BulkResult =
  | { episode: number; ok: true; mediaAssetId: string; mode: 'insert' | 'relink' | 'update' | 'idempotent' }
  | { episode: number; ok: false; code: string; message: string };

export const POST: RequestHandler = async ({ request, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);

  let body: {
    contentType?: string;
    tmdbId?: string;
    season?: string | number;
    provider?: string;
    title?: string;
    year?: string | number;
    posterPath?: string;
    backdropPath?: string;
    items?: Array<{ episode?: string | number; reference?: string; episodeTitle?: string }>;
  };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const { contentType, tmdbId, season, provider, title: clientTitle, year: clientYear, posterPath: clientPosterPath, backdropPath: clientBackdropPath, items: rawItems } = body;

  // ---------------- Structural validation (whole-batch rejects) ---------

  if (!contentType || !tmdbId || !provider || season == null || !rawItems) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'contentType, tmdbId, season, provider, and items are required.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  if (contentType !== 'series' && contentType !== 'anime') {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Bulk link is for series and anime-series episodes only. Movies are linked one at a time via manual-link.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  if (provider !== 'vidara' && provider !== 'abyss') {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'provider must be "vidara" or "abyss".' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const seasonNum = typeof season === 'number' ? season : Number(season);
  if (!Number.isInteger(seasonNum) || seasonNum <= 0) {
    return json({ ok: false, error: { code: 'EPISODE_REQUIRED', message: 'Bulk link requires a season number of 1 or greater.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return json({ ok: false, error: { code: 'BULK_ITEMS_REQUIRED', message: 'At least one { episode, reference } item is required.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (rawItems.length > MAX_BULK_ITEMS) {
    return json({ ok: false, error: { code: 'BULK_ITEMS_LIMIT', message: `A bulk link request may contain at most ${MAX_BULK_ITEMS} episodes. Split larger seasons into multiple requests.` } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const items: BulkItem[] = [];
  for (const raw of rawItems) {
    const epNum = raw?.episode == null ? NaN : Number(raw.episode);
    const ref = typeof raw?.reference === 'string' ? raw.reference : '';
    if (!Number.isInteger(epNum) || epNum <= 0) {
      return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Every item requires a positive integer episode.' } }, { status: 400, headers: NO_STORE_HEADERS });
    }
    if (!ref.trim()) {
      return json({ ok: false, error: { code: 'INVALID_REQUEST', message: `Episode ${epNum} is missing its provider reference. Every episode carries its own reference.` } }, { status: 400, headers: NO_STORE_HEADERS });
    }
    items.push({
      episode: epNum,
      reference: ref,
      episodeTitle: typeof raw.episodeTitle === 'string' && raw.episodeTitle.trim() ? raw.episodeTitle.trim() : undefined,
    });
  }

  // Duplicate episodes would fight over the same media_item identity.
  const dupEpisodes = items.map((i) => i.episode).filter((ep, idx, arr) => arr.indexOf(ep) !== idx);
  if (dupEpisodes.length > 0) {
    return json({ ok: false, error: { code: 'DUPLICATE_EPISODES', message: `Duplicate episodes in the batch: ${[...new Set(dupEpisodes)].sort((a, b) => a - b).join(', ')}. Each episode may appear exactly once.` } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // Duplicate references would map two episodes to ONE provider asset row
  // (the UNIQUE (provider_source_id, provider_asset_id) constraint) — the
  // later write would re-point the single row at the other media item.
  // That is NOT "per-episode references"; reject it structurally.
  const seenRefs = new Map<string, number>();
  const dupRefs: Array<{ ref: string; episodes: number[] }> = [];
  for (const it of items) {
    const normalized = normalizeReference(provider, it.reference);
    const key = normalized?.providerAssetId ?? it.reference.trim().toLowerCase();
    if (seenRefs.has(key)) {
      const existing = dupRefs.find((d) => d.ref === key);
      if (existing) { existing.episodes.push(it.episode); }
      else { dupRefs.push({ ref: key, episodes: [seenRefs.get(key)!, it.episode] }); }
    } else {
      seenRefs.set(key, it.episode);
    }
  }
  if (dupRefs.length > 0) {
    const detail = dupRefs.map((d) => `reference "${d.ref}" used by episodes ${d.episodes.join(' & ')}`).join('; ');
    return json({ ok: false, error: { code: 'DUPLICATE_REFERENCES', message: `Each episode needs its OWN distinct provider reference (a shared reference is not bulk linking). Conflicts: ${detail}.` } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // ---------------- Shared batch context ---------------------------------

  // Release-eligibility for the WHOLE season in ONE TMDB fetch — a
  // 100-episode batch must not perform 100 metadata requests.
  const eligibility = await batchEpisodeEligibility(contentType, tmdbId, seasonNum, items.map((i) => i.episode));

  // Series title/year — client-supplied when available (the episode sheet
  // already has it), TMDB detail fetch otherwise.
  let title: string;
  let year: number | null;
  try {
    if (clientTitle && typeof clientTitle === 'string' && clientTitle.trim()) {
      title = clientTitle.trim();
      year = (() => {
        if (clientYear == null) return null;
        const n = typeof clientYear === 'number' ? clientYear : parseInt(String(clientYear), 10);
        return Number.isInteger(n) ? n : null;
      })();
    } else {
      const detail = await getDetail('series' as ContentType, tmdbId);
      title = detail.title ?? 'Untitled';
      year = detail.year ?? null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resolve the series metadata.';
    return json({ ok: false, error: { code: 'MEDIA_ITEM_RESOLUTION_FAILED', message } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // Provider source — resolved ONCE; every item in the batch shares it.
  const providerSource = await resolveProviderSource(adminClient, provider);
  if (!providerSource.ok) {
    return json({ ok: false, error: { code: providerSource.code, message: providerSource.message } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const providerSourceId = providerSource.providerSourceId;

  // ---------------- Per-episode processing --------------------------------

  const results: BulkResult[] = [];
  for (const item of items) {
    // 1. Per-episode reference validation (structural shape checked above;
    //    this is the provider-allowlist + normalization contract).
    const refError = validateReference(provider, item.reference);
    if (refError) {
      results.push({ episode: item.episode, ok: false, code: 'INVALID_REQUEST', message: refError });
      continue;
    }

    // 2. Release-eligibility gate (from the single season metadata fetch).
    const eligibilityError = eligibility.get(item.episode);
    if (eligibilityError != null && eligibilityError !== '') {
      results.push({ episode: item.episode, ok: false, code: 'EPISODE_NOT_RELEASED', message: eligibilityError });
      continue;
    }

    const normalized = normalizeReference(provider, item.reference)!;

    // 3. Canonical episode identity (parent-ensure-first per item; the
    //    repeated parent upsert is an idempotent no-op after the first).
    let resolvedMediaItemId: string;
    try {
      resolvedMediaItemId = await resolveMediaItemId(mediaService, {
        contentType, tmdbId, title, year,
        seasonNum, episodeNum: item.episode,
        episodeTitle: item.episodeTitle ?? null,
        posterPath: clientPosterPath, backdropPath: clientBackdropPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resolve the media item.';
      results.push({ episode: item.episode, ok: false, code: 'MEDIA_ITEM_RESOLUTION_FAILED', message });
      continue;
    }

    // 4. The SAME insert/relink/update write path as manual-link.
    try {
      const upsert = await upsertLinkAsset({
        adminClient,
        adminUserId: user.id,
        resolvedMediaItemId,
        providerSourceId,
        providerAssetId: normalized.providerAssetId,
        playbackUrl: normalized.playbackUrl,
        via: 'bulk-link',
      });
      if (upsert.ok) {
        results.push({ episode: item.episode, ok: true, mediaAssetId: upsert.mediaAssetId, mode: upsert.mode });
      } else {
        results.push({ episode: item.episode, ok: false, code: upsert.code, message: upsert.message });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      results.push({ episode: item.episode, ok: false, code: 'UNKNOWN', message });
    }
  }

  // Order results by episode for a readable response regardless of the
  // input order.
  results.sort((a, b) => a.episode - b.episode);

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  return json(
    {
      ok: true,
      contentType, tmdbId, season: seasonNum, provider,
      total: results.length, succeeded, failed,
      results,
    },
    { headers: NO_STORE_HEADERS }
  );
};
