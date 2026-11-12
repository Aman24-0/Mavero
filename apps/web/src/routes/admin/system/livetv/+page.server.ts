/**
 * Admin 2.0 — Unified Live TV management workspace (Phase 4, R-1 workflow).
 *
 * The server layer of /admin/system/livetv. SECURITY CONTRACT:
 *
 *   * `requireAdmin()` on the load AND on every action (repo convention —
 *     client-side visibility is never authorization).
 *   * All reads/writes go through src/lib/server/livetv/admin-service.ts,
 *     which reuses the Phase 1 registry validators and the Phase 2/3
 *     refresh/preview/EPG services — no second pipeline, no weaker fetcher.
 *   * Refresh/preview actions are rate-limited per identity with the SAME
 *     additive rules the Phase 2/3 JSON endpoints use (`livetvAdmin*`) — a
 *     refresh spends a bounded upstream fetch + DB writes.
 *   * Fail-closed RLS (`public.is_admin()` policies) remains the DB-level
 *     twin of every write below; `livetv_config_meta` is read-only here.
 *   * Errors: typed `LivetvAdminError` messages (safe, actionable) through
 *     the standard `fail()` envelope; no stack traces, no raw provider
 *     responses, no signed URLs.
 *
 * R-1 SOURCE-FIRST WORKFLOW: the page's PRIMARY interface is the source
 * list — heading, one Add Source button, one row per source (name, type,
 * persisted ON/OFF toggle, Edit). The five-tab workflow, the overview
 * dashboard and the mapping/EPG tables are GONE from the primary UI (the
 * canonical/EPG/mapping model remains fully implemented server-side below
 * — nothing was deleted; `?tab=` URLs are accepted and harmlessly ignored
 * so old links never 400). The Edit sheet's channel section is served by
 * the bounded `?/sourceChannels` read action (paginated, searchable,
 * admin-gated) — no unbounded entry load ever reaches the browser.
 */

import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { checkRateLimit, clientIdentity, RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE } from '$lib/server/http/rate-limit';
import {
  LivetvAdminError,
  addLivetvChannelCandidate,
  addLivetvEndpoint,
  createLivetvChannel,
  createLivetvEpgMapping,
  createLivetvEpgSource,
  createLivetvSource,
  deleteLivetvChannel,
  deleteLivetvEpgMapping,
  deleteLivetvEpgSource,
  deleteLivetvEndpoint,
  deleteLivetvSource,
  getLivetvAdminOverview,
  getLatestLivetvRefreshHistoryBySource,
  getLivetvChannelCandidates,
  getLivetvEpgGuideDiagnostics,
  getLivetvEntryEndpoints,
  listLivetvChannels,
  listLivetvEntries,
  listLivetvEpgMappings,
  listLivetvEpgSources,
  listLivetvSourceChannelsForAdmin,
  listLivetvSourceDeleteImpacts,
  listLivetvSources,
  removeLivetvChannelCandidate,
  reorderLivetvSources,
  setLivetvChannelEnabled,
  setLivetvEndpointEnabled,
  setLivetvEntryEnabled,
  setLivetvEntryMapping,
  setLivetvEpgSourceEnabled,
  setLivetvSourceEnabled,
  updateLivetvChannel,
  updateLivetvChannelCandidate,
  updateLivetvEpgSource,
  updateLivetvEndpoint,
  updateLivetvSource
} from '$lib/server/livetv/admin-service';
import { type LivetvEndpointInput } from '$lib/server/livetv/registry';
import {
  getLivetvRefreshOutcomes,
  previewLivetvSource,
  refreshAllEligibleLivetvSources,
  refreshLivetvSource
} from '$lib/server/livetv/refresh-service';
import { getLivetvNavVisible, setLivetvNavVisible } from '$lib/server/livetv/nav-visibility';
import { previewLivetvEpgSource, refreshAllEligibleLivetvEpgSources, refreshLivetvEpgSource } from '$lib/server/livetv/epg/guide-service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Form parsing helpers (every field passes through service validation after)
// ---------------------------------------------------------------------------

function formText(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === 'string' ? value : undefined;
}

