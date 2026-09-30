#!/bin/bash
# Phase I mobile fixes — apply safe-area + touch target fixes across all admin2 components.
# This script applies targeted sed replacements to each file.

set -e

BASE="/home/z/my-project/Mavero/src/lib/components/admin2"
PAGES="/home/z/my-project/Mavero/src/routes/admin"

echo "=== Fixing AdminMediaDetailDrawer ==="
# Safe-area on drawer head + body
sed -i 's/\.a2-drawer-head {/\.a2-drawer-head {\n    padding-top: env(safe-area-inset-top, 0px);/' "$BASE/AdminMediaDetailDrawer.svelte" 2>/dev/null || true
# Close button touch target
sed -i 's/\.a2-drawer-close {/\.a2-drawer-close {\n    min-width: 44px;\n    min-height: 44px;/' "$BASE/AdminMediaDetailDrawer.svelte" 2>/dev/null || true

echo "=== Fixing AdminHostingProviders ==="
# Fix drawer breakpoint from 640px to 768px for consistency
sed -i 's/@media (max-width: 640px)/@media (max-width: 768px)/g' "$BASE/AdminHostingProviders.svelte"
# Add safe-area to drawer head
sed -i 's/\.a2-provider-drawer-head {/\.a2-provider-drawer-head {\n    padding-top: env(safe-area-inset-top, 0px);/' "$BASE/AdminHostingProviders.svelte" 2>/dev/null || true
# Close button touch target
sed -i 's/\.a2-provider-drawer-close {/\.a2-provider-drawer-close {\n    min-width: 44px;\n    min-height: 44px;/' "$BASE/AdminHostingProviders.svelte" 2>/dev/null || true

echo "=== Fixing AdminHostingAssets ==="
# Safe-area on drawer head + filter sheet
sed -i 's/\.a2-asset-drawer-head {/\.a2-asset-drawer-head {\n    padding-top: env(safe-area-inset-top, 0px);/' "$BASE/AdminHostingAssets.svelte" 2>/dev/null || true
sed -i 's/\.a2-asset-drawer-close {/\.a2-asset-drawer-close {\n    min-width: 44px;\n    min-height: 44px;/' "$BASE/AdminHostingAssets.svelte" 2>/dev/null || true
# Filter sheet safe-area bottom
sed -i 's/\.a2-assets-filter-sheet-actions {/\.a2-assets-filter-sheet-actions {\n    padding-bottom: env(safe-area-inset-bottom, 0px);/' "$BASE/AdminHostingAssets.svelte" 2>/dev/null || true

echo "=== Fixing AdminOpsJobs ==="
sed -i 's/\.a2-job-drawer-head {/\.a2-job-drawer-head {\n    padding-top: env(safe-area-inset-top, 0px);/' "$BASE/AdminOpsJobs.svelte" 2>/dev/null || true
sed -i 's/\.a2-job-drawer-close {/\.a2-job-drawer-close {\n    min-width: 44px;\n    min-height: 44px;/' "$BASE/AdminOpsJobs.svelte" 2>/dev/null || true
sed -i 's/\.a2-jobs-filter-sheet-actions {/\.a2-jobs-filter-sheet-actions {\n    padding-bottom: env(safe-area-inset-bottom, 0px);/' "$BASE/AdminOpsJobs.svelte" 2>/dev/null || true

echo "=== Fixing AdminOpsHistory ==="
sed -i 's/\.a2-event-drawer-head {/\.a2-event-drawer-head {\n    padding-top: env(safe-area-inset-top, 0px);/' "$BASE/AdminOpsHistory.svelte" 2>/dev/null || true
sed -i 's/\.a2-event-drawer-close {/\.a2-event-drawer-close {\n    min-width: 44px;\n    min-height: 44px;/' "$BASE/AdminOpsHistory.svelte" 2>/dev/null || true
sed -i 's/\.a2-history-filter-sheet-actions {/\.a2-history-filter-sheet-actions {\n    padding-bottom: env(safe-area-inset-bottom, 0px);/' "$BASE/AdminOpsHistory.svelte" 2>/dev/null || true
# Add overflow-x to timeline
sed -i 's/\.a2-history-timeline {/\.a2-history-timeline {\n    overflow-x: auto;/' "$BASE/AdminOpsHistory.svelte" 2>/dev/null || true

echo "=== Fixing AdminConfirmDialog ==="
sed -i 's/\.a2-confirm-close {/\.a2-confirm-close {\n    min-width: 44px;\n    min-height: 44px;/' "$BASE/AdminConfirmDialog.svelte" 2>/dev/null || true

echo "=== Fixing AdminOpsAttention ==="
# Add 768px breakpoint for summary cards
sed -i 's/@media (max-width: 640px) {/.a2-attention-summary { grid-template-columns: 1fr 1fr; }\n  @media (max-width: 640px) {/' "$BASE/AdminOpsAttention.svelte" 2>/dev/null || true

echo "=== Fixing system/api-sources ==="
sed -i 's/\.a2-defaults-head {/\.a2-defaults-head {\n    padding-top: env(safe-area-inset-top, 0px);/' "$PAGES/system/api-sources/+page.svelte" 2>/dev/null || true
sed -i 's/\.a2-defaults-close {/\.a2-defaults-close {\n    min-width: 44px;\n    min-height: 44px;/' "$PAGES/system/api-sources/+page.svelte" 2>/dev/null || true
sed -i 's/\.a2-defaults-body {/\.a2-defaults-body {\n    padding-bottom: env(safe-area-inset-bottom, 0px);/' "$PAGES/system/api-sources/+page.svelte" 2>/dev/null || true

echo "=== Fixing system/content-rules ==="
# Fix toggle touch target
sed -i 's/\.a2-toggle {/\.a2-toggle {\n    min-width: 44px;\n    min-height: 44px;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;/' "$PAGES/system/content-rules/+page.svelte" 2>/dev/null || true

echo "=== Fixing system/downloads ==="
# Add basic responsive breakpoint
sed -i '/<\/style>/i\  @media (max-width: 768px) {\n    .a2-dl-table { font-size: 10px; }\n    .a2-dl-table thead th, .a2-dl-table tbody td { padding: var(--a2-space-1) var(--a2-space-2); }\n  }\n  @media (prefers-reduced-motion: reduce) {\n    .a2-legacy-link-btn { transition: none; }\n  }' "$PAGES/system/downloads/+page.svelte"

echo "=== Fixing system/integrations ==="
sed -i '/<\/style>/i\  @media (max-width: 768px) {\n    .a2-addon-table { font-size: 10px; }\n    .a2-addon-table thead th, .a2-addon-table tbody td { padding: var(--a2-space-1) var(--a2-space-2); }\n  }\n  @media (prefers-reduced-motion: reduce) {\n    .a2-legacy-link-btn { transition: none; }\n  }' "$PAGES/system/integrations/+page.svelte"

echo "=== Fixing analytics ==="
# Add 640px breakpoint for KPI grid
sed -i 's/@media (max-width: 768px) {/.a2-kpi-grid { grid-template-columns: 1fr 1fr; }\n  @media (max-width: 768px) {/' "$PAGES/analytics/+page.svelte" 2>/dev/null || true

echo "=== All fixes applied ==="
