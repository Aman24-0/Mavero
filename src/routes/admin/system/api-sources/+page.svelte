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
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatus from '$lib/components/admin2/AdminStatus.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import AdminFormSection from '$lib/components/admin/AdminFormSection.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddButton from '$lib/components/admin/AdminAddButton.svelte';
  import { SlidersHorizontal, X, Check, Server, HardDrive, Edit3, Trash2, Power } from 'lucide-svelte';
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
  import { CONTROLS_SIZE_MIN_PX, CONTROLS_SIZE_MAX_PX, BACK_CONTROL_DEFAULT_SIZE_PX, LANDSCAPE_CONTROL_DEFAULT_SIZE_PX, parsePlayerControlsPosition, controlsPreviewMarkerStyle, CONTROLS_PREVIEW_REFERENCE_PORTRAIT, CONTROLS_PREVIEW_REFERENCE_LANDSCAPE } from '$lib/shared/player-controls-position';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const VALID_TABS = new Set(['providers', 'sources']);
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

  function openCreateProvider(event?: Event) {
    if (event) providerSheetTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    editingProvider = null;
    providerSheetOpen = true;
  }
  function openEditProvider(provider: any, event?: Event) {
    if (event) providerSheetTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    editingProvider = provider;
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

  // --- Player Controls Position (per-source floating-control placement) ---
  // MAVP-2 contract: the Admin sheet edits TWO independent controls
  // ('landscape' = Landscape/fullscreen FAB group, 'back' = Back FAB), each
  // with an independent PORTRAIT and LANDSCAPE profile, each profile holding
  // an independent horizontal + vertical axis (anchor + offset). The sheet
  // serializes the draft into ONE hidden `controls_position_json` form field
  // (the stored shape verbatim); the server validates it strictly
  // (playerControlsPositionCapability). Legacy sources saved before MAVP-2
  // (base axes + orientation overrides for the Landscape control only) are
  // prefilled into the visible profiles on load; saving rewrites them as
  // explicit per-orientation profiles. Loading is TOTAL — malformed legacy
  // values degrade to the unset (default) state instead of throwing.
  type ControlsAxisDraft = { anchor: string; offset: string };
  type ControlsProfileDraft = { h: ControlsAxisDraft; v: ControlsAxisDraft };
  type ControlsControlDraft = { portrait: ControlsProfileDraft; landscape: ControlsProfileDraft };
  const emptyAxisDraft = (): ControlsAxisDraft => ({ anchor: '', offset: '' });
  const emptyProfileDraft = (): ControlsProfileDraft => ({ h: emptyAxisDraft(), v: emptyAxisDraft() });
  const emptyControlDraft = (): ControlsControlDraft => ({ portrait: emptyProfileDraft(), landscape: emptyProfileDraft() });

  let controlsPositionMode = $state('default');
  let positionDraft = $state<{ landscapeControl: ControlsControlDraft; back: ControlsControlDraft }>({
    landscapeControl: emptyControlDraft(),
    back: emptyControlDraft(),
  });
  // MAVP-3 Issue 5: independent per-control SIZE drafts (Back button,
  // Landscape button) in px. Empty string = default size (44/48 — the
  // player's stylesheet values). Sizes are orientation-independent and fully
  // independent of the placement axes: editing a size never touches any
  // anchor/offset draft and vice versa, and each control's size is its own.
  let controlsSizesDraft = $state<{ back: string; landscape: string }>({ back: '', landscape: '' });
  // Preview/calibration orientation — which orientation the preview stage and
  // its control markers are currently showing.
  let positionPreviewOrientation = $state<'portrait' | 'landscape'>('landscape');

  type LegacyAxisLike = { anchor?: unknown; offsetPercent?: unknown } | null | undefined;

  /** Total legacy-axis read: valid anchor enum + finite 0..100 offset, else unset. */
  function readLegacyAxis(axis: LegacyAxisLike, anchors: string[]): ControlsAxisDraft {
    if (!axis || typeof axis !== 'object') return emptyAxisDraft();
    const anchor = typeof axis.anchor === 'string' && anchors.includes(axis.anchor) ? axis.anchor : '';
    if (!anchor) return emptyAxisDraft();
    const offset = typeof axis.offsetPercent === 'number' && Number.isFinite(axis.offsetPercent) && axis.offsetPercent >= 0 && axis.offsetPercent <= 100
      ? String(axis.offsetPercent)
      : '';
    return { anchor, offset };
  }

  function loadControlsPositionState(source: any) {
    const raw = source?.capabilities?.player_controls_position;
    const custom = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.mode === 'custom' ? raw : null;
    controlsPositionMode = custom ? 'custom' : 'default';
    // MAVP-3 Issue 5: prefill the per-control size drafts from the stored
    // sizes section (valid bounded numbers only; anything else → default).
    const storedSizes = custom && typeof custom.sizes === 'object' && custom.sizes !== null && !Array.isArray(custom.sizes) ? custom.sizes : null;
    const readSizeDraft = (value: unknown): string =>
      typeof value === 'number' && Number.isFinite(value) && value >= CONTROLS_SIZE_MIN_PX && value <= CONTROLS_SIZE_MAX_PX ? String(value) : '';
    controlsSizesDraft = {
      back: readSizeDraft(storedSizes?.back),
      landscape: readSizeDraft(storedSizes?.landscape),
    };
    positionDraft = {
      // Landscape control: prefill each orientation profile from its stored
      // override, falling back to the LEGACY base axes (pre-MAVP-2 saves).
      landscapeControl: {
        portrait: {
          h: readLegacyAxis(custom?.portrait?.horizontal ?? custom?.horizontal, ['left', 'right', 'center']),
          v: readLegacyAxis(custom?.portrait?.vertical ?? custom?.vertical, ['top', 'bottom', 'center']),
        },
        landscape: {
          h: readLegacyAxis(custom?.landscape?.horizontal ?? custom?.horizontal, ['left', 'right', 'center']),
          v: readLegacyAxis(custom?.landscape?.vertical ?? custom?.vertical, ['top', 'bottom', 'center']),
        },
      },
      // Back control (MAVP-2): independent — never inherits the Landscape
      // control's stored axes.
      back: {
        portrait: {
          h: readLegacyAxis(custom?.back?.portrait?.horizontal, ['left', 'right', 'center']),
          v: readLegacyAxis(custom?.back?.portrait?.vertical, ['top', 'bottom', 'center']),
        },
        landscape: {
          h: readLegacyAxis(custom?.back?.landscape?.horizontal, ['left', 'right', 'center']),
          v: readLegacyAxis(custom?.back?.landscape?.vertical, ['top', 'bottom', 'center']),
        },
      },
    };
  }

  function resetControlProfile(control: 'landscapeControl' | 'back', orientation: 'portrait' | 'landscape') {
    positionDraft[control][orientation] = emptyProfileDraft();
  }

  /** MAVP-3 Issue 5: reset ONE control's size without touching any other
   *  setting (its placement profiles, its axes, and the other control's
   *  size all stay exactly as edited). */
  function resetControlSize(control: 'back' | 'landscape') {
    controlsSizesDraft = { ...controlsSizesDraft, [control]: '' };
  }

  function resetAllControlsPosition() {
    positionDraft = { landscapeControl: emptyControlDraft(), back: emptyControlDraft() };
    controlsSizesDraft = { back: '', landscape: '' };
    controlsPositionMode = 'default';
  }

  /** One axis object in the stored contract shape, or null when unset. */
  function serializeAxisDraft(axis: ControlsAxisDraft, anchors: string[]): { anchor: string; offsetPercent: number } | null {
    if (!axis.anchor || !anchors.includes(axis.anchor)) return null;
    const raw = String(axis.offset ?? '').trim();
    let offsetPercent: number;
    if (!raw) {
      offsetPercent = axis.anchor === 'center' ? 50 : 0; // anchor-default semantics, mirrors the server
    } else {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null; // invalid input → axis unset (server re-validates authoritatively)
      offsetPercent = Math.round(parsed * 10) / 10;
    }
    return { anchor: axis.anchor, offsetPercent };
  }

  /**
   * MAVP-3 Issue 5: one control's size in the stored contract shape, or null
   * when unset/invalid. Mirrors the axis precedent: an invalid non-empty
   * value serializes as unset here (the server re-validates authoritatively
   * for direct API callers; the inputs carry min/max for interactive guardrails).
   */
  function serializeSizeDraft(raw: string): number | null {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < CONTROLS_SIZE_MIN_PX || parsed > CONTROLS_SIZE_MAX_PX) return null;
    return Math.round(parsed);
  }

  /** MAVP-3 Issue 5: the active size draft for the calibration preview markers. */
  function previewMarkerSize(control: 'back' | 'landscape'): number | null {
    return serializeSizeDraft(controlsSizesDraft[control]);
  }

  /**
   * Serialize the draft into the `controls_position_json` payload — the
   * EXACT stored contract shape. Unset axes/sections/sizes are omitted; custom
   * mode with no usable axis or size at all serializes as 'default' (the server's
   * "at least one anchor" rule then never rejects a UI-driven save).
   */
  const controlsPositionJson = $derived.by(() => {
    if (controlsPositionMode !== 'custom') return JSON.stringify({ mode: 'default' });
    const landscapeControl = {
      portrait: {
        horizontal: serializeAxisDraft(positionDraft.landscapeControl.portrait.h, ['left', 'right', 'center']),
        vertical: serializeAxisDraft(positionDraft.landscapeControl.portrait.v, ['top', 'bottom', 'center']),
      },
      landscape: {
        horizontal: serializeAxisDraft(positionDraft.landscapeControl.landscape.h, ['left', 'right', 'center']),
        vertical: serializeAxisDraft(positionDraft.landscapeControl.landscape.v, ['top', 'bottom', 'center']),
      },
    };
    const back = {
      portrait: {
        horizontal: serializeAxisDraft(positionDraft.back.portrait.h, ['left', 'right', 'center']),
        vertical: serializeAxisDraft(positionDraft.back.portrait.v, ['top', 'bottom', 'center']),
      },
      landscape: {
        horizontal: serializeAxisDraft(positionDraft.back.landscape.h, ['left', 'right', 'center']),
        vertical: serializeAxisDraft(positionDraft.back.landscape.v, ['top', 'bottom', 'center']),
      },
    };
    const payload: Record<string, unknown> = { mode: 'custom' };
    const lcPortrait: Record<string, unknown> = {};
    const lcLandscape: Record<string, unknown> = {};
    if (landscapeControl.portrait.horizontal || landscapeControl.portrait.vertical) lcPortrait.portrait = Object.fromEntries(Object.entries(landscapeControl.portrait).filter(([, v]) => v !== null));
    if (landscapeControl.landscape.horizontal || landscapeControl.landscape.vertical) lcLandscape.landscape = Object.fromEntries(Object.entries(landscapeControl.landscape).filter(([, v]) => v !== null));
    if (lcPortrait.portrait) payload.portrait = lcPortrait.portrait;
    if (lcLandscape.landscape) payload.landscape = lcLandscape.landscape;
    const backOut: Record<string, unknown> = {};
    if (back.portrait.horizontal || back.portrait.vertical) backOut.portrait = Object.fromEntries(Object.entries(back.portrait).filter(([, v]) => v !== null));
    if (back.landscape.horizontal || back.landscape.vertical) backOut.landscape = Object.fromEntries(Object.entries(back.landscape).filter(([, v]) => v !== null));
    if (Object.keys(backOut).length) payload.back = backOut;
    // MAVP-3 Issue 5: independent per-control sizes — serialized ONLY when at
    // least one is set; each entry stands alone (one control's size never
    // carries or resets the other's).
    const backSize = serializeSizeDraft(controlsSizesDraft.back);
    const landscapeSize = serializeSizeDraft(controlsSizesDraft.landscape);
    if (backSize !== null || landscapeSize !== null) payload.sizes = { ...(backSize !== null ? { back: backSize } : {}), ...(landscapeSize !== null ? { landscape: landscapeSize } : {}) };
    if (Object.keys(payload).length === 1) return JSON.stringify({ mode: 'default' });
    return JSON.stringify(payload);
  });

  /**
   * MAVP-4 Issue 3: the preview interprets the configuration EXACTLY like the
   * runtime player. The serialized draft payload (the same string the form
   * submits) is parsed by the REAL shared total parser
   * (`parsePlayerControlsPosition`) and both markers are styled by the
   * SHARED `controlsPreviewMarkerStyle` resolver — inheritance (per-
   * orientation overrides falling back to prefill), unset axes (the
   * control's stylesheet default corner, scaled), configured sizes, and
   * resets all render through ONE code path with the runtime.
   * Malformed values degrade to the default positioning through the parser
   * (never a plausible-looking but wrong preview — an unparseable payload
   * simply shows the default corners).
   */
  const previewPosition = $derived.by(() => {
    try {
      return parsePlayerControlsPosition(JSON.parse(controlsPositionJson));
    } catch {
      return null;
    }
  });

  /** Shared-resolver inline styles for the two preview markers. */
  const previewBackStyle = $derived(controlsPreviewMarkerStyle(previewPosition, 'back', positionPreviewOrientation));
  const previewLandscapeStyle = $derived(controlsPreviewMarkerStyle(previewPosition, 'landscape', positionPreviewOrientation));

  // Section template loops (typed so the per-control reset + bindings stay
  // literal-union safe).
  const POSITION_ORIENTATIONS: Array<'portrait' | 'landscape'> = ['portrait', 'landscape'];
  const POSITION_CONTROLS: Array<{ id: 'landscapeControl' | 'back'; title: string }> = [
    { id: 'landscapeControl', title: 'Landscape button' },
    { id: 'back', title: 'Back button' },
  ];

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

  // --- Helpers ---
  function statusTone(status: string): 'good' | 'warn' | 'bad' | 'neutral' {
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

  const tabs = [
    { id: 'providers', label: 'Providers' },
    { id: 'sources', label: 'Sources' },
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
      {:else}
        <AdminAddButton label="Add source" onclick={openCreateSource} />
      {/if}
    {/snippet}

    {#snippet description()}
      <p>Manage playback providers, sources, and default source configuration. All CRUD operations are available directly in this workspace.</p>
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
                <span class="a2-provider-row-icon">{provider.icon ?? '🔧'}</span>
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
      {:else}
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
        <p class="a2-sheet-desc">Configure which source is preferred for each content type.</p>
        {#each CONTENT_TYPES as ct}
          {@const def = defaultForType(ct.type)}
          <div class="a2-default-row">
            <div class="a2-default-row-label">
              <span class="a2-default-row-type">{ct.label}</span>
              <span class="a2-default-row-current">
                {#if def?.source_id}Current: <strong>{sourceName(def.source_id)}</strong>{:else}<span class="a2-default-row-none">No default set</span>{/if}
              </span>
            </div>
            <div class="a2-default-row-control">
              <form method="POST" action="?/saveDefault" style="display:flex; gap:4px; flex:1;">
                <input type="hidden" name="content_type" value={ct.type} />
                <select name="source_id" class="a2-default-select">
                  <option value="">— Select —</option>
                  {#each data.sources as source (source.id)}
                    {@const eligible = isSourceEligible(source)}
                    <option value={source.id} selected={def?.source_id === source.id} disabled={!eligible}>
                      {source.name}{#if !eligible} (ineligible){/if}
                    </option>
                  {/each}
                </select>
                <button type="submit" class="a2-default-save">Save</button>
                {#if def?.source_id}
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
    <form method="POST" action={editingProvider ? '?/updateProvider' : '?/createProvider'} class="a2-crud-form">
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
        <label class="a2-field"><span>Icon URL</span><input name="icon" type="url" value={editingProvider?.icon ?? ''} placeholder="https://example.com/icon.svg" /></label>
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
        </div>
        <label class="a2-field"><span>Visibility</span>
          <select name="visibility">
            <option value="public" selected={editingSource?.visibility === 'public'}>Public</option>
            <option value="internal" selected={editingSource?.visibility === 'internal'}>Internal</option>
            <option value="hidden" selected={editingSource?.visibility === 'hidden'}>Hidden</option>
          </select>
        </label>
        <label class="a2-field"><span>Ordering</span><input type="number" name="ordering" value={editingSource?.ordering ?? 0} /></label>
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
        <p class="a2-field-hint">Position the MAVERO floating controls per source. Each control has an independent portrait and landscape profile; each profile has an independent horizontal and vertical axis. Percentages are viewport-relative (0–100), measured from the anchor edge toward the centre. Each control also has an independent size ({CONTROLS_SIZE_MIN_PX}–{CONTROLS_SIZE_MAX_PX} px; empty = default: Back {BACK_CONTROL_DEFAULT_SIZE_PX} px, Landscape {LANDSCAPE_CONTROL_DEFAULT_SIZE_PX} px). Sources without a custom placement use the defaults: Landscape button bottom-right, Back button top-left. To inspect a saved placement in the running player, open any title's watch URL with <code>?controls=calibrate</code> appended — the player then holds the controls visible for that calibration session only (normal playback keeps the 5s auto-hide).</p>
        <input type="hidden" name="controls_position_json" value={controlsPositionJson} />
        <label class="a2-field"><span>Position Mode</span>
          <select name="controls_position_mode" bind:value={controlsPositionMode}>
            <option value="default">Default — stylesheet corners</option>
            <option value="custom">Custom — manual placement</option>
          </select>
        </label>
        {#if controlsPositionMode === 'custom'}
          {#each POSITION_ORIENTATIONS as orientation}
            <div class="a2-position-orientation-block">
              <span class="a2-position-axis-label">{orientation === 'portrait' ? 'Portrait configuration' : 'Landscape configuration'}</span>
              {#each POSITION_CONTROLS as control}
                <div class="a2-position-control-group">
                  <div class="a2-position-control-head">
                    <span class="a2-position-control-title">{control.title} — {orientation === 'portrait' ? 'Portrait' : 'Landscape'}</span>
                    <button type="button" class="a2-btn-mini" onclick={() => resetControlProfile(control.id, orientation)}>Reset</button>
                  </div>
                  <div class="a2-position-grid">
                    <label class="a2-field"><span>H anchor</span>
                      <select bind:value={positionDraft[control.id][orientation].h.anchor}>
                        <option value="">Default</option>
                        <option value="right">From right</option>
                        <option value="left">From left</option>
                        <option value="center">Centered</option>
                      </select>
                    </label>
                    <label class="a2-field"><span>H offset %</span>
                      <input type="number" min="0" max="100" step="0.5" bind:value={positionDraft[control.id][orientation].h.offset} disabled={!positionDraft[control.id][orientation].h.anchor || positionDraft[control.id][orientation].h.anchor === 'center'} />
                    </label>
                    <label class="a2-field"><span>V anchor</span>
                      <select bind:value={positionDraft[control.id][orientation].v.anchor}>
                        <option value="">Default</option>
                        <option value="bottom">From bottom</option>
                        <option value="top">From top</option>
                        <option value="center">Centered</option>
                      </select>
                    </label>
                    <label class="a2-field"><span>V offset %</span>
                      <input type="number" min="0" max="100" step="0.5" bind:value={positionDraft[control.id][orientation].v.offset} disabled={!positionDraft[control.id][orientation].v.anchor || positionDraft[control.id][orientation].v.anchor === 'center'} />
                    </label>
                  </div>
                </div>
              {/each}
            </div>
          {/each}
          <!-- MAVP-3 Issue 5: independent per-control SIZE settings. Sizes are
               orientation-independent (one size per control per source) and
               fully independent of the placement profiles above: editing a
               size never mutates any anchor/offset and vice versa. Empty =
               the control's default stylesheet size. -->
          <div class="a2-position-orientation-block">
            <span class="a2-position-axis-label">Control size (both orientations)</span>
            {#each POSITION_CONTROLS as control}
              <div class="a2-position-control-group">
                <div class="a2-position-control-head">
                  <span class="a2-position-control-title">{control.title} size (px, {CONTROLS_SIZE_MIN_PX}–{CONTROLS_SIZE_MAX_PX}{control.id === 'back' ? `, default ${BACK_CONTROL_DEFAULT_SIZE_PX}` : `, default ${LANDSCAPE_CONTROL_DEFAULT_SIZE_PX}`})</span>
                  <button type="button" class="a2-btn-mini" onclick={() => resetControlSize(control.id === 'back' ? 'back' : 'landscape')}>Reset size</button>
                </div>
                <div class="a2-position-grid">
                  <label class="a2-field"><span>Size px</span>
                    <input type="number" min={CONTROLS_SIZE_MIN_PX} max={CONTROLS_SIZE_MAX_PX} step="1" bind:value={controlsSizesDraft[control.id === 'back' ? 'back' : 'landscape']} placeholder="default" />
                  </label>
                </div>
              </div>
            {/each}
          </div>
          <!-- Calibration preview (MAVP-4 Issue 3): the orientation toggle
               switches the stage between the two documented REFERENCE
               viewports (landscape 844×390, portrait 390×844 — the same
               shapes the runtime viewport takes). Both markers are styled by
               the SHARED resolver (player-controls-position.ts) over the
               exact payload the form submits, so configured anchors,
               offsets, inheritance, defaults, resets and SIZES render
               identically (scaled) to the real player. The square marker is
               the Back button, the round dot the Landscape control group,
               the dashed corner marker the provider's typical fullscreen
               control position for reference. -->
          <div class="a2-position-preview-orientation" role="group" aria-label="Preview orientation">
            <button type="button" class:active={positionPreviewOrientation === 'landscape'} onclick={() => (positionPreviewOrientation = 'landscape')}>Landscape preview</button>
            <button type="button" class:active={positionPreviewOrientation === 'portrait'} onclick={() => (positionPreviewOrientation = 'portrait')}>Portrait preview</button>
          </div>
          <div class="a2-position-preview" class:portrait={positionPreviewOrientation === 'portrait'} role="img" aria-label={`Preview of the floating-control placement in ${positionPreviewOrientation} orientation`}>
            <span class="a2-position-preview-provider" aria-hidden="true"></span>
            <span class="a2-position-preview-back" aria-hidden="true" style={previewBackStyle}></span>
            <span class="a2-position-preview-dot" aria-hidden="true" style={previewLandscapeStyle}></span>
            <span class="a2-position-preview-caption" aria-hidden="true">{positionPreviewOrientation} preview · back {previewMarkerSize('back') ?? BACK_CONTROL_DEFAULT_SIZE_PX}px · landscape {previewMarkerSize('landscape') ?? LANDSCAPE_CONTROL_DEFAULT_SIZE_PX}px · scaled from {positionPreviewOrientation === 'portrait' ? `${CONTROLS_PREVIEW_REFERENCE_PORTRAIT.width}×${CONTROLS_PREVIEW_REFERENCE_PORTRAIT.height}` : `${CONTROLS_PREVIEW_REFERENCE_LANDSCAPE.width}×${CONTROLS_PREVIEW_REFERENCE_LANDSCAPE.height}`} reference</span>
          </div>
          <button type="button" class="a2-btn-secondary" onclick={resetAllControlsPosition}>Reset all positioning</button>
        {/if}
      </AdminFormSection>
      <div class="a2-form-actions">
        <button type="submit" class="a2-btn-primary">{editingSource ? 'Save' : 'Create'}</button>
        <button type="button" class="a2-btn-secondary" onclick={closeSourceSheet}>Cancel</button>
      </div>
    </form>
  </AdminSheet>
{/if}

<style>
  .a2-notice { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-sm); }
  .a2-form-error { padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-sm); }
  .a2-defaults-btn { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-4); background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; }
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
  .a2-icon-editor { display: flex; align-items: center; gap: var(--a2-space-2); }
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
  .a2-position-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--a2-space-2); align-items: end; }
  .a2-position-axis-label { font-size: var(--a2-text-2xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--a2-text-dim); padding-top: var(--a2-space-2); }
  .a2-position-orientation-block { display: flex; flex-direction: column; gap: var(--a2-space-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); padding: var(--a2-space-2) var(--a2-space-3); }
  .a2-position-control-group { display: flex; flex-direction: column; gap: var(--a2-space-1); }
  .a2-position-control-head { display: flex; align-items: center; justify-content: space-between; gap: var(--a2-space-2); }
  .a2-position-control-title { font-size: var(--a2-text-2xs); font-weight: 600; color: var(--a2-text-muted); }
  .a2-btn-mini { padding: 4px 10px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text-muted); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; }
  .a2-btn-mini:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .a2-position-preview-orientation { display: inline-flex; gap: 6px; }
  .a2-position-preview-orientation button { padding: 6px 12px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text-muted); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; }
  .a2-position-preview-orientation button.active { color: var(--a2-cyan); border-color: var(--a2-cyan-border); background: var(--a2-cyan-soft); }
  /* MAVP-4 Issue 3: the preview stages are SCALED REFERENCE VIEWPORTS —
     portrait 390×844, landscape 844×390 (the shared contract's documented
     references, same aspect ratio as the modelled runtime viewport so
     viewport-relative % map 1:1). `container-type: size` makes the stage a
     query container so marker sizes/defaults render in cqw/cqh — uniformly
     scaled by the shared geometry helper instead of treating preview pixels
     as runtime pixels. Both markers are ALWAYS explicitly positioned by the
     shared resolver (no auto-position pile-up in either orientation). */
  .a2-position-preview { position: relative; container-type: size; aspect-ratio: 844 / 390; border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); background: linear-gradient(160deg, #0c0c14, #16161f); overflow: hidden; }
  .a2-position-preview.portrait { aspect-ratio: 390 / 844; max-width: 220px; margin: 0 auto; }
  .a2-position-preview-provider { position: absolute; right: 8%; bottom: 10%; width: 18px; height: 10px; border: 1px dashed rgba(255,255,255,.35); border-radius: 2px; }
  .a2-position-preview-dot { position: absolute; border-radius: 50%; background: var(--a2-cyan); box-shadow: 0 0 0 4px rgba(0,0,0,.35), 0 0 10px var(--a2-cyan); }
  .a2-position-preview-back { position: absolute; border-radius: 4px; background: var(--a2-green, #7ee2a8); box-shadow: 0 0 0 4px rgba(0,0,0,.35), 0 0 10px var(--a2-green, #7ee2a8); }
  .a2-position-preview-caption { position: absolute; left: 8px; top: 6px; font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.45); }

  @media (max-width: 768px) {
    .a2-sheet { max-width: 100%; }
    .a2-provider-row, .a2-source-row { flex-direction: column; align-items: stretch; }
    .a2-provider-row-actions, .a2-source-row-actions { justify-content: flex-end; }
    .a2-default-row-control { flex-wrap: wrap; }
  }
</style>
