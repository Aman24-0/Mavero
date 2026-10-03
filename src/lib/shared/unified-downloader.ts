// MAVERO unified downloader — shared source model + PURE ordering helpers.
//
// FINAL TASK (unified Mavero Downloader): the single source of truth for the
// user-facing merged source list:
//
//     Mavero Downloader
//       ├── Add-on sources   (Stremio — resolved via /api/downloader/mavero/**)
//       └── Plugin sources   (CloudStream/Nuvio — resolved via /api/downloader/mavero2/**)
//
// This module is intentionally framework-free (no SvelteKit, no Supabase
// imports) so the same pure ranking logic runs on the server (the
// /api/downloader/mavero/sources endpoint), in tests, and is referenced
// indirectly by the browser via the typed payloads.
//
// DESIGN (task PART F/H):
//   * ONE GLOBAL ordering namespace spans BOTH source kinds:
//       addon:<uuid>             (Stremio add-on row id)
//       extension:<canonicalKey> (the type-aware canonical adapter key, e.g.
//                                 'cloudstream:bollyflix' or
//                                 'nuvio:moviesdrive' — the SAME identity the
//                                 CloudStream eligibility selection uses for
//                                 cross-repository dedup, so one user-visible
//                                 source has exactly ONE ordering key)
//   * The user-facing order is ALWAYS computed from persisted ordering data
//     (the downloader_source_order table) + deterministic fallbacks — never
//     array index, repository insertion order, or unordered SQL results.
//   * Fallback rule (deterministic, documented, tested):
//       1. sources WITH an ordering row → ascending position;
//       2. add-ons WITHOUT a row → their streaming_addons ordering, then name;
//       3. extensions WITHOUT a row → catalog order (repository creation →
//          internal name — the order the /tabs endpoint already emits).
//

/** The source kind the unified downloader renders. */
export type UnifiedSourceKind = 'addon' | 'plugin';

/**
 * One user-facing source in the unified Mavero Downloader.
 * `position` is the GLOBAL 1-based rank (spans both kinds).
 */
export type UnifiedSourceView = {
  kind: UnifiedSourceKind;
  /**
   * The identity the RESOLUTION flow uses: the add-on UUID (addon kind) or
   * the extension adapter id the /mavero2 tabs payload exposes (the value
   * passed to /mavero2/extension for per-source retry).
   */
  id: string;
  /** Display name (addonName / extensionName). */
  name: string;
  /** Global 1-based position (rank). Dense 1..N for a given source list. */
  position: number;
};

/** The persisted ordering row projection (source_key → position). */
export type SourceOrderEntry = {
  sourceKey: string;
  position: number;
};

/**
 * Builds the global ordering key for an add-on source.
 * The add-on id is the streaming_addons UUID (stable across manifests).
 */
export function addonOrderKey(addonId: string): string {
  return `addon:${addonId}`;
}

/**
 * Builds the global ordering key for an extension source from its canonical
 * adapter key ('cloudstream:bollyflix' / 'nuvio:moviesdrive'). The SERVER
 * derives canonical keys from catalog rows (canonicalAdapterKeyForRow); the
 * browser never constructs these keys.
 */
export function extensionOrderKey(canonicalAdapterKey: string): string {
  return `extension:${canonicalAdapterKey}`;
}

/** The add-on tab input shape the ranking function consumes. */
export type RankAddonTab = { addonId: string; addonName: string };

/**
 * The extension tab input shape the ranking function consumes.
 * `canonicalKey` is derived server-side from the catalog row; `extensionId`
 * is the public adapter identity (bare internal name for native adapters,
 * canonical key for generated adapters) — they legitimately differ.
 */
export type RankExtensionTab = { extensionId: string; extensionName: string; canonicalKey: string };