function formNumber(form: FormData, key: string): number | undefined {
  const value = formText(form, key);
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Builds the typed per-source-type config from the shared form fields (the
 *  registry validator rejects unknown keys, so exactly ONE shape may ship). */
function sourceConfigFromForm(form: FormData, sourceType: string): unknown {
  if (sourceType === 'm3u_playlist') return { playlistUrl: formText(form, 'playlistUrl') ?? '' };
  if (sourceType === 'api_provider') return { baseUrl: formText(form, 'baseUrl') ?? '' };
  if (sourceType === 'embed_provider') {
    return { allowedOrigins: (formText(form, 'allowedOrigins') ?? '').split(/[\s,]+/).filter((origin) => origin.trim() !== '') };
  }
  return {};
}

function toFailure(caught: unknown, fallback: string) {
  if (caught instanceof LivetvAdminError) return fail(400, { message: caught.message });
  if (caught instanceof Error) return fail(400, { message: caught.message || fallback });
  return fail(503, { message: fallback });
}

function requireUuidOr400(form: FormData, key: string, label: string): string {
  const value = formText(form, key);
  if (!value || !UUID_PATTERN.test(value)) throw new LivetvAdminError(`${label} is invalid.`);
  return value;
}

// ---------------------------------------------------------------------------
// Load — the bounded source-first read (auth first, always).
// ---------------------------------------------------------------------------

function parsePositiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/system/livetv' });

  // R-1: the primary interface is the SOURCE LIST. Legacy `?tab=` URLs are
  // accepted and harmlessly ignored (old links never 400; no tab state
  // exists anymore). One bounded read serves the whole view: the source
  // rows, the delete-impact map (the Edit sheet's confirmed delete), the
  // per-source durable last-refresh slice and the instance-local outcome
  // records (the sheet's refresh/preview result fallbacks).
  void url.searchParams.get('tab');

  const sourceOutcomes = getLivetvRefreshOutcomes().slice(0, 25);
  const [sources, impacts, latestSourceHistory] = await Promise.all([
    listLivetvSources(locals.supabase),
    listLivetvSourceDeleteImpacts(locals.supabase),
    getLatestLivetvRefreshHistoryBySource(locals.supabase)
  ]);
  const navVisible = await getLivetvNavVisible(locals.supabase);
  return { sources, impacts, latestSourceHistory, sourceOutcomes, navVisible };
};

// ---------------------------------------------------------------------------
// Actions — every mutation re-checks authorization server-side
// ---------------------------------------------------------------------------

