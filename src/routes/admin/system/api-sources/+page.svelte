<script lang="ts">
  /**
   * Admin 2.0 — Phase 1 — API & Sources workspace.
   *
   * Canonical workspace with full CRUD for providers, sources, and defaults.
   * No redirects to legacy UI — all management happens here.
   *
   * The provider/source forms use the same server actions as the legacy
   * /admin/providers and /admin/sources pages (now moved to this route's
   * +page.server.ts). The forms are rendered inside AdminAppShell + AdminPage.
   */

  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { enhance } from '$app/forms';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatus from '$lib/components/admin2/AdminStatus.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import AdminFormSection from '$lib/components/admin/AdminFormSection.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddButton from '$lib/components/admin/AdminAddButton.svelte';
  import { SlidersHorizontal, X, Check, Server, HardDrive, Edit3, Trash2, Power, Layers, AlertCircle, Plus } from 'lucide-svelte';
  import SourceIcon from '$lib/components/source/SourceIcon.svelte';
  import { CAPABILITY_FIELDS, CAPABILITY_LABELS } from '$lib/shared/player-capabilities';
  import { sandboxPolicyFromCapabilities, sandboxPolicies } from '$lib/shared/sandbox-policy';
  import { integrationTypes, providerStatuses } from '$lib/shared/streaming';
  // Task 13 / MAVP-4 Issue 4: source presentation metadata contracts — safe
  // icon keys, rich icon values (PNG/SVG data URLs, https image URLs) and
  // extensible badge configs (built-ins + per-source definitions).
  import { sourceIconKeys, sourceIconLabels, DEFAULT_SOURCE_ICON, BUILTIN_SOURCE_BADGES, sourceBadgeVariants, parseSourceBadges, serializeSourceBadges, classifySourceIconValue, type SourceBadgeConfig, type SourceBadgeVariant } from '$lib/shared/source-presentation';
  // MAVP-3 Issue 5: documented size bounds + defaults for the per-control
  // Back/Landscape size settings (shared contract with the server gate and
  // the player renderer).
  // MAVP-4 Issue 3: the preview resolves through the SAME shared contract as
  // the runtime player — the serialized payload is parsed by the real total
  // parser and mapped by the shared preview geometry helper, so the preview
  // can never diverge from the runtime interpretation.
  // 2026-10-16 round (Issue 5): the unified bulk-reposition validation
  // contract shared by every Admin ordering list (live duplicate/blank/
  // zero/negative/decimal rejection with the server as the authority).
  import { validateRepositionSet, repositionDraftFromEntries, repositionDraftIsDirty } from '$lib/shared/bulk-reposition';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const VALID_TABS = new Set(['providers', 'sources', 'categories']);
  // svelte-ignore state_referenced_locally
  let currentTab = $state<string>(VALID_TABS.has(data.initialTab) ? data.initialTab : 'providers');

  $effect(() => {
    const urlTab = page.url.searchParams.get('tab') ?? 'providers';
    if (VALID_TABS.has(urlTab) && urlTab !== currentTab) {
      currentTab = urlTab;
    }
  });

  function switchTab(tab: string) {
    if (!VALID_TABS.has(tab) || tab === currentTab) return;
    currentTab = tab;
    const params = new URLSearchParams(page.url.searchParams);
    params.set('tab', tab);
    goto(`${page.url.pathname}?${params.toString()}`, { replaceState: true, noScroll: true, invalidateAll: false });
  }

  // --- Defaults sheet ---
  let defaultsOpen = $state(false);

  // --- Provider edit/create sheet ---
  let providerSheetOpen = $state(false);
  let editingProvider: any = $state(null);
  let providerSheetTrigger: HTMLElement | null = null;

  // Issue 4 (2026-10-16 round): PROVIDER ICON editor — URL field PRESERVED,
  // file UPLOAD added through the SAME server pipeline as source icons
  // (`icon_file` multipart; PNG magic-byte check / SVG sanitization server-
  // side), explicit remove checkbox, live preview, and the SAME precedence
  // rule the source editor uses (an uploaded file wins over the URL; the
  // selected result is visible before save). "No file selected" never
  // erases a saved icon — the server's update contract treats an empty icon
  // field as NO CHANGE; removal is the explicit checkbox.
  let providerIconUrlDraft = $state('');
  let providerIconFileDataUrl = $state('');
  let providerIconFileName = $state('');
  let providerIconRemove = $state(false);
  let providerIconPreviewFailed = $state(false);

  function resetProviderIconDrafts() {
    providerIconPreviewFailed = false;
    providerIconFileDataUrl = '';
    providerIconFileName = '';
    providerIconRemove = false;
    const stored = typeof editingProvider?.icon === 'string' ? editingProvider.icon.trim() : '';
    providerIconUrlDraft = /^https?:\/\//.test(stored) ? stored : '';
  }

  function handleProviderIconFileChange(event: Event) {
    const input = event.currentTarget instanceof HTMLInputElement ? event.currentTarget : null;
    const file = input?.files?.[0];
    providerIconPreviewFailed = false;
    if (!file) {
      providerIconFileName = '';
      providerIconFileDataUrl = '';
      return;
    }
    providerIconFileName = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      providerIconFileDataUrl = typeof reader.result === 'string' ? reader.result : '';
    };
    reader.readAsDataURL(file);
  }

  /** The preview the admin sees BEFORE save — upload > URL draft > stored value. */
  const providerIconPreviewUrl = $derived.by(() => {
    if (providerIconRemove) return '';
    if (providerIconFileDataUrl) return providerIconFileDataUrl;
    const url = providerIconUrlDraft.trim();
    if (url) return url;
    const stored = typeof editingProvider?.icon === 'string' ? editingProvider.icon.trim() : '';
    return /^(https?:\/\/|data:image\/)/.test(stored) ? stored : '';
  });

  /** Hidden `icon` field value: '' in upload mode / explicit removal, else the URL draft. */
  const providerIconSubmitValue = $derived(providerIconFileDataUrl ? '' : providerIconUrlDraft.trim());

  function openCreateProvider(event?: Event) {
    if (event) providerSheetTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    editingProvider = null;
    resetProviderIconDrafts();
    providerSheetOpen = true;
  }
  function openEditProvider(provider: any, event?: Event) {
    if (event) providerSheetTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    editingProvider = provider;
    resetProviderIconDrafts();
    providerSheetOpen = true;
  }
  function closeProviderSheet() {
    providerSheetOpen = false;
    editingProvider = null;
  }

  // --- Source edit/create sheet ---
  let sourceSheetOpen = $state(false);
  let editingSource: any = $state(null);
  let sourceSheetTrigger: HTMLElement | null = null;

  // --- MAVP-4 Issue 4: source ICON editor (restored pickers + rich inputs) ---
  // The Admin 2.0 migration had degraded the Task 13 pickers to plain text
  // inputs. The icon editor now offers the four supported input methods:
  //   * key    — the Task 13 safe-key grid with live SourceIcon previews;
  //   * upload — a PNG/SVG FILE (multipart `icon_file`; server validates the
  //     PNG magic bytes / sanitizes the SVG before storing the data URL);
  //   * svg    — pasted SVG markup (server-side sanitized before storing);
  //   * url    — an https image URL (server validates via the icon-url
  //     contract).
  // The submitted `icon` field always carries the RAW chosen value; the
  // server parses/sanitizes/normalizes it into the stored contract. The
  // client-side preview renders through <img> (script-inert for SVG) or the
  // SourceIcon component — untrusted markup never reaches {@html}.
  type IconMode = 'key' | 'upload' | 'svg' | 'url';
  let iconMode = $state<IconMode>('key');
  let iconKeyDraft = $state<string>(DEFAULT_SOURCE_ICON);
  let iconSvgDraft = $state('');
  let iconUrlDraft = $state('');
  let iconFileName = $state('');
  // Client-side preview source (upload: the picked file as a data URL; svg:
  // a data URL of the CURRENT draft — both script-inert <img> surfaces).
  let iconPreviewDataUrl = $state('');
  let iconPreviewFailed = $state(false);

  const iconSubmitValue = $derived.by(() => {
    if (iconMode === 'key') return iconKeyDraft.trim();
    if (iconMode === 'upload') return ''; // the file posts via `icon_file`
    if (iconMode === 'svg') return iconSvgDraft.trim();
    return iconUrlDraft.trim();
  });

  /** Script-inert SVG preview URL for the paste editor (never {@html}). */
  const iconSvgPreviewUrl = $derived(iconSvgDraft.trim() ? `data:image/svg+xml;utf8,${encodeURIComponent(iconSvgDraft)}` : '');

  function handleIconFileChange(event: Event) {
    const input = event.currentTarget instanceof HTMLInputElement ? event.currentTarget : null;
    const file = input?.files?.[0];
    iconPreviewFailed = false;
    if (!file) {
      iconFileName = '';
      iconPreviewDataUrl = '';
      return;
    }
    iconFileName = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      iconPreviewDataUrl = typeof reader.result === 'string' ? reader.result : '';
    };
    reader.readAsDataURL(file);
  }

  /** Client-side decode of a stored sanitized-SVG data URL (re-edit prefill). */
  function decodeSvgDataUrl(value: string): string {
    const match = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.trim());
    if (!match) return '';
    try {
      const markup = atob(match[1]);
      return markup.startsWith('<svg') ? markup : '';
    } catch {
      return '';
    }
  }

  // --- MAVP-4 Issue 4: EXTENSIBLE BADGE editor ---
  // Badge definitions are per-source copies ({id,label,variant}); the picker
  // offers the built-ins (Ad-Free / Ads / 4K) plus every definition already
  // used by ANY configured source (harvested for reuse) plus the current
  // drafts. Creating/renaming/deleting on one source never touches another.
  let badgeDrafts = $state<SourceBadgeConfig[]>([]);
  let newBadgeLabel = $state('');
  let newBadgeVariant = $state<SourceBadgeVariant>('accent');
  let badgeEditorHint = $state('');

  const badgeSubmitValue = $derived(badgeDrafts.length ? serializeSourceBadges(badgeDrafts) : '');

  const knownBadgeDefinitions = $derived.by(() => {
    const byId = new Map<string, SourceBadgeConfig>();
    for (const badge of BUILTIN_SOURCE_BADGES) byId.set(badge.id, badge);
    for (const source of data.sources as any[]) {
      for (const badge of parseSourceBadges(source?.badge)) {
        if (!byId.has(badge.id)) byId.set(badge.id, badge);
      }
    }
    for (const badge of badgeDrafts) byId.set(badge.id, badge);
    return [...byId.values()];
  });

  function toggleBadgeDefinition(definition: SourceBadgeConfig) {
    badgeEditorHint = '';
    if (badgeDrafts.some((badge) => badge.id === definition.id)) {
      badgeDrafts = badgeDrafts.filter((badge) => badge.id !== definition.id);
      return;
    }
    if (badgeDrafts.length >= 3) {
      badgeEditorHint = 'A source can carry at most 3 badges.';
      return;
    }
    badgeDrafts = [...badgeDrafts, definition];
  }

  function removeBadgeDraft(id: string) {
    badgeDrafts = badgeDrafts.filter((badge) => badge.id !== id);
    badgeEditorHint = '';
  }

  function createBadgeDefinition() {
    const label = newBadgeLabel.trim();
    if (!label) return;
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (!id) {
      badgeEditorHint = 'Use letters or numbers in the badge label.';
      return;
    }
    if (badgeDrafts.some((badge) => badge.id === id)) {
      badgeEditorHint = 'That badge is already assigned to this source.';
      return;
    }
    if (badgeDrafts.length >= 3) {
      badgeEditorHint = 'A source can carry at most 3 badges.';
      return;
    }
    const existing = knownBadgeDefinitions.find((badge) => badge.id === id);
    badgeDrafts = [...badgeDrafts, existing ?? { id, label, variant: newBadgeVariant }];
    newBadgeLabel = '';
    badgeEditorHint = '';
  }

  /** Prefill the icon + badge drafts from a stored source row (TOTAL reads). */
  function loadIconBadgeState(source: any) {
    const storedIcon = typeof source?.icon === 'string' ? source.icon : '';
    const kind = classifySourceIconValue(storedIcon);
    iconPreviewFailed = false;
    iconFileName = '';
    iconSvgDraft = '';
    iconUrlDraft = '';
    iconPreviewDataUrl = '';
    iconRemoveChecked = false;
    if (kind === 'svg-data') {
      iconMode = 'svg';
      iconSvgDraft = decodeSvgDataUrl(storedIcon);
      iconPreviewDataUrl = iconSvgDraft ? `data:image/svg+xml;utf8,${encodeURIComponent(iconSvgDraft)}` : '';
    } else if (kind === 'png-data') {
      iconMode = 'upload';
      iconFileName = 'uploaded PNG';
      iconPreviewDataUrl = storedIcon;
    } else if (kind === 'remote-url') {
      iconMode = 'url';
      iconUrlDraft = storedIcon;
    } else {
      iconMode = 'key';
      iconKeyDraft = isKeyDraft(storedIcon) ? storedIcon : DEFAULT_SOURCE_ICON;
    }
    badgeDrafts = parseSourceBadges(source?.badge ?? null);
    newBadgeLabel = '';
    newBadgeVariant = 'accent';
    badgeEditorHint = '';
  }

  function isKeyDraft(value: string): boolean {
    return Boolean(value) && (sourceIconKeys as readonly string[]).includes(value);
  }

  // --- Player Controls Position (3x3 grid) ---
  // The Admin picks a 3x3 cell for the Back button and for the Fullscreen
  // (landscape) FAB. Stored inside capabilities.player_controls_position as
  // { mode:'custom', grid:{ back, landscape } }. Legacy percentage configs are
  // still parsed + rendered by the runtime (backward-compatible); saving here
  // writes the grid form.
  type ControlsGridCell =
    | 'top-left' | 'top-center' | 'top-right'
    | 'mid-left' | 'mid-center' | 'mid-right'
    | 'bottom-left' | 'bottom-center' | 'bottom-right';
  const GRID_CELLS: ControlsGridCell[] = [
    'top-left', 'top-center', 'top-right',
    'mid-left', 'mid-center', 'mid-right',
    'bottom-left', 'bottom-center', 'bottom-right',
  ];
  const GRID_CELL_LABELS: Record<string, string> = {
    'top-left': 'Top-left', 'top-center': 'Top-center', 'top-right': 'Top-right',
    'mid-left': 'Mid-left', 'mid-center': 'Center', 'mid-right': 'Mid-right',
    'bottom-left': 'Bottom-left', 'bottom-center': 'Bottom-center', 'bottom-right': 'Bottom-right',
  };
  const isGridCell = (value: unknown): value is ControlsGridCell =>
    typeof value === 'string' && (GRID_CELLS as string[]).includes(value);

  let controlsPositionMode = $state('default');
  let gridBack = $state<ControlsGridCell | ''>('');
  let gridLandscape = $state<ControlsGridCell | ''>('');

  function loadControlsPositionState(source: any) {
    const raw = source?.capabilities?.player_controls_position;
    const custom = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.mode === 'custom' ? raw : null;
    const grid = custom && typeof custom.grid === 'object' && custom.grid !== null && !Array.isArray(custom.grid) ? custom.grid : null;
    gridBack = isGridCell(grid?.back) ? grid.back : '';
    gridLandscape = isGridCell(grid?.landscape) ? grid.landscape : '';
    controlsPositionMode = custom ? 'custom' : 'default';
  }

  function resetAllControlsPosition() {
    gridBack = '';
    gridLandscape = '';
    controlsPositionMode = 'default';
  }

  function setGridCell(control: 'back' | 'landscape', cell: ControlsGridCell) {
    if (control === 'back') gridBack = gridBack === cell ? '' : cell;
    else gridLandscape = gridLandscape === cell ? '' : cell;
  }

  const gridPickers = $derived([
    { id: 'back' as const, title: 'Back button', value: gridBack },
    { id: 'landscape' as const, title: 'Fullscreen button', value: gridLandscape },
  ]);

  const controlsPositionJson = $derived.by(() => {
    if (controlsPositionMode !== 'custom') return JSON.stringify({ mode: 'default' });
    const grid: Record<string, string> = {};
    if (isGridCell(gridBack)) grid.back = gridBack;
    if (isGridCell(gridLandscape)) grid.landscape = gridLandscape;
    if (!grid.back && !grid.landscape) return JSON.stringify({ mode: 'default' });
    return JSON.stringify({ mode: 'custom', grid });
  });

  function openCreateSource(event?: Event) {
    if (event) sourceSheetTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    editingSource = null;
    loadControlsPositionState(null);
    loadIconBadgeState(null);
    sourceSheetOpen = true;
  }
  function openEditSource(source: any, event?: Event) {
    if (event) sourceSheetTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    editingSource = source;
    loadControlsPositionState(source);
    loadIconBadgeState(source);
    sourceSheetOpen = true;
  }
  function closeSourceSheet() {
    sourceSheetOpen = false;
    editingSource = null;
  }

  // Issue 3 (2026-10-16 round): explicit icon-removal control for the source
  // sheet. The server's update contract now treats an EMPTY icon field as
  // NO CHANGE (the root-cause fix for "editing an unrelated field erases the
  // saved icon"), so removal must be a deliberate, visible action: this
  // checkbox submits icon_remove=true → the server stores null. Offered
  // ONLY when an icon is actually saved.
  let iconRemoveChecked = $state(false);
  const storedSourceIconExists = $derived(Boolean(typeof editingSource?.icon === 'string' && editingSource.icon.trim()));

  // Issue 5 (2026-10-16 round): UNIFIED BULK REPOSITION for the GLOBAL source
  // ordering — the authoritative workflow (the per-sheet Ordering field is
  // REMOVED below). One “Reposition” action over the Sources list; prefilled
  // saved values; live shared validation (blank/zero/negative/decimal/
  // duplicate values disable Apply immediately); ONE request; enhanced
  // submission (no full-page reload; failed saves keep the edits visible).
  // Global ordering contract: gaps permitted, values may start at 0.
  let sourcesListRepositioning = $state(false);
  let sourcesListDrafts = $state<Record<string, string>>({});
  let sourcesListSaving = $state(false);

  const sourcesListEntries = $derived(
    (data.sources as any[])
      .slice()
      .sort((a, b) => (a.ordering ?? 0) - (b.ordering ?? 0))
      .map((source) => ({ id: source.id, savedPosition: source.ordering ?? 0 })),
  );
  const sourcesListValidation = $derived(
    sourcesListRepositioning
      ? validateRepositionSet(sourcesListEntries, sourcesListDrafts, { minPosition: 0 })
      : null,
  );
  const sourcesListDirty = $derived(sourcesListRepositioning && repositionDraftIsDirty(sourcesListEntries, sourcesListDrafts));

  function startSourcesListReposition() {
    sourcesListDrafts = repositionDraftFromEntries(sourcesListEntries);
    sourcesListRepositioning = true;
  }
  function cancelSourcesListReposition() {
    sourcesListRepositioning = false;
    sourcesListDrafts = {};
  }

  // --- Helpers ---
  function statusTone(status: string | null | undefined): 'good' | 'warn' | 'bad' | 'neutral' {
    if (status === 'active' || status === 'experimental') return 'good';
    if (status === 'maintenance') return 'warn';
    return 'neutral';
  }
  function sandboxOn(provider: any): boolean {
    return sandboxPolicyFromCapabilities(provider.capabilities) === 'required';
  }
  function providerForSource(source: any): any | null {
    return data.providers.find((p: any) => p.id === source.provider_id) ?? null;
  }
  function defaultForType(type: string): any | null {
    return data.defaults.find((d: any) => d.content_type === type) ?? null;
  }
  // MAVP-5 (Issue 6): ordered default slots for one content type — the
  // saved slot rows in position order (1..3). Falls back to the legacy
  // single default as a one-entry order so pre-migration configurations
  // render identically before any slot row exists.
  function slotsForType(type: string): string[] {
    const rows = ((data.defaultSlots ?? []) as any[]).filter((row) => row.content_type === type).sort((a, b) => a.position - b.position);
    const ids = rows.map((row) => row.source_id as string).filter(Boolean);
    if (ids.length) return ids;
    const legacy = defaultForType(type);
    return legacy?.source_id ? [legacy.source_id as string] : [];
  }
  function sourceName(sourceId: string | null): string {
    if (!sourceId) return '—';
    const source = data.sources.find((s: any) => s.id === sourceId);
    return source?.name ?? '—';
  }
  function isSourceEligible(source: any): boolean {
    return source.enabled && source.visibility === 'public' && (source.status === 'active' || source.status === 'experimental');
  }

  const CONTENT_TYPES = [
    { type: 'movie', label: 'Movies' },
    { type: 'series', label: 'Series' },
    { type: 'anime', label: 'Anime' },
    { type: 'adult', label: 'Adult' },
  ];

  const providerStatusLabels: Record<string, string> = { active: 'Active', disabled: 'Disabled', maintenance: 'Maintenance', experimental: 'Experimental', unavailable: 'Unavailable' };
  const integrationLabels: Record<string, string> = { template: 'Template', api: 'API', direct: 'Direct', embed: 'Embed', custom: 'Custom' };
  const sandboxPolicyLabels: Record<string, string> = { required: 'Required — secure sandbox', unrestricted: 'Unrestricted — warning' };

  function capabilityState(providerId: string, field: string): 'supported' | 'unsupported' | 'unknown' {
    const entry = data.capabilityMap?.[providerId] ?? null;
    if (!entry) return 'unknown';
    if (entry.supported.includes(field)) return 'supported';
    return 'unsupported';
  }

  // ============================================================
  // Category management (migrated from /admin/system/content-rules).
  // The authoritative data is the EXISTING load payload (sources +
  // sourceCategories mapping rows) — no second data model. A mapping row
  // whose source no longer exists (stale/deleted) renders as 'Unknown
  // source' and can still be removed (the remove form carries the
  // mapping's own source_id).
  // ============================================================
  type AssignedSourceRow = { sourceId: string; name: string; status: string | null; enabled: boolean | null; position: number };

  function assignedSourcesForCategory(categoryId: string): AssignedSourceRow[] {
    const rows = (data.sourceCategories as any[])
      .filter((sc) => sc.category_id === categoryId)
      .slice()
      .sort((a, b) => (a.ordering ?? 0) - (b.ordering ?? 0));
    return rows.map((mapping, index) => {
      const source = (data.sources as any[]).find((candidate) => candidate.id === mapping.source_id) ?? null;
      return {
        sourceId: mapping.source_id,
        name: source?.name ?? 'Unknown source',
        status: source?.status ?? null,
        enabled: source?.enabled ?? null,
        position: index + 1,
      };
    });
  }

  /** A source may live in AT MOST ONE category. The assign picker offers
   *  ONLY sources with ZERO category assignments anywhere. The service
   *  layer re-validates authoritatively (rejects any already-assigned
   *  source, and the DB-level unique(source_id) constraint closes the
   *  concurrent-assign race). */
  function assignableSourcesForCategory(categoryId: string): any[] {
    void categoryId; // the rule is GLOBAL — kept for call-site symmetry
    const assignedAnywhere = new Set((data.sourceCategories as any[]).map((sc) => sc.source_id));
    return (data.sources as any[]).filter((candidate) => !assignedAnywhere.has(candidate.id));
  }

  function sourceCountForCategory(categoryId: string): number {
    return (data.sourceCategories as any[]).filter((sc) => sc.category_id === categoryId).length;
  }

  // --- Category edit/create sheet ---
  let categorySheetOpen = $state(false);
  let editingCategoryId: string | null = $state(null);
  const editingCategory = $derived(
    editingCategoryId ? ((data.categories as any[]).find((candidate) => candidate.id === editingCategoryId) ?? null) : null,
  );

  function openCreateCategory(event?: Event) { editingCategoryId = null; categorySheetOpen = true; }
  function openEditCategory(cat: any, event?: Event) { editingCategoryId = cat?.id ?? null; categorySheetOpen = true; }
  function closeCategorySheet() { categorySheetOpen = false; editingCategoryId = null; }

  // --- Bulk reposition: the category's assigned sources (sheet) ---
  let sourcesRepositioning = $state(false);
  let sourceDrafts = $state<Record<string, string>>({});
  let sourceReorderSaving = $state(false);

  const sourceRepositionEntries = $derived(
    editingCategory
      ? assignedSourcesForCategory(editingCategory.id).map((row) => ({ id: row.sourceId, savedPosition: row.position }))
      : [],
  );
  // Dense 1..N contract: positions must stay within the list length.
  const sourceRepositionValidation = $derived(
    sourcesRepositioning
      ? validateRepositionSet(sourceRepositionEntries, sourceDrafts, { maxPosition: sourceRepositionEntries.length })
      : null,
  );
  const sourceRepositionDirty = $derived(sourcesRepositioning && repositionDraftIsDirty(sourceRepositionEntries, sourceDrafts));

  function startSourcesReposition() {
    sourceDrafts = repositionDraftFromEntries(sourceRepositionEntries);
    sourcesRepositioning = true;
  }
  function cancelSourcesReposition() {
    sourcesRepositioning = false;
    sourceDrafts = {};
  }

  // --- Bulk reposition: the GLOBAL category ordering (categories tab) ---
  let categoriesRepositioning = $state(false);
  let categoryDrafts = $state<Record<string, string>>({});
  let categoryReorderSaving = $state(false);

  const categoryRepositionEntries = $derived(
    (data.categories as any[])
      .slice()
      .sort((a, b) => (a.ordering ?? 0) - (b.ordering ?? 0))
      .map((cat) => ({ id: cat.id, savedPosition: cat.ordering ?? 0 })),
  );
  // Global ordering contract: gaps permitted, values may start at 0.
  const categoryRepositionValidation = $derived(
    categoriesRepositioning
      ? validateRepositionSet(categoryRepositionEntries, categoryDrafts, { minPosition: 0 })
      : null,
  );
  const categoryRepositionDirty = $derived(categoriesRepositioning && repositionDraftIsDirty(categoryRepositionEntries, categoryDrafts));

  function startCategoriesReposition() {
    categoryDrafts = repositionDraftFromEntries(categoryRepositionEntries);
    categoriesRepositioning = true;
  }
  function cancelCategoriesReposition() {
    categoriesRepositioning = false;
    categoryDrafts = {};
  }

  const tabs = [
    { id: 'providers', label: 'Providers' },
    { id: 'sources', label: 'Sources' },
    { id: 'categories', label: 'Categories' },
  ];
