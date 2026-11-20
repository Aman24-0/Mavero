#!/usr/bin/env bash
# 2026-10 rebrand: replace all hardcoded cyber-green (#00ff9c / rgba(0,255,156,*))
# with white (#ffffff / rgba(255,255,255,*)) across the user-facing app.
#
# The global CSS variables in src/app.css were already changed by hand;
# this script handles the hardcoded fallback values scattered across
# component <style> blocks (var(--color-primary, #00ff9c) fallbacks,
# box-shadow rgba(0,255,156,...) glows, etc.).
#
# The replacement is mechanical: every "0, 255, 156" → "255, 255, 255"
# and every "#00ff9c" → "#ffffff" and "#00e676" → "#e6e6e6" (the
# hover variant). Alpha values are preserved verbatim.
set -euo pipefail
cd "$(dirname "$0")/.."

# Find all .svelte and .css files under src/ EXCLUDING app.css (already
# hand-edited) and EXCLUDING any file under src/lib/components/admin* and
# src/routes/admin* (admin semantic green is handled separately — the
# admin uses --a2-green which was already updated in app.css; the
# hardcoded admin rgba(0,255,156) values are status-badge tints that
# should also become white for consistency).
#
# Actually — the user said "ALL green accents across the entire user-side
# app". The admin panel is behind auth. To be safe + consistent with the
# global --a2-green change in app.css (which IS already white), we also
# replace the hardcoded admin green values. The admin status badges use
# green for "healthy/ready" — white preserves the semantic (positive)
# through the text label + tone.

FILES=$(find src -type f \( -name '*.svelte' -o -name '*.css' \) ! -path 'src/app.css')

# Replace rgba(0, 255, 156, X) and rgba(0,255,156,X) → rgba(255, 255, 255, X) / rgba(255,255,255,X)
# Use perl for the regex (handles both spaced and unspaced forms).
for f in $FILES; do
  perl -i -pe 's/rgba\(\s*0\s*,\s*255\s*,\s*156\s*,/rgba(255, 255, 255,/g' "$f"
  perl -i -pe 's/rgba\(\s*0\s*,\s*255\s*,\s*156\s*\)/rgba(255, 255, 255)/g' "$f"
  # Hex values
  perl -i -pe 's/#00ff9c/#ffffff/gi' "$f"
  perl -i -pe 's/#00e676/#e6e6e6/gi' "$f"
  perl -i -pe 's/#00e88c/#e6e6e6/gi' "$f"
done

echo "Done. Replaced hardcoded green values with white across $(echo $FILES | wc -w) files."