export const actions: Actions = {
  // ---------------- Playback sources ----------------
  createSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=sources' });
    try {
      const form = await request.formData();
      const sourceType = formText(form, 'sourceType') ?? '';
      const source = await createLivetvSource(locals.supabase, {
        slug: formText(form, 'slug'),
        name: formText(form, 'name'),
        sourceType,
        status: formText(form, 'status'),
        visibility: formText(form, 'visibility'),
        priority: formNumber(form, 'priority'),
        enabled: formText(form, 'enabled') === 'on',
        description: formText(form, 'description'),
        config: sourceConfigFromForm(form, sourceType)
      });
      return { notice: `Created source ${source.slug}.` };
    } catch (caught) {
      return toFailure(caught, 'Unable to create the source.');
    }
  },
  updateSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=sources' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'Source');
      const sourceType = formText(form, 'sourceType') ?? '';
      await updateLivetvSource(locals.supabase, id, {
        name: formText(form, 'name'),
        status: formText(form, 'status'),
        visibility: formText(form, 'visibility'),
        priority: formNumber(form, 'priority'),
        description: formText(form, 'description'),
        config: sourceConfigFromForm(form, sourceType)
      });
      return { notice: 'Source updated.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to update the source.');
    }
  },
  toggleSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=sources' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'Source');
      await setLivetvSourceEnabled(locals.supabase, id, formText(form, 'enabled') === 'true');
      return { notice: 'Source state updated.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to change the source state.');
    }
  },
  setNavVisibility: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv' });
    try {
      const form = await request.formData();
      await setLivetvNavVisible(locals.supabase, formText(form, 'visible') === 'true');
      return { notice: 'Live TV nav visibility updated.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to change Live TV nav visibility.');
    }
  },
  reorderSources: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=sources' });
    try {
      const form = await request.formData();
      const positions: Array<{ id: string; priority: number }> = [];
      for (const [key, value] of form.entries()) {
        if (!key.startsWith('priority_')) continue;
        const id = key.slice('priority_'.length);
        if (!UUID_PATTERN.test(id)) throw new LivetvAdminError('Source is invalid.');
        const priority = Number(value);
        if (!Number.isSafeInteger(priority)) throw new LivetvAdminError('Priority must be an integer.');
        positions.push({ id, priority });
      }
      await reorderLivetvSources(locals.supabase, positions);
      return { notice: 'Source priority saved.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to save the source ordering.');
    }
  },
  deleteSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=sources' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'Source');
      await deleteLivetvSource(locals.supabase, id);
      return { notice: 'Source deleted.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to delete the source.');
    }
  },
  refreshSource: async ({ request, locals }) => {
    const verdict = checkRateLimit('livetvAdminRefresh', clientIdentity(request.headers, locals.user?.id));
    if (!verdict.allowed) return fail(429, { message: RATE_LIMITED_MESSAGE, code: RATE_LIMITED_ERROR_CODE });
    try {
      await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=sources' });
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'Source');
      const outcome = await refreshLivetvSource(locals.supabase, { id });
      return { outcome, refreshKind: 'source' as const };
    } catch (caught) {
      return toFailure(caught, 'The refresh failed or timed out. Try again.');
    }
  },
  refreshAllSources: async ({ request, locals }) => {
    const verdict = checkRateLimit('livetvAdminRefresh', clientIdentity(request.headers, locals.user?.id));
    if (!verdict.allowed) return fail(429, { message: RATE_LIMITED_MESSAGE, code: RATE_LIMITED_ERROR_CODE });
    try {
      await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=sources' });
      const result = await refreshAllEligibleLivetvSources(locals.supabase);
      return { batchOutcome: result, refreshKind: 'source' as const };
    } catch (caught) {
      return toFailure(caught, 'The refresh failed or timed out. Try again.');
    }
  },
  previewSource: async ({ request, locals }) => {
    const verdict = checkRateLimit('livetvAdminPreview', clientIdentity(request.headers, locals.user?.id));
    if (!verdict.allowed) return fail(429, { message: RATE_LIMITED_MESSAGE, code: RATE_LIMITED_ERROR_CODE });
    try {
      await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=sources' });
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'Source');
      const outcome = await previewLivetvSource(locals.supabase, { id });
      return { outcome, refreshKind: 'source-preview' as const };
    } catch (caught) {
      return toFailure(caught, 'The preview failed or timed out. Try again.');
    }
  },

  /**
   * R-1 — the Edit sheet's bounded channel-section read: ONE source's
   * imported entries, paginated (50/page) and searchable. Authorization is
   * re-checked here; the ids and page bounds are validated; the underlying
   * read is bounded (no unbounded entry load can reach the browser). The
   * response carries the sourceId it was computed for — the UI renders it
   * only while it still matches the sheet's source (no cross-source leak).
   */
  sourceChannels: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv' });
    try {
      const form = await request.formData();
      const sourceId = requireUuidOr400(form, 'sourceId', 'Source');
      const page = parsePositiveInt(formText(form, 'page') ?? null) ?? 0;
      const query = formText(form, 'q') ?? null;
      const entries = await listLivetvSourceChannelsForAdmin(locals.supabase, { sourceId, page, query });
      return { sourceChannels: { sourceId, ...entries } };
    } catch (caught) {
      return toFailure(caught, 'Unable to load the source channels.');
    }
  },

  // ---------------- Imported entries ----------------
  toggleEntry: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=entries' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'Entry');
      await setLivetvEntryEnabled(locals.supabase, id, formText(form, 'enabled') === 'true');
      return { notice: 'Entry state updated.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to change the entry state.');
    }
  },
  mapEntry: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=entries' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'Entry');
      await setLivetvEntryMapping(locals.supabase, id, formText(form, 'channelId') ?? null);
      return { notice: 'Entry mapping updated.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to update the entry mapping.');
    }
  },

  // ---------------- Canonical channels ----------------
  createChannel: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=channels' });
    try {
      const form = await request.formData();
      const channel = await createLivetvChannel(locals.supabase, {
        name: formText(form, 'name'),
        category: formText(form, 'category'),
        logoUrl: formText(form, 'logoUrl'),
        dedupKey: formText(form, 'dedupKey'),
        enabled: formText(form, 'enabled') === 'on',
        notes: formText(form, 'notes')
      });
      return { notice: 'Canonical channel created.', channelId: channel.id };
    } catch (caught) {
      return toFailure(caught, 'Unable to create the canonical channel.');
    }
  },
  updateChannel: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=channels' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'Canonical channel');
      await updateLivetvChannel(locals.supabase, id, {
        name: formText(form, 'name'),
        category: formText(form, 'category'),
        logoUrl: formText(form, 'logoUrl'),
        dedupKey: formText(form, 'dedupKey'),
        enabled: formText(form, 'enabled') === 'on',
        notes: formText(form, 'notes')
      });
      return { notice: 'Canonical channel updated.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to update the canonical channel.');
    }
  },
  toggleChannel: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=channels' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'Canonical channel');
      await setLivetvChannelEnabled(locals.supabase, id, formText(form, 'enabled') === 'true');
      return { notice: 'Channel state updated.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to change the channel state.');
    }
  },
  deleteChannel: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=channels' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'Canonical channel');
      await deleteLivetvChannel(locals.supabase, id);
      return { notice: 'Canonical channel deleted.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to delete the canonical channel.');
    }
  },

  // ---------------- Playback candidates (configuration only) ----------------
  addCandidate: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=channels' });
    try {
      const form = await request.formData();
      const channelId = requireUuidOr400(form, 'channelId', 'Canonical channel');
      const endpointId = requireUuidOr400(form, 'endpointId', 'Endpoint');
      await addLivetvChannelCandidate(locals.supabase, channelId, endpointId, {
        priority: formNumber(form, 'priority'),
        enabled: true
      });
      return { notice: 'Playback candidate added.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to add the playback candidate.');
    }
  },
  updateCandidate: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=channels' });
    try {
      const form = await request.formData();
      const channelId = requireUuidOr400(form, 'channelId', 'Canonical channel');
      const id = requireUuidOr400(form, 'id', 'Candidate');
      await updateLivetvChannelCandidate(locals.supabase, channelId, id, {
        priority: formNumber(form, 'priority'),
        enabled: formText(form, 'enabled') === undefined ? undefined : formText(form, 'enabled') === 'true'
      });
      return { notice: 'Playback candidate updated.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to update the playback candidate.');
    }
  },
  removeCandidate: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=channels' });
    try {
      const form = await request.formData();
      const channelId = requireUuidOr400(form, 'channelId', 'Canonical channel');
      const id = requireUuidOr400(form, 'id', 'Candidate');
      await removeLivetvChannelCandidate(locals.supabase, channelId, id);
      return { notice: 'Playback candidate removed.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to remove the playback candidate.');
    }
  },

  // ---------------- Typed endpoints ----------------
  addEndpoint: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=entries' });
    try {
      const form = await request.formData();
      const entryId = requireUuidOr400(form, 'entryId', 'Entry');
      const streamFormat = formText(form, 'streamFormat');
      const input: LivetvEndpointInput = {
        endpointKind: (formText(form, 'endpointKind') ?? '') as LivetvEndpointInput['endpointKind'],
        streamFormat: streamFormat === 'dash' || streamFormat === 'hls' ? streamFormat : streamFormat ? (streamFormat as never) : undefined,
        url: formText(form, 'url') ?? '',
        ordering: formNumber(form, 'ordering'),
        label: formText(form, 'label')
      };
      await addLivetvEndpoint(locals.supabase, entryId, input);
      return { notice: 'Endpoint added.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to add the endpoint.');
    }
  },
  updateEndpoint: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=entries' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'Endpoint');
      await updateLivetvEndpoint(locals.supabase, id, {
        endpointKind: formText(form, 'endpointKind'),
        streamFormat: formText(form, 'streamFormat'),
        url: formText(form, 'url'),
        ordering: formNumber(form, 'ordering'),
        enabled: formText(form, 'enabled') === undefined ? undefined : formText(form, 'enabled') === 'true',
        label: formText(form, 'label')
      });
      return { notice: 'Endpoint updated.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to update the endpoint.');
    }
  },
  toggleEndpoint: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=entries' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'Endpoint');
      await setLivetvEndpointEnabled(locals.supabase, id, formText(form, 'enabled') === 'true');
      return { notice: 'Endpoint state updated.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to change the endpoint state.');
    }
  },
  deleteEndpoint: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=entries' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'Endpoint');
      await deleteLivetvEndpoint(locals.supabase, id);
      return { notice: 'Endpoint deleted.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to delete the endpoint.');
    }
  },

  // ---------------- EPG sources ----------------
  createEpgSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=epg' });
    try {
      const form = await request.formData();
      const source = await createLivetvEpgSource(locals.supabase, {
        slug: formText(form, 'slug'),
        name: formText(form, 'name'),
        sourceUrl: formText(form, 'sourceUrl'),
        status: formText(form, 'status'),
        enabled: formText(form, 'enabled') === 'on',
        description: formText(form, 'description'),
        defaultTimezone: formText(form, 'defaultTimezone')
      });
      return { notice: `Created EPG source ${source.slug}.` };
    } catch (caught) {
      return toFailure(caught, 'Unable to create the EPG source.');
    }
  },
  updateEpgSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=epg' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'EPG source');
      await updateLivetvEpgSource(locals.supabase, id, {
        name: formText(form, 'name'),
        sourceUrl: formText(form, 'sourceUrl'),
        status: formText(form, 'status'),
        description: formText(form, 'description'),
        defaultTimezone: formText(form, 'defaultTimezone')
      });
      return { notice: 'EPG source updated.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to update the EPG source.');
    }
  },
  toggleEpgSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=epg' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'EPG source');
      await setLivetvEpgSourceEnabled(locals.supabase, id, formText(form, 'enabled') === 'true');
      return { notice: 'EPG source state updated.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to change the EPG source state.');
    }
  },
  deleteEpgSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=epg' });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'EPG source');
      await deleteLivetvEpgSource(locals.supabase, id);
      return { notice: 'EPG source deleted.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to delete the EPG source.');
    }
  },
  refreshEpgSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=epg' });
    const verdict = checkRateLimit('livetvAdminEpgRefresh', clientIdentity(request.headers, locals.user?.id));
    if (!verdict.allowed) return fail(429, { message: RATE_LIMITED_MESSAGE, code: RATE_LIMITED_ERROR_CODE });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'EPG source');
      const outcome = await refreshLivetvEpgSource(locals.supabase, { id });
      return { outcome, refreshKind: 'epg' as const };
    } catch (caught) {
      return toFailure(caught, 'The guide refresh failed.');
    }
  },
  refreshAllEpgSources: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=epg' });
    const verdict = checkRateLimit('livetvAdminEpgRefresh', clientIdentity(request.headers, locals.user?.id));
    if (!verdict.allowed) return fail(429, { message: RATE_LIMITED_MESSAGE, code: RATE_LIMITED_ERROR_CODE });
    try {
      const result = await refreshAllEligibleLivetvEpgSources(locals.supabase);
      return { batchOutcome: result, refreshKind: 'epg' as const };
    } catch (caught) {
      return toFailure(caught, 'The guide refresh failed.');
    }
  },
  previewEpgSource: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=epg' });
    const verdict = checkRateLimit('livetvAdminEpgPreview', clientIdentity(request.headers, locals.user?.id));
    if (!verdict.allowed) return fail(429, { message: RATE_LIMITED_MESSAGE, code: RATE_LIMITED_ERROR_CODE });
    try {
      const form = await request.formData();
      const id = requireUuidOr400(form, 'id', 'EPG source');
      const outcome = await previewLivetvEpgSource(locals.supabase, { id });
      return { outcome, refreshKind: 'epg-preview' as const };
    } catch (caught) {
      return toFailure(caught, 'The guide preview failed.');
    }
  },
  createEpgMapping: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=epg' });
    try {
      const form = await request.formData();
      const epgSourceId = requireUuidOr400(form, 'epgSourceId', 'EPG source');
      await createLivetvEpgMapping(locals.supabase, epgSourceId, formText(form, 'channelId') ?? '', formText(form, 'epgChannelId') ?? '');
      return { notice: 'EPG mapping created.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to create the EPG mapping.');
    }
  },
  deleteEpgMapping: async ({ request, locals }) => {
    await requireAdmin(locals, { redirectTo: '/admin/system/livetv?tab=epg' });
    try {
      const form = await request.formData();
      const epgSourceId = requireUuidOr400(form, 'epgSourceId', 'EPG source');
      const id = requireUuidOr400(form, 'id', 'Mapping');
      await deleteLivetvEpgMapping(locals.supabase, epgSourceId, id);
      return { notice: 'EPG mapping deleted.' };
    } catch (caught) {
      return toFailure(caught, 'Unable to delete the EPG mapping.');
    }
  }
};