/**
 * Ranks the merged source list into ONE deterministic global order.
 *
 * Inputs (both ALREADY deterministically ordered by their own endpoints —
 * add-ons by (ordering, name), extensions by catalog order):
 *   - addonTabs:     the /api/downloader/mavero/tabs payload tabs
 *   - extensionTabs: the /api/downloader/mavero2/tabs payload tabs + canonical keys
 *   - orderEntries:  the persisted downloader_source_order rows
 *
 * Rule (deterministic — never relies on raw array identity beyond the
 * documented per-kind orders):
 *   1. every source whose ordering key appears in `orderEntries`, sorted by
 *      ascending position (ties broken by the documented per-kind order —
 *      defensive; the RPC keeps positions dense);
 *   2. unpositioned add-ons in their tab order (ordering, then name);
 *   3. unpositioned extensions in their tab order (catalog order).
 *
 * The result carries dense global positions 1..N.
 */
export function rankUnifiedSources(
  addonTabs: ReadonlyArray<RankAddonTab>,
  extensionTabs: ReadonlyArray<RankExtensionTab>,
  orderEntries: ReadonlyArray<SourceOrderEntry>,
): UnifiedSourceView[] {
  const positions = new Map<string, number>();
  for (const entry of orderEntries) {
    if (typeof entry.sourceKey !== 'string' || entry.sourceKey.length === 0) continue;
    if (!Number.isFinite(entry.position)) continue;
    if (positions.has(entry.sourceKey)) continue; // defensive: first row wins
    positions.set(entry.sourceKey, entry.position);
  }

  const addonPositioned: Array<{ view: UnifiedSourceView; position: number; order: number }> = [];
  const addonUnpositioned: UnifiedSourceView[] = [];
  addonTabs.forEach((tab, index) => {
    const key = addonOrderKey(tab.addonId);
    const position = positions.get(key);
    const view: UnifiedSourceView = { kind: 'addon', id: tab.addonId, name: tab.addonName, position: 0 };
    if (position === undefined) {
      addonUnpositioned.push(view);
      return;
    }
    addonPositioned.push({ view, position, order: index });
  });

  const extensionPositioned: Array<{ view: UnifiedSourceView; position: number; order: number }> = [];
  const extensionUnpositioned: UnifiedSourceView[] = [];
  extensionTabs.forEach((tab, index) => {
    const key = extensionOrderKey(tab.canonicalKey);
    const position = positions.get(key);
    const view: UnifiedSourceView = { kind: 'plugin', id: tab.extensionId, name: tab.extensionName, position: 0 };
    if (position === undefined) {
      extensionUnpositioned.push(view);
      return;
    }
    extensionPositioned.push({ view, position, order: index });
  });

  const positioned = [...addonPositioned, ...extensionPositioned].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    if (a.order !== b.order) return a.order - b.order;
    return a.view.name.localeCompare(b.view.name, undefined, { sensitivity: 'base' });
  });

  const merged: UnifiedSourceView[] = [
    ...positioned.map((entry) => entry.view),
    ...addonUnpositioned,
    ...extensionUnpositioned,
  ];
  return merged.map((view, index) => ({ ...view, position: index + 1 }));
}

/**
 * Sorts a resolved unified source list by global position (the client-side
 * mirror of the server ranking — kept here so tests exercise the exact
 * ordering semantics the UI applies when a late response reorders sources).
 */
export function sortUnifiedSources(sources: ReadonlyArray<UnifiedSourceView>): UnifiedSourceView[] {
  return [...sources].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    if (a.kind !== b.kind) return a.kind === 'addon' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/** The stable slug of the unified user-facing downloader provider. */
export const UNIFIED_DOWNLOADER_PROVIDER_ID = 'mavero-downloader';

/**
 * The `/api/downloader/mavero/sources` payload body (ok envelope).
 * `sources` is the merged, globally ranked list — both kinds interleaved.
 */
export type UnifiedSourcesPayload = {
  ok: true;
  sources: UnifiedSourceView[];
  /** Number of add-ons considered (the addon tabs baseline). */
  consideredAddons: number;
  /** Number of extensions considered (repo-enabled + extension-enabled). */
  consideredExtensions: number;
};
