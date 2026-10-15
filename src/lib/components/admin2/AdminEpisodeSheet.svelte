<script lang="ts" module>
  /**
   * Task 2 (2026-10-15) — Accessible episode sheet for a parent
   * series / anime card in the Media Library.
   *
   * ROLE: the parent card opens ONE sheet; the sheet is the ONLY place
   * episodes are listed. It mirrors the player's episode-sheet
   * interaction model (season chips + scrollable episode list), adapted
   * to the admin's link-management domain:
   *
   *   - Season chips follow the EXACT Phase-1 sizing contract from
   *     PlayerShell.svelte: flex column sheet, rail with flex 0 0 auto
   *     chips, fixed 36px height, width from label + padding only,
   *     count in the aria-label (never inside the chip), rail scrolls
   *     horizontally, one 8px gap, no page-level overflow.
   *   - The episode list merges TWO data sources:
   *       1. GET /api/admin/media/library/{id}/episodes — the LINKED
   *          ground truth (which episodes have provider assets, on
   *          which provider, with what status).
   *       2. GET /api/content/series/series-{tmdbId} + /season/{n} —
   *          the TMDB season metadata (episode numbers, titles, air
   *          dates) so UNLINKED episodes render too and the
   *          release-eligibility UI is honest (isEpisodeReleased is
   *          the same shared helper the player uses).
   *   - Per-episode actions: Add link (unlinked + released), Update
   *     link + Delete (linked), all delegated to the parent list's
   *     single AdminAddFileWizard / delete confirm via callbacks.
   *   - BULK LINK (Task 3): "Bulk link this season" opens a form with
   *     ONE provider select and ONE reference input PER EPISODE —
   *     every episode carries its OWN provider reference (never a
   *     shared reference copied across episodes). Submit posts to
   *     /api/admin/media/bulk-link and renders per-episode outcomes.
   *   - BULK DELETE (Task 4; 2026-10-16 selection round): "Bulk delete"
   *     NEVER deletes by default. With MORE than one linked episode it
   *     opens an explicit selection view (only the season's LINKED
   *     episodes are listed; select-all is explicit; Continue opens a
   *     confirmation naming the exact selection). With EXACTLY ONE
   *     linked episode it confirms that single episode directly. Submit
   *     posts { parentId, season, episodeIds } to
   *     /api/admin/media/bulk-unlink — the server re-derives membership
   *     and rejects altered selections.
   *
   * Accessibility contract (same as the app's other sheets):
   *   role=dialog + aria-modal, labelled by the sheet title, focus
   *   trapped while open, Escape closes, focus restores to the opener,
   *   loading/error/empty states are aria-live polite.
   */
  import type { UpdateTarget } from './AdminAddFileWizard.svelte';

  export type EpisodeSheetParent = {
    /** media_items.id of the PARENT series/anime row. */
    id: string;
    title: string;
    /** 'series' | 'anime' (internal media_items content_type). */
    contentType: string;
    tmdbId: string;
    year?: number | null;
    posterPath?: string | null;
  };

  export type LinkedEpisode = {
    id: string;
    season: number | null;
    episode: number | null;
    episodeTitle: string | null;
    assets: Array<{
      id: string;
      provider_source_id: string | null;
      provider_asset_id: string | null;
      status: string;
      mavero_status: string;
    }>;
    hosting_state: string;
  };

  export type TmdbSeasonInfo = { number: number; title: string; episodeCount: number; airDate?: string };
  export type TmdbEpisodeInfo = { number: number; title: string; airDate?: string; still?: string };

  export type BulkOutcome = {
    episode: number;
    ok: boolean;
    message?: string;
    code?: string;
    mode?: string;
  };
</script>

