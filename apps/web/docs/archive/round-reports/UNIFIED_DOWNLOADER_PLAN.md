# MAVERO — Unified Downloader + Global Source Ordering (FINAL TASK plan)

Surgical consolidation task (not a phase system — the Permanent Adapter Plan is
COMPLETE per the worklog). Scope: ONE user-facing downloader, ONE global source
order spanning Add-ons + Plugins, admin position control for extensions, the
provider-dropdown icon-alignment fix, and retirement of the user-facing
`mavero-downloader-2` entry.

Verified startup state (live + HEAD e53a5ec):
- live `download_providers`: 11 rows; `mavero-downloader` (default, ord 90),
  `mavero-downloader-2` (enabled, ord 92) — both special-cased in DownloadSheet.
- live `streaming_addons`: 10 rows, dense ordering 0..9 (PenguPlay…FebBox).
- live `cloudstream_extensions`: 5 rows, 2 enabled (Bollyflix + MoviesDrive,
  native adapters). No ordering column exists.
- No global-ordering table exists (probe: count=null for all candidates).
- `set_addon_position` RPC exists live; PGlite is available for migration
  verification; NO Management-API PAT in this environment (DDL → owner action).

## Architecture decisions

1. **Unified panel** — new `MaveroUnifiedDownload.svelte` rendered by
   DownloadSheet for slug `mavero-downloader` (replaces MaveroAddonDownload
   inline). It owns ONE chip rail: green (`--accent`) add-on chips + blue
   (`--accent-2`) plugin chips, ordered by the global position. Resolution
   mechanics stay SEPARATE per kind (PART D): add-on chips → existing
   `/api/downloader/mavero/addon` per-source fetches; plugin chips → existing
   ONE-batch `/api/downloader/mavero2` + `/extension` retry. No Builder in
   runtime (unchanged). MaveroAddonDownload + MaveroCloudStreamDownload stay
   as reusable components (standalone pages + pinned tests) — not deleted.

2. **Unified sources endpoint** — `GET /api/downloader/mavero/sources`
   composes `listAddonDownloadTargets` + `listCloudStreamDownloadTabs`, merges
   with the global order, returns ONE list
   `{ kind: 'addon'|'plugin', id, name, position }`. Existing tab endpoints
   stay unchanged (back-compat).

3. **Global ordering data model** (PART H, minimal): new table
   `downloader_source_order(source_key text pk, position int ≥ 1, updated_at)`
   + `set_downloader_source_position(text, int)` RPC (atomic move + dense
   renumber + streaming_addons.ordering sync, advisory-locked, admin-gated).
   Keys: `addon:<uuid>` / `extension:<canonicalAdapterKey>` (type-aware,
   collision-free, matches the tabs' dedup identity).
   Deterministic read rule (never insertion order): positioned sources by
   position → unpositioned add-ons (ordering, name) → unpositioned extensions
   (catalog order). Addon moves sync `streaming_addons.ordering` (single
   source of truth for the legacy readers).
   Backfill (first-run only, table empty): all add-ons by current order, then
   all enabled extensions by catalog order — preserves the live add-on order.
   Missing-table degradation: reader falls back to the deterministic rule;
   addon position-set falls back to the legacy `set_addon_position` RPC;
   extension position-set returns an honest error. Zero regression
   pre-migration.

4. **Retirement** (PART E): migration sets `enabled = false` on the
   `mavero-downloader-2` row (idempotent, data preserved). DownloadSheet loses
   the special-casing branch. Standalone `/watch/mavero-downloader-2/**`
   pages stay (reusable, graceful if ever re-enabled). Provider constant +
   origin-rewrite stay (harmless back-compat).

5. **Admin** (PART G/I): tabs stay separate. Extension rows gain
   `Position: [N] Set Position` (fetch-based via the existing admin extensions
   API, new `setPosition` action → `setSourcePosition('extension:<key>')`).
   The add-on detail-sheet position control now moves the GLOBAL position
   (global RPC; legacy fallback pre-migration). Position values shown are
   global ranks (1-based).

6. **Dropdown fix** (PART J): `.dl-dropdown-item` drops
   `justify-content: space-between`; `.dl-item-name` gets `flex:1; min-width:0`
   (icon+title adjacent, badge pushed via margin-left:auto). Shared layout —
   all providers fixed.

## Files

NEW:
- supabase/migrations/20261004000000_unified_downloader_global_order.sql
- src/lib/shared/unified-downloader.ts (types + PURE rank/merge)
- src/lib/server/downloader/source-order.ts (order read + position set)
- src/routes/api/downloader/mavero/sources/+server.ts
- src/lib/components/MaveroUnifiedDownload.svelte
- scripts/unified_downloader_test.ts (registered in the pnpm chain)

MODIFIED:
- DownloadSheet.svelte (unified panel for mavero-downloader; remove
  downloader-2 branch; dropdown CSS fix)
- watch/mavero-downloader/{movie,tv} pages (render the unified panel)
- cloudstream/extensions/service.ts (+ setExtensionPosition, positions in view)
- api/admin/integrations/cloudstream/extensions/+server.ts (+ setPosition)
- AdminCloudStreamManager.svelte (position control)
- admin/system/integrations/+page.server.ts (global position load + action)
- admin/system/integrations/+page.svelte (addon detail: global position)
- stremio/admin-addons.ts (position action → global ordering; list enrich)
- package.json (test chain)

## Gates

pnpm check 0/0 · full chain + new suite ALL GREEN · build PASS · responsive
Chromium audit (390/412/768/1280) · live read-only verification · worklog.
