// ============================================================
// Mavero TV — design tokens.
//
// Single source of truth for the native TV look. Values mirror
// the web app (apps/web) dark palette so the TV experience looks
// exactly like maveroweb.space:
//   page background #0a0a0a, white text, cyan #00d9ff accent,
//   near-black rounded cards (#161616), 64px TV-safe page margin.
//
// Colors are stored as Tizen.NUI.Color (floats 0-1) converted from
// the same hex values the web app uses in its global styles.
// ============================================================
using System;
using Tizen.NUI;

namespace MaveroTv
{
    /// <summary>Design tokens mirroring the Mavero web app dark theme.</summary>
    public static class Theme
    {
        // ---- Colors (from the web app's global dark palette) ----

        /// <summary>#0a0a0a — page background.</summary>
        public static readonly Color Background = Hex(0x0A0A0A);

        /// <summary>#161616 — card / rail surface.</summary>
        public static readonly Color Surface = Hex(0x161616);

        /// <summary>#1f1f1f — focused / hovered card surface.</summary>
        public static readonly Color SurfaceFocused = Hex(0x1F1F1F);

        /// <summary>#ffffff — headings and card titles.</summary>
        public static readonly Color TextPrimary = Hex(0xFFFFFF);

        /// <summary>#9ca3af — secondary metadata text.</summary>
        public static readonly Color TextSecondary = Hex(0x9CA3AF);

        /// <summary>#00d9ff — cyan accent (brand highlights, focus ring).</summary>
        public static readonly Color Accent = Hex(0x00D9FF);

        // ---- Layout (TV windows run at a fixed 1920x1080) ----

        public const int ScreenWidth = 1920;
        public const int ScreenHeight = 1080;

        /// <summary>Horizontal safe margin — matches the web app's page gutter.</summary>
        public const int PageMargin = 64;

        /// <summary>Vertical gap between header / section title / rail.</summary>
        public const int SectionGap = 48;

        // ---- Cards (2:3 poster ratio, rounded like the web app) ----

        public const int CardWidth = 220;
        public const int CardHeight = 330;
        public const int CardGap = 24;
        public const float CardCornerRadius = 12f;

        /// <summary>Converts a 0xRRGGBB web-app hex value into a NUI color.</summary>
        public static Color Hex(int value)
        {
            float r = ((value >> 16) & 0xFF) / 255f;
            float g = ((value >> 8) & 0xFF) / 255f;
            float b = (value & 0xFF) / 255f;
            return new Color(r, g, b, 1f);
        }
    }
}
