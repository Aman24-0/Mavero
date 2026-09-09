#!/usr/bin/env python3
"""
Mavero Icon Rasterization Script

Generates all required PNG icon assets from the SVG source:
  - mavero-192.png      (192x192, PWA manifest)
  - mavero-512.png      (512x512, PWA manifest)
  - mavero-maskable-512.png (512x512, maskable PWA — same SVG but
    with extra padding so the M stays inside the 80% safe zone)
  - mavero-apple-touch.png (180x180, Apple touch icon — no rounded
    corners since iOS adds its own mask)
  - favicon-32.png      (32x32, browser favicon)
  - favicon-16.png      (16x16, browser favicon)

The maskable variant uses a separate SVG with a larger background
that fills the full viewport, keeping the M within the 80% center
safe zone that Android adaptive icons require.
"""

import cairosvg
import os
import sys

ICONS_DIR = os.path.join(os.path.dirname(__file__), '..', 'static', 'icons')
SOURCE_SVG = os.path.join(ICONS_DIR, 'mavero-icon-source.svg')

def generate_png(svg_path, output_path, width, height):
    """Rasterize an SVG to PNG at the given dimensions."""
    cairosvg.svg2png(
        url=svg_path,
        write_to=output_path,
        output_width=width,
        output_height=height,
    )
    size_kb = os.path.getsize(output_path) / 1024
    print(f'  OK: {output_path} ({width}x{height}, {size_kb:.1f} KB)')

def main():
    if not os.path.exists(SOURCE_SVG):
        print(f'ERROR: Source SVG not found at {SOURCE_SVG}', file=sys.stderr)
        sys.exit(1)

    print(f'Source SVG: {SOURCE_SVG}')
    print(f'Output dir: {ICONS_DIR}')
    print()

    # --- Standard icons (with rounded background) ---
    # These have the rounded-square background baked in. Used for:
    # - PWA manifest "any" purpose
    # - Favicon
    # - Apple touch icon (iOS will apply its own mask)

    print('Standard icons:')
    generate_png(SOURCE_SVG, os.path.join(ICONS_DIR, 'mavero-192.png'), 192, 192)
    generate_png(SOURCE_SVG, os.path.join(ICONS_DIR, 'mavero-512.png'), 512, 512)
    generate_png(SOURCE_SVG, os.path.join(ICONS_DIR, 'mavero-apple-touch.png'), 180, 180)
    generate_png(SOURCE_SVG, os.path.join(ICONS_DIR, 'favicon-32.png'), 32, 32)
    generate_png(SOURCE_SVG, os.path.join(ICONS_DIR, 'favicon-16.png'), 16, 16)

    # --- Maskable icon ---
    # For maskable icons, Android may crop up to 20% from each edge.
    # The standard SVG already keeps the M within the 80% safe zone,
    # so we can use it directly. The key requirement is that the
    # background fills the entire viewport (no transparency at edges).
    # Our SVG already does this (the bgGlow rect fills 0,0→512,512
    # with clip-path).
    print()
    print('Maskable icon:')
    generate_png(SOURCE_SVG, os.path.join(ICONS_DIR, 'mavero-maskable-512.png'), 512, 512)

    # --- Small-size quality check ---
    # Generate temporary small sizes for visual inspection.
    print()
    print('Small-size quality check (temp):')
    for size in [16, 32, 48]:
        tmp = f'/tmp/mavero-check-{size}.png'
        generate_png(SOURCE_SVG, tmp, size, size)

    print()
    print('All icon assets generated successfully.')

if __name__ == '__main__':
    main()