<script lang="ts">
  import { X, Loader2, AlertCircle, RotateCw, Tv, Sparkles, Film, Link2, Trash2, Layers, CheckCircle2, ChevronLeft, ListPlus } from 'lucide-svelte';
  import { untrack } from 'svelte';
  import { isEpisodeReleased } from '$lib/shared/episode-eligibility';
  import type { UpdateTarget as WizardUpdateTarget } from './AdminAddFileWizard.svelte';
  import { dialogOpened, dialogClosed, isTopDialog } from './dialog-stack.svelte';

  const SHEET_DIALOG_ID = 'admin-episode-sheet';
  const BULK_DELETE_DIALOG_ID = 'admin-episode-sheet-bulk-delete';

  // --- Props ---
  let {
    open = $bindable(false),
    parent = null as EpisodeSheetParent | null,
    providers = [] as Array<{ adapterId: string; name: string; sourceId: string }>,
    /** Task 3: bump after a wizard save / delete confirm that happened
     * ABOVE this sheet — the sheet reloads its linked ground truth without
     * closing (selected season + scroll position preserved). */
    refreshKey = 0 as number,
    onclose = undefined as (() => void) | undefined,
    onsaved = undefined as (() => void) | undefined,
    onaddlink = undefined as ((target: { tmdbId: string; contentType: string; title: string; year?: number | null; season: number; episode: number; episodeTitle?: string | null; posterPath?: string | null }) => void) | undefined,
    onupdatelink = undefined as ((target: WizardUpdateTarget & { season?: number | null; episode?: number | null }) => void) | undefined,
    ondeletelink = undefined as ((target: { mediaAssetId: string; title: string; episodeLabel: string }) => void) | undefined,
  } = $props();

  // --- Linked-episode ground truth (admin API) ---
  let linkedEpisodes = $state<LinkedEpisode[]>([]);
  let linkedLoading = $state(false);
  let linkedError = $state<string | null>(null);
  let linkedToken = 0;

  // --- TMDB season metadata (public content API) ---
  let seasons = $state<TmdbSeasonInfo[]>([]);
  let seasonsLoading = $state(false);
  let seasonsError = $state<string | null>(null);
  let seasonsToken = 0;

  let activeSeason = $state<number | null>(null);
  let seasonEpisodes = $state<TmdbEpisodeInfo[]>([]);
  let seasonLoading = $state(false);
  let seasonError = $state<string | null>(null);
  let seasonToken = 0;

  // --- Bulk link mode (Task 3) ---
  let bulkOpen = $state(false);
  let bulkProvider = $state<string>('vidara');
  let bulkRefs = $state<Record<number, string>>({});
  let bulkSubmitting = $state(false);
  let bulkError = $state<string | null>(null);
  let bulkOutcomes = $state<BulkOutcome[] | null>(null);

  // --- Bulk delete mode (Task 4; 2026-10-16 selection round) ---
  // Case A (>1 linked episode): openBulkDelete() opens an explicit
  // SELECTION view first; nothing is deletable until episodes are
  // checked and the confirmation names the exact count.
  // Case B (exactly 1 linked episode): the selection screen is skipped —
  // the confirmation directly targets the sole linked episode.
  // Case C (0 linked): the action is disabled.
  let bulkDeleteSelectOpen = $state(false);
  let bulkDeleteSelected = $state<Set<number>>(new Set());
  let bulkDeleteConfirmOpen = $state(false);
  let bulkDeleting = $state(false);
  let bulkDeleteError = $state<string | null>(null);
  let bulkDeleteOutcomes = $state<BulkOutcome[] | null>(null);

  // --- Focus management ---
  let sheetEl = $state<HTMLElement | null>(null);
  let lastFocused: HTMLElement | null = null;
  // Stable re-query key: after a save the parent list REFRESHES (items
  // reset + remount), so the captured opener node can become detached.
  // We then re-find the opener by its data attribute instead.
  let openerKey: string | null = null;

  const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';
  function posterUrl(path?: string | null): string | null {
    if (!path) return null;
    if (path.startsWith('http')) return path;
    return `${TMDB_IMAGE_BASE}${path}`;
  }

  function providerNameForSource(sourceId: string | null): string {
    if (!sourceId) return 'Unknown';
    const p = providers.find((p) => p.sourceId === sourceId);
    return p?.name ?? p?.adapterId ?? 'Unknown';
  }

  // -------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------

  async function loadLinked() {
    if (!parent) return;
    const token = ++linkedToken;
    linkedLoading = true;
    linkedError = null;
    try {
      const res = await fetch(`/api/admin/media/library/${encodeURIComponent(parent.id)}/episodes`);
      const json = await res.json();
      if (token !== linkedToken) return;
      if (json.ok) {
        linkedEpisodes = (json.episodes ?? []) as LinkedEpisode[];
      } else {
        linkedError = json.error?.message ?? 'Failed to load linked episodes.';
        linkedEpisodes = [];
      }
    } catch (err) {
      if (token !== linkedToken) return;
      linkedError = err instanceof Error ? err.message : 'Failed to load linked episodes.';
      linkedEpisodes = [];
    } finally {
      if (token === linkedToken) linkedLoading = false;
    }
  }

  async function loadSeasons() {
    if (!parent) return;
    const token = ++seasonsToken;
    seasonsLoading = true;
    seasonsError = null;
    seasons = [];
    activeSeason = null;
    seasonEpisodes = [];
    try {
      // Same contract the Add File wizard uses: { ok, item } with the
      // Season[] at item.seasonsData (specials season 0 excluded).
      const endpoint = `/api/content/series/series-${encodeURIComponent(parent.tmdbId)}`;
      const res = await fetch(endpoint);
      if (token !== seasonsToken) return;
      if (!res.ok) {
        seasonsError = `Could not load seasons (HTTP ${res.status}).`;
        return;
      }
      const json = await res.json();
      if (token !== seasonsToken) return;
      const seasonsData = json?.item?.seasonsData;
      if (!Array.isArray(seasonsData) || seasonsData.length === 0) {
        seasonsError = 'No seasons found for this title.';
        return;
      }
      seasons = seasonsData.map((s: any) => ({
        number: s.number ?? s.season_number ?? 0,
        title: s.title ?? s.name ?? `Season ${s.number ?? 0}`,
        episodeCount: s.episodeCount ?? s.episode_count ?? 0,
        airDate: s.airDate ?? s.air_date,
      }));
      // Prefer the season with the most linked episodes (the admin is
      // most likely working there), else season 1.
      const linkedBySeason = new Map<number, number>();
      for (const ep of linkedEpisodes) {
        if (ep.season == null) continue;
        linkedBySeason.set(ep.season, (linkedBySeason.get(ep.season) ?? 0) + 1);
      }
      const busiest = [...linkedBySeason.entries()].sort((a, b) => b[1] - a[1])[0];
      const preferred = busiest && seasons.some((s) => s.number === busiest[0])
        ? busiest[0]
        : (seasons.find((s) => s.number > 0) ?? seasons[0])?.number ?? null;
      if (preferred != null) selectSeason(preferred);
    } catch (err) {
      if (token !== seasonsToken) return;
      seasonsError = err instanceof Error ? err.message : 'Could not load seasons.';
    } finally {
      if (token === seasonsToken) seasonsLoading = false;
    }
  }

  function selectSeason(seasonNumber: number) {
    if (activeSeason === seasonNumber && seasonEpisodes.length > 0) return;
    activeSeason = seasonNumber;
    bulkOpen = false;
    bulkOutcomes = null;
    bulkError = null;
    // Season switch leaves the bulk-delete selection view (the selection
    // belongs to the previous season's linked set).
    bulkDeleteSelectOpen = false;
    bulkDeleteSelected = new Set();
    void loadSeasonEpisodes(seasonNumber);
  }

  async function loadSeasonEpisodes(seasonNumber: number) {
    if (!parent) return;
    const token = ++seasonToken;
    seasonLoading = true;
    seasonError = null;
    seasonEpisodes = [];
    try {
      // Same contract the Add File wizard uses: { ok, season } with the
      // episodes at season.episodes.
      const endpoint = `/api/content/series/series-${encodeURIComponent(parent.tmdbId)}/season/${seasonNumber}`;
      const res = await fetch(endpoint);
      if (token !== seasonToken) return;
      if (!res.ok) {
        seasonError = `Could not load episodes (HTTP ${res.status}).`;
        return;
      }
      const json = await res.json();
      if (token !== seasonToken) return;
      const eps = json?.season?.episodes;
      if (!Array.isArray(eps) || eps.length === 0) {
        seasonError = 'No episodes found for this season.';
        return;
      }
      seasonEpisodes = eps.map((e: any) => ({
        number: e.number ?? e.episode_number ?? 0,
        title: e.title ?? e.name ?? `Episode ${e.number ?? 0}`,
        airDate: e.airDate ?? e.air_date,
        still: e.still,
      }));
    } catch (err) {
      if (token !== seasonToken) return;
      seasonError = err instanceof Error ? err.message : 'Could not load episodes.';
    } finally {
      if (token === seasonToken) seasonLoading = false;
    }
  }

  async function refreshAfterSave() {
    await loadLinked();
    onsaved?.();
  }

  // -------------------------------------------------------------
  // Open / close lifecycle (focus trap + restore + dialog stack)
  // -------------------------------------------------------------

  // Task 3 — register this sheet in the shared dialog stack so Escape and
  // backdrop interactions are owned by the TOPMOST dialog only (the wizard
  // and the delete confirmation open ABOVE this sheet).
  $effect(() => {
    if (open && parent) {
      dialogOpened(SHEET_DIALOG_ID);
      return () => dialogClosed(SHEET_DIALOG_ID);
    }
  });

  // Task 3 — external refresh signal: a wizard save / delete confirmation
  // that happened above this sheet bumps refreshKey; reload the linked
  // ground truth WITHOUT closing (season + scroll position preserved).
  $effect(() => {
    const key = refreshKey;
    if (key > 0) {
      untrack(() => {
        if (open && parent) void loadLinked();
      });
    }
  });

  $effect(() => {
    if (open && parent) {
      lastFocused = document.activeElement as HTMLElement | null;
      openerKey = parent.id;
      bulkOpen = false;
      bulkOutcomes = null;
      bulkRefs = {};
      bulkDeleteSelectOpen = false;
      bulkDeleteSelected = new Set();
      void loadLinked().then(() => loadSeasons());
      // Focus the sheet (its close button) once rendered.
      requestAnimationFrame(() => {
        sheetEl?.querySelector<HTMLElement>('[data-sheet-close]')?.focus();
      });
    }
  });

  function closeSheet() {
    open = false;
    bulkOpen = false;
    bulkOutcomes = null;
    bulkDeleteSelectOpen = false;
    bulkDeleteSelected = new Set();
    bulkDeleteConfirmOpen = false;
    bulkDeleteOutcomes = null;
    onclose?.();
    // Restore focus to the opener. If the list refreshed while the sheet
    // was open (a save triggered loadList), the captured node is detached —
    // re-query the opener by its stable key so focus still lands on the
    // (remounted) parent card button.
    let target = lastFocused;
    if (target && !target.isConnected) {
      target = openerKey
        ? document.querySelector<HTMLElement>(`[data-episode-sheet-opener="${CSS.escape(openerKey)}"]`)
        : null;
    }
    if (target && typeof target.focus === 'function') target.focus();
    lastFocused = null;
    openerKey = null;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      // Task 3 — only the TOPMOST dialog reacts. The bulk-delete
      // confirmation owns Escape while open; above it, the wizard owns
      // it (registered later = higher); below, the sheet. The in-sheet
      // selection view backs out of selection mode FIRST (one level per
      // press — never closes the whole sheet from the selection view).
      if (bulkDeleteConfirmOpen) {
        onBulkDeleteKeydown(event);
        return;
      }
      if (!isTopDialog(SHEET_DIALOG_ID)) return;
      event.stopPropagation();
      if (bulkDeleteSelectOpen) {
        closeBulkDeleteSelect();
        return;
      }
      closeSheet();
      return;
    }
    // Minimal focus trap: keep Tab inside the sheet while open.
    if (event.key === 'Tab' && sheetEl) {
      const focusables = Array.from(
        sheetEl.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === sheetEl)) {
        event.preventDefault();
        last.focus();
      }
    }
  }

  // -------------------------------------------------------------
  // Derived episode view (TMDB metadata + linked ground truth)
  // -------------------------------------------------------------

  type EpisodeView = {
    number: number;
    title: string;
    airDate?: string;
    released: boolean;
    linked: LinkedEpisode | null;
    asset: LinkedEpisode['assets'][number] | null;
  };

  let episodeViews = $derived.by<EpisodeView[]>(() => {
    const byNumber = new Map<number, LinkedEpisode>();
    for (const ep of linkedEpisodes) {
      if (ep.season === activeSeason && ep.episode != null) byNumber.set(ep.episode, ep);
    }
    return seasonEpisodes.map((tmdb) => {
      const linked = byNumber.get(tmdb.number) ?? null;
      const asset = linked?.assets.find((a) => a.status !== 'deleted') ?? linked?.assets[0] ?? null;
      return {
        number: tmdb.number,
        title: tmdb.title,
        airDate: tmdb.airDate,
        released: isEpisodeReleased({ airDate: tmdb.airDate }, { hasConfirmedPlayableSource: asset != null }),
        linked,
        asset,
      };
    });
  });

  let linkedCountThisSeason = $derived.by(() => episodeViews.filter((v) => v.linked && (v.linked.assets ?? []).some((a) => a.status !== 'deleted')).length);
  let seasonChipLabel = (s: TmdbSeasonInfo) => `Season ${s.number}${s.episodeCount ? `, ${s.episodeCount} episodes` : ''}`;

  // -------------------------------------------------------------
  // Task 1 — honest header counts.
  //
  // linked = episodes with at least one ACTIVE asset (NOT the raw row
  // count — an unlinked episode keeps its media_items row, so the row
  // count over-reports after a delete).
  //
  // total = the COMPLETE TMDB season metadata sum (the same denominator
  // the library service serves). Local rows in seasons TMDB does not
  // know about are added so linked<=total always holds. When the season
  // metadata is unavailable, no denominator is shown — a total is never
  // invented.
  // -------------------------------------------------------------
  let linkedActiveCount = $derived.by(() =>
    linkedEpisodes.filter((ep) => (ep.assets ?? []).some((a) => a.status !== 'deleted')).length
  );
  let headerTotalEpisodes = $derived.by(() => {
    if (seasons.length === 0) return null;
    const metadataSeasons = new Set(seasons.map((s) => s.number));
    const metadataTotal = seasons.reduce((sum, s) => sum + (s.episodeCount || 0), 0);
    const localOutsideMetadata = linkedEpisodes.filter(
      (ep) => ep.season != null && !metadataSeasons.has(ep.season)
    ).length;
    return metadataTotal + localOutsideMetadata;
  });
  let headerSeasonCount = $derived.by(() => {
    const seen = new Set<number>(seasons.map((s) => s.number));
    for (const ep of linkedEpisodes) {
      if (ep.season != null) seen.add(ep.season);
    }
    return seen.size;
  });

  // -------------------------------------------------------------
  // Actions (delegate to the parent list's wizard / delete dialog)
  // -------------------------------------------------------------

  function addLink(view: EpisodeView) {
    if (!parent || !view.released) return;
    onaddlink?.({
      tmdbId: parent.tmdbId,
      contentType: parent.contentType,
      title: parent.title,
      year: parent.year ?? null,
      season: activeSeason!,
      episode: view.number,
      episodeTitle: view.title,
      posterPath: parent.posterPath ?? null,
    });
  }

  function updateLink(view: EpisodeView) {
    if (!parent || !view.asset) return;
    onupdatelink?.({
      mediaAssetId: view.asset.id,
      title: parent.title,
      contentType: parent.contentType,
      tmdbId: parent.tmdbId,
      providerName: providerNameForSource(view.asset.provider_source_id),
      providerAssetId: view.asset.provider_asset_id ?? '',
      season: activeSeason,
      episode: view.number,
    });
  }

  function deleteLink(view: EpisodeView) {
    if (!parent || !view.asset) return;
    ondeletelink?.({
      mediaAssetId: view.asset.id,
      title: parent.title,
      episodeLabel: `S${activeSeason}E${view.number} — ${view.title}`,
    });
  }

  // -------------------------------------------------------------
  // Bulk link (Task 3) — per-episode references, one POST
  // -------------------------------------------------------------

  function openBulkMode() {
    if (!parent || seasonEpisodes.length === 0) return;
    bulkProvider = providers[0]?.adapterId?.toLowerCase().includes('abyss') ? providers[0].adapterId : 'vidara';
    bulkRefs = {};
    bulkOutcomes = null;
    bulkError = null;
    bulkOpen = true;
  }

  let bulkCandidateViews = $derived.by<EpisodeView[]>(() => episodeViews.filter((v) => v.released));

  function bulkRefsFilled(): number {
    return bulkCandidateViews.filter((v) => (bulkRefs[v.number] ?? '').trim()).length;
  }

  async function submitBulk() {
    if (!parent || activeSeason == null) return;
    const items = bulkCandidateViews
      .filter((v) => (bulkRefs[v.number] ?? '').trim())
      .map((v) => ({
        episode: v.number,
        reference: (bulkRefs[v.number] ?? '').trim(),
        episodeTitle: v.title,
      }));
    if (items.length === 0) {
      bulkError = 'Enter at least one provider reference.';
      return;
    }
    bulkSubmitting = true;
    bulkError = null;
    try {
      const res = await fetch('/api/admin/media/bulk-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentType: parent.contentType,
          tmdbId: parent.tmdbId,
          season: activeSeason,
          provider: bulkProvider,
          title: parent.title,
          ...(parent.year != null ? { year: parent.year } : {}),
          ...(parent.posterPath ? { posterPath: parent.posterPath } : {}),
          items,
        }),
      });
      const json = await res.json();
      if (res.status === 400 && json?.error?.code === 'DUPLICATE_REFERENCES') {
        // Structural: surface the message, keep the form intact so the
        // admin can fix the conflicting inputs in place.
        bulkError = json.error.message;
        return;
      }
      if (json.ok) {
        bulkOutcomes = (json.results ?? []).map((r: any) => ({
          episode: r.episode,
          ok: r.ok === true,
          message: r.message,
          code: r.code,
          mode: r.mode,
        }));
        await refreshAfterSave();
      } else {
        bulkError = json?.error?.message ?? 'Bulk link failed.';
      }
    } catch (err) {
      bulkError = err instanceof Error ? err.message : 'Network error during bulk link.';
    } finally {
      bulkSubmitting = false;
    }
  }

  // -------------------------------------------------------------
  // Bulk delete (Task 4; 2026-10-16 selection round) — remove the
  // Mavero associations of SELECTED linked episodes.
  // -------------------------------------------------------------

  /** The linked episodes of the current season that are ELIGIBLE for
   *  bulk deletion (listed in the selection view — nothing else is
   *  offered for deletion). Eligible = at least one ACTIVE (non-deleted)
   *  asset — exactly the set the season toolbar's linked count reports. */
  let bulkDeleteCandidates = $derived.by<EpisodeView[]>(() =>
    episodeViews.filter((v) => v.linked != null && (v.linked.assets ?? []).some((a) => a.status !== 'deleted'))
  );

  function openBulkDelete() {
    if (!parent || activeSeason == null) return;
    if (linkedCountThisSeason === 0) return; // Case C — nothing linked, no destructive action
    bulkDeleteError = null;
    bulkDeleteOutcomes = null;
    if (linkedCountThisSeason === 1) {
      // Case B — exactly ONE linked episode: skip the selection screen,
      // confirm the single episode directly.
      const sole = bulkDeleteCandidates[0];
      if (!sole) return;
      bulkDeleteSelected = new Set([sole.number]);
      bulkDeleteSelectOpen = false;
      bulkDeleteConfirmOpen = true;
      return;
    }
    // Case A — more than one linked episode: EXPLICIT selection first.
    bulkDeleteSelected = new Set();
    bulkDeleteSelectOpen = true;
  }

  function closeBulkDeleteSelect() {
    if (bulkDeleting) return;
    bulkDeleteSelectOpen = false;
    bulkDeleteSelected = new Set();
  }

  function toggleBulkDeleteEpisode(number: number, checked: boolean) {
    const next = new Set(bulkDeleteSelected);
    if (checked) next.add(number);
    else next.delete(number);
    bulkDeleteSelected = next;
  }

  function toggleBulkDeleteSelectAll() {
    if (bulkDeleteSelected.size === bulkDeleteCandidates.length) {
      bulkDeleteSelected = new Set();
    } else {
      bulkDeleteSelected = new Set(bulkDeleteCandidates.map((v) => v.number));
    }
  }

  function confirmBulkDeleteSelection() {
    // Continue from the selection view to the confirmation. An empty
    // selection can never reach this (the button is disabled), but the
    // guard keeps the contract server-side too.
    if (bulkDeleteSelected.size === 0) {
      bulkDeleteError = 'Select at least one linked episode.';
      return;
    }
    bulkDeleteConfirmOpen = true;
  }

  function closeBulkDeleteConfirm() {
    if (bulkDeleting) return; // no closing mid-flight
    bulkDeleteConfirmOpen = false;
    bulkDeleteError = null;
    if (bulkDeleteOutcomes) {
      // Post-results "Done": leave the flow entirely (selection view +
      // outcomes) — the episode list and linked counts have already been
      // refreshed by refreshAfterSave().
      bulkDeleteOutcomes = null;
      bulkDeleteSelectOpen = false;
      bulkDeleteSelected = new Set();
      return;
    }
    // Pre-submit cancel: return to the STILL-OPEN selection view (Case A)
    // with the selection preserved, or to the episode list (Case B) —
    // nothing was deleted.
  }

  function selectedEpisodeLabels(): string[] {
    return [...bulkDeleteSelected].sort((a, b) => a - b).map((n) => {
      const view = episodeViews.find((v) => v.number === n);
      return view ? `E${n} — ${view.title}` : `E${n}`;
    });
  }

  function onBulkDeleteKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && bulkDeleteConfirmOpen) {
      if (!isTopDialog(BULK_DELETE_DIALOG_ID)) return;
      event.stopPropagation();
      closeBulkDeleteConfirm();
    }
  }
  // The single window-level handler routes Escape to the topmost dialog:
  // the bulk-delete confirmation when it is open, otherwise the sheet.

  $effect(() => {
    if (bulkDeleteConfirmOpen) {
      dialogOpened(BULK_DELETE_DIALOG_ID);
      return () => dialogClosed(BULK_DELETE_DIALOG_ID);
    }
  });

  async function submitBulkDelete() {
    if (!parent || activeSeason == null || bulkDeleting) return;
    if (bulkDeleteSelected.size === 0) {
      bulkDeleteError = 'Select at least one linked episode.';
      return;
    }
    bulkDeleting = true;
    bulkDeleteError = null;
    try {
      const res = await fetch('/api/admin/media/bulk-unlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentId: parent.id,
          season: activeSeason,
          // ONLY the explicitly selected episodes — the server rejects
          // an absent/empty selection and re-verifies every id against
          // THIS parent + season.
          episodeIds: [...bulkDeleteSelected].sort((a, b) => a - b),
        }),
      });
      const json = await res.json();
      if (json.ok) {
        bulkDeleteOutcomes = (json.results ?? []).map((r: any) => ({
          episode: r.episode,
          ok: r.ok === true,
          message: r.message,
          code: r.code,
          mode: r.mode,
        }));
        await refreshAfterSave();
      } else {
        bulkDeleteError = json?.error?.message ?? 'Bulk delete failed.';
      }
    } catch (err) {
      bulkDeleteError = err instanceof Error ? err.message : 'Network error during bulk delete.';
    } finally {
      bulkDeleting = false;
    }
  }

  function bulkDeleteFailedCount(): number {
    return (bulkDeleteOutcomes ?? []).filter((o) => !o.ok).length;
  }

  /** Retry round: only episodes that STILL have associations are
   * re-processed (the server derives the set; successful ones report
   * idempotent). */
  function retryBulkDeleteFailed() {
    bulkDeleteOutcomes = null;
    bulkDeleteError = null;
    void submitBulkDelete();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open && parent}
  <div class="episode-sheet-overlay" onclick={closeSheet} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      bind:this={sheetEl}
      class="episode-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="episode-sheet-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <!-- Header: poster + identity + progress + close -->
      <div class="sheet-head">
        <div class="head-poster">
          {#if posterUrl(parent.posterPath)}
            <img src={posterUrl(parent.posterPath)} alt="" />
          {:else}
            {#if parent.contentType === 'anime'}<Sparkles size={20} />{:else}<Tv size={20} />{/if}
          {/if}
        </div>
        <div class="head-info">
          <p class="head-eyebrow">{parent.contentType === 'anime' ? 'Anime Series' : 'TV Series'} · TMDB {parent.tmdbId}</p>
          <h2 id="episode-sheet-title" class="head-title">{parent.title}{parent.year ? ` (${parent.year})` : ''}</h2>
          {#if linkedLoading}
            <p class="head-progress" aria-live="polite"><Loader2 size={12} class="spinner" /> Loading episodes…</p>
          {:else if linkedError}
            <p class="head-progress head-progress-error">{linkedError}</p>
          {:else if headerTotalEpisodes != null}
            <p class="head-progress" aria-live="polite">
              {linkedActiveCount}/{headerTotalEpisodes} linked
              · {headerSeasonCount} season{headerSeasonCount === 1 ? '' : 's'}
            </p>
          {:else}
            <p class="head-progress" aria-live="polite">
              {linkedActiveCount} linked episode{linkedActiveCount === 1 ? '' : 's'}
              · {headerSeasonCount} season{headerSeasonCount === 1 ? '' : 's'}
            </p>
          {/if}
        </div>
        <button type="button" class="close-button" data-sheet-close onclick={closeSheet} aria-label="Close episode sheet">
          <X size={16} />
        </button>
      </div>

      <!-- Season rail — Phase-1 chip sizing contract (identical rules to
           PlayerShell: flex 0 0 auto chips, fixed 36px height, width from
           label + padding only, count via aria-label, rail scrolls, no
           page overflow). -->
      {#if seasonsLoading}
        <div class="season-state" aria-live="polite"><Loader2 size={14} class="spinner" /> Loading seasons…</div>
      {:else if seasonsError}
        <div class="season-state season-state-error" role="alert">
          <AlertCircle size={14} /> {seasonsError}
          <button type="button" class="retry-btn" onclick={() => loadSeasons()}>Retry</button>
        </div>
      {:else if seasons.length > 0}
        <div class="season-row" role="tablist" aria-label="Seasons">
          {#each seasons as season (season.number)}
            <button
              type="button"
              class="season-chip"
              class:active={activeSeason === season.number}
              role="tab"
              aria-selected={activeSeason === season.number}
              aria-current={activeSeason === season.number ? 'true' : undefined}
              aria-label={seasonChipLabel(season)}
              onclick={() => selectSeason(season.number)}
            >
              Season {season.number}
            </button>
          {/each}
        </div>
      {/if}

      <!-- Season toolbar: progress + bulk actions (Task 3 + Task 4).
           The two bulk actions are GROUPED (link + delete) and wrap on
           narrow viewports. -->
      {#if activeSeason != null && !bulkOpen}
        <div class="season-toolbar">
          <span class="season-progress" aria-live="polite">
            {#if seasonLoading}
              <Loader2 size={11} class="spinner" /> Loading…
            {:else}
              {#if seasonEpisodes.length > 0}
                {linkedCountThisSeason}/{seasonEpisodes.length} linked
              {:else}
                {linkedCountThisSeason} linked
              {/if}
            {/if}
          </span>
          <div class="bulk-actions" role="group" aria-label="Bulk actions for season {activeSeason}">
            <button
              type="button"
              class="bulk-btn"
              onclick={openBulkMode}
              disabled={seasonLoading || seasonEpisodes.length === 0}
              aria-label="Bulk link multiple episodes of this season, each with its own provider reference"
            >
              <ListPlus size={13} />
              <span>Bulk link season</span>
            </button>
            <button
              type="button"
              class="bulk-btn bulk-btn-danger"
              onclick={openBulkDelete}
              disabled={seasonLoading || linkedCountThisSeason === 0}
              aria-label="Select linked episodes of this season to delete (Mavero associations only; provider files are preserved)"
            >
              <Trash2 size={13} />
              <span>Bulk delete</span>
            </button>
          </div>
        </div>
      {/if}

      <!-- Main area: episode list, bulk-link form, or bulk-delete selection -->
      <div class="sheet-body">
        {#if bulkOpen}
          <!-- BULK LINK MODE (Task 3): one provider + ONE REFERENCE PER
               EPISODE. Each input is its own labeled field; nothing is
               shared or copied across episodes. -->
          <div class="bulk-form">
            <div class="bulk-head">
              <button type="button" class="back-btn" onclick={() => { bulkOpen = false; bulkOutcomes = null; bulkError = null; }} aria-label="Back to episode list">
                <ChevronLeft size={14} />
              </button>
              <div class="bulk-title">
                <h3>Bulk link — Season {activeSeason}</h3>
                <p>Each episode below carries its <strong>own</strong> provider reference. A shared reference is rejected.</p>
              </div>
            </div>

            <div class="bulk-provider-row">
              <label class="field-label" for="bulk-provider">Provider</label>
              <select id="bulk-provider" class="ref-input" bind:value={bulkProvider}>
                {#each providers as p (p.sourceId)}
                  <option value={p.adapterId}>{p.name}</option>
                {/each}
                {#if providers.length === 0}
                  <option value="vidara">Vidara</option>
                  <option value="abyss">Abyss</option>
                {/if}
              </select>
            </div>

            {#if bulkOutcomes}
              <div class="bulk-outcomes" role="status">
                <p class="outcome-summary">
                  {bulkOutcomes.filter((o) => o.ok).length} linked · {bulkOutcomes.filter((o) => !o.ok).length} failed
                </p>
                {#each bulkOutcomes as outcome (outcome.episode)}
                  <div class="outcome-row" class:outcome-ok={outcome.ok} class:outcome-fail={!outcome.ok}>
                    {#if outcome.ok}
                      <CheckCircle2 size={13} /> <span>E{outcome.episode} linked{outcome.mode === 'idempotent' ? ' (already linked)' : ''}.</span>
                    {:else}
                      <AlertCircle size={13} /> <span>E{outcome.episode}: {outcome.message}</span>
                    {/if}
                  </div>
                {/each}
                <button type="button" class="retry-btn" onclick={() => { bulkOutcomes = null; }}>Link more</button>
              </div>
            {:else}
              <div class="bulk-rows">
                {#each bulkCandidateViews as view (view.number)}
                  <div class="bulk-row">
                    <span class="bulk-ep">E{view.number}</span>
                    <span class="bulk-ep-title" title={view.title}>{view.title}</span>
                    <input
                      type="text"
                      class="bulk-ref-input"
                      placeholder="filecode or URL"
                      value={bulkRefs[view.number] ?? ''}
                      oninput={(e) => { bulkRefs = { ...bulkRefs, [view.number]: (e.target as HTMLInputElement).value }; }}
                      aria-label="Provider reference for episode {view.number}, {view.title}"
                    />
                  </div>
                {/each}
              </div>

              {#if bulkError}
                <div class="bulk-error" role="alert"><AlertCircle size={14} /> {bulkError}</div>
              {/if}

              <div class="bulk-actions">
                <span class="bulk-count">{bulkRefsFilled()} reference{bulkRefsFilled() === 1 ? '' : 's'} entered</span>
                <button type="button" class="btn btn-apply" onclick={submitBulk} disabled={bulkSubmitting || bulkRefsFilled() === 0}>
                  {#if bulkSubmitting}<Loader2 size={13} class="spinner" /> Linking…{:else}<Link2 size={13} /> Link {bulkRefsFilled() || ''} episode{bulkRefsFilled() === 1 ? '' : 's'}{/if}
                </button>
              </div>
            {/if}
          </div>
        {:else if bulkDeleteSelectOpen}
          <!-- BULK DELETE SELECTION (2026-10-16 round, Case A): ONLY the
               LINKED episodes of this season are listed; each carries its
               own checkbox. Nothing is deleted from this view — the
               Continue action opens the confirmation naming the exact
               selection. -->
          <div class="bulk-form" data-bulk-delete-select>
            <div class="bulk-head">
              <button type="button" class="back-btn" onclick={closeBulkDeleteSelect} aria-label="Back to episode list">
                <ChevronLeft size={14} />
              </button>
              <div class="bulk-title">
                <h3>Bulk delete — Season {activeSeason}</h3>
                <p>Select the linked episodes whose Mavero associations should be removed. Unselected episodes stay linked.</p>
              </div>
            </div>

            <div class="bulk-delete-tools">
              <button
                type="button"
                class="select-all-btn"
                onclick={toggleBulkDeleteSelectAll}
                aria-pressed={bulkDeleteSelected.size === bulkDeleteCandidates.length && bulkDeleteCandidates.length > 0}
              >
                {bulkDeleteSelected.size === bulkDeleteCandidates.length && bulkDeleteCandidates.length > 0 ? 'Clear all' : 'Select all'} ({bulkDeleteCandidates.length})
              </button>
              <span class="bulk-count" aria-live="polite">
                {bulkDeleteSelected.size} of {bulkDeleteCandidates.length} linked episode{bulkDeleteCandidates.length === 1 ? '' : 's'} selected
              </span>
            </div>

            <div class="bulk-rows" role="group" aria-label="Episodes eligible for bulk delete in season {activeSeason}">
              {#each bulkDeleteCandidates as view (view.number)}
                <label class="bulk-delete-row" data-checked={bulkDeleteSelected.has(view.number)}>
                  <input
                    type="checkbox"
                    class="bulk-delete-check"
                    checked={bulkDeleteSelected.has(view.number)}
                    onchange={(e) => toggleBulkDeleteEpisode(view.number, (e.target as HTMLInputElement).checked)}
                    aria-label="Select episode {view.number}, {view.title}, for bulk delete"
                  />
                  <span class="bulk-ep">E{view.number}</span>
                  <span class="bulk-ep-title" title={view.title}>{view.title}</span>
                  {#if view.asset}
                    <span class="badge-provider" data-provider={providerNameForSource(view.asset.provider_source_id).toLowerCase()}>
                      {providerNameForSource(view.asset.provider_source_id)}
                    </span>
                  {/if}
                </label>
              {/each}
            </div>

            {#if bulkDeleteError}
              <div class="bulk-error" role="alert"><AlertCircle size={14} /> {bulkDeleteError}</div>
            {/if}

            <div class="bulk-actions">
              <button type="button" class="bulk-delete-btn" onclick={closeBulkDeleteSelect}>Cancel</button>
              <button type="button" class="btn btn-apply btn-apply-danger" onclick={confirmBulkDeleteSelection} disabled={bulkDeleteSelected.size === 0}>
                <Trash2 size={13} /> Continue — {bulkDeleteSelected.size} episode{bulkDeleteSelected.size === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        {:else if seasonLoading}
          <div class="season-state" aria-live="polite"><Loader2 size={14} class="spinner" /> Loading episodes…</div>
        {:else if seasonError}
          <div class="season-state season-state-error" role="alert">
            <AlertCircle size={14} /> {seasonError}
            <button type="button" class="retry-btn" onclick={() => activeSeason != null && loadSeasonEpisodes(activeSeason)}>Retry</button>
          </div>
        {:else if seasonEpisodes.length === 0}
          <div class="season-state"><Film size={22} /><p>No episodes in this season.</p></div>
        {:else}
          <div class="episode-list" role="list" aria-label="Episodes of season {activeSeason}">
            {#each episodeViews as view (view.number)}
              <div class="episode-row" role="listitem" data-linked={view.linked != null && (view.linked.assets ?? []).some((a) => a.status !== 'deleted')} data-released={view.released}>
                <span class="ep-number">E{view.number}</span>
                <div class="ep-info">
                  <span class="ep-title" title={view.title}>{view.title}</span>
                  <span class="ep-meta">
                    {#if view.airDate}<span class="ep-air">{view.airDate}</span>{/if}
                    {#if view.linked && view.asset}
                      <span class="badge-provider" data-provider={providerNameForSource(view.asset.provider_source_id).toLowerCase()}>
                        {providerNameForSource(view.asset.provider_source_id)}
                      </span>
                      <span class="badge-status" data-state={view.asset.mavero_status}>{view.asset.mavero_status}</span>
                    {:else if view.released}
                      <span class="badge-unlinked">Not linked</span>
                    {:else}
                      <span class="badge-unreleased" title="Air date not passed yet — linking is disabled">Not released</span>
                    {/if}
                  </span>
                </div>
                <div class="ep-actions">
                  {#if view.released}
                    {#if view.asset}
                      <button type="button" class="ep-btn" onclick={() => updateLink(view)} aria-label="Update link for episode {view.number}">
                        <Link2 size={13} />
                      </button>
                      <button type="button" class="ep-btn ep-btn-danger" onclick={() => deleteLink(view)} aria-label="Delete link for episode {view.number}">
                        <Trash2 size={13} />
                      </button>
                    {:else}
                      <button type="button" class="ep-btn ep-btn-add" onclick={() => addLink(view)} aria-label="Add link for episode {view.number}">
                        <Link2 size={13} /> <span>Add</span>
                      </button>
                    {/if}
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- 2026-10-16 selection round — bulk-delete confirmation. Sibling of
       the sheet overlay, z-index ABOVE the sheet (93) and BELOW the
       wizard (94). Confirms the EXPLICIT selection (Case A) or the single
       sole linked episode (Case B); Escape/Cancel returns to the
       still-open flow without deleting anything. -->
  {#if bulkDeleteConfirmOpen}
    <div class="bulk-delete-overlay" onclick={() => { if (!bulkDeleting) closeBulkDeleteConfirm(); }} role="presentation">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="bulk-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-delete-title"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
      >
        {#if bulkDeleteOutcomes}
          <h3 id="bulk-delete-title"><Trash2 size={16} /> Bulk delete — results</h3>
          <p class="bulk-delete-desc">
            {bulkDeleteOutcomes.filter((o) => o.ok).length} episode{(bulkDeleteOutcomes.filter((o) => o.ok).length === 1 ? '' : 's')} processed
            · {bulkDeleteFailedCount()} failed
          </p>
          <div class="bulk-delete-outcomes" role="status">
            {#each bulkDeleteOutcomes as outcome (outcome.episode)}
              <div class="outcome-row" class:outcome-ok={outcome.ok} class:outcome-fail={!outcome.ok}>
                {#if outcome.ok}
                  <CheckCircle2 size={13} />
                  <span>E{outcome.episode} {outcome.mode === 'idempotent' ? 'already unlinked' : 'unlinked'}.</span>
                {:else}
                  <AlertCircle size={13} />
                  <span>E{outcome.episode}: {outcome.message}</span>
                {/if}
              </div>
            {/each}
          </div>
          <div class="bulk-delete-actions">
            {#if bulkDeleteFailedCount() > 0}
              <button type="button" class="bulk-delete-btn" onclick={retryBulkDeleteFailed} disabled={bulkDeleting}>
                {#if bulkDeleting}<Loader2 size={12} class="spinner" /> Retrying…{:else}<RotateCw size={12} /> Retry failed{/if}
              </button>
            {/if}
            <button type="button" class="bulk-delete-btn bulk-delete-btn-primary" onclick={closeBulkDeleteConfirm} disabled={bulkDeleting}>Done</button>
          </div>
        {:else}
          <h3 id="bulk-delete-title"><Trash2 size={16} /> Bulk delete — Season {activeSeason}?</h3>
          <p class="bulk-delete-desc">
            {#if bulkDeleteSelected.size === 1}
              This will remove <strong>the 1 linked episode association</strong>
              <strong>{selectedEpisodeLabels()[0]}</strong>
              from season {activeSeason} of {parent.title}.
            {:else}
              This will remove <strong>{bulkDeleteSelected.size} linked episode associations</strong>
              from season {activeSeason} of {parent.title}:
            {/if}
          </p>
          {#if bulkDeleteSelected.size !== 1}
            <ul class="bulk-delete-episode-list" data-count={bulkDeleteSelected.size}>
              {#each selectedEpisodeLabels() as label (label)}
                <li>{label}</li>
              {/each}
            </ul>
          {/if}
          <p class="bulk-delete-note">
            <strong>Files are NOT deleted from Vidara or Abyss.</strong> Only Mavero's media associations are
            removed; the parent series, episode metadata, other seasons, and the provider-hosted files stay intact.
            {#if linkedCountThisSeason > bulkDeleteSelected.size}Unselected linked episodes stay linked.{/if}
          </p>
          {#if bulkDeleteError}
            <p class="bulk-delete-error" role="alert"><AlertCircle size={13} /> {bulkDeleteError}</p>
          {/if}
          <div class="bulk-delete-actions">
            <button type="button" class="bulk-delete-btn" onclick={closeBulkDeleteConfirm} disabled={bulkDeleting}>Cancel</button>
            <button type="button" class="bulk-delete-btn bulk-delete-btn-danger" onclick={submitBulkDelete} disabled={bulkDeleting}>
              {#if bulkDeleting}<Loader2 size={12} class="spinner" /> Deleting…{:else}<Trash2 size={12} /> Delete {bulkDeleteSelected.size} association{bulkDeleteSelected.size === 1 ? '' : 's'}{/if}
            </button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
{/if}

<style>
  /* Overlay + sheet — the sheet is a FLEX COLUMN (Phase-1 contract):
     head/toolbar/season rail size to content (flex: 0 0 auto), the body
     takes the remaining space with min-height:0 + overflow-y:auto. */
  .episode-sheet-overlay { position: fixed; inset: 0; z-index: 92; background: rgba(0,0,0,0.62); backdrop-filter: blur(4px); display: flex; align-items: flex-end; justify-content: stretch; }
  .episode-sheet {
    display: flex; flex-direction: column;
    width: 100%; max-width: 560px; max-height: calc(100dvh - 24px);
    margin: 0 auto;
    background: var(--a2-surface-2, #141414); border: 1px solid var(--a2-border-strong, #333); border-radius: 14px 14px 0 0;
    box-shadow: 0 -20px 60px rgba(0,0,0,0.55); overflow: hidden;
  }
  @media (min-width: 720px) {
    .episode-sheet-overlay { align-items: stretch; justify-content: flex-end; }
    .episode-sheet { border-radius: 14px 0 0 14px; margin: 0; max-height: none; height: 100dvh; }
  }

  /* Header */
  .sheet-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px 10px; border-bottom: 1px solid var(--a2-border, #222); flex: 0 0 auto; }
  .head-poster { display: grid; place-items: center; width: 44px; height: 64px; border-radius: 8px; background: var(--a2-surface-4, #222); color: var(--a2-text-dim, #777); overflow: hidden; flex-shrink: 0; }
  .head-poster img { width: 100%; height: 100%; object-fit: cover; }
  .head-info { flex: 1; min-width: 0; }
  .head-eyebrow { margin: 0 0 2px; font-size: var(--a2-text-2xs, 0.62rem); font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--a2-text-muted, #888); }
  .head-title { margin: 0; font-size: 0.95rem; font-weight: 700; color: var(--a2-text-bright, #f0f0f0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .head-progress { margin: 3px 0 0; font-size: var(--a2-text-xs, 0.7rem); color: var(--a2-text-muted, #888); display: flex; align-items: center; gap: 6px; }
  .head-progress-error { color: var(--a2-red, #e5484d); }
  .close-button { display: grid; place-items: center; min-width: 44px; min-height: 44px; border: 0; border-radius: 8px; background: transparent; color: var(--a2-text-muted, #888); cursor: pointer; flex-shrink: 0; }
  .close-button:hover { background: var(--a2-surface-3, #1e1e1e); color: var(--a2-text, #ddd); }
  .close-button:focus-visible { outline: 2px solid var(--a2-cyan, #0ff); outline-offset: 2px; }

  /* Season rail — the EXACT Phase-1 sizing contract. */
  .season-row {
    display: flex; align-items: center; gap: 8px; overflow-x: auto; padding: 10px 16px 8px;
    flex: 0 0 auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain;
  }
  .season-row::-webkit-scrollbar { display: none; }
  .season-chip {
    flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
    height: 36px; box-sizing: border-box; padding: 0 14px;
    border: 1px solid var(--a2-border-strong, #333); border-radius: 999px;
    background: transparent; color: var(--a2-text, #ddd);
    font-size: 12px; font-weight: 600; line-height: 1; cursor: pointer; white-space: nowrap;
  }
  .season-chip:hover { border-color: var(--a2-cyan, #0ff); }
  .season-chip.active { background: var(--a2-cyan, #0ff); border-color: var(--a2-cyan, #0ff); color: #001418; }
  .season-chip:focus-visible { outline: 2px solid var(--a2-cyan, #0ff); outline-offset: 2px; }

  /* Season toolbar */
  .season-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 16px 8px; flex: 0 0 auto; flex-wrap: wrap; }
  .season-progress { font-size: var(--a2-text-xs, 0.7rem); color: var(--a2-text-muted, #888); font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
  /* Task 4 — the two bulk actions grouped; wrap to a second row on
     narrow viewports so both stay usable at mobile width. */
  .bulk-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .bulk-btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border: 1px solid rgba(0,200,200,0.35); border-radius: 8px; background: rgba(0,200,200,0.08); color: var(--a2-cyan, #0ff); font-size: var(--a2-text-xs, 0.7rem); font-weight: 700; cursor: pointer; }
  .bulk-btn:hover { background: rgba(0,200,200,0.16); }
  .bulk-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .bulk-btn:focus-visible { outline: 2px solid var(--a2-cyan, #0ff); outline-offset: 2px; }
  .bulk-btn-danger { border-color: rgba(229,72,77,0.4); background: rgba(229,72,77,0.08); color: var(--a2-red, #e5484d); }
  .bulk-btn-danger:hover { background: rgba(229,72,77,0.16); }

  /* Body */
  .sheet-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 0 max(14px, env(safe-area-inset-bottom)); }

  .season-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 32px 16px; color: var(--a2-text-muted, #888); font-size: var(--a2-text-sm, 0.8rem); }
  .season-state p { margin: 0; }
  .season-state-error { color: var(--a2-red, #e5484d); flex-direction: row; flex-wrap: wrap; justify-content: center; }
  .retry-btn { padding: 5px 12px; border: 1px solid var(--a2-border-strong, #333); border-radius: 8px; background: var(--a2-surface-3, #1e1e1e); color: var(--a2-text, #ddd); font-size: var(--a2-text-xs, 0.7rem); font-weight: 600; cursor: pointer; }
  .retry-btn:hover { border-color: var(--a2-cyan, #0ff); color: var(--a2-cyan, #0ff); }

  /* Episode rows */
  .episode-list { display: flex; flex-direction: column; gap: 2px; padding: 0 10px 10px; }
  .episode-row { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px; }
  .episode-row:hover { background: var(--a2-surface-3, #1a1a1a); }
  .episode-row[data-released="false"] { opacity: 0.55; }
  .ep-number { font-family: var(--a2-font-mono, monospace); font-size: var(--a2-text-xs, 0.7rem); font-weight: 700; color: var(--a2-text-dim, #777); min-width: 38px; flex-shrink: 0; }
  .episode-row[data-linked="true"] .ep-number { color: var(--a2-cyan, #0ff); }
  .ep-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .ep-title { font-size: var(--a2-text-sm, 0.8rem); font-weight: 600; color: var(--a2-text-bright, #eee); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ep-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .ep-air { font-size: var(--a2-text-2xs, 0.62rem); color: var(--a2-text-dim, #777); font-family: var(--a2-font-mono, monospace); }
  .badge-provider { padding: 1px 6px; border-radius: 5px; font-size: var(--a2-text-2xs, 0.62rem); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
  .badge-provider[data-provider="vidara"] { background: rgba(99,102,241,0.15); color: #818cf8; }
  .badge-provider[data-provider="abyss"] { background: rgba(245,158,11,0.15); color: #fbbf24; }
  .badge-status { padding: 1px 6px; border-radius: 5px; font-size: var(--a2-text-2xs, 0.62rem); font-weight: 700; text-transform: uppercase; background: rgba(0,200,200,0.12); color: var(--a2-cyan, #0ff); }
  .badge-status[data-state="missing"] { background: rgba(229,72,77,0.12); color: #e5484d; }
  .badge-unlinked { padding: 1px 6px; border-radius: 5px; font-size: var(--a2-text-2xs, 0.62rem); font-weight: 700; text-transform: uppercase; background: var(--a2-surface-4, #262626); color: var(--a2-text-muted, #888); }
  .badge-unreleased { padding: 1px 6px; border-radius: 5px; font-size: var(--a2-text-2xs, 0.62rem); font-weight: 700; text-transform: uppercase; background: rgba(245,158,11,0.1); color: #b98a2f; }

  .ep-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .ep-btn { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 8px; border: 1px solid var(--a2-border, #262626); border-radius: 7px; background: transparent; color: var(--a2-text-muted, #888); font-size: var(--a2-text-2xs, 0.65rem); font-weight: 700; cursor: pointer; }
  .ep-btn:hover { border-color: var(--a2-cyan, #0ff); color: var(--a2-cyan, #0ff); }
  .ep-btn:focus-visible { outline: 2px solid var(--a2-cyan, #0ff); outline-offset: 1px; }
  .ep-btn-add { border-color: rgba(0,200,200,0.35); color: var(--a2-cyan, #0ff); background: rgba(0,200,200,0.08); }
  .ep-btn-danger:hover { border-color: var(--a2-red, #e5484d); color: var(--a2-red, #e5484d); }

  /* Bulk form */
  .bulk-form { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; }
  .bulk-head { display: flex; align-items: flex-start; gap: 8px; }
  .back-btn { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--a2-border, #262626); border-radius: 8px; background: transparent; color: var(--a2-text-muted, #888); cursor: pointer; flex-shrink: 0; }
  .back-btn:hover { color: var(--a2-text, #ddd); border-color: var(--a2-border-strong, #333); }
  .bulk-title h3 { margin: 0; font-size: 0.85rem; font-weight: 700; color: var(--a2-text-bright, #f0f0f0); }
  .bulk-title p { margin: 2px 0 0; font-size: var(--a2-text-xs, 0.7rem); color: var(--a2-text-muted, #888); line-height: 1.45; }
  .bulk-provider-row { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--a2-text-muted, #888); }
  .ref-input { height: 36px; padding: 0 12px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 8px; color: var(--a2-text, #ddd); font-size: 0.8rem; outline: 0; }
  .ref-input:focus { border-color: var(--a2-cyan, #0ff); }

  .bulk-rows { display: flex; flex-direction: column; gap: 4px; }
  .bulk-row { display: flex; align-items: center; gap: 8px; }
  .bulk-ep { font-family: var(--a2-font-mono, monospace); font-size: var(--a2-text-xs, 0.7rem); font-weight: 700; color: var(--a2-text-dim, #777); min-width: 34px; flex-shrink: 0; }
  .bulk-ep-title { flex: 0 1 30%; font-size: var(--a2-text-xs, 0.7rem); color: var(--a2-text-muted, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bulk-ref-input { flex: 1; min-width: 0; height: 32px; padding: 0 10px; background: var(--a2-surface-3, #1a1a1a); border: 1px solid var(--a2-border, #222); border-radius: 7px; color: var(--a2-text, #ddd); font-size: 0.72rem; font-family: var(--a2-font-mono, monospace); outline: 0; }
  .bulk-ref-input:focus { border-color: var(--a2-cyan, #0ff); }
  .bulk-ref-input::placeholder { color: var(--a2-text-dim, #666); }

  .bulk-error { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 8px; background: rgba(229,72,77,0.1); border: 1px solid rgba(229,72,77,0.3); color: #e5484d; font-size: var(--a2-text-xs, 0.7rem); line-height: 1.45; }
  .bulk-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 4px; }
  .bulk-count { font-size: var(--a2-text-xs, 0.7rem); color: var(--a2-text-muted, #888); }
  .btn-apply { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border: 1px solid rgba(0,200,200,0.3); border-radius: 8px; background: rgba(0,200,200,0.12); color: var(--a2-cyan, #0ff); font-size: 0.75rem; font-weight: 700; cursor: pointer; }
  .btn-apply:hover { background: rgba(0,200,200,0.2); }
  .btn-apply:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-apply-danger { border-color: rgba(220,60,60,0.35); background: rgba(220,60,60,0.12); color: #c44; }
  .btn-apply-danger:hover:not(:disabled) { background: rgba(220,60,60,0.2); }

  /* 2026-10-16 selection round — the bulk-delete selection view. */
  .bulk-delete-tools { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0; }
  .select-all-btn { padding: 5px 10px; border: 1px solid var(--a2-border, #262626); border-radius: 8px; background: transparent; color: var(--a2-text-muted, #888); font-size: var(--a2-text-xs, 0.7rem); font-weight: 700; cursor: pointer; }
  .select-all-btn:hover { color: var(--a2-text, #ddd); border-color: var(--a2-border-strong, #333); }
  .select-all-btn[aria-pressed="true"] { color: var(--a2-cyan, #0ff); border-color: rgba(0,200,200,0.4); }
  .bulk-delete-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 8px; cursor: pointer; }
  .bulk-delete-row:hover { background: var(--a2-surface-3, #1a1a1a); }
  .bulk-delete-row[data-checked="true"] { background: rgba(220,60,60,0.06); }
  .bulk-delete-check { width: 15px; height: 15px; flex-shrink: 0; accent-color: #e5484d; cursor: pointer; }
  .bulk-delete-episode-list { margin: 0; padding: 10px 12px; list-style: none; border-radius: 8px; background: var(--a2-surface-4, #262626); max-height: 22dvh; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
  .bulk-delete-episode-list li { font-size: var(--a2-text-xs, 0.7rem); color: var(--a2-text, #ddd); font-family: var(--a2-font-mono, monospace); }

  .bulk-outcomes { display: flex; flex-direction: column; gap: 4px; }
  .outcome-summary { margin: 0 0 4px; font-size: var(--a2-text-sm, 0.8rem); font-weight: 700; color: var(--a2-text-bright, #eee); }
  .outcome-row { display: flex; align-items: center; gap: 7px; font-size: var(--a2-text-xs, 0.7rem); line-height: 1.4; }
  .outcome-row.outcome-ok { color: #46c88a; }
  .outcome-row.outcome-fail { color: #e5484d; }
  .bulk-outcomes .retry-btn { align-self: flex-start; margin-top: 6px; }

  .spinner { animation: spin 1s linear infinite; }
  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

  /* Task 4 — bulk-delete confirmation: ABOVE the sheet (93), BELOW the
     wizard (94). Fixed overlay + centered dialog, same visual language
     as the delete confirmation in AdminMediaList. */
  .bulk-delete-overlay { position: fixed; inset: 0; z-index: 93; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; }
  .bulk-delete-dialog { width: min(420px, calc(100vw - 32px)); max-height: calc(100dvh - 64px); overflow-y: auto; background: var(--a2-surface-2, #1a1a1a); border: 1px solid var(--a2-border-strong, #333); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); padding: 20px; display: flex; flex-direction: column; gap: 10px; }
  .bulk-delete-dialog:focus-visible { outline: 2px solid var(--a2-cyan, #0ff); }
  .bulk-delete-dialog h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 0.9rem; color: var(--a2-text-bright, #f0f0f0); }
  .bulk-delete-desc { margin: 0; font-size: 0.8rem; color: var(--a2-text, #ddd); line-height: 1.5; }
  .bulk-delete-note { margin: 0; padding: 10px 12px; border-radius: 8px; background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.25); font-size: 0.7rem; color: #d3a95c; line-height: 1.5; }
  .bulk-delete-error { margin: 0; display: flex; align-items: flex-start; gap: 6px; font-size: 0.72rem; color: var(--a2-red, #e5484d); }
  .bulk-delete-outcomes { display: flex; flex-direction: column; gap: 4px; max-height: 40dvh; overflow-y: auto; }
  .bulk-delete-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
  .bulk-delete-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid transparent; border-radius: 8px; font-size: 0.78rem; font-weight: 700; cursor: pointer; background: var(--a2-surface-3, #1a1a1a); border-color: var(--a2-border, #222); color: var(--a2-text-muted, #888); }
  .bulk-delete-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .bulk-delete-btn-danger { background: rgba(220,60,60,0.12); border-color: rgba(220,60,60,0.3); color: #c44; }
  .bulk-delete-btn-danger:hover:not(:disabled) { background: rgba(220,60,60,0.2); }
  .bulk-delete-btn-primary { background: rgba(0,200,200,0.12); border-color: rgba(0,200,200,0.3); color: var(--a2-cyan, #0ff); }
  .bulk-delete-btn:focus-visible { outline: 2px solid var(--a2-cyan, #0ff); outline-offset: 1px; }

  @media (max-width: 640px) {
    .episode-sheet { max-height: calc(100dvh - 12px); }
    .bulk-ep-title { display: none; }
    .ep-btn span { display: none; }
    .ep-btn { padding: 0 9px; }
  }
</style>