</script>

<svelte:head>
  <title>API & Sources — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="api-sources">
  <AdminPage
    eyebrow="System"
    title="API & Sources"
    accent="cyan"
    tabs={tabs.map((t) => ({ id: t.id, label: t.label, active: t.id === currentTab, onclick: () => switchTab(t.id) }))}
  >
    {#snippet actions()}
      <button type="button" class="a2-defaults-btn" onclick={() => { defaultsOpen = true; }}>
        <SlidersHorizontal size={13} /> Defaults
      </button>
      {#if currentTab === 'providers'}
        <AdminAddButton label="Add provider" onclick={openCreateProvider} />
      {:else if currentTab === 'sources'}
        <AdminAddButton label="Add source" onclick={openCreateSource} />
      {:else if currentTab === 'categories'}
        <AdminAddButton label="Add category" onclick={openCreateCategory} />
      {/if}
    {/snippet}

    {#if data.notice}
      <div class="a2-notice" role="status"><Check size={14} /> {data.notice}</div>
    {/if}
    {#if form?.message}
      <div class="a2-form-error" role="alert">{form.message}</div>
    {/if}

    {#if currentTab === 'providers'}
      <!-- Providers tab with full CRUD -->
      {#if data.providers.length === 0}
        <div class="a2-empty">
          <Server size={32} />
          <h3>No providers configured</h3>
          <p>Create the first provider to begin configuring playback sources.</p>
          <AdminAddButton label="Add provider" onclick={openCreateProvider} />
        </div>
      {:else}
        <div class="a2-provider-list">
          {#each data.providers as provider (provider.id)}
            <div class="a2-provider-row" data-enabled={provider.enabled}>
              <div class="a2-provider-row-main">
                <span class="a2-provider-row-icon">
                  <!-- Issue 4 (2026-10-16 round): rich provider icons render as
                       script-inert <img> surfaces (uploaded data URLs / https
                       URLs); legacy emoji/text values keep rendering exactly
                       as before. -->
                  {#if typeof provider.icon === 'string' && /^(https?:\/\/|data:image\/)/.test(provider.icon.trim())}
                    <img src={provider.icon.trim()} alt="" width="22" height="22" loading="lazy" onerror={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                  {:else}
                    {provider.icon ?? '🔧'}
                  {/if}
                </span>
                <div class="a2-provider-row-info">
                  <div class="a2-provider-row-name">{provider.name}</div>
                  <div class="a2-provider-row-meta">
                    <span class="mono">{provider.adapter_id}</span>
                    <span>·</span>
                    <span>{integrationLabels[provider.integration_type] ?? provider.integration_type}</span>
                    <span>·</span>
                    <span>{sandboxOn(provider) ? 'Sandboxed' : 'Unrestricted'}</span>
                  </div>
                </div>
              </div>
              <div class="a2-provider-row-actions">
                <AdminStatusBadge label={providerStatusLabels[provider.status] ?? provider.status} tone={statusTone(provider.status)} />
                <form method="POST" action="?/toggleProvider" style="display:inline">
                  <input type="hidden" name="id" value={provider.id} />
                  <input type="hidden" name="enabled" value={String(!provider.enabled)} />
                  <button type="submit" class="a2-icon-btn" title={provider.enabled ? 'Disable' : 'Enable'}>
                    <Power size={14} />
                  </button>
                </form>
                <button type="button" class="a2-icon-btn" onclick={(e) => openEditProvider(provider, e)} title="Edit">
                  <Edit3 size={14} />
                </button>
                <form method="POST" action="?/deleteProvider" style="display:inline" onsubmit={(e) => { if (!confirm('Delete this provider? This cannot be undone.')) e.preventDefault(); }}>
                  <input type="hidden" name="id" value={provider.id} />
                  <button type="submit" class="a2-icon-btn a2-icon-btn-danger" title="Delete">
                    <Trash2 size={14} />
                  </button>
                </form>
              </div>
            </div>
          {/each}
        </div>
      {/if}

    {:else if currentTab === 'sources'}
      <!-- Sources tab with full CRUD -->
      {#if data.sources.length === 0}
        <div class="a2-empty">
          <HardDrive size={32} />
          <h3>No sources configured</h3>
          <p>Create the first playback source to expose content to the application.</p>
          <AdminAddButton label="Add source" onclick={openCreateSource} />
        </div>
      {:else if sourcesListRepositioning}
        <!-- 2026-10-16 round (Issue 5): the UNIFIED bulk reposition editor —
             the authoritative global ordering workflow for sources. Every
             input is prefilled with the SAVED ordering; the complete set is
             validated live by the shared helper (gaps permitted — the saved
             values are shown verbatim, never renumbered); Apply submits ONE
             request and the enhanced submission updates the list in place
             (no full-page reload). Cancel discards only the unsaved edits. -->
        <form
          method="POST"
          action="?/reorderSources"
          class="a2-reposition-form"
          use:enhance={() => {
            sourcesListSaving = true;
            return async ({ update, result }) => {
              await update({ reset: false });
              sourcesListSaving = false;
              if (result.type === 'success' || result.type === 'redirect') {
                sourcesListRepositioning = false;
                sourcesListDrafts = {};
              }
            };
          }}
        >
          <p class="a2-field-hint">Edit the numbers to reposition the global source order (used by resolver ranking and the default-source fallback). Values are validated live — Apply stays disabled until the whole set is valid. Cancel discards unsaved edits.</p>
          {#if sourcesListValidation?.setError}
            <div class="a2-form-error" role="alert">{sourcesListValidation.setError}</div>
          {/if}
          <div class="a2-assigned-list">
            {#each sourcesListEntries as entry (entry.id)}
              {@const source = (data.sources as any[]).find((candidate) => candidate.id === entry.id)}
              {@const rowError = sourcesListValidation?.errors[entry.id] ?? null}
              <div class="a2-assigned-row">
                <label class="a2-position-field">
                  <span>Order</span>
                  <input type="number" name={`ordering_${entry.id}`} value={sourcesListDrafts[entry.id] ?? String(entry.savedPosition)} min="0" step="1" inputmode="numeric" class:invalid={Boolean(rowError)} aria-invalid={rowError ? 'true' : undefined} aria-label={`Ordering for ${source?.name ?? 'source'}`} oninput={(e) => { sourcesListDrafts = { ...sourcesListDrafts, [entry.id]: (e.currentTarget as HTMLInputElement).value }; }} />
                </label>
                <span class="a2-assigned-name">{source?.name ?? 'Unknown source'}</span>
                {#if rowError}<span class="a2-position-row-error" role="alert">{rowError}</span>{/if}
              </div>
            {/each}
          </div>
          <div class="a2-form-actions">
            <button type="submit" class="a2-btn-primary" disabled={!sourcesListValidation?.valid || !sourcesListDirty || sourcesListSaving}>{sourcesListSaving ? 'Saving…' : 'Apply'}</button>
            <button type="button" class="a2-btn-secondary" onclick={cancelSourcesListReposition} disabled={sourcesListSaving}>Cancel</button>
          </div>
        </form>
      {:else}
        <div class="a2-reposition-bar">
          <button type="button" class="a2-btn-secondary a2-reposition-trigger" onclick={startSourcesListReposition}>Reposition</button>
        </div>
        <div class="a2-source-list">
          {#each data.sources as source (source.id)}
            {@const provider = providerForSource(source)}
            <div class="a2-source-row" data-enabled={source.enabled}>
              <div class="a2-source-row-main">
                <!-- MAVP-4 Issue 4: real icon rendering (rich values via <img>,
                     keys via SourceIcon) + badge chips — the raw text fallback
                     that made values show as plain text is gone. -->
                <span class="a2-source-row-icon"><SourceIcon icon={source.icon ?? null} size={20} /></span>
                <div class="a2-source-row-info">
                  <div class="a2-source-row-name">{source.name}{#each parseSourceBadges(source.badge) as badgeConfig (badgeConfig.id)}<span class="source-badge-mini" data-variant={badgeConfig.variant}>{badgeConfig.label}</span>{/each}</div>
                  <div class="a2-source-row-meta">
                    <span>{provider?.name ?? '—'}</span>
                    <span>·</span>
                    <span class="mono">{source.integration_type}</span>
                    <span>·</span>
                    <span>{source.visibility}</span>
                    <span>·</span>
                    <span>order: {source.ordering}</span>
                  </div>
                </div>
              </div>
              <div class="a2-source-row-actions">
                <AdminStatusBadge label={source.status} tone={statusTone(source.status)} />
                <form method="POST" action="?/toggleSource" style="display:inline">
                  <input type="hidden" name="id" value={source.id} />
                  <input type="hidden" name="enabled" value={String(!source.enabled)} />
                  <button type="submit" class="a2-icon-btn" title={source.enabled ? 'Disable' : 'Enable'}>
                    <Power size={14} />
                  </button>
                </form>
                <button type="button" class="a2-icon-btn" onclick={(e) => openEditSource(source, e)} title="Edit">
                  <Edit3 size={14} />
                </button>
                <form method="POST" action="?/deleteSource" style="display:inline" onsubmit={(e) => { if (!confirm('Delete this source? This cannot be undone.')) e.preventDefault(); }}>
                  <input type="hidden" name="id" value={source.id} />
                  <button type="submit" class="a2-icon-btn a2-icon-btn-danger" title="Delete">
                    <Trash2 size={14} />
                  </button>
                </form>
              </div>
            </div>
          {/each}
        </div>
      {/if}

    {:else if currentTab === 'categories'}
      <!-- Categories tab (migrated from /admin/system/content-rules). The
           markup + bulk-reposition workflow are unchanged — only the
           route URL changed. -->
      {#if data.categories.length === 0}
        <div class="a2-empty">
          <Layers size={32} />
          <h3>No categories configured</h3>
          <p>Create categories to group sources and control resolver ordering.</p>
          <AdminAddButton label="Add category" onclick={openCreateCategory} />
        </div>
      {:else if categoriesRepositioning}
        <form
          method="POST"
          action="?/reorderCategories"
          class="a2-reposition-bar"
          use:enhance={() => {
            categoryReorderSaving = true;
            return async ({ update, result }) => {
              await update({ reset: false });
              categoryReorderSaving = false;
              if (result.type === 'success' || result.type === 'redirect') {
                categoriesRepositioning = false;
                categoryDrafts = {};
              }
            };
          }}
        >
          <p class="a2-reposition-hint">Edit the numbers to reposition. Every value is validated live — Apply stays disabled until the whole set is valid. Cancel discards unsaved edits.</p>
          {#if categoryRepositionValidation?.setError}
            <p class="a2-reposition-error" role="alert"><AlertCircle size={13} /> {categoryRepositionValidation.setError}</p>
          {/if}
          <div class="a2-assigned-list">
            {#each categoryRepositionEntries as entry (entry.id)}
              {@const cat = (data.categories as any[]).find((c) => c.id === entry.id)}
              {@const rowError = categoryRepositionValidation?.errors[entry.id] ?? null}
              <div class="a2-assigned-row">
                <label class="a2-position-field">
                  <span>Position</span>
                  <input type="number" name={`ordering_${entry.id}`} value={categoryDrafts[entry.id] ?? String(entry.savedPosition)} min="0" step="1" inputmode="numeric" class:invalid={Boolean(rowError)} aria-invalid={rowError ? 'true' : undefined} aria-label={`Position for ${cat?.name ?? 'category'}`} oninput={(e) => { categoryDrafts = { ...categoryDrafts, [entry.id]: (e.currentTarget as HTMLInputElement).value }; }} />
                </label>
                <span class="a2-assigned-name">{cat?.name ?? 'Unknown category'}</span>
                <AdminStatusBadge label={cat?.enabled ? 'Enabled' : 'Disabled'} tone={cat?.enabled ? 'good' : 'neutral'} />
                {#if rowError}<span class="a2-position-row-error" role="alert">{rowError}</span>{/if}
              </div>
            {/each}
          </div>
          <div class="a2-form-actions">
            <button type="submit" class="a2-btn-primary" disabled={!categoryRepositionValidation?.valid || !categoryRepositionDirty || categoryReorderSaving}>{categoryReorderSaving ? 'Saving…' : 'Apply'}</button>
            <button type="button" class="a2-btn-secondary" onclick={cancelCategoriesReposition} disabled={categoryReorderSaving}>Cancel</button>
          </div>
        </form>
      {:else}
        <div class="a2-reposition-bar">
          <button type="button" class="a2-btn-secondary a2-reposition-trigger" onclick={startCategoriesReposition}>Reposition</button>
        </div>
        <div class="a2-category-list">
          {#each data.categories as cat (cat.id)}
            <div class="a2-category-row" data-enabled={cat.enabled}>
              <div class="a2-category-row-main">
                <span class="a2-category-row-icon">📂</span>
                <div class="a2-category-row-info">
                  <div class="a2-category-row-name">{cat.name}</div>
                  <div class="a2-category-row-meta">
                    <span class="mono">{cat.slug}</span>
                    <span>·</span>
                    <span>{sourceCountForCategory(cat.id)} source(s)</span>
                    <span>·</span>
                    <span>order: {cat.ordering}</span>
                  </div>
                </div>
              </div>
              <div class="a2-category-row-actions">
                <AdminStatusBadge label={cat.enabled ? 'Enabled' : 'Disabled'} tone={cat.enabled ? 'good' : 'neutral'} />
                <form method="POST" action="?/toggleCategory" style="display:inline">
                  <input type="hidden" name="id" value={cat.id} />
                  <input type="hidden" name="enabled" value={String(!cat.enabled)} />
                  <button type="submit" class="a2-icon-btn" title={cat.enabled ? 'Disable' : 'Enable'}><Power size={14} /></button>
                </form>
                <button type="button" class="a2-icon-btn" onclick={() => openEditCategory(cat)} title="Edit"><Edit3 size={14} /></button>
                <form method="POST" action="?/deleteCategory" style="display:inline" onsubmit={(e) => { if (!confirm('Delete this category? This cannot be undone.')) e.preventDefault(); }}>
                  <input type="hidden" name="id" value={cat.id} />
                  <button type="submit" class="a2-icon-btn a2-icon-btn-danger" title="Delete"><Trash2 size={14} /></button>
                </form>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </AdminPage>
</AdminAppShell>

<!-- Defaults sheet -->
{#if defaultsOpen}
  <div class="a2-overlay" onclick={() => { defaultsOpen = false; }} onkeydown={(e) => { if (e.key === 'Escape') defaultsOpen = false; }} role="presentation">
    <div class="a2-sheet" role="dialog" aria-modal="true" aria-labelledby="a2-defaults-title" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
      <header class="a2-sheet-head">
        <h2 id="a2-defaults-title" class="a2-sheet-title"><SlidersHorizontal size={16} /> Default Sources</h2>
        <button type="button" class="a2-sheet-close" onclick={() => { defaultsOpen = false; }} aria-label="Close"><X size={16} /></button>
      </header>
      <div class="a2-sheet-body">
        <p class="a2-sheet-desc">Configure the preferred source order for each content type: a primary choice plus two automatic fallbacks. When the primary source cannot play a title, Mavero tries the fallbacks in order before any other source.</p>
        {#each CONTENT_TYPES as ct}
          {@const slotIds = slotsForType(ct.type)}
          <div class="a2-default-row">
            <div class="a2-default-row-label">
              <span class="a2-default-row-type">{ct.label}</span>
              <span class="a2-default-row-current">
                {#if slotIds.length}Current: <strong>{slotIds.map((id) => sourceName(id)).join(' → ')}</strong>{:else}<span class="a2-default-row-none">No default set</span>{/if}
              </span>
            </div>
            <div class="a2-default-row-control">
              <!-- MAVP-5 (Issue 6): THREE ordered slots per category —
                   primary (1), secondary fallback (2), tertiary fallback (3).
                   One form posts all three in order (slot_source repeated
                   field; position = order of appearance). Already-chosen
                   sources are disabled in the OTHER slots of the same
                   category (distinct choices); ineligible sources stay
                   disabled everywhere (same rule as before). -->
              <form method="POST" action="?/saveDefaultSlots" style="display:flex; gap:4px; flex:1; flex-wrap:wrap;">
                <input type="hidden" name="content_type" value={ct.type} />
                {#each [0, 1, 2] as slotIndex}
                  {@const chosen = slotIds[slotIndex] ?? ''}
                  {@const positionLabel = slotIndex === 0 ? 'Primary' : slotIndex === 1 ? 'Secondary' : 'Tertiary'}
                  <label class="a2-default-slot">
                    <span class="a2-default-slot-label">{positionLabel}</span>
                    <select name="slot_source" class="a2-default-select">
                      <option value="">— None —</option>
                      {#each data.sources as source (source.id)}
                        {@const eligible = isSourceEligible(source)}
                        {@const chosenElsewhere = slotIds.some((id, i) => i !== slotIndex && id === source.id)}
                        <option value={source.id} selected={chosen === source.id} disabled={!eligible || chosenElsewhere}>
                          {source.name}{#if !eligible} (ineligible){:else if chosenElsewhere} (already chosen){/if}
                        </option>
                      {/each}
                    </select>
                  </label>
                {/each}
                <button type="submit" class="a2-default-save">Save order</button>
                {#if slotIds.length}
                  <button type="submit" formaction="?/clearDefault" name="content_type" value={ct.type} class="a2-default-clear">Clear</button>
                {/if}
              </form>
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<!-- Provider create/edit sheet -->
{#if providerSheetOpen}
  <AdminSheet open={providerSheetOpen} title={editingProvider ? `Edit ${editingProvider.name}` : 'Add Provider'} onClose={closeProviderSheet}>
    <form method="POST" action={editingProvider ? '?/updateProvider' : '?/createProvider'} class="a2-crud-form" enctype="multipart/form-data">
      {#if editingProvider}
        <input type="hidden" name="id" value={editingProvider.id} />
      {/if}
      <AdminFormSection heading="Identity">
        <label class="a2-field"><span>Name</span><input name="name" required value={editingProvider?.name ?? ''} /></label>
        <label class="a2-field"><span>Slug</span><input name="slug" required value={editingProvider?.slug ?? ''} /></label>
        <label class="a2-field"><span>Adapter ID</span><input name="adapter_id" required value={editingProvider?.adapter_id ?? ''} /></label>
        <label class="a2-field"><span>Integration Type</span>
          <select name="integration_type">
            {#each integrationTypes as t}<option value={t} selected={editingProvider?.integration_type === t}>{integrationLabels[t]}</option>{/each}
          </select>
        </label>
        <label class="a2-field"><span>Status</span>
          <select name="status">
            {#each providerStatuses as s}<option value={s} selected={editingProvider?.status === s}>{providerStatusLabels[s]}</option>{/each}
          </select>
        </label>
      </AdminFormSection>
      <AdminFormSection heading="Configuration">
        <!-- Issue 4 (2026-10-16 round): provider icon editor. The URL field
             is PRESERVED; an optional PNG/SVG upload (same server pipeline
             and validation as source icons) takes precedence when a file is
             selected; removal is the explicit checkbox. The hidden `icon`
             field submits '' when a file is selected (the file wins) or —
             for an update with no file and no URL — means NO CHANGE (the
             saved icon is never erased by an unrelated edit). The preview
             always shows the result that will be saved. -->
        <div class="a2-field">
          <span>Icon</span>
          <input type="hidden" name="icon" value={providerIconSubmitValue} />
          <div class="a2-icon-editor">
            <div class="a2-icon-preview" aria-hidden="true">
              {#if providerIconRemove || !providerIconPreviewUrl}
                <span class="a2-provider-icon-fallback" aria-hidden="true">🔧</span>
              {:else if !providerIconPreviewFailed}
                <img src={providerIconPreviewUrl} alt="" width="22" height="22" onerror={() => (providerIconPreviewFailed = true)} />
              {:else}
                <span class="a2-provider-icon-fallback" aria-hidden="true">🔧</span>
              {/if}
            </div>
            <div class="a2-provider-icon-inputs">
              <label class="a2-field"><span>Icon URL (https)</span><input name="icon_url_visible" type="url" bind:value={providerIconUrlDraft} placeholder="https://example.com/icon.svg" oninput={() => (providerIconPreviewFailed = false)} /></label>
              <label class="a2-field"><span>Upload PNG / SVG file (PNG ≤ 64 KB or SVG ≤ 48 KB — a selected file replaces the URL)</span><input type="file" name="icon_file" accept="image/png,image/svg+xml" onchange={handleProviderIconFileChange} /></label>
              {#if providerIconFileName}<small class="a2-field-hint">Selected: {providerIconFileName} — this file will be saved as the icon.</small>{/if}
              {#if editingProvider && typeof editingProvider.icon === 'string' && editingProvider.icon.trim()}
                <label class="a2-field a2-icon-remove-row">
                  <input type="checkbox" bind:checked={providerIconRemove} oninput={() => (providerIconPreviewFailed = false)} />
                  <span class="a2-icon-remove-label">Remove the saved icon on save</span>
                </label>
              {/if}
            </div>
          </div>
        </div>
        <label class="a2-field"><span>Description</span><input name="description" value={editingProvider?.description ?? ''} /></label>
        <label class="a2-field"><span>Notes</span><input name="notes" value={editingProvider?.notes ?? ''} /></label>
        <label class="a2-field">
          <span>Sandbox Policy</span>
          <select name="sandbox_policy">
            {#each sandboxPolicies as p}<option value={p} selected={editingProvider ? sandboxOn(editingProvider) === (p === 'required') : p === 'required'}>{sandboxPolicyLabels[p]}</option>{/each}
          </select>
        </label>
        <label class="a2-field"><span>Enabled</span><input type="checkbox" name="enabled" value="true" checked={editingProvider ? editingProvider.enabled : true} /></label>
      </AdminFormSection>
      {#if !editingProvider}
        <input type="hidden" name="capabilities" value={'{"movies":true}'} />
      {/if}
      <div class="a2-form-actions">
        <button type="submit" class="a2-btn-primary">{editingProvider ? 'Save' : 'Create'}</button>
        <button type="button" class="a2-btn-secondary" onclick={closeProviderSheet}>Cancel</button>
      </div>
    </form>
  </AdminSheet>
{/if}

<!-- Source create/edit sheet -->
{#if sourceSheetOpen}
  <AdminSheet open={sourceSheetOpen} title={editingSource ? `Edit ${editingSource.name}` : 'Add Source'} onClose={closeSourceSheet}>
    <form method="POST" action={editingSource ? '?/updateSource' : '?/createSource'} class="a2-crud-form" enctype="multipart/form-data">
      {#if editingSource}
        <input type="hidden" name="id" value={editingSource.id} />
      {/if}
      <AdminFormSection heading="Identity">
        <label class="a2-field"><span>Name</span><input name="name" required value={editingSource?.name ?? ''} /></label>
        <label class="a2-field"><span>Slug</span><input name="slug" required value={editingSource?.slug ?? ''} /></label>
        <label class="a2-field"><span>Provider</span>
          <select name="provider_id" required>
            <option value="">— Select provider —</option>
            {#each data.providers as p}<option value={p.id} selected={editingSource?.provider_id === p.id}>{p.name}</option>{/each}
          </select>
        </label>
        <label class="a2-field"><span>Integration Type</span>
          <select name="integration_type">
            {#each integrationTypes as t}<option value={t} selected={editingSource?.integration_type === t}>{integrationLabels[t]}</option>{/each}
          </select>
        </label>
        <label class="a2-field"><span>Status</span>
          <select name="status">
            {#each providerStatuses as s}<option value={s} selected={editingSource?.status === s}>{providerStatusLabels[s]}</option>{/each}
          </select>
        </label>
      </AdminFormSection>
      <AdminFormSection heading="Presentation">
        <!-- MAVP-4 Issue 4: RESTORED icon picker + rich icon inputs. The
             hidden `icon` field carries the raw chosen value (key / pasted
             SVG markup / URL); uploads travel as `icon_file` (multipart)
             and take precedence server-side. The server sanitizes SVG and
             validates PNG/URL values into the stored contract. -->
        <div class="a2-field">
          <span>Icon</span>
          <input type="hidden" name="icon" value={iconSubmitValue} />
          <div class="a2-icon-editor">
            <div class="a2-icon-preview" aria-hidden="true">
              {#if iconMode === 'key' || (iconMode === 'svg' && !iconSvgPreviewUrl) || (iconMode === 'upload' && !iconPreviewDataUrl) || (iconMode === 'url' && !iconUrlDraft.trim())}
                <SourceIcon icon={iconMode === 'key' ? iconKeyDraft : null} size={22} />
              {:else if iconMode === 'svg'}
                {#if !iconPreviewFailed}<img src={iconSvgPreviewUrl} alt="" width="22" height="22" onerror={() => (iconPreviewFailed = true)} />{:else}<SourceIcon icon={null} size={22} />{/if}
              {:else if iconMode === 'upload'}
                {#if !iconPreviewFailed}<img src={iconPreviewDataUrl} alt="" width="22" height="22" onerror={() => (iconPreviewFailed = true)} />{:else}<SourceIcon icon={null} size={22} />{/if}
              {:else}
                {#if !iconPreviewFailed}<img src={iconUrlDraft} alt="" width="22" height="22" onerror={() => (iconPreviewFailed = true)} />{:else}<SourceIcon icon={null} size={22} />{/if}
              {/if}
            </div>
            <select bind:value={iconMode} aria-label="Icon input method">
              <option value="key">Built-in icon</option>
              <option value="upload">Upload PNG / SVG file</option>
              <option value="svg">Paste SVG markup</option>
              <option value="url">Image URL</option>
            </select>
          </div>
          {#if iconMode === 'key'}
            <div class="a2-icon-key-grid" role="group" aria-label="Built-in icon keys">
              {#each sourceIconKeys as iconKey (iconKey)}
                <button type="button" class="a2-icon-key" class:active={iconKeyDraft === iconKey} aria-pressed={iconKeyDraft === iconKey} title={sourceIconLabels[iconKey]} onclick={() => { iconKeyDraft = iconKey; iconPreviewFailed = false; }}><SourceIcon icon={iconKey} size={16} /></button>
              {/each}
            </div>
          {:else if iconMode === 'upload'}
            <label class="a2-field"><span>Icon file (PNG ≤ 64 KB or SVG ≤ 48 KB)</span><input type="file" name="icon_file" accept="image/png,image/svg+xml" onchange={handleIconFileChange} /></label>
            {#if iconFileName}<small class="a2-field-hint">Selected: {iconFileName}{iconMode === 'upload' && iconFileName === 'uploaded PNG' ? ' — choose a file to replace it' : ''}</small>{/if}
          {:else if iconMode === 'svg'}
            <label class="a2-field"><span>SVG markup (sanitized on save — scripts, event handlers and external references are rejected)</span><textarea rows="5" bind:value={iconSvgDraft} aria-label="SVG markup" spellcheck="false"></textarea></label>
          {:else}
            <label class="a2-field"><span>Image URL (https)</span><input type="url" bind:value={iconUrlDraft} placeholder="https://example.com/icon.png" oninput={() => (iconPreviewFailed = false)} /></label>
          {/if}
          <!-- Issue 3 (2026-10-16 round): EXPLICIT icon removal. An empty
               icon field / no new file can no longer erase a saved icon (the
               server treats it as NO CHANGE) — removal is this deliberate,
               visible checkbox, offered only when an icon is actually saved. -->
          {#if editingSource && storedSourceIconExists}
            <label class="a2-field a2-icon-remove-row">
              <input type="checkbox" name="icon_remove" value="true" bind:checked={iconRemoveChecked} />
              <span class="a2-icon-remove-label">Remove the saved icon on save</span>
            </label>
            {#if iconRemoveChecked}<small class="a2-field-hint" role="status">The saved icon will be REMOVED when you press Save.</small>{/if}
          {/if}
        </div>
        <label class="a2-field"><span>Visibility</span>
          <select name="visibility">
            <option value="public" selected={editingSource?.visibility === 'public'}>Public</option>
            <option value="internal" selected={editingSource?.visibility === 'internal'}>Internal</option>
            <option value="hidden" selected={editingSource?.visibility === 'hidden'}>Hidden</option>
          </select>
        </label>
        <label class="a2-field"><span>Identifier Mode</span>
          <select name="identifier_mode">
            <option value="tmdb_id" selected={editingSource?.identifier_mode === 'tmdb_id'}>TMDB ID</option>
            <option value="imdb_id" selected={editingSource?.identifier_mode === 'imdb_id'}>IMDb ID</option>
            <option value="anilist_id" selected={editingSource?.identifier_mode === 'anilist_id'}>AniList ID</option>
            <option value="slug" selected={editingSource?.identifier_mode === 'slug'}>Slug</option>
            <option value="custom" selected={editingSource?.identifier_mode === 'custom'}>Custom</option>
          </select>
        </label>
        <label class="a2-field"><span>Language</span><input name="language" value={editingSource?.language ?? ''} /></label>
        <!-- MAVP-4 Issue 4: EXTENSIBLE badge picker — built-in chips
             (Ad-Free / Ads / 4K) + previously used definitions (harvested
             from the configured sources for reuse) + create-new with a
             controlled style variant. The hidden `badge` field serializes
             the canonical JSON-array contract; the server validates it
             strictly. Legacy single-badge values keep rendering unchanged. -->
        <div class="a2-field">
          <span>Badges (up to 3)</span>
          <input type="hidden" name="badge" value={badgeSubmitValue} />
          <div class="a2-badge-picker">
            {#each knownBadgeDefinitions as definition (definition.id)}
              <button type="button" class="a2-badge-chip" class:selected={badgeDrafts.some((badge) => badge.id === definition.id)} data-variant={definition.variant} aria-pressed={badgeDrafts.some((badge) => badge.id === definition.id)} onclick={() => toggleBadgeDefinition(definition)}>{definition.label}</button>
            {/each}
          </div>
          {#if badgeEditorHint}<small class="a2-field-hint" role="status">{badgeEditorHint}</small>{/if}
          <div class="a2-badge-new">
            <input type="text" bind:value={newBadgeLabel} placeholder="New badge label" maxlength={24} aria-label="New badge label" />
            <select bind:value={newBadgeVariant} aria-label="New badge style">
              {#each sourceBadgeVariants as variant}<option value={variant}>{variant}</option>{/each}
            </select>
            <button type="button" class="a2-btn-mini" onclick={createBadgeDefinition} disabled={!newBadgeLabel.trim()}>Create</button>
          </div>
        </div>
        <label class="a2-field"><span>Enabled</span><input type="checkbox" name="enabled" value="true" checked={editingSource ? editingSource.enabled : true} /></label>
      </AdminFormSection>
      <AdminFormSection heading="Templates">
        <label class="a2-field"><span>Movie Template</span><input name="movie_template" value={editingSource?.movie_template ?? ''} /></label>
        <label class="a2-field"><span>Series Template</span><input name="series_template" value={editingSource?.series_template ?? ''} /></label>
        <label class="a2-field"><span>Anime Template</span><input name="anime_template" value={editingSource?.anime_template ?? ''} /></label>
      </AdminFormSection>
      <AdminFormSection heading="Metadata">
        <label class="a2-field"><span>Description</span><input name="description" value={editingSource?.description ?? ''} /></label>
        <label class="a2-field"><span>Notes</span><input name="notes" value={editingSource?.notes ?? ''} /></label>
      </AdminFormSection>
      <!-- MAVP-2: per-source floating-control placement. Persisted inside
           capabilities.player_controls_position as ONE structured JSON payload
           (controls_position_json) validated strictly by the server action.
           TWO independent controls (Landscape button, Back button) × TWO
           independent orientation profiles (portrait, landscape) × TWO
           independent axes (horizontal anchor+offset, vertical anchor+offset).
           Unset axes keep the player's stylesheet defaults (Landscape button
           = bottom-right, Back button = top-left — both safe-area aware). -->
      <AdminFormSection heading="Player Controls Position">
        <p class="a2-field-hint">Pick a 3×3 cell for each MAVERO floating control. The cell anchors the button to that corner/edge of the screen (safe-area aware). Defaults: Back button top-left, Fullscreen button bottom-right. To hold the controls visible while you align them, open a watch URL with <code>?controls=calibrate</code>.</p>
        <input type="hidden" name="controls_position_json" value={controlsPositionJson} />
        <label class="a2-field"><span>Position Mode</span>
          <select name="controls_position_mode" bind:value={controlsPositionMode}>
            <option value="default">Default — stylesheet corners</option>
            <option value="custom">Custom — 3×3 grid</option>
          </select>
        </label>
        {#if controlsPositionMode === 'custom'}
          <div class="a2-grid-picker-wrap">
            {#each gridPickers as control (control.id)}
              <div class="a2-grid-picker">
                <span class="a2-grid-picker-title">{control.title}</span>
                <div class="a2-grid-picker-cells" role="group" aria-label={`${control.title} position`}>
                  {#each GRID_CELLS as cell}
                    <button type="button" class="a2-grid-cell" class:selected={control.value === cell} aria-pressed={control.value === cell} aria-label={`${control.title}: ${GRID_CELL_LABELS[cell]}`} title={GRID_CELL_LABELS[cell]} onclick={() => setGridCell(control.id, cell)}>
                      {#if control.value === cell}<span class="a2-grid-cell-dot" aria-hidden="true"></span>{/if}
                    </button>
                  {/each}
                </div>
                <span class="a2-grid-picker-current">Current: {control.value ? GRID_CELL_LABELS[control.value] : 'Default'}</span>
              </div>
            {/each}
          </div>
          <button type="button" class="a2-btn-secondary" onclick={resetAllControlsPosition}>Reset positioning</button>
        {/if}
      </AdminFormSection>
      <div class="a2-form-actions">
        <button type="submit" class="a2-btn-primary">{editingSource ? 'Save' : 'Create'}</button>
        <button type="button" class="a2-btn-secondary" onclick={closeSourceSheet}>Cancel</button>
      </div>
    </form>
  </AdminSheet>
{/if}

<!-- Category create/edit sheet (migrated from /admin/system/content-rules) -->
{#if categorySheetOpen}
  <AdminSheet open={categorySheetOpen} title={editingCategory ? `Edit ${editingCategory.name}` : 'Add Category'} onClose={closeCategorySheet}>
    <div class="a2-crud-form">
      <form method="POST" action={editingCategory ? '?/updateCategory' : '?/createCategory'} use:enhance={() => {
        return async ({ update }) => { await update({ reset: false }); };
      }}>
        {#if editingCategory}<input type="hidden" name="id" value={editingCategory.id} />{/if}
        <AdminFormSection heading="Identity">
          <label class="a2-field"><span>Name</span><input name="name" required value={editingCategory?.name ?? ''} /></label>
          <label class="a2-field"><span>Slug</span><input name="slug" required value={editingCategory?.slug ?? ''} /></label>
          <label class="a2-field"><span>Enabled</span><input type="checkbox" name="enabled" value="true" checked={editingCategory ? editingCategory.enabled : true} /></label>
        </AdminFormSection>
        <AdminFormSection heading="Metadata">
          <label class="a2-field"><span>Description</span><input name="description" value={editingCategory?.description ?? ''} /></label>
        </AdminFormSection>
        <div class="a2-form-actions">
          <button type="submit" class="a2-btn-primary">{editingCategory ? 'Save' : 'Create'}</button>
          <button type="button" class="a2-btn-secondary" onclick={closeCategorySheet}>Cancel</button>
        </div>
      </form>

      {#if editingCategory}
        <AdminFormSection heading="Sources in this category">
          {#if sourcesRepositioning && sourceRepositionEntries.length > 0}
            <form
              method="POST"
              action="?/reorderSourcesBulk"
              class="a2-reposition-form"
              use:enhance={() => {
                sourceReorderSaving = true;
                return async ({ update, result }) => {
                  await update({ reset: false });
                  sourceReorderSaving = false;
                  if (result.type === 'success' || result.type === 'redirect') {
                    sourcesRepositioning = false;
                    sourceDrafts = {};
                  }
                };
              }}
            >
              <input type="hidden" name="category_id" value={editingCategory.id} />
              {#if sourceRepositionValidation?.valid}
                {#each sourceRepositionValidation.orderedIds as orderedId (orderedId)}
                  <input type="hidden" name="ordered_source_ids" value={orderedId} />
                {/each}
              {/if}
              <p class="a2-field-hint">Edit the numbers to reposition (1 = first). Values are validated live — Apply stays disabled until the whole set is valid. Cancel discards unsaved edits.</p>
              {#if sourceRepositionValidation?.setError}
                <p class="a2-reposition-error" role="alert"><AlertCircle size={13} /> {sourceRepositionValidation.setError}</p>
              {/if}
              <div class="a2-assigned-list">
                {#each sourceRepositionEntries as entry (entry.id)}
                  {@const row = assignedSourcesForCategory(editingCategory.id).find((candidate) => candidate.sourceId === entry.id)}
                  {@const rowError = sourceRepositionValidation?.errors[entry.id] ?? null}
                  <div class="a2-assigned-row">
                    <label class="a2-position-field">
                      <span>Position</span>
                      <input type="number" value={sourceDrafts[entry.id] ?? String(entry.savedPosition)} min="1" max={sourceRepositionEntries.length} step="1" inputmode="numeric" class:invalid={Boolean(rowError)} aria-invalid={rowError ? 'true' : undefined} aria-label={`Position for ${row?.name ?? 'source'}`} oninput={(e) => { sourceDrafts = { ...sourceDrafts, [entry.id]: (e.currentTarget as HTMLInputElement).value }; }} />
                    </label>
                    <span class="a2-assigned-name">{row?.name ?? 'Unknown source'}</span>
                    {#if row?.enabled === false}
                      <AdminStatusBadge label="Disabled" tone="neutral" />
                    {/if}
                    {#if rowError}<span class="a2-position-row-error" role="alert">{rowError}</span>{/if}
                  </div>
                {/each}
              </div>
              <div class="a2-form-actions">
                <button type="submit" class="a2-btn-primary" disabled={!sourceRepositionValidation?.valid || !sourceRepositionDirty || sourceReorderSaving}>{sourceReorderSaving ? 'Saving…' : 'Apply'}</button>
                <button type="button" class="a2-btn-secondary" onclick={cancelSourcesReposition} disabled={sourceReorderSaving}>Cancel</button>
              </div>
            </form>
          {:else}
            <p class="a2-field-hint">Assign an unassigned source to this category. Positions (1 = first) are edited through the shared Reposition workflow; removing never deletes the source itself.</p>
            {#if sourceRepositionEntries.length > 0}
              <div class="a2-reposition-bar">
                <button type="button" class="a2-btn-secondary a2-reposition-trigger" onclick={startSourcesReposition}>Reposition</button>
              </div>
              <div class="a2-assigned-list">
                {#each assignedSourcesForCategory(editingCategory.id) as row (row.sourceId)}
                  <div class="a2-assigned-row">
                    <span class="a2-assigned-pos">{row.position}</span>
                    <span class="a2-assigned-name">{row.name}</span>
                    <AdminStatusBadge label={row.status ?? 'unknown'} tone={statusTone(row.status)} />
                    {#if row.enabled === false}
                      <AdminStatusBadge label="Disabled" tone="neutral" />
                    {/if}
                    <span class="a2-assigned-spacer"></span>
                    <form method="POST" action="?/removeSource" class="a2-inline-form" use:enhance={({ cancel }) => {
                      if (!confirm('Remove this source from the category? The source itself is not deleted.')) { cancel(); return; }
                      return async ({ update }) => {
                        await update({ reset: false });
                        cancelSourcesReposition();
                      };
                    }}>
                      <input type="hidden" name="category_id" value={editingCategory.id} />
                      <input type="hidden" name="source_id" value={row.sourceId} />
                      <button type="submit" class="a2-icon-btn a2-icon-btn-danger" title="Remove from category" aria-label={`Remove ${row.name} from this category`}><Trash2 size={14} /></button>
                    </form>
                  </div>
                {/each}
              </div>
            {:else}
              <p class="a2-sources-empty" role="status">No sources assigned to this category yet.</p>
            {/if}
          {/if}
          {#if assignableSourcesForCategory(editingCategory.id).length === 0}
            <p class="a2-sources-empty" role="status">No unassigned sources remain — every existing source already belongs to a category.</p>
          {:else}
            <form method="POST" action="?/assignSource" class="a2-assign-row" use:enhance={() => {
              return async ({ update, formElement, result }) => {
                await update({ reset: false });
                if (result.type === 'success' || result.type === 'redirect') {
                  formElement.reset();
                  cancelSourcesReposition();
                }
              };
            }}>
              <input type="hidden" name="category_id" value={editingCategory.id} />
              <label class="a2-field a2-assign-select"><span>Assign a source</span>
                <select name="source_id" required>
                  {#each assignableSourcesForCategory(editingCategory.id) as candidate (candidate.id)}
                    <option value={candidate.id}>{candidate.name} — {candidate.status ?? 'unknown'}</option>
                  {/each}
                </select>
              </label>
              <button type="submit" class="a2-btn-secondary"><Plus size={13} /> Assign</button>
            </form>
          {/if}
        </AdminFormSection>
      {:else}
        <p class="a2-field-hint">Source assignment becomes available once the category is created — edit it afterwards to manage its sources and resolver order.</p>
      {/if}
    </div>
  </AdminSheet>
{/if}

<style>
  .a2-notice { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-sm); }
  .a2-form-error { padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-sm); }
  .a2-defaults-btn { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-4); background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; }
  /* MAVP-5 (Issue 6): ordered slot selects — three labelled selects per
     category row, wrapping on narrow viewports without breaking the sheet. */
  .a2-default-slot { display: flex; flex-direction: column; gap: 2px; min-width: 150px; flex: 1 1 150px; }
  .a2-default-slot-label { color: var(--a2-text-muted); font-size: var(--a2-text-xs); letter-spacing: 0.04em; text-transform: uppercase; }
  .a2-defaults-btn:hover { background: var(--a2-cyan-soft); border-color: var(--a2-cyan); color: var(--a2-cyan); }
  .a2-empty { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); text-align: center; color: var(--a2-text-muted); }
  .a2-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-empty p { margin: 0; font-size: var(--a2-text-sm); max-width: 420px; }

  .a2-provider-list, .a2-source-list { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-provider-row, .a2-source-row { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-provider-row[data-enabled="false"], .a2-source-row[data-enabled="false"] { opacity: 0.6; }
  .a2-provider-row-main, .a2-source-row-main { display: flex; align-items: center; gap: var(--a2-space-3); min-width: 0; }
  .a2-provider-row-icon, .a2-source-row-icon { font-size: 20px; flex-shrink: 0; }
  .a2-provider-row-info, .a2-source-row-info { min-width: 0; }
  .a2-provider-row-name, .a2-source-row-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-provider-row-meta, .a2-source-row-meta { display: flex; gap: var(--a2-space-1); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); flex-wrap: wrap; }
  .a2-provider-row-actions, .a2-source-row-actions { display: flex; align-items: center; gap: var(--a2-space-1); flex-shrink: 0; }
  .a2-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; min-width: 44px; min-height: 44px; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); background: var(--a2-surface-3); color: var(--a2-text-muted); cursor: pointer; transition: all 140ms ease-out; }
  .a2-icon-btn:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .a2-icon-btn-danger:hover { color: var(--a2-red); border-color: var(--a2-red-border); }

  .a2-overlay { position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,0.55); backdrop-filter: blur(2px); display: flex; justify-content: flex-end; }
  .a2-sheet { width: 100%; max-width: 480px; background: var(--a2-surface-1); border-left: 1px solid var(--a2-border-strong); display: flex; flex-direction: column; overflow-y: auto; }
  .a2-sheet-head { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-4); padding-top: env(safe-area-inset-top, 0px); border-bottom: 1px solid var(--a2-border); position: sticky; top: 0; background: var(--a2-surface-1); z-index: 1; }
  .a2-sheet-title { display: inline-flex; align-items: center; gap: var(--a2-space-2); margin: 0; font-size: var(--a2-text-base); font-weight: 700; color: var(--a2-text-bright); }
  .a2-sheet-close { background: transparent; border: none; cursor: pointer; color: var(--a2-text-muted); padding: 4px; min-width: 44px; min-height: 44px; border-radius: var(--a2-radius-xs); }
  .a2-sheet-body { padding: var(--a2-space-4); padding-bottom: env(safe-area-inset-bottom, 0px); display: flex; flex-direction: column; gap: var(--a2-space-4); }
  .a2-sheet-desc { margin: 0 0 var(--a2-space-2); font-size: var(--a2-text-sm); color: var(--a2-text-muted); line-height: 1.5; }
  .a2-default-row { display: flex; flex-direction: column; gap: var(--a2-space-2); padding: var(--a2-space-3); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); }
  .a2-default-row-label { display: flex; justify-content: space-between; align-items: center; }
  .a2-default-row-type { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-default-row-current { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-default-row-none { color: var(--a2-text-dim); font-style: italic; }
  .a2-default-row-control { display: flex; gap: var(--a2-space-1); align-items: center; }
  .a2-default-select { flex: 1; background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-xs); padding: 8px 10px; min-height: 44px; }
  .a2-default-save { padding: 8px 14px; background: var(--a2-cyan); color: var(--a2-surface-1); border: none; border-radius: var(--a2-radius-sm); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; min-height: 44px; }
  .a2-default-clear { padding: 8px 14px; background: var(--a2-surface-4); color: var(--a2-text-muted); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; min-height: 44px; }

  .a2-crud-form { display: flex; flex-direction: column; gap: var(--a2-space-4); }
  .a2-field { display: flex; flex-direction: column; gap: 2px; }
  .a2-field span { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-field input, .a2-field select { background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); padding: 6px 10px; }
  .a2-field input:focus, .a2-field select:focus { outline: none; border-color: var(--a2-cyan); }
  .a2-form-actions { display: flex; gap: var(--a2-space-2); justify-content: flex-end; padding-top: var(--a2-space-3); border-top: 1px solid var(--a2-border); }
  .a2-btn-primary { padding: 10px 16px; background: var(--a2-cyan); color: var(--a2-surface-1); border: none; border-radius: var(--a2-radius-sm); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }
  .a2-btn-secondary { padding: 10px 16px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }

  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }

  /* MAVP-4 Issue 4: icon editor (restored picker + rich inputs) and the
     extensible badge picker. Admin tokens only. */
  .a2-icon-editor { display: flex; align-items: flex-start; gap: var(--a2-space-2); }
  /* 2026-10-16 round (Issue 5): unified bulk-reposition editor (Sources tab)
     — mirrors the content-rules surface so both lists behave identically. */
  .a2-reposition-bar { display: flex; align-items: center; justify-content: flex-end; gap: var(--a2-space-2); margin-bottom: var(--a2-space-2); }
  .a2-reposition-trigger { min-height: 44px; }
  .a2-reposition-form { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-assigned-list { display: flex; flex-direction: column; gap: var(--a2-space-1); }
  .a2-assigned-row { display: flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-1) var(--a2-space-2); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); flex-wrap: wrap; }
  .a2-assigned-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  /* Issue 4 (2026-10-16 round): provider icon editor inputs + explicit
     remove rows (shared by the provider and source sheets). */
  .a2-provider-icon-inputs { display: flex; flex-direction: column; gap: var(--a2-space-2); flex: 1 1 auto; min-width: 0; }
  .a2-icon-remove-row { flex-direction: row; align-items: center; gap: var(--a2-space-1); }
  .a2-icon-remove-row input[type='checkbox'] { width: 16px; height: 16px; accent-color: var(--a2-cyan); }
  .a2-icon-remove-label { font-size: var(--a2-text-xs); color: var(--a2-text); text-transform: none; letter-spacing: 0; font-weight: 500; }
  .a2-provider-icon-fallback { font-size: 18px; }
  .a2-icon-editor select { flex: 1; }
  .a2-icon-preview { display: grid; place-items: center; width: 40px; height: 40px; flex: 0 0 40px; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); background: var(--a2-surface-3); color: var(--a2-text); }
  .a2-icon-preview img { border-radius: 4px; }
  .a2-icon-key-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(38px, 1fr)); gap: var(--a2-space-1); }
  .a2-icon-key { display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); background: var(--a2-surface-3); color: var(--a2-text-muted); cursor: pointer; }
  .a2-icon-key:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .a2-icon-key.active { color: var(--a2-cyan); border-color: var(--a2-cyan); background: var(--a2-cyan-soft); }
  .a2-field textarea { background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-xs); font-family: var(--a2-font-mono); padding: 8px 10px; resize: vertical; }
  .a2-field textarea:focus { outline: none; border-color: var(--a2-cyan); }
  .a2-badge-picker { display: flex; flex-wrap: wrap; gap: var(--a2-space-1); }
  .a2-badge-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--a2-border-strong); border-radius: 999px; padding: 4px 10px; background: var(--a2-surface-3); color: var(--a2-text-muted); font-size: var(--a2-text-2xs); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; cursor: pointer; }
  .a2-badge-chip:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .a2-badge-chip.selected { color: var(--a2-cyan); border-color: var(--a2-cyan); background: var(--a2-cyan-soft); }
  .a2-badge-new { display: flex; gap: var(--a2-space-1); align-items: center; }
  .a2-badge-new input { flex: 1; }
  .a2-badge-new select { width: auto; }
  .source-badge-mini { display: inline-flex; align-items: center; margin-left: 6px; border: 1px solid var(--a2-border-strong); border-radius: 999px; padding: 0 6px; font-size: 9px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--a2-text-muted); vertical-align: middle; }
  .source-badge-mini[data-variant='accent'] { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .source-badge-mini[data-variant='positive'] { color: var(--a2-green, #7ee2a8); border-color: var(--a2-green-soft, rgba(126,226,168,.3)); }
  .source-badge-mini[data-variant='warning'] { color: var(--a2-amber, #ffc247); border-color: var(--a2-amber-soft, rgba(255,194,71,.3)); }

  /* Player Controls Position section (player redesign; MAVP-2 per-control,
     per-orientation profiles). */
  .a2-field-hint { margin: 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); line-height: 1.5; }
  .a2-btn-mini { padding: 4px 10px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text-muted); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; }
  .a2-btn-mini:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  /* MAVP-4 Issue 3: the preview stages are SCALED REFERENCE VIEWPORTS —
     portrait 390×844, landscape 844×390 (the shared contract's documented
     references, same aspect ratio as the modelled runtime viewport so
     viewport-relative % map 1:1). `container-type: size` makes the stage a
     query container so marker sizes/defaults render in cqw/cqh — uniformly
     scaled by the shared geometry helper instead of treating preview pixels
     as runtime pixels. Both markers are ALWAYS explicitly positioned by the
     shared resolver (no auto-position pile-up in either orientation). */

  @media (max-width: 768px) {
    .a2-sheet { max-width: 100%; }
    .a2-provider-row, .a2-source-row { flex-direction: column; align-items: stretch; }
    .a2-provider-row-actions, .a2-source-row-actions { justify-content: flex-end; }
    .a2-default-row-control { flex-wrap: wrap; }
  }
  .a2-position-field { display: flex; flex-direction: column; gap: 2px; }
  .a2-position-field span { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-position-field input { width: 4.5rem; min-height: 44px; padding: 6px 8px; background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); text-align: center; }
  .a2-position-field input:focus { outline: none; border-color: var(--a2-cyan); }
  .a2-position-field input.invalid { border-color: var(--a2-red); color: var(--a2-red); }
  .a2-position-field input.invalid:focus { border-color: var(--a2-red); }
  .a2-position-row-error { font-size: var(--a2-text-2xs); color: var(--a2-red); }
  /* Player Controls Position — 3x3 grid picker */
  .a2-grid-picker-wrap { display: flex; flex-wrap: wrap; gap: var(--a2-space-4); margin-top: var(--a2-space-2); }
  .a2-grid-picker { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-grid-picker-title { font-size: var(--a2-text-2xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--a2-text-dim); }
  .a2-grid-picker-cells { display: grid; grid-template-columns: repeat(3, 44px); grid-template-rows: repeat(3, 44px); gap: 4px; }
  .a2-grid-cell { display: grid; place-items: center; width: 44px; height: 44px; padding: 0; background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); cursor: pointer; transition: border-color .12s ease, background .12s ease; }
  .a2-grid-cell:hover { border-color: var(--a2-border-strong); background: var(--a2-surface-2); }
  .a2-grid-cell.selected { border-color: var(--a2-cyan); background: var(--a2-cyan-soft); }
  .a2-grid-cell-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--a2-cyan); box-shadow: 0 0 0 3px rgba(0,0,0,.25); }
  .a2-grid-picker-current { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }

  /* Categories tab (migrated from /admin/system/content-rules). The
     shared bulk-reposition classes above already cover the editor; the
     list + sheet-specific classes below mirror the legacy surface. */
  .a2-category-list { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-category-row { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-category-row[data-enabled="false"] { opacity: 0.6; }
  .a2-category-row-main { display: flex; align-items: center; gap: var(--a2-space-3); min-width: 0; }
  .a2-category-row-icon { font-size: 20px; }
  .a2-category-row-info { min-width: 0; }
  .a2-category-row-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-category-row-meta { display: flex; gap: var(--a2-space-1); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); flex-wrap: wrap; }
  .a2-category-row-actions { display: flex; align-items: center; gap: var(--a2-space-1); flex-shrink: 0; }
  .a2-reposition-hint { margin: 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-reposition-error { display: inline-flex; align-items: center; gap: var(--a2-space-1); margin: 0; padding: var(--a2-space-1) var(--a2-space-2); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-2xs); }
  .a2-sources-empty { margin: 0; padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-surface-2); border: 1px dashed var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text-muted); font-size: var(--a2-text-xs); }
  .a2-assigned-pos { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; border-radius: 999px; background: var(--a2-surface-3); color: var(--a2-text-dim); font-size: var(--a2-text-2xs); font-weight: 700; }
  .a2-assigned-spacer { flex: 1 1 auto; }
  .a2-inline-form { display: inline-flex; }
  .a2-assign-row { display: flex; align-items: flex-end; gap: var(--a2-space-2); flex-wrap: wrap; }
  .a2-assign-select { flex: 1 1 220px; }
  .a2-assign-row select { background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); padding: 8px 10px; min-height: 44px; }
  .a2-assign-row select:focus { outline: none; border-color: var(--a2-cyan); }
  .a2-assign-row .a2-btn-secondary { display: inline-flex; align-items: center; gap: var(--a2-space-1); }
  @media (max-width: 768px) { .a2-category-row { flex-direction: column; align-items: stretch; } .a2-category-row-actions { justify-content: flex-end; } }
</style>
